/**
 * FiberEye — the connection-intelligence bot.
 *
 * An opered IRC connection that runs inside the same gateway image but
 * only in the process that sets `IRCFIBER_FIBEREYE_ENABLED=1` (prod: the
 * dedicated `ircfiber-fibereye` container).
 *
 * It joins no channel and sends no PRIVMSG. Everything it does is:
 *   - subscribe to snomasks `+s +cqx` and persist every connect and quit
 *     to Mongo (`ircfiber.fibereye.store`);
 *   - count connects, distinct nicks and short sessions per IP group in
 *     Redis sorted sets, and ask `ircfiber.fibereye.rules` for a verdict;
 *   - place a timed `ZLINE` when a rule trips *and* enforcement is armed
 *     (`fibereye:armed` = "1", flipped from the admin page — the bot ships
 *     disarmed and merely records what it would have done);
 *   - confirm its own placements with a periodic `STATS Z` sweep, because
 *     InspIRCd answers a successful `ZLINE` with silence.
 *
 * It is deliberately *not* the code that removes a Z-line: releases happen
 * in the web process over the dashboard-oper session
 * (`ircfiber.web.admin.ircd.removeXlineNow`), which is where both the
 * admin Release button and the public `/unban` page live.
 *
 * The IRC client skeleton (reconnects, OPER, sideband) is
 * `ircfiber.bots.core.IrcBot`; this module is only the FiberEye logic.
 *
 * Env:
 *   IRCFIBER_FIBEREYE_ENABLED              "1"/"true" → run (unset → disabled)
 *   IRCFIBER_FIBEREYE_HOST                 ircd host (default IRCFIBER_IRCD_HOST, then irc.ircfiber.com)
 *   IRCFIBER_FIBEREYE_PORT                 ircd port (default IRCFIBER_IRCD_PORT, then 6667)
 *   IRCFIBER_FIBEREYE_TLS                  "1" → TLS client connection
 *   IRCFIBER_FIBEREYE_NICK                 default FiberEye
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
 *   IRCFIBER_REDIS_URL                     counters, heartbeat and control
 */
module ircfiber.fibereye.bot;

import std.conv : to;
import std.process : environment;
import std.string : indexOf, strip, toLower;
import std.uni : icmp;
import core.time : seconds;

import vibe.core.core : runTask, sleep;
import vibe.core.log;
import vibe.data.json : Json;

import ircfiber.bots.core;
import ircfiber.env : envSecret;
import ircfiber.fibereye.events;
import ircfiber.fibereye.format;
import ircfiber.fibereye.rules;
import ircfiber.fibereye.store;
import ircfiber.logs.geo : cachedGeo;
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
    logInfo("FiberEye starting: %s:%s (%s) nick=%s oper=%s window=%ss "
        ~ "connects=%s nicks=%s churn=%s ban=%ss ignore=%s exempt=%s",
        cfg.host, cfg.port, cfg.tls ? "TLS" : "plaintext", cfg.nick,
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
    // `c` connects, `q` local quits, `x` X-line notices.
    b.snomasks = "cqx";
    b.redisUrl = c.redisUrl;
    b.heartbeatKey = fiberEyeBotKey();
    b.controlKey = fiberEyeControlKey();
    b.logPrefix = "FiberEye";
    return b;
}

/// The FiberEye logic on top of the shared IRC client skeleton.
final class FiberEyeBot : IrcBot {
    private enum STATS_INTERVAL = 60;
    private enum GEO_INTERVAL = 60;
    /// Open-session map cap. A flood must not grow it without bound; the
    /// oldest insertion is evicted, which only costs a `durationMs` on a
    /// session that has been open longer than 20 000 others.
    private enum MAX_OPEN_SESSIONS = 20_000;

    private FiberEyeConfig fe;
    /// Redis connection owned by the reader fiber (each loop owns its own).
    private RedisStorage redis;
    private FiberEyeStore store;

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
    private XLine[string] pendingStats;
    private bool statsLoopStarted;
    private bool geoLoopStarted;

    // ── status published to Redis for the admin FiberEye page ──
    private long connectsSeen;
    private long connectsIgnored;
    private long quitsSeen;
    private long bansPlaced;
    private long bansObserved;
    private long accountLookups;
    private long geoFilled;

