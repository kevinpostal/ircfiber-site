/**
 * NickServ → site auto-sync: every IRC-first user gets a site row.
 *
 * People register with NickServ over IRC without ever touching the site, so
 * they have no row in Mongo `users` and cannot log in, link, or be managed.
 * This loop reconciles the other direction from `!adduser`: every 10 minutes
 * it reads the Anope flatfile inventory (the gateway mounts it read-only;
 * RPC has no account enumeration) and mints a parked site row for every
 * NickServ account nobody already owns — no site user of that name, no
 * Fiber network credential link (`saslUsername` — the provisioner's
 * collision-fallback accounts belong to an existing site user under a
 * different name), no site user carrying its email, and not a staff or
 * infrastructure account.
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
 *   unsuspend — no oper action needed to heal). Anope suspends the account,
 *   so the inventory flags every grouped alias of it.
 * - Reserved names (services pseudoclients, role accounts) never mint rows.
 * - Staff and infrastructure accounts (opers via `OperServ OPER LIST`, the
 *   RPC oper account, both bot nicks) never mint rows — same oracle as the
 *   admin page (`ircfiber.services.staff`).
 * - An account whose email already belongs to a site user is skipped: that
 *   human has an account; a second one would double every bulk mailing.
 *   Linking the nick to them stays an admin action.
 * - Capped at NICKSERV_SYNC_MAX_NEW_PER_RUN creations per cycle; an
 *   attacker mass-registering nicks buys throttled rows plus a staff feed,
 *   and the true nick owner self-heals via NickServ-password login (the
 *   409 on signup tells them to), so squatting cannot lock anyone out.
 * - Single-flight across gateway replicas via a `SET NX` token compared on
 *   read-back; the site-username unique index is the final backstop
 *   (duplicate key → skip).
 * - Kill-switch `irc:config:nickservSync` (default on), flippable at
 *   GET/POST /api/admin/config/nickserv-sync. No anope.db mount (support-bot
 *   container) → the inventory read reports unavailable and the cycle skips.
 * - Each cycle that processes an inventory records `irc:nickserv-sync:status`
 *   (`NickservSyncStatus`), shown on the admin NickServ tab.
 *
 * `decideNickservSync` is @safe pure so it links into `services-test`.
 */
module ircfiber.services.nickserv_sync;

import std.algorithm : canFind;
import std.conv : ConvException, to;
import std.datetime : Clock;
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
import ircfiber.services.accounts : generateServicesPassword, isValidIrcNick;
import ircfiber.services.anope_db : AnopeAccount, AnopeInventory, asciiLowerStr,
    readAnopeInventory;
import ircfiber.services.staff : staffAccountsLower;
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
/// Hash describing the last cycle that processed an inventory (see
/// NickservSyncStatus); read by GET /api/admin/config/nickserv-sync.
enum NICKSERV_SYNC_STATUS_KEY = "irc:nickserv-sync:status";

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

/// Canonical account name for one inventory row: the owning core's display,
/// or the alias nick when the core is missing (mid-write file).
string syncAccountName(const AnopeAccount a) @safe pure {
    const acct = a.account.strip();
    return acct.length ? acct : a.nick.strip();
}

/// Per-cycle lookup index. Every key is `asciiLowerStr`-folded; values
/// come from one users query, one networks query and the staff oracle.
struct SyncIndex {
    bool[string] users;           /// site usernames
    string[string] emailOwner;    /// site email → username (lowest username wins on a shared address, as `loadUserEmails` does)
    bool[string] platformLinked;  /// `saslUsername` held by some Fiber network
    bool[string] staff;           /// opers, the RPC oper account, bot nicks, plus their grouped aliases
}

/// Pure verdict for one inventory row against the cycle's index. The
/// ownership classes mirror the admin NickServ page
/// (`classifyAccountOwnership`): staff, a site user of the same name (ASCII
/// case-insensitive, the house rule), a Fiber network holding the account as
/// `saslUsername` (the provisioner's collision-fallback credential — site
/// `p34c3` holding NickServ `p34c3_e5eb`), then a site user carrying the
/// account's email. Each means the human already has a site account, so
/// minting a row would duplicate them.
struct SyncDecision {
    bool create;
    string username;    /// canonical account display when create
    string email;       /// INFO email, or the placeholder when unset
    string skipReason;  /// set when !create, for the cycle log
}

