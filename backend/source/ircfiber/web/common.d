module ircfiber.web.common;

import std.string : strip, split;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

/// Makes the vibe session cookie persistent (Max-Age) instead of a browser-session cookie.
/// Without this, closing the browser clears the cookie even though Redis still holds the session,
/// which is the "logged out every day" bug. Uses centralized TTL from storage.session.
/// Enterprise: HttpOnly + Secure + SameSite=Lax + Path=/ + Max-Age/Expires.
void persistSessionCookie(scope HTTPServerResponse res, string sessionId) @safe {
    enum COOKIE_NAME = "vibe.session_id";
    try {
        import ircfiber.storage.session : getSessionTtlSeconds;
        long ttl = getSessionTtlSeconds();
        if (auto c = res.cookies.get(COOKIE_NAME, null)) {
            c.maxAge = ttl;
            import std.datetime : Clock, UTC;
            import core.time : seconds;
            c.expires = Clock.currTime(UTC()) + ttl.seconds;
            c.httpOnly = true;
            c.secure = true;
            import vibe.http.common : Cookie;
            c.sameSite = Cookie.SameSite.lax;
            c.path = "/";
        } else {
            auto c = res.setCookie(COOKIE_NAME, sessionId, "/");
            c.maxAge = ttl;
            import std.datetime : Clock, UTC;
            import core.time : seconds;
            c.expires = Clock.currTime(UTC()) + ttl.seconds;
            c.httpOnly = true;
            c.secure = true;
            import vibe.http.common : Cookie;
            c.sameSite = Cookie.SameSite.lax;
            c.path = "/";
        }
    } catch (Exception) {}
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
