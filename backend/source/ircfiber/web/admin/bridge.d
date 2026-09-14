module ircfiber.web.admin.bridge;

///
/// Admin surface for the Discord bridge (`BridgeServ` on the Anope 2.1
/// sidecar, `bridge.ircfiber.com`).
///
/// The transport is `ircfiber.services.bridge` (JSON-RPC), NOT the 2.0
/// XML-RPC client the NickServ/ChanServ surfaces use — the bridge is a
/// separate Anope instance. The shape of the handlers is the one those
/// surfaces established: settings gate, validate, one services call, then a
/// status code classified from what services actually said.
///
/// Validation happens before any RPC call because every argument is
/// reassembled space-delimited on the Anope side, and because a malformed
/// Discord id would otherwise come back as an opaque services error.
///

import std.conv : to;
import std.algorithm : canFind;
import std.string : startsWith, strip, toLower;

import vibe.core.log : logInfo;
import vibe.data.json : Json;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.services.bridge : BridgeError, BridgeListing, BridgeSettings,
    bridgeAdd, bridgeDel, bridgeList, bridgeSet, discordChannels, discordGuilds,
    isValidSnowflake, loadBridgeSettings;
import ircfiber.web.admin.helpers : jsonError, jsonOk, queryString, readJsonBody;

// ---------------------------------------------------------------------------
// Shared prologue / failure mapping
// ---------------------------------------------------------------------------

/// Loads settings and rejects early with copy the SPA special-cases (its
/// not-configured test matches /not configured/i). 503, not 501: the
/// surface exists but the sidecar it drives is not deployed here.
private bool bridgeSettings(HTTPServerResponse res, out BridgeSettings s) {
    s = loadBridgeSettings();
    if (!s.configured) {
        jsonError(res, 503, "The Discord bridge is not configured"
            ~ " (IRCFIBER_BRIDGE_RPC_URL, IRCFIBER_BRIDGE_RPC_TOKEN,"
            ~ " IRCFIBER_BRIDGE_RPC_ACCOUNT).");
        return false;
    }
    return true;
}

/// Maps one `BridgeError` onto a status code.
///
/// A transport failure is a 502 with fixed copy — the exception message is a
/// socket error the operator cannot act on. A refusal carries the services
/// reply text, which is the actionable part, and is classified from its
/// wording exactly as the NickServ surface classifies Anope's.
private void bridgeFailed(HTTPServerResponse res, BridgeError e) {
    if (e.isTransport) {
        jsonError(res, 502, "The bridge service is not reachable.");
        return;
    }
    const t = e.msg.toLower();
    if (t.canFind("access denied") || t.canFind("permission")) {
        jsonError(res, 403, "The bridge service refused the command: " ~ e.msg);
        return;
    }
    if (t.canFind("already bridged") || t.canFind("already exists")
        || t.canFind("is already")) {
        jsonError(res, 409, e.msg);
        return;
    }
    jsonError(res, 502, e.msg);
}

// ---------------------------------------------------------------------------
// Argument guards
// ---------------------------------------------------------------------------

private bool validChannel(HTTPServerResponse res, string channel) {
    if (!channel.startsWith("#") || channel.length < 2) {
        jsonError(res, 400, "An IRC channel starting with # is required.");
        return false;
    }
    foreach (char c; channel) {
        if (c <= 0x20 || c == 0x7F || c == ',') {
            jsonError(res, 400, "That is not a usable IRC channel name.");
            return false;
        }
    }
    return true;
}

private bool validSnowflake(HTTPServerResponse res, string id, string what) {
    if (!isValidSnowflake(id)) {
        jsonError(res, 400, "The Discord " ~ what ~ " id must be 1-20 digits.");
        return false;
    }
    return true;
}

/// The suffix is appended to every bridged nickname, so it is short and
/// must survive `IRCDProto::IsNickValid`; whitespace would also split the
/// command into an extra parameter.
private bool validSuffix(HTTPServerResponse res, string suffix) {
    if (suffix.length > 8) {
        jsonError(res, 400, "A nickname suffix may be at most 8 characters.");
        return false;
    }
    foreach (char c; suffix) {
        if (c <= 0x20 || c == 0x7F) {
            jsonError(res, 400, "A nickname suffix may not contain whitespace.");
            return false;
        }
    }
    return true;
}

private string jsonField(Json payload, string key) {
    if (payload.type != Json.Type.object) return "";
    auto v = payload[key];
    if (v.type != Json.Type.string) return "";
    return v.get!string.strip();
}

