/**
 * NickServ → site auto-sync: every IRC-first user gets a site row.
 *
 * People register with NickServ over IRC without ever touching the site, so
 * they have no row in Mongo `users` and cannot log in, link, or be managed.
 * This loop reconciles the other direction from `!adduser`: every 10 minutes
 * it reads the Anope flatfile inventory (the gateway mounts it read-only;
 * RPC has no account enumeration) and mints a parked site row for every
 * NickServ account with no matching site user.
 *
 * Parked means exactly this: a normal `users` row with an unusable random
 * site password and NO Fiber network. The network is created on first site
 * login, where `loginPost` proves NickServ ownership (hash upgrade) and
 * captures the SASL credential — so the engine can never war over a nick
 * whose password we do not hold. See `parkOnSaslRejection` (engine) for the
 * other half of that guarantee.
 *
 * Safety, all load-bearing:
 * - Suspended NickServ accounts are skipped (re-run picks them up after
 *   unsuspend — no oper action needed to heal).
 * - Reserved names (services pseudoclients, role accounts) never mint rows.
 * - Capped at NICKSERV_SYNC_MAX_NEW_PER_RUN creations per cycle; an
 *   attacker mass-registering nicks buys throttled rows plus a staff feed,
 *   and the true nick owner self-heals via NickServ-password login (the
 *   409 on signup tells them to), so squatting cannot lock anyone out.
 * - Single-flight across gateway replicas via a Redis SET NX lock; the
 *   site-username unique index is the final backstop (duplicate key → skip).
 * - Kill-switch `irc:config:nickservSync` (default on), flippable at
 *   GET/POST /api/admin/config/nickserv-sync. No anope.db mount (support-bot
 *   container) → the inventory read reports unavailable and the cycle skips.
 *
 * `decideNickservSync` is @safe pure so it links into `services-test`.
 */
module ircfiber.services.nickserv_sync;

import std.conv : to;
import std.datetime : Clock;
import std.random : uniform;
import std.string : strip;
import std.uuid : randomUUID;
import core.time : seconds;

import vibe.core.core : runTask, sleep;
import vibe.core.log : logInfo, logWarn;

import ircfiber.auth : hashPassword;
import ircfiber.db.user : UserRepository;
import ircfiber.logs.events : LogEvent, pushLogEvent;
import ircfiber.mail : emailWellFormed;
import ircfiber.models.user : User;
import ircfiber.services.accounts : isValidIrcNick;
import ircfiber.services.anope_db : AnopeAccount, asciiLowerStr, readAnopeInventory;
import ircfiber.storage.redis : RedisStorage;
/// Seconds between reconciliation cycles.
enum NICKSERV_SYNC_INTERVAL_SECS = 600;
/// New site rows per cycle — bounds a mass-registration flood.
enum NICKSERV_SYNC_MAX_NEW_PER_RUN = 25;
/// Redis kill-switch; missing key means enabled.
enum NICKSERV_SYNC_CONFIG_KEY = "irc:config:nickservSync";
/// Single-flight lock across gateway replicas (shorter than the interval).
enum NICKSERV_SYNC_LOCK_KEY = "irc:nickserv-sync:lock";
enum NICKSERV_SYNC_LOCK_TTL_SECS = 540;
/// Last processed anope.db mtime; unchanged file → cycle is a no-op.
enum NICKSERV_SYNC_CURSOR_KEY = "irc:nickserv-sync:cursor";

/// Nicks that must never mint site rows: services pseudoclients plus the
/// generic role/admin names a squatter would reach for first. Compared
/// ASCII case-insensitively (IRC nicks are ASCII).
immutable string[] NICKSERV_SYNC_RESERVED = [
    "nickserv", "chanserv", "operserv", "memoserv", "hostserv", "botserv",
    "global", "admin", "administrator", "root", "system", "support", "help",
    "oper", "operator", "staff", "moderator", "webmaster", "postmaster",
    "abuse", "security", "info", "contact", "irc", "ircfiber", "fiber",
    "fiberserv", "owner",
];

/// Kill-switch read: true unless explicitly "0"/"false". Fail-open like
/// `isFiberEnabled` — a Redis hiccup must not silently stop the sync.
bool isNickservSyncEnabled(RedisStorage redis) @trusted {
    try {
        if (redis is null) return true;
        auto v = redis.getDb().get(NICKSERV_SYNC_CONFIG_KEY);
        if (v.length == 0) return true;
        return v != "0" && v != "false" && v != "False";
    } catch (Exception) {
        return true;
    }
}

