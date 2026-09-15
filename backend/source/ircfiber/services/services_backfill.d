/**
 * Site → NickServ backfill: every site user ends up with a NickServ account.
 *
 * Provisioning is otherwise only ever attempted at a moment a user is
 * present: signup, every login, the admin `POST
 * /api/admin/ircd/nickserv/create`, and the self-serve `POST
 * /api/me/irc-account/retry`. A user who signed up while Anope RPC was down,
 * who hit the 24h `irc:services:skip:<userId>` park, or who predates the
 * feature therefore stays unprovisioned until they happen to log in again —
 * and an account-less user is invisible to every account-gated ircd feature,
 * including the `+w v:account:*` autovoice on #ircfiber and #support.
 *
 * This is the reconcile loop for that gap, the mirror of
 * `ircfiber.services.nickserv_sync` (which runs NickServ → site). Every
 * cycle re-derives the candidate list from `unprovisionedUsers` — the same
 * oracle the admin NickServ page counts and offers to fix, so the page and
 * the loop can never disagree about who is missing — and walks it through
 * the ordinary provisioner.
 *
 * Deliberately unexceptional about how it provisions:
 * - `ensureDefaultFiberNetwork` then `provisionServicesAccount`, the same
 *   idempotent pair signup, login and the admin action use. No preferred
 *   account, so the normal candidate ladder applies.
 * - It never clears a skip marker. The 24h park exists because NickServ
 *   refused; overriding that stays an admin action (`preferredAccount`).
 * - IRC-first parked rows (`provisionedFrom: nickserv-sync:*`) are skipped.
 *   Their network is minted on first site login, where `loginPost` proves
 *   NickServ ownership; provisioning them here would mint a `<nick>_<hex>`
 *   fallback account for a nick the human already owns.
 * - Capped at SERVICES_BACKFILL_MAX_PER_RUN provisionings per cycle: each
 *   one is an Anope RPC round trip plus a Mongo write, and the rest is
 *   picked up next cycle.
 * - Single-flight across gateway replicas via a `SET NX` token compared on
 *   read-back, and skipped entirely in a container with no Anope RPC
 *   configured (support-bot, bnc) so it neither holds the lock nor
 *   overwrites the real gateway's status record.
 * - Kill-switch `irc:config:servicesBackfill` (default on), flippable at
 *   GET/POST /api/admin/config/services-backfill.
 *
 * `decideServicesBackfill` is @safe pure so it links into `services-test`.
 */
module ircfiber.services.services_backfill;

import std.algorithm : startsWith;
import std.conv : ConvException, to;
import std.datetime : Clock;
import std.uuid : UUID, randomUUID;
import core.time : seconds;

import vibe.core.core : runTask, sleep;
import vibe.core.log : logInfo, logWarn;

import ircfiber.db.network : NetworkRepository;
import ircfiber.default_network : ensureDefaultFiberNetwork;
import ircfiber.irc.registry : ServerRegistry;
import ircfiber.services.accounts : provisionServicesAccount, ProvisionOutcome,
    unprovisionedUsers;
import ircfiber.services.anope : loadAnopeSettings;
import ircfiber.storage.redis : RedisStorage;

/// Seconds between reconciliation cycles.
enum SERVICES_BACKFILL_INTERVAL_SECS = 900;
/// Accounts registered per cycle — bounds the Anope RPC burst.
enum SERVICES_BACKFILL_MAX_PER_RUN = 10;
/// Redis kill-switch; missing key means enabled.
enum SERVICES_BACKFILL_CONFIG_KEY = "irc:config:servicesBackfill";
/// Single-flight lock across gateway replicas (shorter than the interval).
enum SERVICES_BACKFILL_LOCK_KEY = "irc:services-backfill:lock";
enum SERVICES_BACKFILL_LOCK_TTL_SECS = 840;
/// Hash describing the last cycle that ran (see ServicesBackfillStatus);
/// read by GET /api/admin/config/services-backfill.
enum SERVICES_BACKFILL_STATUS_KEY = "irc:services-backfill:status";

/// `User.provisionedFrom` prefix `nickserv_sync` stamps on a parked row.
enum SERVICES_BACKFILL_PARKED_PREFIX = "nickserv-sync:";

/// Kill-switch read: true unless explicitly "0"/"false". Fail-open like
/// `isNickservSyncEnabled` — a Redis hiccup must not silently stop the loop.
bool isServicesBackfillEnabled(RedisStorage redis) @trusted {
    try {
        if (redis is null) return true;
        auto v = redis.getDb().get(SERVICES_BACKFILL_CONFIG_KEY);
        if (v.length == 0) return true;
        return v != "0" && v != "false" && v != "False";
    } catch (Exception) {
        return true;
    }
}

/// Persists the kill-switch flag.
void setServicesBackfillEnabled(RedisStorage redis, bool enabled) @trusted {
    redis.getDb().set(SERVICES_BACKFILL_CONFIG_KEY, enabled ? "1" : "0");
}

