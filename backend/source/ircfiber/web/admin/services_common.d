module ircfiber.web.admin.services_common;

///
/// Shared prologue for the admin services surfaces (NickServ, ChanServ).
///
/// Every one of these helpers is service-agnostic: the settings gate, the
/// HTTP mapping of Anope's own refusals, the JSON body accessors, the
/// argument guards and the website-account join. They live here rather than
/// in `ircfiber.web.admin.nickserv` because ChanServ needs them verbatim and
/// importing a nick module from a channel module would be a lie about the
/// dependency.
///
/// The one wording that is *not* shared is "no such subject": NickServ says
/// "No NickServ account named …", ChanServ "No registered channel named …",
/// so `anopeReplyOk` takes that message from the caller.
///

import std.algorithm : canFind;
import std.string : strip, toLower;
import std.uuid : UUID, parseUUID;

import vibe.core.log : logWarn;
import vibe.data.json : Json;
import vibe.http.server : HTTPServerResponse;

import ircfiber.db.network : NetworkRepository;
import ircfiber.db.user : UserRepository;
import ircfiber.default_network : DEFAULT_FIBER_HOST;
import ircfiber.models.user : User;
import ircfiber.services.anope : AnopeReply, AnopeSettings, anopeAccessDenied,
    loadAnopeSettings;
import ircfiber.web.admin.helpers : jsonError;

// ---------------------------------------------------------------------------
// Shared prologue / failure mapping
// ---------------------------------------------------------------------------

/// Loads settings and rejects early with copy the SPA already special-cases
/// (its `notConfigured()` test matches /not configured/i).
package bool servicesSettings(HTTPServerResponse res, out AnopeSettings s) {
    s = loadAnopeSettings();
    if (!s.configured) {
        jsonError(res, 501, "Anope RPC is not configured (IRCFIBER_ANOPE_RPC_URL).");
        return false;
    }
    if (!s.hasOper) {
        jsonError(res, 501, "Anope oper account is not configured (IRCFIBER_ANOPE_OPER_ACCOUNT).");
        return false;
    }
    return true;
}

/// Remediation copy for a refusal. Spelled out because the cause is always
/// the same and is not fixable in code: the account must exist in NickServ
/// *before* Anope loads its config, which is when `Tied oper` is logged.
package string accessDeniedMessage(const AnopeSettings s) {
    return "Anope refused the command: the services oper account \"" ~ s.operAccount
        ~ "\" has no privileges. Register that NickServ account, then restart"
        ~ " ircfiber-services so Anope logs \"Tied oper\".";
}

/// Transport failure and Anope's privilege refusal, which arrives as HTTP 200.
/// Returns false when it has already written a response.
package bool anopeTransportOk(HTTPServerResponse res, const AnopeSettings s, const AnopeReply r) {
    if (!r.transportOk) {
        jsonError(res, 502, "Anope unreachable: " ~ r.transportError);
        return false;
    }
    if (anopeAccessDenied(r)) {
        jsonError(res, 403, accessDeniedMessage(s));
        return false;
    }
    return true;
}

/// ditto, plus Anope's "isn't registered" refusal as a 404 carrying
/// `notFoundMessage` — the subject's wording differs per service.
package bool anopeReplyOk(HTTPServerResponse res, const AnopeSettings s,
                          const AnopeReply r, string notFoundMessage) {
    if (!anopeTransportOk(res, s, r)) return false;
    if (notRegistered(r.text)) {
        jsonError(res, 404, notFoundMessage);
        return false;
    }
    return true;
}

package bool notRegistered(string text) {
    const t = text.toLower();
    return t.canFind("isn't registered") || t.canFind("is not registered");
}

package string jsonStr(Json payload, string key) {
    if (payload.type != Json.Type.object) return "";
    auto v = payload[key];
    if (v.type != Json.Type.string) return "";
    return v.get!string.strip();
}

package bool jsonTrue(Json payload, string key) {
    if (payload.type != Json.Type.object) return false;
    auto v = payload[key];
    return v.type == Json.Type.bool_ && v.get!bool;
}

/// `30d` / `2w` / `12h` — `ns_suspend`'s `[+expiry]` grammar.
package bool isValidExpiry(string s) @safe pure nothrow @nogc {
    if (s.length < 2) return false;
    foreach (char c; s[0 .. $ - 1])
        if (c < '0' || c > '9') return false;
    const unit = s[$ - 1];
    return unit == 's' || unit == 'm' || unit == 'h'
        || unit == 'd' || unit == 'w' || unit == 'y';
}

/// A control character in the trailing reason would inject a second command.
package bool hasControlChars(string s) @safe pure nothrow @nogc {
    foreach (char c; s)
        if (c < 0x20 || c == 0x7F) return true;
    return false;
}

// ---------------------------------------------------------------------------
// Platform (IRC Fiber) account join
// ---------------------------------------------------------------------------

/// The website side of one NickServ account.
package struct PlatformRow {
    string saslAccount;    /// as stored, so the degraded list keeps its case
    string userId;
    string username;
    string userEmail;
    string networkId;
    string networkNick;
    bool networkDisabled;
}

/// lower(saslUsername) → owner, from one Mongo query plus one lookup per
/// distinct owner (the `usernamesFor` pattern in web.admin.bnc).
package PlatformRow[string] loadPlatformRows() {
    PlatformRow[string] rows;
    try {
        auto networks = new NetworkRepository();
        auto users = new UserRepository();
        User[string] cache;
        foreach (row; networks.listWithSaslAccount(DEFAULT_FIBER_HOST)) {
            const account = row.config.saslUsername.strip();
            if (!account.length) continue;
            const uid = row.userId.toString();
            if (uid !in cache) {
                User u;
                if (row.userId != UUID.init) {
                    // `.idup`: vibe.d's parseUUID aliases (and can blank) the source slice.
                    try u = users.findById(parseUUID(uid.idup));
                    catch (Exception) {}
                }
                cache[uid] = u;
            }
            const owner = cache[uid];
            PlatformRow p;
            p.saslAccount = account;
            p.userId = owner.id == UUID.init ? "" : uid;
            p.username = owner.username;
            p.userEmail = owner.email;
            p.networkId = row.config.id.toString();
            p.networkNick = row.config.nick;
            p.networkDisabled = row.config.disabled;
            rows[account.toLower()] = p;
        }
    } catch (Exception e) {
        logWarn("services: loading the platform account join failed: %s", e.msg);
    }
    return rows;
}
