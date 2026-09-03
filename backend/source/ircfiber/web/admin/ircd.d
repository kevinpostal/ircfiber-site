module ircfiber.web.admin.ircd;

///
/// IRCd (InspIRCd) management for the admin dashboard.
///
/// Opens a short-lived IRC control connection to the InspIRCd daemon,
/// authenticates as a dedicated dashboard oper, and runs read or oper
/// commands: LUSERS / STATS / LIST / NAMES for the overview, GLINE /
/// KLINE / ZLINE for ban management, REHASH to reload config.
///
/// Wire behavior here mirrors the live InspIRCd 4.11 protocol:
/// - OPER success -> MODE +o and numeric 381; bad password -> 491.
/// - STATS g/k list G/K-lines as numeric 210; Z-lines need STATS Z
///   (lowercase STATS z returns server usage stats instead).
/// - XLINE add/delete succeed SILENTLY; failures arrive as NOTICE
///   ("already exists" / "not found"). Adds are verified by re-listing.
/// - XLINE deletion is the bare mask: `GLINE user@host` (no dash prefix;
///   the dash form is treated as a literal mask and never matches).
/// - REHASH -> numeric 382 plus a "*** Successfully rehashed" NOTICE.
///
/// Blocking sockets with select() timeouts are used inline in the
/// handler, the same pattern as _probeSocks in web.admin.api (admin
/// endpoints are low-traffic; sessions last a few seconds at most).
/// Secrets (oper password) never appear in logs or error strings.
///

import std.algorithm : canFind, startsWith, endsWith;
import std.array : split;
import std.conv : to;
import std.datetime : dur;
import std.exception : enforce;
import std.socket : TcpSocket, Socket, getAddress, SocketSet;
import std.string : strip, indexOf, lastIndexOf, replace, toLower;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json;

import ircfiber.web.admin.helpers : jsonOk, jsonError, readJsonBody;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// Connection settings for the IRCd control session. All from env so no
/// secret is ever committed; empty host means "not configured".
struct IrcdSettings {
    string host;
    ushort port = 6667;
    string operName;
    string operPassword;
    string confDir = "/etc/ircfiber/ircd";

    bool configured() const {
        return host.length > 0 && operName.length > 0 && operPassword.length > 0;
    }
}

IrcdSettings loadIrcdSettings() {
    import std.process : environment;
    IrcdSettings s;
    s.host = environment.get("IRCFIBER_IRCD_HOST", "").strip();
    try {
        s.port = environment.get("IRCFIBER_IRCD_PORT", "6667").strip().to!ushort;
    } catch (Exception) { s.port = 6667; }
    s.operName = environment.get("IRCFIBER_IRCD_OPER", "").strip();
    s.operPassword = environment.get("IRCFIBER_IRCD_OPER_PASSWORD", "");
    auto dir = environment.get("IRCFIBER_IRCD_CONF_DIR", "").strip();
    if (dir.length > 0) s.confDir = dir;
    return s;
}

// ---------------------------------------------------------------------------
// Pure IRC line parsing (no I/O — covered by unit tests)
// ---------------------------------------------------------------------------

/// A parsed IRC protocol line.
public struct IrcLine {
    string prefix;
    string command;
    string[] params;
    bool valid;
}

/// Parse one raw IRC line. Tolerates an optional leading @tag section
/// (never sent without CAP negotiation, but harmless to accept).
public IrcLine parseIrcLine(string raw) {
    IrcLine l;
    auto s = raw.strip();
    if (s.length == 0) return l;
    if (s[0] == '@') {
        auto sp = s.indexOf(' ');
        if (sp < 0) return l;
        s = s[sp + 1 .. $].strip();
    }
    if (s.length == 0) return l;
    if (s[0] == ':') {
        auto sp = s.indexOf(' ');
        if (sp < 0) return l;
        l.prefix = s[1 .. sp];
        s = s[sp + 1 .. $].strip();
    }
    if (s.length == 0) return l;
    string[] parts;
    while (s.length > 0) {
        if (s[0] == ':') { parts ~= s[1 .. $]; break; }
        auto sp = s.indexOf(' ');
        if (sp < 0) { parts ~= s; break; }
        parts ~= s[0 .. sp];
        s = s[sp + 1 .. $].strip();
    }
    if (parts.length == 0) return l;
    l.command = parts[0];
    l.params = parts[1 .. $];
    l.valid = true;
    return l;
}

