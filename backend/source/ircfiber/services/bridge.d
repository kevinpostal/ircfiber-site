/**
 * Anope 2.1 JSON-RPC client for the Discord bridge sidecar (`bridgeserv`).
 *
 * The bridge runs as its own Anope instance (`bridge.ircfiber.com`,
 * `deploy/roles/ircd/tasks/bridge.yml`) because `bridgeserv` is 2.1 only
 * while `ircfiber-services` is pinned to 2.0.20 for `db_flatfile` +
 * `m_xmlrpc_main`. `ircfiber.services.anope` is therefore NOT reusable here:
 * it is an XML-RPC transport hard-wired to 2.0's `command`/`user`/
 * `checkAuthentication` methods and to `m_xmlrpc`'s double-escaping. That
 * module stays untouched and still serves the 2.0.20 instance.
 *
 * Transport (Anope `modules/rpc/jsonrpc.cpp`): HTTP POST to `/jsonrpc` with
 * `Content-Type: application/json`, JSON-RPC 2.0. The reply for
 * `anope.command` is `result`, an array with one entry per services reply
 * line (`RPCCommandReply::SendMessage`, `modules/rpc/rpc_user.cpp`).
 *
 * Authentication, verified live against 2.1.27: the Bearer credential is
 * **base64-encoded** in the header — `RPC::Provider::CanExecute`
 * (`include/modules/rpc.h`) runs `B64Decode` on everything after `Bearer `
 * before comparing. Sending the raw token answers
 * `-32601 No authorization for method: anope.command`.
 *
 * Why the guild/channel pickers do NOT go through BridgeServ: `GUILDS` and
 * `CHANNELS` answer asynchronously, addressed to the requesting IRC user by
 * UID (`DeliverListing`/`Requester` in `modules/bridgeserv/bridgeserv.cpp`).
 * An RPC caller is not an IRC user, so the synchronous reply is empty and
 * the real answer is discarded — verified live: `anope.command bridge-rpc
 * BridgeServ GUILDS` returns `[]` while `LIST`/`ADD`/`DEL` all answer
 * normally. The pickers therefore call Discord directly, which is also
 * synchronous and keeps working while the sidecar is down.
 *
 * Env:
 *   IRCFIBER_BRIDGE_RPC_URL      full endpoint, e.g. http://bridge:8080/jsonrpc
 *                                (empty → the bridge surface is disabled)
 *   IRCFIBER_BRIDGE_RPC_TOKEN    Bearer token (or _FILE indirection)
 *   IRCFIBER_BRIDGE_RPC_ACCOUNT  the account BridgeServ commands run as
 *   IRCFIBER_DISCORD_BOT_TOKEN   bot token for the pickers (or _FILE)
 *   IRCFIBER_BRIDGE_RPC_TIMEOUT  connect/read timeout in seconds (default 10)
 */
module ircfiber.services.bridge;

import std.array : appender;
import std.algorithm : canFind;
import std.conv : to;
import std.process : environment;
import std.string : indexOf, split, startsWith, strip, toLower;
import core.time : seconds;

import vibe.core.log : logWarn;
import vibe.data.json : Json, parseJsonString;
import vibe.http.client : requestHTTP, HTTPClientRequest, HTTPClientResponse,
    HTTPClientSettings, HTTPMethod;
import vibe.stream.operations : readAll;

import ircfiber.env : envSecret;

/// Endpoint configuration read from the environment.
struct BridgeSettings {
    string rpcUrl;             /// IRCFIBER_BRIDGE_RPC_URL; "" disables the surface
    string token;              /// IRCFIBER_BRIDGE_RPC_TOKEN (raw, not yet base64)
    string account;            /// IRCFIBER_BRIDGE_RPC_ACCOUNT
    string discordToken;       /// IRCFIBER_DISCORD_BOT_TOKEN
    int timeoutSeconds = 10;   /// IRCFIBER_BRIDGE_RPC_TIMEOUT

    /// All three RPC inputs are required: the listener rejects a missing or
    /// wrong token, and `anope.command` errors with `No such account` when
    /// the account is not registered on the sidecar.
    bool configured() const @safe pure nothrow @nogc {
        return rpcUrl.length > 0 && token.length > 0 && account.length > 0;
    }

    /// Whether the Discord-side pickers can be served. Independent of
    /// `configured`: the bot token is a separate secret and the pickers keep
    /// working while the sidecar is down.
    bool hasDiscordToken() const @safe pure nothrow @nogc {
        return discordToken.length > 0;
    }
}

