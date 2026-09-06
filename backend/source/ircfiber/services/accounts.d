/**
 * NickServ account provisioning for website accounts.
 *
 * Signing up on ircfiber.com creates a Mongo user plus a systemManaged
 * `irc.ircfiber.com` network (`ircfiber.default_network`) whose nick is the
 * website username — but nothing claimed that nick with Anope. This module
 * registers it, stores the generated password as the network's SASL PLAIN
 * credential, and forces the engine to reconnect so the live session is
 * authenticated.
 *
 * Called fire-and-forget from `registerPost` (new signups) and `loginPost`
 * (lazy backfill for existing accounts). Both call sites run
 * `ensureDefaultFiberNetwork` synchronously first, so the Fiber network is
 * always in Mongo by the time the task looks it up.
 *
 * Guards:
 *   - `irc:services:lock:<userId>`  SET NX EX 60 — one gateway replica at a
 *     time, so concurrent logins cannot double-register.
 *   - `irc:services:skip:<userId>`  EX 86400 — a permanent refusal (services
 *     disabled, every candidate taken, bad password/email) is not retried
 *     for 24h. Transport failures set no skip key: they retry next login.
 *   - `cfg.sasl == plain && saslUsername && saslPassword` — already done.
 *
 * Every attempt's outcome is counted into `irc:services:outcomes`
 * (`SERVICES_OUTCOMES_KEY`), because a failing provisioner is otherwise
 * invisible: a transport failure writes one `logWarn` and no skip key, so it
 * retries on every login forever. The admin NickServ page reads that hash.
 *
 * Anope only flushes `anope.db` every `updatetimeout` (5m), so a services
 * restart right after a signup can lose the registration. Recovery is
 * automatic: the credential guard above is the only state that matters, and
 * losing the account means the next login re-provisions it.
 */
module ircfiber.services.accounts;

import std.algorithm : canFind;
import std.ascii : isAlphaNum;
import std.conv : to;
import std.datetime : Clock;
import std.uni : toLower;
import std.uuid : UUID;
import core.time : msecs;

import vibe.core.core : runTask, sleep;
import vibe.core.log;
import vibe.data.json : Json, parseJsonString;

import ircfiber.db.network : NetworkRepository;
import ircfiber.default_network : DEFAULT_FIBER_HOST, buildDefaultNick;
import ircfiber.irc.registry : ServerRegistry;
import ircfiber.models.network : NetworkConfig, SASLMechanism;
import ircfiber.models.user : User;
import ircfiber.redis.protocol : ControlMessage, NetworkStateSnapshot, RedisKeys;
import ircfiber.services.anope : AnopeSettings, anopeCheckAuthentication, anopeCommand,
    anopeUser, anopeUserOnline, isSafeServicesArg, loadAnopeSettings;
import ircfiber.storage.redis : RedisStorage;

/// Max nick length accepted by InspIRCd 4 in our config (`<limits maxnick>`).
enum size_t IRC_MAX_NICK_LEN = 32;

/**
 * InspIRCd 4 / Anope `IRCDProto::IsNickValid` rules: 1..maxLen characters;
 * the first must be a letter or one of "[]\`_^{|}"; later characters may
 * also be digits or '-'.
 */
bool isValidIrcNick(string s, size_t maxLen = IRC_MAX_NICK_LEN) @safe pure nothrow @nogc {
    if (s.length == 0 || s.length > maxLen) return false;
    foreach (i, char c; s) {
        const letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
        const special = c == '[' || c == ']' || c == '\\' || c == '`'
                     || c == '_' || c == '^' || c == '{' || c == '|' || c == '}';
        if (letter || special) continue;
        if (i > 0 && ((c >= '0' && c <= '9') || c == '-')) continue;
        return false;
    }
    return true;
}

