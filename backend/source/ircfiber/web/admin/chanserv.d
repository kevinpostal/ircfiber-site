module ircfiber.web.admin.chanserv;

///
/// ChanServ channel management for the admin dashboard (IRCD page → ChanServ).
///
/// Two data paths, deliberately different, exactly as the NickServ section:
///   * the **inventory** (`/channels`) reads Anope's `db_flatfile` directly
///     (`ircfiber.services.anope_db`), because Anope 2.0 exposes no
///     enumeration RPC and `ChanServ LIST` is capped by `chanserv.conf`'s
///     `listmax` (50 here). It is up to `updatetimeout` (5m) stale and says so;
///   * every **per-channel** view and action goes over XML-RPC as the
///     services-oper account (`IRCFIBER_ANOPE_OPER_ACCOUNT`), so it is live
///     and authoritative.
///
/// `m_xmlrpc_main` builds a `CommandSource` with a null `User`, so
/// `require_oper` never applies and these commands run with the oper account
/// offline. An account that is not tied to an opertype yet answers
/// `Access denied.` with HTTP 200 — `anopeAccessDenied` detects that and it
/// is reported as 403 with the remediation.
///
/// Trap worth stating once: `cs_drop` requires the channel name **twice**
/// for every caller including Services Root. `DROP #x` answers with the
/// confirmation prompt and HTTP 200, dropping nothing — a silent no-op. The
/// command sent below is therefore `DROP #x #x`.
///
/// Second trap, same shape: `cs_set` takes the **option before the channel**
/// (`SET FOUNDER #x acct`, verified against 2.0.20). The reverse order answers
/// `Syntax: SET option channel parameters` with HTTP 200 and changes nothing,
/// exactly like `SASET` on the NickServ side.
///
/// Scope: suspend, unsuspend, drop, register, founder transfer and XOP access
/// add/remove. `AKICK`, `LEVELS`, mode lock, topic and the remaining `SET`
/// options are not exposed.
///

import std.algorithm : canFind;
import std.string : strip, toLower, toUpper;

import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.services.accounts : isValidIrcChannel;
import ircfiber.services.anope : AnopeReply, AnopeSettings, anopeChanServCommand,
    anopeChanServQuery, chanServSetFounderCommand, flattenReplyText, isSafeServicesArg,
    parseChanAccessList, parseChanInfo;
import ircfiber.services.anope_db : AnopeChannel, asciiLowerStr, readAnopeChannelInventory;
import ircfiber.web.admin.helpers : jsonError, jsonOk, readJsonBody;
import ircfiber.web.admin.services_common : anopeReplyOk, anopeTransportOk,
    hasControlChars, isValidExpiry, jsonStr, jsonTrue, loadPlatformRows, PlatformRow,
    servicesSettings;

// ---------------------------------------------------------------------------
// Argument guards / failure mapping
// ---------------------------------------------------------------------------

/// Both gates: the ircd's own channel rule and the injection guard, because
/// services commands are space-delimited.
private bool csValidChannel(HTTPServerResponse res, string chan) {
    if (!isValidIrcChannel(chan) || !isSafeServicesArg(chan)) {
        jsonError(res, 400, "Not a valid channel name.");
        return false;
    }
    return true;
}

/// A single-token services argument (account name, access mask, XOP tier).
private bool csValidToken(HTTPServerResponse res, string v, string what) {
    if (!v.length || !isSafeServicesArg(v)) {
        jsonError(res, 400, what);
        return false;
    }
    return true;
}

private bool csReplyOk(HTTPServerResponse res, const AnopeSettings s, string chan,
                       const AnopeReply r) {
    return anopeReplyOk(res, s, r, "No registered channel named \"" ~ chan ~ "\".");
}

/// Anope's own refusal, flattened, for the 4xx/502 bodies that must show it.
private string csReply(const AnopeReply r) { return flattenReplyText(r.text); }

