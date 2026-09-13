module ircd_test;

///
/// Unit tests for the IRCd admin parsing/redaction helpers
/// (ircfiber.web.admin.ircd). All samples are real InspIRCd 4.11
/// protocol lines captured from a live server — no network needed:
///   dub --root=backend build --config=ircd-test && ./backend/ircd-test
///

import std.stdio : writeln, writefln;
import std.string : indexOf;

import ircfiber.web.admin.ircd : HISTORY_SKEW_MS, isHistoryReplayLine, parseIrcLine, parseIrcTimestamp,
    parseNamesLine, parseServerTimeTag, parseStatsXLine, parseListLine,
    stripStatusPrefix, parseConfTag, parseConfTags, redactConfText, redactedMarker,
    restoreSecrets, validBanMask, XLine, ChanInfo, NamesInfo;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

private void testParseIrcLine() {
    auto l = parseIrcLine(":probe.test 210 operA2 g mask@h 1788427942 600 operA :reason here");
    check(l.valid && l.prefix == "probe.test" && l.command == "210", "210 prefix/command");
    check(l.params == ["operA2", "g", "mask@h", "1788427942", "600", "operA", "reason here"],
        "210 trailing param keeps spaces");
    auto p = parseIrcLine("PING :12345");
    check(p.valid && p.prefix == "" && p.command == "PING" && p.params == ["12345"], "PING no prefix");
    auto t = parseIrcLine("@time=2026-09-03 :srv NOTICE n :hi");
    check(t.valid && t.prefix == "srv" && t.command == "NOTICE", "tags stripped");
    check(!parseIrcLine("").valid, "empty invalid");
    check(!parseIrcLine("   ").valid, "blank invalid");
    auto m = parseIrcLine(":srv MODE operA :+o");
    check(m.valid && m.params == ["operA", "+o"], "MODE params");
}

private void testParseServerTime() {
    // Anchors that need no hand-computed civil dates.
    check(parseIrcTimestamp("1970-01-01T00:00:00Z") == 0, "epoch is zero");
    check(parseIrcTimestamp("1970-01-01T00:00:01Z") == 1_000, "one second is 1000 ms");
    // Millis arithmetic is exact: the same instant half a second apart.
    const a = parseIrcTimestamp("2026-09-09T15:33:00.000Z");
    check(a > 0, "2026 stamp positive");
    check(parseIrcTimestamp("2026-09-09T15:33:00.500Z") == a + 500, "fractional millis exact");
    check(parseIrcTimestamp("2026-09-09T15:33:01Z") == a + 1_000, "fraction digits optional");
    check(parseIrcTimestamp("2026-09-09T15:33:00.000100Z") == a, "sub-millis truncated");
    check(parseIrcTimestamp("2026-02-29T12:00:00Z") > parseIrcTimestamp("2026-02-28T12:00:00Z"),
        "leap-day ordering");
    // Malformed input is -1, never an exception.
    check(parseIrcTimestamp("") == -1, "empty rejected");
    check(parseIrcTimestamp("2026-09-09 15:33:00Z") == -1, "space instead of T rejected");
    check(parseIrcTimestamp("2026-09-09T15:33:00+00:00") == -1, "offset rejected, Z only");
    check(parseIrcTimestamp("2026-13-01T00:00:00Z") == -1, "month 13 rejected");
    check(parseIrcTimestamp("2026-09-09T25:00:00Z") == -1, "hour 25 rejected");
    check(parseIrcTimestamp("2026-09-09T15:33:00.") == -1, "bare dot rejected");
    check(parseIrcTimestamp("2026-09-09T15:33:00Z ") == -1, "trailing space rejected");
    // Tag section: first usable `time=` wins, escapes decoded.
    check(parseServerTimeTag("time=2026-09-09T15:33:00.000Z") == a, "bare time tag");
    check(parseServerTimeTag("msgid=abc;time=2026-09-09T15:33:00.500Z") == a + 500,
        "time after other tags");
    check(parseServerTimeTag("foo=1;bar=2") == -1, "no time tag is -1");
    check(parseServerTimeTag("time=junk") == -1, "bad time value is -1");
    // The parser carries the stamp onto the line; untagged lines stay -1.
    auto h = parseIrcLine("@time=2026-09-09T15:33:00.000Z :nick!u@h PRIVMSG #support :!issues");
    check(h.valid && h.serverTimeMs == a, "line carries server time");
    check(parseIrcLine(":srv NOTICE n :hi").serverTimeMs == -1, "untagged is -1");
    // Replay rule: older than JOIN minus skew is replay, live is not,
    // unknown channel and untagged lines never are.
    const joinAt = a + 1_000_000;
    check(isHistoryReplayLine(a, joinAt), "day-old line is replay");
    check(!isHistoryReplayLine(joinAt, joinAt), "line at join is live");
    check(!isHistoryReplayLine(joinAt + 5_000, joinAt), "line after join is live");
    check(!isHistoryReplayLine(joinAt - HISTORY_SKEW_MS, joinAt), "skew edge is live");
    check(isHistoryReplayLine(joinAt - HISTORY_SKEW_MS - 1, joinAt), "past skew is replay");
    check(!isHistoryReplayLine(-1, joinAt), "untagged never replay");
    check(!isHistoryReplayLine(a, 0), "unknown channel never replay");
}

