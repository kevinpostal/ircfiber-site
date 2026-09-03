module ircd_test;

///
/// Unit tests for the IRCd admin parsing/redaction helpers
/// (ircfiber.web.admin.ircd). All samples are real InspIRCd 4.11
/// protocol lines captured from a live server — no network needed:
///   dub --root=backend build --config=ircd-test && ./backend/ircd-test
///

import std.stdio : writeln, writefln;
import std.string : indexOf;

import ircfiber.web.admin.ircd : parseIrcLine, parseStatsXLine, parseListLine,
    parseNamesLine, stripStatusPrefix, redactAttr, redactConfText,
    validBanMask, XLine, ChanInfo, NamesInfo;

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
    check(redactAttr(`<cloak method="hmac-sha256" key="SECRETKEY" prefix="a">`, "key") ==
        `<cloak method="hmac-sha256" key="***REDACTED***" prefix="a">`, "cloak key masked");
    check(redactAttr(`      sendpass="hunter2"`, "sendpass") ==
        `      sendpass="***REDACTED***"`, "sendpass masked");
    check(redactAttr(`      password="abc$def"`, "password") ==
        `      password="***REDACTED***"`, "oper password masked");
    check(redactAttr(`<server name="irc.example.com">`, "key") ==
        `<server name="irc.example.com">`, "non-secret untouched");
    auto doc = "<link name=\"s\"\n      sendpass=\"A\"\n      recvpass=\"B\">\n<server name=\"x\">";
    auto red = redactConfText(doc);
    check(red.indexOf("\"A\"") < 0 && red.indexOf("\"B\"") < 0, "both link secrets gone");
    check(red.indexOf("***REDACTED***") >= 0 && red.indexOf("<server name=\"x\">") >= 0,
        "structure preserved");
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
    testParseStatsXLine();
    testParseListLine();
    testParseNamesLine();
    testRedact();
    testValidBanMask();
    if (failures) {
        writefln("ircd tests: %d FAILED", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("ircd tests: PASS");
}