/**
 * Account names to try, in priority order: the username, then the
 * deterministic `<username>_<4 hex>` fallback, then `<username>_2` …
 * `<username>_9`. Invalid nicks are dropped rather than sent to Anope.
 *
 * A non-empty `preferred` (the account name an admin typed in the NickServ
 * page's create action) REPLACES the derived list instead of heading it: an
 * admin naming `bob` means that account, so quietly falling back to `bob_2`
 * would hand the user an account nobody asked for. An illegal `preferred`
 * yields no candidates at all, which the caller reports as `nickUnavailable`.
 */
string[] servicesAccountCandidates(User user, string preferred = "") @safe {
    string[] out_;
    void add(string c) {
        if (!isValidIrcNick(c)) return;
        if (out_.canFind(c)) return;
        out_ ~= c;
    }
    if (preferred.length) {
        add(preferred);
        return out_;
    }
    add(user.username);
    add(buildDefaultNick(user));
    foreach (n; 2 .. 10) add(user.username ~ "_" ~ n.to!string);
    return out_;
}

/// How NickServ answered a REGISTER.
enum NickServVerdict {
    registered,
    alreadyTaken,
    nickRejected,
    emailRejected,
    passwordRejected,
    disabled,
    unknown
}

/**
 * Classify NickServ's reply text. Order matters: "is already registered!"
 * must be tested before the "registered." suffix that marks success.
 */
NickServVerdict classifyNickServReply(string text) @safe pure {
    const t = text.toLower();
    if (t.canFind("is already registered")) return NickServVerdict.alreadyTaken;
    if (t.canFind("may not be registered")) return NickServVerdict.nickRejected;
    if (t.canFind("not a valid e-mail address") || t.canFind("not a valid email address"))
        return NickServVerdict.emailRejected;
    if (t.canFind("more obscure password") || t.canFind("password is too long"))
        return NickServVerdict.passwordRejected;
    if (t.canFind("registration is currently disabled") || t.canFind("temporarily disabled"))
        return NickServVerdict.disabled;
    if (t.canFind("registered under your") || t.canFind("registered."))
        return NickServVerdict.registered;
    return NickServVerdict.unknown;
}

/**
 * `len` characters from A-Za-z0-9, read from /dev/urandom with rejection
 * sampling (bytes >= 248 discarded, 248 = 4 * 62) so the distribution is
 * unbiased. Never the website password. Throws on /dev/urandom failure,
 * which the caller treats as retryable.
 */
string generateServicesPassword(size_t len = 24) @trusted {
    import std.exception : enforce;
    import std.stdio : File;

    static immutable string alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    enforce(alphabet.length == 62, "alphabet must be 62 chars for unbiased sampling");
    enum ubyte limit = 248;  // 4 * 62; bytes >= limit are discarded

    auto f = File("/dev/urandom", "rb");
    scope (exit) f.close();

    char[] out_;
    out_.reserve(len);
    ubyte[64] buf;
    while (out_.length < len) {
        auto chunk = f.rawRead(buf[]);
        enforce(chunk.length > 0, "/dev/urandom returned no data");
        foreach (ubyte b; chunk) {
            if (b >= limit) continue;
            out_ ~= alphabet[b % 62];
            if (out_.length == len) break;
        }
    }
    return out_.idup;
}

/**
 * The nick the engine currently holds for this network, or "" when it is not
 * connected. This is the collision oracle: IRC nicks are unique, so if the
 * engine holds `alice` nobody else can, and if it holds something else while
 * `alice` is online then `alice` belongs to a foreign session.
 */
private string engineCurrentNick(RedisStorage redis, ServerRegistry serverRegistry, string networkId) {
    string readSnapshot(string key) {
        try {
            auto fields = redis.hgetAll(key);
            if ("data" !in fields) return "";
            auto snap = NetworkStateSnapshot.fromJson(parseJsonString(fields["data"]));
            return snap.connected ? snap.currentNick : "";
        } catch (Exception e) {
            logDebug("services: reading snapshot %s failed: %s", key, e.msg);
            return "";
        }
    }

    string serverId;
    try serverId = serverRegistry.getServerForNetwork(networkId);
    catch (Exception) {}
    if (serverId.length) {
        const nick = readSnapshot(RedisKeys.state(serverId, networkId));
        if (nick.length) return nick;
    }
    return readSnapshot(RedisKeys.state_legacy(networkId));
}

