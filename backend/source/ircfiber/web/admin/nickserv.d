module ircfiber.web.admin.nickserv;

///
/// NickServ account management for the admin dashboard (IRCD page → NickServ).
///
/// Two data paths, deliberately different:
///   * the **inventory** (`/accounts`) reads Anope's `db_flatfile` directly
///     (`ircfiber.services.anope_db`), because Anope 2.0 has no enumeration
///     RPC and `NickServ LIST` is capped by `listmax`. It is up to
///     `updatetimeout` (5m) stale and says so;
///   * every **per-account** view and action goes over the existing XML-RPC
///     client as the services-oper account (`IRCFIBER_ANOPE_OPER_ACCOUNT`),
///     so it is live and authoritative.
///
/// `m_xmlrpc_main` builds a `CommandSource` with a null `User` for an offline
/// nick, and `CommandSource::HasPriv` then resolves privileges straight from
/// `nc->o->ot`, so `require_oper` on the oper block does not apply and the
/// oper account need not be online. Anope attaches `nc->o` only at config
/// load, so an account that is not tied yet answers `Access denied.` with
/// HTTP 200 — that is what `anopeAccessDenied` detects and reports as 403
/// with the remediation, instead of a misleading 500.
///
/// Platform coupling: an account whose name matches a `saslUsername` on an
/// `irc.ircfiber.com` network belongs to a website user, so DROP and
/// password reset also fix that user's stored credential. Skipping it would
/// leave the engine authenticating with a credential that no longer works.
///

import std.algorithm : canFind, sort;
import std.conv : to;
import std.string : strip, toLower;
import std.traits : EnumMembers;
import std.uni : sicmp;
import std.uuid : UUID, parseUUID;

import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.db.network : NetworkRepository;
import ircfiber.db.user : UserRepository;
import ircfiber.default_network : DEFAULT_FIBER_HOST, buildDefaultNick,
    ensureDefaultFiberNetwork;
import ircfiber.irc.registry : ServerRegistry;
import ircfiber.models.network : NetworkConfig, SASLMechanism;
import ircfiber.models.user : User;
import ircfiber.redis.protocol : ControlMessage, RedisKeys;
import ircfiber.services.accounts : generateServicesPassword, isValidIrcNick,
    persistProvisionedAccount, provisionServicesAccount, provisionServicesAccountAsync,
    ProvisionOutcome, servicesAccountCandidates, servicesPendingKey, servicesSkipKey,
    SERVICES_OUTCOMES_KEY;
import ircfiber.services.anope : AnopeReply, AnopeSettings, anopeAccessDenied,
    anopeCheckAuthentication, anopeNickRegistration, anopeOperAccounts, anopeOperCommand,
    anopeOperQuery, isSafeServicesArg, loadAnopeSettings, nickServSetPasswordCommand,
    NickRegistration, parseNickInfo;
import ircfiber.services.anope_db : AnopeAccount, AnopeInventory, asciiLowerStr,
    classifyAccountOwnership, readAnopeInventory;
import ircfiber.support.bot : SupportBotConfig;
import ircfiber.fibereye.bot : FiberEyeConfig;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonError, jsonOk, readJsonBody;
import ircfiber.web.admin.services_common : accessDeniedMessage, anopeReplyOk,
    anopeTransportOk, hasControlChars, isValidExpiry, jsonStr, jsonTrue,
    loadPlatformRows, notRegistered, PlatformRow, servicesSettings;

// ---------------------------------------------------------------------------
// Nick-specific failure mapping
// ---------------------------------------------------------------------------

/// `anopeReplyOk` with NickServ's wording for a subject that does not exist.
private bool nsReplyOk(HTTPServerResponse res, const AnopeSettings s, string nick,
                       const AnopeReply r) {
    return anopeReplyOk(res, s, r, "No NickServ account named \"" ~ nick ~ "\".");
}