/// One X-line (ban) row from STATS g/k/Z numeric 210:
/// `:server 210 nick <letter> <mask> <settime> <duration> <setter> :<reason>`
public struct XLine {
    string type; // "g", "k" or "Z"
    string mask;
    long setAt;
    long durationSecs;
    string setter;
    string reason;
}

public bool parseStatsXLine(IrcLine l, out XLine x) {
    if (!l.valid || l.command != "210" || l.params.length < 6) return false;
    x.type = l.params[1];
    if (x.type != "g" && x.type != "k" && x.type != "Z") return false;
    x.mask = l.params[2];
    try { x.setAt = l.params[3].to!long; } catch (Exception) { return false; }
    try { x.durationSecs = l.params[4].to!long; } catch (Exception) { return false; }
    x.setter = l.params[5];
    x.reason = l.params.length > 6 ? l.params[6] : "";
    return true;
}

/// One LIST row, numeric 322:
/// `:server 322 nick <channel> <users> :[<modes>] <topic>`
public struct ChanInfo {
    string name;
    long users;
    string modes;
    string topic;
}

public bool parseListLine(IrcLine l, out ChanInfo c) {
    if (!l.valid || l.command != "322" || l.params.length < 3) return false;
    c.name = l.params[1];
    try { c.users = l.params[2].to!long; } catch (Exception) { return false; }
    string trailing = l.params.length > 3 ? l.params[3] : "";
    c.modes = "";
    c.topic = trailing;
    if (trailing.length > 0 && trailing[0] == '[') {
        auto end = trailing.indexOf(']');
        if (end > 0) {
            c.modes = trailing[1 .. end];
            c.topic = trailing[end + 1 .. $].strip();
        }
    }
    return true;
}

/// One NAMES row, numeric 353:
/// `:server 353 nick <sym> <channel> :<members...>`
public struct NamesInfo {
    string channel;
    string[] members; // raw entries with status prefixes (@, +, ...)
}

/// Strip a single leading status prefix for display.
public string stripStatusPrefix(string m) {
    if (m.length > 1 && "@+%&~!".canFind(m[0])) return m[1 .. $];
    return m;
}

public bool parseNamesLine(IrcLine l, out NamesInfo n) {
    if (!l.valid || l.command != "353" || l.params.length < 4) return false;
    n.channel = l.params[2];
    n.members = l.params[3].split(" ");
    return true;
}

/// Numeric reply of interest for LUSERS / STATS u / VERSION parsing.
public bool numericOf(IrcLine l, string num) {
    return l.valid && l.command == num;
}

// ---------------------------------------------------------------------------
// Config file redaction (pure — covered by unit tests)
// ---------------------------------------------------------------------------

/// Config attribute names whose quoted value is a secret.
private immutable string[] _secretAttrs = ["key", "sendpass", "recvpass", "password"];

/// Mask the quoted value of one `attr="..."` / `attr='...'` occurrence.
/// Returns the line unchanged when the attribute is absent.
public string redactAttr(string line, string attr) {
    foreach (q; ['"', '\'']) {
        auto needle = attr ~ "=" ~ [q];
        auto at = line.indexOf(needle);
        if (at < 0) continue;
        auto vs = at + needle.length;
        auto end = line.indexOf(q, vs);
        if (end < 0) continue;
        return line[0 .. vs] ~ "***REDACTED***" ~ line[end .. $];
    }
    return line;
}

/// Redact every secret attribute on every line of a config file dump.
public string redactConfText(string text) {
    string[] out_;
    out_.reserve(text.length / 64 + 1);
    foreach (line; text.split("\n")) {
        foreach (attr; _secretAttrs) line = redactAttr(line, attr);
        out_ ~= line;
    }
    import std.array : join;
    return out_.join("\n");
}