/// Seconds the provisioner waits for the engine to report a live nick before
/// falling back to STATUS-only reasoning. Signup pushes `addNetwork`
/// synchronously before this task runs, so the connection normally lands in
/// one to three seconds.
enum int ENGINE_NICK_WAIT_SECONDS = 12;

private string awaitEngineNick(RedisStorage redis, ServerRegistry serverRegistry, string networkId) {
    foreach (_; 0 .. ENGINE_NICK_WAIT_SECONDS * 2) {
        const nick = engineCurrentNick(redis, serverRegistry, networkId);
        if (nick.length) return nick;
        sleep(500.msecs);
    }
    return "";
}

/// Result of one provisioning attempt.
enum ProvisionOutcome {
    disabled,
    skipped,
    alreadyProvisioned,
    registered,
    /// No candidate is a legal IRC nick (legacy username predating the
    /// signup-time gate) — distinct from every candidate being taken.
    nickUnavailable,
    /// A candidate is held by a live session we cannot attribute to our own
    /// engine. Registering it would hand that session the new account
    /// (`ns_register` ends with `u->Identify(na)`), so we retry later instead.
    deferred,
    /// Every candidate is registered by, or in use by, somebody else.
    collisionExhausted,
    failed
}

/// Redis key holding the 24h "stopped trying, here's why" marker. Read by
/// `GET /api/me/irc-account` to report `unavailable` + reason, and deleted by
/// the retry endpoint.
string servicesSkipKey(string userId) @safe pure { return "irc:services:skip:" ~ userId; }
private string lockKey(string userId) @safe pure { return "irc:services:lock:" ~ userId; }
/**
 * Redis key holding a credential that was generated but whose persistence to
 * Mongo has not been confirmed. Written immediately BEFORE `NickServ
 * REGISTER`, deleted once the SASL credential is live in Mongo. Without it, a
 * crash (or a Mongo write failure) in that window would leave the account
 * registered under a password nobody knows, permanently denying the user
 * their own nick. Value is `{"account":…,"password":…}`; 24h TTL.
 */
string servicesPendingKey(string userId) @safe pure { return "irc:services:pending:" ~ userId; }

/**
 * Redis hash carrying provisioning telemetry: one counter per
 * `ProvisionOutcome` member (HINCRBY), plus `lastOutcome` and
 * `lastOutcomeAt` (unix seconds) for the most recent attempt.
 *
 * Why it exists: prod sat at zero provisioned credentials for weeks and
 * nothing showed it. `ProvisionOutcome.failed` only logs, and a transport
 * failure deliberately sets no skip key so it retries — which means a
 * permanently broken Anope looks exactly like an idle system. These counters
 * are the observable form of that state.
 *
 * No TTL: the counts are a lifetime tally of a rare event and the hash holds
 * a dozen small fields.
 */
enum string SERVICES_OUTCOMES_KEY = "irc:services:outcomes";

/// Records one attempt. Telemetry must never change the outcome it reports
/// nor escape as an exception, so every failure is swallowed after a warning.
private void recordProvisionOutcome(RedisStorage redis, ProvisionOutcome outcome) nothrow {
    try {
        auto db = redis.getDb();
        const name = outcome.to!string;
        db.request!long("HINCRBY", SERVICES_OUTCOMES_KEY, name, "1");
        db.hset(SERVICES_OUTCOMES_KEY, "lastOutcome", name);
        db.hset(SERVICES_OUTCOMES_KEY, "lastOutcomeAt",
                Clock.currTime.toUnixTime!long.to!string);
    } catch (Exception e) {
        try logWarn("services: recording a provisioning outcome failed: %s", e.msg);
        catch (Exception) {}
    }
}


