module ircfiber.web.common;

import std.algorithm : canFind, startsWith;
import std.string : indexOf, split, strip, toLower;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.http.common : HTTPMethod;

/// Makes the vibe session cookie persistent (Max-Age) instead of a browser-session cookie.
/// Without this, closing the browser clears the cookie even though Redis still holds the session,
/// which is the "logged out every day" bug. Uses centralized TTL from storage.session.
/// HttpOnly + Secure + Path=/ + Max-Age/Expires, and SameSite per
/// `sessionSameSite` below.
void persistSessionCookie(scope HTTPServerResponse res, string sessionId) @safe {
    try {
        import ircfiber.storage.session : getSessionTtlSeconds;
        import std.datetime : Clock, UTC;
        import core.time : seconds;
        import vibe.http.common : Cookie;
        long ttl = getSessionTtlSeconds();
        auto c = res.cookies.get(SESSION_COOKIE, null);
        if (c is null) c = res.setCookie(SESSION_COOKIE, sessionId, "/");
        c.maxAge = ttl;
        c.expires = Clock.currTime(UTC()) + ttl.seconds;
        c.httpOnly = true;
        c.secure = true;
        c.sameSite = sessionSameSite();
        c.path = "/";
    } catch (Exception) {}
}

/// SameSite value for the session cookie. `Lax` normally; `None` while a
/// partner origin is allowed to embed the site, because a cross-site iframe
/// never receives a Lax cookie and the embedded app would render permanently
/// logged out. `None` requires `Secure`, which is always set above. Forged
/// cross-site mutations are blocked by `rejectForeignOrigin` instead.
private auto sessionSameSite() @trusted {
    import vibe.http.common : Cookie;
    import ircfiber.embed : embeddingEnabled;
    try {
        if (embeddingEnabled()) return Cookie.SameSite.none;
    } catch (Exception) {}
    return Cookie.SameSite.lax;
}

/// Refreshes the session cookie's Max-Age on every authenticated response.
/// Implements sliding window for the browser cookie (not just Redis TTL).
/// Call after router.handleRequest when req.session is authenticated.
void refreshSessionCookie(scope HTTPServerRequest req, scope HTTPServerResponse res) @safe {
    try {
        if (!req.session) return;
        if (!req.session.isKeySet("sessionUserId")) return;
        persistSessionCookie(res, req.session.id);
    } catch (Exception) {}
}

string getClientIp(scope HTTPServerRequest req) {
    // 1. Cloudflare Tunnel header
    auto cf = req.headers.get("CF-Connecting-IP", "");
    if (cf.length > 0) {
        auto v = cf.split(",")[0].strip();
        if (v.length > 0) return v;
    }

    // 2. Standard reverse-proxy header (comma-separated chain)
    auto xff = req.headers.get("X-Forwarded-For", "");
    if (xff.length > 0) {
        auto v = xff.split(",")[0].strip();
        if (v.length > 0) return v;
    }

    // 3. Single-IP header (nginx, some load balancers)
    auto xri = req.headers.get("X-Real-IP", "");
    if (xri.length > 0) {
        auto v = xri.strip();
        if (v.length > 0) return v;
    }

    // 4. Raw TCP peer address
    try {
        auto addr = req.clientAddress.toAddressString();
        if (addr.length > 0) return addr;
    } catch (Exception) {}
    return "unknown";
}

/// Name of the vibe session cookie. Presence of this cookie is what makes a
/// request forgeable from another site, so it is also the trigger for the
/// origin check below.
package(ircfiber) enum SESSION_COOKIE = "vibe.session_id";

/// True for the admin surface, which is never embeddable and never accepts a
/// partner origin, no matter what the allowlist says.
private bool isAdminSurface(string path) @safe {
    return path == "/admin" || path.startsWith("/admin/")
        || path.startsWith("/api/admin/");
}

import ircfiber.embed_origin : originAuthority;

