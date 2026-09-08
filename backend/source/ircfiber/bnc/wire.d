/**
 * Pure IRC wire helpers for the bouncer listener. No I/O — every function
 * here is exercised by `tests/bnc_wire_test.d`.
 */
module ircfiber.bnc.wire;

import std.string : indexOf, toUpper, toLower, split, strip, startsWith;
import std.conv : to;
import std.array : appender, Appender;
import std.algorithm : canFind, max;
import vibe.data.json : Json;

/// `<username>[/<network>][@<clientid>]` — the soju/ZNC identity suffix
/// carried by `USER`, SASL PLAIN authcid or the left side of `PASS`.
struct BncIdentity {
    /// IRC Fiber username (case-insensitive lookup).
    string username;
    /// Network selector (slug, id or host) or "" for none.
    string network;
    /// Optional per-device id used for backlog replay ("" when absent).
    string clientId;
    /// False when the value does not parse.
    bool ok;
}

/// True for `[A-Za-z0-9_.:-]`.
private bool isClientIdChar(char c) @safe pure nothrow @nogc {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
        || c == '_' || c == '.' || c == ':' || c == '-';
}

/// Splits an identity: first `@` → clientid, then first `/` → network.
BncIdentity parseBncIdentity(string raw) @safe pure {
    BncIdentity r;
    if (!raw.length) return r;
    string left = raw;
    const at = raw.indexOf("@");
    if (at >= 0) {
        const cid = raw[at + 1 .. $];
        if (cid.length == 0 || cid.length > 64) return r;
        foreach (c; cid) if (!isClientIdChar(c)) return r;
        r.clientId = cid;
        left = raw[0 .. at];
    }
    const slash = left.indexOf("/");
    if (slash >= 0) {
        r.network = left[slash + 1 .. $];
        if (!r.network.length) return r;
        left = left[0 .. slash];
    }
    if (!left.length || left.canFind(' ')) return r;
    r.username = left;
    r.ok = true;
    return r;
}

/// Parsed `PASS` value: `<identity>:<token>` (ZNC style) or a bare token
/// (identity then comes from `USER`).
struct BncPass {
    /// Identity from the left side of the first `:` (valid when `hasIdentity`).
    BncIdentity identity;
    /// True when the value carried an identity prefix.
    bool hasIdentity;
    /// Bouncer password.
    string token;
    /// False when the value does not match either accepted form.
    bool ok;
}

/// Splits a raw `PASS` argument into identity + token.
BncPass parseBncPass(string raw) @safe pure {
    BncPass r;
    const colon = raw.indexOf(":");
    if (colon < 0) {
        if (!raw.length) return r;
        r.token = raw;
        r.ok = true;
        return r;
    }
    r.token = raw[colon + 1 .. $];
    if (!r.token.length) return r;
    r.identity = parseBncIdentity(raw[0 .. colon]);
    if (!r.identity.ok) return r;
    r.hasIdentity = true;
    r.ok = true;
    return r;
}

/// Lower-cases `name`, collapses runs of non-`[a-z0-9]` to `-` and trims
/// the dashes; "" when nothing remains. `IRC Fiber` → `irc-fiber`.
string networkSlug(string name) @safe pure {
    auto app = appender!string();
    app.reserve(name.length);
    bool pendingDash;
    foreach (char c; name.toLower()) {
        const keep = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        if (!keep) { pendingDash = app.data.length > 0; continue; }
        if (pendingDash) { app.put('-'); pendingDash = false; }
        app.put(c);
    }
    return app.data;
}

/// Decoded SASL PLAIN payload (`authzid\0authcid\0passwd`).
struct SaslPlain {
    /// Authentication identity (our `BncIdentity` grammar).
    string authcid;
    /// Bouncer password.
    string password;
    /// False on bad base64, wrong part count or empty authcid/passwd.
    bool ok;
}

