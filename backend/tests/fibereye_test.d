module fibereye_test;

///
/// Unit tests for the FiberEye pure helpers — the quit-notice parser, the
/// IPv6 /64 grouping, the Z-line mask matcher, the rule engine, the strike
/// escalation and the "was this ban machine-placed" predicate that guards
/// the public unban page. No Redis, Mongo or IRCd needed:
///   dub --root=backend build --config=fibereye-test && ./backend/fibereye-test
///

import std.stdio : writeln, writefln;

import std.algorithm : canFind;
import std.conv : to;
import std.string : indexOf;

import ircfiber.fibereye.format : parseQuitNotice, ipGroup, expandIpv6, zlineMatches,
    validExemptEntry, validExemptNick, nickExemptMatch;
import ircfiber.fibereye.rules : Observation, Thresholds, evaluate, banDurationFor,
    isAutoPlacedZline, banReason, validateThresholds;
import ircfiber.fibereye.ruleset : RuleSet, validateRuleSet, summarizeRuleChange;
import ircfiber.fibereye.events : Appeal, fiberEyeAppealKey, fiberEyeConnKey, fiberEyeRulesKey;
import ircfiber.logs.format : parseConnectNotice;

import vibe.data.json : Json, parseJsonString;

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

/// The point of the per-rule flags: switching a rule off preserves its
/// threshold, so turning it back on restores what the admin chose rather
/// than the 0 they used to have to type to disable it.
private void testRuleToggles() {
    Thresholds t;
    t.connects = 4;
    t.connectsEnabled = false;
    auto v = evaluate(Observation(9, 0, 0, 60), t);
    check(!v.trip, "a disabled connect rule does not trip even far over its threshold");
    t.connectsEnabled = true;
    v = evaluate(Observation(9, 0, 0, 60), t);
    check(v.trip && v.rule == "connect_flood", "re-enabling restores the preserved threshold of 4");

    t = Thresholds.init;
    t.nicksEnabled = false;
    check(!evaluate(Observation(0, 99, 0, 60), t).trip, "nick_churn respects its flag");
    t = Thresholds.init;
    t.churnEnabled = false;
    check(!evaluate(Observation(0, 0, 99, 60), t).trip, "session_churn respects its flag");

    // A stored 0 must not fire on every connect even with the rule on.
    t = Thresholds.init;
    t.connects = 0;
    check(!evaluate(Observation(1, 0, 0, 60), t).trip, "an enabled rule with a 0 threshold never fires");
}

private void testValidateThresholds() {
    check(validateThresholds(Thresholds.init).length == 0, "the shipped defaults are a valid rule set");

    Thresholds t;
    t.windowSeconds = 1;
    auto errs = validateThresholds(t);
    check(errs.length == 1 && errs[0] == "window must be between 5 and 3600 seconds",
        "the window message is the exact text the API returns");

    t = Thresholds.init;
    t.connects = 1;
    check(validateThresholds(t).canFind("connect threshold must be between 2 and 100000"),
        "a threshold of 1 bans on the first connect and is refused");

    // A disabled rule is still range-checked, so re-enabling it can never
    // bring back a nonsense value.
    t = Thresholds.init;
    t.nicks = 1;
    t.nicksEnabled = false;
    check(validateThresholds(t).canFind("nick threshold must be between 2 and 100000"),
        "a disabled rule's threshold is validated too");

    t = Thresholds.init;
    t.shortMs = 900;
    t.banSeconds = 30;
    errs = validateThresholds(t);
    check(errs.canFind("short session must be between 1000 and 600000 ms"), "shortMs floor");
    check(errs.canFind("first ban must be between 60 and 2592000 seconds"), "banSeconds floor");
}

/// An exemption is a permanent hole — an exempt group is never counted, so
/// it can never be banned however hard it floods.
private void testExemptEntries() {
    check(validExemptEntry("76.32.236.21"), "a production exemption is storable");
    check(validExemptEntry("2603:8001:98f0:1530::/64"), "the production /64 is storable");
    check(validExemptEntry("198.51.100.0/24"), "a /24 is storable");
    check(!validExemptEntry("*"), "a catch-all glob is refused");
    check(!validExemptEntry("0.0.0.0/0"), "0.0.0.0/0 is refused");
    check(!validExemptEntry("::/0"), "::/0 is refused");
    check(!validExemptEntry("10.0.0.0/8"), "a /8 is wider than /16 and refused");
    check(!validExemptEntry("2603:8001::/16"), "a v6 prefix wider than /32 is refused");
    check(!validExemptEntry("76.32.236.*"), "a glob is refused even though zlineMatches honours it");
    check(!validExemptEntry("1.2.3.4 "), "a trailing space is refused");
    check(!validExemptEntry("1.2.3.4,5.6.7.8"), "a comma-joined pair is refused");
    check(!validExemptEntry(""), "empty is refused");
    check(!validExemptEntry("not an ip"), "unparsable input is refused");
}

