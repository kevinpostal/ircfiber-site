module ircfiber.web.admin.ircd;

///
/// IRCd (InspIRCd) management for the admin dashboard.
///
/// Keeps one IRC control connection to the InspIRCd daemon open,
/// authenticated as a dedicated dashboard oper, and runs read or oper
/// commands over it: LUSERS / STATS / LIST / NAMES for the overview,
/// GLINE / KLINE / ZLINE for ban management, REHASH to reload config.
/// The session is shared across requests (see "Shared oper session"):
/// every connect/OPER/QUIT cycle is broadcast as CONNECT + OPER + QUIT
/// server notices (plus an OperServ GLOBOPS) to every oper on every
/// linked server, and the admin page polls every 15s.
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
/// vibe TCP sockets (fiber-blocking, like the support bot) with an
/// optional TLS layer. The ircd serves a self-signed cert on 6697, so
/// peer validation is off and the Docker network is the trust boundary —
/// still strictly better than plaintext (no oper password on the wire
/// for passive sniffers). Admin endpoints are low-traffic; a transaction
/// lasts a few seconds at most.
/// Secrets (oper password) never appear in logs or error strings.
///
import std.algorithm : canFind, startsWith, endsWith;
import std.array : split;
import std.conv : to;
import std.datetime : dur;
import std.string : strip, indexOf, lastIndexOf, replace, toLower;
import std.typecons : Tuple;
import vibe.core.net : TCPConnection, WaitForDataStatus, connectTCP;
import vibe.core.stream : IOMode;
import vibe.stream.tls : TLSContextKind, TLSPeerValidationMode, TLSStream, TLSStreamState,
    createTLSContext, createTLSStream;

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
    ushort port = 6697;
    bool tls = true;
    string operName;
    string operPassword;
    string confDir = "/etc/ircfiber/ircd";

    bool configured() const {
        return host.length > 0 && operName.length > 0 && operPassword.length > 0;
    }
}

IrcdSettings loadIrcdSettings() {
    import std.process : environment;
    import ircfiber.env : envSecret;
    IrcdSettings s;
    s.host = environment.get("IRCFIBER_IRCD_HOST", "").strip();
    bool explicitPort = false;
    try {
        auto rawPort = environment.get("IRCFIBER_IRCD_PORT", "").strip();
        if (rawPort.length) { s.port = rawPort.to!ushort; explicitPort = true; }
    } catch (Exception) { s.port = 6697; }
    // TLS by default (the ircd TLS listener). IRCFIBER_IRCD_TLS=0 keeps
    // plaintext for local dev; when the flag is unset a legacy explicit
    // 6667 keeps meaning plaintext so a new binary + old env still works
    // until redeploy renders 6697.
    auto rawTls = environment.get("IRCFIBER_IRCD_TLS", "").strip().toLower();
    if (rawTls.length == 0) s.tls = !(explicitPort && s.port == 6667);
    else s.tls = !(rawTls == "0" || rawTls == "false" || rawTls == "no" || rawTls == "off");
    s.operName = environment.get("IRCFIBER_IRCD_OPER", "").strip();
    // Oper password: file-backed in prod (IRCFIBER_IRCD_OPER_PASSWORD_FILE)
    // so `docker inspect` cannot hand out ircd oper rights.
    s.operPassword = envSecret("IRCFIBER_IRCD_OPER_PASSWORD", "");
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
    /// `time` message-tag (IRCv3 `server-time`) as unix millis, or -1 when
    /// the server sent no tag (untagged relay, pre-CAP peer). The ircd
    /// replays chathistory with the ORIGINAL stamps, so anything older
    /// than our own JOIN is a replay, never a live message.
    long serverTimeMs = -1;
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
        l.serverTimeMs = parseServerTimeTag(s[1 .. sp]);
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

/// Tolerance for the history-replay check: a line stamped more than this
/// far before our own JOIN is a chathistory replay, never live traffic.
/// Minutes-old replays vs same-second live lines — 2 s absorbs any clock
/// skew between the ircd and bot containers on the same host.
enum HISTORY_SKEW_MS = 2_000;

/// True when a channel line with `serverTimeMs` predates our `joinedAtMs
/// and is therefore chathistory replay. Untagged lines (no negotiated
/// `server-time` cap) and channels we never stamped are never replays.
bool isHistoryReplayLine(long serverTimeMs, long joinedAtMs) @safe pure nothrow {
    if (serverTimeMs < 0 || joinedAtMs <= 0) return false;
    return joinedAtMs - serverTimeMs > HISTORY_SKEW_MS;
}

/// Unix millis from an IRCv3 `time` tag section (`tag[;tag...]`, tag values
/// may carry `\:` `\s` `\\` escapes). -1 when no usable `time=` is present.
long parseServerTimeTag(string tags) @safe pure nothrow {
    foreach (tok; splitTags(tags)) {
        if (tok.length > 5 && tok[0 .. 5] == "time=") {
            const ms = parseIrcTimestamp(unescapeTagValue(tok[5 .. $]));
            if (ms >= 0) return ms;
        }
    }
    return -1;
}

private string[] splitTags(string tags) @safe pure nothrow {
    string[] parts;
    size_t start = 0;
    // A `;` preceded by `\` is an escaped literal, not a separator.
    for (size_t i = 0; i < tags.length; i++) {
        if (tags[i] != ';') continue;
        size_t bs = 0;
        for (size_t j = i; j > start && tags[j - 1] == '\\'; j--) bs++;
        if (bs % 2 == 1) continue;
        parts ~= tags[start .. i];
        start = i + 1;
    }
    parts ~= tags[start .. $];
    return parts;
}

private string unescapeTagValue(string v) @safe pure nothrow {
    // Single pass so `\n` survives alongside `\:`/`\s`/`\\`.
    char[] buf;
    buf.length = v.length;
    size_t n = 0;
    for (size_t i = 0; i < v.length; i++) {
        if (v[i] == '\\' && i + 1 < v.length) {
            i++;
            switch (v[i]) {
                case ':': buf[n++] = ';'; break;
                case 's': buf[n++] = ' '; break;
                case '\\': buf[n++] = '\\'; break;
                case 'r': buf[n++] = '\r'; break;
                case 'n': buf[n++] = '\n'; break;
                default: buf[n++] = v[i]; break;
            }
        } else {
            buf[n++] = v[i];
        }
    }
    return buf[0 .. n].idup;
}

/// Unix millis from `YYYY-MM-DDTHH:MM:SS[.sss]Z`. -1 on anything else —
/// no timezone offsets, no leap-second smuggling, just what the ircd emits.
long parseIrcTimestamp(string iso) @safe pure nothrow {
    // Shortest accepted: `1970-01-01T00:00:00Z` (20 chars).
    if (iso.length < 20) return -1;
    if (iso[4] != '-' || iso[7] != '-' || iso[10] != 'T'
            || iso[13] != ':' || iso[16] != ':' || iso[$ - 1] != 'Z')
        return -1;
    long num(size_t a, size_t b) {
        long v = 0;
        foreach (i; a .. b) {
            if (iso[i] < '0' || iso[i] > '9') return -1;
            v = v * 10 + (iso[i] - '0');
        }
        return v;
    }
    const y = num(0, 4), mo = num(5, 7), d = num(8, 10);
    const h = num(11, 13), mi = num(14, 16), se = num(17, 19);
    if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > 31
            || h > 23 || mi > 59 || se > 60)
        return -1;
    long ms = 0;
    size_t i = 19;
    if (i < iso.length - 1 && iso[i] == '.') {
        i++;
        long scale = 100;
        int digits = 0;
        while (i < iso.length - 1 && iso[i] >= '0' && iso[i] <= '9' && digits < 6) {
            if (digits < 3) ms += (iso[i] - '0') * scale;
            scale /= 10;
            digits++;
            i++;
        }
        if (digits == 0) return -1;
        while (i < iso.length - 1 && iso[i] >= '0' && iso[i] <= '9') i++;
    }
    if (i != iso.length - 1) return -1;
    return daysToUnix(y, mo, d) * 86_400_000L + h * 3_600_000L + mi * 60_000L + se * 1_000L + ms;
}