/// Decodes a base64 SASL PLAIN payload.
SaslPlain parseSaslPlain(string b64) @safe {
    import std.base64 : Base64;
    SaslPlain r;
    ubyte[] raw;
    try raw = Base64.decode(b64);
    catch (Exception) return r;
    auto parts = (() @trusted => cast(string) raw)().split("\0");
    if (parts.length != 3) return r;
    r.authcid = parts[1];
    r.password = parts[2];
    r.ok = r.authcid.length > 0 && r.password.length > 0;
    return r;
}

/// Inverse of `escapeTagValue`. A trailing lone backslash is dropped.
string unescapeTagValue(string v) @safe pure {
    auto app = appender!string();
    app.reserve(v.length);
    for (size_t i = 0; i < v.length; i++) {
        if (v[i] != '\\') { app.put(v[i]); continue; }
        if (i + 1 >= v.length) break;
        i++;
        switch (v[i]) {
            case ':': app.put(';'); break;
            case 's': app.put(' '); break;
            case '\\': app.put('\\'); break;
            case 'r': app.put('\r'); break;
            case 'n': app.put('\n'); break;
            default: app.put(v[i]);
        }
    }
    return app.data;
}

/// Parses a `k=v;k2=v2` bouncer-networks attribute list (message-tag
/// escaping on values). A bare key maps to "".
string[string] parseBouncerAttrs(string raw) @safe pure {
    string[string] r;
    foreach (item; raw.split(";")) {
        if (!item.length) continue;
        const eq = item.indexOf("=");
        if (eq < 0) { r[item] = ""; continue; }
        r[item[0 .. eq]] = unescapeTagValue(item[eq + 1 .. $]);
    }
    return r;
}

/// Serialises ordered pairs as `k=v;...` (empty value → bare key).
string formatBouncerAttrs(const(string[2])[] pairs) @safe pure {
    auto app = appender!string();
    foreach (i, p; pairs) {
        if (i) app.put(';');
        app.put(p[0]);
        if (p[1].length) { app.put('='); app.put(escapeTagValue(p[1])); }
    }
    return app.data;
}

/// Command + params of a line the client sent (tags/prefix discarded).
struct ParsedLine {
    /// Upper-cased command (or numeric).
    string command;
    /// Middle + trailing params.
    string[] params;
    /// Line with the leading `@tags` word removed (prefix kept). Used when
    /// forwarding the client's line verbatim to the engine.
    string withoutTags;
}

/// RFC 1459 tokenizer with IRCv3 tag skipping.
ParsedLine parseClientLine(string line) @safe pure {
    ParsedLine r;
    string rest = line.strip();
    if (rest.startsWith("@")) {
        const sp = rest.indexOf(" ");
        if (sp < 0) return r;
        rest = rest[sp + 1 .. $].strip();
    }
    r.withoutTags = rest;
    if (rest.startsWith(":")) {
        const sp = rest.indexOf(" ");
        if (sp < 0) return r;
        rest = rest[sp + 1 .. $].strip();
    }
    while (rest.length) {
        if (rest[0] == ':') {
            r.params ~= rest[1 .. $];
            break;
        }
        const sp = rest.indexOf(" ");
        string tok;
        if (sp < 0) { tok = rest; rest = ""; }
        else { tok = rest[0 .. sp]; rest = rest[sp + 1 .. $].strip(); }
        if (!tok.length) continue;
        if (!r.command.length) r.command = tok.toUpper();
        else r.params ~= tok;
    }
    return r;
}

/// Escapes a tag value per the IRCv3 message-tags spec.
string escapeTagValue(string v) @safe pure {
    auto app = appender!string();
    app.reserve(v.length);
    foreach (c; v) {
        switch (c) {
            case ';': app.put("\\:"); break;
            case ' ': app.put("\\s"); break;
            case '\\': app.put("\\\\"); break;
            case '\r': app.put("\\r"); break;
            case '\n': app.put("\\n"); break;
            default: app.put(c);
        }
    }
    return app.data;
}