/**
 * Register the user's nick with NickServ and persist the generated password
 * as the Fiber network's SASL PLAIN credential.
 *
 * Synchronous body — only safe to call inside a vibe.d fiber (it does Redis,
 * Mongo and HTTP I/O). Use `provisionServicesAccountAsync` from a request
 * handler.
 *
 * `preferredAccount` is the admin-chosen account name (`web.admin.nickserv`'s
 * create action). Supplying it also suppresses the 24h skip marker: an
 * admin's nick choice must not park the automatic provisioner for a user.
 */
ProvisionOutcome provisionServicesAccount(User user, NetworkRepository networkRepo,
                                          RedisStorage redis, ServerRegistry serverRegistry,
                                          string preferredAccount = "") {
    // One recording site for every exit of the attempt below, including the
    // exception path (which `ServicesProvisioner.run` swallows): the initial
    // value is what an escaping exception is counted as.
    ProvisionOutcome outcome = ProvisionOutcome.failed;
    scope (exit) recordProvisionOutcome(redis, outcome);
    outcome = provisionAttempt(user, networkRepo, redis, serverRegistry, preferredAccount);
    return outcome;
}

/// The attempt itself. Every `return` here is counted by the wrapper above,
/// so nothing in this body touches the telemetry hash.
private ProvisionOutcome provisionAttempt(User user, NetworkRepository networkRepo,
                                          RedisStorage redis, ServerRegistry serverRegistry,
                                          string preferredAccount = "") {
    auto s = loadAnopeSettings();
    if (!s.configured) {
        logDebug("services: IRCFIBER_ANOPE_RPC_URL unset — NickServ auto-registration disabled");
        return ProvisionOutcome.disabled;
    }
    if (user.id == UUID.init || user.username.length == 0)
        return ProvisionOutcome.skipped;

    const userId = user.id.toString();
    auto db = redis.getDb();

    // Permanent-failure guard: do not hammer Anope on every login.
    try {
        const skip = db.get(servicesSkipKey(userId));
        if (skip.length) {
            logDebug("services: skipping %s (%s)", user.username, skip);
            return ProvisionOutcome.skipped;
        }
    } catch (Exception e) {
        logWarn("services: reading skip key for %s failed: %s", user.username, e.msg);
    }

    // Single-flight across gateway replicas.
    const lockVal = userId ~ ":" ~ Clock.currTime.toUnixTime.to!string;
    try {
        db.request!string("SET", lockKey(userId), lockVal, "NX", "EX", "60");
        if (db.get(lockKey(userId)) != lockVal) return ProvisionOutcome.skipped;
    } catch (Exception e) {
        logWarn("services: lock for %s failed: %s", user.username, e.msg);
        return ProvisionOutcome.failed;
    }
    bool released = false;
    void release() {
        if (released) return;
        released = true;
        try db.del(lockKey(userId));
        catch (Exception e) logWarn("services: releasing lock for %s failed: %s", user.username, e.msg);
    }
    scope (exit) release();

    // The Fiber network is provisioned synchronously by
    // ensureDefaultFiberNetwork before this task runs.
    NetworkConfig cfg;
    bool found = false;
    foreach (ref c; networkRepo.findByUserId(user.id)) {
        if (c.host == DEFAULT_FIBER_HOST) {
            cfg = c;
            found = true;
            break;
        }
    }
    if (!found) {
        logDebug("services: %s has no %s network yet", user.username, DEFAULT_FIBER_HOST);
        return ProvisionOutcome.skipped;
    }
    if (cfg.disabled) return ProvisionOutcome.skipped;
    if (cfg.sasl == SASLMechanism.plain && cfg.saslUsername.length && cfg.saslPassword.length)
        return ProvisionOutcome.alreadyProvisioned;

    // An admin-chosen nick never parks automatic provisioning: the refusal
    // says something about that nick, not about the user, and a 24h marker
    // would then stop the ordinary provisioner from ever trying the user's
    // own candidates again.
    const adminChosen = preferredAccount.length > 0;
    void markSkip(string reason) {
        if (adminChosen) return;
        try db.request!string("SET", servicesSkipKey(userId), reason, "EX", "86400");
        catch (Exception e) logWarn("services: setting skip key for %s failed: %s", user.username, e.msg);
    }

    void rememberPending(string account, string password) {
        try {
            auto rec = Json.emptyObject;
            rec["account"] = Json(account);
            rec["password"] = Json(password);
            db.request!string("SET", servicesPendingKey(userId), rec.toString(), "EX", "86400");
        } catch (Exception e) {
            logWarn("services: recording pending credential for %s failed: %s",
                    user.username, e.msg);
        }
    }

    // Crash recovery: a credential recorded but never persisted (gateway died
    // or Mongo rejected the write after REGISTER succeeded). Adopt it if it
    // still authenticates — registering a second account would abandon the
    // user's own nick to a password nobody holds.
    {
        string pendingAccount, pendingPassword;
        try {
            const raw = db.get(servicesPendingKey(userId));
            if (raw.length) {
                auto rec = parseJsonString(raw);
                pendingAccount = rec["account"].opt!string("");
                pendingPassword = rec["password"].opt!string("");
            }
        } catch (Exception e) {
            logWarn("services: unreadable pending credential for %s: %s", user.username, e.msg);
        }
        if (pendingAccount.length && pendingPassword.length) {
            bool determined;
            const works = anopeCheckAuthentication(s, pendingAccount, pendingPassword, determined);
            if (!determined) {
                logWarn("services: cannot verify pending credential for %s — Anope unreachable",
                        user.username);
                return ProvisionOutcome.failed;
            }
            if (works) {
                logInfo("services: adopting pending NickServ credential %s for user %s",
                        pendingAccount, user.username);
                return persistProvisionedAccount(user, cfg, pendingAccount, pendingPassword,
                                                 networkRepo, redis, serverRegistry);
            }
            logInfo("services: pending credential %s for %s no longer authenticates — discarding",
                    pendingAccount, user.username);
            try db.del(servicesPendingKey(userId));
            catch (Exception) {}
        }
    }

    auto candidates = servicesAccountCandidates(user, preferredAccount);
    if (!candidates.length) {
        // Accounts created before the registerPost nick gate can hold a
        // username no derived nick can be legal for (`bob.smith`, `1234`).
        markSkip("username is not a valid IRC nickname");
        logWarn("services: no legal IRC nick can be derived from %s",
                adminChosen ? preferredAccount : "username " ~ user.username);
        return ProvisionOutcome.nickUnavailable;
    }

    string password;
    try password = generateServicesPassword();
    catch (Exception e) {
        logWarn("services: password generation failed for %s: %s", user.username, e.msg);
        return ProvisionOutcome.failed;
    }

    // Hijack guard. `ns_register` finishes with `u->Identify(na)` for whoever
    // is online as the target nick, so registering a nick a stranger holds
    // would hand them the brand-new account. The engine's own nick is the
    // oracle: nicks are unique, so a candidate the engine holds is ours.
    const engineNick = awaitEngineNick(redis, serverRegistry, cfg.id.toString());
    if (!engineNick.length)
        logDebug("services: engine reports no live nick for %s yet", cfg.id.toString());

    /// true → registering `candidate` cannot hand the account to a stranger.
    /// `defer` is set when somebody holds the nick but we cannot prove that
    /// somebody is us.
    bool safeToRegister(string candidate, out bool defer) {
        defer = false;
        if (candidate == engineNick) return true;

        auto probe = anopeUser(s, candidate);
        if (!probe.transportOk) {
            logWarn("services: presence probe for %s failed: %s", candidate, probe.transportError);
            defer = true;
            return false;
        }
        if (!anopeUserOnline(probe)) return true;  // nobody there → nothing to hijack
        if (engineNick.length) {
            // Engine is connected under a different nick, so this live session
            // belongs to somebody else. Never register it.
            logWarn("services: nick %s is held by a foreign session (our engine holds %s) — " ~
                    "refusing to register it for %s", candidate, engineNick, user.username);
            return false;
        }
        // Engine not connected yet: the session may be our own connection
        // mid-registration. Unprovable → retry later.
        defer = true;
        return false;
    }

    // Services commands are space-delimited: an email carrying whitespace or
    // control characters would inject extra REGISTER parameters, so drop it
    // rather than pass it through.
    string emailArg;
    if (isSafeServicesArg(user.email)) emailArg = user.email;
    else if (user.email.length)
        logWarn("services: dropping unsafe email argument for %s", user.username);

    string account;
    foreach (candidate; candidates) {
        bool defer;
        if (!safeToRegister(candidate, defer)) {
            if (defer) {
                logInfo("services: deferring NickServ registration for %s — %s is online " ~
                        "but not attributable to our engine", user.username, candidate);
                return ProvisionOutcome.deferred;
            }
            continue;  // stranger holds it; try the next candidate
        }

        // Record the credential BEFORE creating the account. If the process
        // dies (or Mongo rejects the write) between REGISTER and save, the
        // next run adopts this record instead of orphaning the nick with a
        // password nobody knows — see adoptPendingCredential.
        rememberPending(candidate, password);

        auto reply = anopeCommand(s, "NickServ", candidate,
                                  emailArg.length ? "REGISTER " ~ password ~ " " ~ emailArg
                                                  : "REGISTER " ~ password);
        if (!reply.transportOk) {
            // Retry on the next login rather than burning a candidate.
            logWarn("services: Anope unreachable while registering %s: %s",
                    candidate, reply.transportError);
            return ProvisionOutcome.failed;
        }

        auto verdict = classifyNickServReply(reply.text);
        if (verdict == NickServVerdict.emailRejected) {
            // Some configurations reject the address; REGISTER works without one.
            reply = anopeCommand(s, "NickServ", candidate, "REGISTER " ~ password);
            if (!reply.transportOk) {
                logWarn("services: Anope unreachable while registering %s: %s",
                        candidate, reply.transportError);
                return ProvisionOutcome.failed;
            }
            verdict = classifyNickServReply(reply.text);
        }

        final switch (verdict) {
            case NickServVerdict.registered:
                // Never hand the user a credential we have not proven works:
                // verify it through the same path SASL PLAIN will take.
                bool determined;
                if (!anopeCheckAuthentication(s, candidate, password, determined)) {
                    logWarn("services: %s registered but the generated credential does not " ~
                            "authenticate (verified=%s) — leaving it unpersisted for the next run",
                            candidate, determined);
                    return ProvisionOutcome.failed;
                }
                account = candidate;
                break;
            case NickServVerdict.alreadyTaken:
            case NickServVerdict.nickRejected:
                continue;
            case NickServVerdict.emailRejected:
            case NickServVerdict.passwordRejected:
            case NickServVerdict.disabled:
            case NickServVerdict.unknown:
                logWarn("services: NickServ refused %s: %s", candidate, reply.text);
                markSkip(reply.text.length ? reply.text : "NickServ refused the registration");
                return ProvisionOutcome.failed;
        }
        if (account.length) break;
    }

    if (!account.length) {
        markSkip("\"" ~ user.username ~ "\" and every fallback nick are already"
                 ~ " registered or in use on IRC");
        logWarn("services: no candidate nick for %s could be registered " ~
                "(all taken or held by other sessions)", user.username);
        return ProvisionOutcome.collisionExhausted;
    }

    return persistProvisionedAccount(user, cfg, account, password,
                                     networkRepo, redis, serverRegistry);
}