// ---------------------------------------------------------------------------
// Blocking IRC control session
// ---------------------------------------------------------------------------

/// Thrown for transport, registration and oper failures. The message is
/// always safe to surface to admins (never contains the oper password).
class IrcdError : Exception {
    int httpStatus;
    this(string msg, int status = 502) { super(msg); httpStatus = status; }
}

/// One short-lived authed IRC session. Construct, run commands, close.
final class IrcdClient {
    private TcpSocket _sock;
    private string _nick;
    private string _readBuf;
    private long _ioTimeoutMs = 5000;

    this(IrcdSettings s) {
        if (!s.configured())
            throw new IrcdError("IRCd management is not configured. Set " ~
                "IRCFIBER_IRCD_HOST / IRCFIBER_IRCD_OPER / " ~
                "IRCFIBER_IRCD_OPER_PASSWORD on the gateway.", 503);
        scope (failure) close();
        auto addrs = getAddress(s.host, s.port);
        if (addrs.length == 0)
            throw new IrcdError("IRCd host does not resolve: " ~ s.host);
        // Try every resolved address with a matching socket family.
        // A fixed AF_INET socket cannot connect to a v6 address (EAFNOSUPPORT
        // fails sync with SO_ERROR left at 0, which used to look like success
        // and died later as "broke while sending" on dual-stack networks).
        Exception lastErr;
        foreach (addr; addrs) {
            import std.socket : AddressFamily;
            auto probe = new TcpSocket(addr.addressFamily());
            probe.blocking = false;
            try {
                probe.connect(addr);
                _sock = probe;
                break;
            } catch (Exception e) {
                lastErr = e;
                if (!waitWritable(probe, 5000)) { probe.close(); continue; }
                int errVal = 0;
                import std.socket : SocketOptionLevel, SocketOption;
                probe.getOption(SocketOptionLevel.SOCKET, SocketOption.ERROR, errVal);
                if (errVal != 0) {
                    probe.close();
                    continue;
                }
                _sock = probe;
                break;
            }
        }
        if (_sock is null) {
            if (lastErr !is null)
                throw new IrcdError("IRCd connection refused: " ~ s.host ~ ":" ~
                    s.port.to!string);
            throw new IrcdError("IRCd connection timed out: " ~ s.host ~ ":" ~
                s.port.to!string);
        }
        _sock.blocking = true;
        import std.socket : SocketOptionLevel, SocketOption;
        import std.datetime : dur;
        _sock.setOption(SocketOptionLevel.SOCKET, SocketOption.RCVTIMEO, dur!"msecs"(_ioTimeoutMs));
        _sock.setOption(SocketOptionLevel.SOCKET, SocketOption.SNDTIMEO, dur!"msecs"(_ioTimeoutMs));

        import std.datetime : Clock;
        // Unique per session: the page fires status/channels/bans concurrently
        // and same-second identical nicks collide (nick grab kills the loser).
        import std.random : uniform;
        _nick = "ircfiber-adm-" ~ (Clock.currTime.toUnixTime() % 100000).to!string ~
            "-" ~ uniform(0, 1_000_000).to!string;
        sendLine("USER ircfiber-adm 0 * :IRC Fiber admin dashboard");
        sendLine("NICK " ~ _nick);
        // Registration burst: 001..004, 005, 251.., 375/372/376 or 422.
        drainUntil(["001"], 15_000);
        sendLine("OPER " ~ s.operName ~ " " ~ s.operPassword);
        bool authed = false;
        auto deadline = monoMs() + 8000;
        while (monoMs() < deadline) {
            auto line = readLine(8000);
            if (line is null) break;
            auto l = parseIrcLine(line);
            if (!l.valid) continue;
            if (l.command == "381") { authed = true; break; }
            if (l.command == "491" || l.command == "464")
                throw new IrcdError("IRCd OPER rejected (bad oper name or password).", 502);
            if (l.command == "ERROR")
                throw new IrcdError("IRCd closed the connection during OPER.");
        }
        if (!authed) throw new IrcdError("IRCd OPER timed out waiting for 381.");
    }