BridgeSettings loadBridgeSettings() {
    BridgeSettings s;
    s.rpcUrl = environment.get("IRCFIBER_BRIDGE_RPC_URL", "").strip();
    s.account = environment.get("IRCFIBER_BRIDGE_RPC_ACCOUNT", "").strip();
    s.token = envSecret("IRCFIBER_BRIDGE_RPC_TOKEN", "").strip();
    s.discordToken = envSecret("IRCFIBER_DISCORD_BOT_TOKEN", "").strip();
    const raw = environment.get("IRCFIBER_BRIDGE_RPC_TIMEOUT", "").strip();
    if (raw.length) {
        try {
            const v = raw.to!int;
            if (v > 0 && v <= 120) s.timeoutSeconds = v;
        } catch (Exception) {
            // keep the default; a bad env value must not disable the surface
        }
    }
    return s;
}

/// A JSON-RPC `error` object, or a transport failure with `code == 0`.
class BridgeError : Exception {
    int code;
    this(int code, string msg, string file = __FILE__, size_t line = __LINE__) @safe pure nothrow {
        super(msg, file, line);
        this.code = code;
    }
    /// A transport failure rather than a refusal by services.
    bool isTransport() const @safe pure nothrow @nogc { return this.code == 0; }
}

/// One row of `BridgeServ LIST`.
struct BridgeRow {
    string ircChannel;
    string space;        /// Discord guild id
    string channel;      /// Discord channel id
    string suffix;       /// nick suffix, "" when unset
    string network;      /// bridge protocol, "discord"
    bool endpoint;       /// whether the outbound webhook is established
    uint reserved;       /// nicknames held for this bridge
}

struct DiscordGuild { string id; string name; }
struct DiscordChannel { string id; string name; }

/// The reply lines of one `BridgeServ LIST`, parsed and raw.
struct BridgeListing {
    BridgeRow[] rows;
    string[] raw;
}

/// Every argument is reassembled space-delimited on the Anope side
/// (`rpc_user.cpp` joins `params`), so a value containing whitespace injects
/// an extra parameter. Same rule `ircfiber.services.anope.isSafeServicesArg`
/// applies to the XML-RPC surface.
bool isSafeBridgeArg(string s) @safe pure nothrow @nogc {
    if (s.length == 0) return false;
    foreach (char c; s)
        if (c <= 0x20 || c == 0x7F) return false;
    return true;
}

/// Runs one BridgeServ command and returns its reply lines.
///
/// Throws: `BridgeError` on a JSON-RPC error, an unusable body, or a
/// transport failure (`code == 0`).
string[] bridgeCommand(BridgeSettings s, string[] args) {
    import std.base64 : Base64;

    if (!s.configured)
        throw new BridgeError(0, "the Discord bridge is not configured");
    if (args.length == 0)
        throw new BridgeError(0, "no BridgeServ command given");
    foreach (a; args)
        if (!isSafeBridgeArg(a))
            throw new BridgeError(0, "unusable BridgeServ argument");

    auto params = appender!(Json[]);
    params ~= Json(s.account);
    params ~= Json("BridgeServ");
    foreach (a; args)
        params ~= Json(a);

    auto call = Json.emptyObject;
    call["jsonrpc"] = Json("2.0");
    call["id"] = Json("gateway");
    call["method"] = Json("anope.command");
    call["params"] = Json(params.data);
    const payload = call.toString();
    // The Bearer credential is base64 of the token: the listener runs
    // B64Decode on everything after "Bearer " before comparing (rpc.h).
    const bearer = "Bearer " ~ Base64.encode(cast(const(ubyte)[]) s.token).idup;

    auto settings = new HTTPClientSettings;
    settings.connectTimeout = s.timeoutSeconds.seconds;
    settings.readTimeout = s.timeoutSeconds.seconds;

    int status = 0;
    string responseBody;
    try {
        requestHTTP(s.rpcUrl,
            (scope HTTPClientRequest req) {
                req.method = HTTPMethod.POST;
                // `Connection: close` plus an explicit Content-Length, for
                // the same reason as the 2.0 XML-RPC client: Anope's httpd
                // is a hand-rolled server which serves one request per
                // connection and whose parser reads only what has already
                // arrived. See the long comment in `services/anope.d`.
                req.headers["Connection"] = "close";
                req.headers["Content-Type"] = "application/json";
                // The Bearer credential is base64 of the token: the
                // listener B64Decodes it before comparing (rpc.h).
                req.headers["Authorization"] = bearer;
                req.headers["Content-Length"] = payload.length.to!string;
                req.bodyWriter.write(cast(const(ubyte)[]) payload);
            },
            (scope HTTPClientResponse res) {
                status = res.statusCode;
                try responseBody = cast(string) res.bodyReader.readAll();
                catch (Exception e)
                    logWarn("bridge rpc: reading the response failed: %s", e.msg);
            },
            settings);
    } catch (Exception e) {
        logWarn("bridge rpc: %s failed: %s", args[0], e.msg);
        throw new BridgeError(0, e.msg);
    }

    Json reply;
    try
        reply = parseJsonString(responseBody);
    catch (Exception e) {
        logWarn("bridge rpc: unparseable body (HTTP %s): %s", status, e.msg);
        throw new BridgeError(0, "the bridge service returned an unreadable reply");
    }

    if (reply.type == Json.Type.object) {
        auto err = reply["error"];
        if (err.type == Json.Type.object) {
            int code = 0;
            auto c = err["code"];
            if (c.type == Json.Type.int_) code = cast(int) c.get!long;
            string msg;
            auto m = err["message"];
            if (m.type == Json.Type.string) msg = m.get!string;
            // A JSON-RPC error is a refusal, never a transport failure, so
            // it must not be reported with code 0.
            throw new BridgeError(code == 0 ? -1 : code,
                msg.length ? msg : "the bridge service refused the command");
        }
    }

    auto result = reply.type == Json.Type.object ? reply["result"] : Json.init;
    if (result.type != Json.Type.array)
        throw new BridgeError(0, "the bridge service returned no result");

    string[] lines;
    foreach (v; result.get!(Json[]))
        if (v.type == Json.Type.string) lines ~= v.get!string;
    return lines;
}

