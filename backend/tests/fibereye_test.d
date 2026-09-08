module fibereye_test;

///
/// Unit tests for the FiberEye pure helpers — the quit-notice parser, the
/// IPv6 /64 grouping, the Z-line mask matcher, the rule engine, the strike
/// escalation and the "was this ban machine-placed" predicate that guards
/// the public unban page. No Redis, Mongo or IRCd needed:
///   dub --root=backend build --config=fibereye-test && ./backend/fibereye-test
///

import std.stdio : writeln, writefln;

import ircfiber.fibereye.format : parseQuitNotice, ipGroup, expandIpv6, zlineMatches;
import ircfiber.fibereye.rules : Observation, Thresholds, evaluate, banDurationFor,
    isAutoPlacedZline, banReason;
import ircfiber.fibereye.events : Appeal, fiberEyeAppealKey, fiberEyeConnKey;
import ircfiber.logs.format : parseConnectNotice;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

// The three nicks and the two source addresses below are the ones from the
// live #staff incident log that motivated FiberEye.
private void testParseQuitNotice() {
    auto q = parseQuitNotice(
        "*** QUIT: Client exiting: mtddnsz7!~u@7b2forhf.hidden (76.32.236.21) [Quit: ]");
    check(q.ok, "incident quit notice parses");
    check(q.nick == "mtddnsz7", "quit nick");
    check(q.ident == "~u", "quit ident");
    check(q.host == "7b2forhf.hidden", "quit cloak");
    check(q.ip == "76.32.236.21", "quit real IP");
    check(q.reason == "Quit:", "empty quit reason survives as the bare prefix");

    // IPv6 source plus a reason carrying brackets and parentheses.
    auto v6 = parseQuitNotice("*** QUIT: Client exiting: slxpbdgg__!~s@cloak.hidden "
        ~ "(2603:8001:98f0:1530:691d:b048:970e:1304) [Quit: bye (really) [x]]");
    check(v6.ok, "ipv6 quit notice parses");
    check(v6.ip == "2603:8001:98f0:1530:691d:b048:970e:1304", "ipv6 address is not split by the mask parser");
    check(v6.reason == "Quit: bye (really) [x]", "bracketed reason survives");
    check(v6.nick == "slxpbdgg__", "trailing underscores kept in nick");

    // A connect notice is not a quit notice, and vice versa.
    check(!parseQuitNotice("*** Client connecting on port 6697 (class main): "
        ~ "a!~a@h.example (203.0.113.7) [A]").ok, "connect notice rejected by quit parser");
    check(!parseConnectNotice("*** QUIT: Client exiting: a!~a@h (1.2.3.4) [Quit: x]").ok,
        "quit notice rejected by connect parser");
    check(!parseQuitNotice("*** Notice -- foo").ok, "unrelated snotice rejected");
    check(!parseQuitNotice("*** QUIT: Client exiting: nomask (1.2.3.4) [x]").ok,
        "quit notice without a nick!user@host mask rejected");
}

private void testIpGroup() {
    check(ipGroup("76.32.236.21") == "76.32.236.21", "ipv4 group is the exact address");
    // The observed flood rotated addresses inside one /64 — both collapse.
    check(ipGroup("2603:8001:98f0:1530:691d:b048:970e:1304") == "2603:8001:98f0:1530::/64",
        "ipv6 groups to the /64");
    check(ipGroup("2603:8001:98f0:1530:1:2:3:4") == ipGroup("2603:8001:98f0:1530:691d:b048:970e:1304"),
        "two addresses in one /64 share a group");
    check(ipGroup("2603:8001:98f0:1531:1:2:3:4") != ipGroup("2603:8001:98f0:1530:1:2:3:4"),
        "a different /64 is a different group");
    check(ipGroup("::1") == "::1", "loopback is never widened into a /64");
    check(ipGroup("not an ip") == "not an ip", "unparsable input returned unchanged");
    check(ipGroup("::ffff:203.0.113.7") == "203.0.113.7", "ipv4-mapped reduces to the embedded v4");
    check(ipGroup("  76.32.236.21  ") == "76.32.236.21", "input is stripped");

    ushort[8] p;
    check(expandIpv6("2603:8001:98f0:1530::1", p) && p[0] == 0x2603 && p[3] == 0x1530 && p[7] == 1,
        "expandIpv6 handles the :: elision");
    check(!expandIpv6("2603:8001:98f0:1530:1:2:3:4:5", p), "nine hextets rejected");
    check(!expandIpv6("1.2.3.4", p), "plain ipv4 rejected");
}

