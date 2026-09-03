/**
 * Pure IRC wire helpers for the bouncer listener. No I/O — every function
 * here is exercised by `tests/bnc_wire_test.d`.
 */
module ircfiber.bnc.wire;

import std.string : indexOf, toUpper, split, strip, startsWith;
import std.conv : to;
import std.array : appender, Appender;
import std.algorithm : canFind, max;
import vibe.data.json : Json;

/// Parsed `PASS` value. IRCCloud accepts `bnc:<token>` and
/// `bnc@<clientid>:<token>`.
struct BncPass {
    /// Optional per-device id used for backlog replay ("" when absent).
    string clientId;
    /// Network password token.
    string token;
    /// False when the value does not match either accepted form.
    bool ok;
}

/// True for `[A-Za-z0-9_.:-]`.
private bool isClientIdChar(char c) @safe pure nothrow @nogc {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
        || c == '_' || c == '.' || c == ':' || c == '-';
}

/// Splits a raw `PASS` argument into clientid + token.
BncPass parseBncPass(string raw) @safe pure {
    BncPass r;
    const colon = raw.indexOf(":");
    if (colon < 0) return r;
    const left = raw[0 .. colon];
    const token = raw[colon + 1 .. $];
    if (!token.length) return r;
    if (left == "bnc") {
        r.token = token;
        r.ok = true;
        return r;
    }
    if (!left.startsWith("bnc@")) return r;
    const cid = left[4 .. $];
    if (cid.length == 0 || cid.length > 64) return r;
    foreach (c; cid) if (!isClientIdChar(c)) return r;
    r.clientId = cid;
    r.token = token;
    r.ok = true;
    return r;
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
