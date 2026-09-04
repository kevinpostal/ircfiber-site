module egress_test;

///
/// Unit tests for the Mullvad pool parsing / egress id helpers
/// (ircfiber.egress) shared by the admin API and the user-facing
/// "Connect via" picker. Pure code — no SOCKS, Redis or Mongo needed:
///   dub --root=backend build --config=egress-test && ./backend/egress-test
///

import std.stdio : writeln, writefln;

import ircfiber.egress : parseMullvadPool, normalizeEgressId, DIRECT_EGRESS_ID, PoolEntry;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

private void testParsePool() {
    auto p = parseMullvadPool("socks5://tailscale-mullvad-de:1055, socks5://100.94.116.56:1081,,socks5://nl.example,socks5://US@100.94.116.56:1082");
    check(p.length == 4, "four entries (empty one skipped)");
    check(p[0].label == "de" && p[0].host == "tailscale-mullvad-de" && p[0].port == 1055, "dash label from k8s service name");
    // Dot heuristic on a bare IP collapses to the first octet — the reason
    // bare-IP pools must carry an explicit `<label>@` prefix.
    check(p[1].label == "100" && p[1].host == "100.94.116.56" && p[1].port == 1081, "bare IP falls back to dot heuristic");
    check(p[2].label == "nl" && p[2].port == 1080, "default port 1080");
    check(p[3].label == "us" && p[3].host == "100.94.116.56" && p[3].port == 1082, "explicit label@ wins, lower-cased");
    check(parseMullvadPool("").length == 0, "empty pool");
    check(parseMullvadPool("socks5://:1080").length == 0, "empty host skipped");
}

private void testNormalizeEgressId() {
    check(normalizeEgressId(" Auto ") == "", "auto → automatic");
    check(normalizeEgressId("random") == "", "random → automatic");
    check(normalizeEgressId("") == "", "empty stays empty");
    check(normalizeEgressId("DE") == "de", "labels lower-cased");
    check(normalizeEgressId("Direct") == DIRECT_EGRESS_ID, "direct pseudo-label");
}

void main() {
    testParsePool();
    testNormalizeEgressId();
    if (failures) {
        writefln("egress tests: %d FAILED", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("egress tests: PASS");
}
