/**
 * Pure parsing, IP grouping and Z-line mask matching for FiberEye.
 *
 * The connect-notice parser, the connect-class filter and the private-IP
 * test are reused from `ircfiber.logs.format` rather than re-implemented —
 * both bots read the same InspIRCd snotices. What is new here is the quit
 * notice (snomask `q`, which the #staff bot never subscribed to), the
 * nick-change notice (snomask `n`/`N`, which is how a session's nick
 * stops being frozen at the one it registered with), the IPv6 `/64`
 * grouping FiberEye counts and bans on, and the predicate that decides
 * whether a live Z-line covers a given visitor's address.
 *
 * No IO — covered by `tests/fibereye_test.d`.
 */
module ircfiber.fibereye.format;

import std.conv : to;
import std.path : globMatch;
import std.string : indexOf, lastIndexOf, split, startsWith, endsWith, strip, toLower;

import ircfiber.support.json : sanitizeLine;

public import ircfiber.ipintel.cidr : expandIpv6, parseIpv4, hextetString, sameIpv6Prefix;
public import ircfiber.logs.format : parseConnectNotice, ConnectNotice, classIgnored,
    isPrivateIp;

/// A parsed `*** QUIT: Client exiting: nick!ident@host (ip) [reason]`
/// server notice (snomask `q`).
struct QuitNotice {
    /// True when the notice was a local quit notice and yielded a nick.
    bool ok;
    /// Client mask parts.
    string nick, ident, host;
    /// Real (uncloaked) IP as the ircd sees it.
    string ip;
    /// Quit reason, brackets stripped (may be empty).
    string reason;
}

/// Parses an InspIRCd 4 local-quit server notice as delivered to an opered
/// client with snomask `q`:
///
///   `*** QUIT: Client exiting: alice!~alice@h.example (203.0.113.7) [Quit: leaving]`
///
/// The reason and the IP are peeled off the tail before the mask is split,
/// in the same order as `parseConnectNotice`, so an IPv6 address and a
/// reason containing brackets or parentheses both survive. Anything else
/// — a connect notice, a remote quit, an unrelated snotice — returns
/// `ok = false`.
QuitNotice parseQuitNotice(string text) @safe pure {
    QuitNotice q;
    auto t = text.strip();
    if (t.startsWith("*** ")) t = t[4 .. $].strip();
    if (t.startsWith("QUIT: ")) t = t["QUIT: ".length .. $].strip();

    enum PREFIX = "Client exiting: ";
    if (!t.startsWith(PREFIX)) return q;
    auto tail = t[PREFIX.length .. $].strip();

    // First, not last: the mask and the IP contain no spaces, so the first
    // " [" after them opens the reason — which may itself contain brackets
    // and parentheses ("[Quit: bye (really)]").
    const lb = tail.indexOf(" [");
    if (lb >= 0 && tail.endsWith("]")) {
        auto rn = tail[lb + 2 .. $ - 1];
        // InspIRCd terminates attacker-supplied text with \x0F (reset).
        while (rn.length && rn[$ - 1] == '\x0F') rn = rn[0 .. $ - 1];
        q.reason = rn;
        tail = tail[0 .. lb].strip();
    }

    const lp = tail.indexOf(" (");
    if (lp >= 0 && tail.endsWith(")")) {
        q.ip = tail[lp + 2 .. $ - 1];
        tail = tail[0 .. lp].strip();
    }

    const mask = tail.strip();
    const bang = mask.indexOf('!');
    const at = mask.lastIndexOf('@');
    if (!(bang > 0 && bang < at)) return q;
    q.nick = mask[0 .. bang];
    q.ident = mask[bang + 1 .. at];
    q.host = mask[at + 1 .. $];

    q.nick = sanitizeLine(q.nick);
    q.ident = sanitizeLine(q.ident);
    q.host = sanitizeLine(q.host);
    q.ip = sanitizeLine(q.ip);
    q.reason = sanitizeLine(q.reason);
    q.ok = q.nick.length > 0;
    return q;
}

/// A parsed `*** NICK: User old!ident@host (ip) changed their nickname to
/// new` server notice (snomask `n`; `*** REMOTENICK:` on snomask `N` when
/// the client sits on a linked server).
struct NickNotice {
    /// True when the notice was a nick-change notice and yielded both nicks.
    bool ok;
    /// Nick before and after the change.
    string oldNick, newNick;
    /// Mask parts. InspIRCd's `seenicks` prints the **real** user@host
    /// (`GetRealUserHost()`) here, not the cloak the connect notice shows.
    string ident, host;
    /// Real (uncloaked) IP as the ircd sees it.
    string ip;
    /// True when the notice came from a linked server (`REMOTENICK`).
    bool remote;
}

