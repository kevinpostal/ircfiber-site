/**
 * Pure parsing and formatting for the `#staff` announcements: the
 * InspIRCd connect server-notice parser, the private-IP test, the
 * IP-intelligence clause builders and one IRC line (or two) per outbox
 * event. No IO — covered by `tests/logs_format_test.d`.
 *
 * `#staff` is oper-only (`+O`), so unlike the #support bot these lines
 * deliberately carry the full IP, the full e-mail address and the geo/ASN
 * report. Every field still goes through `sanitizeLine` — a realname or
 * error string is attacker-controlled text that must never carry CR/LF or
 * IRC formatting bytes into the channel.
 */
module ircfiber.logs.format;

import std.conv : to;
import std.string : endsWith, indexOf, lastIndexOf, split, startsWith, strip, toLower;
import std.uni : icmp;

import ircfiber.ipintel.record : IpIntel;
import ircfiber.logs.events : LogEvent;
import ircfiber.support.format : clipBytes, truncateText;
import ircfiber.support.json : sanitizeLine;

/// Hard cap for one announcement line (bytes, before the PRIVMSG prefix).
enum LOGS_LINE_MAX_BYTES = 400;
/// Mail failure text length (code points) shown on IRC.
enum LOGS_ERROR_MAX_CHARS = 120;
/// GECOS length (code points) shown on IRC.
enum LOGS_REALNAME_MAX_CHARS = 60;

/// A parsed `*** Client connecting on port …` server notice.
struct ConnectNotice {
    /// True when the notice was a connect notice and yielded a nick.
    bool ok;
    /// Server port the client connected to.
    ushort port;
    /// ircd connect class the client landed in.
    string connClass;
    /// Client mask parts.
    string nick, ident, host;
    /// Real (uncloaked) IP as the ircd sees it.
    string ip;
    /// GECOS.
    string realname;
}

/// Parses an InspIRCd 4 connect server notice as delivered to an opered
/// client with snomask `c`:
///
///   `*** Client connecting on port 6697 (class main): alice!~alice@h.example (203.0.113.7) [Alice]`
///
/// The realname and the IP are peeled off the tail before the mask is
/// split, so an IPv6 address and a realname containing brackets or
/// parentheses both survive. Any other server notice returns `ok = false`.
ConnectNotice parseConnectNotice(string text) @safe pure {
    ConnectNotice c;
    auto t = text.strip();
    if (t.startsWith("*** ")) t = t[4 .. $].strip();
    if (t.startsWith("CONNECT: ")) t = t["CONNECT: ".length .. $].strip();

    enum PREFIX = "Client connecting on port ";
    if (!t.startsWith(PREFIX)) return c;
    t = t[PREFIX.length .. $];

    size_t d = 0;
    while (d < t.length && t[d] >= '0' && t[d] <= '9') d++;
    if (d == 0) return c;
    uint port;
    try port = t[0 .. d].to!uint;
    catch (Exception) return c;
    if (port > ushort.max) return c;
    c.port = cast(ushort) port;

    t = t[d .. $].strip();
    enum CLASS = "(class ";
    if (!t.startsWith(CLASS)) return c;
    auto rest = t[CLASS.length .. $];
    const close = rest.indexOf("): ");
    if (close < 0) return c;
    c.connClass = rest[0 .. close];
    auto tail = rest[close + 3 .. $].strip();

    // First, not last: the mask and the IP contain no spaces, so the first
    // " [" after them opens the GECOS — which may itself contain brackets
    // and parentheses ("Al (ice) [x]").
    const lb = tail.indexOf(" [");
    if (lb >= 0 && tail.endsWith("]")) {
        auto rn = tail[lb + 2 .. $ - 1];
        // InspIRCd terminates the GECOS with \x0F (reset) inside the brackets.
        while (rn.length && rn[$ - 1] == '\x0F') rn = rn[0 .. $ - 1];
        c.realname = rn;
        tail = tail[0 .. lb].strip();
    }

    const lp = tail.indexOf(" (");
    if (lp >= 0 && tail.endsWith(")")) {
        c.ip = tail[lp + 2 .. $ - 1];
        tail = tail[0 .. lp].strip();
    }

    const mask = tail.strip();
    const bang = mask.indexOf('!');
    const at = mask.lastIndexOf('@');
    if (!(bang > 0 && bang < at)) return c;
    c.nick = mask[0 .. bang];
    c.ident = mask[bang + 1 .. at];
    c.host = mask[at + 1 .. $];

    c.connClass = sanitizeLine(c.connClass);
    c.nick = sanitizeLine(c.nick);
    c.ident = sanitizeLine(c.ident);
    c.host = sanitizeLine(c.host);
    c.ip = sanitizeLine(c.ip);
    c.realname = sanitizeLine(c.realname);
    c.ok = c.nick.length > 0;
    return c;
}