/// Persists the kill-switch flag.
void setNickservSyncEnabled(RedisStorage redis, bool enabled) @trusted {
    redis.getDb().set(NICKSERV_SYNC_CONFIG_KEY, enabled ? "1" : "0");
}

/// Pure verdict for one inventory row. `haveUser` is whether a site row
/// already exists for the account (ASCII case-insensitive, the house rule).
struct SyncDecision {
    bool create;
    string username;    /// canonical account display when create
    string email;       /// INFO email, or the placeholder when unset
    string skipReason;  /// set when !create, for the cycle log
}

SyncDecision decideNickservSync(const AnopeAccount a, bool haveUser) @safe pure {
    SyncDecision d;
    string account = a.account.strip().length ? a.account.strip() : a.nick.strip();
    if (!account.length) {
        d.skipReason = "empty account name";
        return d;
    }
    if (!isValidIrcNick(account)) {
        d.skipReason = "not a valid IRC nick";
        return d;
    }
    foreach (r; NICKSERV_SYNC_RESERVED) {
        if (asciiLowerStr(account) == r) {
            d.skipReason = "reserved name";
            return d;
        }
    }
    if (a.suspended) {
        d.skipReason = "suspended in NickServ";
        return d;
    }
    if (haveUser) {
        d.skipReason = "site user exists";
        return d;
    }
    const mail = a.email.strip();
    d.create = true;
    d.username = account;
    d.email = emailWellFormed(mail) ? mail : account ~ "@provisioned.irc.invalid";
    return d;
}

/// Starts the reconcile fiber.
void startNickservSyncLoop() {
    runTask(&nickservSyncLoop);
    logInfo("NickServ sync starting (%ds interval, cap %d/cycle)",
        NICKSERV_SYNC_INTERVAL_SECS, NICKSERV_SYNC_MAX_NEW_PER_RUN);
}

private void nickservSyncLoop() nothrow {
    while (true) {
        try nickservSyncOnce();
        catch (Exception e) {
            try logWarn("nickserv sync: cycle failed: %s", e.msg);
            catch (Exception) {}
        }
        try sleep(NICKSERV_SYNC_INTERVAL_SECS.seconds);
        catch (Exception) {}
    }
}

private void nickservSyncOnce() {
    import std.process : environment;

    RedisStorage redis;
    try {
        auto r = new RedisStorage();
        r.connectFromUrl(environment.get("IRCFIBER_REDIS_URL", "redis://127.0.0.1:6379"));
        redis = r;
    } catch (Exception e) {
        logWarn("nickserv sync: redis unavailable, skipping cycle: %s", e.msg);
        return;
    }
    if (!isNickservSyncEnabled(redis)) return;

    // Single-flight: blue/green replicas share the schedule.
    bool locked = false;
    try {
        auto db = redis.getDb();
        db.request!string("SET", NICKSERV_SYNC_LOCK_KEY, "1", "NX", "EX",
            NICKSERV_SYNC_LOCK_TTL_SECS);
        locked = db.get(NICKSERV_SYNC_LOCK_KEY) == "1";
    } catch (Exception e) {
        logWarn("nickserv sync: lock failed, skipping cycle: %s", e.msg);
        return;
    }
    if (!locked) return;
    scope (exit) releaseSyncLock(redis);

    auto inv = readAnopeInventory();
    if (!inv.available) return; // no mount here (e.g. support-bot) — not an error
    bool unchanged = false;
    try {
        unchanged = redis.getDb().get(NICKSERV_SYNC_CURSOR_KEY) == inv.fileMtime.to!string;
    } catch (Exception) {}
    if (unchanged) return;

    // Preload site usernames once per cycle (tens of rows, one query).
    bool[string] haveUser;
    try {
        foreach (u; (new UserRepository()).findAll(10_000, 0))
            haveUser[asciiLowerStr(u.username)] = true;
    } catch (Exception e) {
        logWarn("nickserv sync: user preload failed: %s", e.msg);
        return;
    }

    int created = 0, skipped = 0;
    foreach (ref a; inv.accounts) {
        if (created >= NICKSERV_SYNC_MAX_NEW_PER_RUN) {
            logWarn("nickserv sync: hit cap %d, deferring the rest to next cycle",
                NICKSERV_SYNC_MAX_NEW_PER_RUN);
            break;
        }
        const key = asciiLowerStr(a.account.length ? a.account : a.nick);
        auto d = decideNickservSync(a, (key in haveUser) !is null);
        if (!d.create) {
            skipped++;
            continue;
        }
        if (mintSyncedUser(d)) {
            created++;
            haveUser[key] = true;
        } else {
            skipped++;
        }
    }
    // Advance the cursor only on a completed cycle: a mid-cycle failure
    // (mongo down) must retry the same file next time, not skip it.
    try redis.getDb().set(NICKSERV_SYNC_CURSOR_KEY, inv.fileMtime.to!string);
    catch (Exception) {}
    if (created) logInfo("nickserv sync: minted %d site row(s), skipped %d", created, skipped);
}