/// Shared tail of both paths (fresh registration and adopted pending
/// credential): persist the SASL credential, drop the engine's remembered
/// nick, and make the live session reconnect so it authenticates.
///
/// Not `private`: `ircfiber.web.admin.nickserv` commits an admin-generated
/// password through exactly this path, because skipping any one of its five
/// steps (Mongo save, userNetworks cache drop, pending-record delete,
/// networkNick delete, reconnectNetwork push) leaves the engine
/// authenticating with the stale credential.
ProvisionOutcome persistProvisionedAccount(
        User user, NetworkConfig cfg, string account, string password,
        NetworkRepository networkRepo, RedisStorage redis, ServerRegistry serverRegistry) {
    const userId = user.id.toString();
    auto db = redis.getDb();

    cfg.sasl = SASLMechanism.plain;
    cfg.saslUsername = account;
    cfg.saslPassword = password;
    if (account != cfg.nick) {
        cfg.nick = account;
        cfg.realName = account;
    }
    networkRepo.save(cfg, user.id);
    redis.del(RedisKeys.userNetworks(userId));
    // The credential is live in Mongo now, so the crash-recovery record has
    // done its job.
    try db.del(servicesPendingKey(userId));
    catch (Exception e) logWarn("services: clearing pending credential for %s failed: %s",
                                user.username, e.msg);
    // The engine prefers the Redis-persisted nick over config.nick, so a
    // collision fallback only takes effect once this key is gone.
    try db.del(RedisKeys.networkNick(cfg.id.toString()));
    catch (Exception e) logWarn("services: clearing persisted nick for %s failed: %s",
                                cfg.id.toString(), e.msg);

    // Reconnect so the live session authenticates via SASL. reconnectNetwork
    // is correct whether or not a connection currently exists, and it is the
    // only way to guarantee the session is identified when Anope registered
    // the account while the nick was momentarily offline (killprotect would
    // otherwise guest-nick it within 60s).
    string serverId;
    try {
        serverId = serverRegistry.getServerForNetwork(cfg.id.toString());
        if (!serverId.length) serverId = serverRegistry.assignNetwork(cfg.id.toString());
    } catch (Exception e) {
        logWarn("services: server lookup for %s failed: %s", cfg.id.toString(), e.msg);
    }
    if (!serverId.length) {
        logWarn("services: registered %s but no healthy engine to reconnect network %s — " ~
                "the engine will pick up the credential on its next bootstrap",
                account, cfg.id.toString());
        return ProvisionOutcome.registered;
    }
    try {
        auto msg = ControlMessage("reconnectNetwork", cfg.id.toString(), userId, cfg.toJson());
        msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
        redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
    } catch (Exception e) {
        logWarn("services: failed to push reconnectNetwork for %s: %s", cfg.id.toString(), e.msg);
    }

    // Reached from both a fresh REGISTER and an adopted pending credential,
    // so do not claim the account was created right now.
    logInfo("services: NickServ account %s is live for user %s", account, user.username);
    return ProvisionOutcome.registered;
}