private void testParseStatsXLine() {
    XLine x;
    check(parseStatsXLine(parseIrcLine(
        ":probe.test 210 operZ Z 192.0.2.77 1788428163 3600 operZ :probe z engaged"), x),
        "STATS Z 210 parses");
    check(x.type == "Z" && x.mask == "192.0.2.77" && x.setAt == 1788428163 &&
        x.durationSecs == 3600 && x.setter == "operZ" && x.reason == "probe z engaged",
        "STATS Z fields");
    check(parseStatsXLine(parseIrcLine(
        ":probe.test 210 operA2 g u@*.example 1788427942 600 operA :probe gline"), x) &&
        x.type == "g", "gline letter");
    check(!parseStatsXLine(parseIrcLine(
        ":probe.test 249 operA :Whowas entries: 4"), x), "249 rejected");
    check(!parseStatsXLine(parseIrcLine(
        ":probe.test 219 operA g :End of /STATS report"), x), "219 rejected");
}

private void testParseListLine() {
    ChanInfo c;
    check(parseListLine(parseIrcLine(
        ":probe.test 322 operA #probe 1 :[+nt] "), c), "322 parses");
    check(c.name == "#probe" && c.users == 1 && c.modes == "+nt" && c.topic == "",
        "322 fields, empty topic");
    check(parseListLine(parseIrcLine(
        ":irc.test 322 n #chat 42 :[+nt] Welcome to chat, enjoy!"), c) &&
        c.topic == "Welcome to chat, enjoy!" && c.users == 42, "322 topic spaces");
    check(!parseListLine(parseIrcLine(
        ":probe.test 321 operA Channel :Users Name"), c), "321 rejected");
}

private void testParseNamesLine() {
    NamesInfo n;
    check(parseNamesLine(parseIrcLine(":probe.test 353 operA = #probe :@chanB +voice plain"), n),
        "353 parses");
    check(n.channel == "#probe" && n.members == ["@chanB", "+voice", "plain"], "353 members");
    check(stripStatusPrefix("@chanB") == "chanB", "strip @");
    check(stripStatusPrefix("+voice") == "voice", "strip +");
    check(stripStatusPrefix("plain") == "plain", "no prefix untouched");
    check(stripStatusPrefix("@") == "@", "lone @ kept");
}

private void testRedact() {
    check(redactConfText(`<cloak method="hmac-sha256" key="SECRETKEY" prefix="a">`) ==
        `<cloak method="hmac-sha256" key="***REDACTED#1***" prefix="a">`, "cloak key masked");
    check(redactConfText(`      password="abc$def"`) ==
        `      password="***REDACTED#1***"`, "oper password masked");
    check(redactConfText(`<server name="irc.example.com">`) ==
        `<server name="irc.example.com">`, "non-secret untouched");
    // Multi-secret line numbers left to right, not per attribute name.
    check(redactConfText(`<link name="s" sendpass="A" recvpass="B">`) ==
        `<link name="s" sendpass="***REDACTED#1***" recvpass="***REDACTED#2***">`,
        "multi-secret line numbered left to right");
    // custom.conf shape: two identically indented recvpass lines must get
    // distinct markers — an unindexed marker made this pair unsavable.
    auto twin = redactConfText("      recvpass=\"A\"\n      recvpass=\"B\"");
    check(twin == "      recvpass=\"***REDACTED#1***\"\n      recvpass=\"***REDACTED#2***\"",
        "identical lines get distinct indices");
    check(twin.indexOf("\"A\"") < 0 && twin.indexOf("\"B\"") < 0, "no live secret survives");
    auto doc = "<link name=\"s\"\n      sendpass=\"A\"\n      recvpass=\"B\">\n<server name=\"x\">";
    auto red = redactConfText(doc);
    check(red.indexOf("\"A\"") < 0 && red.indexOf("\"B\"") < 0, "both link secrets gone");
    check(red.indexOf(redactedMarker(1)) >= 0 && red.indexOf(redactedMarker(2)) >= 0 &&
        red.indexOf("<server name=\"x\">") >= 0, "structure preserved");
}