/// A nick exemption skips counting for one user without shielding the
/// strangers behind the same exit — the p34c3 bouncer alts behind the
/// shared exit 185.206.149.176 are the motivating case.
private void testExemptNicks() {
    check(validExemptNick("p34c3"), "an exact nick is storable");
    check(validExemptNick("p34c3*"), "a trailing glob covers bouncer alts");
    check(validExemptNick("*p34c3?"), "a leading glob is storable");
    check(!validExemptNick("*"), "a bare catch-all is refused");
    check(!validExemptNick("?"), "a bare wildcard is refused");
    check(!validExemptNick("*?"), "wildcards alone carry no literal content");
    check(!validExemptNick("a"), "a single literal is refused");
    check(!validExemptNick("3foo"), "a digit-first nick can never match a real nick");
    check(!validExemptNick("a!b"), "a bang is refused");
    check(!validExemptNick("a@b"), "an at-sign is refused");
    check(!validExemptNick("a b"), "a space is refused");
    check(!validExemptNick("p34c3 "), "a trailing space is refused");
    check(!validExemptNick("p34c3,p34c3_"), "a comma-joined pair is refused");
    check(!validExemptNick(""), "empty is refused");
    check(!validExemptNick("123456789012345678901234567890123"), "33 chars exceed maxnick");

    check(nickExemptMatch("p34c3", "p34c3"), "an exact entry matches");
    check(nickExemptMatch("p34c3", "P34C3"), "matching is case-insensitive");
    check(nickExemptMatch("p34c3*", "p34c3_"), "the glob covers the bouncer alt");
    check(nickExemptMatch("p34c3*", "P34C3_E5EB"), "the glob covers the second alt regardless of case");
    check(!nickExemptMatch("p34c3*", "stranger"), "the glob does not cover strangers");
    check(!nickExemptMatch("p34c3", "p34c3_"), "an exact entry does not cover the alt");
    check(!nickExemptMatch("*", "p34c3"), "a catch-all entry never matches, however stored");
    check(!nickExemptMatch("p34c3", ""), "empty nick never matches");
}

private void testExemptNicksRuleSet() {
    RuleSet baseline;
    baseline.exemptNicks = ["p34c3*"];

    const roundTrip = RuleSet.fromJson(baseline.toJson(), RuleSet.init);
    check(roundTrip.exemptNicks == ["p34c3*"], "nick exemptions survive a JSON round trip");

    // A stored override written before the field existed degrades to the
    // deployed baseline instead of invalidating the whole set.
    const merged = RuleSet.fromJson(Json.emptyObject, baseline);
    check(merged.exemptNicks == ["p34c3*"], "a missing nick list inherits the baseline");

    // De-duplication folds case; the stored spelling wins.
    const deduped = RuleSet.fromJson(
        parseJsonString(`{"exemptNicks":["p34c3*","P34C3*","stranger"]}`), RuleSet.init);
    check(deduped.exemptNicks == ["p34c3*", "stranger"], "nick exemptions de-duplicate case-insensitively");

    const cleared = RuleSet.fromJson(parseJsonString(`{"exemptNicks":[]}`), baseline);
    check(cleared.exemptNicks.length == 0, "an explicit empty array clears the nick list");

    RuleSet bad;
    bad.exemptNicks = ["*"];
    check(validateRuleSet(bad).canFind(
            "invalid nick exemption (use a nick or a glob like p34c3*): *"),
        "a catch-all nick exemption is refused with the message the UI shows");

    auto after = RuleSet.init;
    after.exemptNicks = ["p34c3*"];
    check(summarizeRuleChange(RuleSet.init, after).indexOf("exemptNicks +1") >= 0,
        "a nick addition is counted in the change summary");
}

