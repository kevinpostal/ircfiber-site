/**
 * `#support` services bot (`FiberSupport`). Runs inside the gateway binary
 * but only in the process that sets `IRCFIBER_SUPPORT_BOT_ENABLED=1`
 * (prod: the dedicated `ircfiber-support-bot` container — same image as
 * the gateway, never a blue/green replica; local dev: the single gateway).
 *
 * It keeps one plaintext (or TLS) client connection to the ircd, joins the
 * support channel, announces every entry of the Redis outbox
 * (`RedisKeys.supportOutbox()`, fed by `ircfiber.support.events`) and
 * answers `!help`, `!issues [open|all]` and `!issue <n>`.
 *
 * The IRC client skeleton (reconnects, JOIN, sideband) is
 * `ircfiber.bots.core.IrcBot`; this module is only the support logic.
 *
 * Env:
 *   IRCFIBER_SUPPORT_BOT_ENABLED            "1"/"true" → run the bot (unset → disabled)
 *   IRCFIBER_SUPPORT_BOT_HOST               ircd host (default IRCFIBER_IRCD_HOST, then irc.ircfiber.com)
 *   IRCFIBER_SUPPORT_BOT_PORT               ircd port (default IRCFIBER_IRCD_PORT, then 6667)
 *   IRCFIBER_SUPPORT_BOT_TLS                "1" → TLS client connection (default plaintext)
 *   IRCFIBER_SUPPORT_BOT_NICK               default FiberSupport
 *   IRCFIBER_SUPPORT_BOT_CHANNEL            default #support
 *   IRCFIBER_SUPPORT_BOT_NICKSERV_PASSWORD  optional; IDENTIFY after 001 when set.
 *                                           Prod sets only the _FILE form
 *                                           (ircfiber.env.envSecret).
 *   IRCFIBER_SUPPORT_BOT_PUBLIC_URL         default https://ircfiber.com (admin/feedback links)
 *   IRCFIBER_REDIS_URL                      outbox consumer connection
 */
module ircfiber.support.bot;

import std.conv : to;
import std.process : environment;
import std.string : strip;
import std.typecons : Nullable, Tuple;
import std.uni : icmp;
import core.time : seconds, msecs;

import vibe.core.core : runTask, sleep;
import vibe.core.log;
import vibe.core.task : Task;
import vibe.data.json : Json, parseJsonString;

import ircfiber.bots.core;
import ircfiber.db.support_issues : SupportIssueRepository, SupportIssueRecord;
import ircfiber.env : envSecret;
import ircfiber.redis.protocol : RedisKeys;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.support.events : SupportEvent;
import ircfiber.support.format;
import ircfiber.tracing : isEnvEnabled;
import ircfiber.web.admin.ircd : IrcLine;

/// Bot settings, resolved once from the environment.
struct SupportBotConfig {
    string host;
    ushort port = 6667;
    bool tls;
    string nick = "FiberSupport";
    string channel = "#support";
    string nickservPassword;
    string publicUrl = "https://ircfiber.com";
    string redisUrl = "redis://127.0.0.1:6379";
    /// Fallback oper allowlist for `!adduser`/`!nsinfo` when the ircd does
    /// not answer 313 for oper callers. Comma nicks, ASCII case-insensitive.
    /// Empty = WHOIS-313 gate only.
    string[] adduserAllow;
}

