/**
 * Address parsing and CIDR containment for both IP families.
 *
 * `expandIpv6` / `parseIpv4` moved here from `ircfiber.fibereye.format`
 * (which imports them back): FiberEye's `/64` grouping and Z-line
 * matching, and the RDAP bootstrap's per-registry CIDR lists, need the
 * same parsers. No IO — covered by `tests/ipintel_test.d`.
 */
module ircfiber.ipintel.cidr;

import std.conv : to;
import std.string : indexOf, lastIndexOf, split, strip, toLower;

/// Parses a dotted-quad into its four octets. False for anything else.
bool parseIpv4(string ip, out ubyte[4] octets) @safe pure {
    auto parts = ip.strip().split('.');
    if (parts.length != 4) return false;
    foreach (i, p; parts) {
        if (!p.length || p.length > 3) return false;
        foreach (ch; p) if (ch < '0' || ch > '9') return false;
        uint v;
        try v = p.to!uint;
        catch (Exception) return false;
        if (v > 255) return false;
        octets[i] = cast(ubyte) v;
    }
    return true;
}

/// Expands an IPv6 textual address (including the `::` elision and a
/// trailing embedded IPv4 quad) to eight hextets. False when `ip` is not
/// a well-formed IPv6 address.
bool expandIpv6(string ip, out ushort[8] parts) @safe pure {
    parts[] = 0;
    auto s = ip.strip().toLower();
    if (!s.length) return false;
    // Drop a zone index ("fe80::1%eth0") — irrelevant to grouping.
    const pct = s.indexOf('%');
    if (pct >= 0) s = s[0 .. pct];
    if (s.indexOf(':') < 0) return false;

    // A trailing dotted quad is rewritten as its two hextets, so the
    // generic `::`-elision path below handles every remaining form.
    const lastColon = s.lastIndexOf(':');
    if (lastColon >= 0 && s[lastColon + 1 .. $].indexOf('.') >= 0) {
        ubyte[4] o;
        if (!parseIpv4(s[lastColon + 1 .. $], o)) return false;
        s = s[0 .. lastColon + 1]
            ~ hextetString(cast(ushort)((o[0] << 8) | o[1])) ~ ":"
            ~ hextetString(cast(ushort)((o[2] << 8) | o[3]));
    }

    string head = s, tailStr;
    bool elided;
    const dc = s.indexOf("::");
    if (dc >= 0) {
        elided = true;
        head = s[0 .. dc];
        tailStr = s[dc + 2 .. $];
        // A second "::" is invalid.
        if (tailStr.indexOf("::") >= 0) return false;
    }

    static bool hextets(string spec, out ushort[] outParts) @safe pure {
        outParts = null;
        if (!spec.length) return true;
        foreach (piece; spec.split(':')) {
            if (!piece.length || piece.length > 4) return false;
            ushort v;
            foreach (ch; piece) {
                int d;
                if (ch >= '0' && ch <= '9') d = ch - '0';
                else if (ch >= 'a' && ch <= 'f') d = ch - 'a' + 10;
                else return false;
                v = cast(ushort)((v << 4) | d);
            }
            outParts ~= v;
        }
        return true;
    }

    ushort[] left, right;
    if (!hextets(head, left)) return false;
    if (!hextets(tailStr, right)) return false;

    const total = left.length + right.length;
    if (elided) {
        if (total > 7) return false;   // "::" must stand for at least one group
    } else {
        if (total != 8) return false;
    }

    foreach (i, v; left) parts[i] = v;
    foreach (i, v; right) parts[8 - right.length + i] = v;
    return true;
}

/// Lower-case hex of one hextet without leading zeros (`0` for zero).
string hextetString(ushort v) @safe pure {
    static immutable digits = "0123456789abcdef";
    if (v == 0) return "0";
    char[4] buf;
    size_t n;
    bool started;
    foreach_reverse (shift; 0 .. 4) {
        const nib = (v >> (shift * 4)) & 0xF;
        if (!started && nib == 0) continue;
        started = true;
        buf[n++] = digits[nib];
    }
    return buf[0 .. n].idup;
}

/// True when the two addresses share their first `bits` bits.
bool sameIpv6Prefix(const ushort[8] a, const ushort[8] b, int bits) @safe pure nothrow @nogc {
    int left = bits;
    foreach (i; 0 .. 8) {
        if (left <= 0) break;
        const take = left >= 16 ? 16 : left;
        const mask = cast(ushort)(take == 16 ? 0xFFFF : ~((1 << (16 - take)) - 1));
        if ((a[i] & mask) != (b[i] & mask)) return false;
        left -= take;
    }
    return true;
}

/// True when `cidr` (`185.65.132.0/22`, `2001:db8::/32`, or a bare
/// address meaning `/32` / `/128`) covers `ip`. Mixed families and
/// malformed input are false; a `/0` covers everything of its family.
bool cidrContains(string cidr, string ip) @safe pure {
    auto m = cidr.strip();
    const target = ip.strip();
    if (!m.length || !target.length) return false;
    int bits = -1;
    const slash = m.lastIndexOf('/');
    if (slash > 0) {
        try bits = m[slash + 1 .. $].strip().to!int;
        catch (Exception) return false;
        m = m[0 .. slash].strip();
    }
    const v6 = m.indexOf(':') >= 0;
    if (v6 != (target.indexOf(':') >= 0)) return false;
    if (v6) {
        if (bits < 0) bits = 128;
        if (bits > 128) return false;
        ushort[8] a, b;
        if (!expandIpv6(m, a) || !expandIpv6(target, b)) return false;
        return sameIpv6Prefix(a, b, bits);
    }
    if (bits < 0) bits = 32;
    if (bits > 32) return false;
    ubyte[4] na, nb;
    if (!parseIpv4(m, na) || !parseIpv4(target, nb)) return false;
    const uint va = (na[0] << 24) | (na[1] << 16) | (na[2] << 8) | na[3];
    const uint vb = (nb[0] << 24) | (nb[1] << 16) | (nb[2] << 8) | nb[3];
    const uint bitmask = bits == 0 ? 0u : bits == 32 ? 0xFFFF_FFFFu : ~((1u << (32 - bits)) - 1);
    return (va & bitmask) == (vb & bitmask);
}