/// True when `connClass` matches one of `ignore` (case-insensitively).
/// Empty entries are skipped, so an empty configured list ignores nothing.
bool classIgnored(string connClass, const string[] ignore) @safe pure {
    const c = connClass.strip();
    if (!c.length) return false;
    foreach (entry; ignore) {
        const e = entry.strip();
        if (!e.length) continue;
        if (icmp(e, c) == 0) return true;
    }
    return false;
}

private bool isHexish(string s) @safe pure nothrow @nogc {
    foreach (ch; s) {
        const hex = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
        if (!hex && ch != ':' && ch != '.' && ch != '%') return false;
    }
    return true;
}

/// True for addresses no public geo provider can resolve: loopback, RFC1918,
/// CGNAT, link-local, multicast/reserved, ULA — and anything unparsable
/// (empty, `unknown`, a hostname), so the bot never spends a lookup on it.
bool isPrivateIp(string ip) @safe pure {
    const s = ip.strip();
    if (!s.length) return true;
    if (s.indexOf(':') >= 0) {
        const l = s.toLower();
        if (!isHexish(l)) return true;
        if (l == "::1" || l == "::") return true;
        // IPv4-mapped (::ffff:203.0.113.7) → judge the embedded v4 address.
        const lastColon = l.lastIndexOf(':');
        if (lastColon >= 0 && l[lastColon + 1 .. $].indexOf('.') >= 0)
            return isPrivateIp(l[lastColon + 1 .. $]);
        if (l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return true;
        if (l.startsWith("ff")) return true;   // multicast
        return false;
    }
    auto parts = s.split('.');
    if (parts.length != 4) return true;
    ubyte[4] o;
    foreach (i, p; parts) {
        if (!p.length || p.length > 3) return true;
        foreach (ch; p) if (ch < '0' || ch > '9') return true;
        uint v;
        try v = p.to!uint;
        catch (Exception) return true;
        if (v > 255) return true;
        o[i] = cast(ubyte) v;
    }
    if (o[0] == 0 || o[0] == 10 || o[0] == 127) return true;
    if (o[0] == 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] == 192 && o[1] == 168) return true;
    if (o[0] == 100 && o[1] >= 64 && o[1] <= 127) return true;
    if (o[0] == 169 && o[1] == 254) return true;
    if (o[0] >= 224) return true;
    return false;
}

private string joinClauses(const string[] parts, string sep) @safe pure {
    string out_;
    foreach (p; parts) {
        if (!p.length) continue;
        if (out_.length) out_ ~= sep;
        out_ ~= p;
    }
    return out_;
}

/// `Austin, Texas, US · AS15169 Google LLC · vpn(Mullvad)+hosting · risk 73 · prefix 185.65.134.0/24 · America/Chicago`
/// Missing fields are skipped rather than rendered as empty separators.
/// No coordinates: `docs/IP_INTEL.md` §4 rule 4.
string geoDetail(const IpIntel r) @safe pure {
    const place = joinClauses([sanitizeLine(r.geo.city), sanitizeLine(r.geo.region),
        sanitizeLine(r.geo.countryCode)], ", ");
    const asn = joinClauses([sanitizeLine(r.network.asn), sanitizeLine(r.network.asName)], " ");
    const risk = r.reputation.riskScore >= 0 ? "risk " ~ r.reputation.riskScore.to!string : "";
    const prefix = r.identity.prefix.length ? "prefix " ~ sanitizeLine(r.identity.prefix) : "";
    return joinClauses([place, asn, sanitizeLine(r.flagsLabel()), risk, prefix,
        sanitizeLine(r.geo.timezone)], " · ");
}

