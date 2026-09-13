/// Origin grammar for the iframe-embedding allowlist.
///
/// Deliberately free of vibe.d and Redis imports: the rules that decide what
/// may be allowlisted are pure string work, and keeping them here lets them be
/// tested without the storage layer. `ircfiber.embed` adds persistence and the
/// per-request cache on top.
module ircfiber.embed_origin;

import std.algorithm : all, canFind;
import std.ascii : isAlphaNum, isDigit;
import std.array : join;
import std.conv : to;
import std.string : indexOf, startsWith, strip, toLower;

/// Hard cap on allowlist size. Every entry lands in a response header on
/// every request, so the list stays small by construction.
enum size_t EMBED_ORIGINS_MAX = 16;

/// Normalizes an origin to `scheme://host[:port]`, lowercased, or returns
/// "" when the input is not a usable origin. Rejects paths, wildcards,
/// credentials, and plaintext http for anything but loopback.
string normalizeOrigin(string raw) @safe {
    auto s = raw.strip();
    if (s.length == 0 || s.length > 255) return "";
    // A trailing slash is what a browser's Origin header never has but a
    // human pasting from the address bar always does — accept and drop it.
    while (s.length > 0 && s[$ - 1] == '/') s = s[0 .. $ - 1];
    s = s.toLower();

    string scheme;
    if (s.startsWith("https://")) scheme = "https";
    else if (s.startsWith("http://")) scheme = "http";
    else return "";
    auto rest = s[scheme.length + 3 .. $];
    if (rest.length == 0) return "";
    // Anything beyond the authority (path, query, fragment, credentials)
    // makes this not an origin.
    if (rest.canFind('/') || rest.canFind('?') || rest.canFind('#')
        || rest.canFind('@') || rest.canFind('*') || rest.canFind(' '))
        return "";

    string host = rest;
    string port;
    auto colon = rest.indexOf(':');
    if (colon >= 0) {
        host = rest[0 .. colon];
        port = rest[colon + 1 .. $];
        if (port.length == 0 || port.length > 5 || !port.all!isDigit) return "";
    }
    if (host.length == 0) return "";
    bool loopback = host == "localhost" || host == "127.0.0.1";
    if (scheme == "http" && !loopback) return "";
    // Hostname characters only: labels of alphanumerics plus '-' and '.'.
    foreach (c; host) {
        if (!c.isAlphaNum && c != '-' && c != '.') return "";
    }
    if (!loopback && !host.canFind('.')) return "";
    if (host[0] == '.' || host[0] == '-' || host[$ - 1] == '.' || host[$ - 1] == '-')
        return "";

    return port.length > 0 ? scheme ~ "://" ~ host ~ ":" ~ port
                           : scheme ~ "://" ~ host;
}

/// Validates a submitted list. Returns the normalized, de-duplicated list in
/// `accepted` and one human-readable message per rejected entry.
string[] validateEmbedOrigins(string[] submitted, out string[] accepted) @safe {
    string[] errors;
    string[] ok;
    foreach (raw; submitted) {
        auto trimmed = raw.strip();
        if (trimmed.length == 0) continue;
        auto norm = normalizeOrigin(trimmed);
        if (norm.length == 0) {
            errors ~= trimmed ~ ": not a valid origin (expected https://host[:port], "
                ~ "no path, no wildcard; http:// only for localhost)";
            continue;
        }
        if (ok.canFind(norm)) continue;
        if (ok.length >= EMBED_ORIGINS_MAX) {
            errors ~= trimmed ~ ": allowlist is limited to "
                ~ to!string(EMBED_ORIGINS_MAX) ~ " origins";
            continue;
        }
        ok ~= norm;
    }
    accepted = ok;
    return errors;
}

/// `frame-ancestors` source list for the given allowlist. `'none'` when
/// empty, so a Redis outage or an empty list keeps the site unframeable.
string frameAncestors(const(string)[] origins) @safe {
    if (origins.length == 0) return "'none'";
    return "'self' " ~ origins.join(" ");
}

/// Host[:port] portion of an origin or Referer value, lowercased; "" when
/// unparseable. Comparisons are on the authority rather than the full origin
/// because Caddy terminates TLS and forwards plain HTTP, so the scheme the
/// gateway sees is not the scheme the browser used.
string originAuthority(string origin) @safe {
    auto s = origin.strip().toLower();
    auto sep = s.indexOf("://");
    if (sep < 0) return "";
    auto rest = s[sep + 3 .. $];
    auto slash = rest.indexOf('/');
    if (slash >= 0) rest = rest[0 .. slash];
    return rest;
}