/// Serialises one server→client line. The last param gets a `:` when it
/// is empty, contains a space or starts with `:`. The total is capped at
/// 8191 bytes with tags / 512 bytes without (the last param is truncated).
string formatLine(string[string] tags, string prefix, string command, string[] params) @safe pure {
    auto app = appender!string();
    if (tags.length) {
        app.put('@');
        bool first = true;
        foreach (k, v; tags) {
            if (!first) app.put(';');
            first = false;
            app.put(k);
            if (v.length) { app.put('='); app.put(escapeTagValue(v)); }
        }
        app.put(' ');
    }
    const tagLen = app.data.length;
    if (prefix.length) { app.put(':'); app.put(prefix); app.put(' '); }
    app.put(command);
    foreach (i, p; params) {
        app.put(' ');
        const last = i + 1 == params.length;
        if (last && (p.length == 0 || p.canFind(' ') || p.startsWith(":"))) app.put(':');
        app.put(p);
    }
    string line = sanitizeUtf8Wire(app.data);
    // 512 for the message body (incl. CRLF) — reserve 2 bytes for CRLF.
    const size_t bodyLimit = 510;
    const size_t tagLimit = tags.length ? 8191 : 0;
    const size_t limit = tagLen + bodyLimit;
    if (line.length > limit || (tags.length && line.length > tagLimit)) {
        size_t cut = limit;
        if (tags.length && tagLimit < cut) cut = tagLimit;
        line = truncateUtf8(line, cut);
    }
    return line;
}

/// Cuts `s` to at most `max` bytes without splitting a UTF-8 sequence.
/// Also sanitizes invalid sequences to U+FFFD so a 10k unicode burst
/// with mixed CP437/legacy bytes cannot emit an invalid UTF-8 line that
/// crashes the TLS writer or downstream parser.
private string sanitizeUtf8Wire(string s) @safe pure {
    import std.utf : decode, encode;
    char[] out_;
    out_.reserve(s.length);
    size_t i = 0;
    while (i < s.length) {
        try {
            auto d = decode(s, i);
            encode(out_, d);
        } catch (Exception) {
            out_ ~= '\uFFFD';
            i++;
        }
    }
    return () @trusted { return cast(string) out_; }();
}