/// Starts the bot task when `IRCFIBER_SUPPORT_BOT_ENABLED` is set; no-op otherwise.
void startSupportBot() {
    if (!isEnvEnabled("IRCFIBER_SUPPORT_BOT_ENABLED")) {
        logInfo("Support bot disabled (IRCFIBER_SUPPORT_BOT_ENABLED unset)");
        return;
    }
    SupportBotConfig cfg;
    cfg.host = botEnvStr("SUPPORT_BOT", "HOST", "IRCD_HOST", "irc.ircfiber.com");
    cfg.port = botEnvPort("SUPPORT_BOT", "PORT", "IRCD_PORT", 6667);
    cfg.tls = botEnvFlag("SUPPORT_BOT", "TLS", "", false);
    cfg.nick = botEnvStr("SUPPORT_BOT", "NICK", "", cfg.nick);
    cfg.channel = botEnvStr("SUPPORT_BOT", "CHANNEL", "", cfg.channel);
    // File-backed in prod so the bot's NickServ password is not readable
    // from `docker inspect ircfiber-support-bot`.
    cfg.nickservPassword = envSecret("IRCFIBER_SUPPORT_BOT_NICKSERV_PASSWORD", "");
    cfg.publicUrl = botEnvStr("SUPPORT_BOT", "PUBLIC_URL", "", cfg.publicUrl);
    cfg.redisUrl = environment.get("IRCFIBER_REDIS_URL", cfg.redisUrl);
    cfg.adduserAllow = botEnvList("IRCFIBER_SUPPORT_BOT_ADDUSER_ALLOW", []);

    auto bot = new SupportBot(cfg);
    runTask(&bot.run);
    logInfo("Support bot starting: %s:%s (%s) nick=%s channel=%s nickserv=%s",
        cfg.host, cfg.port, cfg.tls ? "TLS" : "plaintext", cfg.nick, cfg.channel,
        cfg.nickservPassword.length ? "yes" : "no");
}
private IrcBotConfig coreConfig(const SupportBotConfig c) {
    IrcBotConfig b;
    b.host = c.host;
    b.port = c.port;
    b.tls = c.tls;
    b.nick = c.nick;
    b.username = "fibersupport";
    b.realname = "IRC Fiber support bot";
    b.nickservPassword = c.nickservPassword;
    b.channels = supportChannels(c);
    b.redisUrl = c.redisUrl;
    b.heartbeatKey = RedisKeys.supportBot();
    b.controlKey = RedisKeys.supportBotControl();
    b.logPrefix = "support bot";
    return b;
}

/// Comma-separated channel list (`#support` default, opt-in `#support,#ircfiber`).
/// First entry stays the announcement channel; all are JOINed.
private string[] supportChannels(const SupportBotConfig c) {
    import std.string : split, strip;
    string[] out_;
    foreach (part; c.channel.split(',')) {
        auto s = part.strip().idup;
        if (s.length) out_ ~= s;
    }
    return out_.length ? out_ : [c.channel.idup];
}

private bool isSupportChannel(const SupportBotConfig c, string target) {
    foreach (ch; supportChannels(c)) if (icmp(ch, target) == 0) return true;
    return false;
}

private string primaryChannel(const SupportBotConfig c) {
    auto chs = supportChannels(c);
    return chs.length ? chs[0] : c.channel;
}

/// The #support logic on top of the shared IRC client skeleton.
final class SupportBot : IrcBot {
    private enum CMD_COOLDOWN_MS = 2000;
    private enum OPER_WHOIS_TIMEOUT_MS = 10_000;
    private enum OPER_PENDING_MAX = 64;

    private SupportBotConfig sb;
    private Task outboxTask;
    private long[string] lastCmdMs;
    private SupportIssueRepository repo;
    // WHOIS-313 oper gate: lower-cased nick → request ms / flags.
    private long[string] whoisAt;
    private bool[string] whoisOper;
    private bool[string] whoisDone;

    // ── status published to Redis for the admin IRCD page ──
    private long announcedCount;
    private string lastAnnouncement;
    private long lastAnnouncementAt;
    private long commandsAnswered;
    private long invitesSent;
    private string lastCommandText;
    private string lastCommandBy;
    private long lastCommandAt;

    this(SupportBotConfig cfg) {
        super(coreConfig(cfg));
        this.sb = cfg;
    }

    // ── inbound protocol ─────────────────────────────────────────────

    protected override bool onLine(ref IrcLine l) {
        if (l.command == "PRIVMSG" && l.params.length >= 2) {
            onPrivmsg(l);
            return true;
        }
        // WHOIS-313 oper gate replies. 313 carries the oper mark for the
        // WHOIS target; 318 ends the WHOIS; 401 means no such nick.
        // Shape: `:server 313 mynick <target> :is an IRC operator`.
        if (l.command == "313" && l.params.length >= 2) {
            whoisOper[asciiLower(l.params[1])] = true;
            return true;
        }
        if ((l.command == "318" || l.command == "401") && l.params.length >= 2) {
            whoisDone[asciiLower(l.params[1])] = true;
            return true;
        }
        return false;
    }

