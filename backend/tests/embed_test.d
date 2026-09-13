module embed_test;

import std.conv : to;
import std.stdio : writefln, writeln;

import ircfiber.embed_origin;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

/// What an operator may put on the allowlist. Every rejection here is a
/// header-injection or over-broad-grant hazard if it were accepted.
private void testNormalizeOrigin() {
    check(normalizeOrigin("https://chatlife.net") == "https://chatlife.net",
        "plain https origin survives");
    check(normalizeOrigin("  HTTPS://ChatLife.NET/  ") == "https://chatlife.net",
        "case and trailing slash normalized, got " ~ normalizeOrigin("  HTTPS://ChatLife.NET/  "));
    check(normalizeOrigin("https://app.chatlife.net:8443") == "https://app.chatlife.net:8443",
        "explicit port kept");

    // Loopback is the only plaintext exception — local development.
    check(normalizeOrigin("http://localhost:5173") == "http://localhost:5173",
        "http allowed for localhost");
    check(normalizeOrigin("http://127.0.0.1") == "http://127.0.0.1",
        "http allowed for 127.0.0.1");
    check(normalizeOrigin("http://chatlife.net") == "",
        "plaintext http rejected for a public host");

    // frame-ancestors has no wildcard-subdomain syntax we want to grant, and
    // anything past the authority is not an origin at all.
    check(normalizeOrigin("https://*.chatlife.net") == "", "wildcard rejected");
    check(normalizeOrigin("https://chatlife.net/embed") == "", "path rejected");
    check(normalizeOrigin("https://chatlife.net?x=1") == "", "query rejected");
    check(normalizeOrigin("https://user@chatlife.net") == "", "credentials rejected");
    check(normalizeOrigin("https://chatlife.net data:") == "",
        "space-separated extra source rejected");
    check(normalizeOrigin("chatlife.net") == "", "scheme required");
    check(normalizeOrigin("ftp://chatlife.net") == "", "non-http scheme rejected");
    check(normalizeOrigin("https://") == "", "empty authority rejected");
    check(normalizeOrigin("https://intranet") == "", "dotless public host rejected");
    check(normalizeOrigin("https://chatlife.net:") == "", "empty port rejected");
    check(normalizeOrigin("https://chatlife.net:80a") == "", "non-numeric port rejected");
    check(normalizeOrigin("https://.chatlife.net") == "", "leading dot rejected");
    check(normalizeOrigin("") == "", "empty input rejected");
}

private void testValidateList() {
    string[] accepted;
    auto errors = validateEmbedOrigins(
        ["https://chatlife.net", "", "  https://CHATLIFE.net/  ", "nope"], accepted);
    check(accepted == ["https://chatlife.net"],
        "duplicates collapse and blanks are dropped, got " ~ accepted.to!string);
    check(errors.length == 1, "one error for the one bad entry, got " ~ errors.length.to!string);

    string[] many;
    foreach (i; 0 .. EMBED_ORIGINS_MAX + 3) many ~= "https://p" ~ i.to!string ~ ".example";
    string[] cappedAccepted;
    auto capErrors = validateEmbedOrigins(many, cappedAccepted);
    check(cappedAccepted.length == EMBED_ORIGINS_MAX,
        "cap enforced, got " ~ cappedAccepted.length.to!string);
    check(capErrors.length == 3, "each over-cap entry reported, got " ~ capErrors.length.to!string);
}

/// The response header value. `'none'` on an empty list is the fail-closed
/// case a Redis outage lands in.
private void testFrameAncestors() {
    check(frameAncestors([]) == "'none'", "empty list denies framing");
    check(frameAncestors(["https://chatlife.net"]) == "'self' https://chatlife.net",
        "self plus partner, got " ~ frameAncestors(["https://chatlife.net"]));
    check(frameAncestors(["https://a.example", "https://b.example"])
            == "'self' https://a.example https://b.example",
        "multiple partners space-separated");
}

/// Requests are matched on authority because Caddy forwards plain HTTP, so
/// the scheme the gateway sees never matches the browser's.
private void testOriginAuthority() {
    check(originAuthority("https://chatlife.net") == "chatlife.net", "host extracted");
    check(originAuthority("https://chatlife.net:8443") == "chatlife.net:8443", "port retained");
    check(originAuthority("https://chatlife.net/page?x=1") == "chatlife.net",
        "Referer path stripped");
    check(originAuthority("HTTPS://ChatLife.net") == "chatlife.net", "lowercased");
    check(originAuthority("null") == "", "opaque origin yields nothing");
    check(originAuthority("") == "", "missing header yields nothing");
}

void main() {
    testNormalizeOrigin();
    testValidateList();
    testFrameAncestors();
    testOriginAuthority();
    if (failures > 0) {
        writefln("\n%d check(s) failed", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("embed_test: all checks passed");
}
