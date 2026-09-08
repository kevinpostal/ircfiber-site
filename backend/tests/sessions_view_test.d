module sessions_view_test;

///
/// Unit tests for the `GET /api/me/sessions` view model
/// (ircfiber.web.sessions_view) behind Settings → Sessions. Pure code — no
/// Redis, Mongo or WebSocket needed:
///   dub --root=backend build --config=sessions-view-test && ./backend/sessions-view-test
///

import std.stdio : writeln, writefln;

import vibe.data.json : Json;

import ircfiber.web.sessions_view : LoginSessionRow, LoginClientRow,
    loginSessionsJson, sessionRef, sessionIdForRef;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

private enum NOW = 1_800_000_000_000L;

/// Two logins of one user: an older desktop session with two tabs open and a
/// fresh phone login with none.
private LoginSessionRow[] fixtureSessions() {
    LoginSessionRow desktop;
    desktop.sessionId = "sid-desktop";
    desktop.createdAtMs = NOW - 7 * 86_400_000L;
    desktop.lastAccessMs = NOW - 30_000L;
    desktop.ttlSeconds = 90 * 86_400L;
    desktop.clientIp = "2a02:6ea0:fe00:1::e025";
    desktop.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/152.0.0.0";
    desktop.current = true;

    LoginSessionRow phone;
    phone.sessionId = "sid-phone";
    phone.createdAtMs = NOW - 3_600_000L;
    phone.lastAccessMs = NOW - 3_600_000L;
    phone.ttlSeconds = -1; // key without an expiry
    phone.clientIp = "203.0.113.9";
    phone.userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari";
    return [desktop, phone];
}

private LoginClientRow[] fixtureClients() {
    LoginClientRow tabOld;
    tabOld.wsSessionId = "ws-1";
    tabOld.webSessionId = "sid-desktop";
    tabOld.connectedAtMs = NOW - 600_000L;
    tabOld.clientIp = "203.0.113.4";
    tabOld.userAgent = "Mozilla/5.0 Chrome/152.0.0.0";

    LoginClientRow tabNew;
    tabNew.wsSessionId = "ws-2";
    tabNew.webSessionId = "sid-desktop";
    tabNew.connectedAtMs = NOW - 60_000L;
    tabNew.clientIp = "203.0.113.4";
    tabNew.userAgent = "Mozilla/5.0 Chrome/152.0.0.0";
    tabNew.current = true;

    // Socket whose login session is gone (revoked or expired under it).
    LoginClientRow orphan;
    orphan.wsSessionId = "ws-3";
    orphan.webSessionId = "sid-vanished";
    orphan.connectedAtMs = NOW - 5_000L;
    return [tabOld, tabNew, orphan];
}

private void testGroupingAndOrder() {
    auto j = loginSessionsJson(fixtureSessions(), fixtureClients(), NOW);
    auto sessions = j["sessions"];
    check(sessions.length == 2, "both login sessions listed");
    check(j["total"].get!long == 2, "total counts sessions");

    // Newest login first: the phone logged in an hour ago, the desktop a week ago.
    check(sessions[0]["clientIp"].get!string == "203.0.113.9", "newest login first");
    check(sessions[1]["clientIp"].get!string == "2a02:6ea0:fe00:1::e025", "older login second");

    auto desktop = sessions[1];
    check(desktop["clientCount"].get!long == 2, "two tabs under the desktop login");
    check(desktop["clients"].length == 2, "client rows nested under their login");
    check(desktop["clients"][0]["connectedAt"].get!long > desktop["clients"][1]["connectedAt"].get!long,
        "newest client connection first");
    check(desktop["clients"][0]["current"].get!bool, "the asking tab is marked current");
    check(!desktop["clients"][1]["current"].get!bool, "the sibling tab is not");
    check(desktop["current"].get!bool && !sessions[0]["current"].get!bool,
        "only the requesting login is current");

    auto phone = sessions[0];
    check(phone["clientCount"].get!long == 0 && phone["clients"].length == 0,
        "a login with no open socket reports no clients");

    // The orphan socket is dropped, not attached to an unrelated login.
    check(j["liveClients"].get!long == 2, "only clients with a listed login are counted");
}

private void testExpiryMaths() {
    auto j = loginSessionsJson(fixtureSessions(), null, NOW);
    // TTL slides forward on every authenticated request, so expiry is
    // measured from now, not from the login.
    check(j["sessions"][1]["expiresAt"].get!long == NOW + 90 * 86_400L * 1000L,
        "expiresAt is now + remaining TTL");
    check(j["sessions"][0]["expiresAt"].get!long == 0,
        "a key without an expiry reports 0, not a past date");
    check(j["now"].get!long == NOW, "server clock echoed for skew-free relative times");
}

private void testIdsNeverLeak() {
    auto j = loginSessionsJson(fixtureSessions(), fixtureClients(), NOW);
    const dump = j.toString();
    check(dump.length > 0, "payload serialises");
    import std.string : indexOf;
    check(dump.indexOf("sid-desktop") < 0 && dump.indexOf("sid-phone") < 0,
        "login session ids (the cookie value) are absent from the payload");
    check(dump.indexOf("ws-1") < 0, "websocket session ids are absent too");

    auto r = sessionRef("sid-desktop");
    check(r.length == 12, "ref is 12 hex digits");
    check(r == sessionRef("sid-desktop"), "ref is stable for one id");
    check(r != sessionRef("sid-phone"), "refs differ per session");
    check(sessionRef("") == "", "no ref for an empty id");
    check(j["sessions"][1]["ref"].get!string == r, "rows carry the ref of their session");
}

private void testEmpty() {
    auto j = loginSessionsJson(null, null, NOW);
    check(j["sessions"].length == 0 && j["total"].get!long == 0, "no sessions → empty list");
    check(j["liveClients"].get!long == 0, "no clients → zero");
}

/// Revoke resolves the opaque ref against the caller's OWN ids, so a ref
/// belonging to somebody else's session can never name a target.
private void testRefResolution() {
    const owned = ["sid-desktop", "sid-phone"];
    check(sessionIdForRef(owned, sessionRef("sid-phone")) == "sid-phone",
        "a ref resolves back to its session id");
    check(sessionIdForRef(owned, sessionRef("sid-someone-else")) == "",
        "a ref for a session the caller does not own resolves to nothing");
    check(sessionIdForRef(owned, "") == "" && sessionIdForRef(owned, "abc") == "",
        "a malformed ref resolves to nothing");
    check(sessionIdForRef(null, sessionRef("sid-phone")) == "",
        "no owned sessions → nothing to revoke");
}

void main() {
    testGroupingAndOrder();
    testExpiryMaths();
    testIdsNeverLeak();
    testEmpty();
    testRefResolution();
    if (failures) {
        writefln("sessions view tests: %d FAILED", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("sessions view tests: PASS");
}