    /// On primary-channel join: start draining the announcement outbox.
    protected override void onJoined(string channel) {
        if (icmp(channel, primaryChannel(sb)) != 0) return;
        if (outboxTask == Task.init || !outboxTask.running) outboxTask = runTask(&outboxLoop);
    }

    /// The outbox consumer ends with the session; the next session starts a fresh one.
    protected override void onSessionEnd() {
        if (outboxTask != Task.init) {
            try outboxTask.join(); catch (Exception) {}
            outboxTask = Task.init;
        }
    }

    private static string nickOf(string prefix) @safe pure {
        import std.string : indexOf;
        auto bang = prefix.indexOf('!');
        return bang >= 0 ? prefix[0 .. bang] : prefix;
    }

    private static string asciiLower(string s) @safe pure nothrow {
        char[] r;
        r.length = s.length;
        foreach (i, char c; s)
            r[i] = (c >= 'A' && c <= 'Z') ? cast(char)(c + 32) : c;
        return r.idup;
    }

    private void onPrivmsg(IrcLine l) {
        const target = l.params[0];
        const text = l.params[1];
        if (!text.length || text[0] != '!') return;   // also skips CTCP (\x01)
        const toChannel = isSupportChannel(sb, target);
        const toMe = icmp(target, currentNick()) == 0;
        if (!toChannel && !toMe) return;
        const sender = nickOf(l.prefix);

        auto cmd = parseBotCommand(text);
        if (cmd.name != "help" && cmd.name != "issues" && cmd.name != "issue"
                && cmd.name != "adduser" && cmd.name != "nsinfo") return;

        const now = nowMs();
        if (auto p = sender in lastCmdMs) if (now - *p < CMD_COOLDOWN_MS) return;
        if (lastCmdMs.length > 1000) lastCmdMs.clear();
        lastCmdMs[sender] = now;

        const replyTo = toChannel ? target : sender;
        // Oper-only commands go through the WHOIS-313 gate (or the env
        // allowlist fallback) and continue asynchronously.
        if (cmd.name == "adduser" || cmd.name == "nsinfo") {
            if (!cmd.ok) {
                say(replyTo, [SUPPORT_USAGE]);
                return;
            }
            requestOperCommand(sender, cmd.arg, replyTo, cmd.name, text, now);
            return;
        }
        string[] reply;
        switch (cmd.name) {
            case "help":
                reply = formatHelp(sb.publicUrl);
                break;
            case "issues":
                reply = cmd.ok ? issuesSummary(cmd.arg) : [SUPPORT_USAGE];
                break;
            case "issue":
                reply = cmd.ok ? issueDetail(cmd.arg) : [SUPPORT_USAGE];
                break;
            default:
                return;
        }
        say(replyTo, reply);
        commandsAnswered++;
        lastCommandText = text;
        lastCommandBy = sender;
        lastCommandAt = now;
    }

    private bool operAllowlisted(string sender) const {
        const s = asciiLower(sender);
        foreach (a; sb.adduserAllow) if (asciiLower(a) == s) return true;
        return false;
    }

    private void requestOperCommand(string sender, string nick, string replyTo,
            string cmdName, string text, long now) {
        import ircfiber.services.anope : isSafeServicesArg;
        // Injection guard before any Anope call or WHOIS echo.
        if (!isSafeServicesArg(sender) || !isSafeServicesArg(nick)) {
            say(replyTo, [SUPPORT_USAGE]);
            return;
        }
        // Env allowlist bypass (for ircds that omit 313).
        if (operAllowlisted(sender)) {
            string s0 = sender, n0 = nick, r0 = replyTo, c0 = cmdName, t0 = text;
            long now0 = now;
            runTask(() nothrow { try this.operCommandTask(s0, n0, r0, c0, t0, now0, true); catch (Exception) {} });
            return;
        }
        const key = asciiLower(sender);
        if (whoisAt.length >= OPER_PENDING_MAX) {
            whoisAt.clear(); whoisOper.clear(); whoisDone.clear();
        }
        whoisAt[key] = now;
        whoisOper.remove(key);
        whoisDone.remove(key);
        try sendLine("WHOIS " ~ sender);
        catch (Exception e) {
            logWarn("support bot: WHOIS %s failed: %s", sender, e.msg);
            say(replyTo, ["Services unavailable — try again later."]);
            return;
        }
        string s1 = sender, n1 = nick, r1 = replyTo, c1 = cmdName, t1 = text;
        long now1 = now;
        runTask(() nothrow { try this.operCommandTask(s1, n1, r1, c1, t1, now1, false); catch (Exception) {} });
    }

