/**
 * FiberEye — the connection-intelligence bot and the `#staff` announcer.
 *
 * An opered IRC connection that runs inside the same gateway image but
 * only in the process that sets `IRCFIBER_FIBEREYE_ENABLED=1` (prod: the
 * dedicated `ircfiber-fibereye` container).
 *
 * What it does:
 *   - subscribe to snomasks `+s +cCqx` and persist every connect and quit
 *     to Mongo (`ircfiber.fibereye.store`);
 *   - for every public connect, count the sighting and assemble the IP
 *     intelligence record (`ircfiber.ipintel`), attach it to the FiberEye
 *     rollups, then queue the `irc_connect` announcement;
 *   - sit in `#staff` and announce the Redis outbox (`logsOutboxKey()`):
 *     signups, mail, connects, admin notices, backup runs — each connect
 *     with its record (`ircfiber.logs.format`);
 *   - refresh the Tor exit set hourly;
 *   - count connects, distinct nicks and short sessions per IP group in
 *     Redis sorted sets, and ask `ircfiber.fibereye.rules` for a verdict;
  *   - place a timed `ZLINE` when a rule trips *and* enforcement is armed
  *     (`fibereye:armed` = "1", flipped from the admin page — the bot ships
  *     disarmed and merely records what it would have done), and announce
  *     every placed ban in `#staff` through the logs outbox;
 *   - confirm its own placements with a periodic `STATS Z` sweep, because
 *     InspIRCd answers a successful `ZLINE` with silence.
 *
 * It is deliberately *not* the code that removes a Z-line: releases happen
 * in the web process over the dashboard-oper session
 * (`ircfiber.web.admin.ircd.removeXlineNow`), which is where both the
 * admin Release button and the public `/unban` page live.
 *
 * The IRC client skeleton (reconnects, OPER, JOIN, sideband) is
 * `ircfiber.bots.core.IrcBot`; this module is only the FiberEye logic.
 *
 * The rule env vars below are the *deployed baseline*, not the last word:
 * an admin can override every threshold, flag and list from `#/fibereye`.
 * The override lives in Mongo (`fibereye_rules`), is mirrored to
 * `fibereye:rules` and is picked up by `onSidebandTick` within 5 s. A
 * missing or invalid mirror falls back to this baseline, so a Redis wipe
 * fails safe.
 *
 * Env:
 *   IRCFIBER_FIBEREYE_ENABLED              "1"/"true" → run (unset → disabled)
 *   IRCFIBER_FIBEREYE_HOST                 ircd host (default IRCFIBER_IRCD_HOST, then irc.ircfiber.com)
 *   IRCFIBER_FIBEREYE_PORT                 ircd port (default IRCFIBER_IRCD_PORT, then 6667)
 *   IRCFIBER_FIBEREYE_TLS                  "1" → TLS client connection
 *   IRCFIBER_FIBEREYE_NICK                 default FiberEye
 *   IRCFIBER_FIBEREYE_CHANNEL              announcements channel (default #staff)
 *   IRCFIBER_FIBEREYE_NICKSERV_PASSWORD    optional (also _FILE); IDENTIFY after 001
 *   IRCFIBER_FIBEREYE_OPER                 oper account; unset → no OPER, so no
 *                                          notices and no bans
 *   IRCFIBER_FIBEREYE_OPER_PASSWORD        oper password (also _FILE)
 *   IRCFIBER_FIBEREYE_IGNORE_CLASSES       comma list of connect classes never counted
 *                                          (default ircfiber-engine,ircfiber-engine-v6,
 *                                          localhost,localhost-v6; empty ignores nothing)
 *   IRCFIBER_FIBEREYE_EXEMPT_IPS           comma list of IP groups never counted
 *   IRCFIBER_FIBEREYE_WINDOW               counting window, seconds (default 60)
 *   IRCFIBER_FIBEREYE_CONNECT_THRESHOLD    connects per window (default 10)
 *   IRCFIBER_FIBEREYE_NICK_THRESHOLD       distinct nicks per window (default 6)
 *   IRCFIBER_FIBEREYE_CHURN_THRESHOLD      short sessions per window (default 6)
 *   IRCFIBER_FIBEREYE_SHORT_MS             what counts as short (default 20000)
 *   IRCFIBER_FIBEREYE_BAN_SECONDS          first-strike ban duration (default 3600)
 *   IRCFIBER_FIBEREYE_RETENTION_DAYS       session TTL, days (default 90; see store.d)
 *   IRCFIBER_PUBLIC_URL                    appeal link base (default https://ircfiber.com)
 *   IRCFIBER_REDIS_URL                     counters, heartbeat, control, outbox
 *   IRCFIBER_IPINFO_TOKEN, IRCFIBER_PROXYCHECK_KEY, IRCFIBER_IPAPI_IS_KEY,
 *   IRCFIBER_IPHUB_KEY (all _FILE), IRCFIBER_IPINTEL_*   see ircfiber.ipintel.sources
 */
module ircfiber.fibereye.bot;