    void close() {
        if (_sock !is null) {
            try { _sock.close(); } catch (Exception) {}
            _sock = null;
        }
    }

    void sendLine(string line) {
        auto data = (line ~ "\r\n").dup;
        size_t sent = 0;
        while (sent < data.length) {
            auto n = _sock.send(data[sent .. $]);
            if (n <= 0) throw new IrcdError("IRCd connection broke while sending.");
            sent += cast(size_t) n;
        }
    }

    /// Read one line (without CRLF), PING answers handled inline.
    /// Returns null on timeout / closed connection.
    string readLine(long timeoutMs) {
        import core.time : msecs;
        auto deadline = monoMs() + timeoutMs;
        while (true) {
            auto nl = _readBuf.indexOf('\n');
            if (nl >= 0) {
                auto line = _readBuf[0 .. nl].strip();
                _readBuf = _readBuf[nl + 1 .. $];
                if (line.startsWith("PING")) {
                    auto sp = line.indexOf(' ');
                    sendLine("PONG" ~ (sp >= 0 ? line[sp .. $] : ""));
                    continue;
                }
                return line;
            }
            auto remain = deadline - monoMs();
            if (remain <= 0) return null;
            auto rset = new SocketSet(1);
            rset.add(_sock);
            int sel;
            try { sel = Socket.select(rset, null, null, msecs(remain > 1000 ? 1000 : remain)); }
            catch (Exception) { return null; }
            if (sel <= 0) continue;
            ubyte[8192] chunk;
            auto n = _sock.receive(chunk);
            if (n <= 0) return null;
            _readBuf ~= cast(string) chunk[0 .. cast(size_t) n].idup;
        }
    }

    /// Drain incoming lines until a line contains one of `tokens`.
    string[] drainUntil(string[] tokens, long budgetMs) {
        string[] out_;
        auto deadline = monoMs() + budgetMs;
        while (monoMs() < deadline && out_.length < 400) {
            auto line = readLine(deadline - monoMs());
            if (line is null) break;
            out_ ~= line;
            foreach (t; tokens)
                if (line.indexOf(t) >= 0) return out_;
        }
        return out_;
    }

    /// Send a command; collect lines until a numeric in `stopNumerics`
    /// arrives (prefix match on the command field) or the budget lapses.
    string[] transact(string cmd, string[] stopNumerics, long budgetMs = 8000) {
        sendLine(cmd);
        string[] out_;
        auto deadline = monoMs() + budgetMs;
        while (monoMs() < deadline && out_.length < 2000) {
            auto line = readLine(deadline - monoMs());
            if (line is null) break;
            out_ ~= line;
            auto l = parseIrcLine(line);
            if (l.valid && stopNumerics.canFind(l.command)) return out_;
        }
        return out_;
    }

    private bool waitWritable(Socket sock, long timeoutMs) {
        import core.time : msecs;
        auto wset = new SocketSet(1);
        auto eset = new SocketSet(1);
        wset.add(sock);
        eset.add(sock);
        try {
            auto sel = Socket.select(null, wset, eset, msecs(timeoutMs));
            return sel > 0 && wset.isSet(sock);
        } catch (Exception) { return false; }
    }

    /// Wall-clock milliseconds (SysTime hnsecs → ms). Only used for
    /// timeout arithmetic, never for absolute time.
    static long monoMs() {
        import std.datetime : Clock;
        return Clock.currTime.stdTime / 10_000;
    }
}

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

private Json ircdNotices(string[] lines) {
    auto a = Json.emptyArray;
    foreach (line; lines) {
        auto l = parseIrcLine(line);
        if (l.valid && l.command == "NOTICE" && l.params.length > 0)
            a ~= Json(l.params[$ - 1]);
    }
    return a;
}

