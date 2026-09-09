module ircfiber.web.admin.invites;

///
/// Invite + provisioned-account management for the admin dashboard
/// (IRCD page → Invites tab).
///
/// Two lists, both read-only except revoke:
///   * **pending invites** (`/invites`) — `signup:invite:*` keys in Redis,
///     minted by `!adduser` for nicks with no NickServ account.
///   * **provisioned accounts** (`/provisioned`) — `users` rows with a
///     non-empty `provisionedFrom` (`nickserv:<account>`), i.e. everything
///     `!adduser` ever created.
///   * **revoke** (`/invites/revoke`) — DELs the token so the link dies.
///     Already-redeemed/expired tokens report `revoked:false`, not an error.
///
/// Token hygiene mirrors `web.admin.emails`: the bearer token never leaves
/// the gateway — rows are keyed by `sha256(token)[0..16]` and revoke
/// re-scans to resolve the id. Listing uses `KEYS` (not `SCAN`) per the
/// `keysMatching` idiom there: the `signup:invite:*` keyspace is tiny
/// (oper-driven, 24h TTL).

import std.digest : toHexString;
import std.digest.sha : sha256Of;
import std.string : strip, toLower;

import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json, parseJsonString;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.db.user : UserRepository;
import ircfiber.invites : InvitePending, inviteKey;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonError, jsonOk, readJsonBody;

private enum invitePrefix = "signup:invite:";

/// Prefix-anchored key sweep, capped — same idiom as
/// `web.admin.emails.keysMatching`.
private string[] keysMatching(RedisStorage redis, string pattern, size_t cap = 500) {
    string[] keys;
    try {
        foreach (k; redis.getDb().keys(pattern)) {
            keys ~= () @trusted { return cast(string) k.idup; }();
            if (keys.length >= cap) break;
        }
    } catch (Exception e) {
        logWarn("invites admin: listing %s failed: %s", pattern, e.msg);
        throw e;
    }
    return keys;
}

/// Row identity for the pending list: the token never leaves the gateway.
private string inviteRowId(string token) {
    return sha256Of(token).toHexString.idup.toLower[0 .. 16];
}

// ---------------------------------------------------------------------------
// GET /api/admin/ircd/invites
// ---------------------------------------------------------------------------

/// Pending `!adduser` invites. `ttlSecs` is -2 when the key vanished between
/// listing and GET (a concurrent redemption) — those rows are skipped, not
/// shown as phantom invites.
package void apiInvitesList(HTTPServerRequest, HTTPServerResponse res, RedisStorage redis) {
    auto arr = Json.emptyArray;
    string[] keys;
    try keys = keysMatching(redis, invitePrefix ~ "*");
    catch (Exception e) {
        jsonError(res, 502, "Could not read the invite list: " ~ e.msg);
        return;
    }
    auto db = redis.getDb();
    foreach (key; keys) {
        if (key.length <= invitePrefix.length) continue;
        if (arr.length >= 200) break;
        string raw;
        try raw = db.get(key);
        catch (Exception e) {
            logWarn("invites admin: GET %s failed: %s", key, e.msg);
            continue;
        }
        if (!raw.length) continue;
        InvitePending p;
        try p = InvitePending.fromJson(parseJsonString(raw));
        catch (Exception) continue;
        long ttl = -2;
        try ttl = db.ttl(key);
        catch (Exception) {}
        auto j = Json.emptyObject;
        j["id"] = Json(inviteRowId(key[invitePrefix.length .. $]));
        j["nick"] = Json(p.nick);
        j["invitedBy"] = Json(p.invitedBy);
        j["createdAt"] = Json(p.createdAt);
        j["ttlSecs"] = Json(ttl);
        arr ~= j;
    }
    auto data = Json.emptyObject;
    data["invites"] = arr;
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// POST /api/admin/ircd/invites/revoke  body {id}
// ---------------------------------------------------------------------------

/// Revokes the invite whose row id matches. Unknown/expired ids report
/// `revoked:false` — revoke is idempotent, not an error when the link is
/// already dead.
package void apiInviteRevoke(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto body = readJsonBody(req);
    string id = "";
    try id = body["id"].get!string;
    catch (Exception) {}
    id = id.strip().toLower();
    if (!id.length || id.length > 16) {
        jsonError(res, 400, "A valid invite id is required.");
        return;
    }
    string[] keys;
    try keys = keysMatching(redis, invitePrefix ~ "*");
    catch (Exception e) {
        jsonError(res, 502, "Could not revoke the invite: " ~ e.msg);
        return;
    }
    bool revoked = false;
    auto db = redis.getDb();
    foreach (key; keys) {
        if (key.length <= invitePrefix.length) continue;
        if (inviteRowId(key[invitePrefix.length .. $]) != id) continue;
        try {
            revoked = db.get(key).length > 0;
            if (revoked) db.del(key);
        } catch (Exception e) {
            logWarn("invites admin: revoke failed: %s", e.msg);
            jsonError(res, 502, "Could not revoke the invite: " ~ e.msg);
            return;
        }
        break;
    }
    if (revoked) logInfo("invites admin: revoked invite id %s", id);
    auto data = Json.emptyObject;
    data["revoked"] = Json(revoked);
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// GET /api/admin/ircd/provisioned
// ---------------------------------------------------------------------------

/// Every site account `!adduser` created (`provisionedFrom` non-empty).
package void apiProvisionedList(HTTPServerRequest, HTTPServerResponse res) {
    auto arr = Json.emptyArray;
    try {
        foreach (ref u; (new UserRepository()).listProvisioned()) {
            auto j = Json.emptyObject;
            j["username"] = Json(u.username);
            j["email"] = Json(u.email);
            j["provisionedFrom"] = Json(u.provisionedFrom);
            j["signupIp"] = Json(u.signupIp);
            j["createdAt"] = Json(u.createdAt.toUnixTime());
            arr ~= j;
        }
    } catch (Exception e) {
        logWarn("invites admin: listing provisioned accounts failed: %s", e.msg);
        jsonError(res, 502, "Could not read the provisioned list: " ~ e.msg);
        return;
    }
    auto data = Json.emptyObject;
    data["users"] = arr;
    jsonOk(res, data);
}