/// Parses an InspIRCd 4 nick-change server notice as delivered to an
/// opered client with snomask `n` (or `N`):
///
///   `*** NICK: User i!~incog@h.example (94.8.165.152) changed their nickname to incog`
///
/// The `NICK:`/`REMOTENICK:` label is mandatory, so no other snotice can
/// be mistaken for a rename. The IP is peeled off before the mask is
/// split — in the same order as `parseQuitNotice`, so an IPv6 address
/// survives — and the new nick is the first word after the fixed
/// `changed their nickname to` marker. Anything else returns `ok = false`.
///
/// The notice only exists when the ircd loads the `seenicks` module and
/// the oper class allows the snomask; both are wired in
/// `deploy/roles/ircd/templates/{modules,opers}.conf.j2`.
NickNotice parseNickNotice(string text) @safe pure {
    NickNotice n;
    auto t = text.strip();
    if (t.startsWith("*** ")) t = t[4 .. $].strip();
    if (t.startsWith("NICK: ")) t = t["NICK: ".length .. $].strip();
    else if (t.startsWith("REMOTENICK: ")) {
        n.remote = true;
        t = t["REMOTENICK: ".length .. $].strip();
    } else return n;

    enum PREFIX = "User ";
    if (!t.startsWith(PREFIX)) return n;
    auto head = t[PREFIX.length .. $].strip();

    enum MARKER = " changed their nickname to ";
    const mk = head.indexOf(MARKER);
    if (mk <= 0) return n;
    auto tail = head[mk + MARKER.length .. $].strip();
    head = head[0 .. mk].strip();
    // A nick carries no whitespace, so anything trailing it (a future
    // suffix, a stacked "(last message repeated N times)") is dropped
    // rather than stored as part of the new nick.
    const sp = tail.indexOf(' ');
    if (sp >= 0) tail = tail[0 .. sp];
    n.newNick = tail;

    const lp = head.indexOf(" (");
    if (lp >= 0 && head.endsWith(")")) {
        n.ip = head[lp + 2 .. $ - 1];
        head = head[0 .. lp].strip();
    }

    const mask = head.strip();
    const bang = mask.indexOf('!');
    const at = mask.lastIndexOf('@');
    if (!(bang > 0 && bang < at)) return n;
    n.oldNick = mask[0 .. bang];
    n.ident = mask[bang + 1 .. at];
    n.host = mask[at + 1 .. $];

    n.oldNick = sanitizeLine(n.oldNick);
    n.newNick = sanitizeLine(n.newNick);
    n.ident = sanitizeLine(n.ident);
    n.host = sanitizeLine(n.host);
    n.ip = sanitizeLine(n.ip);
    n.ok = n.oldNick.length > 0 && n.newNick.length > 0;
    return n;
}

/// WHOX query type FiberEye stamps on its sweep, echoed back in every
/// `354` so a reply to somebody else's WHO can never be mistaken for one
/// of ours. InspIRCd drops a query type longer than three characters.
enum WHOX_QUERYTYPE = "fe";

/// The WHOX request FiberEye sends: no matching flags, fields
/// `t` (query type), `i` (IP), `n` (nick), `a` (services account).
///
/// InspIRCd emits the fields in its own canonical order
/// (`whox_field_order = "tcuihsnfdlaor"`, modules/core/who.cpp), NOT in
/// the order they were asked for, so `354` always arrives as
/// `<me> <querytype> <ip> <nick> <account>`.
enum WHOX_FLAGS = "%tina," ~ WHOX_QUERYTYPE;

/// What InspIRCd substitutes for the IP of a user the requester may not
/// see (`source_can_see_target` is false without `users/auspex`). It is a
/// placeholder, never a real address — treating it as one would group
/// every client on the network under a single fictional IP.
enum WHOX_IP_HIDDEN = "255.255.255.255";

/// One live client from a WHOX (`354`) reply.
struct WhoEntry {
    /// True when the line was one of our `354`s and yielded a nick.
    bool ok;
    /// Nick in force right now.
    string nick;
    /// Real IP, or `WHOX_IP_HIDDEN` when the ircd refused it.
    string ip;
    /// Services account, empty when the client is not logged in (the wire
    /// value for that is the literal `0`).
    string account;
    /// True when `ip` is the placeholder rather than an address.
    bool ipHidden;
}