/// Open an oper session, run `work`, always close. Maps IrcdError to JSON.
private void withIrcd(HTTPServerRequest req, HTTPServerResponse res, void delegate(IrcdClient) work) {
    auto settings = loadIrcdSettings();
    IrcdClient client;
    try {
        client = new IrcdClient(settings);
    } catch (IrcdError e) {
        jsonError(res, e.httpStatus, e.msg);
        return;
    } catch (Exception e) {
        logWarn("IRCd connect failed: %s", e.msg);
        jsonError(res, 502, "IRCd connection failed.");
        return;
    }
    scope (exit) client.close();
    try {
        work(client);
    } catch (IrcdError e) {
        jsonError(res, e.httpStatus, e.msg);
    } catch (Exception e) {
        logWarn("IRCd operation failed: %s", e.msg);
        jsonError(res, 502, "IRCd operation failed.");
    }
}

/// GET /api/admin/ircd/status — server, version, LUSERS counts, uptime, MOTD.
package void apiIrcdStatus(HTTPServerRequest req, HTTPServerResponse res) {
    withIrcd(req, res, (client) {
        string server = "";
        string ver = "", verComment = "";
        string uptime = "", maxConns = "";
        long users = -1, invisible = -1, opers = -1, unknown = -1;
        long channels = -1, local = -1, localMax = -1, global = -1, globalMax = -1;
        auto motd = Json.emptyArray;

        // NOTE: 265 (local) always precedes 266 (global) — stopping at
        // 265 would drop the global counts. 250 (peak connections)
        // follows 266 and bounds the wait when 266 is absent.
        foreach (line; client.transact("LUSERS", ["266", "250", "421"], 8000)) {
            auto l = parseIrcLine(line);
            if (!l.valid || l.params.length == 0) continue;
            if (server.length == 0 && l.prefix.length > 0) server = l.prefix;
            switch (l.command) {
                case "251":
                    // ":There are N users and M invisible on K servers"
                    try {
                        import std.regex : matchFirst, regex;
                        auto m = matchFirst(l.params[$ - 1],
                            regex(`There are (\d+) users and (\d+) invisible`));
                        if (!m.empty) { users = m[1].to!long; invisible = m[2].to!long; }
                    } catch (Exception) {}
                    break;
                case "252": if (l.params.length > 1) {
                    try { opers = l.params[1].to!long; } catch (Exception) {}
                } break;
                case "253": if (l.params.length > 1) {
                    try { unknown = l.params[1].to!long; } catch (Exception) {}
                } break;
                case "254": if (l.params.length > 1) {
                    try { channels = l.params[1].to!long; } catch (Exception) {}
                } break;
                case "265":
                    try {
                        import std.regex : matchFirst, regex;
                        auto m = matchFirst(l.params[$ - 1],
                            regex(`Current local users: (\d+)\s+Max: (\d+)`));
                        if (!m.empty) { local = m[1].to!long; localMax = m[2].to!long; }
                    } catch (Exception) {}
                    break;
                case "266":
                    try {
                        import std.regex : matchFirst, regex;
                        auto m = matchFirst(l.params[$ - 1],
                            regex(`Current global users: (\d+)\s+Max: (\d+)`));
                        if (!m.empty) { global = m[1].to!long; globalMax = m[2].to!long; }
                    } catch (Exception) {}
                    break;
                default: break;
            }
        }
        foreach (line; client.transact("STATS u", ["219"], 8000)) {
            auto l = parseIrcLine(line);
            if (!l.valid || l.params.length == 0) continue;
            if (l.command == "242") uptime = l.params[$ - 1];
            else if (l.command == "250") maxConns = l.params[$ - 1];
        }
        foreach (line; client.transact("VERSION", ["351", "421"], 8000)) {
            auto l = parseIrcLine(line);
            if (!l.valid || l.command != "351" || l.params.length < 3) continue;
            ver = l.params[1];
            server = l.params[2];
            verComment = l.params[$ - 1];
        }
        // MOTD is display-only; cap at 60 lines.
        foreach (line; client.transact("MOTD", ["376", "422", "421"], 8000)) {
            auto l = parseIrcLine(line);
            if (!l.valid) continue;
            if (l.command == "372" && l.params.length > 0 && motd.length < 60)
                motd ~= Json(l.params[$ - 1]);
        }

        auto data = Json.emptyObject;
        data["server"] = Json(server);
        data["version"] = Json(ver);
        data["versionComment"] = Json(verComment);
        data["uptime"] = Json(uptime);
        data["maxConnections"] = Json(maxConns);
        auto u = Json.emptyObject;
        u["users"] = Json(users); u["invisible"] = Json(invisible);
        u["opers"] = Json(opers); u["unknown"] = Json(unknown);
        u["channels"] = Json(channels);
        u["local"] = Json(local); u["localMax"] = Json(localMax);
        u["global"] = Json(global); u["globalMax"] = Json(globalMax);
        data["users"] = u;
        data["motd"] = motd;
        jsonOk(res, data);
    });
}