    this(FiberEyeConfig cfg) {
        super(coreConfig(cfg));
        this.fe = cfg;
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

    /// FiberEye joins no channel: `+s +cqx` is its entire subscription.
    protected override void onReady() {
        if (isOpered()) {
            if (!statsLoopStarted) { statsLoopStarted = true; runTask(&statsLoop); }
        } else {
            logWarn("FiberEye: not opered — no connect notices and no bans");
        }
        if (!geoLoopStarted) { geoLoopStarted = true; runTask(&geoLoop); }
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
    /// notice (`q`), or an X-line notice (`x`, logged only — placements are
    /// confirmed by the `STATS Z` sweep, which is the only truthful oracle
    /// from inside a read loop).
    protected override void onServerNotice(string text) {
        auto c = parseConnectNotice(text);
        if (c.ok) { onConnect(c); return; }
        auto q = parseQuitNotice(text);
        if (q.ok) { onQuit(q); return; }
        const t = text.strip();
        if (t.indexOf("Z-line") >= 0 || t.indexOf("Z:line") >= 0 || t.indexOf("ZLINE") >= 0)
            logInfo("FiberEye: xline notice: %s", t);
    }

    private void onConnect(ConnectNotice c) {
        if (classIgnored(c.connClass, fe.ignoreClasses)) {
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

        // A trusted-subnet container address must never be banned: that
        // would take the whole platform offline. Persist it, count nothing.
        if (isPrivateIp(c.ip) || exempt(c.ip, group)) return;

        Observation o;
        o.windowSeconds = fe.thresholds.windowSeconds;
        if (!countConnect(group, c.nick, r.ts, o)) return;
        const v = evaluate(o, fe.thresholds);
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
        if (duration > 0 && duration < fe.thresholds.shortMs) {
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
        foreach (e; fe.exemptIps) {
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
        const windowMs = fe.thresholds.windowSeconds * 1000;
        const cutoff = ts - windowMs;
        const ttl = fe.thresholds.windowSeconds * 4;
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
            db.expire(hk, fe.thresholds.windowSeconds * 4);
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
        const seconds_ = banDurationFor(strikes, fe.thresholds.banSeconds);
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
        bansPlaced++;
        store.setIpBan(group, b.expiresAtMs, banId, strikes);
        logInfo("FiberEye: ZLINE %s for %ss (%s, strike %s)", b.mask, seconds_, rule, strikes);
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

    // ── geo backfill ─────────────────────────────────────────────────

    /// Cache-only geo backfill. FiberEye never performs an ipinfo lookup:
    /// `lookupGeo` sets the "first sighting" marker the #staff bot's
    /// `↳ <ip> · <geo detail>` follow-up line depends on, and whichever bot
    /// won the race would steal it.
    private void geoLoop() nothrow {
        while (true) {
            try {
                sleep(GEO_INTERVAL.seconds);
                if (store is null || redis is null) continue;
                foreach (ip; store.pendingGeoIps(20)) {
                    const addr = ip.ip.length ? ip.ip : ip.ipGroup;
                    auto g = cachedGeo(redis, addr);
                    if (!g.ok) continue;
                    store.setIpGeo(ip.ipGroup, g);
                    store.fillGroupGeo(ip.ipGroup, g);
                    geoFilled++;
                }
            } catch (Exception e) {
                try logWarn("FiberEye: geo backfill failed: %s", e.msg); catch (Exception) {}
                try sleep(5.seconds); catch (Exception) {}
            }
        }
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
        j["geoFilled"] = Json(geoFilled);
        auto t = Json.emptyObject;
        t["windowSeconds"] = Json(fe.thresholds.windowSeconds);
        t["connects"] = Json(fe.thresholds.connects);
        t["nicks"] = Json(fe.thresholds.nicks);
        t["churn"] = Json(fe.thresholds.churn);
        t["shortMs"] = Json(fe.thresholds.shortMs);
        t["banSeconds"] = Json(fe.thresholds.banSeconds);
        j["thresholds"] = t;
        auto ignore = Json.emptyArray;
        foreach (c; fe.ignoreClasses) ignore ~= Json(c);
        j["ignoreClasses"] = ignore;
        auto exemptJson = Json.emptyArray;
        foreach (e; fe.exemptIps) exemptJson ~= Json(e);
        j["exemptIps"] = exemptJson;
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