/// Lock release for the `scope (exit)` in `nickservSyncOnce` — `catch`
/// is illegal directly inside `scope (exit)`, hence the indirection.
private void releaseSyncLock(RedisStorage redis) nothrow {
    try redis.getDb().del(NICKSERV_SYNC_LOCK_KEY);
    catch (Exception) {}
}

/// Inserts the parked row + staff signup event. Returns false when another
/// writer won the race (duplicate key) — the next cycle treats it as ours.
private bool mintSyncedUser(const SyncDecision d) {
    import std.base64 : Base64;

    ubyte[32] raw;
    foreach (ref b; raw) b = cast(ubyte) uniform(0, 256);
    string randomPw = Base64.encode(raw[]).idup;
    User u;
    u.id = randomUUID();
    u.username = d.username;
    u.email = d.email;
    u.passwordHash = hashPassword(randomPw);
    randomPw = "";
    u.roles = ["user"];
    u.signupIp = "nickserv-sync";
    u.createdAt = Clock.currTime;
    u.provisionedFrom = "nickserv-sync:" ~ d.username;
    try {
        (new UserRepository()).create(u);
    } catch (Exception e) {
        import std.algorithm : canFind;
        if (!e.msg.canFind("duplicate key"))
            logWarn("nickserv sync: create %s failed: %s", d.username, e.msg);
        return false;
    }
    // Best-effort staff feed, same shape as a normal signup.
    try {
        RedisStorage r2;
        try {
            import std.process : environment;
            auto r = new RedisStorage();
            r.connectFromUrl(environment.get("IRCFIBER_REDIS_URL", "redis://127.0.0.1:6379"));
            r2 = r;
        } catch (Exception) {}
        if (r2 !is null) {
            try {
                LogEvent le;
                le.type = "signup";
                le.ts = Clock.currTime.toUnixTime!long * 1000;
                le.username = u.username;
                le.email = u.email;
                le.ip = "nickserv-sync";
                pushLogEvent(r2, le);
            } catch (Exception e) {
                logWarn("nickserv sync: announce %s failed: %s", d.username, e.msg);
            }
            try r2.close();
            catch (Exception) {}
        }
    } catch (Exception e) {
        logWarn("nickserv sync: announce %s failed: %s", d.username, e.msg);
    }
    return true;
}

@("sync creates a bare account with a placeholder email")
unittest {
    AnopeAccount a;
    a.nick = "lex0de";
    a.account = "lex0de";
    a.email = "";
    auto d = decideNickservSync(a, false);
    assert(d.create && d.username == "lex0de");
    assert(d.email == "lex0de@provisioned.irc.invalid");
}

@("sync keeps a well-formed NickServ email")
unittest {
    AnopeAccount a;
    a.nick = "lex0de";
    a.account = "lex0de";
    a.email = "lex0de@tuta.com";
    auto d = decideNickservSync(a, false);
    assert(d.create && d.email == "lex0de@tuta.com");
}

@("sync skips reserved names case-insensitively")
unittest {
    AnopeAccount a;
    a.account = "NickServ";
    assert(!decideNickservSync(a, false).create);
    a.account = "ADMIN";
    assert(!decideNickservSync(a, false).create);
}

@("sync skips existing users, bad nicks and suspended accounts")
unittest {
    AnopeAccount a;
    a.account = "dnsk";
    assert(!decideNickservSync(a, true).create);
    a.account = "123bad";
    assert(!decideNickservSync(a, false).create);
    a.account = "goodnick";
    a.suspended = true;
    auto d = decideNickservSync(a, false);
    assert(!d.create && d.skipReason == "suspended in NickServ");
}