    private void operCommandTask(string sender, string nick, string replyTo,
            string cmdName, string text, long now, bool preAuthed) {
        try {
            if (!preAuthed) {
                const key = asciiLower(sender);
                const start = nowMs();
                bool ok = false;
                bool done = false;
                while (nowMs() - start < OPER_WHOIS_TIMEOUT_MS) {
                    if (auto p = key in whoisOper) if (*p) { ok = true; break; }
                    if (auto d = key in whoisDone) if (*d) { done = true; break; }
                    sleep(100.msecs);
                }
                whoisAt.remove(key); whoisOper.remove(key); whoisDone.remove(key);
                if (!ok) {
                    // Timeout or 318 without 313: not an oper.
                    try say(replyTo, ["This command is restricted to IRC operators."]);
                    catch (Exception) {}
                    return;
                }
                cast(void) done;
            }
            if (cmdName == "adduser") adduserFlow(sender, nick, replyTo, text, now);
            else if (cmdName == "nsinfo") nsinfoFlow(sender, nick, replyTo, text, now);
        } catch (Exception e) {
            try logWarn("support bot: !%s failed: %s", cmdName, e.msg);
            catch (Exception) {}
        }
    }

    // Step 3–5/8: verify NickServ, create the site user, announce, invite.
    private void adduserFlow(string sender, string nick, string replyTo, string text, long now) {
        import std.algorithm : canFind;
        import std.base64 : Base64;
        import std.datetime : Clock;
        import std.random : uniform;
        import std.uuid : randomUUID;
        import ircfiber.auth : hashPassword;
        import ircfiber.db.user : UserRepository;
        import ircfiber.invites : InvitePending, InviteStore, inviteLink, newInviteToken;
        import ircfiber.logs.events : LogEvent, pushLogEvent;
        import ircfiber.mail : emailWellFormed;
        import ircfiber.models.user : User;
        import ircfiber.services.accounts : isValidIrcNick;
        import ircfiber.services.anope : classifyNickInfoReply, loadAnopeSettings,
            anopeOperQuery, parseNickInfo, NickRegistration;

        if (!isValidIrcNick(nick)) {
            try say(replyTo, ["\"" ~ nick ~ "\" is not a valid IRC nickname."]);
            catch (Exception) {}
            return;
        }
        // Site-uniqueness first: a site row without a NickServ account
        // still replies "already exists".
        try {
            auto existing = (new UserRepository()).findByUsernameCI(nick);
            if (existing.username.length > 0) {
                try say(replyTo, ["Site account \"" ~ existing.username ~ "\" already exists."]);
                catch (Exception) {}
                return;
            }
        } catch (Exception e) {
            logWarn("support bot: !adduser user lookup failed: %s", e.msg);
            try say(replyTo, ["Services unavailable — try again later."]);
            catch (Exception) {}
            return;
        }
        auto anope = loadAnopeSettings();
        if (!anope.configured || !anope.hasOper) {
            logWarn("support bot: !adduser with Anope unconfigured");
            try say(replyTo, ["Services unavailable — try again later."]);
            catch (Exception) {}
            return;
        }
        auto qr = anopeOperQuery(anope, "INFO " ~ nick);
        if (!qr.transportOk) {
            logWarn("support bot: !adduser INFO %s failed: %s", nick, qr.transportError);
            try say(replyTo, ["Services unavailable — try again later."]);
            catch (Exception) {}
            return;
        }
        auto reg = classifyNickInfoReply(qr.text);
        if (reg == NickRegistration.unknown) {
            logWarn("support bot: !adduser INFO %s unrecognised", nick);
            try say(replyTo, ["Services unavailable — try again later."]);
            catch (Exception) {}
            return;
        }
        if (reg != NickRegistration.registered) {
            inviteFlow(sender, nick, replyTo);
            return;
        }
        auto info = parseNickInfo(qr.rawText);
        if (!info.registered) {
            inviteFlow(sender, nick, replyTo);
            return;
        }
        string account = info.account.length ? info.account : nick;
        // Re-check uniqueness against the canonical account case.
        try {
            auto again = (new UserRepository()).findByUsernameCI(account);
            if (again.username.length > 0) {
                try say(replyTo, ["Site account \"" ~ again.username ~ "\" already exists."]);
                catch (Exception) {}
                return;
            }
        } catch (Exception e) {
            logWarn("support bot: !adduser user lookup failed: %s", e.msg);
            try say(replyTo, ["Services unavailable — try again later."]);
            catch (Exception) {}
            return;
        }
        string email = "";
        if (auto p = "Email address" in info.fields) {
            auto v = (*p).strip();
            if (v.length && emailWellFormed(v)) email = v;
        }
        bool placeholder = false;
        if (!email.length) { email = account ~ "@provisioned.irc.invalid"; placeholder = true; }
        // Unusable site password: 32 random bytes, Base64, hashed then discarded.
        ubyte[32] raw;
        foreach (ref b; raw) b = cast(ubyte) uniform(0, 256);
        string randomPw = Base64.encode(raw[]).idup;
        User u;
        u.id = randomUUID();
        u.username = account;
        u.email = email;
        u.passwordHash = hashPassword(randomPw);
        randomPw = "";
        u.roles = ["user"];
        u.signupIp = "irc:!" ~ sender;
        u.createdAt = Clock.currTime;
        u.provisionedFrom = "nickserv:" ~ account;
        try {
            (new UserRepository()).create(u);
        } catch (Exception e) {
            if (e.msg.canFind("duplicate key")) {
                try say(replyTo, ["Site account \"" ~ account ~ "\" already exists."]);
                catch (Exception) {}
                return;
            }
            logWarn("support bot: !adduser create %s failed: %s", account, e.msg);
            try say(replyTo, ["Services unavailable — try again later."]);
            catch (Exception) {}
            return;
        }
        // No Fiber network here: provisioning one would push an `addNetwork`
        // control message and the engine would immediately connect as this
        // nick — squatting a live IRC user (or riding `nick_` while they
        // hold it), unidentified and without their consent. The network is
        // created on first site login instead, where loginPost proves
        // NickServ ownership and captures the SASL credential. Never
        // REGISTER a new NickServ account here either.
        RedisStorage redis;
        try {
            redis = new RedisStorage();
            redis.connectFromUrl(sb.redisUrl);
            // Staff feed: same signup event createAccountAndLogin emits.
            try {
                LogEvent le;
                le.type = "signup";
                le.ts = Clock.currTime.toUnixTime!long * 1000;
                le.username = u.username;
                le.email = u.email;
                le.ip = "irc:!" ~ sender;
                pushLogEvent(redis, le);
            } catch (Exception e) logWarn("support bot: !adduser announce %s failed: %s", account, e.msg);
        } catch (Exception e) {
            logWarn("support bot: !adduser redis failed: %s", e.msg);
        }
        if (redis !is null) try redis.close(); catch (Exception) {}
        string note = placeholder ? " (placeholder email — they can update it on the site)" : "";
        try say(replyTo, ["Added site account \"" ~ account ~ "\" (" ~ email ~ note ~ ") — they can log in with their NickServ password."]);
        catch (Exception e) logWarn("support bot: !adduser reply failed: %s", e.msg);
        commandsAnswered++;
        lastCommandText = text;
        lastCommandBy = sender;
        lastCommandAt = now;
    }
    private void nsinfoFlow(string sender, string nick, string replyTo, string text, long now) {
        import std.string : toLower;
        import ircfiber.services.accounts : isValidIrcNick;
        import ircfiber.services.anope : loadAnopeSettings, anopeOperQuery, parseNickInfo;

        if (!isValidIrcNick(nick)) {
            try say(sender, ["\"" ~ nick ~ "\" is not a valid IRC nickname."]);
            catch (Exception) {}
            return;
        }
        auto anope = loadAnopeSettings();
        if (!anope.configured || !anope.hasOper) {
            logWarn("support bot: !nsinfo with Anope unconfigured");
            try say(sender, ["Services unavailable — try again later."]);
            catch (Exception) {}
            return;
        }
        auto qr = anopeOperQuery(anope, "INFO " ~ nick);
        if (!qr.transportOk) {
            logWarn("support bot: !nsinfo INFO %s failed: %s", nick, qr.transportError);
            try say(sender, ["Services unavailable — try again later."]);
            catch (Exception) {}
            return;
        }
        auto info = parseNickInfo(qr.rawText);
        // Channel gets a one-line ack; PII goes ONLY by DM.
        if (replyTo != sender) {
            try say(replyTo, ["NickServ info for \"" ~ nick ~ "\" sent by DM."]);
            catch (Exception) {}
        }
        if (!info.registered) {
            try say(sender, ["No NickServ account named \"" ~ nick ~ "\"."]);
            catch (Exception) {}
        } else {
            string account = info.account.length ? info.account : nick;
            string email = "none set";
            if (auto p = "Email address" in info.fields) {
                auto v = (*p).strip();
                if (v.length) email = v;
            }
            string reg = "?";
            if (auto p = "Registered" in info.fields) if ((*p).length) reg = *p;
            string seen = "?";
            if (auto p = "Last seen" in info.fields) if ((*p).length) seen = *p;
            string line = nick ~ ": registered as " ~ account ~ ", email " ~ email
                ~ ", registered " ~ reg ~ ", last seen " ~ seen;
            bool suspended = false;
            if (auto p = "Suspended" in info.fields) {
                auto v = (*p).strip().toLower();
                suspended = v == "yes" || v == "true" || v == "1" || v == "on";
            }
            if (suspended) {
                string reason = "";
                if (auto p = "Reason" in info.fields) reason = *p;
                line ~= " (suspended: " ~ reason ~ ")";
            }
            try say(sender, [line]);
            catch (Exception e) logWarn("support bot: !nsinfo reply failed: %s", e.msg);
        }
        commandsAnswered++;
        lastCommandText = text;
        lastCommandBy = sender;
        lastCommandAt = now;
    }