/// Fiber wrapper so request handlers can fire-and-forget.
private final class ServicesProvisioner {
    private User user;
    private RedisStorage redis;

    this(User user, RedisStorage redis) {
        this.user = user;
        this.redis = redis;
    }

    void run() nothrow {
        try {
            provisionServicesAccount(user, new NetworkRepository(), redis, new ServerRegistry(redis));
        } catch (Exception e) {
            try logWarn("services: provisioning %s failed: %s", user.username, e.msg);
            catch (Exception) {}
        }
    }
}

/// Schedule provisioning for `user` without blocking the response.
void provisionServicesAccountAsync(User user, RedisStorage redis) {
    auto worker = new ServicesProvisioner(user, redis);
    runTask(&worker.run);
}

@("isValidIrcNick follows the InspIRCd first-character rule")
unittest {
    assert(isValidIrcNick("alice"));
    assert(isValidIrcNick("[bob]"));
    assert(isValidIrcNick("bob-2"));
    assert(isValidIrcNick("_ghost"));
    assert(!isValidIrcNick(""));
    assert(!isValidIrcNick("1234"), "a leading digit is not a legal nick");
    assert(!isValidIrcNick("-bob"), "a leading hyphen is not a legal nick");
    assert(!isValidIrcNick("bob.smith"), "'.' is not a nick character");
    assert(!isValidIrcNick("bob smith"));
    string long_;
    foreach (_; 0 .. 33) long_ ~= "a";
    assert(!isValidIrcNick(long_), "33 chars exceeds maxnick");
    assert(isValidIrcNick(long_[0 .. 32]));
}