private void testRestoreSecrets() {
    // (a) redacted sendpass line restores live password byte-for-byte
    auto live = "      sendpass=\"secret123\"";
    auto submitted = "      sendpass=\"***REDACTED#1***\"";
    auto r = restoreSecrets(live, submitted);
    check(r.error.length == 0 && r.restored == live, "restore single secret");

    // (b) untouched lines pass through
    live = "      sendpass=\"secret123\"\n      other=\"value\"";
    submitted = "      sendpass=\"***REDACTED#1***\"\n      other=\"value\"";
    r = restoreSecrets(live, submitted);
    check(r.error.length == 0 && r.restored == live, "untouched lines pass");

    // (c) the custom.conf regression: two identically indented secret
    // lines round-trip to their own values (this is what used to 400).
    live = "      recvpass=\"A\"\n      recvpass=\"B\"";
    r = restoreSecrets(live, redactConfText(live));
    check(r.error.length == 0 && r.restored == live, "twin secret lines round-trip");

    // (d) reordering the editor buffer keeps each secret with its marker
    submitted = "      recvpass=\"***REDACTED#2***\"\n      recvpass=\"***REDACTED#1***\"";
    r = restoreSecrets(live, submitted);
    check(r.error.length == 0 && r.restored == "      recvpass=\"B\"\n      recvpass=\"A\"",
        "markers follow their index, not their position");

    // (e) multi-secret line positional refill
    live = `<link name="s" sendpass="A" recvpass="B">`;
    r = restoreSecrets(live, redactConfText(live));
    check(r.error.length == 0 && r.restored == live, "multi-secret positional");

    // (f) index out of range -> error naming the 1-based line
    live = "      other=\"value\"";
    submitted = "x\n      sendpass=\"***REDACTED#1***\"";
    r = restoreSecrets(live, submitted);
    check(r.error.length > 0 && r.error.indexOf("line 2") >= 0, "out of range -> error");

    // (g) unindexed leftover marker -> error naming the 1-based line
    live = "      sendpass=\"secret123\"";
    submitted = "      sendpass=\"***REDACTED***\"";
    r = restoreSecrets(live, submitted);
    check(r.error.length > 0 && r.error.indexOf("line 1") >= 0 &&
        r.error.indexOf("no index") >= 0, "bare marker -> error");

    // (h) line without marker keeps submitted value (Ansible vault paste)
    submitted = "      sendpass=\"vault-copied-value\"";
    r = restoreSecrets(live, submitted);
    check(r.error.length == 0 && r.restored == submitted, "vault paste kept");
}

private void testParseConfTags() {
    // custom.conf shape: two <link> blocks plus an <autoconnect>.
    auto conf = "# a comment about <link> tags\n" ~
        "<link name=\"irc.netcrave.chat\"\n      ipaddr=\"1.2.3.4\"\n      port=\"4445\"\n" ~
        "      sendpass=\"A\"\n      recvpass=\"B\">\n" ~
        "<link name=\"k8s.ircfiber.com\"\n      ipaddr=\"5.6.7.8\"\n      port=\"4445\"\n" ~
        "      sendpass=\"C\"\n      recvpass=\"D\">\n" ~
        "<autoconnect period=\"120\" server=\"irc.netcrave.chat\">\n";
    auto links = parseConfTags(conf, "link");
    check(links.length == 2, "both link tags found");
    check(links.length == 2 && links[0]["name"] == "irc.netcrave.chat" &&
        links[1]["name"] == "k8s.ircfiber.com", "link names in file order");
    check(links.length == 2 && links[1]["ipaddr"] == "5.6.7.8" && links[1]["port"] == "4445",
        "second link attrs are its own");
    check(parseConfTag(conf, "link")["name"] == "irc.netcrave.chat", "singular returns first");
    check(parseConfTags(conf, "autoconnect").length == 1 &&
        parseConfTags(conf, "autoconnect")[0]["server"] == "irc.netcrave.chat", "autoconnect parsed");
    check(parseConfTags(conf, "server").length == 0, "absent tag is empty");
    // Prefix guard: <connectban> must not be found by <connect>.
    check(parseConfTags("<connectban threshold=\"10\">", "connect").length == 0,
        "prefix guard holds");
}

private void testValidBanMask() {
    check(validBanMask("*@*.example"), "wildcard mask ok");
    check(validBanMask("192.0.2.99"), "IP ok");
    check(!validBanMask(""), "empty rejected");
    check(!validBanMask("a b"), "space rejected");
    check(!validBanMask("a,b"), "comma rejected");
    check(!validBanMask("a\nb"), "newline rejected");
}

void main() {
    testParseIrcLine();
    testParseServerTime();
    testParseStatsXLine();
    testParseListLine();
    testParseNamesLine();
    testRedact();
    testRestoreSecrets();
    testParseConfTags();
    testValidBanMask();
    if (failures) {
        writefln("ircd tests: %d FAILED", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("ircd tests: PASS");
}