private void testZlineMatches() {
    check(zlineMatches("76.32.236.21", "76.32.236.21"), "exact ipv4 mask matches");
    check(!zlineMatches("76.32.236.22", "76.32.236.21"), "neighbouring ipv4 does not match");
    check(zlineMatches("2603:8001:98f0:1530::/64", "2603:8001:98f0:1530:691d:b048:970e:1304"),
        "/64 covers a sibling address");
    check(!zlineMatches("2603:8001:98f0:1531::/64", "2603:8001:98f0:1530:691d:b048:970e:1304"),
        "a different /64 does not cover it");
    check(zlineMatches("76.32.236.*", "76.32.236.21"), "glob mask matches");
    check(zlineMatches("198.51.100.0/24", "198.51.100.9"), "ipv4 CIDR matches");
    check(!zlineMatches("198.51.100.0/24", "198.51.101.9"), "ipv4 CIDR excludes another /24");
    // A catch-all must never be read as "this visitor's own ban".
    check(!zlineMatches("*", "76.32.236.21"), "* is never treated as the visitor's ban");
    check(!zlineMatches("::/0", "2603:8001:98f0:1530::1"), "::/0 rejected");
    check(!zlineMatches("0.0.0.0/0", "76.32.236.21"), "0.0.0.0/0 rejected");
    check(!zlineMatches("", "76.32.236.21"), "empty mask rejected");
}

private void testRules() {
    Thresholds t;   // 10 connects / 6 nicks / 6 short sessions per 60 s
    // Over both the connect and the nick threshold: connect_flood wins, so
    // the recorded rule (and therefore the ban wording) is deterministic.
    auto v = evaluate(Observation(12, 9, 0, 60), t);
    check(v.trip && v.rule == "connect_flood", "connect_flood takes precedence over nick_churn");
    v = evaluate(Observation(3, 7, 0, 60), t);
    check(v.trip && v.rule == "nick_churn", "nick_churn trips on distinct nicks alone");
    v = evaluate(Observation(3, 2, 6, 60), t);
    check(v.trip && v.rule == "session_churn", "session_churn trips at the threshold");
    v = evaluate(Observation(9, 5, 5, 60), t);
    check(!v.trip && v.rule == "", "an observation under every threshold does not trip");

    check(banDurationFor(1, 3600) == 3600, "first strike is the base duration");
    check(banDurationFor(2, 3600) == 86_400, "second strike is a day");
    check(banDurationFor(3, 3600) == 604_800, "third strike is a week");
    check(banDurationFor(9, 3600) == 604_800, "escalation stops at a week");
}

private void testAutoPlacedPredicate() {
    check(isAutoPlacedZline(banReason("connect_flood", "https://ircfiber.com/unban/tok")),
        "FiberEye's own reason is recognised");
    // The retuned <connectban banmessage> carries the same marker.
    check(isAutoPlacedZline("FiberEye: connection flood detected. Appeal: https://ircfiber.com/unban"),
        "connectban banmessage is recognised");
    // The default reason of the admin ban endpoint must NOT be liftable by
    // the public page — this is the check that protects the network.
    check(!isAutoPlacedZline("Banned by administrator"), "an oper's ban is not auto-placed");
    check(!isAutoPlacedZline(""), "empty reason is not auto-placed");

    check(banReason("connect_flood", "https://x/unban/t")
        == "FiberEye: connection flood from your address. Appeal: https://x/unban/t",
        "connect_flood reason wording");
    check(banReason("nick_churn", "https://x/u")
        == "FiberEye: too many nicknames from your address. Appeal: https://x/u",
        "nick_churn reason wording");
    check(banReason("session_churn", "https://x/u")
        == "FiberEye: repeated connect/disconnect from your address. Appeal: https://x/u",
        "session_churn reason wording");
    check(banReason("manual", "") == "FiberEye: banned by staff.", "manual reason without a URL");
}

private void testAppealRoundTrip() {
    Appeal a;
    a.mask = "2603:8001:98f0:1530::/64";
    a.ipGroup = a.mask;
    a.banId = "b-1";
    a.reason = banReason("connect_flood", "https://ircfiber.com/unban/tok");
    a.placedAtMs = 1_700_000_000_000;
    a.expiresAtMs = a.placedAtMs + 3_600_000;
    const back = Appeal.fromJson(a.toJson());
    check(back.mask == a.mask && back.banId == "b-1" && back.expiresAtMs == a.expiresAtMs,
        "appeal survives a JSON round trip");
    check(Appeal.fromJson(Appeal.init.toJson()).mask == "", "empty appeal round trips");
    check(fiberEyeAppealKey("tok") == "fibereye:appeal:tok", "appeal key shape");
    check(fiberEyeConnKey("76.32.236.21") == "fibereye:conn:76.32.236.21", "conn key shape");
}

void main() {
    testParseQuitNotice();
    testIpGroup();
    testZlineMatches();
    testRules();
    testAutoPlacedPredicate();
    testAppealRoundTrip();
    if (failures) {
        writefln("%d check(s) failed", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("fibereye: all checks passed");
}