/// Parses one `354` (RPL_WHOSPCRPL) reply to `WHOX_FLAGS`.
///
/// `params` is the numeric's parameter list, so `params[0]` is our own
/// nick and the fields follow. A line whose query type is not ours — any
/// other WHOX in flight — returns `ok = false`.
WhoEntry parseWhoxReply(const string[] params) @safe pure {
    WhoEntry w;
    if (params.length < 5) return w;
    if (params[1].strip() != WHOX_QUERYTYPE) return w;
    w.ip = sanitizeLine(params[2].strip());
    w.nick = sanitizeLine(params[3].strip());
    const acct = sanitizeLine(params[4].strip());
    w.account = acct == "0" ? "" : acct;
    w.ipHidden = w.ip == WHOX_IP_HIDDEN || !w.ip.length;
    w.ok = w.nick.length > 0;
    return w;
}

/// The unit FiberEye counts and bans: the exact address for IPv4, the
/// `/64` for IPv6 — the observed flood rotates addresses inside one /64.
///
/// An IPv4-mapped IPv6 address is reduced to the embedded IPv4 address,
/// and loopback/private/unparsable input is returned stripped but
/// otherwise unchanged, so a bad parse can never widen into a mask that
/// covers more than the address it came from.
///
///   `76.32.236.21`                              -> `76.32.236.21`
///   `2603:8001:98f0:1530:691d:b048:970e:1304`   -> `2603:8001:98f0:1530::/64`
///   `::1`                                       -> `::1`
string ipGroup(string ip) @safe pure {
    const s = ip.strip();
    if (!s.length) return s;
    if (s.indexOf(':') < 0) return s;               // IPv4 or a hostname
    // ::ffff:203.0.113.7 → the embedded v4 address is the real client.
    const lastColon = s.lastIndexOf(':');
    if (lastColon >= 0 && s[lastColon + 1 .. $].indexOf('.') >= 0) {
        ubyte[4] o;
        if (parseIpv4(s[lastColon + 1 .. $], o)) return s[lastColon + 1 .. $].strip();
    }
    if (isPrivateIp(s)) return s;
    ushort[8] p;
    if (!expandIpv6(s, p)) return s;
    if (p[0] == 0 && p[1] == 0 && p[2] == 0 && p[3] == 0) return s;
    return hextetString(p[0]) ~ ":" ~ hextetString(p[1]) ~ ":"
        ~ hextetString(p[2]) ~ ":" ~ hextetString(p[3]) ~ "::/64";
}

/// True when an ircd Z-line mask covers `ip`. Handles an exact address, a
/// `*`/`?` glob and an `a:b:c:d::/64` or `198.51.100.0/24` CIDR.
///
/// A catch-all mask is rejected outright: `*`, `0.0.0.0/0` and `::/0` all
/// return false, because the tokenless `/unban` page treats a match as
/// "this visitor's own ban" and must never offer to lift a network-wide
/// Z-line on behalf of one visitor.
bool zlineMatches(string mask, string ip) @safe pure {
    const m = mask.strip();
    const target = ip.strip();
    if (!m.length || !target.length) return false;
    if (m == "*" || m == "*@*" || m == "*!*@*") return false;

    const slash = m.lastIndexOf('/');
    if (slash > 0) {
        const net = m[0 .. slash].strip();
        const bitsText = m[slash + 1 .. $].strip();
        int bits;
        try bits = bitsText.to!int;
        catch (Exception) return false;
        if (bits <= 0) return false;                 // catch-all
        if (net.indexOf(':') >= 0) {
            if (bits > 128) return false;
            ushort[8] a, b;
            if (!expandIpv6(net, a)) return false;
            if (!expandIpv6(target, b)) return false;
            return sameIpv6Prefix(a, b, bits);
        }
        if (bits > 32) return false;
        ubyte[4] na, nb;
        if (!parseIpv4(net, na)) return false;
        if (!parseIpv4(target, nb)) return false;
        const uint va = (na[0] << 24) | (na[1] << 16) | (na[2] << 8) | na[3];
        const uint vb = (nb[0] << 24) | (nb[1] << 16) | (nb[2] << 8) | nb[3];
        const uint bitmask = bits == 32 ? 0xFFFF_FFFFu : ~((1u << (32 - bits)) - 1);
        return (va & bitmask) == (vb & bitmask);
    }

    if (m.indexOf('*') >= 0 || m.indexOf('?') >= 0) return globMatch(target, m);

    if (m == target) return true;
    // Two spellings of the same IPv6 address ("2001:db8::1" vs the
    // expanded form the ircd may print) still describe one host.
    if (m.indexOf(':') >= 0 && target.indexOf(':') >= 0) {
        ushort[8] a, b;
        if (expandIpv6(m, a) && expandIpv6(target, b)) return a == b;
    }
    return false;
}

