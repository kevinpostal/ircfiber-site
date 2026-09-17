/**
 * `BridgeServ` commands over the shared Anope 2.1 JSON-RPC transport
 * (`ircfiber.services.anope`), plus the Discord REST the guild/channel
 * pickers call directly.
 *
 * There is no sidecar any more: `BridgeServ` runs on the merged services
 * instance (`services.ircfiber.com`), and its commands go through
 * `anope.command` as the oper account (`IRCFIBER_ANOPE_OPER_ACCOUNT`),
 * which is Services Root and therefore holds `bridgeserv/*`.
 *
 * Why the guild/channel pickers do NOT go through BridgeServ: `GUILDS` and
 * `CHANNELS` answer asynchronously, addressed to the requesting IRC user by
 * UID. An RPC caller is not an IRC user, so the synchronous reply is empty
 * and the real answer is discarded — while `LIST`/`ADD`/`DEL` all answer
 * normally. The pickers therefore call Discord directly, which is also
 * synchronous and keeps working while services are down.
 *
 * Env:
 *   IRCFIBER_DISCORD_BOT_TOKEN   bot token for the pickers (or _FILE)
 */
module ircfiber.services.bridge;

import std.algorithm : canFind;
import std.conv : to;
import std.process : environment;
import std.string : indexOf, split, splitLines, startsWith, strip, toLower;
import core.time : seconds;

import vibe.core.log : logWarn;
import vibe.data.json : Json, parseJsonString;
import vibe.http.client : requestHTTP, HTTPClientRequest, HTTPClientResponse,
    HTTPClientSettings, HTTPMethod;
import vibe.stream.operations : readAll;

import ircfiber.env : envSecret;
import ircfiber.services.anope : AnopeSettings, anopeCommand, isSafeServicesArg;

/// Endpoint configuration read from the environment.
struct BridgeSettings {
    string discordToken;       /// IRCFIBER_DISCORD_BOT_TOKEN

    /// Whether the Discord-side pickers can be served. Independent of the
    /// Anope surface: the bot token is a separate secret and the pickers
    /// keep working while services are down.
    bool hasDiscordToken() const @safe pure nothrow @nogc {
        return discordToken.length > 0;
    }
}

BridgeSettings loadBridgeSettings() {
    BridgeSettings s;
    s.discordToken = envSecret("IRCFIBER_DISCORD_BOT_TOKEN", "").strip();
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

/// Runs one BridgeServ command and returns its reply lines.
///
/// The words are reassembled space-delimited on the Anope side, so a value
/// containing whitespace would inject an extra parameter — every argument
/// passes `isSafeServicesArg` first.
///
/// Throws: `BridgeError` on a JSON-RPC error (its code), on an unusable
/// body, or on a transport failure (`code == 0`); also `code == 0` when the
/// Anope surface itself is not configured.
string[] bridgeCommand(AnopeSettings s, string[] args) {
    import std.string : join;

    if (!s.configured || !s.hasOper)
        throw new BridgeError(0, "the Discord bridge is not configured");
    if (args.length == 0)
        throw new BridgeError(0, "no BridgeServ command given");
    foreach (a; args)
        if (!isSafeServicesArg(a))
            throw new BridgeError(0, "unusable BridgeServ argument");

    auto r = anopeCommand(s, "BridgeServ", s.operAccount, args.join(" "));
    if (!r.transportOk)
        throw new BridgeError(0, r.transportError);
    if (r.errorCode != 0) {
        const msg = r.error.length ? r.error : r.text;
        // A JSON-RPC error is a refusal, never a transport failure, so it
        // must not be reported with code 0.
        throw new BridgeError(r.errorCode == 0 ? -1 : cast(int) r.errorCode,
            msg.length ? msg : "the bridge service refused the command");
    }
    return r.rawText.length ? r.rawText.splitLines() : [];
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
BridgeListing bridgeList(AnopeSettings s) {
    return parseBridgeList(bridgeCommand(s, ["LIST"]));
}

/// True when the reply reads like a refusal rather than a success.
private bool refused(string[] lines, string success) @safe pure {
    if (lines.length == 0) return true;
    return !lines[0].strip().toLower().canFind(success.toLower());
}

/// `ADD <channel> <space> <foreign channel> [suffix]`.
string[] bridgeAdd(AnopeSettings s, string ircChannel, string space,
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
string[] bridgeSet(AnopeSettings s, string ircChannel, string space,
                   string channel, string suffix = "") {
    string[] args = ["SET", ircChannel, space, channel];
    if (suffix.length) args ~= suffix;
    auto lines = bridgeCommand(s, args);
    if (refused(lines, "updated bridge"))
        throw new BridgeError(-1, lines[0].strip());
    return lines;
}

/// `DEL <channel>`.
string[] bridgeDel(AnopeSettings s, string ircChannel) {
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
    settings.connectTimeout = 10.seconds;
    settings.readTimeout = 10.seconds;

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
    import ircfiber.services.anope : isSafeServicesArg;

    assert(isValidSnowflake("1085202042806607932"));
    assert(!isValidSnowflake(""));
    assert(!isValidSnowflake("12a"));
    assert(!isValidSnowflake("123456789012345678901"));

    // Same rule the command path enforces: a value containing whitespace
    // would inject an extra parameter on the Anope side.
    assert(isSafeServicesArg("#dmz"));
    assert(!isSafeServicesArg("#dmz two"));
    assert(!isSafeServicesArg(""));

    // No I/O happens before the gate: an unconfigured surface and an unsafe
    // argument both throw without touching the network.
    try {
        bridgeCommand(AnopeSettings.init, ["LIST"]);
        assert(false);
    } catch (BridgeError e) {
        assert(e.isTransport);
    }
    try {
        bridgeCommand(AnopeSettings("http://services:8080/jsonrpc", "tok", 10, "admin"),
                      ["ADD", "#dmz two"]);
        assert(false);
    } catch (BridgeError e) {
        assert(e.msg == "unusable BridgeServ argument");
    }

    // The exact shape BridgeServ LIST prints, verified live against 2.1.
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