import std.conv : to;
import std.process : environment;
import std.string : indexOf, startsWith, strip, toLower;
import std.array : split;
import std.typecons : Nullable, Tuple;
import std.uni : icmp;
import core.time : minutes, seconds;

import vibe.core.core : runTask, sleep;
import vibe.core.log;
import vibe.core.task : Task;
import vibe.data.json : Json, parseJsonString;

import ircfiber.bots.core;
import ircfiber.env : envSecret;
import ircfiber.fibereye.events;
import ircfiber.fibereye.format;
import ircfiber.fibereye.rules;
import ircfiber.fibereye.store;
import ircfiber.fibereye.ruleset;
import ircfiber.ipintel.record : IpIntel;
import ircfiber.ipintel.service : IpIntelService, LookupMode, loadIpIntelSettings;
import ircfiber.ipintel.store : IpIntelStore;
import ircfiber.logs.events : LogEvent, logsOutboxKey, pushLogEvent;
import ircfiber.logs.format : formatLogEvent;
import ircfiber.services.accounts : generateServicesPassword;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.tracing : isEnvEnabled;
import ircfiber.web.admin.ircd : IrcLine, XLine, parseStatsXLine;

/// Bot settings, resolved once from the environment.
struct FiberEyeConfig {
    string host;
    ushort port = 6667;
    bool tls;
    string nick = "FiberEye";
    string channel = "#staff";
    /// Comma-separated list of channels to join (supports multiple).
    string channels = "#staff,#ircfiber";
    string nickservPassword;
    string operName;
    string operPassword;
    /// Connect classes never counted and never banned. `localhost-v6` is
    /// in this list on purpose: banning the ircd's own healthcheck source
    /// is the documented self-Z-line trap.
    string[] ignoreClasses = ["ircfiber-engine", "ircfiber-engine-v6", "localhost", "localhost-v6"];
    /// IP groups that are persisted but never counted or banned.
    string[] exemptIps;
    Thresholds thresholds;
    string publicBase = "https://ircfiber.com";
    string redisUrl = "redis://127.0.0.1:6379";
}

/// Starts the bot task when `IRCFIBER_FIBEREYE_ENABLED` is set; no-op otherwise.
void startFiberEye() {
    if (!isEnvEnabled("IRCFIBER_FIBEREYE_ENABLED")) {
        logInfo("FiberEye disabled (IRCFIBER_FIBEREYE_ENABLED unset)");
        return;
    }
    FiberEyeConfig cfg;
    cfg.host = botEnvStr("FIBEREYE", "HOST", "IRCD_HOST", "irc.ircfiber.com");
    cfg.port = botEnvPort("FIBEREYE", "PORT", "IRCD_PORT", 6667);
    cfg.tls = botEnvFlag("FIBEREYE", "TLS", "", false);
    cfg.nick = botEnvStr("FIBEREYE", "NICK", "", cfg.nick);
    cfg.channel = botEnvStr("FIBEREYE", "CHANNEL", "", cfg.channel);
    cfg.channels = botEnvStr("FIBEREYE", "CHANNELS", "", cfg.channels);
    // File-backed in prod so the credentials are not readable from
    // `docker inspect ircfiber-fibereye`.
    cfg.nickservPassword = envSecret("IRCFIBER_FIBEREYE_NICKSERV_PASSWORD", "");
    cfg.operName = botEnvStr("FIBEREYE", "OPER", "", "");
    cfg.operPassword = envSecret("IRCFIBER_FIBEREYE_OPER_PASSWORD", "");
    cfg.ignoreClasses = botEnvList("IRCFIBER_FIBEREYE_IGNORE_CLASSES", cfg.ignoreClasses);
    cfg.exemptIps = botEnvList("IRCFIBER_FIBEREYE_EXEMPT_IPS", null);
    cfg.thresholds.windowSeconds = botEnvLong("IRCFIBER_FIBEREYE_WINDOW", 60);
    cfg.thresholds.connects = botEnvLong("IRCFIBER_FIBEREYE_CONNECT_THRESHOLD", 10);
    cfg.thresholds.nicks = botEnvLong("IRCFIBER_FIBEREYE_NICK_THRESHOLD", 6);
    cfg.thresholds.churn = botEnvLong("IRCFIBER_FIBEREYE_CHURN_THRESHOLD", 6);
    cfg.thresholds.shortMs = botEnvLong("IRCFIBER_FIBEREYE_SHORT_MS", 20_000);
    cfg.thresholds.banSeconds = botEnvLong("IRCFIBER_FIBEREYE_BAN_SECONDS", 3_600);
    if (cfg.thresholds.windowSeconds <= 0) cfg.thresholds.windowSeconds = 60;
    auto base = environment.get("IRCFIBER_PUBLIC_URL", "https://ircfiber.com").strip();
    while (base.length && base[$ - 1] == '/') base = base[0 .. $ - 1];
    if (base.length) cfg.publicBase = base;
    cfg.redisUrl = environment.get("IRCFIBER_REDIS_URL", cfg.redisUrl);

    auto bot = new FiberEyeBot(cfg);
    runTask(&bot.run);
    logInfo("FiberEye starting: %s:%s (%s) nick=%s channel=%s oper=%s window=%ss "
        ~ "connects=%s nicks=%s churn=%s ban=%ss ignore=%s exempt=%s",
        cfg.host, cfg.port, cfg.tls ? "TLS" : "plaintext", cfg.nick, cfg.channel,
        cfg.operName.length ? cfg.operName : "none",
        cfg.thresholds.windowSeconds, cfg.thresholds.connects, cfg.thresholds.nicks,
        cfg.thresholds.churn, cfg.thresholds.banSeconds, cfg.ignoreClasses, cfg.exemptIps);
}