    private void inviteFlow(string sender, string nick, string replyTo) {
        import std.datetime : Clock;
        import ircfiber.invites : InvitePending, InviteStore, inviteLink, newInviteToken;

        RedisStorage redis;
        try {
            redis = new RedisStorage();
            redis.connectFromUrl(sb.redisUrl);
            auto store = new InviteStore(redis);
            const token = newInviteToken();
            InvitePending p;
            p.nick = nick;
            p.invitedBy = sender;
            p.createdAt = Clock.currTime.toUnixTime();
            try store.put(token, p);
            catch (Exception e) {
                logWarn("support bot: !adduser invite store failed: %s", e.msg);
                try say(replyTo, ["Services unavailable — try again later."]);
                catch (Exception) {}
                return;
            }
            const link = inviteLink(sb.publicUrl, token);
            bool pmOk = true;
            try say(nick, ["Hi " ~ nick ~ ", " ~ sender ~ " invited you to IRC Fiber — finish signing up here (expires in 24h, single use): " ~ link]);
            catch (Exception e) {
                pmOk = false;
                logWarn("support bot: invite PM to %s failed: %s", nick, e.msg);
            }
            if (pmOk) {
                try say(replyTo, ["No NickServ account for \"" ~ nick ~ "\" — PM'd them a 24h signup link."]);
                catch (Exception) {}
            } else {
                // Bearer-secrecy: the link never goes to a channel.
                try say(sender, ["Couldn't reach " ~ nick ~ " directly — relay this link (24h, single-use): " ~ link]);
                catch (Exception) {}
                if (replyTo != sender) {
                    try say(replyTo, ["No NickServ account for \"" ~ nick ~ "\" — couldn't PM them, sent you the link by DM."]);
                    catch (Exception) {}
                }
            }
            invitesSent++;
        } catch (Exception e) {
            logWarn("support bot: !adduser invite redis failed: %s", e.msg);
            try say(replyTo, ["Services unavailable — try again later."]);
            catch (Exception) {}
        }
        if (redis !is null) try redis.close(); catch (Exception) {}
    }