/// GET /api/admin/ircd/channels — LIST snapshot (name, users, modes, topic).
package void apiIrcdChannels(HTTPServerRequest req, HTTPServerResponse res) {
    withIrcd(req, res, (client) {
        auto arr = Json.emptyArray;
        foreach (line; client.transact("LIST", ["323"], 15_000)) {
        // NOTE: 321 is the LIST *header* ("Channel :Users Name") and
        // arrives before any 322 row — only 323 terminates the list.
            ChanInfo c;
            if (!parseListLine(parseIrcLine(line), c)) continue;
            auto o = Json.emptyObject;
            o["name"] = Json(c.name);
            o["users"] = Json(c.users);
            o["modes"] = Json(c.modes);
            o["topic"] = Json(c.topic);
            arr ~= o;
        }
        auto data = Json.emptyObject;
        data["channels"] = arr;
        jsonOk(res, data);
    });
}

/// GET /api/admin/ircd/channel?channel=#name — NAMES member list.
package void apiIrcdChannel(HTTPServerRequest req, HTTPServerResponse res) {
    auto name = req.query.get("channel", "").strip();
    if (name.length == 0 || name[0] != '#' || name.length > 64 ||
        name.indexOf(' ') >= 0 || name.indexOf(',') >= 0) {
        jsonError(res, 400, "Query param channel must be a single #channel (max 64 chars).");
        return;
    }
    withIrcd(req, res, (client) {
        auto members = Json.emptyArray;
        string seen = "";
        long count = 0;
        foreach (line; client.transact("NAMES " ~ name, ["366", "403", "401"], 10_000)) {
            NamesInfo n;
            if (!parseNamesLine(parseIrcLine(line), n)) continue;
            seen = n.channel;
            foreach (m; n.members) {
                if (m.length == 0) continue;
                auto o = Json.emptyObject;
                o["nick"] = Json(stripStatusPrefix(m));
                o["prefix"] = Json(m.length > 1 && "@+%&~!".canFind(m[0]) ? m[0 .. 1] : "");
                o["raw"] = Json(m);
                members ~= o;
                count++;
            }
        }
        if (seen.length == 0) { jsonError(res, 404, "No such channel."); return; }
        auto data = Json.emptyObject;
        data["channel"] = Json(seen);
        data["count"] = Json(count);
        data["members"] = members;
        jsonOk(res, data);
    });
}

private string xlineLetter(string type) {
    switch (type) {
        case "gline": return "g";
        case "kline": return "k";
        case "zline": return "Z";
        default: return "";
    }
}

private Json xlineToJson(XLine x) {
    auto o = Json.emptyObject;
    o["type"] = Json(x.type == "g" ? "gline" : x.type == "k" ? "kline" : "zline");
    o["mask"] = Json(x.mask);
    o["setAt"] = Json(x.setAt);
    o["durationSecs"] = Json(x.durationSecs);
    o["setter"] = Json(x.setter);
    o["reason"] = Json(x.reason);
    return o;
}

private Json listBans(IrcdClient client, string type) {
    auto letter = xlineLetter(type);
    auto cmd = type == "zline" ? "STATS Z" : "STATS " ~ letter;
    auto arr = Json.emptyArray;
    foreach (line; client.transact(cmd, ["219"], 8000)) {
        XLine x;
        if (!parseStatsXLine(parseIrcLine(line), x)) continue;
        arr ~= xlineToJson(x);
    }
    return arr;
}