private IrcBotConfig coreConfig(const FiberEyeConfig c) {
    IrcBotConfig b;
    b.host = c.host;
    b.port = c.port;
    b.tls = c.tls;
    b.nick = c.nick;
    b.username = "fibereye";
    b.realname = "IRC Fiber connection watch";
    b.nickservPassword = c.nickservPassword;
    b.operName = c.operName;
    b.operPassword = c.operPassword;
    // `c` connects, `C` remote connects (announced), `q` local quits, `x` X-line notices.
    b.snomasks = "cCqx";
    string[] chs;
    if (c.channels.length) chs = c.channels.split(",");
    else if (c.channel.length) chs = [c.channel];
    b.channels = chs;
    logInfo("FiberEye: channels array: %s", chs);
    b.redisUrl = c.redisUrl;
    b.heartbeatKey = fiberEyeBotKey();
    b.controlKey = fiberEyeControlKey();
    b.logPrefix = "FiberEye";
    return b;
}

/// The FiberEye logic on top of the shared IRC client skeleton.
final class FiberEyeBot : IrcBot {
    private enum STATS_INTERVAL = 60;
    private enum TOR_REFRESH = 60;
    /// Open-session map cap. A flood must not grow it without bound; the
    /// oldest insertion is evicted, which only costs a `durationMs` on a
    /// session that has been open longer than 20 000 others.
    private enum MAX_OPEN_SESSIONS = 20_000;

    private FiberEyeConfig fe;
    /// Redis connection owned by the reader fiber (each loop owns its own).
    private RedisStorage redis;
    private FiberEyeStore store;
    /// IP intelligence: fan-out, caches, sightings.
    private IpIntelService intel;
    /// Producer connection for `pushLogEvent` (the outbox consumer owns its own).
    private RedisStorage pushRedis;
    private Task outboxTask;
    private bool torLoopStarted;

    /// nick\0ip → open session id, so a quit can close its own row.
    private string[string] openSessions;
    /// Insertion order of `openSessions`, for bounded eviction.
    private string[] openOrder;
    /// Connect time per open session id, so a quit computes its duration
    /// without a Mongo read on the IRC read loop.
    private long[string] openedAt;
    /// Last WHOIS send, for the account-enrichment throttle.
    private long lastWhoisMs;

    /// Masks the ircd currently lists in `STATS Z`, refreshed by the sweep.
    private bool[string] activeZlines;
    /// Masks FiberEye itself ZLINE'd recently (mask → send time, unix ms),
    /// so the ircd's own X-line notice for our placement doesn't
    /// double-announce the ban `enforceBan` already reported.
    private long[string] ownBanAt;
    private XLine[string] pendingStats;
    private bool statsLoopStarted;

    // ── status published to Redis for the admin FiberEye page ──
    private long connectsSeen;
    private long connectsIgnored;
    private long quitsSeen;
    private long bansPlaced;
    private long bansObserved;
    private long accountLookups;
    private long announcedCount;
    private string lastAnnouncement;
    private long lastAnnouncementAt;
    private long intelLookups;
    private long intelFailures;

    // ── rules in force ───────────────────────────────────────────────
    /// The env baseline captured at construction; never mutated, and the
    /// value an admin "Reset to deployed" falls back to.
    private RuleSet deployedRules;
    /// What is actually enforced right now. Replaced wholesale by
    /// `onSidebandTick`; the reader fiber cannot observe a torn value
    /// because vibe fibers are cooperatively scheduled and the assignment
    /// contains no yield point.
    private RuleSet liveRules;
    /// True while an admin override is in force (vs. the env baseline).
    private bool rulesFromOverride;

    this(FiberEyeConfig cfg) {
        super(coreConfig(cfg));
        this.fe = cfg;
        deployedRules.thresholds = cfg.thresholds;
        deployedRules.ignoreClasses = cfg.ignoreClasses.dup;
        deployedRules.exemptIps = cfg.exemptIps.dup;
        liveRules = deployedRules;
    }