/// Services commands are space-delimited, so a nick carrying whitespace would
/// inject extra parameters into the command Anope runs. Both gates are
/// applied: `isValidIrcNick` is the ircd's own rule, `isSafeServicesArg` the
/// injection guard.
private bool nsValidNick(HTTPServerResponse res, string nick) {
    if (!isValidIrcNick(nick) || !isSafeServicesArg(nick)) {
        jsonError(res, 400, "Not a valid nickname.");
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Platform (IRC Fiber) account join
// ---------------------------------------------------------------------------

/// The Fiber network whose `saslUsername` is `nick` (ASCII case-insensitive,
/// because IRC nicks are), plus its owner. False when the nick is not a
/// platform account or its owner no longer exists.
private bool findPlatformAccount(string nick, out NetworkConfig cfg, out User owner) {
    cfg = NetworkConfig.init;
    owner = User.init;
    try {
        auto networks = new NetworkRepository();
        foreach (row; networks.listWithSaslAccount(DEFAULT_FIBER_HOST)) {
            if (sicmp(row.config.saslUsername.strip(), nick) != 0) continue;
            if (row.userId == UUID.init) return false;
            try owner = new UserRepository().findById(parseUUID(row.userId.toString().idup));
            catch (Exception e) {
                logWarn("nickserv: owner lookup for %s failed: %s", nick, e.msg);
                return false;
            }
            if (owner.id == UUID.init) return false;
            cfg = row.config;
            return true;
        }
    } catch (Exception e) {
        logWarn("nickserv: platform lookup for %s failed: %s", nick, e.msg);
    }
    return false;
}

// ---------------------------------------------------------------------------
// Provisioning telemetry
// ---------------------------------------------------------------------------
//
// Why this is on the NickServ page: prod ran for weeks with zero of ten
// website users holding a NickServ credential, and nothing said so. The
// provisioner logs a warning on failure and deliberately sets no skip key
// for a transport failure, so a permanently broken Anope is indistinguishable
// from an idle one. The three numbers below are the ones that would have
// shown it: how many networks have no credential at all, how many generated
// credentials were never persisted (each one a user locked out of their own
// nick), and how the last attempts actually ended.

/// A count we could not read. The SPA renders it as "unknown": reporting a
/// Redis hiccup as `0` would be the exact reassuring lie this section exists
/// to prevent.
private enum long COUNT_UNKNOWN = -1;

/// The 24h "stopped trying, here's why" marker, or "" when there is none.
/// Read rather than inferred: the provisioner stores NickServ's own refusal
/// text there, which is the only record of why a user was given up on.
private string skipReasonFor(RedisStorage redis, string userId) {
    try return redis.getDb().get(servicesSkipKey(userId));
    catch (Exception e) {
        logWarn("nickserv: reading the skip marker for %s failed: %s", userId, e.msg);
        return "";
    }
}

/// One website user whose IRC identity is backed by no NickServ account.
private struct UnprovisionedUser {
    User user;
    NetworkConfig cfg;   /// their Fiber network; `id == UUID.init` when they have none
    bool hasNetwork;
}

/**
 * Every website user whose `irc.ircfiber.com` network carries no SASL
 * credential, plus the users who have no Fiber network at all — those are
 * equally unsynced, and `create` provisions the network for them.
 *
 * Enumerated from the users collection, not from networks, so the count this
 * page reports and the rows it offers to fix are the same population. A
 * networks-derived list would silently omit exactly the users nothing has
 * ever provisioned.
 */
private UnprovisionedUser[] unprovisionedUsers() {
    auto users = new UserRepository();
    // findAll ignores its offset argument, so one oversized page holds
    // everybody; the admin user table is in the tens.
    auto all = users.findAll(users.count() + 50, 0);

    NetworkConfig[string] fiber;
    foreach (row; new NetworkRepository().findAll()) {
        if (row.config.host != DEFAULT_FIBER_HOST) continue;
        const uid = row.userId.toString();
        // Hand-made Mongo docs can leave a user with two Fiber networks: the
        // one holding a credential wins, so a provisioned user is never listed.
        if (auto have = uid in fiber)
            if (have.saslUsername.strip().length) continue;
        fiber[uid] = row.config;
    }

    UnprovisionedUser[] rows;
    foreach (u; all) {
        if (u.id == UUID.init) continue;
        auto cfg = u.id.toString() in fiber;
        if (cfg && cfg.saslUsername.strip().length) continue;
        UnprovisionedUser r;
        r.user = u;
        if (cfg) {
            r.cfg = *cfg;
            r.hasNetwork = true;
        }
        rows ~= r;
    }
    sort!((a, b) => sicmp(a.user.username, b.user.username) < 0)(rows);
    return rows;
}

/// The three per-user counters, all derived in one pass.
private struct ProvisioningCounts {
    long pendingOrphans = COUNT_UNKNOWN;
    long skipMarkers = COUNT_UNKNOWN;
    long unprovisioned = COUNT_UNKNOWN;
}

/**
 * Counts derived per user instead of by scanning the keyspace.
 *
 * The first version issued `SCAN` and read the reply as `RedisReply!string`.
 * A SCAN reply is a NESTED multi-bulk — `[cursor, [key, ...]]` — so consuming
 * the second element as a string desynchronised the pooled connection, and
 * every later request that borrowed it hung too: the whole account inventory
 * stopped responding (observed in the scratch smoke, >30s with no reply).
 *
 * Two `GET`s per Fiber network cost nothing at this scale, cannot desync
 * anything, and read the exact keys the provisioner writes — a pending or
 * skip marker only exists for a user who already had a network.
 *
 * `unprovisioned` is counted from `unprovisionedUsers` instead, so the number
 * and the rows the create action offers to fix can never disagree.
 */
private ProvisioningCounts provisioningCounts(RedisStorage redis) {
    ProvisioningCounts c;
    long pending = 0, skips = 0;
    bool redisOk = true;
    try {
        auto db = redis.getDb();
        foreach (row; new NetworkRepository().findAll()) {
            if (row.config.host != DEFAULT_FIBER_HOST) continue;
            if (!redisOk) continue;
            const uid = row.userId.toString();
            try {
                if (db.get(servicesPendingKey(uid)).length) pending++;
                if (db.get(servicesSkipKey(uid)).length) skips++;
            } catch (Exception e) {
                // Keep whatever else is readable; only the Redis numbers degrade.
                logWarn("nickserv: reading provisioning markers failed: %s", e.msg);
                redisOk = false;
            }
        }
    } catch (Exception e) {
        logWarn("nickserv: counting provisioning state failed: %s", e.msg);
        return c;
    }
    if (redisOk) {
        c.pendingOrphans = pending;
        c.skipMarkers = skips;
    }
    try c.unprovisioned = cast(long) unprovisionedUsers().length;
    catch (Exception e) logWarn("nickserv: counting unprovisioned users failed: %s", e.msg);
    return c;
}

/// The `provisioning` block of the inventory response. Every source is read
/// under its own guard: a failing Redis or Mongo degrades one number to
/// `unknown` instead of taking the whole account inventory down with it.
private Json provisioningJson(RedisStorage redis) {
    auto outcomes = Json.emptyObject;
    // Zero-fill first, so the UI always renders the same breakdown and a
    // field that was never incremented reads as "never happened" rather than
    // disappearing from the list.
    bool[string] known;
    foreach (m; EnumMembers!ProvisionOutcome) {
        const name = m.to!string;
        known[name] = true;
        outcomes[name] = 0L;
    }

    string lastOutcome;
    long lastOutcomeAt = 0;
    try {
        auto raw = redis.hgetAll(SERVICES_OUTCOMES_KEY);
        foreach (name, value; raw) {
            if (name == "lastOutcome") {
                lastOutcome = value;
                continue;
            }
            if (name == "lastOutcomeAt") {
                try lastOutcomeAt = value.to!long;
                catch (Exception) {}
                continue;
            }
            // Ignore anything else: an outcome member dropped from the enum
            // must not resurrect itself in the breakdown, and `opIndex` on a
            // mutable Json object would insert the stale field.
            if (name !in known) continue;
            try outcomes[name] = value.to!long;
            catch (Exception) {}
        }
    } catch (Exception e) {
        logWarn("nickserv: reading %s failed: %s", SERVICES_OUTCOMES_KEY, e.msg);
    }

    auto j = Json.emptyObject;
    j["outcomes"] = outcomes;
    j["lastOutcome"] = lastOutcome;
    j["lastOutcomeAt"] = lastOutcomeAt;
    const counts = provisioningCounts(redis);
    j["pendingOrphans"] = counts.pendingOrphans;
    // Named `skipMarkers`, not `skipped`: `outcomes.skipped` already means
    // something else (an attempt that bailed out), and confusing the two
    // would misread a healthy no-op as a giving-up.
    j["skipMarkers"] = counts.skipMarkers;
    j["unprovisioned"] = counts.unprovisioned;
    return j;
}

// ---------------------------------------------------------------------------
// GET /api/admin/ircd/nickserv/unprovisioned
// POST /api/admin/ircd/nickserv/create
// ---------------------------------------------------------------------------

/// GET /api/admin/ircd/nickserv/unprovisioned — the website users the create
/// action exists for: no NickServ account owns their nick, so anybody on IRC
/// can take it. `suggestedNick` is the candidate the automatic provisioner
/// would try first, and `skipReason` is why it stopped trying (if it did).
package void apiNsUnprovisioned(HTTPServerRequest, HTTPServerResponse res, RedisStorage redis) {
    UnprovisionedUser[] rows;
    try rows = unprovisionedUsers();
    catch (Exception e) {
        logWarn("nickserv: listing users without a NickServ account failed: %s", e.msg);
        jsonError(res, 502, "Could not read the user list: " ~ e.msg);
        return;
    }

    auto arr = Json.emptyArray;
    foreach (ref r; rows) {
        auto j = Json.emptyObject;
        const userId = r.user.id.toString();
        j["userId"] = userId;
        j["username"] = r.user.username;
        j["email"] = r.user.email;
        j["networkId"] = r.hasNetwork ? r.cfg.id.toString() : "";
        j["hasNetwork"] = r.hasNetwork;
        j["networkDisabled"] = r.hasNetwork && r.cfg.disabled;
        auto candidates = servicesAccountCandidates(r.user);
        // "" when no legal nick can be derived from the username (a legacy
        // `bob.smith`): the UI then makes the admin type one.
        j["suggestedNick"] = candidates.length ? candidates[0] : "";
        j["skipReason"] = skipReasonFor(redis, userId);
        arr ~= j;
    }
    auto data = Json.emptyObject;
    data["users"] = arr;
    jsonOk(res, data);
}

/// Maps a provisioning attempt that did not end in `registered` onto HTTP.
/// Each message names the remedy, because every one of these outcomes has a
/// different one and "provisioning failed" would name none of them.
private void createFailed(HTTPServerResponse res, ProvisionOutcome outcome,
                          string username, string nick, string skipReason) {
    switch (outcome) {
        case ProvisionOutcome.disabled:
            jsonError(res, 501, "Anope RPC is not configured (IRCFIBER_ANOPE_RPC_URL).");
            return;
        case ProvisionOutcome.alreadyProvisioned:
            jsonError(res, 409, username ~ " already holds a NickServ credential.");
            return;
        case ProvisionOutcome.skipped:
            jsonError(res, 409, "Provisioning declined for " ~ username ~ ": their "
                      ~ DEFAULT_FIBER_HOST ~ " network is missing or disabled.");
            return;
        case ProvisionOutcome.nickUnavailable:
            jsonError(res, 400, nick.length
                ? "\"" ~ nick ~ "\" is not a legal IRC nickname."
                : "No legal IRC nickname can be derived from \"" ~ username
                  ~ "\" — type one in.");
            return;
        case ProvisionOutcome.deferred:
            // ns_register ends with u->Identify(na), so registering a nick a
            // stranger holds would hand them the new account.
            jsonError(res, 409, (nick.length ? "\"" ~ nick ~ "\"" : "That nickname")
                      ~ " is online and the session cannot be attributed to " ~ username
                      ~ ", so nothing was registered. Retry once their engine session is"
                      ~ " connected, or pick another nick.");
            return;
        case ProvisionOutcome.collisionExhausted:
            jsonError(res, 409, nick.length
                ? "\"" ~ nick ~ "\" is already registered or in use on IRC. Link the existing"
                  ~ " account instead."
                : "Every candidate nick for " ~ username
                  ~ " is registered or in use on IRC — type a different nick.");
            return;
        default:
            jsonError(res, 502, skipReason.length
                ? "NickServ refused the registration: " ~ skipReason
                : "The registration failed — see the gateway log.");
            return;
    }
}

/**
 * POST /api/admin/ircd/nickserv/create   body {userId, nick?}
 *
 * The manual form of what signup and login do automatically: register a
 * NickServ account and store it as the user's SASL credential, so their
 * session identifies and nobody else can take their nick. `nick` is optional
 * — without it the provisioner walks the same candidate list signup uses
 * (username, `<username>_<hex>`, `_2`…`_9`).
 *
 * Runs the real provisioner rather than a second registration path: its
 * hijack guard (never register a nick a foreign session holds), its
 * pending-credential crash recovery and its credential verification are the
 * reason an account created here actually authenticates.
 *
 * No services-oper privileges are needed — `REGISTER` is sent *as* the target
 * nick, exactly as the automatic provisioner sends it — so this stays usable
 * on a deployment whose oper account is not tied yet.
 *
 * The generated password is deliberately not returned: SASL reads it from
 * Mongo, no human needs it, and "Reset password" already exists for the case
 * where the owner wants one they can type.
 */
package void apiNsCreate(HTTPServerRequest req, HTTPServerResponse res,
                         RedisStorage redis, ServerRegistry serverRegistry) {
    auto s = loadAnopeSettings();
    if (!s.configured) {
        jsonError(res, 501, "Anope RPC is not configured (IRCFIBER_ANOPE_RPC_URL).");
        return;
    }
    auto payload = readJsonBody(req);
    User owner;
    if (!bodyUser(res, payload, owner)) return;
    const nick = jsonStr(payload, "nick");
    if (nick.length && !nsValidNick(res, nick)) return;

    // Reject an owned name before touching anything: the provisioner would
    // answer `collisionExhausted`, which reads as "try another nick" when the
    // actual remedy is to link the account that already exists.
    if (nick.length) {
        final switch (anopeNickRegistration(s, nick)) {
            case NickRegistration.registered:
                jsonError(res, 409, "\"" ~ nick ~ "\" is already registered. Link it to "
                          ~ owner.username ~ " instead of creating an account.");
                return;
            case NickRegistration.servicesReserved:
                jsonError(res, 409, "\"" ~ nick ~ "\" belongs to the network's own services.");
                return;
            case NickRegistration.unknown:
                jsonError(res, 502, "Could not check \"" ~ nick ~ "\" with Anope.");
                return;
            case NickRegistration.free:
                break;
        }
    }

    NetworkConfig cfg;
    if (!fiberNetworkFor(owner, redis, serverRegistry, cfg)) {
        jsonError(res, 409, owner.username ~ " has no " ~ DEFAULT_FIBER_HOST ~ " network and one"
                  ~ " could not be created (the Fiber network may be disabled in config).");
        return;
    }
    if (cfg.disabled) {
        jsonError(res, 409, owner.username ~ "'s " ~ DEFAULT_FIBER_HOST
                  ~ " network is disabled — enable it before creating an account.");
        return;
    }
    const existing = cfg.saslUsername.strip();
    if (existing.length && cfg.saslPassword.length) {
        jsonError(res, 409, owner.username ~ " already holds NickServ account \"" ~ existing
                  ~ "\". Use Reset password, or unlink it first.");
        return;
    }

    // An admin pressing this button overrides the 24h park a previous
    // permanent refusal left behind; without this the action would silently
    // no-op as `skipped`.
    const userId = owner.id.toString();
    try redis.getDb().del(servicesSkipKey(userId));
    catch (Exception e) logWarn("nickserv: clearing the skip marker for %s failed: %s",
                                userId, e.msg);

    ProvisionOutcome outcome;
    try outcome = provisionServicesAccount(owner, new NetworkRepository(), redis,
                                           serverRegistry, nick);
    catch (Exception e) {
        logWarn("nickserv: creating a NickServ account for %s failed: %s", owner.username, e.msg);
        jsonError(res, 502, "The registration failed: " ~ e.msg);
        return;
    }
    if (outcome != ProvisionOutcome.registered) {
        createFailed(res, outcome, owner.username, nick, skipReasonFor(redis, userId));
        return;
    }

    // Read back what the provisioner settled on instead of echoing the
    // request: without an explicit nick it picks a candidate, and it also
    // adopts an orphaned pending credential when one still authenticates.
    string account = nick;
    string networkId = cfg.id.toString();
    try {
        foreach (ref c; new NetworkRepository().findByUserId(owner.id)) {
            if (c.host != DEFAULT_FIBER_HOST) continue;
            if (!c.saslUsername.strip().length) continue;
            account = c.saslUsername.strip();
            networkId = c.id.toString();
            break;
        }
    } catch (Exception e) {
        logWarn("nickserv: reading back the credential for %s failed: %s", owner.username, e.msg);
    }

    logInfo("Admin created NickServ account %s for user %s", account, owner.username);
    auto data = Json.emptyObject;
    data["nick"] = account;
    data["userId"] = userId;
    data["username"] = owner.username;
    data["networkId"] = networkId;
    data["created"] = true;
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// Account ownership (who, if anybody, this account belongs to)
// ---------------------------------------------------------------------------
//
// The inventory says an account exists; it never said whether anybody still
// wants it. Prod is the argument for this section: of 13 NickServ accounts
// only 4 carry a `saslUsername` link, three more (`kfnFiber`, `TL`,
// `lex0de_df02`) belong to current users and are tied to them by nothing but
// the address they registered with, and one (`dnsk`) has no website user at
// all — yet its owner was seen online on IRC. So this classifies and
// reports; it never drops. `unowned` is a prompt for a human to press the
// existing Drop button, not a verdict.

// `classifyAccountOwnership` and `asciiLowerStr` live in
// `services.anope_db`: they are pure inventory logic, and only there does a
// dub configuration (`services-test`) actually compile and run their
// unittests — in this module the blocks would never execute.

/**
 * The accounts that must never read as unowned, ASCII-lowercased.
 *
 * Three sources, because no single one covers the staff population:
 *   * `OperServ OPER LIST` over RPC — the authoritative opers, but it reports
 *     the *nick* each `oper {}` block names, so prod's `admin` block has to
 *     be resolved through the inventory to its display `Zodiac` (both rows
 *     are then staff);
 *   * `IRCFIBER_ANOPE_OPER_ACCOUNT` — the account this gateway itself runs
 *     privileged commands as. It is an oper by construction, and adding it
 *     unconditionally means an unreachable Anope cannot make it look
 *     droppable;
 *   * the bots' nicks — `FiberSupport` and `FiberLogs` are *not* Anope
 *     opers (verified: their `NickServ INFO` has no "is a Services
 *     Operator" line), they are infrastructure this codebase owns and
 *     identifies as, so nothing in Mongo will ever claim them.
 */
private bool[string] staffAccountsLower(const ref AnopeInventory inv) {
    import std.process : environment;

    auto s = loadAnopeSettings();
    auto staff = anopeOperAccounts(s);
    if (s.operAccount.length) staff[asciiLowerStr(s.operAccount)] = true;
    auto botNick = environment.get("IRCFIBER_SUPPORT_BOT_NICK", "").strip();
    if (!botNick.length) botNick = SupportBotConfig.init.nick;
    if (botNick.length) staff[asciiLowerStr(botNick)] = true;
    auto eyeNick = environment.get("IRCFIBER_FIBEREYE_NICK", "").strip();
    if (!eyeNick.length) eyeNick = FiberEyeConfig.init.nick;
    if (eyeNick.length) staff[asciiLowerStr(eyeNick)] = true;

    // Alias → display. A grouped account is one identity wearing several
    // nicks, so flagging only the nick the oper block happens to name would
    // leave its other rows (prod: `Zodiac`, from the `admin` block) looking
    // ownerless.
    foreach (ref a; inv.accounts) {
        if (!a.account.length) continue;
        const nick = asciiLowerStr(a.nick);
        const display = asciiLowerStr(a.account);
        if (nick in staff || display in staff) {
            staff[nick] = true;
            staff[display] = true;
        }
    }
    return staff;
}

/// lower(email) → username for every website user, from one Mongo query. The
/// `email` ownership class exists entirely because of this index: accounts
/// registered before SASL linking carry their owner's address and nothing
/// else.
private string[string] loadUserEmails() {
    string[string] byEmail;
    try {
        auto users = new UserRepository();
        // findAll ignores its offset argument, so one oversized page holds
        // everybody (same idiom as unprovisionedUsers).
        foreach (u; users.findAll(users.count() + 50, 0)) {
            const email = asciiLowerStr(u.email.strip());
            if (!email.length) continue;
            // Two users on one address (prod: `TL` and `TPABA` both hold
            // audrius@gamesnet.lt) is a Mongo defect, not two owners. The
            // lowest username wins so the reported owner cannot flip
            // between requests as Mongo reorders documents.
            if (auto have = email in byEmail)
                if (asciiLowerStr(*have) <= asciiLowerStr(u.username)) continue;
            byEmail[email] = u.username;
        }
    } catch (Exception e) {
        logWarn("nickserv: loading the user email index failed: %s", e.msg);
    }
    return byEmail;
}

// ---------------------------------------------------------------------------
// GET /api/admin/ircd/nickserv/accounts
// ---------------------------------------------------------------------------

private Json accountJson(const ref AnopeAccount a) {
    auto j = Json.emptyObject;
    j["nick"] = a.nick;
    j["account"] = a.account;
    j["email"] = a.email;
    j["registeredAt"] = a.registeredAt;
    j["lastSeenAt"] = a.lastSeenAt;
    j["lastUsermask"] = a.lastUsermask;
    j["lastRealName"] = a.lastRealName;
    j["suspended"] = a.suspended;
    j["suspendedBy"] = a.suspendedBy;
    j["suspendReason"] = a.suspendReason;
    j["suspendedAt"] = a.suspendedAt;
    j["suspendExpiresAt"] = a.suspendExpiresAt;
    return j;
}

private void annotate(ref Json j, const PlatformRow p) {
    j["userId"] = p.userId;
    j["username"] = p.username;
    j["userEmail"] = p.userEmail;
    j["networkId"] = p.networkId;
    j["networkNick"] = p.networkNick;
    j["networkDisabled"] = p.networkDisabled;
}

/// Sets the two ownership keys on one row and reports whether it came out
/// `unowned` — the number the panel headlines.
private bool annotateOwnership(ref Json j, string account, string email,
                               const(PlatformRow)* p, const bool[string] staffLower,
                               const string[string] userEmails) {
    string owner;
    const ownership = classifyAccountOwnership(account, email, p !is null,
                                               staffLower, userEmails, owner);
    // A linked row already reports its owner via the platform join; the
    // classifier only resolves the email match.
    if (ownership == "linked" && p !is null) owner = p.username;
    j["ownership"] = ownership;
    j["ownerUsername"] = owner;
    return ownership == "unowned";
}

/// GET /api/admin/ircd/nickserv/accounts — the whole account inventory,
/// annotated with the website user that owns each account and with how that
/// ownership was established (`ownership`/`ownerUsername`, plus the
/// `unownedCount` roll-up). One `OperServ OPER LIST` and one users query per
/// request, never per row.
///
/// Degraded mode (no mount, path unset, unreadable file): the Mongo join
/// alone still lists every IRC Fiber account, and `reason` tells the admin
/// what is missing. Accounts registered only on IRC are invisible then —
/// which is exactly why the flatfile is read in the first place.
/// The `provisioning` block additionally reports how provisioning itself is
/// going (see the telemetry section above); it needs Redis, which is why this
/// handler takes the storage the other read-only admin endpoints take.
package void apiNsAccounts(HTTPServerRequest, HTTPServerResponse res, RedisStorage redis) {
    auto inv = readAnopeInventory();
    auto platform = loadPlatformRows();
    auto staff = staffAccountsLower(inv);
    auto userEmails = loadUserEmails();
    long unownedCount = 0;

    auto arr = Json.emptyArray;
    foreach (ref a; inv.accounts) {
        auto j = accountJson(a);
        auto p = a.nick.toLower() in platform;
        annotate(j, p ? *p : PlatformRow.init);
        // An alias whose NickCore is missing has no display; the nick is
        // then the only name it has (see anopeAccountsFromDb).
        if (annotateOwnership(j, a.account.length ? a.account : a.nick, a.email,
                              p, staff, userEmails))
            unownedCount++;
        arr ~= j;
    }
    if (!inv.available) {
        string[] names;
        foreach (_, ref p; platform) names ~= p.saslAccount;
        sort!((a, b) => sicmp(a, b) < 0)(names);
        foreach (name; names) {
            AnopeAccount a;
            a.nick = name;
            a.account = name;
            auto j = accountJson(a);
            annotate(j, platform[name.toLower()]);
            // Degraded rows exist *because* a network carries this account
            // as its saslUsername, so they are linked by construction.
            annotateOwnership(j, name, "", &platform[name.toLower()], staff, userEmails);
            arr ~= j;
        }
    }

    auto data = Json.emptyObject;
    data["available"] = inv.available;
    data["reason"] = inv.reason;
    data["asOf"] = inv.fileMtime;
    data["accounts"] = arr;
    data["unownedCount"] = unownedCount;
    data["provisioning"] = provisioningJson(redis);
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// GET /api/admin/ircd/nickserv/account?nick=
// ---------------------------------------------------------------------------

/// Live `NickServ INFO`. A free nickname answers 200 with `registered:false`
/// rather than 404, so the UI can say "this nick is free" — which is why this
/// handler maps failures itself instead of going through `nsReplyOk`.
package void apiNsAccount(HTTPServerRequest req, HTTPServerResponse res) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    const nick = req.query.get("nick", "").strip();
    if (!nsValidNick(res, nick)) return;

    auto r = anopeOperQuery(s, "INFO " ~ nick);
    if (!r.transportOk) {
        jsonError(res, 502, "Anope unreachable: " ~ r.transportError);
        return;
    }
    if (anopeAccessDenied(r)) {
        jsonError(res, 403, accessDeniedMessage(s));
        return;
    }

    auto info = parseNickInfo(r.rawText.length ? r.rawText : r.text);
    auto data = Json.emptyObject;
    data["nick"] = nick;
    data["registered"] = info.registered;
    data["account"] = info.account;
    data["realName"] = info.realName;
    auto fields = Json.emptyObject;
    foreach (k, v; info.fields) fields[k] = v;
    data["fields"] = fields;
    auto lines = Json.emptyArray;
    foreach (line; info.lines) lines ~= Json(line);
    data["lines"] = lines;

    NetworkConfig cfg;
    User owner;
    if (findPlatformAccount(nick, cfg, owner)) {
        auto p = Json.emptyObject;
        p["userId"] = owner.id.toString();
        p["username"] = owner.username;
        p["networkId"] = cfg.id.toString();
        data["platform"] = p;
    } else {
        data["platform"] = Json(null);
    }
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// Suspend / unsuspend / logout
// ---------------------------------------------------------------------------

/// POST /api/admin/ircd/nickserv/suspend  body {nick, reason, expiry?}
/// A suspended account can no longer identify, so a website user's engine
/// session stops authenticating — that is the point of the action.
package void apiNsSuspend(HTTPServerRequest req, HTTPServerResponse res) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    auto payload = readJsonBody(req);
    const nick = jsonStr(payload, "nick");
    if (!nsValidNick(res, nick)) return;
    const reason = jsonStr(payload, "reason");
    if (!reason.length || reason.length > 200 || hasControlChars(reason)) {
        jsonError(res, 400, "A reason is required.");
        return;
    }
    const expiry = jsonStr(payload, "expiry");
    if (expiry.length && !isValidExpiry(expiry)) {
        jsonError(res, 400, "Expiry must look like 30d.");
        return;
    }

    auto r = anopeOperCommand(s, "SUSPEND " ~ nick
        ~ (expiry.length ? " +" ~ expiry : "") ~ " " ~ reason);
    if (!nsReplyOk(res, s, nick, r)) return;

    const t = r.text.toLower();
    if (t.canFind("is already suspended")) { jsonError(res, 409, r.text); return; }
    if (t.canFind("may not suspend other services operators")) {
        jsonError(res, 403, r.text);
        return;
    }
    if (!t.canFind("is now suspended")) {
        jsonError(res, 502, r.text.length ? r.text : "NickServ did not confirm the suspension.");
        return;
    }

    logInfo("Admin suspended NickServ account %s (reason: %s)", nick, reason);
    auto data = Json.emptyObject;
    data["nick"] = nick;
    data["suspended"] = true;
    data["reply"] = r.text;
    jsonOk(res, data);
}

/// POST /api/admin/ircd/nickserv/unsuspend  body {nick}
package void apiNsUnsuspend(HTTPServerRequest req, HTTPServerResponse res) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    const nick = jsonStr(readJsonBody(req), "nick");
    if (!nsValidNick(res, nick)) return;

    auto r = anopeOperCommand(s, "UNSUSPEND " ~ nick);
    if (!nsReplyOk(res, s, nick, r)) return;

    const t = r.text.toLower();
    if (t.canFind("is not suspended")) { jsonError(res, 409, r.text); return; }
    if (!t.canFind("is now released")) {
        jsonError(res, 502, r.text.length ? r.text : "NickServ did not confirm the release.");
        return;
    }

    logInfo("Admin unsuspended NickServ account %s", nick);
    auto data = Json.emptyObject;
    data["nick"] = nick;
    data["suspended"] = false;
    data["reply"] = r.text;
    jsonOk(res, data);
}

/// POST /api/admin/ircd/nickserv/logout  body {nick}
/// De-identifies the live session without touching the account. A nick that
/// is not online is not an error — Anope says so in `reply`.
package void apiNsLogout(HTTPServerRequest req, HTTPServerResponse res) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    const nick = jsonStr(readJsonBody(req), "nick");
    if (!nsValidNick(res, nick)) return;

    auto r = anopeOperCommand(s, "LOGOUT " ~ nick);
    if (!nsReplyOk(res, s, nick, r)) return;

    logInfo("Admin logged out NickServ account %s", nick);
    auto data = Json.emptyObject;
    data["nick"] = nick;
    data["loggedOut"] = true;
    data["reply"] = r.text;
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// Drop + password reset (both carry platform side effects)
// ---------------------------------------------------------------------------

/// The account is gone from services, so the stored SASL credential is dead.
/// Clear it and let the normal provisioner mint a replacement; leaving it
/// would make the engine authenticate against a nonexistent account on every
/// reconnect. False when `nick` is not a platform account.
private bool syncDroppedAccount(string nick, RedisStorage redis, out string username) {
    username = "";
    NetworkConfig cfg;
    User owner;
    if (!findPlatformAccount(nick, cfg, owner)) return false;
    username = owner.username;

    cfg.sasl = SASLMechanism.none;
    cfg.saslUsername = "";
    cfg.saslPassword = "";
    new NetworkRepository().save(cfg, owner.id);
    const userId = owner.id.toString();
    redis.del(RedisKeys.userNetworks(userId));
    auto db = redis.getDb();
    // Both guards would otherwise stop the replacement from being created.
    try db.del(servicesSkipKey(userId));
    catch (Exception e) logWarn("nickserv: clearing skip key for %s failed: %s", userId, e.msg);
    try db.del(servicesPendingKey(userId));
    catch (Exception e) logWarn("nickserv: clearing pending key for %s failed: %s", userId, e.msg);
    provisionServicesAccountAsync(owner, redis);
    return true;
}

/// POST /api/admin/ircd/nickserv/drop  body {nick, confirm}
package void apiNsDrop(HTTPServerRequest req, HTTPServerResponse res,
                       RedisStorage redis, ServerRegistry serverRegistry) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    auto payload = readJsonBody(req);
    const nick = jsonStr(payload, "nick");
    if (!nsValidNick(res, nick)) return;
    if (!jsonTrue(payload, "confirm")) {
        jsonError(res, 400, "Confirmation required.");
        return;
    }

    auto r = anopeOperCommand(s, "DROP " ~ nick);
    if (!nsReplyOk(res, s, nick, r)) return;
    if (!r.text.toLower().canFind("has been dropped")) {
        jsonError(res, 502, r.text.length ? r.text : "NickServ did not confirm the drop.");
        return;
    }

    string username;
    bool reprovisioning;
    try reprovisioning = syncDroppedAccount(nick, redis, username);
    catch (Exception e) {
        // The account is already gone from services; report the failure to
        // clean up rather than pretend the drop did not happen.
        logWarn("nickserv: dropped %s but the platform cleanup failed: %s", nick, e.msg);
    }

    logWarn("Admin dropped NickServ account %s (platform user: %s)",
            nick, username.length ? username : "none");
    auto data = Json.emptyObject;
    data["nick"] = nick;
    data["dropped"] = true;
    data["reprovisioning"] = reprovisioning;
    jsonOk(res, data);
}

/// POST /api/admin/ircd/nickserv/password  body {nick, confirm}
/// Generates the password, sets it with `SASET`, and **proves** it works via
/// `checkAuthentication` before showing it — Anope's `SASET` reply is not
/// evidence that SASL will accept the credential.
package void apiNsResetPassword(HTTPServerRequest req, HTTPServerResponse res,
                                RedisStorage redis, ServerRegistry serverRegistry) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    auto payload = readJsonBody(req);
    const nick = jsonStr(payload, "nick");
    if (!nsValidNick(res, nick)) return;
    if (!jsonTrue(payload, "confirm")) {
        jsonError(res, 400, "Confirmation required.");
        return;
    }

    string pw;
    try pw = generateServicesPassword();
    catch (Exception e) {
        logWarn("nickserv: password generation failed: %s", e.msg);
        jsonError(res, 500, "Could not generate a password.");
        return;
    }

    auto r = anopeOperCommand(s, nickServSetPasswordCommand(nick, pw));
    if (!nsReplyOk(res, s, nick, r)) return;

    bool determined;
    if (!anopeCheckAuthentication(s, nick, pw, determined)) {
        if (!determined) {
            jsonError(res, 502, "Could not verify the new password (Anope unreachable).");
            return;
        }
        jsonError(res, 502, "Anope accepted no new password for \"" ~ nick ~ "\".");
        return;
    }

    string username;
    bool synced;
    NetworkConfig cfg;
    User owner;
    if (findPlatformAccount(nick, cfg, owner)) {
        username = owner.username;
        try {
            // Exactly the path signup uses, so the engine reconnects with the
            // new credential instead of retrying the old one.
            persistProvisionedAccount(owner, cfg, nick, pw,
                                      new NetworkRepository(), redis, serverRegistry);
            synced = true;
        } catch (Exception e) {
            logWarn("nickserv: reset the password for %s but persisting it failed: %s",
                    nick, e.msg);
        }
    }

    logInfo("Admin reset the NickServ password for %s (platform user: %s)",
            nick, username.length ? username : "none");
    auto data = Json.emptyObject;
    data["nick"] = nick;
    data["password"] = pw;
    data["platformSynced"] = synced;
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// Link / unlink a website user to a NickServ account
// ---------------------------------------------------------------------------
//
// The join the inventory renders is derived, not stored: a row is "linked"
// because some irc.ircfiber.com network carries that account as its
// `saslUsername`. So linking is not a bookkeeping entry — it means giving the
// user's network a credential that actually authenticates, which is why both
// paths below refuse to persist anything they have not proven with
// `checkAuthentication` first.

/// Make the engine re-read a network's credential.
///
/// `persistProvisionedAccount` does this for a credential being SET; clearing
/// one needs the same push, or the live session keeps authenticating with the
/// credential we just removed until something else happens to reconnect it.
private void pushReconnect(NetworkConfig cfg, string userId, RedisStorage redis,
                           ServerRegistry serverRegistry) {
    import std.datetime : Clock;

    string serverId;
    try {
        serverId = serverRegistry.getServerForNetwork(cfg.id.toString());
        if (!serverId.length) serverId = serverRegistry.assignNetwork(cfg.id.toString());
    } catch (Exception e) {
        logWarn("nickserv: server lookup for %s failed: %s", cfg.id.toString(), e.msg);
    }
    if (!serverId.length) {
        logWarn("nickserv: no healthy engine to reconnect network %s — it will pick the " ~
                "credential up on its next bootstrap", cfg.id.toString());
        return;
    }
    try {
        auto msg = ControlMessage("reconnectNetwork", cfg.id.toString(), userId, cfg.toJson());
        msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
        redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
    } catch (Exception e) {
        logWarn("nickserv: failed to push reconnectNetwork for %s: %s", cfg.id.toString(), e.msg);
    }
}

/// Strip the SASL credential from `cfg` and make the engine drop it.
///
/// A non-empty `skipReason` also parks auto-provisioning for 24h via the
/// existing skip marker. Without that, the very next login would see a
/// network with no credential, register a brand-new NickServ account and
/// silently re-link the user — which makes an admin's unlink look broken.
/// The marker is the same 24h one the provisioner uses, so it expires on its
/// own and shows up in this page's `skipMarkers` count.
private void clearCredential(User owner, NetworkConfig cfg, RedisStorage redis,
                             ServerRegistry serverRegistry, string skipReason) {
    const userId = owner.id.toString();
    auto db = redis.getDb();

    // Linking sets nick/realName to the account name, so clearing must undo
    // that too. Leaving the nick pointing at an account the user no longer
    // holds means their session reconnects trying to use somebody else's
    // nickname and gets guest-nicked by services (observed in the scratch
    // smoke: an unlinked user kept `nick: nslink1` after the account moved).
    const removed = cfg.saslUsername.strip();
    cfg.sasl = SASLMechanism.none;
    cfg.saslUsername = "";
    cfg.saslPassword = "";
    if (removed.length && sicmp(cfg.nick.strip(), removed) == 0) {
        const own = buildDefaultNick(owner);
        if (own.length) {
            cfg.nick = own;
            cfg.realName = own;
        }
    }
    new NetworkRepository().save(cfg, owner.id);
    redis.del(RedisKeys.userNetworks(userId));
    try db.del(servicesPendingKey(userId));
    catch (Exception e) logWarn("nickserv: clearing pending key for %s failed: %s", userId, e.msg);
    if (skipReason.length) {
        try db.request!string("SET", servicesSkipKey(userId), skipReason, "EX", "86400");
        catch (Exception e) logWarn("nickserv: setting skip key for %s failed: %s", userId, e.msg);
    } else {
        try db.del(servicesSkipKey(userId));
        catch (Exception e) logWarn("nickserv: clearing skip key for %s failed: %s", userId, e.msg);
    }
    pushReconnect(cfg, userId, redis, serverRegistry);
}

/// The user's `irc.ircfiber.com` network, created if they somehow lack one.
/// `ensureDefaultFiberNetwork` is the same idempotent helper signup and login
/// use, so linking works for an account that predates the feature.
private bool fiberNetworkFor(User owner, RedisStorage redis, ServerRegistry serverRegistry,
                             out NetworkConfig cfg) {
    cfg = NetworkConfig.init;
    auto repo = new NetworkRepository();
    foreach (ref c; repo.findByUserId(owner.id)) {
        if (c.host == DEFAULT_FIBER_HOST) {
            cfg = c;
            return true;
        }
    }
    cfg = ensureDefaultFiberNetwork(owner, repo, redis, serverRegistry);
    return cfg.id != UUID.init;
}

/// Resolve the `userId` field of a request body to a real user.
private bool bodyUser(HTTPServerResponse res, Json payload, out User owner) {
    owner = User.init;
    const userId = jsonStr(payload, "userId");
    if (!userId.length) {
        jsonError(res, 400, "A userId is required.");
        return false;
    }
    UUID uid;
    // `.idup`: vibe.d's parseUUID aliases (and can blank) the source slice.
    try uid = parseUUID(userId.idup);
    catch (Exception) {
        jsonError(res, 400, "That userId is not a UUID.");
        return false;
    }
    try owner = new UserRepository().findById(uid);
    catch (Exception e) {
        logWarn("nickserv: user lookup for %s failed: %s", userId, e.msg);
        jsonError(res, 502, "Could not read the user record.");
        return false;
    }
    if (owner.id == UUID.init) {
        jsonError(res, 404, "No user with that id.");
        return false;
    }
    return true;
}

/**
 * POST /api/admin/ircd/nickserv/link
 * body {nick, userId, password?, confirm?, force?}
 *
 * Two credential modes, because an admin links for two different reasons:
 *   - `password` supplied — the user already knows their NickServ password and
 *     it must not change. The password is only verified, never written.
 *   - no `password` — the credential is unknown (the usual case for an account
 *     registered on IRC long ago), so one is generated, set with SASET and
 *     returned once. That rotates the account's password, hence `confirm`.
 */
package void apiNsLink(HTTPServerRequest req, HTTPServerResponse res,
                       RedisStorage redis, ServerRegistry serverRegistry) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    auto payload = readJsonBody(req);
    const nick = jsonStr(payload, "nick");
    if (!nsValidNick(res, nick)) return;
    User owner;
    if (!bodyUser(res, payload, owner)) return;

    // Refuse to "link" a nickname nobody owns: the credential could never
    // authenticate, and the supplied-password path would otherwise report the
    // password as wrong rather than the account as missing.
    auto info = anopeOperQuery(s, "INFO " ~ nick);
    if (!nsReplyOk(res, s, nick, info)) return;
    if (!parseNickInfo(info.rawText.length ? info.rawText : info.text).registered) {
        jsonError(res, 404, "No NickServ account named \"" ~ nick ~ "\".");
        return;
    }

    // One account, one network. Two networks authenticating as the same
    // account fight over the nick on IRC and one of them loses its session.
    string replacedUser;
    NetworkConfig otherCfg;
    User otherOwner;
    if (findPlatformAccount(nick, otherCfg, otherOwner) && otherOwner.id != owner.id) {
        if (!jsonTrue(payload, "force")) {
            jsonError(res, 409, "\"" ~ nick ~ "\" is already linked to " ~ otherOwner.username
                ~ ". Unlink that user first, or pass force to move the account.");
            return;
        }
        replacedUser = otherOwner.username;
    }

    const supplied = jsonStr(payload, "password");
    string pw = supplied;
    const rotate = supplied.length == 0;
    if (rotate) {
        if (!jsonTrue(payload, "confirm")) {
            jsonError(res, 400, "Confirmation required: linking without a password rotates " ~
                      "the account's password.");
            return;
        }
        try pw = generateServicesPassword();
        catch (Exception e) {
            logWarn("nickserv: password generation failed: %s", e.msg);
            jsonError(res, 500, "Could not generate a password.");
            return;
        }
        auto set = anopeOperCommand(s, nickServSetPasswordCommand(nick, pw));
        if (!nsReplyOk(res, s, nick, set)) return;
    } else if (!isSafeServicesArg(pw)) {
        jsonError(res, 400, "That password cannot be used (whitespace or control characters).");
        return;
    }

    // Never persist a credential we have not proven: this is the check that
    // caught SASET's reversed parameter order, where Anope answered 200 and
    // changed nothing.
    bool determined;
    if (!anopeCheckAuthentication(s, nick, pw, determined)) {
        if (!determined) {
            jsonError(res, 502, "Could not verify the credential (Anope unreachable).");
            return;
        }
        jsonError(res, rotate ? 502 : 400,
                  rotate ? "Anope accepted no new password for \"" ~ nick ~ "\"."
                         : "That password does not authenticate for \"" ~ nick ~ "\".");
        return;
    }

    NetworkConfig cfg;
    if (!fiberNetworkFor(owner, redis, serverRegistry, cfg)) {
        jsonError(res, 409, owner.username ~ " has no " ~ DEFAULT_FIBER_HOST ~ " network and " ~
                  "one could not be created (the Fiber network may be disabled in config).");
        return;
    }
    const previousAccount = cfg.saslUsername.strip();

    // Move the account off the previous owner first, so there is never a
    // moment where two networks hold the same credential.
    if (replacedUser.length) {
        try clearCredential(otherOwner, otherCfg, redis, serverRegistry,
                            "NickServ account " ~ nick ~ " was reassigned by an administrator");
        catch (Exception e) {
            logWarn("nickserv: could not unlink %s from %s: %s", nick, replacedUser, e.msg);
            jsonError(res, 502, "Could not unlink " ~ replacedUser ~ " first; nothing was changed.");
            return;
        }
    }

    try {
        // The signup path, so the engine reconnects and identifies instead of
        // retrying whatever it held before.
        persistProvisionedAccount(owner, cfg, nick, pw,
                                  new NetworkRepository(), redis, serverRegistry);
    } catch (Exception e) {
        logWarn("nickserv: linking %s to %s failed: %s", nick, owner.username, e.msg);
        jsonError(res, 502, "Could not persist the credential: " ~ e.msg);
        return;
    }
    // The link is deliberate, so auto-provisioning must neither be parked nor
    // hold a stale half-finished credential for this user.
    auto db = redis.getDb();
    try db.del(servicesSkipKey(owner.id.toString()));
    catch (Exception) {}
    try db.del(servicesPendingKey(owner.id.toString()));
    catch (Exception) {}

    logInfo("Admin linked NickServ account %s to user %s (rotated: %s, previous account: %s, " ~
            "taken from: %s)", nick, owner.username, rotate,
            previousAccount.length ? previousAccount : "none",
            replacedUser.length ? replacedUser : "none");

    auto data = Json.emptyObject;
    data["nick"] = nick;
    data["userId"] = owner.id.toString();
    data["username"] = owner.username;
    data["networkId"] = cfg.id.toString();
    data["passwordRotated"] = rotate;
    // Shown once, and only when we generated it — never echo one the admin
    // supplied back into a response body.
    if (rotate) data["password"] = pw;
    data["previousAccount"] = previousAccount;
    data["takenFrom"] = replacedUser;
    jsonOk(res, data);
}