private void testRuleSetJson() {
    RuleSet baseline;
    baseline.thresholds.connects = 11;
    baseline.thresholds.windowSeconds = 45;
    baseline.ignoreClasses = ["ircfiber-engine"];
    baseline.exemptIps = ["76.32.236.21"];

    // A stored override written before a future field existed must degrade
    // to the deployed baseline for that field, not invalidate the whole set.
    const merged = RuleSet.fromJson(Json.emptyObject, baseline);
    check(merged.thresholds.connects == 11 && merged.thresholds.windowSeconds == 45,
        "missing numeric fields inherit the baseline");
    check(merged.ignoreClasses == baseline.ignoreClasses && merged.exemptIps == baseline.exemptIps,
        "missing lists inherit the baseline");
    check(merged.thresholds.churnEnabled, "missing flags inherit the baseline");

    const roundTrip = RuleSet.fromJson(baseline.toJson(), RuleSet.init);
    check(roundTrip.thresholds == baseline.thresholds, "thresholds survive a JSON round trip");
    check(roundTrip.exemptIps == baseline.exemptIps, "exemptions survive a JSON round trip");

    // An explicitly empty array clears a list; that is an edit, not a gap.
    const cleared = RuleSet.fromJson(parseJsonString(`{"exemptIps":[]}`), baseline);
    check(cleared.exemptIps.length == 0, "an explicit empty array clears the list");

    // Duplicates are canonicalised rather than rejected.
    const deduped = RuleSet.fromJson(
        parseJsonString(`{"ignoreClasses":["main","MAIN"," main "],"exemptIps":["1.2.3.4","1.2.3.4"]}`),
        baseline);
    check(deduped.ignoreClasses == ["main"], "ignore classes de-duplicate case-insensitively");
    check(deduped.exemptIps == ["1.2.3.4"], "exemptions de-duplicate exactly");

    // A wrong type is a missing field, not a zero.
    const mistyped = RuleSet.fromJson(parseJsonString(`{"connects":"lots"}`), baseline);
    check(mistyped.thresholds.connects == 11, "a mistyped field falls back to the baseline");
}

private void testValidateRuleSet() {
    RuleSet r;
    check(validateRuleSet(r).length == 0, "the built-in defaults are storable");

    r.exemptIps = ["*"];
    check(validateRuleSet(r).canFind(
            "invalid exemption (use an address or a CIDR no wider than /16 or /32): *"),
        "a catch-all exemption is refused with the message the UI shows");

    r = RuleSet.init;
    r.ignoreClasses = ["main class"];
    check(validateRuleSet(r).canFind("invalid connect class: main class"), "a class with a space is refused");

    r = RuleSet.init;
    foreach (i; 0 .. 65) r.exemptIps ~= "10.0." ~ (i / 256).to!string ~ "." ~ (i % 256).to!string ~ "/32";
    check(validateRuleSet(r).canFind("exemptIps has more than 64 entries"), "the list cap is enforced");
}

private void testSummarizeRuleChange() {
    RuleSet before;
    auto after = before;
    check(summarizeRuleChange(before, after) == "", "identical rule sets summarise to nothing");

    after.thresholds.connects = 4;
    after.thresholds.churnEnabled = false;
    after.exemptIps = ["203.0.113.7"];
    const s = summarizeRuleChange(before, after);
    check(s.indexOf("connects 10 -> 4") >= 0, "a threshold change is named with both values");
    check(s.indexOf("session_churn disabled") >= 0, "a rule being switched off is named");
    check(s.indexOf("exemptIps +1") >= 0, "a list addition is counted");

    // updatedAtMs/updatedBy always differ between baseline and override and
    // must not register as a rule change.
    auto stamped = before;
    stamped.updatedAtMs = 1_700_000_000_000;
    stamped.updatedBy = "ruleadmin";
    check(summarizeRuleChange(before, stamped) == "", "metadata alone is not a rule change");

    check(fiberEyeRulesKey() == "fibereye:rules", "rules mirror key shape");
}

private void testAutoPlacedPredicate() {
    check(isAutoPlacedZline(banReason("connect_flood", "https://ircfiber.com/unban/tok")),
        "FiberEye's own reason is recognised");
    // The retuned <connectban banmessage> carries the same marker.
    check(isAutoPlacedZline("FIBEREYE: connection flood detected. Appeal: https://ircfiber.com/unban"),
        "connectban banmessage is recognised");
    // Pre-cutover bans carry the mixed-case marker and must stay releasable.
    check(isAutoPlacedZline("FiberEye: connection flood detected. Appeal: https://ircfiber.com/unban"),
        "legacy mixed-case marker still recognised");
    // The default reason of the admin ban endpoint must NOT be liftable by
    // the public page — this is the check that protects the network.
    check(!isAutoPlacedZline("Banned by administrator"), "an oper's ban is not auto-placed");
    check(!isAutoPlacedZline(""), "empty reason is not auto-placed");

    check(banReason("connect_flood", "https://x/unban/t")
        == "FIBEREYE: connection flood from your address. Appeal: https://x/unban/t",
        "connect_flood reason wording");
    check(banReason("nick_churn", "https://x/u")
        == "FIBEREYE: too many nicknames from your address. Appeal: https://x/u",
        "nick_churn reason wording");
    check(banReason("session_churn", "https://x/u")
        == "FIBEREYE: repeated connect/disconnect from your address. Appeal: https://x/u",
        "session_churn reason wording");
    check(banReason("manual", "") == "FIBEREYE: banned by staff.", "manual reason without a URL");
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
    testRuleToggles();
    testExemptEntries();
    testExemptNicks();
    testExemptNicksRuleSet();
    testRuleSetJson();
    testValidateRuleSet();
    testSummarizeRuleChange();
    testAppealRoundTrip();
    if (failures) {
        writefln("%d check(s) failed", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("fibereye: all checks passed");
}