/// A free-text tail (`reason`, `description`). Never checked with
/// `isSafeServicesArg`, which rejects the spaces a multi-word reason needs;
/// Anope rejoins tokens past a command's `max_params`, which is what makes
/// the tail work at all. `reasonmax = 200` in our `chanserv` block.
private bool csValidText(HTTPServerResponse res, string v, bool required, string what) {
    if (!v.length) {
        if (!required) return true;
        jsonError(res, 400, what);
        return false;
    }
    if (v.length > 200) {
        jsonError(res, 400, "That text is too long (200 characters max).");
        return false;
    }
    if (hasControlChars(v)) {
        jsonError(res, 400, "That text contains control characters.");
        return false;
    }
    return true;
}

private enum string[5] XOP_TIERS = ["QOP", "SOP", "AOP", "HOP", "VOP"];

// ---------------------------------------------------------------------------
// GET /api/admin/ircd/chanserv/channels
// ---------------------------------------------------------------------------

/// The registered-channel inventory, joined to the website user whose
/// `saslUsername` matches the channel's founder.
///
/// Like `apiNsAccounts` this endpoint never errors, it degrades: when the
/// flatfile is unavailable the list is empty with `available:false` and a
/// `reason`. There is no Mongo-side fallback — nothing in Mongo references a
/// channel — so an empty degraded list is correct by construction.
package void apiCsChannels(HTTPServerRequest, HTTPServerResponse res) {
    auto inv = readAnopeChannelInventory();
    auto platform = loadPlatformRows();
    long suspendedCount = 0;

    auto arr = Json.emptyArray;
    foreach (ref c; inv.channels) {
        auto j = Json.emptyObject;
        j["name"] = c.name;
        j["founder"] = c.founder;
        j["successor"] = c.successor;
        j["description"] = c.description;
        j["registeredAt"] = c.registeredAt;
        j["lastUsedAt"] = c.lastUsedAt;
        j["lastTopic"] = c.lastTopic;
        j["lastTopicSetter"] = c.lastTopicSetter;
        j["lastTopicAt"] = c.lastTopicAt;
        j["bot"] = c.bot;
        j["accessCount"] = c.accessCount;
        j["noExpire"] = c.noExpire;
        j["isPrivate"] = c.isPrivate;
        j["persistent"] = c.persistent;
        j["suspended"] = c.suspended;
        j["suspendedBy"] = c.suspendedBy;
        j["suspendReason"] = c.suspendReason;
        j["suspendedAt"] = c.suspendedAt;
        j["suspendExpiresAt"] = c.suspendExpiresAt;

        // The founder is a NickCore display, and `loadPlatformRows` is keyed
        // by lower(saslUsername), so the lookup is direct.
        auto p = c.founder.length ? (asciiLowerStr(c.founder) in platform) : null;
        j["founderUserId"] = p ? p.userId : "";
        j["founderUsername"] = p ? p.username : "";
        j["founderNetworkId"] = p ? p.networkId : "";

        if (c.suspended) suspendedCount++;
        arr ~= j;
    }

    auto data = Json.emptyObject;
    data["available"] = inv.available;
    data["reason"] = inv.reason;
    data["asOf"] = inv.fileMtime;
    data["channels"] = arr;
    data["suspendedCount"] = suspendedCount;
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// GET /api/admin/ircd/chanserv/channel?channel=
// ---------------------------------------------------------------------------

/// Live `ChanServ INFO` plus `ACCESS … LIST`. An unregistered channel answers
/// 200 with `registered:false` rather than 404, so the UI can say the channel
/// is free — which is why this handler uses `anopeTransportOk`, not
/// `csReplyOk`.
///
/// A refused or unreachable access list does not fail the request: the INFO is
/// still useful, so it comes back 200 with `accessError` set.
package void apiCsChannel(HTTPServerRequest req, HTTPServerResponse res) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    const chan = req.query.get("channel", "").strip();
    if (!csValidChannel(res, chan)) return;

    auto r = anopeChanServQuery(s, "INFO " ~ chan);
    if (!anopeTransportOk(res, s, r)) return;

    auto info = parseChanInfo(r.rawText.length ? r.rawText : r.text);
    auto data = Json.emptyObject;
    data["channel"] = chan;
    data["registered"] = info.registered;
    data["founder"] = info.founder;
    data["successor"] = info.successor;
    data["description"] = info.description;
    data["suspended"] = info.suspended;
    auto fields = Json.emptyObject;
    foreach (k, v; info.fields) fields[k] = v;
    data["fields"] = fields;
    auto lines = Json.emptyArray;
    foreach (line; info.lines) lines ~= Json(line);
    data["lines"] = lines;

    auto access = Json.emptyArray;
    string accessError;
    if (info.registered) {
        auto ra = anopeChanServQuery(s, "ACCESS " ~ chan ~ " LIST");
        if (!ra.transportOk) {
            accessError = "Access list unavailable: " ~ ra.transportError;
        } else {
            const flat = flattenReplyText(ra.text);
            const low = flat.toLower();
            if (low.canFind("access denied")) {
                accessError = "ChanServ refused the access list: " ~ flat;
            } else {
                foreach (ref e; parseChanAccessList(ra.rawText.length ? ra.rawText : ra.text)) {
                    auto j = Json.emptyObject;
                    j["number"] = e.number;
                    j["level"] = e.level;
                    j["mask"] = e.mask;
                    access ~= j;
                }
            }
        }
    }
    data["access"] = access;
    data["accessError"] = accessError;

    auto platform = loadPlatformRows();
    auto p = info.founder.length ? (asciiLowerStr(info.founder) in platform) : null;
    if (p !is null && p.userId.length) {
        auto pj = Json.emptyObject;
        pj["userId"] = p.userId;
        pj["username"] = p.username;
        pj["networkId"] = p.networkId;
        data["platform"] = pj;
    } else {
        data["platform"] = Json(null);
    }
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// Suspend / unsuspend
// ---------------------------------------------------------------------------

/// POST /api/admin/ircd/chanserv/suspend  body {channel, reason, expiry?}
/// A suspended channel is unregistered from the users' point of view: nobody
/// can identify to it and Anope keeps them out.
package void apiCsSuspend(HTTPServerRequest req, HTTPServerResponse res) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    auto payload = readJsonBody(req);
    const chan = jsonStr(payload, "channel");
    if (!csValidChannel(res, chan)) return;
    const reason = jsonStr(payload, "reason");
    if (!reason.length) { jsonError(res, 400, "A reason is required."); return; }
    if (reason.length > 200) {
        jsonError(res, 400, "That reason is too long (200 characters max).");
        return;
    }
    if (hasControlChars(reason)) {
        jsonError(res, 400, "That reason contains control characters.");
        return;
    }
    const expiry = jsonStr(payload, "expiry");
    if (expiry.length && !isValidExpiry(expiry)) {
        jsonError(res, 400, "Expiry must look like 30d.");
        return;
    }

    auto r = anopeChanServCommand(s, "SUSPEND " ~ chan
        ~ (expiry.length ? " +" ~ expiry : "") ~ " " ~ reason);
    if (!csReplyOk(res, s, chan, r)) return;

    const t = r.text.toLower();
    if (t.canFind("is already suspended")) { jsonError(res, 409, csReply(r)); return; }
    if (!t.canFind("is now suspended")) {
        jsonError(res, 502, "ChanServ did not confirm the suspension: " ~ csReply(r));
        return;
    }

    logInfo("Admin suspended channel %s (reason: %s)", chan, reason);
    auto data = Json.emptyObject;
    data["channel"] = chan;
    data["suspended"] = true;
    data["reply"] = csReply(r);
    jsonOk(res, data);
}