/**
 * POST /api/admin/ircd/nickserv/unlink
 * body {nick?, userId?, confirm}
 *
 * Clears the credential without touching the NickServ account itself — that
 * is what `drop` is for. Deliberately does NOT require Anope to be reachable:
 * an unreachable services host is exactly when an admin needs to stop a
 * session from retrying a credential.
 */
package void apiNsUnlink(HTTPServerRequest req, HTTPServerResponse res,
                         RedisStorage redis, ServerRegistry serverRegistry) {
    auto payload = readJsonBody(req);
    if (!jsonTrue(payload, "confirm")) {
        jsonError(res, 400, "Confirmation required.");
        return;
    }
    const nick = jsonStr(payload, "nick");
    const userId = jsonStr(payload, "userId");

    NetworkConfig cfg;
    User owner;
    if (nick.length) {
        if (!nsValidNick(res, nick)) return;
        if (!findPlatformAccount(nick, cfg, owner)) {
            jsonError(res, 404, "\"" ~ nick ~ "\" is not linked to any IRC Fiber user.");
            return;
        }
    } else if (userId.length) {
        if (!bodyUser(res, payload, owner)) return;
        bool found;
        try {
            foreach (ref c; new NetworkRepository().findByUserId(owner.id)) {
                if (c.host == DEFAULT_FIBER_HOST && c.saslUsername.strip().length) {
                    cfg = c;
                    found = true;
                    break;
                }
            }
        } catch (Exception e) {
            logWarn("nickserv: network lookup for %s failed: %s", owner.username, e.msg);
            jsonError(res, 502, "Could not read the user's networks.");
            return;
        }
        if (!found) {
            jsonError(res, 404, owner.username ~ " holds no NickServ credential.");
            return;
        }
    } else {
        jsonError(res, 400, "A nick or a userId is required.");
        return;
    }

    const account = cfg.saslUsername.strip();
    try clearCredential(owner, cfg, redis, serverRegistry,
                        "unlinked from NickServ account " ~ account ~ " by an administrator");
    catch (Exception e) {
        logWarn("nickserv: unlinking %s from %s failed: %s", account, owner.username, e.msg);
        jsonError(res, 502, "Could not clear the credential: " ~ e.msg);
        return;
    }

    logWarn("Admin unlinked NickServ account %s from user %s", account, owner.username);
    auto data = Json.emptyObject;
    data["nick"] = account;
    data["userId"] = owner.id.toString();
    data["username"] = owner.username;
    data["networkId"] = cfg.id.toString();
    data["unlinked"] = true;
    // Auto-provisioning is parked for 24h so the next login does not silently
    // mint a replacement account and re-link the user.
    data["autoProvisionParkedHours"] = 24;
    jsonOk(res, data);
}
