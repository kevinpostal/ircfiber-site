/// View model behind `GET /api/me/sessions` — the user's own login sessions
/// with their live clients nested underneath, IRCCloud-style.
///
/// Pure on purpose: the handler in `ircfiber.api.rest` does the Redis and
/// SessionManager reads, this module owns the shaping (grouping, ordering,
/// expiry maths, id hiding) so it can be unit-tested without a server.
module ircfiber.web.sessions_view;

import std.algorithm.sorting : sort;
import std.digest.sha : sha256Of;
import std.digest : toHexString;
import std.uni : toLower;

import vibe.data.json : Json;

/// One login session of the caller, read out of the `session:<id>` Redis hash.
struct LoginSessionRow {
    /// Raw vibe.d session id. Used to group clients and to derive `ref`;
    /// never serialised — it is the value of the session cookie, so handing
    /// a user their other sessions' ids would hand an XSS their credentials.
    string sessionId;
    /// Login time (unix ms), from the `createdAt` session field.
    long createdAtMs;
    /// Last authenticated request (unix ms), from `lastAccess`.
    long lastAccessMs;
    /// Remaining lifetime of the Redis key. `<= 0` when the key has no
    /// expiry (or Redis could not tell us), which renders as "never".
    long ttlSeconds;
    /// IP and User-Agent captured at login (`captureSessionMeta`).
    string clientIp;
    string userAgent;
    /// True for the session making the request.
    bool current;
}

/// One live WebSocket client, i.e. an open tab.
struct LoginClientRow {
    /// WebSocket session id. Not a credential, but not serialised either:
    /// the client only ever needs the opaque `ref`.
    string wsSessionId;
    /// Login session whose cookie authenticated this socket.
    string webSessionId;
    /// Connect time (unix ms).
    long connectedAtMs;
    string clientIp;
    string userAgent;
    /// True for the socket belonging to the tab that asked.
    bool current;
}

/// Stable, opaque handle for a session id: the first 12 hex digits of its
/// SHA-256. Lets the UI key rows and lets a bug report name a row without
/// the response ever carrying a usable session id.
string sessionRef(string id) @safe {
    if (id.length == 0) return "";
    auto hex = toHexString(sha256Of(id));
    return toLower(hex[0 .. 12].idup);
}

/// Resolves the opaque `ref` a client sends back (Revoke) to the real session
/// id, searching only the ids the caller owns — so ownership is enforced by
/// construction rather than by remembering to check it. Returns "" when no
/// owned session matches, which the caller answers with a 404.
string sessionIdForRef(const(string)[] ownedIds, string ref_) @safe {
    if (ref_.length != 12) return "";
    foreach (id; ownedIds)
        if (sessionRef(id) == ref_) return id;
    return "";
}

/// Shapes the sessions payload.
///
/// - Sessions come out newest login first; clients newest connection first.
/// - `expiresAt` is `nowMs + ttlSeconds` because the session TTL slides
///   forward on every authenticated request; `0` means no expiry.
/// - `clientCount` is the number of nested clients, so the table can show
///   IRCCloud's "Active clients" column without counting in the template.
/// - Clients whose `webSessionId` matches no listed session are dropped:
///   that only happens when the login session was revoked or expired out
///   from under a still-open socket, and a client row is meaningless
///   without the login it belongs to.
Json loginSessionsJson(LoginSessionRow[] sessions, LoginClientRow[] clients,
                       long nowMs) @safe {
    LoginClientRow[][string] byLogin;
    foreach (ref c; clients) {
        if (c.webSessionId.length == 0) continue;
        byLogin[c.webSessionId] ~= c;
    }
    foreach (ref group; byLogin) {
        group.sort!((a, b) => a.connectedAtMs > b.connectedAtMs);
    }

    auto rows = sessions.dup;
    rows.sort!((a, b) => a.createdAtMs > b.createdAtMs);

    Json[] arr;
    long liveClients;
    foreach (ref s; rows) {
        Json sj = Json.emptyObject;
        sj["ref"] = Json(sessionRef(s.sessionId));
        sj["createdAt"] = Json(s.createdAtMs);
        sj["lastAccess"] = Json(s.lastAccessMs);
        sj["expiresAt"] = Json(s.ttlSeconds > 0 ? nowMs + s.ttlSeconds * 1000L : 0L);
        sj["clientIp"] = Json(s.clientIp);
        sj["userAgent"] = Json(s.userAgent);
        sj["current"] = Json(s.current);

        Json[] cj;
        if (auto group = s.sessionId in byLogin) {
            foreach (ref c; *group) {
                Json c1 = Json.emptyObject;
                c1["ref"] = Json(sessionRef(c.wsSessionId));
                c1["connectedAt"] = Json(c.connectedAtMs);
                c1["clientIp"] = Json(c.clientIp);
                c1["userAgent"] = Json(c.userAgent);
                c1["current"] = Json(c.current);
                cj ~= c1;
            }
        }
        liveClients += cast(long) cj.length;
        sj["clientCount"] = Json(cast(long) cj.length);
        sj["clients"] = Json(cj);
        arr ~= sj;
    }

    Json data = Json.emptyObject;
    data["sessions"] = Json(arr);
    data["total"] = Json(cast(long) arr.length);
    // Live sockets across every listed login — the page uses it to caption
    // the table without re-summing the rows.
    data["liveClients"] = Json(liveClients);
    // Server clock, so the page can render relative times without inheriting
    // the browser's skew.
    data["now"] = Json(nowMs);
    return data;
}