/// POST /api/admin/ircd/chanserv/unsuspend  body {channel}
package void apiCsUnsuspend(HTTPServerRequest req, HTTPServerResponse res) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    const chan = jsonStr(readJsonBody(req), "channel");
    if (!csValidChannel(res, chan)) return;

    auto r = anopeChanServCommand(s, "UNSUSPEND " ~ chan);
    if (!csReplyOk(res, s, chan, r)) return;

    const t = r.text.toLower();
    if (t.canFind("isn't suspended") || t.canFind("is not suspended")) {
        jsonError(res, 409, csReply(r));
        return;
    }
    if (!t.canFind("is now released")) {
        jsonError(res, 502, "ChanServ did not confirm the release: " ~ csReply(r));
        return;
    }

    logInfo("Admin unsuspended channel %s", chan);
    auto data = Json.emptyObject;
    data["channel"] = chan;
    data["suspended"] = false;
    data["reply"] = csReply(r);
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// Drop
// ---------------------------------------------------------------------------

/// POST /api/admin/ircd/chanserv/drop  body {channel, confirm}
///
/// The channel name is sent twice: `cs_drop` treats a single name as a
/// confirmation request and answers HTTP 200 without dropping anything.
/// Unlike `apiNsDrop` there is nothing to clean up afterwards — no Mongo
/// document or Redis key references a channel registration.
package void apiCsDrop(HTTPServerRequest req, HTTPServerResponse res) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    auto payload = readJsonBody(req);
    const chan = jsonStr(payload, "channel");
    if (!csValidChannel(res, chan)) return;
    if (!jsonTrue(payload, "confirm")) {
        jsonError(res, 400, "Confirmation required.");
        return;
    }

    auto r = anopeChanServCommand(s, "DROP " ~ chan ~ " " ~ chan);
    if (!csReplyOk(res, s, chan, r)) return;
    if (!r.text.toLower().canFind("has been dropped")) {
        jsonError(res, 502, "ChanServ did not confirm the drop: " ~ csReply(r));
        return;
    }

    logWarn("Admin dropped channel registration %s", chan);
    auto data = Json.emptyObject;
    data["channel"] = chan;
    data["dropped"] = true;
    data["reply"] = csReply(r);
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