    /// Picks up an admin rule change within one tick (≤5 s), no redeploy.
    ///
    /// Mongo is the source of truth but the bot polls the Redis mirror:
    /// one GET per 5 s beats a Mongo round trip, and a missing mirror is
    /// the fail-safe "use the deployed baseline" signal.
    protected override void onSidebandTick(RedisStorage side) {
        if (side is null) return;
        RuleSet next = deployedRules;
        bool fromOverride = false;
        Json j = Json(null);
        try j = side.getJson(fiberEyeRulesKey());
        catch (Exception e) {
            logWarn("FiberEye: cannot read stored rules: %s", e.msg);
            return;                                  // keep what is in force
        }
        if (j.type == Json.Type.object) {
            auto candidate = RuleSet.fromJson(j, deployedRules);
            auto errs = validateRuleSet(candidate);
            if (errs.length)
                logWarn("FiberEye: ignoring stored rules (%s); using the deployed baseline", errs[0]);
            else {
                next = candidate;
                fromOverride = true;
            }
        }
        const summary = summarizeRuleChange(liveRules, next);
        if (summary.length)
            logInfo("FiberEye: rules changed (%s) by %s", summary,
                next.updatedBy.length ? next.updatedBy : "deploy");
        liveRules = next;
        rulesFromOverride = fromOverride;
    }

    protected override void onStart() {
        try {
            redis = new RedisStorage();
            redis.connectFromUrl(fe.redisUrl);
        } catch (Exception e) {
            redis = null;
            logWarn("FiberEye: Redis unavailable: %s", e.msg);
        }
        try store = new FiberEyeStore();
        catch (Exception e) {
            store = null;
            logWarn("FiberEye: Mongo unavailable: %s", e.msg);
        }
        try {
            pushRedis = new RedisStorage();
            pushRedis.connectFromUrl(fe.redisUrl);
        } catch (Exception e) {
            pushRedis = null;
            logWarn("FiberEye: producer Redis unavailable: %s", e.msg);
        }
        IpIntelStore intelStore;
        try intelStore = new IpIntelStore();
        catch (Exception e) {
            intelStore = null;
            logWarn("FiberEye: ipintel Mongo unavailable: %s", e.msg);
        }
        intel = new IpIntelService(redis, intelStore, loadIpIntelSettings());
        logInfo("FiberEye: ipintel sources: %s", intel.activeSources());
    }

    // ── inbound protocol ─────────────────────────────────────────────

    protected override bool onLine(ref IrcLine l) {
        switch (l.command) {
            case "330":   // RPL_WHOISACCOUNT — [me, nick, account, "is logged in as"]
                if (l.params.length >= 3) onWhoisAccount(l.params[1], l.params[2]);
                return true;
            case "210":   // one X-line row of a STATS sweep
                {
                    XLine x;
                    if (parseStatsXLine(l, x) && x.type == "Z") pendingStats[x.mask] = x;
                }
                return true;
            case "219":   // RPL_ENDOFSTATS — the sweep is complete
                onStatsComplete();
                return true;
            default:
                return false;
        }
    }

    /// `+s +cCqx` for the notices; the STATS sweep needs oper. The Tor
    /// exit list refresh is per process, not per session.
    protected override void onReady() {
        if (isOpered()) {
            if (!statsLoopStarted) { statsLoopStarted = true; runTask(&statsLoop); }
        } else {
            logWarn("FiberEye: not opered — no connect notices and no bans");
        }
        if (!torLoopStarted) { torLoopStarted = true; runTask(&torListLoop); }
    }

    /// In `#staff`: start draining the announcement outbox.
    protected override void onJoined(string channel) {
        if (icmp(channel, fe.channel) != 0) return;
        if (outboxTask == Task.init || !outboxTask.running) outboxTask = runTask(&outboxLoop);
    }

    /// The outbox consumer ends with the session; the next session starts a fresh one.
    protected override void onSessionEnd() {
        if (outboxTask != Task.init) {
            try outboxTask.join(); catch (Exception) {}
            outboxTask = Task.init;
        }
    }

    // ── connect / quit observation ───────────────────────────────────

    private static string openKey(string nick_, string ip) {
        return nick_.toLower() ~ "\0" ~ ip;
    }

    private void rememberOpen(string key, string id, long ts) {
        if (!(key in openSessions)) {
            openOrder ~= key;
            if (openOrder.length > MAX_OPEN_SESSIONS) {
                const evict = openOrder[0];
                openOrder = openOrder[1 .. $];
                if (auto old = evict in openSessions) {
                    openedAt.remove(*old);
                    openSessions.remove(evict);
                }
            }
        }
        openSessions[key] = id;
        openedAt[id] = ts;
    }