/// GET /api/admin/ircd/bans — active G/K/Z-lines.
package void apiIrcdBans(HTTPServerRequest req, HTTPServerResponse res) {
    withIrcd(req, res, (client) {
        auto data = Json.emptyObject;
        data["glines"] = listBans(client, "gline");
        data["klines"] = listBans(client, "kline");
        data["zlines"] = listBans(client, "zline");
        jsonOk(res, data);
    });
}

public bool validBanMask(string mask) {
    if (mask.length == 0 || mask.length > 100) return false;
    foreach (c; mask)
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == ',' || c < 0x20) return false;
    return true;
}

/// POST /api/admin/ircd/bans body {type: gline|kline|zline, mask, duration?, reason?}
/// Adds succeed silently — presence is confirmed by re-listing.
package void apiIrcdBanAdd(HTTPServerRequest req, HTTPServerResponse res) {
    auto body = readJsonBody(req);
    string type = "", mask = "", duration = "", reason = "Banned by administrator";
    if (body.type == Json.Type.object) {
        if (body["type"].type == Json.Type.string) type = body["type"].get!string.strip().toLower();
        if (body["mask"].type == Json.Type.string) mask = body["mask"].get!string.strip();
        if (body["duration"].type == Json.Type.string && body["duration"].get!string.strip().length)
            duration = body["duration"].get!string.strip();
        else duration = type == "zline" ? "1h" : "1d";
        if (body["reason"].type == Json.Type.string && body["reason"].get!string.strip().length)
            reason = body["reason"].get!string.strip();
    }
    if (xlineLetter(type).length == 0) { jsonError(res, 400, "type must be gline, kline or zline."); return; }
    if (!validBanMask(mask)) { jsonError(res, 400, "mask is required (max 100 chars, no spaces)."); return; }
    if (duration.length == 0 || duration.length > 20 || duration.indexOf(' ') >= 0) {
        jsonError(res, 400, "duration is required, e.g. 1h, 7d, 0 for permanent.");
        return;
    }
    if (reason.length > 200) { jsonError(res, 400, "reason is too long (max 200)."); return; }
    // Reason travels as an IRC trailing parameter — strip newlines defensively.
    reason = reason.replace("\r", " ").replace("\n", " ").strip();
    if (reason.length == 0) reason = "Banned by administrator";

    withIrcd(req, res, (client) {
        auto verb = type == "gline" ? "GLINE" : type == "kline" ? "KLINE" : "ZLINE";
        client.sendLine(verb ~ " " ~ mask ~ " " ~ duration ~ " :" ~ reason);
        // Success is silent; collect ~2.5s for an error NOTICE.
        auto deadline = IrcdClient.monoMs() + 2500;
        string errNotice = "";
        while (IrcdClient.monoMs() < deadline) {
            auto line = client.readLine(deadline - IrcdClient.monoMs());
            if (line is null) break;
            auto l = parseIrcLine(line);
            if (l.valid && l.command == "NOTICE" && l.params.length > 0) {
                errNotice = l.params[$ - 1];
                break;
            }
        }
        if (errNotice.length > 0) { jsonError(res, 409, "IRCd: " ~ errNotice); return; }
        // Confirm by re-listing.
        bool present = false;
        foreach (b; listBans(client, type)) {
            if (b["mask"].type == Json.Type.string && b["mask"].get!string == mask) { present = true; break; }
        }
        if (!present) { jsonError(res, 502, "Ban sent but not present on re-list."); return; }
        logInfo("Admin added %s %s (%s)", verb, mask, duration);
        auto data = Json.emptyObject;
        data["type"] = Json(type);
        data["mask"] = Json(mask);
        data["duration"] = Json(duration);
        jsonOk(res, data);
    });
}