/// Pure verdict for one `unprovisionedUsers` row.
///
/// Ordered, and the order is the point: a parked IRC-first row is skipped
/// even if it somehow also looks credentialed or disabled, because the
/// reason not to touch it (a human already owns that nick) outranks both.
struct BackfillDecision {
    bool provision;
    string skipReason;  /// set when !provision, for the cycle's counters
}

BackfillDecision decideServicesBackfill(string provisionedFrom, bool hasNetwork,
                                        bool networkDisabled, bool hasCredential) @safe pure {
    BackfillDecision d;
    if (provisionedFrom.startsWith(SERVICES_BACKFILL_PARKED_PREFIX)) {
        d.skipReason = "IRC-first parked account";
        return d;
    }
    if (hasCredential) {
        d.skipReason = "already provisioned";
        return d;
    }
    // A user who disabled their Fiber network asked for it to stop
    // connecting; registering a nick for it would be work nobody wants. A
    // user with no network at all is a different case — one is created.
    if (hasNetwork && networkDisabled) {
        d.skipReason = "Fiber network disabled";
        return d;
    }
    d.provision = true;
    return d;
}

/// Starts the reconcile fiber.
void startServicesBackfillLoop() {
    runTask(&servicesBackfillLoop);
    logInfo("Services backfill starting (%ds interval, cap %d/cycle)",
        SERVICES_BACKFILL_INTERVAL_SECS, SERVICES_BACKFILL_MAX_PER_RUN);
}

private void servicesBackfillLoop() nothrow {
    while (true) {
        try servicesBackfillOnce();
        catch (Exception e) {
            try logWarn("services backfill: cycle failed: %s", e.msg);
            catch (Exception) {}
        }
        try sleep(SERVICES_BACKFILL_INTERVAL_SECS.seconds);
        catch (Exception) {}
    }
}

/// What the last cycle did. Written only by a cycle that held the lock in a
/// container that can actually reach Anope, so a support-bot replica never
/// clobbers the admin gateway's record.
struct ServicesBackfillStatus {
    long lastRunAt;        /// unix seconds, cycle end
    string host;           /// HOSTNAME of the replica that ran
    string result;         /// "ok" | "error"
    string error;          /// message when result == "error"
    long candidates;       /// rows `unprovisionedUsers` returned
    long provisioned, skipped, failed;
    bool capped;           /// hit SERVICES_BACKFILL_MAX_PER_RUN; the rest is deferred to the next cycle
}

/// HMSET of every field. A Redis failure is logged, never fatal — the cycle
/// has already done its work.
void recordServicesBackfillStatus(RedisStorage redis, const ServicesBackfillStatus st) @trusted {
    try {
        redis.getDb().hmset(SERVICES_BACKFILL_STATUS_KEY,
            "lastRunAt", st.lastRunAt.to!string,
            "host", st.host,
            "result", st.result,
            "error", st.error,
            "candidates", st.candidates.to!string,
            "provisioned", st.provisioned.to!string,
            "skipped", st.skipped.to!string,
            "failed", st.failed.to!string,
            "capped", st.capped ? "1" : "0");
    } catch (Exception e) {
        logWarn("services backfill: recording status failed: %s", e.msg);
    }
}

/// False when no cycle has recorded itself yet, or the hash is malformed.
bool readServicesBackfillStatus(RedisStorage redis, out ServicesBackfillStatus st) @trusted {
    auto h = redis.hgetAll(SERVICES_BACKFILL_STATUS_KEY);
    if ("lastRunAt" !in h) return false;
    string field(string k) {
        if (auto p = k in h) return *p;
        return "";
    }
    try {
        st.lastRunAt = field("lastRunAt").to!long;
        st.candidates = field("candidates").to!long;
        st.provisioned = field("provisioned").to!long;
        st.skipped = field("skipped").to!long;
        st.failed = field("failed").to!long;
    } catch (ConvException) {
        return false;
    }
    st.host = field("host");
    st.result = field("result");
    st.error = field("error");
    st.capped = field("capped") == "1";
    return true;
}