    /// A server notice: a connect notice (snomask `c`), a local quit
    /// notice (`q`), or an X-line notice (`x`). Our own placements are
    /// announced by `enforceBan` itself; anything else the ircd reports
    /// (connectban automatics, oper/human bans) is announced here so
    /// #staff sees every ban. Removals and expiries stay quiet — the
    /// sweep already logs those and they would double the noise.
    protected override void onServerNotice(string text) {
        auto c = parseConnectNotice(text);
        if (c.ok) { onConnect(c); return; }
        auto q = parseQuitNotice(text);
        if (q.ok) { onQuit(q); return; }
        const t = text.strip();
        if (t.indexOf("Z-line") >= 0 || t.indexOf("Z:line") >= 0 || t.indexOf("ZLINE") >= 0)
            logInfo("FiberEye: xline notice: %s", t);
        if (t.indexOf("XLINE:") < 0 || t.indexOf("added a ") < 0) return;
        // Mask sits between " on " and the next comma:
        // "... added a timed Z-line on 203.0.113.7, expires in ...: <reason>".
        // If it won't parse, announce anyway — a duplicate of our own ban
        // (when the map below misses) beats a silent foreign one.
        string mask;
        const onPos = t.indexOf(" on ");
        if (onPos >= 0) {
            const rest = t[onPos + 4 .. $];
            const comma = rest.indexOf(",");
            if (comma > 0)
                mask = rest[0 .. comma].strip();
        }
        if (mask.length) {
            if (auto at = mask in ownBanAt) {
                if (nowMs() - *at < 120_000) return; // ours — already announced
                ownBanAt.remove(mask);
            }
        }
        string shown = t;
        if (shown.startsWith("*** "))
            shown = shown[4 .. $].strip();
        LogEvent banEv;
        banEv.type = "notice";
        banEv.ts = nowMs();
        banEv.actor = "FiberEye";
        banEv.text = shown;
        pushLogEvent(pushRedis, banEv);
    }

    private void onConnect(ConnectNotice c) {
        if (classIgnored(c.connClass, liveRules.ignoreClasses)) {
            connectsIgnored++;
            return;
        }
        connectsSeen++;
        // Mutable: `runTask` copies its arguments into the task's own
        // storage and cannot assign through a `const` type.
        string group = ipGroup(c.ip);

        SessionRecord r;
        r.ts = nowMs();
        r.nick = c.nick;
        r.ident = c.ident;
        r.host = c.host;
        r.ip = c.ip;
        r.realname = c.realname;
        r.connClass = c.connClass;
        r.port = c.port;
        r.tls = c.port == 6697;
        r.ipGroup = group;
        r.ipVersion = c.ip.indexOf(':') >= 0 ? 6 : 4;
        r.geoPending = true;

        string id;
        if (store !is null) {
            id = store.insertSession(r);
            r.id = id;
            store.upsertIp(r);
        }
        if (id.length) rememberOpen(openKey(c.nick, c.ip), id, r.ts);

        // Sighting + record + `#staff` announcement, off the read loop. The
        // announcement is queued only after the record is assembled, so the
        // outbox consumer always hits the 1 h cache. Private addresses are
        // persisted but neither looked up nor announced.
        if (!isPrivateIp(c.ip)) {
            long ts = r.ts;
            runTask(&intelTask, c, group, ts);
        }

        // A trusted-subnet container address must never be banned: that
        // would take the whole platform offline. Persist it, count nothing.
        if (isPrivateIp(c.ip) || exempt(c.ip, group)) return;

        Observation o;
        o.windowSeconds = liveRules.thresholds.windowSeconds;
        if (!countConnect(group, c.nick, r.ts, o)) return;
        const v = evaluate(o, liveRules.thresholds);
        if (!v.trip) {
            // Account enrichment is best-effort and must never compete
            // with an enforcement line for the 1-line-per-second budget,
            // so at most one WHOIS every 5 s and never for a tripping
            // group. A flood's nicks stay unenriched, which is fine.
            if (isOpered() && id.length && r.ts - lastWhoisMs >= 5_000) {
                lastWhoisMs = r.ts;
                sendLine("WHOIS " ~ c.nick);
            }
            return;
        }
        // Never enforce inline: `enforceBan` writes Mongo and sleeps
        // between the ZLINE and its confirming sweep, and the read loop
        // must keep draining server notices while that happens.
        string rule = v.rule;
        runTask(&enforceTask, group, rule,
            BanEvidence(o.connects, o.nicks, o.churn, o.windowSeconds));
    }

    /// `runTask` entry point for enforcement — a named nothrow method so
    /// a Mongo or IRC failure inside it can never escape into the task
    /// scheduler.
    private void enforceTask(string group, string rule, BanEvidence ev) nothrow {
        try enforceBan(group, rule, ev);
        catch (Exception e) {
            try logWarn("FiberEye: enforcement failed for %s: %s", group, e.msg);
            catch (Exception) {}
        }
    }

    private void onQuit(QuitNotice q) {
        quitsSeen++;
        const key = openKey(q.nick, q.ip);
        auto found = key in openSessions;
        if (found is null) return;
        const id = *found;
        openSessions.remove(key);
        const ts = nowMs();
        long duration;
        if (store !is null) {
            // The connect timestamp is the row's own `ts`; reading it back
            // is one findOne, so instead the duration is derived from the
            // session map's insertion time when available.
            auto opened = openedAt.get(id, 0L);
            duration = opened > 0 ? ts - opened : 0;
            store.closeSession(id, ts, q.reason, duration);
        }
        openedAt.remove(id);
        if (duration > 0 && duration < liveRules.thresholds.shortMs) {
            const group = ipGroup(q.ip);
            if (!isPrivateIp(q.ip) && !exempt(q.ip, group)) {
                countChurn(group, ts);
                if (store !is null) store.bumpShortSession(group);
            }
        }
    }

