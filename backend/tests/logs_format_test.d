module logs_format_test;

import std.stdio : writeln, writefln;
import std.conv : to;
import std.string : indexOf, startsWith, endsWith;
import std.algorithm : canFind;
import std.utf : validate;
import vibe.data.json : parseJsonString;

import ircfiber.logs.events : LogEvent;
import ircfiber.logs.format;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

private void testParseConnectNotice() {
    auto a = parseConnectNotice(
        "*** Client connecting on port 6697 (class main): alice!~alice@host.example (203.0.113.7) [Alice]");
    check(a.ok, "real InspIRCd notice parses");
    check(a.port == 6697, "port 6697, got " ~ a.port.to!string);
    check(a.connClass == "main", "class main, got " ~ a.connClass);
    check(a.nick == "alice" && a.ident == "~alice" && a.host == "host.example",
        "mask split, got " ~ a.nick ~ "/" ~ a.ident ~ "/" ~ a.host);
    check(a.ip == "203.0.113.7", "ip, got " ~ a.ip);
    check(a.realname == "Alice", "realname, got " ~ a.realname);

    auto b = parseConnectNotice(
        "Client connecting on port 6667 (class ircfiber-engine): bob!~bob@gw (10.0.0.9) [Bob]");
    check(b.ok && b.connClass == "ircfiber-engine" && b.port == 6667,
        "notice without the *** prefix parses");

    auto v6 = parseConnectNotice(
        "*** Client connecting on port 6697 (class main): carol!~carol@2001:db8::1 (2001:db8::1) [Carol]");
    check(v6.ok && v6.host == "2001:db8::1" && v6.ip == "2001:db8::1",
        "IPv6 host/ip survive, got " ~ v6.host ~ " / " ~ v6.ip);

    auto noReal = parseConnectNotice(
        "*** Client connecting on port 6667 (class main): dave!~dave@h.example (198.51.100.9)");
    check(noReal.ok && noReal.realname == "" && noReal.ip == "198.51.100.9",
        "missing [realname] still yields the ip");

    auto brackets = parseConnectNotice(
        "*** Client connecting on port 6667 (class main): eve!~eve@h (198.51.100.10) [Al (ice) [x]]");
    check(brackets.ok && brackets.realname == "Al (ice) [x]",
        "realname with brackets/parens survives, got " ~ brackets.realname);
    check(brackets.ip == "198.51.100.10", "ip not eaten by a bracketed realname, got " ~ brackets.ip);
    check(brackets.host == "h", "host intact, got " ~ brackets.host);

    auto reset = parseConnectNotice(
        "*** Client connecting on port 6667 (class main): fred!~fred@h (198.51.100.11) [Fred\x0F]");
    check(reset.realname == "Fred", "trailing \\x0F stripped, got " ~ reset.realname);

    check(!parseConnectNotice("*** Nick zodiac is now an IRC operator").ok,
        "non-connect notice rejected");
    check(!parseConnectNotice("*** Client exiting on port 6667 (class main): a!b@c").ok,
        "exit notice rejected");
    check(!parseConnectNotice("Client connecting on port abc (class main): a!b@c (1.2.3.4)").ok,
        "non-numeric port rejected");
    check(!parseConnectNotice("Client connecting on port 6667 main: a!b@c (1.2.3.4)").ok,
        "missing (class …) rejected");
    check(!parseConnectNotice("Client connecting on port 6667 (class main): justanick (1.2.3.4)").ok,
        "mask without !@ rejected");
    check(!parseConnectNotice("").ok, "empty notice rejected");

    // Control bytes are collapsed to spaces — they must never reach a PRIVMSG.
    auto inj = parseConnectNotice(
        "*** Client connecting on port 6667 (class main): ev\x02il!~a@h (1.2.3.4) [bad\x02name]");
    check(inj.ok, "notice with control bytes still parses");
    foreach (ch; inj.nick) check(ch >= 0x20, "nick has no control bytes");
    foreach (ch; inj.realname) check(ch >= 0x20, "realname has no control bytes");
    check(inj.nick == "ev il" && inj.realname == "bad name",
        "control bytes became spaces, got " ~ inj.nick ~ " / " ~ inj.realname);
}

private void testClassIgnored() {
    const def = ["ircfiber-engine", "ircfiber-engine-v6", "localhost"];
    check(classIgnored("ircfiber-engine", def), "exact class ignored");
    check(classIgnored("IRCFiber-Engine", def), "class match is case-insensitive");
    check(classIgnored("  localhost ", def), "padded class ignored");
    check(!classIgnored("main", def), "unlisted class announced");
    check(!classIgnored("main", []), "empty ignore list ignores nothing");
    check(!classIgnored("main", [""]), "blank entries are skipped");
    check(!classIgnored("", def), "empty class is never ignored");
}