SyncDecision decideNickservSync(const AnopeAccount a, const SyncIndex idx) @safe pure {
    SyncDecision d;
    const account = syncAccountName(a);
    if (!account.length) {
        d.skipReason = "empty account name";
        return d;
    }
    if (!isValidIrcNick(account)) {
        d.skipReason = "not a valid IRC nick";
        return d;
    }
    const key = asciiLowerStr(account);
    foreach (r; NICKSERV_SYNC_RESERVED) {
        if (key == r) {
            d.skipReason = "reserved name";
            return d;
        }
    }
    if (key in idx.staff) {
        d.skipReason = "staff or infrastructure account";
        return d;
    }
    if (a.suspended) {
        d.skipReason = "suspended in NickServ";
        return d;
    }
    if (key in idx.users) {
        d.skipReason = "site user exists";
        return d;
    }
    if (key in idx.platformLinked) {
        d.skipReason = "linked as a Fiber network credential";
        return d;
    }
    // An empty email is "unset", never an identity — same rule as
    // `classifyAccountOwnership`.
    const mail = a.email.strip();
    const mailKey = asciiLowerStr(mail);
    if (mailKey.length) {
        if (auto owner = mailKey in idx.emailOwner) {
            d.skipReason = "email belongs to site user " ~ *owner;
            return d;
        }
    }
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

/// What the last inventory-processing cycle did. Written only by a cycle that
/// held the lock and had an inventory (containers without the anope.db mount
/// never write it, so the admin gateway's record is never clobbered).
struct NickservSyncStatus {
    long lastRunAt;        /// unix seconds, cycle end
    string host;           /// HOSTNAME of the replica that ran
    string result;         /// "ok" | "error"
    string error;          /// message when result == "error"
    long accounts;         /// distinct NickServ accounts in the inventory
    long created, skipped, failed;
    bool capped;           /// hit NICKSERV_SYNC_MAX_NEW_PER_RUN; the rest is deferred to the next cycle
    long inventoryMtime;   /// anope.db mtime, unix seconds
}

/// HMSET of every field. A Redis failure is logged, never fatal — the cycle
/// has already done its work.
void recordNickservSyncStatus(RedisStorage redis, const NickservSyncStatus st) @trusted {
    try {
        redis.getDb().hmset(NICKSERV_SYNC_STATUS_KEY,
            "lastRunAt", st.lastRunAt.to!string,
            "host", st.host,
            "result", st.result,
            "error", st.error,
            "accounts", st.accounts.to!string,
            "created", st.created.to!string,
            "skipped", st.skipped.to!string,
            "failed", st.failed.to!string,
            "capped", st.capped ? "1" : "0",
            "inventoryMtime", st.inventoryMtime.to!string);
    } catch (Exception e) {
        logWarn("nickserv sync: recording status failed: %s", e.msg);
    }
}

/// False when no cycle has recorded itself yet, or the hash is malformed.
bool readNickservSyncStatus(RedisStorage redis, out NickservSyncStatus st) @trusted {
    auto h = redis.hgetAll(NICKSERV_SYNC_STATUS_KEY);
    if ("lastRunAt" !in h) return false;
    string field(string k) {
        if (auto p = k in h) return *p;
        return "";
    }
    try {
        st.lastRunAt = field("lastRunAt").to!long;
        st.accounts = field("accounts").to!long;
        st.created = field("created").to!long;
        st.skipped = field("skipped").to!long;
        st.failed = field("failed").to!long;
        st.inventoryMtime = field("inventoryMtime").to!long;
    } catch (ConvException) {
        return false;
    }
    st.host = field("host");
    st.result = field("result");
    st.error = field("error");
    st.capped = field("capped") == "1";
    return true;
}

private void nickservSyncOnce() {
    import std.process : environment;

    auto redis = new RedisStorage();
    redis.connectFromUrl(environment.get("IRCFIBER_REDIS_URL", "redis://127.0.0.1:6379"));
    scope (exit) redis.close();
    if (!isNickservSyncEnabled(redis)) return;

    // Single-flight across replicas. The read-back must compare a value only
    // this run could have written: SET NX with a constant looks identical
    // whether we won or lost (see api/rest.d retry throttle).
    const token = randomUUID().toString();
    auto db = redis.getDb();
    db.request!string("SET", NICKSERV_SYNC_LOCK_KEY, token, "NX", "EX", NICKSERV_SYNC_LOCK_TTL_SECS);
    if (db.get(NICKSERV_SYNC_LOCK_KEY) != token) return;
    scope (exit) releaseSyncLock(redis, token);

    auto inv = readAnopeInventory();
    if (!inv.available) return; // no mount in this container (support-bot, bnc): not an error, not ours to report

    NickservSyncStatus st;
    st.host = environment.get("HOSTNAME", "");
    st.inventoryMtime = inv.fileMtime;
    try {
        runSyncCycle(inv, redis, st);
        st.result = "ok";
    } catch (Exception e) {
        st.result = "error";
        st.error = e.msg;
        st.lastRunAt = Clock.currTime.toUnixTime!long;
        recordNickservSyncStatus(redis, st);
        throw e;
    }
    st.lastRunAt = Clock.currTime.toUnixTime!long;
    recordNickservSyncStatus(redis, st);
    if (st.created || st.failed)
        logInfo("nickserv sync: %d account(s): created %d, skipped %d, failed %d%s",
            st.accounts, st.created, st.skipped, st.failed,
            st.capped ? " (cap hit, continuing next cycle)" : "");
}

/// Lock release for the `scope (exit)` in `nickservSyncOnce` — `catch`
/// is illegal directly inside `scope (exit)`, hence the indirection. Only
/// our own token is deleted: a lock that expired and was re-taken by a
/// sibling replica is theirs.
private void releaseSyncLock(RedisStorage redis, string token) nothrow {
    try {
        auto db = redis.getDb();
        if (db.get(NICKSERV_SYNC_LOCK_KEY) == token) db.del(NICKSERV_SYNC_LOCK_KEY);
    } catch (Exception) {}
}

/// The cycle's lookup index. Throws on any Mongo failure — fail closed: a
/// partial index would mint duplicates; the loop retries next cycle.
private SyncIndex buildSyncIndex(const ref AnopeInventory inv, UserRepository users) {
    import ircfiber.db.network : NetworkRepository;
    import ircfiber.default_network : DEFAULT_FIBER_HOST;

    SyncIndex idx;
    // findAll ignores its offset argument, so one oversized page holds
    // everybody (same idiom as the admin NickServ page).
    foreach (u; users.findAll(users.count() + 50, 0)) {
        idx.users[asciiLowerStr(u.username)] = true;
        const email = asciiLowerStr(u.email.strip());
        if (!email.length) continue;
        // Two users on one address is a Mongo defect, not two owners. The
        // lowest username wins so the verdict cannot flip between cycles as
        // Mongo reorders documents (same rule as `loadUserEmails`).
        if (auto have = email in idx.emailOwner)
            if (asciiLowerStr(*have) <= asciiLowerStr(u.username)) continue;
        idx.emailOwner[email] = u.username;
    }

    // Every NickServ account already held as a Fiber network credential.
    // The provisioner registers collision-fallback accounts (`p34c3_e5eb`
    // for site user `p34c3`) as `saslUsername`; without this the inventory
    // row matches no site *username* and mints a duplicate site user. Same
    // `listWithSaslAccount` source the admin NickServ page annotates with.
    foreach (row; (new NetworkRepository()).listWithSaslAccount(DEFAULT_FIBER_HOST)) {
        const acct = row.config.saslUsername.strip();
        if (acct.length) idx.platformLinked[asciiLowerStr(acct)] = true;
    }

    // On an Anope RPC failure this degrades to the env-derived names (the
    // RPC oper account, both bot nicks): a human oper without a site user
    // then gets a parked row, which is harmless.
    idx.staff = staffAccountsLower(inv);
    return idx;
}

/// One pass over the inventory; `st` accumulates what the status record and
/// the summary log report.
private void runSyncCycle(const ref AnopeInventory inv, RedisStorage redis, ref NickservSyncStatus st) {
    auto users = new UserRepository();      // one per cycle: the ctor runs ensureIndexes
    auto idx = buildSyncIndex(inv, users);
    bool[string] seen;                      // grouped aliases: one verdict per account
    foreach (ref a; inv.accounts) {
        const key = asciiLowerStr(syncAccountName(a));
        if (!key.length || key in seen) continue;
        seen[key] = true;
        st.accounts++;
        if (st.created >= NICKSERV_SYNC_MAX_NEW_PER_RUN) {
            st.capped = true; // deferred to the next cycle, still counted in `accounts`
            continue;
        }
        auto d = decideNickservSync(a, idx);
        if (!d.create) {
            st.skipped++;
            continue;
        }
        final switch (mintSyncedUser(users, redis, d)) {
            case MintResult.created: st.created++; break;
            case MintResult.exists:  st.skipped++; break; // another writer won the duplicate-key race
            case MintResult.failed:  st.failed++;  break;
        }
    }
}

private enum MintResult { created, exists, failed }

/// Inserts the parked row + staff signup event. `exists` means another
/// writer won the race (duplicate key) — the next cycle treats it as ours.
private MintResult mintSyncedUser(UserRepository users, RedisStorage redis, const SyncDecision d) {
    User u;
    u.id = randomUUID();
    u.username = d.username;
    u.email = d.email;
    // CSPRNG; the plaintext lives only for the hash call. A /dev/urandom
    // failure throws out of the cycle, which is the right severity.
    u.passwordHash = hashPassword(generateServicesPassword(32));
    u.roles = ["user"];
    u.signupIp = "nickserv-sync";
    u.createdAt = Clock.currTime;
    u.provisionedFrom = "nickserv-sync:" ~ d.username;
    try {
        users.create(u);
    } catch (Exception e) {
        if (e.msg.canFind("duplicate key")) return MintResult.exists;
        logWarn("nickserv sync: create %s failed: %s", d.username, e.msg);
        return MintResult.failed;
    }
    // Best-effort staff feed, same shape as a normal signup.
    try {
        LogEvent le;
        le.type = "signup";
        le.ts = Clock.currTime.toUnixTime!long * 1000;
        le.username = u.username;
        le.email = u.email;
        le.ip = "nickserv-sync";
        pushLogEvent(redis, le);
    } catch (Exception e) {
        logWarn("nickserv sync: announce %s failed: %s", d.username, e.msg);
    }
    return MintResult.created;
}

@("sync creates a bare account with a placeholder email")
unittest {
    AnopeAccount a;
    a.nick = "lex0de";
    a.account = "lex0de";
    a.email = "";
    auto d = decideNickservSync(a, SyncIndex.init);
    assert(d.create && d.username == "lex0de");
    assert(d.email == "lex0de@provisioned.irc.invalid");
}

@("sync keeps a well-formed NickServ email")
unittest {
    AnopeAccount a;
    a.nick = "lex0de";
    a.account = "lex0de";
    a.email = "lex0de@tuta.com";
    auto d = decideNickservSync(a, SyncIndex.init);
    assert(d.create && d.email == "lex0de@tuta.com");
}

@("sync skips reserved names case-insensitively")
unittest {
    AnopeAccount a;
    a.account = "NickServ";
    assert(!decideNickservSync(a, SyncIndex.init).create);
    a.account = "ADMIN";
    assert(!decideNickservSync(a, SyncIndex.init).create);
}

@("sync skips existing users, bad nicks and suspended accounts")
unittest {
    SyncIndex idx;
    idx.users["dnsk"] = true;
    AnopeAccount a;
    a.account = "dnsk";
    assert(!decideNickservSync(a, idx).create);
    a.account = "123bad";
    assert(!decideNickservSync(a, idx).create);
    a.account = "goodnick";
    a.suspended = true;
    auto d = decideNickservSync(a, idx);
    assert(!d.create && d.skipReason == "suspended in NickServ");
}

@("sync skips a fallback account held as a Fiber credential")
unittest {
    // Prod regression: site `p34c3` holds NickServ `p34c3_e5eb` as its
    // network credential. No site *username* matches, but minting a row
    // would duplicate the user.
    SyncIndex idx;
    idx.platformLinked["p34c3_e5eb"] = true;
    AnopeAccount a;
    a.nick = "p34c3_e5eb";
    a.account = "p34c3_e5eb";
    a.email = "p34c3@asylum.st";
    auto d = decideNickservSync(a, idx);
    assert(!d.create && d.skipReason == "linked as a Fiber network credential");
    // Case-insensitive like the house rule: the index is lowercased.
    a.account = "P34C3_E5EB";
    assert(!decideNickservSync(a, idx).create);
}

@("sync skips staff and infrastructure accounts")
unittest {
    SyncIndex idx;
    idx.staff = ["fibereye": true];
    AnopeAccount a;
    a.nick = "FIBEREYE";
    a.account = "FIBEREYE";
    auto d = decideNickservSync(a, idx);
    assert(!d.create && d.skipReason == "staff or infrastructure account");
}

@("sync skips an account whose email belongs to a site user")
unittest {
    SyncIndex idx;
    idx.emailOwner = ["alice@example.com": "bob"];
    AnopeAccount a;
    a.nick = "alice";
    a.account = "alice";
    a.email = "Alice@Example.com";
    auto d = decideNickservSync(a, idx);
    assert(!d.create && d.skipReason == "email belongs to site user bob");
    // An empty email is "unset", never an identity.
    a.email = "";
    idx.emailOwner = ["": "nobody"];
    assert(decideNickservSync(a, idx).create);
}