    /// True when this connect is on the never-count, never-ban list.
    ///
    /// An entry may be the IP group verbatim (`2603:8001:98f0:1530::/64`),
    /// any CIDR that covers the address (`198.51.100.0/24`), a glob, or a
    /// bare address — `zlineMatches` is the same predicate the unban page
    /// uses, so an operator writes an exemption exactly like a Z-line mask
    /// instead of having to guess the grouped form. An exact-string-only
    /// match would silently ignore a `/24` entry, which is the sort of
    /// exemption that only gets tested the day it fails to hold.
    private bool exempt(string ip, string group) {
        foreach (e; liveRules.exemptIps) {
            if (e == group || e == ip) return true;
            if (zlineMatches(e, ip)) return true;
        }
        return false;
    }

    private void onWhoisAccount(string who, string account) {
        if (!account.length) return;
        accountLookups++;
        // The map key needs the IP, which a 330 does not carry, so the
        // newest open session for this nick is the one that gets it.
        foreach (key, id; openSessions) {
            const sep = key.indexOf('\0');
            if (sep < 0) continue;
            if (icmp(key[0 .. sep], who) != 0) continue;
            if (store !is null) {
                store.setSessionAccount(id, account);
                const ipPart = key[sep + 1 .. $];
                store.setIpAccount(ipGroup(ipPart), account);
            }
            return;
        }
    }

    // ── window counters ──────────────────────────────────────────────

    /// Adds this connect to the group's sorted sets, trims them to the
    /// window and reads the three counts back. False when Redis is
    /// unavailable — no counters means no verdict, which fails safe.
    private bool countConnect(string group, string nick_, long ts, ref Observation o) {
        if (redis is null) return false;
        const windowMs = liveRules.thresholds.windowSeconds * 1000;
        const cutoff = ts - windowMs;
        const ttl = liveRules.thresholds.windowSeconds * 4;
        try {
            auto db = redis.getDb();
            const ck = fiberEyeConnKey(group);
            const nk = fiberEyeNickKey(group);
            const hk = fiberEyeChurnKey(group);
            // Score is the connect instant; the member carries the nick so
            // two connects in the same millisecond never collapse into one.
            db.zadd(ck, ts, ts.to!string ~ ":" ~ nick_);
            db.zremRangeByScore(ck, 0.0, cast(double) cutoff);
            db.expire(ck, ttl);
            o.connects = db.zcard(ck);
            db.zadd(nk, ts, nick_.toLower());
            db.zremRangeByScore(nk, 0.0, cast(double) cutoff);
            db.expire(nk, ttl);
            o.nicks = db.zcard(nk);
            db.zremRangeByScore(hk, 0.0, cast(double) cutoff);
            o.churn = db.zcard(hk);
            return true;
        } catch (Exception e) {
            logWarn("FiberEye: window counters failed for %s: %s", group, e.msg);
            return false;
        }
    }

    private void countChurn(string group, long ts) {
        if (redis is null) return;
        try {
            auto db = redis.getDb();
            const hk = fiberEyeChurnKey(group);
            db.zadd(hk, ts, ts.to!string);
            db.expire(hk, liveRules.thresholds.windowSeconds * 4);
        } catch (Exception e) {
            logWarn("FiberEye: churn counter failed for %s: %s", group, e.msg);
        }
    }

    // ── enforcement ──────────────────────────────────────────────────

    private bool armedOn(RedisStorage r) {
        if (r is null) return false;
        try return r.getDb().get(fiberEyeArmedKey()) == "1";
        catch (Exception e) {
            // A Redis wipe or outage must not arm enforcement.
            logWarn("FiberEye: cannot read the arm flag: %s", e.msg);
            return false;
        }
    }