private Json linesJson(string[] lines) {
    auto arr = Json.emptyArray;
    foreach (l; lines) arr ~= Json(l);
    auto data = Json.emptyObject;
    data["lines"] = arr;
    return data;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/// GET /api/admin/ircd/bridge/bridges
///
/// `connected` is whether `LIST` answered at all, so the panel can tell "no
/// bridges" from "the sidecar is down"; the raw reply lines travel with the
/// rows so an unparsed table is still visible to the operator.
package void apiBridgeList(HTTPServerRequest req, HTTPServerResponse res) {
    BridgeSettings s;
    if (!bridgeSettings(res, s)) return;

    BridgeListing listing;
    try
        listing = bridgeList(s);
    catch (BridgeError e) {
        bridgeFailed(res, e);
        return;
    }

    auto rows = Json.emptyArray;
    foreach (row; listing.rows) {
        auto r = Json.emptyObject;
        r["ircChannel"] = row.ircChannel;
        r["space"] = row.space;
        r["channel"] = row.channel;
        r["suffix"] = row.suffix;
        r["network"] = row.network;
        r["endpoint"] = row.endpoint;
        r["reserved"] = row.reserved;
        rows ~= r;
    }
    auto raw = Json.emptyArray;
    foreach (l; listing.raw) raw ~= Json(l);

    auto data = Json.emptyObject;
    data["bridges"] = rows;
    data["raw"] = raw;
    data["connected"] = true;
    jsonOk(res, data);
}

/// GET /api/admin/ircd/bridge/guilds
///
/// Straight to Discord, not through BridgeServ: `GUILDS` answers
/// asynchronously to the requesting IRC user by UID, so an RPC caller gets
/// an empty reply (verified live). This also keeps the picker working while
/// the sidecar is down.
package void apiBridgeGuilds(HTTPServerRequest req, HTTPServerResponse res) {
    auto s = loadBridgeSettings();
    if (!s.hasDiscordToken) {
        jsonError(res, 503, "The Discord bridge is not configured"
            ~ " (IRCFIBER_DISCORD_BOT_TOKEN).");
        return;
    }

    auto arr = Json.emptyArray;
    try {
        foreach (g; discordGuilds(s)) {
            auto j = Json.emptyObject;
            j["id"] = g.id;
            j["name"] = g.name;
            arr ~= j;
        }
    } catch (BridgeError e) {
        jsonError(res, 502, "Discord is not reachable: " ~ e.msg);
        return;
    }

    auto data = Json.emptyObject;
    data["guilds"] = arr;
    jsonOk(res, data);
}

/// GET /api/admin/ircd/bridge/channels?guild=<id>
package void apiBridgeChannels(HTTPServerRequest req, HTTPServerResponse res) {
    auto s = loadBridgeSettings();
    if (!s.hasDiscordToken) {
        jsonError(res, 503, "The Discord bridge is not configured"
            ~ " (IRCFIBER_DISCORD_BOT_TOKEN).");
        return;
    }
    const guild = queryString(req, "guild");
    if (!validSnowflake(res, guild, "guild")) return;

    auto arr = Json.emptyArray;
    try {
        foreach (c; discordChannels(s, guild)) {
            auto j = Json.emptyObject;
            j["id"] = c.id;
            j["name"] = c.name;
            arr ~= j;
        }
    } catch (BridgeError e) {
        jsonError(res, 502, "Discord is not reachable: " ~ e.msg);
        return;
    }

    auto data = Json.emptyObject;
    data["channels"] = arr;
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// Add / repoint / remove
// ---------------------------------------------------------------------------

/// POST /api/admin/ircd/bridge/add  body {channel, space, foreignChannel, suffix?}
package void apiBridgeAdd(HTTPServerRequest req, HTTPServerResponse res) {
    BridgeSettings s;
    if (!bridgeSettings(res, s)) return;

    auto payload = readJsonBody(req);
    const channel = jsonField(payload, "channel");
    const space = jsonField(payload, "space");
    const foreign = jsonField(payload, "foreignChannel");
    const suffix = jsonField(payload, "suffix");
    if (!validChannel(res, channel)) return;
    if (!validSnowflake(res, space, "guild")) return;
    if (!validSnowflake(res, foreign, "channel")) return;
    if (!validSuffix(res, suffix)) return;

    string[] lines;
    try
        lines = bridgeAdd(s, channel, space, foreign, suffix);
    catch (BridgeError e) {
        bridgeFailed(res, e);
        return;
    }

    logInfo("Admin bridged %s to discord space %s channel %s", channel, space, foreign);
    jsonOk(res, linesJson(lines));
}

/// POST /api/admin/ircd/bridge/set  body {channel, space, foreignChannel, suffix?}
/// Repoints an existing bridge, and sets or (with an empty suffix) clears
/// the nickname suffix of its pseudo clients.
package void apiBridgeSet(HTTPServerRequest req, HTTPServerResponse res) {
    BridgeSettings s;
    if (!bridgeSettings(res, s)) return;

    auto payload = readJsonBody(req);
    const channel = jsonField(payload, "channel");
    const space = jsonField(payload, "space");
    const foreign = jsonField(payload, "foreignChannel");
    const suffix = jsonField(payload, "suffix");
    if (!validChannel(res, channel)) return;
    if (!validSnowflake(res, space, "guild")) return;
    if (!validSnowflake(res, foreign, "channel")) return;
    if (!validSuffix(res, suffix)) return;

    string[] lines;
    try
        lines = bridgeSet(s, channel, space, foreign, suffix);
    catch (BridgeError e) {
        bridgeFailed(res, e);
        return;
    }

    logInfo("Admin repointed the %s bridge to discord space %s channel %s",
        channel, space, foreign);
    jsonOk(res, linesJson(lines));
}

/// POST /api/admin/ircd/bridge/del  body {channel}
package void apiBridgeDel(HTTPServerRequest req, HTTPServerResponse res) {
    BridgeSettings s;
    if (!bridgeSettings(res, s)) return;

    const channel = jsonField(readJsonBody(req), "channel");
    if (!validChannel(res, channel)) return;

    string[] lines;
    try
        lines = bridgeDel(s, channel);
    catch (BridgeError e) {
        bridgeFailed(res, e);
        return;
    }

    logInfo("Admin removed the %s Discord bridge", channel);
    jsonOk(res, linesJson(lines));
}