private string truncateUtf8(string s, size_t max) @safe pure {
    if (s.length <= max) return s;
    if (max == 0) return "";
    size_t end = max;
    // Back up over continuation bytes so we don't split a codepoint.
    while (end > 0 && end < s.length && (s[end] & 0xC0) == 0x80) end--;
    // If we stopped on a lead byte that claims more bytes than we have
    // room for, the caller already caps at max — the lead itself would be
    // a split sequence, so stay before it (end already points there).
    return s[0 .. end];
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for a unix-ms timestamp.
string serverTimeTag(long ms) @safe {
    import std.datetime : SysTime, UTC, DateTime;
    import std.format : format;
    import core.time : msecs;
    auto t = SysTime.fromUnixTime(ms / 1000, UTC());
    const dt = cast(DateTime) t;
    return format("%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
        dt.year, cast(int) dt.month, dt.day, dt.hour, dt.minute, dt.second, ms % 1000);
}

/// Parses a `server-time` timestamp (`YYYY-MM-DDTHH:MM:SS[.mmm]Z`) to
/// unix ms; returns 0 when malformed.
long parseServerTime(string s) @safe {
    import std.datetime : SysTime, DateTime, UTC;
    import std.conv : to;
    if (s.length < 20 || s[$ - 1] != 'Z' || s[4] != '-' || s[7] != '-' || s[10] != 'T'
        || s[13] != ':' || s[16] != ':') return 0;
    try {
        const dt = DateTime(s[0 .. 4].to!int, s[5 .. 7].to!int, s[8 .. 10].to!int,
                            s[11 .. 13].to!int, s[14 .. 16].to!int, s[17 .. 19].to!int);
        long ms = SysTime(dt, UTC()).toUnixTime!long * 1000;
        if (s.length > 20 && s[19] == '.') {
            auto frac = s[20 .. $ - 1];
            if (!frac.length || frac.length > 9) return 0;
            // Milliseconds: use the first three digits, zero-padded.
            string m3 = frac.length >= 3 ? frac[0 .. 3] : frac ~ "000"[0 .. 3 - frac.length];
            ms += m3.to!int;
        } else if (s.length != 20) {
            return 0;
        }
        return ms;
    } catch (Exception) {
        return 0;
    }
}

/// One CHATHISTORY message reference: `*`, `timestamp=<server-time>`
/// or `msgid=<id>`.
struct HistoryRef {
    /// `"*"`, `"timestamp"` or `"msgid"`.
    string kind;
    /// Unix ms for `timestamp` refs.
    long ts;
    /// Id for `msgid` refs.
    string msgid;
    /// False when the token did not parse.
    bool ok;
}

/// Parses a CHATHISTORY reference token.
HistoryRef parseHistoryRef(string tok) @safe {
    HistoryRef r;
    if (tok == "*") { r.kind = "*"; r.ok = true; return r; }
    if (tok.startsWith("timestamp=")) {
        r.kind = "timestamp";
        r.ts = parseServerTime(tok["timestamp=".length .. $]);
        r.ok = r.ts > 0;
        return r;
    }
    if (tok.startsWith("msgid=")) {
        r.kind = "msgid";
        r.msgid = tok["msgid=".length .. $];
        r.ok = r.msgid.length > 0;
        return r;
    }
    return r;
}

/// `[HH:MM:SS]` UTC prefix ZNC-style for clients without `server-time`.
string playbackTimePrefix(long ms) @safe {
    import std.datetime : SysTime, UTC, DateTime;
    import std.format : format;
    const dt = cast(DateTime) SysTime.fromUnixTime(ms / 1000, UTC());
    return format("[%02d:%02d:%02d] ", dt.hour, dt.minute, dt.second);
}

/// Packs `tokens` into lines `prefixLine ~ tok1 ~ " " ~ tok2 ...` each at
/// most `maxLen` bytes (a single oversize token still gets its own line).
string[] chunkNames(string prefixLine, string[] tokens, size_t maxLen = 480) @safe pure {
    string[] lines;
    string cur = prefixLine;
    bool empty = true;
    foreach (tok; tokens) {
        if (!tok.length) continue;
        const need = empty ? tok.length : tok.length + 1;
        if (!empty && cur.length + need > maxLen) {
            lines ~= cur;
            cur = prefixLine;
            empty = true;
        }
        if (!empty) cur ~= " ";
        cur ~= tok;
        empty = false;
    }
    if (!empty) lines ~= cur;
    return lines;
}

/// Length of the leading prefix-character run of a NAMES token.
private size_t prefixRun(string tok, string prefixChars) @safe pure nothrow @nogc {
    size_t n = 0;
    outer: while (n < tok.length) {
        foreach (pc; prefixChars) {
            if (pc == tok[n]) { n++; continue outer; }
        }
        break;
    }
    return n;
}

/// Adapts a stored NAMES token (`@+nick!user@host`) to what the client
/// negotiated: one prefix char without `multi-prefix`, no `!user@host`
/// without `userhost-in-names`.
string adaptNameToken(string tok, bool multiPrefix, bool uhnames, string prefixChars) @safe pure {
    const run = prefixRun(tok, prefixChars);
    string prefix = multiPrefix ? tok[0 .. run] : (run ? tok[0 .. 1] : "");
    string body = tok[run .. $];
    if (!uhnames) {
        const bang = body.indexOf("!");
        if (bang > 0) body = body[0 .. bang];
    }
    return prefix ~ body;
}

/// Bare nick of a NAMES token (prefix chars and `!user@host` removed).
string stripPrefix(string tok, string prefixChars) @safe pure {
    auto body = tok[prefixRun(tok, prefixChars) .. $];
    const bang = body.indexOf("!");
    if (bang > 0) body = body[0 .. bang];
    return body;
}

/// Prefix characters from an ISUPPORT `PREFIX=(modes)chars` value.
string prefixCharsFromIsupport(string value) @safe pure {
    const close = value.indexOf(")");
    if (close >= 0 && close + 1 < value.length) return value[close + 1 .. $];
    return "~&@%+";
}

/// Groups compact events by buffer (`ch`, falling back to `n`), keeping
/// the input order inside each group and the first-seen order of groups.
Json[][string] groupByBuffer(Json[] events) @safe {
    Json[][string] groups;
    foreach (ev; events) {
        string key;
        if (ev.type != Json.Type.object) continue;
        if (auto ch = "ch" in ev) { if (ch.type == Json.Type.string) key = ch.get!string; }
        if (!key.length) { if (auto n = "n" in ev) { if (n.type == Json.Type.string) key = n.get!string; } }
        if (!key.length) continue;
        groups[key] ~= ev;
    }
    return groups;
}

/// Dedup key for a stored row. The server msgid (`m`) identifies one
/// upstream message across every copy the engine stored (live + each
/// `CHATHISTORY` backfill re-stores it with a fresh `eid`), so it must win
/// over `eid` — keying on `eid` first replays every backfilled message
/// twice (verified live: 200 playback rows, only 102 unique msgids).
string bncRowKey(Json ev) @safe {
    if (auto m = "m" in ev)
        if (m.type == Json.Type.string && m.get!string.length)
            return "m" ~ m.get!string;
    if (auto e = "eid" in ev)
        if (e.type == Json.Type.int_ && e.get!long > 0)
            return "e" ~ e.get!long.to!string;
    return "t" ~ ev["t"].toString() ~ "|" ~ ev["n"].toString() ~ "|" ~ ev["x"].toString();
}

/// True for a chat row the bouncer may replay (mirrors the Mongo
/// `CHAT_PAYLOAD_RE` window: `PRIVMSG`/`NOTICE` outside any phase).
bool isBncChatRow(Json ev) @safe {
    if (ev.type != Json.Type.object) return false;
    if (auto c = "c" in ev) {
        if (c.type != Json.Type.string) return false;
        const cmd = c.get!string;
        if (cmd != "PRIVMSG" && cmd != "NOTICE") return false;
    } else return false;
    return ev["phase"].type == Json.Type.undefined;
}

/// Filters a `getAfterEidForNetwork` page down to what a reconnecting
/// client actually missed. Backfill copies of messages the client already
/// saw live carry fresh eids but old timestamps — those (and only those)
/// are dropped via the `batch` + `seenTs` comparison, so genuinely missed
/// rows are kept even when mis-tagged with a batch marker (stuck engine
/// batch flag tagged every live row, and the old blanket `batch` skip
/// then delivered zero missed messages). `seenTs < 0` means the cursor's
/// timestamp is unknown: fall back to the old skip-all-batched behaviour.
/// Same-msgid live+backfill copies of one missed message collapse to one.
Json[] filterMissedRows(Json[] events, long seenTs) @safe {
    Json[] keep;
    bool[string] seenMsgid;
    foreach (ref ev; events) {
        if (!isBncChatRow(ev)) continue;
        if (ev["batch"].type != Json.Type.undefined) {
            if (seenTs < 0) continue;
            const t = ev["t"].type == Json.Type.int_ ? ev["t"].get!long : 0;
            if (t <= seenTs) continue;
        }
        const dk = bncRowKey(ev);
        if (dk in seenMsgid) continue;
        seenMsgid[dk] = true;
        keep ~= ev;
    }
    return keep;
}

/// Buffer keys of `events` in first-seen order (AA iteration order is
/// unspecified; replay must be deterministic).
string[] bufferOrder(Json[] events) @safe {
    string[] order;
    bool[string] seen;
    foreach (ev; events) {
        if (ev.type != Json.Type.object) continue;
        string key;
        if (auto ch = "ch" in ev) { if (ch.type == Json.Type.string) key = ch.get!string; }
        if (!key.length) { if (auto n = "n" in ev) { if (n.type == Json.Type.string) key = n.get!string; } }
        if (!key.length || key in seen) continue;
        seen[key] = true;
        order ~= key;
    }
    return order;
}