/// `Austin, US` / `US` / `Austin` / `""`.
string geoShort(const IpIntel r) @safe pure {
    return joinClauses([sanitizeLine(r.geo.city), sanitizeLine(r.geo.countryCode)], ", ");
}

/// True when the record carries anything worth printing.
private bool hasIntel(const IpIntel r) @safe pure nothrow {
    return r.provenance.length > 0;
}

/// The trailing intel clause of a one-line event (signup) or of the
/// connect headline. `detailWhenFirst` is false for `irc_connect`, whose
/// detail is carried by the follow-up `↳` line instead.
private string geoClause(string ip, const IpIntel r, bool firstSighting, bool detailWhenFirst) @safe pure {
    if (!ip.strip().length) return "";
    if (isPrivateIp(ip)) return " · private IP";
    if (!hasIntel(r)) return " · geo unavailable";
    if (firstSighting) {
        if (!detailWhenFirst) return "";
        const d = geoDetail(r);
        return d.length ? " · " ~ d : "";
    }
    const s = geoShort(r);
    string out_ = s.length ? " · known IP (" ~ s ~ ")" : " · known IP";
    if (r.reputation.sessionCount > 1) out_ ~= " · " ~ r.reputation.sessionCount.to!string ~ " sessions";
    return out_;
}

private string finish(string line) @safe pure nothrow @nogc {
    return clipBytes(line, LOGS_LINE_MAX_BYTES);
}

/// Human size for a backup archive: `112.4 MB` / `1.5 KB` / `512 B`
/// (one decimal at MB/KB, integer bytes below 1 KB, `0 B` when negative).
string backupSize(long bytes) @safe pure {
    if (bytes < 0) bytes = 0;
    if (bytes >= 1024 * 1024) {
        const tenths = (bytes * 10 + 524_288) / 1_048_576;
        return (tenths / 10).to!string ~ "." ~ (tenths % 10).to!string ~ " MB";
    }
    if (bytes >= 1024) {
        const tenths = (bytes * 10 + 512) / 1024;
        return (tenths / 10).to!string ~ "." ~ (tenths % 10).to!string ~ " KB";
    }
    return bytes.to!string ~ " B";
}

private string ircName(string name) @safe pure {
    const n = sanitizeLine(name);
    return n.length ? n : "someone";
}

/// Attribution clause appended to a foreign (non-FiberEye) X-line
/// announcement so #staff can see which nick(s) tripped the ban: the
/// ircd's own `m_connectban` notice carries only the IP mask, never a nick.
/// `nicks` is newest-first (still-connected sessions first, then the newest
/// stored rows); comparison is case-insensitive because IRC nicks are, the
/// list is capped at five, and every entry goes through `sanitizeLine`.
/// Empty when nothing is known — the caller then appends nothing and the
/// raw notice is announced as-is.
string xlineAttribution(const string[] nicks, string account) @safe pure {
    string[] uniq;
    foreach (n; nicks) {
        if (uniq.length >= 5) break;
        const s = sanitizeLine(n);
        if (!s.length) continue;
        bool dup = false;
        foreach (u; uniq) if (icmp(u, s) == 0) { dup = true; break; }
        if (!dup) uniq ~= s;
    }
    const who = sanitizeLine(account);
    if (!uniq.length && !who.length) return "";
    string out_ = " · trigger: " ~ joinClauses(uniq, ", ");
    if (who.length) out_ ~= (uniq.length ? " " : "") ~ "[" ~ who ~ "]";
    return out_;
}