/// Parses the fixed-column table `BridgeServ LIST` prints.
///
/// Deliberately forgiving: an unrecognised line is skipped rather than
/// failing the request, and the raw lines travel with the parsed rows so the
/// admin panel can show them when parsing yields nothing.
BridgeListing parseBridgeList(string[] lines) @safe pure {
    BridgeListing out_;
    out_.raw = lines;
    foreach (line; lines) {
        const t = line.strip();
        if (!t.startsWith("#")) continue;            // header, status and prose lines
        auto cols = t.split();
        // channel network space remote suffix endpoint users nicks
        if (cols.length < 8) continue;
        BridgeRow row;
        row.ircChannel = cols[0];
        row.network = cols[1];
        row.space = cols[2];
        row.channel = cols[3];
        row.suffix = cols[4] == "-" ? "" : cols[4];
        row.endpoint = cols[5].toLower() == "yes";
        try row.reserved = cols[7].to!uint;
        catch (Exception) row.reserved = 0;
        out_.rows ~= row;
    }
    return out_;
}

/// `BridgeServ LIST`, parsed.
BridgeListing bridgeList(BridgeSettings s) {
    return parseBridgeList(bridgeCommand(s, ["LIST"]));
}

/// True when the reply reads like a refusal rather than a success.
private bool refused(string[] lines, string success) @safe pure {
    if (lines.length == 0) return true;
    return !lines[0].strip().toLower().canFind(success.toLower());
}

/// `ADD <channel> <space> <foreign channel> [suffix]`.
string[] bridgeAdd(BridgeSettings s, string ircChannel, string space,
                   string channel, string suffix = "") {
    string[] args = ["ADD", ircChannel, space, channel];
    if (suffix.length) args ~= suffix;
    auto lines = bridgeCommand(s, args);
    if (refused(lines, "added bridge"))
        throw new BridgeError(-1, lines[0].strip());
    return lines;
}

/// `SET <channel> <space> <foreign channel> [suffix]` — repoint, or change
/// (with no suffix argument, clear) the nick suffix.
string[] bridgeSet(BridgeSettings s, string ircChannel, string space,
                   string channel, string suffix = "") {
    string[] args = ["SET", ircChannel, space, channel];
    if (suffix.length) args ~= suffix;
    auto lines = bridgeCommand(s, args);
    if (refused(lines, "updated bridge"))
        throw new BridgeError(-1, lines[0].strip());
    return lines;
}

/// `DEL <channel>`.
string[] bridgeDel(BridgeSettings s, string ircChannel) {
    auto lines = bridgeCommand(s, ["DEL", ircChannel]);
    if (refused(lines, "bridge removed"))
        throw new BridgeError(-1, lines[0].strip());
    return lines;
}

// ---------------------------------------------------------------------------
// Discord REST — the guild/channel pickers
// ---------------------------------------------------------------------------