@("classifyNickServReply distinguishes taken from registered")
unittest {
    // The '!' vs '.' distinction is why the ordering in classifyNickServReply
    // is load-bearing: "is already registered!" contains "registered".
    assert(classifyNickServReply("Nickname \x02alice\x02 is already registered!")
           == NickServVerdict.alreadyTaken);
    assert(classifyNickServReply("Nickname \x02alice\x02 registered.")
           == NickServVerdict.registered);
    assert(classifyNickServReply("Nickname \x02alice\x02 registered under your user@host-mask: alice@example")
           == NickServVerdict.registered);
    assert(classifyNickServReply("Nickname \x021234\x02 may not be registered.")
           == NickServVerdict.nickRejected);
    assert(classifyNickServReply("\x02nope\x02 is not a valid e-mail address.")
           == NickServVerdict.emailRejected);
    assert(classifyNickServReply("Please try again with a more obscure password.")
           == NickServVerdict.passwordRejected);
    assert(classifyNickServReply("Sorry, registration is currently disabled.")
           == NickServVerdict.disabled);
    assert(classifyNickServReply("You are not authorized to do that.")
           == NickServVerdict.unknown);
}

@("servicesAccountCandidates falls back past the username")
unittest {
    import std.uuid : UUID;
    User u;
    u.id = UUID("12345678-90ab-cdef-1234-567890abcdef");
    u.username = "alice";
    auto c = servicesAccountCandidates(u);
    assert(c.length == 10, "username + deterministic fallback + _2.._9");
    assert(c[0] == "alice");
    assert(c[1] == "alice_1234");
    assert(c[2] == "alice_2");
    assert(c[$ - 1] == "alice_9");
}

