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
import core.time : seconds;

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
    b.channels = [c.channel];
    b.redisUrl = c.redisUrl;
    b.heartbeatKey = RedisKeys.supportBot();
    b.controlKey = RedisKeys.supportBotControl();
    b.logPrefix = "support bot";
    return b;
}

/// The #support logic on top of the shared IRC client skeleton.
final class SupportBot : IrcBot {
    private enum CMD_COOLDOWN_MS = 2000;

    private SupportBotConfig sb;
    private Task outboxTask;
    private long[string] lastCmdMs;
    private SupportIssueRepository repo;

    // ── status published to Redis for the admin IRCD page ──
    private long announcedCount;
    private string lastAnnouncement;
    private long lastAnnouncementAt;
    private long commandsAnswered;
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
        return false;
    }

    /// In `#support`: start draining the announcement outbox.
    protected override void onJoined(string channel) {
        if (icmp(channel, sb.channel) != 0) return;
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

    private void onPrivmsg(IrcLine l) {
        const target = l.params[0];
        const text = l.params[1];
        if (!text.length || text[0] != '!') return;   // also skips CTCP (\x01)
        const toChannel = icmp(target, sb.channel) == 0;
        const toMe = icmp(target, currentNick()) == 0;
        if (!toChannel && !toMe) return;
        const sender = nickOf(l.prefix);
        if (!sender.length) return;

        auto cmd = parseBotCommand(text);
        if (cmd.name != "help" && cmd.name != "issues" && cmd.name != "issue") return;

        const now = nowMs();
        if (auto p = sender in lastCmdMs) if (now - *p < CMD_COOLDOWN_MS) return;
        if (lastCmdMs.length > 1000) lastCmdMs.clear();
        lastCmdMs[sender] = now;

        const replyTo = toChannel ? sb.channel : sender;
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
                if (!joined(sb.channel)) { sleep(1.seconds); continue; }
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
                try say(sb.channel, lines);
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
        j["lastCommand"] = Json(lastCommandText);
        j["lastCommandBy"] = Json(lastCommandBy);
        j["lastCommandAt"] = Json(lastCommandAt);
    }

    protected override void onControl(string cmd, Json entry) {
        logWarn("support bot: unknown control command %s from %s", cmd, entry["by"].opt!string);
    }
}