    /// Records a verdict and, when armed, places the Z-line.
    private void enforceBan(string group, string rule, BanEvidence ev) {
        if (store is null) return;
        const now = nowMs();
        // A continuing flood must not create one ban row per connect.
        if (!store.activeBanForGroup(group, now).isNull) return;

        const isArmed = armedOn(redis);
        long strikes = 1;
        if (redis !is null) {
            try {
                auto db = redis.getDb();
                const sk = fiberEyeStrikeKey(group);
                strikes = db.incr(sk);
                if (strikes == 1) db.expire(sk, 604_800);
            } catch (Exception e) {
                logWarn("FiberEye: strike counter failed for %s: %s", group, e.msg);
                strikes = 1;
            }
        }
        const seconds_ = banDurationFor(strikes, liveRules.thresholds.banSeconds);
        const token = generateServicesPassword(40);
        const appealUrl = fe.publicBase ~ "/unban/" ~ token;

        BanRecord b;
        b.mask = group;
        b.ipGroup = group;
        b.type = "zline";
        b.rule = rule;
        b.reason = banReason(rule, appealUrl);
        b.durationSeconds = seconds_;
        b.placedAtMs = now;
        b.expiresAtMs = now + seconds_ * 1000;
        b.strikes = strikes;
        b.token = token;
        b.observeOnly = !isArmed;
        b.evidence = ev;
        if (!isArmed) b.placeError = "";
        else if (!fe.operName.length || !isOpered()) b.placeError = "not opered";
        const banId = store.insertBan(b);

        if (!isArmed) {
            bansObserved++;
            store.setIpBan(group, 0, banId, strikes);
            logInfo("FiberEye: would ban %s (%s, strike %s, %ss) — enforcement disarmed",
                group, rule, strikes, seconds_);
            return;
        }
        if (!fe.operName.length || !isOpered()) {
            logWarn("FiberEye: %s tripped %s but the bot is not opered — no ZLINE placed",
                group, rule);
            store.setIpBan(group, 0, banId, strikes);
            return;
        }

        Appeal appeal;
        appeal.mask = b.mask;
        appeal.ipGroup = group;
        appeal.banId = banId;
        appeal.reason = b.reason;
        appeal.placedAtMs = b.placedAtMs;
        appeal.expiresAtMs = b.expiresAtMs;
        if (redis !is null)
            redis.setJson(fiberEyeAppealKey(token), appeal.toJson(), seconds_ + 86_400);

        sendLine("ZLINE " ~ b.mask ~ " " ~ seconds_.to!string ~ " :" ~ b.reason);
        // Remember our own placement so the ircd's X-line notice for it
        // (arriving ~instantly on snomask `x`) doesn't double-announce.
        // Prune here — the map only ever holds a handful of masks.
        // Two passes: removing mid-iteration is not safe.
        ownBanAt[b.mask] = now;
        string[] stale;
        foreach (m, at; ownBanAt)
            if (now - at > 3_600_000)
                stale ~= m;
        foreach (m; stale)
            ownBanAt.remove(m);
        bansPlaced++;
        store.setIpBan(group, b.expiresAtMs, banId, strikes);
        logInfo("FiberEye: ZLINE %s for %ss (%s, strike %s)", b.mask, seconds_, rule, strikes);
        // Every placed ban is announced in #staff through the same outbox
        // as connects/signups — a "notice" needs no schema change and the
        // formatter already renders it. Only placed bans announce: disarmed
        // observes and not-opered failures set nothing, so they stay quiet.
        LogEvent banEv;
        banEv.type = "notice";
        banEv.ts = now;
        banEv.actor = "FiberEye";
        banEv.text = "ZLINE " ~ b.mask ~ " for " ~ seconds_.to!string ~ "s ("
            ~ rule ~ ", strike " ~ strikes.to!string ~ ")";
        pushLogEvent(pushRedis, banEv);
        // InspIRCd answers a successful ZLINE with silence, so the sweep is
        // what flips `placed`.
        sleep(3.seconds);
        sendLine("STATS Z");
    }

    // ── STATS Z sweep and reconciliation ─────────────────────────────

    private void statsLoop() nothrow {
        while (true) {
            try {
                sleep(STATS_INTERVAL.seconds);
                if (!isAlive() || !isOpered()) continue;
                sendLine("STATS Z");
            } catch (Exception e) {
                try logWarn("FiberEye: stats sweep failed: %s", e.msg); catch (Exception) {}
                try sleep(5.seconds); catch (Exception) {}
            }
        }
    }

    /// Swaps the accumulated `210` rows in, then reconciles both ways:
    /// unconfirmed bans that are now listed become `placed`, and standing
    /// bans the ircd no longer lists are recorded as gone so the admin page
    /// never shows a ban that is not in force.
    private void onStatsComplete() {
        bool[string] active;
        foreach (mask, _; pendingStats) active[mask] = true;
        activeZlines = active;
        pendingStats = null;
        if (store is null) return;
        const now = nowMs();
        foreach (b; store.standingBans(now)) {
            const listed = (b.mask in activeZlines) !is null;
            if (listed && !b.placed) {
                store.markBanPlaced(b.id, true, "");
                logInfo("FiberEye: ZLINE %s confirmed by STATS Z", b.mask);
            } else if (!listed && b.placed) {
                store.markBanReleased(b.id, now, "expired-or-removed");
                store.setIpBan(b.ipGroup, 0, b.id, b.strikes);
                logInfo("FiberEye: ZLINE %s is gone from the ircd — marking released", b.mask);
            }
        }
    }

    // ── IP intelligence + `#staff` announcements ─────────────────────

    /// Sighting counter, record assembly, FiberEye rollup fields, then
    /// the `irc_connect` outbox entry. Named nothrow so nothing escapes
    /// into the scheduler.
    private void intelTask(ConnectNotice c, string group, long ts) nothrow {
        try {
            bool first;
            intel.recordSighting(c.ip, ts, first);
            auto rec = intel.lookup(c.ip, LookupMode.enrich);
            intelLookups++;
            if (rec.degraded.length) intelFailures++;
            if (store !is null) {
                store.setIpIntel(group, rec);
                store.fillGroupIntel(group, rec);
            }
            LogEvent ev;
            ev.type = "irc_connect";
            ev.ts = ts;
            ev.nick = c.nick;
            ev.ident = c.ident;
            ev.host = c.host;
            ev.ip = c.ip;
            ev.realname = c.realname;
            ev.connClass = c.connClass;
            ev.port = c.port;
            pushLogEvent(pushRedis, ev);
        } catch (Exception e) {
            try logWarn("FiberEye: intel task failed for %s: %s", c.ip, e.msg); catch (Exception) {}
        }
    }

