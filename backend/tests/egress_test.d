module egress_test;

///
/// Unit tests for the Mullvad pool parsing / egress id helpers
/// (ircfiber.egress) shared by the admin API and the user-facing
/// "Connect via" picker. Pure code — no SOCKS, Redis or Mongo needed:
///   dub --root=backend build --config=egress-test && ./backend/egress-test
///

import std.stdio : writeln, writefln;

import ircfiber.egress : parseMullvadPool, normalizeEgressId, DIRECT_EGRESS_ID, PoolEntry,
    EgressSlot, EgressLocationRow, EgressView, egressViewFrom, isKnownEgressId, matchingSlot;

/// Two slots (one on Berlin carrying a connection, one idle in Stockholm) and
/// a three-city catalog — the shape `GET /api/egress` serves.
private EgressView fixtureView(long nowMs = 1_000_000L) {
    EgressSlot de;
    de.serverId = "ovh1"; de.label = "de"; de.host = "mullvad-de"; de.port = 1080;
    de.locationId = "de-ber"; de.country = "Germany"; de.countryCode = "de"; de.city = "Berlin";
    de.controllable = true; de.state = "ready"; de.activeConns = 2;
    EgressSlot se;
    se.serverId = "ovh1"; se.label = "se"; se.host = "mullvad-se"; se.port = 1080;
    se.locationId = "se-sto"; se.country = "Sweden"; se.countryCode = "se"; se.city = "Stockholm";
    se.controllable = true; se.state = "ready"; se.activeConns = 0; se.heldUntilMs = 0;
    EgressLocationRow[] locs = [
        EgressLocationRow("se-sto", "Sweden", "se", "Stockholm", 3),
        EgressLocationRow("de-ber", "Germany", "de", "Berlin", 2),
        EgressLocationRow("us-lax", "USA", "us", "Los Angeles", 4),
    ];
    return egressViewFrom([de, se], locs, nowMs);
}

private void testViewAggregates() {
    auto v = fixtureView();
    check(v.slotCount == 2, "two slots");
    check(v.controllable, "controllable when any slot is retargetable");
    check(v.freeSlots == 1, "only the idle, unheld slot is free");
    check(v.locations.length == 3, "catalog deduped to three cities");
    check(v.locations[0].country == "Germany" && v.locations[2].country == "USA",
        "catalog sorted by country then city");

    // A slot inside its sticky hold or mid-retarget is not free.
    auto held = fixtureView();
    held.slots[1].heldUntilMs = 2_000_000L;
    check(egressViewFrom(held.slots, held.locations, 1_000_000L).freeSlots == 0,
        "held slot is not free");
    held.slots[1].heldUntilMs = 0;
    held.slots[1].state = "retargeting";
    check(egressViewFrom(held.slots, held.locations, 1_000_000L).freeSlots == 0,
        "retargeting slot is not free");

    // Duplicate ids across engines collapse to one option.
    auto dup = egressViewFrom(null, [
        EgressLocationRow("se-sto", "Sweden", "se", "Stockholm", 3),
        EgressLocationRow("se-sto", "Sweden", "se", "Stockholm", 1),
    ], 0);
    check(dup.locations.length == 1, "duplicate location ids deduped");
    check(!dup.controllable && dup.freeSlots == 0, "no slots → nothing controllable");
}

private void testLocationValidation() {
    auto v = fixtureView();
    check(isKnownEgressId("", v), "automatic always valid");
    check(isKnownEgressId(DIRECT_EGRESS_ID, v), "direct always valid");
    check(isKnownEgressId("se", v), "country pin valid when a city in it exists");
    check(isKnownEgressId("se-sto", v), "exact city pin valid");
    check(!isKnownEgressId("fr", v), "unknown country rejected");
    check(!isKnownEgressId("se-got", v), "city outside the catalog rejected");
    // A fresh engine has published no catalog yet — must not lock users out
    // of pins already stored on their networks.
    EgressView empty;
    check(isKnownEgressId("se-got", empty), "permissive when catalog is empty");
}

private void testMatchingSlot() {
    auto v = fixtureView();
    check(matchingSlot("de-ber", v) !is null, "city pin matches the slot on that id");
    check(matchingSlot("de-ber", v).label == "de", "…and it is the right slot");
    check(matchingSlot("de", v) !is null, "country pin matches a slot in that country");
    check(matchingSlot("dk", v) is null, "country prefix must be exact");
    check(matchingSlot("us-lax", v) is null, "catalogued but unassigned city needs a retarget");
    check(matchingSlot("", v) is null, "automatic matches no slot");
    check(matchingSlot(DIRECT_EGRESS_ID, v) is null, "direct matches no slot");
}

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
    testViewAggregates();
    testLocationValidation();
    testMatchingSlot();
    if (failures) {
        writefln("egress tests: %d FAILED", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("egress tests: PASS");
}