/// Days from 1970-01-01 to y-mo-d (Howard Hinnant's days_from_civil).
/// day-of-month validity is the caller's light range check above.
private long daysToUnix(long y, long mo, long d) @safe pure nothrow {
    y -= mo <= 2;
    const era = (y >= 0 ? y : y - 399) / 400;
    const yoe = y - era * 400;
    const doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146_097 + doe - 719_468;
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

/// Attribute map of one `<tag …>` body (everything between the tag name
/// and its unquoted `>`).
private string[string] parseConfAttrs(string inner) @safe pure {
    static bool isSpace(char c) @safe pure {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r';
    }
    string[string] attrs;
    size_t k;
    while (k < inner.length) {
        while (k < inner.length && isSpace(inner[k])) k++;
        const nameStart = k;
        while (k < inner.length && inner[k] != '=' && !isSpace(inner[k])) k++;
        if (k >= inner.length || inner[k] != '=') break;
        const name = inner[nameStart .. k];
        k++;
        if (k >= inner.length || inner[k] != '"') break;
        k++;
        const valStart = k;
        while (k < inner.length && inner[k] != '"') k++;
        const value = inner[valStart .. k];
        if (k < inner.length) k++;
        if (name.length) attrs[name] = value;
    }
    return attrs;
}

/// Attribute maps of EVERY `<tag …>` in an InspIRCd config text, in file
/// order. Handles the multi-line form the templates render (one attribute
/// per line) and quoted values containing `>`; comment lines are dropped
/// first, because the rendered config discusses tags in prose
/// ("# … leaves the per-IP judgement to <connectban> below") and a
/// comment must never be read as the tag itself. Empty when absent.
public string[string][] parseConfTags(string confText, string tag) @safe pure {
    import std.string : splitLines;

    string[string][] tags;
    if (!tag.length) return tags;

    string text;
    foreach (line; confText.splitLines()) {
        if (line.strip().startsWith("#")) continue;
        text ~= line ~ "\n";
    }

    static bool isSpace(char c) @safe pure {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r';
    }

    // `<connectban` must not match `<connectbanfoo`.
    const open = "<" ~ tag;
    size_t pos;
    while (pos < text.length) {
        const rel = text[pos .. $].indexOf(open);
        if (rel < 0) break;
        const size_t after = pos + cast(size_t) rel + open.length;
        if (!(after < text.length && (isSpace(text[after]) || text[after] == '>'))) {
            pos = after;
            continue;
        }
        size_t end = text.length;
        bool quoted;
        for (size_t j = after; j < text.length; j++) {
            if (text[j] == '"') quoted = !quoted;
            else if (text[j] == '>' && !quoted) { end = j; break; }
        }
        tags ~= parseConfAttrs(text[after .. end]);
        pos = end < text.length ? end + 1 : text.length;
    }
    return tags;
}

/// Attribute map of the first `<tag …>` in an InspIRCd config text.
/// Empty when absent. See `parseConfTags` for the scanning rules.
public string[string] parseConfTag(string confText, string tag) @safe pure {
    auto all = parseConfTags(confText, tag);
    return all.length ? all[0] : null;
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

/// Placeholder for the Nth secret in a config file, 1-based. The index is
/// what makes a round-trip safe when two lines redact alike — custom.conf
/// renders `recvpass=` twice with identical indentation (netcrave link and
/// k3s leaf link), and an unindexed marker cannot tell them apart.
public string redactedMarker(size_t n) { return "***REDACTED#" ~ n.to!string ~ "***"; }

/// Redact every secret attribute on every line of a config file dump,
/// numbering the markers file-wide in reading order.
public string redactConfText(string text) {
    string[] out_;
    out_.reserve(text.length / 64 + 1);
    size_t n;
    foreach (line; text.split("\n")) {
        auto hits = secretHits(line);
        if (hits.length == 0) { out_ ~= line; continue; }
        string rebuilt;
        size_t cursor;
        foreach (h; hits) {
            rebuilt ~= line[cursor .. h.valueStart] ~ redactedMarker(++n);
            cursor = h.valueEnd;
        }
        out_ ~= rebuilt ~ line[cursor .. $];
    }
    import std.array : join;
    return out_.join("\n");
}

// ---------------------------------------------------------------------------
// Secret-preserving save (covered by unit tests — no I/O here)
// ---------------------------------------------------------------------------

/// One quoted secret occurrence and the span of its value on the line.
private struct SecretHit {
    size_t valueStart;  // first char of the quoted value
    size_t valueEnd;    // index of the closing quote
    string value;
}

/// Every quoted secret value on `line` (`key`/`sendpass`/`recvpass`/
/// `password`, single or double quotes) in left-to-right order.
private SecretHit[] secretHits(string line) {
    SecretHit[] hits;
    foreach (attr; _secretAttrs) {
        foreach (q; ['"', '\'']) {
            string needle = attr ~ "=" ~ q;
            size_t from = 0;
            while (from < line.length) {
                auto rel = line[from .. $].indexOf(needle);
                if (rel < 0) break;
                auto at = from + cast(size_t) rel;
                auto vs = at + needle.length;
                auto erel = line[vs .. $].indexOf(q);
                if (erel < 0) break;
                auto end = vs + cast(size_t) erel;
                hits ~= SecretHit(vs, end, line[vs .. end]);
                from = end + 1;
            }
        }
    }
    import std.algorithm : sort;
    hits.sort!((a, b) => a.valueStart < b.valueStart);
    return hits;
}

/// Result of `restoreSecrets`: `error` is "" on success.
public struct RestoreSecretsResult {
    string restored;
    string error;
}

/// Re-inject live secrets into submitted (redacted) config text. The editor
/// buffer is the redacted dump, so every marker carries the 1-based index
/// of the live secret it stands for (`***REDACTED#3***`) and is refilled
/// from the live file by that index — position on the line, and even the
/// order of the lines, may change without mixing two secrets up. An index
/// outside the live file, or an unindexed `***REDACTED***` left over from
/// an older editor buffer, is rejected naming the 1-based submitted line —
/// never a guess. Lines without a marker pass through untouched (so a
/// value pasted from the Ansible vault is kept verbatim).
public RestoreSecretsResult restoreSecrets(string liveText, string submittedText) {
    import std.array : join;
    string[] live;
    foreach (line; liveText.split("\n"))
        foreach (h; secretHits(line)) live ~= h.value;

    enum markerHead = "***REDACTED";
    enum markerTail = "***";
    string[] out_;
    out_.reserve(submittedText.length / 64 + 1);
    foreach (idx, line; submittedText.split("\n")) {
        string rebuilt;
        size_t cursor;
        while (cursor < line.length) {
            auto rel = line[cursor .. $].indexOf(markerHead);
            if (rel < 0) break;
            const size_t at = cursor + cast(size_t) rel;
            size_t p = at + markerHead.length;
            if (p + markerTail.length <= line.length && line[p .. p + markerTail.length] == markerTail)
                return RestoreSecretsResult("", "line " ~ (idx + 1).to!string ~
                    ": ***REDACTED*** has no index \u2014 reload the Config tab and re-apply " ~
                    "the edit, or paste the real value from the Ansible vault");
            if (p >= line.length || line[p] != '#') {
                rebuilt ~= line[cursor .. p];
                cursor = p;
                continue;
            }
            p++;
            const size_t digits = p;
            size_t n;
            bool overflow;
            while (p < line.length && line[p] >= '0' && line[p] <= '9') {
                if (n > (size_t.max - 9) / 10) overflow = true;
                else n = n * 10 + cast(size_t)(line[p] - '0');
                p++;
            }
            if (p == digits || p + markerTail.length > line.length ||
                line[p .. p + markerTail.length] != markerTail) {
                rebuilt ~= line[cursor .. p];
                cursor = p;
                continue;
            }
            const size_t markerEnd = p + markerTail.length;
            if (overflow || n == 0 || n > live.length)
                return RestoreSecretsResult("", "line " ~ (idx + 1).to!string ~ ": " ~
                    line[at .. markerEnd] ~ " does not match the live file \u2014 reload the " ~
                    "Config tab and re-apply the edit");
            rebuilt ~= line[cursor .. at] ~ live[n - 1];
            cursor = markerEnd;
        }
        out_ ~= rebuilt ~ line[cursor .. $];
    }
    return RestoreSecretsResult(out_.join("\n"), "");
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

/// One authed IRC session. Construct, run commands; kept open and
/// reused by the shared-session code below.
final class IrcdClient {
    private TCPConnection _conn;
    private TLSStream _tls;
    private bool _open;
    private string _nick;
    private string _readBuf;

    this(IrcdSettings s) {
        if (!s.configured())
            throw new IrcdError("IRCd management is not configured. Set " ~
                "IRCFIBER_IRCD_HOST / IRCFIBER_IRCD_OPER / " ~
                "IRCFIBER_IRCD_OPER_PASSWORD on the gateway.", 503);
        scope (failure) close();
        import core.time : seconds;
        try {
            _conn = connectTCP(s.host, s.port, null, 0, 10.seconds);
        } catch (Exception) {
            throw new IrcdError("IRCd connection refused: " ~ s.host ~ ":" ~
                s.port.to!string);
        }
        _conn.tcpNoDelay = true;
        _open = true;
        if (s.tls) {
            try {
                auto ctx = createTLSContext(TLSContextKind.client);
                // Self-signed ircd cert (generated on first boot; LE mode
                // is opt-in) — same no-verify policy as the support bot
                // and engine IRC connections. The Docker network is the
                // trust boundary; TLS still hides the oper password from
                // passive sniffers.
                ctx.peerValidationMode = TLSPeerValidationMode.none;
                _tls = createTLSStream(_conn, ctx, TLSStreamState.connecting, s.host);
            } catch (Exception) {
                throw new IrcdError("IRCd TLS handshake failed: " ~ s.host ~ ":" ~
                    s.port.to!string);
            }
        }

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
        if (_tls !is null) {
            try { _tls.finalize(); } catch (Exception) {}
            _tls = null;
        }
        if (_open) {
            _open = false;
            try { _conn.close(); } catch (Exception) {}
        }
    }

    void sendLine(string line) {
        try {
            auto data = cast(const(ubyte)[])(line ~ "\r\n");
            if (_tls !is null) { _tls.write(data); _tls.flush(); }
            else { _conn.write(data); _conn.flush(); }
        } catch (Exception) {
            throw new IrcdError("IRCd connection broke while sending.");
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
            bool ready;
            try {
                ready = _tls !is null ? _tls.dataAvailableForRead : _conn.dataAvailableForRead;
            } catch (Exception) { return null; }
            if (!ready) {
                auto waitMs = remain > 1000 ? 1000 : remain;
                try {
                    final switch (_conn.waitForDataEx(msecs(waitMs))) {
                        case WaitForDataStatus.dataAvailable: ready = true; break;
                        case WaitForDataStatus.timeout: continue;
                        case WaitForDataStatus.noMoreData: return null;
                    }
                } catch (Exception) { return null; }
            }
            if (!ready) continue;
            ubyte[8192] chunk;
            long n;
            try {
                n = cast(long)(_tls !is null ? _tls.read(chunk[], IOMode.once)
                    : _conn.read(chunk[], IOMode.once));
            } catch (Exception) { return null; }
            if (n <= 0) {
                try { if (!_conn.connected) return null; }
                catch (Exception) { return null; }
                continue;
            }
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

    /// Discard input queued while the session was idle (server notices,
    /// PINGs — answered inline) so it never leaks into the next transact.
    /// Returns false when the peer has closed the socket.
    bool drainPending() {
        try {
            while (_tls !is null ? _tls.dataAvailableForRead : _conn.dataAvailableForRead) {
                ubyte[8192] chunk;
                auto n = _tls !is null ? _tls.read(chunk[], IOMode.once)
                    : _conn.read(chunk[], IOMode.once);
                if (n == 0) return _conn.connected;
                _readBuf ~= cast(string) chunk[0 .. cast(size_t) n].idup;
            }
        } catch (Exception) { return false; }
        while (true) {
            auto nl = _readBuf.indexOf('\n');
            if (nl < 0) break;
            auto line = _readBuf[0 .. nl].strip();
            _readBuf = _readBuf[nl + 1 .. $];
            if (line.startsWith("PING")) {
                auto sp = line.indexOf(' ');
                try sendLine("PONG" ~ (sp >= 0 ? line[sp .. $] : ""));
                catch (Exception) return false;
            }
        }
        try return _conn.connected;
        catch (Exception) return false;
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

// ---------------------------------------------------------------------------
// Shared oper session
// ---------------------------------------------------------------------------
//
// Handlers run on vibe fibers and every handler finishes its IRC I/O
// before writing the response, so one module-level session needs no
// lock. A 30s timer answers idle PINGs so the ircd never ping-times-out
// the session while nobody is on the admin page, and detects a closed
// socket so the next request reconnects.

private IrcdClient _session;
private bool _keepaliveStarted;

private void dropSession() nothrow {
    if (_session is null) return;
    try _session.close(); catch (Exception) {}
    _session = null;
}

private void ircdKeepalive() nothrow {
    if (_session is null) return;
    bool ok;
    try ok = _session.drainPending(); catch (Exception) ok = false;
    if (!ok) {
        logInfo("IRCd control session closed by peer; will reconnect on demand");
        dropSession();
    }
}

/// Reuse the live session or open a new one. `reused` tells the caller
/// whether a failure may be a stale socket worth one reconnect.
private IrcdClient acquireSession(IrcdSettings settings, out bool reused) {
    if (_session !is null) {
        bool ok;
        try ok = _session.drainPending(); catch (Exception) ok = false;
        if (ok) { reused = true; return _session; }
        dropSession();
    }
    reused = false;
    _session = new IrcdClient(settings);
    if (!_keepaliveStarted) {
        import vibe.core.core : setTimer;
        import core.time : seconds;
        setTimer(30.seconds, () @trusted nothrow { ircdKeepalive(); }, true);
        _keepaliveStarted = true;
    }
    return _session;
}

/// Run `work` on the shared oper session. A failure on a reused session
/// drops it and retries once on a fresh connection (the peer may have
/// closed it between keepalive ticks); any failure on a fresh session
/// drops it so the next request starts clean. Maps IrcdError to JSON.
private void withIrcd(HTTPServerRequest req, HTTPServerResponse res, void delegate(IrcdClient) work) {
    auto settings = loadIrcdSettings();
    foreach (attempt; 0 .. 2) {
        IrcdClient client;
        bool reused;
        try {
            client = acquireSession(settings, reused);
        } catch (IrcdError e) {
            jsonError(res, e.httpStatus, e.msg);
            return;
        } catch (Exception e) {
            logWarn("IRCd connect failed: %s", e.msg);
            jsonError(res, 502, "IRCd connection failed.");
            return;
        }
        try {
            work(client);
            return;
        } catch (IrcdError e) {
            dropSession();
            if (reused && attempt == 0) continue;
            jsonError(res, e.httpStatus, e.msg);
        } catch (Exception e) {
            dropSession();
            if (reused && attempt == 0) continue;
            logWarn("IRCd operation failed: %s", e.msg);
            jsonError(res, 502, "IRCd operation failed.");
        }
        return;
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

// ---------------------------------------------------------------------------
// Server links
// ---------------------------------------------------------------------------

/// One `<link>` tag as declared on disk. Passwords are deliberately absent:
/// this struct feeds an HTTP response.
private struct ConfLink {
    string name;
    string ipaddr;
    string port;
    string file;
    bool autoconnect;
}

/// Every `<link>` declared in the gateway-visible conf dir, in file order
/// (`inspircd.conf`, `modules.conf`, `custom.conf`), first declaration of a
/// name winning. `<autoconnect server="a b">` is a failover list, so the
/// flag is resolved against every whitespace-separated entry of every
/// autoconnect tag in any of the files. No IRC I/O.
private ConfLink[] configuredLinks(string confDir) {
    import std.file : exists, isFile, readText;
    import std.path : buildPath;
    ConfLink[] links;
    bool[string] seen;
    string[] autoServers;
    foreach (file; ["inspircd.conf", "modules.conf", "custom.conf"]) {
        auto path = buildPath(confDir, file);
        if (!exists(path) || !isFile(path)) continue;
        string text;
        try text = readText(path);
        catch (Exception) continue;
        foreach (tag; parseConfTags(text, "autoconnect"))
            foreach (s; tag.get("server", "").split()) autoServers ~= s.toLower();
        foreach (tag; parseConfTags(text, "link")) {
            auto name = tag.get("name", "").strip();
            if (name.length == 0 || (name.toLower() in seen) !is null) continue;
            seen[name.toLower()] = true;
            links ~= ConfLink(name, tag.get("ipaddr", ""), tag.get("port", ""), file, false);
        }
    }
    foreach (ref l; links)
        if (autoServers.canFind(l.name.toLower())) l.autoconnect = true;
    return links;
}

/// Server names present on the network right now, lowercased, from LINKS:
/// `:srv 364 <nick> <server> <parent> :<hops> <desc>`, terminated by 365.
private bool[string] liveLinkNames(IrcdClient client) {
    bool[string] live;
    foreach (line; client.transact("LINKS", ["365", "421"], 8000)) {
        auto l = parseIrcLine(line);
        if (!l.valid || l.command != "364" || l.params.length < 4) continue;
        live[l.params[1].toLower()] = true;
    }
    return live;
}

/// GET /api/admin/ircd/links — live LINKS rows plus the `<link>` tags on
/// disk, so "configured but not linked" is visible without reading logs.
package void apiIrcdLinks(HTTPServerRequest req, HTTPServerResponse res) {
    auto settings = loadIrcdSettings();
    withIrcd(req, res, (client) {
        auto servers = Json.emptyArray;
        bool[string] live;
        foreach (line; client.transact("LINKS", ["365", "421"], 8000)) {
            auto l = parseIrcLine(line);
            // A 364 row with fewer than 4 params is skipped, never fatal.
            if (!l.valid || l.command != "364" || l.params.length < 4) continue;
            auto trailing = l.params[3];
            long hops = -1;
            string desc = "";
            auto sp = trailing.indexOf(' ');
            if (sp > 0) {
                try hops = trailing[0 .. cast(size_t) sp].to!long;
                catch (Exception) { hops = -1; }
                desc = trailing[cast(size_t) sp + 1 .. $];
            } else {
                try hops = trailing.to!long;
                catch (Exception) { hops = -1; desc = trailing; }
            }
            auto o = Json.emptyObject;
            o["name"] = Json(l.params[1]);
            o["parent"] = Json(l.params[2]);
            o["hops"] = Json(hops);
            o["desc"] = Json(desc);
            servers ~= o;
            live[l.params[1].toLower()] = true;
        }
        auto configured = Json.emptyArray;
        foreach (c; configuredLinks(settings.confDir)) {
            auto o = Json.emptyObject;
            o["name"] = Json(c.name);
            o["ipaddr"] = Json(c.ipaddr);
            o["port"] = Json(c.port);
            o["file"] = Json(c.file);
            o["autoconnect"] = Json(c.autoconnect);
            o["linked"] = Json((c.name.toLower() in live) !is null);
            configured ~= o;
        }
        auto data = Json.emptyObject;
        data["servers"] = servers;
        data["configured"] = configured;
        jsonOk(res, data);
    });
}

/// POST /api/admin/ircd/links/connect {name} — dial one configured link.
///
/// The name goes into a raw IRC command, so it must both look like a server
/// name and already be declared on disk. InspIRCd answers CONNECT
/// synchronously with a single NOTICE ("Connecting to server: …", "already
/// exists", "No server matching …", "is ME"); an actual dial failure is
/// asynchronous, so the link is polled for a few seconds and `linked: false`
/// plus the notice is the honest answer.
package void apiIrcdLinkConnect(HTTPServerRequest req, HTTPServerResponse res) {
    import vibe.core.core : sleep;
    auto body = readJsonBody(req);
    if (body.type != Json.Type.object) {
        jsonError(res, 400, "Request body must be JSON {name}.");
        return;
    }
    string name = body["name"].type == Json.Type.string ? body["name"].get!string.strip() : "";
    bool wellFormed = name.length > 0 && name.length <= 64;
    if (wellFormed)
        foreach (c; name) {
            const ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
            if (!ok) { wellFormed = false; break; }
        }
    auto settings = loadIrcdSettings();
    bool known = false;
    if (wellFormed)
        foreach (c; configuredLinks(settings.confDir))
            if (c.name == name) { known = true; break; }
    if (!known) {
        jsonError(res, 400, "name must be a configured link.");
        return;
    }
    withIrcd(req, res, (client) {
        string notice = "";
        bool denied = false;
        foreach (line; client.transact("CONNECT " ~ name, ["NOTICE", "481"], 8000)) {
            auto l = parseIrcLine(line);
            if (!l.valid) continue;
            if (l.command == "481") { denied = true; break; }
            if (l.command == "NOTICE" && notice.length == 0 && l.params.length > 0)
                notice = l.params[$ - 1];
        }
        if (denied) {
            jsonError(res, 403, "The dashboard oper may not CONNECT. Deploy roles/ircd " ~
                "(opers.conf grants CONNECT to the Dashboard class) and rehash.");
            return;
        }
        bool linked = false;
        foreach (attempt; 0 .. 4) {
            sleep(dur!"msecs"(2000));
            if ((name.toLower() in liveLinkNames(client)) !is null) { linked = true; break; }
        }
        logInfo("Admin CONNECT %s (linked=%s)", name, linked);
        auto data = Json.emptyObject;
        data["notice"] = Json(notice);
        data["linked"] = Json(linked);
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

/// Active X-lines of one type on `client`. The single place the `STATS`
/// verb choice and the numeric-210 parsing live.
private XLine[] xlinesOn(IrcdClient client, string type) {
    auto letter = xlineLetter(type);
    auto cmd = type == "zline" ? "STATS Z" : "STATS " ~ letter;
    XLine[] rows;
    foreach (line; client.transact(cmd, ["219"], 8000)) {
        XLine x;
        if (!parseStatsXLine(parseIrcLine(line), x)) continue;
        rows ~= x;
    }
    return rows;
}

private Json listBans(IrcdClient client, string type) {
    auto arr = Json.emptyArray;
    foreach (x; xlinesOn(client, type)) arr ~= xlineToJson(x);
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

/// Sends REHASH on `client` and returns the confirmed file name plus the
/// raw reply lines. Throws IrcdError when the ircd refuses or never confirms.
private string rehashOn(IrcdClient client, out string[] lines) {
    lines = client.transact("REHASH", ["382", "481", "491"], 10_000);
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
    return file;
}

/// POST /api/admin/ircd/rehash — reload ircd config (connected users stay up).
package void apiIrcdRehash(HTTPServerRequest req, HTTPServerResponse res) {
    withIrcd(req, res, (client) {
        string[] lines;
        auto file = rehashOn(client, lines);
        logInfo("Admin rehashed ircd (%s)", file);
        auto data = Json.emptyObject;
        data["rehashed"] = Json(file);
        data["notices"] = ircdNotices(lines);
        jsonOk(res, data);
    });
}

/// REHASH over the shared oper session outside an HTTP handler (the MOTD
/// rotation timer). Same one-retry-on-stale-session policy as `withIrcd`;
/// must run on the main thread that owns the session. Returns the
/// confirmed file name; throws IrcdError / Exception on failure.
package string rehashIrcdNow() {
    auto settings = loadIrcdSettings();
    if (!settings.configured())
        throw new IrcdError("IRCd oper credentials are not configured.", 503);
    foreach (attempt; 0 .. 2) {
        bool reused;
        auto client = acquireSession(settings, reused);
        try {
            string[] lines;
            return rehashOn(client, lines);
        } catch (Exception e) {
            dropSession();
            if (reused && attempt == 0) continue;
            throw e;
        }
    }
    assert(0);
}

/// Active X-lines of one type, read over the shared dashboard-oper
/// session outside any HTTP request. Same one-retry-on-stale-session
/// policy as `withIrcd`; must run on the main thread that owns the
/// session. Throws IrcdError when the ircd is not configured or refuses.
///
/// Public rather than `package` because `ircfiber.web.unban` — the public
/// self-service ban-appeal page — is not in the `ircfiber.web.admin`
/// package and needs to see whether the visitor's own address is banned.
public XLine[] listXlinesNow(string type) {
    if (xlineLetter(type).length == 0)
        throw new IrcdError("type must be gline, kline or zline.", 400);
    auto settings = loadIrcdSettings();
    if (!settings.configured())
        throw new IrcdError("IRCd oper credentials are not configured.", 503);
    foreach (attempt; 0 .. 2) {
        bool reused;
        auto client = acquireSession(settings, reused);
        try
            return xlinesOn(client, type);
        catch (Exception e) {
            dropSession();
            if (reused && attempt == 0) continue;
            throw e;
        }
    }
    assert(0);
}

/// Removes one X-line over the shared dashboard-oper session outside any
/// HTTP request, and confirms the removal by re-listing — InspIRCd answers
/// a successful removal with silence, so absence from `STATS` is the only
/// proof. Deletion is the bare mask (no duration): the dash form is
/// treated as a literal mask and never matches.
///
/// Any oper may remove any X-line, which is why the release path lives in
/// the web process (which holds a `ZLINE`-capable oper session) rather
/// than in FiberEye, which has no session here.
public void removeXlineNow(string type, string mask) {
    if (xlineLetter(type).length == 0)
        throw new IrcdError("type must be gline, kline or zline.", 400);
    if (!validBanMask(mask))
        throw new IrcdError("mask is required (max 100 chars, no spaces).", 400);
    auto settings = loadIrcdSettings();
    if (!settings.configured())
        throw new IrcdError("IRCd oper credentials are not configured.", 503);
    auto verb = type == "gline" ? "GLINE" : type == "kline" ? "KLINE" : "ZLINE";
    foreach (attempt; 0 .. 2) {
        bool reused;
        // An answer from the ircd — an error NOTICE or a mask still
        // listed — is a verdict, not a stale socket, so it is never
        // retried on a fresh connection.
        bool answered;
        auto client = acquireSession(settings, reused);
        try {
            client.sendLine(verb ~ " " ~ mask);
            // Success is silent; an error arrives as a NOTICE.
            auto deadline = IrcdClient.monoMs() + 2500;
            string errNotice;
            while (IrcdClient.monoMs() < deadline) {
                auto line = client.readLine(deadline - IrcdClient.monoMs());
                if (line is null) break;
                auto l = parseIrcLine(line);
                if (l.valid && l.command == "NOTICE" && l.params.length > 0) {
                    errNotice = l.params[$ - 1];
                    break;
                }
            }
            if (errNotice.length) {
                answered = true;
                throw new IrcdError("IRCd: " ~ errNotice, 404);
            }
            foreach (x; xlinesOn(client, type))
                if (x.mask == mask) {
                    answered = true;
                    throw new IrcdError("Ban removal sent but still listed.");
                }
            logInfo("Removed %s %s", verb, mask);
            return;
        } catch (Exception e) {
            if (!answered) dropSession();
            if (reused && attempt == 0 && !answered) continue;
            throw e;
        }
    }
    assert(0);
}

/// Config files viewable (read-only) from the dashboard. `custom.conf`
/// holds the server `<link>` / `<autoconnect>` / `<bind>` tags.
private immutable string[] _viewableConf =
    ["inspircd.conf", "modules.conf", "custom.conf", "opers.conf", "motd"];

/// Files editable through the save endpoint. `opers.conf` stays in Ansible
/// (an oper block edited live is an authentication change, not a tuning one).
private immutable string[] _editableConf = ["inspircd.conf", "modules.conf", "custom.conf", "motd"];

/// Lowercase hex sha256 of a config file's bytes. Lowercase because that is
/// what Ansible's `stat.checksum` writes into .ansible.<file>.sha256
/// (guarded_conf.yml) — D's toHexString is uppercase, which made every file
/// look drifted. Doubles as the editor's optimistic-concurrency revision.
private string confRevision(string text) {
    import std.digest : toHexString;
    import std.digest.sha : sha256Of;
    auto hex = toHexString(sha256Of(cast(const(char)[]) text));
    return hex[].idup.toLower();
}

/// GET /api/admin/ircd/config?file=inspircd.conf — redacted config text.
/// Reads the host-exposed conf dir (mounted read-only into the gateway).
package void apiIrcdConfig(HTTPServerRequest req, HTTPServerResponse res) {
    auto settings = loadIrcdSettings();
    auto name = req.query.get("file", "inspircd.conf").strip();
    if (!_viewableConf.canFind(name)) {
        import std.array : join;
        jsonError(res, 400, "file must be one of: " ~ _viewableConf.join(", ") ~ ".");
        return;
    }
    if (name.indexOf('/') >= 0 || name.indexOf('.') == 0) {
        jsonError(res, 400, "Invalid file name.");
        return;
    }
    import std.file : exists, isFile, readText;
    import std.path : buildPath;
    // The MOTD moved into the gateway-writable motd.d/ (admin rotation).
    auto path = name == "motd" ? buildPath(settings.confDir, "motd.d", "motd") : buildPath(settings.confDir, name);
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
    bool editable = _editableConf.canFind(name);
    // drifted: sha256 of live file != content of sidecar .ansible.<file>.sha256.
    // Computed for every viewable file — the guarded render writes a sidecar
    // for opers.conf and custom.conf too; a missing sidecar is "not drifted".
    bool drifted = false;
    auto sidecar = buildPath(settings.confDir, ".ansible." ~ name ~ ".sha256");
    if (exists(sidecar) && isFile(sidecar)) {
        try {
            drifted = readText(sidecar).strip().toLower() != confRevision(text);
        } catch (Exception) {
            // missing/unreadable sidecar -> not drifted
        }
    }
    auto data = Json.emptyObject;
    data["file"] = Json(name);
    data["redacted"] = Json(true);
    data["content"] = Json(redactConfText(text));
    data["editable"] = Json(editable);
    data["drifted"] = Json(drifted);
    data["revision"] = Json(confRevision(text));
    jsonOk(res, data);
}

/// Helper: in-place write to live path (same inode — gateway sees it
/// through a per-file rw bind mount; rename would orphan the mount).
/// Returns "" on success or the error reason.
private string writeIrcdFileInPlace(string path, string text) {
    import std.file : write;
    try write(path, text);
    catch (Exception e) return "cannot write " ~ path ~ ": " ~ e.msg;
    return "";
}

/// Helper: write timestamped backup to admin-bak dir, then prune to
/// newest 5 per file. Returns (backupPath, error) — error "" on success.
private Tuple!(string, string) writeBackup(string confDir, string file, string text) {
    import std.file : exists, isDir, write, remove, dirEntries, SpanMode;
    import std.path : buildPath, baseName;
    import std.algorithm : sort;
    import std.datetime : Clock;
    import std.conv : to;
    auto bakDir = buildPath(confDir, "admin-bak");
    if (!exists(bakDir) || !isDir(bakDir))
        return Tuple!(string, string)("", "admin-bak dir not mounted (mount the ircd conf dir with admin-bak rw)");
    auto ms = Clock.currTime.stdTime;
    auto bakPath = buildPath(bakDir, file ~ "." ~ ms.to!string ~ ".bak");
    try write(bakPath, text);
    catch (Exception e) return Tuple!(string, string)("", "cannot write backup " ~ bakPath ~ ": " ~ e.msg);
    string[] bakFiles;
    try {
        foreach (de; dirEntries(bakDir, SpanMode.shallow)) {
            if (de.isFile) bakFiles ~= baseName(de.name);
        }
    } catch (Exception) {}
    string prefix = file ~ ".";
    string[] matching;
    foreach (f; bakFiles) if (f.startsWith(prefix) && f.endsWith(".bak")) matching ~= f;
    matching.sort!((a, b) => a > b); // newest first (ms timestamp in name)
    if (matching.length > 5) {
        foreach (i; 5 .. matching.length)
            try remove(buildPath(bakDir, matching[i])); catch (Exception) {}
    }
    return Tuple!(string, string)(bakPath, "");
}

/// POST /api/admin/ircd/config — save config + rehash
package void apiIrcdConfigSave(HTTPServerRequest req, HTTPServerResponse res) {
    auto body = readJsonBody(req);
    if (body.type != Json.Type.object) {
        jsonError(res, 400, "Request body must be JSON {file, content}.");
        return;
    }
    string name = body["file"].type == Json.Type.string ? body["file"].get!string.strip() : "";
    string content = body["content"].type == Json.Type.string ? body["content"].get!string : "";
    string revision = body["revision"].type == Json.Type.string ? body["revision"].get!string.strip() : "";
    if (!_editableConf.canFind(name)) {
        import std.array : join;
        jsonError(res, 400, "file must be one of: " ~ _editableConf.join(", ") ~
            " (opers.conf stays in Ansible).");
        return;
    }
    if (content.length == 0 || content.length > 200_000) {
        jsonError(res, 400, "Config content empty or too large (max 200000).");
        return;
    }
    auto settings = loadIrcdSettings();
    // Nothing below may touch disk when the ircd cannot be rehashed: a saved
    // but un-rehashed config is neither live nor rolled back.
    if (!settings.configured()) {
        jsonError(res, 503, "IRCd oper credentials are not configured; " ~
            "refusing to write config that cannot be rehashed.");
        return;
    }
    import std.file : exists, isFile, readText;
    import std.path : buildPath;
    // Resolve path exactly as GET does
    auto path = name == "motd" ? buildPath(settings.confDir, "motd.d", "motd") : buildPath(settings.confDir, name);
    if (!exists(path) || !isFile(path)) {
        jsonError(res, 503, "Config file is not visible to the gateway (" ~ path ~
            "). Mount the ircd conf dir read-only to enable the config viewer.");
        return;
    }
    // Read live text for secret restore
    string liveText;
    try liveText = readText(path);
    catch (Exception e) {
        jsonError(res, 500, "Could not read live config file.");
        return;
    }
    // Optimistic concurrency: with indexed markers a stale editor buffer
    // would splice the wrong secret into the wrong tag.
    if (revision.length == 0 || revision != confRevision(liveText)) {
        jsonError(res, 409, "This file changed on disk since you loaded it " ~
            "(Ansible install or another admin). Reload the Config tab and re-apply your edit.");
        return;
    }
    // Restore secrets
    auto restored = restoreSecrets(liveText, content);
    if (restored.error.length > 0) {
        jsonError(res, 400, restored.error);
        return;
    }
    // Write backup
    auto backup = writeBackup(settings.confDir, name, liveText);
    if (backup[1].length > 0) {
        jsonError(res, 503, backup[1]);
        return;
    }
    // Write in place
    auto writeErr = writeIrcdFileInPlace(path, restored.restored);
    if (writeErr.length > 0) {
        jsonError(res, 500, writeErr);
        return;
    }
    // REHASH
    withIrcd(req, res, (IrcdClient client) {
        string[] lines;
        string file;
        bool rehashFailed = false;
        string rehashError = "";
        try {
            file = rehashOn(client, lines);
        } catch (IrcdError e) {
            rehashFailed = true;
            rehashError = e.msg;
        } catch (Exception e) {
            rehashFailed = true;
            rehashError = e.msg;
        }
        if (rehashFailed) {
            // Restore backup in place (best effort, never retried in a loop)
            bool restoreOk = false;
            try {
                auto restoreErr = writeIrcdFileInPlace(path, liveText);
                restoreOk = restoreErr.length == 0;
                if (!restoreOk) logWarn("IRCd config rollback failed for %s: %s", path, restoreErr);
            } catch (Exception e) logWarn("IRCd config rollback failed for %s: %s", path, e.msg);
            // Best-effort rehash after restore
            try {
                string[] _;
                rehashOn(client, _);
            } catch (Exception) {}
            auto payload = Json.emptyObject;
            payload["ok"] = Json(false);
            payload["restored"] = Json(restoreOk);
            payload["error"] = Json(rehashError ~ (restoreOk ?
                " — previous content restored" :
                " — automatic restore failed; recover from admin-bak/ on the host"));
            res.headers["Content-Type"] = "application/json; charset=utf-8";
            res.statusCode = 502;
            res.writeBody(payload.toString());
            return;
        }
        logInfo("Admin saved %s and rehashed ircd (%s)", name, file);
        auto data = Json.emptyObject;
        data["file"] = Json(name);
        data["rehashed"] = Json(file);
        data["notices"] = ircdNotices(lines);
        jsonOk(res, data);
    });
}