    /// Hourly Tor bulk exit list → `irc:ipintel:torexits` (and once at start).
    private void torListLoop() nothrow {
        while (true) {
            try intel.refreshTorExits();
            catch (Exception e) {
                try logWarn("FiberEye: tor list refresh failed: %s", e.msg); catch (Exception) {}
            }
            try sleep(TOR_REFRESH.minutes); catch (Exception) {}
        }
    }

    /// Drains `logsOutboxKey()` while connected and in `#staff`. On a send
    /// failure the entry goes back to the head of the list and the loop
    /// ends; the next session starts a fresh consumer.
    private void outboxLoop() nothrow {
        RedisStorage box;
        try {
            box = new RedisStorage();
            box.connectFromUrl(fe.redisUrl);
            const key = logsOutboxKey();
            while (isAlive()) {
                if (!joined(fe.channel)) { sleep(1.seconds); continue; }
                Nullable!(Tuple!(string, string)) popped;
                try popped = box.getDb().blpop!string(key, 5);
                catch (Exception e) {
                    logWarn("FiberEye: outbox BLPOP failed: %s", e.msg);
                    sleep(5.seconds);
                    continue;
                }
                if (popped.isNull) continue;
                const raw = popped.get[1];
                LogEvent ev;
                try ev = LogEvent.fromJson(parseJsonString(raw));
                catch (Exception e) {
                    logWarn("FiberEye: dropping malformed outbox entry: %s", e.msg);
                    continue;
                }
                bool first = false;
                IpIntel rec;
                if (ev.ip.strip().length && !isPrivateIp(ev.ip)) {
                    // A signup is its own sighting; a connect was counted by
                    // `intelTask` before it was queued.
                    if (ev.type == "signup") intel.recordSighting(ev.ip, ev.ts, first);
                    rec = intel.lookup(ev.ip, LookupMode.enrich);
                    intelLookups++;
                    if (rec.degraded.length) intelFailures++;
                    if (ev.type == "irc_connect") first = rec.reputation.sessionCount <= 1;
                }
                auto lines = formatLogEvent(ev, rec, first);
                if (!lines.length) {
                    logWarn("FiberEye: dropping outbox entry of unknown type %s", ev.type);
                    continue;
                }
                try say(fe.channel, lines);
                catch (Exception e) {
                    try box.getDb().lpush(key, raw); catch (Exception) {}
                    throw e;
                }
                announcedCount++;
                lastAnnouncement = lines[0];
                lastAnnouncementAt = nowMs();
                logInfo("FiberEye: announced %s", ev.type);
            }
        } catch (Exception e) {
            try logWarn("FiberEye: outbox loop ended: %s", e.msg); catch (Exception) {}
        }
        if (box !is null) box.close();
    }

    // ── Redis sideband: heartbeat for the admin page + control ───────

    /// FiberEye's own heartbeat fields. The arm flag is read through the
    /// sideband's own Redis connection so it never shares a request with
    /// the reader fiber.
    protected override void extendStatus(ref Json j, RedisStorage side) {
        j["armed"] = Json(armedOn(side));
        j["connectsSeen"] = Json(connectsSeen);
        j["connectsIgnored"] = Json(connectsIgnored);
        j["quitsSeen"] = Json(quitsSeen);
        j["sessionsOpen"] = Json(cast(long) openSessions.length);
        j["bansPlaced"] = Json(bansPlaced);
        j["bansObserved"] = Json(bansObserved);
        j["activeZlines"] = Json(cast(long) activeZlines.length);
        j["accountLookups"] = Json(accountLookups);
        j["announced"] = Json(announcedCount);
        j["lastAnnouncement"] = Json(lastAnnouncement);
        j["lastAnnouncementAt"] = Json(lastAnnouncementAt);
        j["intelLookups"] = Json(intelLookups);
        j["intelFailures"] = Json(intelFailures);
        auto srcs = Json.emptyArray;
        if (intel !is null) foreach (s; intel.activeSources()) srcs ~= Json(s);
        j["intelSources"] = srcs;
        j["rules"] = liveRules.toJson();
        j["rulesDeployed"] = deployedRules.toJson();
        j["rulesSource"] = Json(rulesFromOverride ? "override" : "deployed");
    }

    protected override void onControl(string cmd, Json entry) {
        const by = entry["by"].opt!string;
        switch (cmd) {
            case "stats":
                if (!isOpered()) {
                    logInfo("FiberEye: stats requested by %s while not opered — ignored", by);
                    return;
                }
                logInfo("FiberEye: STATS Z sweep requested by %s", by);
                try sendLine("STATS Z");
                catch (Exception e) logWarn("FiberEye: stats sweep failed: %s", e.msg);
                break;
            default:
                logWarn("FiberEye: unknown control command %s from %s", cmd, by);
                break;
        }
    }
}