private void testIsPrivateIp() {
    foreach (ip; ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1",
                  "169.254.1.1", "::1", "fe80::1", "fd00::1", "", "unknown", "0.0.0.0",
                  "255.255.255.999", "::ffff:10.0.0.1"])
        check(isPrivateIp(ip), "private/unusable: " ~ ip);
    foreach (ip; ["172.32.0.1", "8.8.8.8", "203.0.113.7", "2001:db8::1", "::ffff:8.8.8.8"])
        check(!isPrivateIp(ip), "public: " ~ ip);
}

private GeoInfo sampleGeo() {
    GeoInfo g;
    g.ok = true;
    g.ip = "203.0.113.7";
    g.city = "Austin";
    g.region = "Texas";
    g.country = "US";
    g.loc = "30.2672,-97.7431";
    g.org = "AS15169 Google LLC";
    g.timezone = "America/Chicago";
    return g;
}

private void testGeoClauses() {
    auto g = sampleGeo();
    check(geoDetail(g) == "Austin, Texas, US · AS15169 Google LLC · 30.2672,-97.7431 · America/Chicago",
        "geo detail, got " ~ geoDetail(g));
    check(geoShort(g) == "Austin, US", "geo short, got " ~ geoShort(g));

    g.privacyFlags = "vpn+hosting";
    check(geoDetail(g).endsWith(" · vpn+hosting"), "privacy flags appended");

    GeoInfo sparse;
    sparse.ok = true;
    sparse.country = "DE";
    check(geoDetail(sparse) == "DE", "missing clauses are skipped, got " ~ geoDetail(sparse));
    check(geoShort(sparse) == "DE", "short falls back to country");
    check(geoShort(GeoInfo.init) == "", "empty geo renders nothing");
}

private void testAsnFromOrg() {
    // Core-endpoint shape: "AS<n> <operator>". The operator name is what the
    // admin Mullvad page shows as the ISP, so the split must not eat it.
    auto a = asnFromOrg("AS39351 31173 Services AB");
    check(a.ok && a.asn == "AS39351" && a.name == "31173 Services AB",
        "AS head split, got " ~ a.asn ~ "/" ~ a.name);
    check(a.domain == "", "Core org carries no domain");

    // am.i.mullvad.net's `organization` has no AS head — the whole value is
    // the operator, and inventing an ASN from it would be a lie.
    auto plain = asnFromOrg("Mullvad VPN AB");
    check(plain.ok && plain.asn == "" && plain.name == "Mullvad VPN AB",
        "no AS head keeps the whole string as the operator, got " ~ plain.asn ~ "/" ~ plain.name);

    // "AS" is only an ASN when digits follow it: an operator may legitimately
    // start with those two letters.
    auto assist = asnFromOrg("ASSIST Networks Ltd");
    check(assist.asn == "" && assist.name == "ASSIST Networks Ltd",
        "AS prefix without digits is a name, got " ~ assist.asn ~ "/" ~ assist.name);

    auto bare = asnFromOrg("  AS15169  ");
    check(bare.ok && bare.asn == "AS15169" && bare.name == "",
        "number with no operator, got " ~ bare.asn ~ "/" ~ bare.name);

    check(!asnFromOrg("   ").ok, "blank org yields nothing");
    check(!asnFromOrg("").ok, "empty org yields nothing");
}

private LogEvent signupEvent() {
    LogEvent ev;
    ev.type = "signup";
    ev.ts = 1_765_000_000_000;
    ev.username = "alice";
    ev.email = "alice@example.com";
    ev.ip = "203.0.113.7";
    return ev;
}

private void testFormatSignup() {
    auto ev = signupEvent();
    auto first = formatLogEvent(ev, sampleGeo(), true);
    check(first.length == 1, "signup is one line");
    check(first[0] == "Signup: alice <alice@example.com> · 203.0.113.7 · Austin, Texas, US"
        ~ " · AS15169 Google LLC · 30.2672,-97.7431 · America/Chicago",
        "signup first sighting, got " ~ first[0]);

    auto again = formatLogEvent(ev, sampleGeo(), false);
    check(again[0] == "Signup: alice <alice@example.com> · 203.0.113.7 · known IP (Austin, US)",
        "signup seen before, got " ~ again[0]);

    auto priv = ev;
    priv.ip = "10.0.0.5";
    check(formatLogEvent(priv, GeoInfo.init, false)[0]
        == "Signup: alice <alice@example.com> · 10.0.0.5 · private IP",
        "signup from a private IP");

    auto nogeo = formatLogEvent(ev, GeoInfo.init, false);
    check(nogeo[0] == "Signup: alice <alice@example.com> · 203.0.113.7 · geo unavailable",
        "signup with no geo, got " ~ nogeo[0]);
}