/// True when `claimed` (an Origin or Referer value) is either this site
/// itself or an origin the admin allowlisted for embedding. `allowPartners`
/// is false for the admin surface, which no partner may ever drive.
///
/// Compared on authority (host[:port]) rather than the full origin: Caddy
/// terminates TLS and forwards plain HTTP, so the scheme the gateway sees is
/// not the scheme the browser used.
bool isPermittedOrigin(string claimed, string host, bool allowPartners) @trusted {
    import ircfiber.embed : cachedEmbedOrigins;
    auto authority = originAuthority(claimed);
    if (authority.length == 0) return false;
    if (host.length > 0 && authority == host.strip().toLower()) return true;
    if (!allowPartners) return false;
    try {
        foreach (allowed; cachedEmbedOrigins()) {
            if (originAuthority(allowed) == authority) return true;
        }
    } catch (Exception) {}
    return false;
}

/// Origin/Referer the request claims to come from, "" when it claims none.
string claimedOrigin(scope HTTPServerRequest req) @trusted {
    try {
        auto o = req.headers.get("Origin", "");
        if (o.length > 0 && o != "null") return o;
        return req.headers.get("Referer", "");
    } catch (Exception) {
        return "";
    }
}

/// Emits the framing policy for this response.
///
/// Caddy contributes the base CSP as a *second* `Content-Security-Policy`
/// header (`+Content-Security-Policy` in the Caddyfile); browsers intersect
/// multiple policies, so the value written here is the only `frame-ancestors`
/// in play and stays admin-editable at runtime. `X-Frame-Options` has no
/// allowlist syntax, so it is only sent in the deny case; when an allowlist
/// exists, `frame-ancestors` is authoritative in every browser that matters.
void applyFrameHeaders(scope HTTPServerRequest req, scope HTTPServerResponse res) @trusted {
    import ircfiber.embed : cachedEmbedOrigins, frameAncestors;
    const(string)[] origins;
    try {
        if (!isAdminSurface(req.requestPath.toString())) origins = cachedEmbedOrigins();
    } catch (Exception) {}
    res.headers["Content-Security-Policy"] = "frame-ancestors " ~ frameAncestors(origins);
    if (origins.length == 0) res.headers["X-Frame-Options"] = "DENY";
}

/// Cross-site request forgery gate for cookie-authenticated mutations.
///
/// The session cookie is issued `SameSite=None` whenever embedding is on, so
/// SameSite no longer blocks a forged cross-site POST — this check replaces
/// it. Scope is deliberately narrow: only unsafe methods that actually carry
/// the session cookie. Public token flows (/login, /register, /verify,
/// /forgot, /reset, /unsubscribe, /unban) carry no session cookie and are
/// untouched; nothing in the backend is authenticated by a bearer token or
/// webhook secret, so there are no non-browser callers to break.
///
/// Returns true when the request was rejected (response already written).
bool rejectForeignOrigin(scope HTTPServerRequest req, scope HTTPServerResponse res) @trusted {
    import vibe.core.log : logWarn;

    auto m = req.method;
    if (m != HTTPMethod.POST && m != HTTPMethod.PUT
        && m != HTTPMethod.PATCH && m != HTTPMethod.DELETE) return false;
    string cookie;
    try cookie = req.cookies.get(SESSION_COOKIE, "");
    catch (Exception) { cookie = ""; }
    if (cookie.length == 0) return false;

    string path;
    try path = req.requestPath.toString();
    catch (Exception) { path = ""; }

    // Origin is sent by every browser on an unsafe cross-origin request and,
    // since Chrome 51/Firefox 70, on same-origin POSTs too. Referer is the
    // fallback for the rare client that omits Origin.
    auto claimed = claimedOrigin(req);
    string host;
    try host = req.host;
    catch (Exception) {}

    // A request that declares no origin at all (curl, an old client) is only
    // refused once embedding is live: until then SameSite=Lax already blocks
    // the cross-site case, and rejecting header-less callers would be a
    // behaviour change with no security gain.
    if (claimed.length == 0) {
        import ircfiber.embed : embeddingEnabled;
        bool enabled = false;
        try enabled = embeddingEnabled();
        catch (Exception) {}
        if (!enabled) return false;
    }

    if (isPermittedOrigin(claimed, host, !isAdminSurface(path))) return false;

    logWarn("csrf: rejected %s %s from origin '%s' (host '%s')",
        m, path, claimed, host);
    res.statusCode = 403;
    if (path.startsWith("/api/")) {
        res.headers["Content-Type"] = "application/json; charset=utf-8";
        res.writeBody(`{"ok":false,"error":"cross-site request blocked"}`);
    } else {
        res.writeBody("cross-site request blocked", "text/plain; charset=utf-8");
    }
    return true;
}