/// One authenticated GET against the Discord API.
///
/// A `User-Agent` is mandatory: without one Cloudflare answers HTTP 403
/// with `error code: 1010` before the request ever reaches Discord
/// (observed while verifying the relay).
private Json discordGet(BridgeSettings s, string path) {
    if (!s.hasDiscordToken)
        throw new BridgeError(0, "no Discord bot token is configured");

    auto settings = new HTTPClientSettings;
    settings.connectTimeout = s.timeoutSeconds.seconds;
    settings.readTimeout = s.timeoutSeconds.seconds;

    int status = 0;
    string responseBody;
    try {
        requestHTTP("https://discord.com/api/v10" ~ path,
            (scope HTTPClientRequest req) {
                req.method = HTTPMethod.GET;
                req.headers["Authorization"] = "Bot " ~ s.discordToken;
                req.headers["User-Agent"] =
                    "DiscordBot (https://ircfiber.com, 1.0) ircfiber-gateway";
            },
            (scope HTTPClientResponse res) {
                status = res.statusCode;
                try responseBody = cast(string) res.bodyReader.readAll();
                catch (Exception e)
                    logWarn("discord api: reading %s failed: %s", path, e.msg);
            },
            settings);
    } catch (Exception e) {
        logWarn("discord api: %s failed: %s", path, e.msg);
        throw new BridgeError(0, e.msg);
    }

    if (status < 200 || status > 299)
        throw new BridgeError(status, "Discord answered HTTP " ~ status.to!string);

    try
        return parseJsonString(responseBody);
    catch (Exception e) {
        logWarn("discord api: unparseable %s body: %s", path, e.msg);
        throw new BridgeError(0, "Discord returned an unreadable reply");
    }
}

/// The guilds the bot is a member of.
DiscordGuild[] discordGuilds(BridgeSettings s) {
    auto payload = discordGet(s, "/users/@me/guilds");
    DiscordGuild[] guilds;
    if (payload.type != Json.Type.array) return guilds;
    foreach (v; payload.get!(Json[])) {
        if (v.type != Json.Type.object) continue;
        DiscordGuild g;
        if (v["id"].type == Json.Type.string) g.id = v["id"].get!string;
        if (v["name"].type == Json.Type.string) g.name = v["name"].get!string;
        if (g.id.length) guilds ~= g;
    }
    return guilds;
}

/// The text channels of one guild. Types 0 (text) and 5 (announcement) are
/// the two a webhook can post to and a bridge can be pointed at.
DiscordChannel[] discordChannels(BridgeSettings s, string guildId) {
    if (!isValidSnowflake(guildId))
        throw new BridgeError(0, "not a Discord id");
    auto payload = discordGet(s, "/guilds/" ~ guildId ~ "/channels");
    DiscordChannel[] channels;
    if (payload.type != Json.Type.array) return channels;
    foreach (v; payload.get!(Json[])) {
        if (v.type != Json.Type.object) continue;
        auto t = v["type"];
        if (t.type != Json.Type.int_) continue;
        const kind = t.get!long;
        if (kind != 0 && kind != 5) continue;
        DiscordChannel c;
        if (v["id"].type == Json.Type.string) c.id = v["id"].get!string;
        if (v["name"].type == Json.Type.string) c.name = v["name"].get!string;
        if (c.id.length) channels ~= c;
    }
    return channels;
}

/// A Discord snowflake: 1-20 ASCII digits. Mirrors `ValidSnowflake` in
/// `modules/bridgeserv/discord.cpp`, so a bad id is rejected here instead
/// of producing a services error.
bool isValidSnowflake(string s) @safe pure nothrow @nogc {
    if (s.length == 0 || s.length > 20) return false;
    foreach (char c; s)
        if (c < '0' || c > '9') return false;
    return true;
}

unittest {
    assert(isValidSnowflake("1085202042806607932"));
    assert(!isValidSnowflake(""));
    assert(!isValidSnowflake("12a"));
    assert(!isValidSnowflake("123456789012345678901"));

    assert(isSafeBridgeArg("#dmz"));
    assert(!isSafeBridgeArg("#dmz two"));
    assert(!isSafeBridgeArg(""));

    // The exact shape BridgeServ LIST prints, verified live against 2.1.27.
    auto listing = parseBridgeList([
        "discord: online (clients appear on <space-id>.discord.bridge)",
        "Channel  Network  Space                Remote channel       Suffix  Endpoint  Users  Nicks",
        "#dmz     discord  1085202042806607932  1085202042806607935  -       yes       0      3",
    ]);
    assert(listing.rows.length == 1);
    assert(listing.rows[0].ircChannel == "#dmz");
    assert(listing.rows[0].network == "discord");
    assert(listing.rows[0].space == "1085202042806607932");
    assert(listing.rows[0].channel == "1085202042806607935");
    assert(listing.rows[0].suffix == "");
    assert(listing.rows[0].endpoint);
    assert(listing.rows[0].reserved == 3);
    assert(listing.raw.length == 3);

    // A suffixed, webhook-less bridge.
    auto suffixed = parseBridgeList([
        "#dmz     discord  1085202042806607932  1085202042806607935  -d      no        2      1",
    ]);
    assert(suffixed.rows.length == 1);
    assert(suffixed.rows[0].suffix == "-d");
    assert(!suffixed.rows[0].endpoint);

    // "No bridges are configured." must not parse as a row.
    assert(parseBridgeList(["No bridges are configured."]).rows.length == 0);
}