private void testFormatMail() {
    LogEvent ev;
    ev.type = "mail";
    ev.kind = "signup_verification";
    ev.email = "alice@example.com";
    ev.username = "alice";
    ev.provider = "resend";
    ev.status = "sent";
    ev.durationMs = 412;
    auto sent = formatLogEvent(ev, GeoInfo.init, false);
    check(sent.length == 1 && sent[0]
        == "Email sent: signup_verification → alice@example.com (alice) · resend · 412ms",
        "mail sent, got " ~ sent[0]);

    ev.username = "";
    check(formatLogEvent(ev, GeoInfo.init, false)[0]
        == "Email sent: signup_verification → alice@example.com · resend · 412ms",
        "username clause omitted when empty");

    ev.username = "alice";
    ev.status = "failed";
    ev.error = "resend rejected the message: HTTP 422 domain not verified";
    auto failed = formatLogEvent(ev, GeoInfo.init, false);
    check(failed[0] == "Email FAILED: signup_verification → alice@example.com (alice) · resend"
        ~ " · resend rejected the message: HTTP 422 domain not verified",
        "mail failed, got " ~ failed[0]);

    ev.error = "";
    foreach (i; 0 .. 40) ev.error ~= "0123456789";
    auto clipped = formatLogEvent(ev, GeoInfo.init, false)[0];
    check(clipped.canFind("…"), "over-long error is truncated");
    check(clipped.length <= LOGS_LINE_MAX_BYTES, "failed mail line is capped");
}

private LogEvent connectEvent() {
    LogEvent ev;
    ev.type = "irc_connect";
    ev.nick = "alice";
    ev.ident = "~alice";
    ev.host = "host.example";
    ev.ip = "203.0.113.7";
    ev.connClass = "main";
    ev.port = 6697;
    ev.realname = "Alice";
    return ev;
}

private void testFormatConnect() {
    auto ev = connectEvent();
    auto first = formatLogEvent(ev, sampleGeo(), true);
    check(first.length == 2, "first sighting emits the geo follow-up line");
    check(first[0] == "IRC connect: alice!~alice@host.example (203.0.113.7) · class main"
        ~ " · port 6697 · [Alice]",
        "connect headline, got " ~ first[0]);
    check(first[1] == "↳ 203.0.113.7 · Austin, Texas, US · AS15169 Google LLC"
        ~ " · 30.2672,-97.7431 · America/Chicago",
        "connect geo line, got " ~ first[1]);

    auto again = formatLogEvent(ev, sampleGeo(), false);
    check(again.length == 1, "known IP is one line");
    check(again[0].endsWith(" · [Alice] · known IP (Austin, US)"),
        "known IP suffix, got " ~ again[0]);

    auto priv = ev;
    priv.ip = "172.20.0.4";
    auto p = formatLogEvent(priv, GeoInfo.init, false);
    check(p.length == 1 && p[0].endsWith(" · private IP"), "private IP suffix");

    auto nogeo = formatLogEvent(ev, GeoInfo.init, false);
    check(nogeo.length == 1 && nogeo[0].endsWith(" · geo unavailable"), "geo unavailable suffix");

    auto noReal = ev;
    noReal.realname = "";
    check(!formatLogEvent(noReal, GeoInfo.init, false)[0].canFind("[]"),
        "empty realname clause omitted");

    auto huge = ev;
    huge.realname = "";
    foreach (i; 0 .. 40) huge.realname ~= "0123456789";
    auto line = formatLogEvent(huge, GeoInfo.init, false)[0];
    check(line.length <= LOGS_LINE_MAX_BYTES, "connect line is capped at 400 bytes");
    check(line.canFind("…"), "over-long realname is truncated");
    validate(line);
}

private void testFormatNoticeAndUnknown() {
    LogEvent ev;
    ev.type = "notice";
    ev.actor = "zodiac";
    ev.text = "maintenance in 10 min";
    check(formatLogEvent(ev, GeoInfo.init, false)[0] == "Notice from zodiac: maintenance in 10 min",
        "notice line");
    ev.text = "";
    check(formatLogEvent(ev, GeoInfo.init, false).length == 0, "empty notice emits nothing");

    LogEvent unknown;
    unknown.type = "wat";
    check(formatLogEvent(unknown, GeoInfo.init, false).length == 0, "unknown type emits nothing");
}

private void testEventJson() {
    auto ev = connectEvent();
    ev.ts = 1_765_000_000_000;
    auto round = LogEvent.fromJson(parseJsonString(ev.toJson().toString()));
    check(round.type == ev.type && round.nick == ev.nick && round.port == ev.port
        && round.ip == ev.ip && round.ts == ev.ts, "LogEvent round-trips through JSON");

    auto partial = LogEvent.fromJson(parseJsonString(`{"type":"signup","ip":"8.8.8.8"}`));
    check(partial.type == "signup" && partial.ip == "8.8.8.8" && partial.username == "",
        "missing fields keep their init value");
    check(LogEvent.fromJson(parseJsonString(`"nope"`)).type == "", "non-object yields LogEvent.init");
}

void main() {
    testParseConnectNotice();
    testClassIgnored();
    testIsPrivateIp();
    testGeoClauses();
    testAsnFromOrg();
    testFormatSignup();
    testFormatMail();
    testFormatConnect();
    testFormatNoticeAndUnknown();
    testEventJson();

    if (failures > 0) {
        writefln("logs format tests: %d FAILED", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("logs format tests: PASS");
}