/// POST /api/admin/ircd/chanserv/register  body {channel, description?, founder?}
///
/// `REGISTER` always founds the channel on the *calling* account, which here
/// is the services oper, so a requested founder is applied with a following
/// `SET FOUNDER`. If that second command fails the response is still 200 with
/// `founderSet:false` and `founderError`: the channel is registered, and
/// reporting a failure would send the admin looking for a channel that exists.
/// No rollback — dropping a freshly registered channel on a transfer failure
/// would be a worse outcome than an admin retrying the transfer.
package void apiCsRegister(HTTPServerRequest req, HTTPServerResponse res) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    auto payload = readJsonBody(req);
    const chan = jsonStr(payload, "channel");
    if (!csValidChannel(res, chan)) return;
    const description = jsonStr(payload, "description");
    if (!csValidText(res, description, false, "")) return;
    const founder = jsonStr(payload, "founder");
    if (founder.length && !csValidToken(res, founder, "Not a valid founder account.")) return;

    auto r = anopeChanServCommand(s, "REGISTER " ~ chan
        ~ (description.length ? " " ~ description : ""));
    if (!anopeTransportOk(res, s, r)) return;

    const t = r.text.toLower();
    if (t.canFind("is already registered")) { jsonError(res, 409, csReply(r)); return; }
    if (t.canFind("temporarily disabled")) { jsonError(res, 503, csReply(r)); return; }
    if (!t.canFind("registered under")) {
        jsonError(res, 502, "ChanServ did not confirm the registration: " ~ csReply(r));
        return;
    }

    bool founderSet = true;
    string founderError;
    string finalFounder = s.operAccount;
    if (founder.length && founder.toLower() != s.operAccount.toLower()) {
        auto r2 = anopeChanServCommand(s, chanServSetFounderCommand(chan, founder));
        if (!r2.transportOk || !r2.text.toLower().canFind("changed to")) {
            founderSet = false;
            founderError = r2.transportOk
                ? csReply(r2)
                : "Anope unreachable: " ~ r2.transportError;
        } else {
            finalFounder = founder;
        }
    }

    logInfo("Admin registered channel %s (founder: %s)", chan, finalFounder);
    auto data = Json.emptyObject;
    data["channel"] = chan;
    data["registered"] = true;
    data["founder"] = founderSet ? finalFounder : founder;
    data["founderSet"] = founderSet;
    data["founderError"] = founderError;
    data["reply"] = csReply(r);
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// Founder transfer
// ---------------------------------------------------------------------------