/// True when `entry` is storable in the admin-managed exemption list: an
/// exact IP address, or a CIDR no wider than `/16` (v4) or `/32` (v6).
///
/// An exemption is a permanent hole — an exempt group is never counted, so
/// it can never be banned however hard it floods. Globs and catch-alls are
/// rejected even though `zlineMatches` would honour them at match time,
/// because a stored `*` would silently disable FiberEye for the whole
/// network. Only the API path validates; the env baseline comes from the
/// reviewed deploy and is trusted as written.
bool validExemptEntry(string entry) @safe pure {
    const e = entry.strip();
    if (!e.length || e.length > 128) return false;
    if (e != entry) return false;                    // stray surrounding space
    foreach (dchar c; e) {
        if (c <= ' ' || c == 0x7F) return false;     // whitespace + control
        if (c == ',' || c == '*' || c == '?') return false;
    }

    const slash = e.lastIndexOf('/');
    if (slash < 0) {
        ubyte[4] v4;
        if (parseIpv4(e, v4)) return true;
        ushort[8] v6;
        return e.indexOf(':') >= 0 && expandIpv6(e, v6);
    }

    const net = e[0 .. slash];
    const bitsText = e[slash + 1 .. $];
    if (!net.length || !bitsText.length) return false;
    int bits;
    try bits = bitsText.to!int;
    catch (Exception) return false;
    if (net.indexOf(':') >= 0) {
        ushort[8] v6;
        if (!expandIpv6(net, v6)) return false;
        return bits >= 32 && bits <= 128;
    }
    ubyte[4] v4;
    if (!parseIpv4(net, v4)) return false;
    return bits >= 16 && bits <= 32;
}

/// True when `entry` is storable in the admin-managed nick exemption list:
/// an exact IRC nick or a glob (`*`/`?`) with at least two literal
/// characters — `p34c3*` covers bouncer alts like `p34c3_` and `p34c3_e5eb`.
///
/// A bare `*` (or any entry without literal content) is refused: an exempt
/// nick is never counted, so a catch-all would silently disable FiberEye
/// for the whole network — the same reason `validExemptEntry` refuses
/// globs for addresses. Matching is case-insensitive (IRC nicks are), so
/// validation does not fold case, only de-duplication does.
bool validExemptNick(string entry) @safe pure {
    const e = entry.strip();
    if (!e.length || e.length > 32) return false;
    if (e != entry) return false;                    // stray surrounding space
    size_t literal;
    foreach (i, dchar c; e) {
        if (c <= ' ' || c == 0x7F) return false;     // whitespace + control
        if (c == ',' || c == '!' || c == '@' || c == '.' || c == ':' || c == '#' || c == '&') return false;
        if (c == '*' || c == '?') continue;
        // IRC nick charset (cf. `isValidIrcNick`): letters and
        // "[]\\`_^{|}" anywhere, digits and '-' past the first character.
        // An exemption is matched, never registered, so a digit or '-'
        // first is merely dead, not dangerous — but refuse it anyway so a
        // typo does not file as an exemption that can never fire.
        const letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
        const special = c == '[' || c == ']' || c == '\\' || c == '`'
                     || c == '_' || c == '^' || c == '{' || c == '|' || c == '}';
        if (letter || special) { literal++; continue; }
        if (i > 0 && ((c >= '0' && c <= '9') || c == '-')) { literal++; continue; }
        return false;
    }
    return literal >= 2;
}

/// True when nick exemption `entry` covers `nick`. Case-insensitive;
/// globs go through the same matcher Z-line masks use.
bool nickExemptMatch(string entry, string nick) @safe pure {
    const e = entry.strip();
    const n = nick.strip();
    if (!e.length || !n.length) return false;
    // Belt to the validator's braces: an entry with no literal content
    // must never match, however it got stored.
    bool literal;
    foreach (dchar c; e) if (c != '*' && c != '?') { literal = true; break; }
    if (!literal) return false;
    if (e.indexOf('*') < 0 && e.indexOf('?') < 0)
        return e.toLower() == n.toLower();
    return globMatch(n.toLower(), e.toLower());
}