@("servicesAccountCandidates drops nicks the ircd would refuse")
unittest {
    import std.uuid : UUID;
    User u;
    u.id = UUID("12345678-90ab-cdef-1234-567890abcdef");
    u.username = "1234";  // not a legal nick — every derived candidate keeps the digit
    assert(servicesAccountCandidates(u).length == 0);
}

@("an admin-supplied account name replaces the derived candidates")
unittest {
    import std.uuid : UUID;
    User u;
    u.id = UUID("12345678-90ab-cdef-1234-567890abcdef");
    u.username = "alice";
    // Falling back to alice_2 for an admin who asked for "bobby" would create
    // an account nobody requested, so the list is exactly the one name.
    assert(servicesAccountCandidates(u, "bobby") == ["bobby"]);
    assert(servicesAccountCandidates(u, "1234").length == 0,
           "an illegal admin nick yields nickUnavailable, never a fallback");
}

@("generateServicesPassword is unbiased-sampled, alphanumeric and unique")
unittest {
    const a = generateServicesPassword();
    const b = generateServicesPassword();
    assert(a.length == 24);
    assert(a != b, "two draws from /dev/urandom must differ");
    foreach (char c; a) assert(isAlphaNum(c), "no XML- or IRC-special characters");
    assert(generateServicesPassword(8).length == 8);
}