/// One or two IRC lines per event; empty for unknown event types.
///
/// - signup:      `Signup: alice <alice@example.com> · 203.0.113.7 · Austin, Texas, US · AS15169 Google LLC · …`
/// - mail:        `Email sent: signup_verification → alice@example.com (alice) · resend · 412ms`
///                `Email FAILED: … · resend · <error>`
/// - irc_connect: `IRC connect: alice!~alice@h.example (203.0.113.7) · class main · port 6697 · [Alice]`
///                plus `↳ 203.0.113.7 · <geo detail>` the first time the IP is seen
/// - notice:      `Notice from zodiac: maintenance in 10 min`
/// - backup:      `Backup mongo ok: mongo-20260907-031700.archive.gz · 112.4 MB · 45231ms`
///                `Backup mongo FAILED at verify: <error>`
string[] formatLogEvent(const LogEvent ev, const IpIntel intel, bool firstSighting) @safe pure {
    const ip = sanitizeLine(ev.ip);
    switch (ev.type) {
        case "signup": {
            string line = "Signup: " ~ ircName(ev.username);
            const email = sanitizeLine(ev.email);
            if (email.length) line ~= " <" ~ email ~ ">";
            if (ip.length) line ~= " · " ~ ip;
            line ~= geoClause(ip, intel, firstSighting, true);
            return [finish(line)];
        }
        case "mail": {
            const failed = sanitizeLine(ev.status) == "failed";
            string line = failed ? "Email FAILED: " : "Email sent: ";
            const kind = sanitizeLine(ev.kind);
            line ~= kind.length ? kind : "email";
            const to_ = sanitizeLine(ev.email);
            if (to_.length) line ~= " → " ~ to_;
            const user = sanitizeLine(ev.username);
            if (user.length) line ~= " (" ~ user ~ ")";
            const provider = sanitizeLine(ev.provider);
            if (provider.length) line ~= " · " ~ provider;
            if (failed) {
                const err = truncateText(sanitizeLine(ev.error), LOGS_ERROR_MAX_CHARS);
                if (err.length) line ~= " · " ~ err;
            } else if (ev.durationMs > 0) {
                line ~= " · " ~ ev.durationMs.to!string ~ "ms";
            }
            return [finish(line)];
        }
        case "irc_connect": {
            const nick = sanitizeLine(ev.nick);
            if (!nick.length) return [];
            string mask = nick;
            const ident = sanitizeLine(ev.ident);
            const host = sanitizeLine(ev.host);
            if (ident.length) mask ~= "!" ~ ident;
            if (host.length) mask ~= "@" ~ host;
            string line = "IRC connect: " ~ mask;
            if (ip.length) line ~= " (" ~ ip ~ ")";
            const cls = sanitizeLine(ev.connClass);
            if (cls.length) line ~= " · class " ~ cls;
            if (ev.port > 0) line ~= " · port " ~ ev.port.to!string;
            const real_ = truncateText(sanitizeLine(ev.realname), LOGS_REALNAME_MAX_CHARS);
            if (real_.length) line ~= " · [" ~ real_ ~ "]";
            line ~= geoClause(ip, intel, firstSighting, false);
            string[] lines = [finish(line)];
            if (ip.length && firstSighting && hasIntel(intel) && !isPrivateIp(ip)) {
                const d = geoDetail(intel);
                if (d.length) lines ~= finish("↳ " ~ ip ~ " · " ~ d);
            }
            return lines;
        }
        case "notice": {
            const text = sanitizeLine(ev.text);
            if (!text.length) return [];
            return [finish("Notice from " ~ ircName(ev.actor) ~ ": " ~ text)];
        }
        case "backup": {
            const kind = sanitizeLine(ev.kind);
            const label = kind.length ? kind : "backup";
            if (sanitizeLine(ev.status) == "ok") {
                string line = "Backup " ~ label ~ " ok:";
                const file = sanitizeLine(ev.file);
                if (file.length) line ~= " " ~ file ~ " ·";
                line ~= " " ~ backupSize(ev.fileBytes);
                if (ev.durationMs > 0) line ~= " · " ~ ev.durationMs.to!string ~ "ms";
                return [finish(line)];
            }
            const stage = sanitizeLine(ev.stage);
            const msg = truncateText(sanitizeLine(ev.error.length ? ev.error : ev.text),
                LOGS_ERROR_MAX_CHARS);
            return [finish("Backup " ~ label ~ " FAILED at "
                ~ (stage.length ? stage : "unknown") ~ ": " ~ msg)];
        }
        default:
            return [];
    }
}