/// POST /api/admin/ircd/bans/delete body {type: gline|kline|zline, mask}
/// Deletion is the bare mask (no duration). Absence is confirmed by re-listing.
package void apiIrcdBanDelete(HTTPServerRequest req, HTTPServerResponse res) {
    auto body = readJsonBody(req);
    string type = "", mask = "";
    if (body.type == Json.Type.object) {
        if (body["type"].type == Json.Type.string) type = body["type"].get!string.strip().toLower();
        if (body["mask"].type == Json.Type.string) mask = body["mask"].get!string.strip();
    }
    if (xlineLetter(type).length == 0) { jsonError(res, 400, "type must be gline, kline or zline."); return; }
    if (!validBanMask(mask)) { jsonError(res, 400, "mask is required."); return; }
    withIrcd(req, res, (client) {
        auto verb = type == "gline" ? "GLINE" : type == "kline" ? "KLINE" : "ZLINE";
        client.sendLine(verb ~ " " ~ mask);
        auto deadline = IrcdClient.monoMs() + 2500;
        string errNotice = "";
        while (IrcdClient.monoMs() < deadline) {
            auto line = client.readLine(deadline - IrcdClient.monoMs());
            if (line is null) break;
            auto l = parseIrcLine(line);
            if (l.valid && l.command == "NOTICE" && l.params.length > 0) {
                errNotice = l.params[$ - 1];
                break;
            }
        }
        if (errNotice.length > 0) { jsonError(res, 404, "IRCd: " ~ errNotice); return; }
        bool gone = true;
        foreach (b; listBans(client, type)) {
            if (b["mask"].type == Json.Type.string && b["mask"].get!string == mask) { gone = false; break; }
        }
        if (!gone) { jsonError(res, 502, "Ban removal sent but still listed."); return; }
        logInfo("Admin removed %s %s", verb, mask);
        auto data = Json.emptyObject;
        data["type"] = Json(type);
        data["mask"] = Json(mask);
        jsonOk(res, data);
    });
}

/// POST /api/admin/ircd/rehash — reload ircd config (connected users stay up).
package void apiIrcdRehash(HTTPServerRequest req, HTTPServerResponse res) {
    withIrcd(req, res, (client) {
        auto lines = client.transact("REHASH", ["382", "481", "491"], 10_000);
        string file = "inspircd.conf";
        bool ok = false;
        foreach (line; lines) {
            auto l = parseIrcLine(line);
            if (!l.valid) continue;
            if (l.command == "382") { ok = true; if (l.params.length > 1) file = l.params[1]; }
            if (l.command == "481" || l.command == "491")
                throw new IrcdError("IRCd refused REHASH (oper privileges).", 403);
        }
        if (!ok) throw new IrcdError("REHASH sent but no 382 confirmation arrived.");
        logInfo("Admin rehashed ircd (%s)", file);
        auto data = Json.emptyObject;
        data["rehashed"] = Json(file);
        data["notices"] = ircdNotices(lines);
        jsonOk(res, data);
    });
}

/// Config files viewable (read-only) from the dashboard.
private immutable string[] _viewableConf = ["inspircd.conf", "modules.conf", "opers.conf", "motd"];

/// GET /api/admin/ircd/config?file=inspircd.conf — redacted config text.
/// Reads the host-exposed conf dir (mounted read-only into the gateway).
package void apiIrcdConfig(HTTPServerRequest req, HTTPServerResponse res) {
    auto settings = loadIrcdSettings();
    auto name = req.query.get("file", "inspircd.conf").strip();
    if (!_viewableConf.canFind(name)) {
        jsonError(res, 400, "file must be one of: inspircd.conf, modules.conf, opers.conf, motd.");
        return;
    }
    if (name.indexOf('/') >= 0 || name.indexOf('.') == 0) {
        jsonError(res, 400, "Invalid file name.");
        return;
    }
    import std.file : exists, isFile, readText;
    import std.path : buildPath;
    auto path = buildPath(settings.confDir, name);
    if (!exists(path) || !isFile(path)) {
        jsonError(res, 503, "Config file is not visible to the gateway (" ~ path ~
            "). Mount the ircd conf dir read-only to enable the config viewer.");
        return;
    }
    string text;
    try {
        text = readText(path);
    } catch (Exception e) {
        jsonError(res, 500, "Could not read config file.");
        return;
    }
    if (text.length > 200_000) { jsonError(res, 400, "Config file too large to display."); return; }
    auto data = Json.emptyObject;
    data["file"] = Json(name);
    data["redacted"] = Json(true);
    data["content"] = Json(redactConfText(text));
    jsonOk(res, data);
}