private void servicesBackfillOnce() {
    import std.process : environment;

    // No RPC URL means this container cannot register anything (support-bot,
    // bnc). Checked before the lock so such a replica never takes it.
    if (!loadAnopeSettings().configured) return;

    auto redis = new RedisStorage();
    redis.connectFromUrl(environment.get("IRCFIBER_REDIS_URL", "redis://127.0.0.1:6379"));
    scope (exit) redis.close();
    if (!isServicesBackfillEnabled(redis)) return;

    // Single-flight across replicas. The read-back must compare a value only
    // this run could have written: SET NX with a constant looks identical
    // whether we won or lost (same idiom as nickserv_sync).
    const token = randomUUID().toString();
    auto db = redis.getDb();
    db.request!string("SET", SERVICES_BACKFILL_LOCK_KEY, token, "NX", "EX", SERVICES_BACKFILL_LOCK_TTL_SECS);
    if (db.get(SERVICES_BACKFILL_LOCK_KEY) != token) return;
    scope (exit) releaseBackfillLock(redis, token);

    ServicesBackfillStatus st;
    st.host = environment.get("HOSTNAME", "");
    try {
        runBackfillCycle(redis, st);
        st.result = "ok";
    } catch (Exception e) {
        st.result = "error";
        st.error = e.msg;
        st.lastRunAt = Clock.currTime.toUnixTime!long;
        recordServicesBackfillStatus(redis, st);
        throw e;
    }
    st.lastRunAt = Clock.currTime.toUnixTime!long;
    recordServicesBackfillStatus(redis, st);
    if (st.provisioned || st.failed)
        logInfo("services backfill: %d candidate(s): provisioned %d, skipped %d, failed %d%s",
            st.candidates, st.provisioned, st.skipped, st.failed,
            st.capped ? " (cap hit, continuing next cycle)" : "");
}

/// Lock release for the `scope (exit)` in `servicesBackfillOnce` — `catch`
/// is illegal directly inside `scope (exit)`, hence the indirection. Only
/// our own token is deleted: a lock that expired and was re-taken by a
/// sibling replica is theirs.
private void releaseBackfillLock(RedisStorage redis, string token) nothrow {
    try {
        auto db = redis.getDb();
        if (db.get(SERVICES_BACKFILL_LOCK_KEY) == token) db.del(SERVICES_BACKFILL_LOCK_KEY);
    } catch (Exception) {}
}

/// One pass over the candidates; `st` accumulates what the status record and
/// the summary log report.
private void runBackfillCycle(RedisStorage redis, ref ServicesBackfillStatus st) {
    auto networkRepo = new NetworkRepository();          // one per cycle, as nickserv_sync does
    auto serverRegistry = new ServerRegistry(redis);
    foreach (row; unprovisionedUsers()) {
        st.candidates++;
        if (st.provisioned >= SERVICES_BACKFILL_MAX_PER_RUN) {
            st.capped = true;   // deferred to the next cycle, still counted in `candidates`
            continue;
        }
        // `hasCredential` is false by construction here — `unprovisionedUsers`
        // filters credentialed rows out — so the rule is passed literally
        // rather than re-derived: it documents precedence for any other
        // caller of the verdict, and a future oracle that did include a
        // half-credentialed row should have it repaired, not skipped.
        const d = decideServicesBackfill(row.user.provisionedFrom, row.hasNetwork,
                                         row.cfg.disabled, false);
        if (!d.provision) {
            st.skipped++;
            continue;
        }
        try {
            // Idempotent: returns the existing network when the user already
            // has one, and NetworkConfig.init when Fiber networks are off.
            const cfg = ensureDefaultFiberNetwork(row.user, networkRepo, redis, serverRegistry);
            if (cfg.id == UUID.init) {
                st.skipped++;
                continue;
            }
            if (provisionServicesAccount(row.user, networkRepo, redis, serverRegistry)
                    == ProvisionOutcome.registered)
                st.provisioned++;
            else
                st.skipped++;   // disabled, parked, deferred, collision — all retried next cycle
        } catch (Exception e) {
            st.failed++;
            logWarn("services backfill: provisioning %s failed: %s", row.user.username, e.msg);
        }
    }
}

@("backfill provisions a plain unprovisioned user")
unittest {
    auto d = decideServicesBackfill("", false, false, false);
    assert(d.provision && d.skipReason.length == 0);
    // Having a live network changes nothing: the credential is what is missing.
    assert(decideServicesBackfill("signup", true, false, false).provision);
}

@("backfill leaves IRC-first parked rows alone")
unittest {
    auto d = decideServicesBackfill("nickserv-sync:lex0de", false, false, false);
    assert(!d.provision && d.skipReason == "IRC-first parked account");
    // Outranks every other rule: the nick already has a human owner, so the
    // network is minted on first site login instead, where loginPost proves it.
    assert(!decideServicesBackfill("nickserv-sync:lex0de", true, true, true).provision);
    // A provenance that merely mentions nickserv is not the parked marker.
    assert(decideServicesBackfill("nickserv:lex0de", false, false, false).provision);
}

@("backfill skips a user who already holds a credential")
unittest {
    auto d = decideServicesBackfill("signup", true, false, true);
    assert(!d.provision && d.skipReason == "already provisioned");
}

@("backfill skips a disabled Fiber network but not a missing one")
unittest {
    auto d = decideServicesBackfill("signup", true, true, false);
    assert(!d.provision && d.skipReason == "Fiber network disabled");
    // `disabled` is a property of a network that exists; with no network the
    // flag is the struct default and must not suppress provisioning.
    assert(decideServicesBackfill("signup", false, true, false).provision);
}