    private SupportIssueRepository repository() {
        if (repo is null) repo = new SupportIssueRepository();
        return repo;
    }

    private string[] issuesSummary(string arg) {
        try {
            auto r = repository();
            auto counts = r.countByStatus();
            auto recent = r.recent(arg == "all" ? [] : ["open", "in_progress"], SUPPORT_SUMMARY_ROWS);
            return formatIssuesSummary(counts, recent, nowMs(), sb.publicUrl);
        } catch (Exception e) {
            logWarn("support bot: !issues failed: %s", e.msg);
            return ["Support database unavailable — try again later"];
        }
    }

    private string[] issueDetail(string arg) {
        long n;
        try n = arg.to!long; catch (Exception) return [SUPPORT_USAGE];
        try {
            auto rec = repository().getByNumber(n);
            if (rec.id.length == 0) return ["No issue #" ~ n.to!string];
            return formatIssueDetail(rec, nowMs(), sb.publicUrl);
        } catch (Exception e) {
            logWarn("support bot: !issue failed: %s", e.msg);
            return ["Support database unavailable — try again later"];
        }
    }

    // ── outbox consumer ──────────────────────────────────────────────

    /// Drains `RedisKeys.supportOutbox()` while connected and joined. On a
    /// send failure the entry goes back to the head of the list and the
    /// loop ends; the next session starts a fresh consumer.
    private void outboxLoop() nothrow {
        RedisStorage redis;
        try {
            redis = new RedisStorage();
            redis.connectFromUrl(sb.redisUrl);
            const key = RedisKeys.supportOutbox();
            while (isAlive()) {
                const primary = primaryChannel(sb);
                if (!joined(primary)) { sleep(1.seconds); continue; }
                Nullable!(Tuple!(string, string)) popped;
                try popped = redis.getDb().blpop!string(key, 5);
                catch (Exception e) {
                    logWarn("support bot: outbox BLPOP failed: %s", e.msg);
                    sleep(5.seconds);
                    continue;
                }
                if (popped.isNull) continue;
                const raw = popped.get[1];
                SupportEvent ev;
                try ev = SupportEvent.fromJson(parseJsonString(raw));
                catch (Exception e) {
                    logWarn("support bot: dropping malformed outbox entry: %s", e.msg);
                    continue;
                }
                auto lines = formatSupportEvent(ev, sb.publicUrl);
                if (!lines.length) {
                    logWarn("support bot: dropping outbox entry of unknown type %s", ev.type);
                    continue;
                }
                try say(primary, lines);
                catch (Exception e) {
                    try redis.getDb().lpush(key, raw); catch (Exception) {}
                    throw e;
                }
                announcedCount++;
                lastAnnouncement = lines[0];
                lastAnnouncementAt = nowMs();
                logInfo("support bot: announced %s #%d", ev.type, ev.number);
            }
        } catch (Exception e) {
            try logWarn("support bot: outbox loop ended: %s", e.msg); catch (Exception) {}
        }
        if (redis !is null) redis.close();
    }
    // ── Redis sideband: heartbeat for the admin IRCD page + control ──

    /// The support bot's own heartbeat fields (the `SupportBotCard` reads them).
    protected override void extendStatus(ref Json j, RedisStorage side) {
        j["publicUrl"] = Json(sb.publicUrl);
        j["announced"] = Json(announcedCount);
        j["lastAnnouncement"] = Json(lastAnnouncement);
        j["lastAnnouncementAt"] = Json(lastAnnouncementAt);
        j["commandsAnswered"] = Json(commandsAnswered);
        j["invitesSent"] = Json(invitesSent);
        j["lastCommand"] = Json(lastCommandText);
        j["lastCommandBy"] = Json(lastCommandBy);
        j["lastCommandAt"] = Json(lastCommandAt);
    }

    protected override void onControl(string cmd, Json entry) {
        logWarn("support bot: unknown control command %s from %s", cmd, entry["by"].opt!string);
    }
}