/// POST /api/admin/ircd/chanserv/founder  body {channel, founder, confirm}
///
/// `anopeTransportOk`, not `csReplyOk`: `isn't registered` here can name the
/// channel *or* the target account, and Anope's own wording says which, so it
/// is passed through verbatim.
package void apiCsFounder(HTTPServerRequest req, HTTPServerResponse res) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    auto payload = readJsonBody(req);
    const chan = jsonStr(payload, "channel");
    if (!csValidChannel(res, chan)) return;
    const founder = jsonStr(payload, "founder");
    if (!csValidToken(res, founder, "Not a valid founder account.")) return;
    if (!jsonTrue(payload, "confirm")) {
        jsonError(res, 400, "Confirmation required.");
        return;
    }

    auto r = anopeChanServCommand(s, chanServSetFounderCommand(chan, founder));
    if (!anopeTransportOk(res, s, r)) return;

    const t = r.text.toLower();
    if (t.canFind("isn't registered") || t.canFind("is not registered")) {
        jsonError(res, 404, csReply(r));
        return;
    }
    if (t.canFind("has too many channels registered")) {
        jsonError(res, 409, csReply(r));
        return;
    }
    if (!t.canFind("changed to")) {
        jsonError(res, 502, "ChanServ did not confirm the transfer: " ~ csReply(r));
        return;
    }

    logInfo("Admin transferred founder of %s to %s", chan, founder);
    auto data = Json.emptyObject;
    data["channel"] = chan;
    data["founder"] = founder;
    data["reply"] = csReply(r);
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// Access list
// ---------------------------------------------------------------------------

/// POST /api/admin/ircd/chanserv/access  body {channel, tier, entry}
///
/// `entry` may be an account name or a hostmask: our `chanserv` block sets
/// `disallow_hostmask_access = no`.
package void apiCsAccessAdd(HTTPServerRequest req, HTTPServerResponse res) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    auto payload = readJsonBody(req);
    const chan = jsonStr(payload, "channel");
    if (!csValidChannel(res, chan)) return;
    const tier = jsonStr(payload, "tier").toUpper();
    if (!XOP_TIERS[].canFind(tier)) {
        jsonError(res, 400, "Access level must be one of QOP, SOP, AOP, HOP, VOP.");
        return;
    }
    const entry = jsonStr(payload, "entry");
    if (!csValidToken(res, entry, "Not a valid account or mask.")) return;

    auto r = anopeChanServCommand(s, tier ~ " " ~ chan ~ " ADD " ~ entry);
    if (!anopeTransportOk(res, s, r)) return;

    const t = r.text.toLower();
    if (t.canFind("may not be on access lists")) { jsonError(res, 400, csReply(r)); return; }
    if (t.canFind("you can only have")) { jsonError(res, 409, csReply(r)); return; }
    if (t.canFind("isn't registered") || t.canFind("is not registered")) {
        jsonError(res, 404, csReply(r));
        return;
    }
    if (!t.canFind("added to")) {
        jsonError(res, 502, "ChanServ did not confirm the access change: " ~ csReply(r));
        return;
    }

    logInfo("Admin added %s to %s %s list", entry, chan, tier);
    auto data = Json.emptyObject;
    data["channel"] = chan;
    data["tier"] = tier;
    data["entry"] = entry;
    data["reply"] = csReply(r);
    jsonOk(res, data);
}

/// POST /api/admin/ircd/chanserv/access/delete  body {channel, entry}
///
/// `entry` is the `mask` column of a row from `apiCsChannel`: `ACCESS … DEL`
/// matches by mask and removes XOP-provider entries too.
package void apiCsAccessDelete(HTTPServerRequest req, HTTPServerResponse res) {
    AnopeSettings s;
    if (!servicesSettings(res, s)) return;
    auto payload = readJsonBody(req);
    const chan = jsonStr(payload, "channel");
    if (!csValidChannel(res, chan)) return;
    const entry = jsonStr(payload, "entry");
    if (!csValidToken(res, entry, "Not a valid account or mask.")) return;

    auto r = anopeChanServCommand(s, "ACCESS " ~ chan ~ " DEL " ~ entry);
    if (!csReplyOk(res, s, chan, r)) return;

    const t = r.text.toLower();
    if (t.canFind("not found on")) { jsonError(res, 404, csReply(r)); return; }
    if (!t.canFind("deleted from")) {
        jsonError(res, 502, "ChanServ did not confirm the removal: " ~ csReply(r));
        return;
    }

    logInfo("Admin removed %s from the %s access list", entry, chan);
    auto data = Json.emptyObject;
    data["channel"] = chan;
    data["entry"] = entry;
    data["reply"] = csReply(r);
    jsonOk(res, data);
}
