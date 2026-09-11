module logs_format_test;

import std.stdio : writeln, writefln;
import std.conv : to;
import std.string : indexOf, startsWith, endsWith;
import std.algorithm : canFind;
import std.utf : validate;
import vibe.data.json : parseJsonString;

import ircfiber.ipintel.record : IpIntel, SourceMark;
import ircfiber.logs.events : LogEvent;
import ircfiber.logs.format;
import ircfiber.logs.backup_announce : backupAnnounceKey, backupDedupId, buildBackupEvent;

private int failures;

/// mIRC shorthand for styled-output expectations.
private enum TB = "\x02";
private enum TC = "\x03";

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

/// A record as the assembler would produce it: every printed field has a
/// provenance mark, so `formatLogEvent` treats it as "intel available".
private IpIntel sampleIntel() {
    IpIntel r;
    r.identity.ip = "203.0.113.7";
    r.geo.city = "Austin";
    r.geo.region = "Texas";
    r.geo.countryCode = "US";
    r.geo.latitude = 30.2672;
    r.geo.longitude = -97.7431;
    r.geo.timezone = "America/Chicago";
    r.network.asn = "AS15169";
    r.network.asName = "Google LLC";
    foreach (k; ["geo.city", "geo.region", "geo.countryCode", "geo.latitude", "geo.longitude",
                 "geo.timezone", "network.asn", "network.asName"])
        r.provenance[k] = SourceMark("ipinfo", 1, 604_800);
    return r;
}

private void testGeoClauses() {
    auto r = sampleIntel();
    // Coordinates are never printed to #staff (IP_INTEL.md §4 rule 4).
    check(geoDetail(r) == "Austin, Texas, US · AS15169 Google LLC · America/Chicago",
        "geo detail, got " ~ geoDetail(r));
    check(geoShort(r) == "Austin, US", "geo short, got " ~ geoShort(r));

    r.classification.isVpn = true;
    r.classification.vpnOperator = "Mullvad";
    r.classification.isHosting = true;
    r.reputation.riskScore = 73;
    r.identity.prefix = "185.65.134.0/24";
    check(geoDetail(r) == "Austin, Texas, US · AS15169 Google LLC · vpn(Mullvad)+hosting"
        ~ " · risk 73 · prefix 185.65.134.0/24 · America/Chicago",
        "flags, risk and prefix clauses, got " ~ geoDetail(r));

    IpIntel net;
    net.geo.countryCode = "US";
    net.classification.networkType = "residential";
    net.provenance["geo.countryCode"] = SourceMark("proxycheck", 1, 1);
    check(geoDetail(net) == "US · net residential",
        "raw network type renders, got " ~ geoDetail(net));

    net.classification.networkType = "hosting";
    check(geoDetail(net) == "US · net hosting",
        "unconfirmed hosting surfaces as network type, got " ~ geoDetail(net));
    net.classification.isHosting = true;
    check(geoDetail(net) == "US · hosting",
        "confirmed flag absorbs the net clause, got " ~ geoDetail(net));

    IpIntel org;
    org.geo.countryCode = "DE";
    org.network.asn = "AS39351";
    org.network.asName = "31173 Services AB";
    org.network.org = "Mullvad VPN AB";
    org.provenance["geo.countryCode"] = SourceMark("ipapi_is", 1, 1);
    check(geoDetail(org) == "DE · AS39351 31173 Services AB · org Mullvad VPN AB",
        "org clause, got " ~ geoDetail(org));
    org.network.org = "31173 services ab";
    check(geoDetail(org) == "DE · AS39351 31173 Services AB",
        "org matching asName adds nothing, got " ~ geoDetail(org));
    org.network.org = "";
    org.network.isp = "Mullvad";
    check(geoDetail(org) == "DE · AS39351 31173 Services AB · org Mullvad",
        "isp falls back as org, got " ~ geoDetail(org));

    IpIntel rep;
    rep.geo.countryCode = "DE";
    rep.reputation.dnsbl = ["dronebl:5"];
    rep.provenance["geo.countryCode"] = SourceMark("dronebl", 1, 1);
    check(geoDetail(rep) == "DE · listed dronebl:5",
        "dnsbl clause, got " ~ geoDetail(rep));
    rep.reputation.sfsFrequency = 9;
    check(geoDetail(rep) == "DE · listed dronebl:5 · sfs freq 9",
        "sfs clause, got " ~ geoDetail(rep));

    IpIntel sparse;
    sparse.geo.countryCode = "DE";
    sparse.provenance["geo.countryCode"] = SourceMark("ipinfo", 1, 1);
    check(geoDetail(sparse) == "DE", "missing clauses are skipped, got " ~ geoDetail(sparse));
    check(geoShort(sparse) == "DE", "short falls back to country");
    check(geoShort(IpIntel.init) == "", "empty record renders nothing");
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
    auto first = formatLogEvent(ev, sampleIntel(), true);
    check(first.length == 1, "signup is one line");
    check(first[0] == TC ~ "03" ~ TB ~ "Signup:" ~ TB ~ TC ~ " " ~ TB ~ "alice" ~ TB
        ~ " <alice@example.com> · 203.0.113.7 · Austin, Texas, US"
        ~ " · AS15169 Google LLC · America/Chicago",
        "signup first sighting, got " ~ first[0]);

    auto again = formatLogEvent(ev, sampleIntel(), false);
    check(again[0] == TC ~ "03" ~ TB ~ "Signup:" ~ TB ~ TC ~ " " ~ TB ~ "alice" ~ TB
        ~ " <alice@example.com> · 203.0.113.7 · known IP (Austin, US)",
        "signup seen before, got " ~ again[0]);

    auto priv = ev;
    priv.ip = "10.0.0.5";
    check(formatLogEvent(priv, IpIntel.init, false)[0]
        == TC ~ "03" ~ TB ~ "Signup:" ~ TB ~ TC ~ " " ~ TB ~ "alice" ~ TB
        ~ " <alice@example.com> · 10.0.0.5 · private IP",
        "signup from a private IP");

    auto nogeo = formatLogEvent(ev, IpIntel.init, false);
    check(nogeo[0] == TC ~ "03" ~ TB ~ "Signup:" ~ TB ~ TC ~ " " ~ TB ~ "alice" ~ TB
        ~ " <alice@example.com> · 203.0.113.7 · geo unavailable",
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
    auto sent = formatLogEvent(ev, IpIntel.init, false);
    check(sent.length == 1 && sent[0]
        == TC ~ "03" ~ TB ~ "Email sent:" ~ TB ~ TC
        ~ " signup_verification → alice@example.com (alice) · resend · 412ms",
        "mail sent, got " ~ sent[0]);

    ev.username = "";
    check(formatLogEvent(ev, IpIntel.init, false)[0]
        == TC ~ "03" ~ TB ~ "Email sent:" ~ TB ~ TC
        ~ " signup_verification → alice@example.com · resend · 412ms",
        "username clause omitted when empty");

    ev.username = "alice";
    ev.status = "failed";
    ev.error = "resend rejected the message: HTTP 422 domain not verified";
    auto failed = formatLogEvent(ev, IpIntel.init, false);
    check(failed[0] == TC ~ "04" ~ TB ~ "Email FAILED:" ~ TB ~ TC
        ~ " signup_verification → alice@example.com (alice) · resend"
        ~ " · resend rejected the message: HTTP 422 domain not verified",
        "mail failed, got " ~ failed[0]);

    ev.error = "";
    foreach (i; 0 .. 40) ev.error ~= "0123456789";
    auto clipped = formatLogEvent(ev, IpIntel.init, false)[0];
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
    auto first = formatLogEvent(ev, sampleIntel(), true);
    check(first.length == 2, "first sighting emits the intel follow-up line");
    check(first[0] == TC ~ "12" ~ TB ~ "IRC connect:" ~ TB ~ TC ~ " "
        ~ TB ~ "alice!~alice@host.example" ~ TB ~ " (203.0.113.7) · class main"
        ~ " · port 6697 · [Alice]",
        "connect headline, got " ~ first[0]);
    check(first[1] == "↳ 203.0.113.7 · Austin, Texas, US · AS15169 Google LLC · America/Chicago",
        "connect intel line, got " ~ first[1]);

    auto again = formatLogEvent(ev, sampleIntel(), false);
    check(again.length == 1, "known IP is one line");
    check(again[0].endsWith(" · [Alice] · known IP (Austin, US)"),
        "known IP suffix, got " ~ again[0]);

    auto known = sampleIntel();
    known.reputation.sessionCount = 12;
    check(formatLogEvent(ev, known, false)[0].endsWith(" · known IP (Austin, US) · 12 sessions"),
        "session count suffix, got " ~ formatLogEvent(ev, known, false)[0]);
    known.reputation.sessionCount = 1;
    check(formatLogEvent(ev, known, false)[0].endsWith(" · known IP (Austin, US)"),
        "one session adds no count");

    auto flagged = sampleIntel();
    flagged.classification.isVpn = true;
    flagged.classification.vpnOperator = "Mullvad";
    flagged.classification.isHosting = true;
    flagged.reputation.sessionCount = 12;
    check(formatLogEvent(ev, flagged, false)[0].endsWith(
        " · known IP (Austin, US) · vpn(Mullvad)+hosting · 12 sessions"),
        "repeat connect keeps its flags, got " ~ formatLogEvent(ev, flagged, false)[0]);

    auto netOnly = sampleIntel();
    netOnly.classification.networkType = "residential";
    check(formatLogEvent(ev, netOnly, false)[0].endsWith(" · known IP (Austin, US) · net residential"),
        "repeat connect keeps its network type, got " ~ formatLogEvent(ev, netOnly, false)[0]);

    auto priv = ev;
    priv.ip = "172.20.0.4";
    auto p = formatLogEvent(priv, IpIntel.init, false);
    check(p.length == 1 && p[0].endsWith(" · private IP"), "private IP suffix");

    auto nogeo = formatLogEvent(ev, IpIntel.init, false);
    check(nogeo.length == 1 && nogeo[0].endsWith(" · geo unavailable"), "geo unavailable suffix");

    auto noReal = ev;
    noReal.realname = "";
    check(!formatLogEvent(noReal, IpIntel.init, false)[0].canFind("[]"),
        "empty realname clause omitted");

    auto huge = ev;
    huge.realname = "";
    foreach (i; 0 .. 40) huge.realname ~= "0123456789";
    auto line = formatLogEvent(huge, IpIntel.init, false)[0];
    check(line.length <= LOGS_LINE_MAX_BYTES, "connect line is capped at 400 bytes");
    check(line.canFind("…"), "over-long realname is truncated");
    validate(line);
}

private void testFormatNoticeAndUnknown() {
    LogEvent ev;
    ev.type = "notice";
    ev.actor = "zodiac";
    ev.text = "maintenance in 10 min";
    check(formatLogEvent(ev, IpIntel.init, false)[0]
        == "Notice from " ~ TB ~ "zodiac" ~ TB ~ ": maintenance in 10 min",
        "notice line");
    ev.text = "";
    check(formatLogEvent(ev, IpIntel.init, false).length == 0, "empty notice emits nothing");

    LogEvent unknown;
    unknown.type = "wat";
    check(formatLogEvent(unknown, IpIntel.init, false).length == 0, "unknown type emits nothing");
}

private void testXlineAttribution() {
    check(xlineAttribution([], "") == "", "no attribution when nothing known");
    check(xlineAttribution(["p34c3_e5eb"], "") == " · trigger: p34c3_e5eb",
        "single nick, got " ~ xlineAttribution(["p34c3_e5eb"], ""));
    check(xlineAttribution(["a", "b", "a", "", "c"], "alice") == " · trigger: a, b, c [alice]",
        "dupes and blanks folded, account bracketed");
    check(xlineAttribution([], "alice") == " · trigger: [alice]", "account alone");
    check(xlineAttribution(["ALICE", "alice"], "") == " · trigger: ALICE",
        "nick dedupe is case-insensitive");
    check(xlineAttribution(["n1", "n2", "n3", "n4", "n5", "n6"], "")
        == " · trigger: n1, n2, n3, n4, n5", "nick list capped at five");
    check(xlineAttribution(["ev\x02il"], "") == " · trigger: ev il",
        "control bytes sanitized");

}
private void testStyleBanNotice() {
    enum B = "\x02";
    enum C = "\x03";
    check(styleBanNotice("maintenance in 10 min") == "maintenance in 10 min",
        "non-ban notice untouched");
    check(styleBanNotice("ZLINE 1.2.3.4 for 3600s (connect_flood, strike 1)")
        == C ~ "04" ~ B ~ "ZLINE" ~ B ~ C ~ " " ~ B ~ "1.2.3.4" ~ B ~ " for 3600s (connect_flood, strike 1)",
        "own placement: red keyword, bold mask");
    const foreign = "XLINE: m_connectban@irc.ircfiber.com added a timed Z-line on 185.206.149.176,"
        ~ " expires in 5 minutes: FIBEREYE: connection flood detected. Appeal: https://ircfiber.com/unban"
        ~ " · trigger: bob, alice [alice]";
    const styled = styleBanNotice(foreign);
    check(styled.indexOf(C ~ "04" ~ B ~ "Z-line" ~ B ~ C) >= 0, "automatic: red Z-line keyword");
    check(styled.indexOf(B ~ "185.206.149.176" ~ B) >= 0, "automatic: bold mask");
    check(styled.indexOf("· trigger: " ~ B ~ "bob, alice" ~ B ~ " [" ~ C ~ "12alice" ~ C ~ "]") >= 0,
        "trigger nicks bold, account blue, got " ~ styled);
    check(styleBanNotice("ZLINE 1.2.3.4 for 5s (x, strike 1) · trigger: unknown · 9 connects seen")
        .indexOf("· trigger: unknown · 9 connects seen") >= 0,
        "unknown fallback stays plain");
    check(styleBanNotice("ZLINE 1.2.3.4 for 5s (x, strike 1) · trigger: [alice]")
        .indexOf("· trigger: [" ~ C ~ "12alice" ~ C ~ "]") >= 0,
        "account-only trigger blue");
    LogEvent ev;
    ev.type = "notice";
    ev.actor = "FiberEye";
    ev.text = "ZLINE 1.2.3.4 for 60s (connect_flood, strike 1)";
    check(formatLogEvent(ev, IpIntel.init, false)[0].indexOf(C ~ "04") >= 0,
        "notice render path styles ban lines");
    ev.text = "maintenance in 10 min";
    check(formatLogEvent(ev, IpIntel.init, false)[0]
        == "Notice from " ~ TB ~ "FiberEye" ~ TB ~ ": maintenance in 10 min",
        "notice render path bolds the actor, leaves the text plain");
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

private void testBackupSize() {
    check(backupSize(512) == "512 B", "512 B, got " ~ backupSize(512));
    check(backupSize(0) == "0 B", "0 B");
    check(backupSize(-7) == "0 B", "negative bytes clamp to 0 B");
    check(backupSize(1023) == "1023 B", "just under 1 KB stays bytes");
    check(backupSize(1024) == "1.0 KB", "1 KB, got " ~ backupSize(1024));
    check(backupSize(1536) == "1.5 KB", "1.5 KB, got " ~ backupSize(1536));
    check(backupSize(1_048_576) == "1.0 MB", "1 MB, got " ~ backupSize(1_048_576));
    check(backupSize(117_858_406) == "112.4 MB", "112.4 MB, got " ~ backupSize(117_858_406));
}

private LogEvent backupOkEvent() {
    LogEvent ev;
    ev.type = "backup";
    ev.kind = "mongo";
    ev.status = "ok";
    ev.stage = "done";
    ev.file = "mongo-20260907-031700.archive.gz";
    ev.fileBytes = 117_858_406;
    ev.durationMs = 45231;
    return ev;
}

private void testFormatBackupOk() {
    auto line = formatLogEvent(backupOkEvent(), IpIntel.init, false);
    check(line.length == 1, "backup ok is one line");
    check(line[0] == "Backup mongo " ~ TC ~ "03" ~ TB ~ "ok:" ~ TB ~ TC
        ~ " mongo-20260907-031700.archive.gz · 112.4 MB · 45231ms",
        "backup ok line, got " ~ line[0]);

    auto noFile = backupOkEvent();
    noFile.file = "";
    check(formatLogEvent(noFile, IpIntel.init, false)[0]
        == "Backup mongo " ~ TC ~ "03" ~ TB ~ "ok:" ~ TB ~ TC ~ " 112.4 MB · 45231ms",
        "empty file omits the file clause");

    auto noDur = backupOkEvent();
    noDur.durationMs = 0;
    check(formatLogEvent(noDur, IpIntel.init, false)[0]
        == "Backup mongo " ~ TC ~ "03" ~ TB ~ "ok:" ~ TB ~ TC
        ~ " mongo-20260907-031700.archive.gz · 112.4 MB",
        "non-positive duration omits the duration clause");

    auto noKind = backupOkEvent();
    noKind.kind = "";
    check(formatLogEvent(noKind, IpIntel.init, false)[0].startsWith("Backup backup "),
        "empty kind falls back to backup");
}

private void testFormatBackupFailed() {
    LogEvent ev;
    ev.type = "backup";
    ev.kind = "mongo";
    ev.status = "failed";
    ev.stage = "verify";
    ev.error = "FAILED: messages missing";
    auto line = formatLogEvent(ev, IpIntel.init, false);
    check(line.length == 1 && line[0] == "Backup mongo " ~ TC ~ "04" ~ TB ~ "FAILED" ~ TB ~ TC
        ~ " at verify: FAILED: messages missing",
        "backup failed line, got " ~ (line.length ? line[0] : "<none>"));

    ev.stage = "";
    check(formatLogEvent(ev, IpIntel.init, false)[0].startsWith("Backup mongo " ~ TC),
        "empty stage falls back to unknown");

    ev.status = "";
    check(formatLogEvent(ev, IpIntel.init, false)[0].startsWith("Backup mongo " ~ TC),
        "non-ok status takes the FAILED shape");

    ev.status = "failed";
    ev.stage = "verify";
    ev.error = "";
    foreach (i; 0 .. 40) ev.error ~= "0123456789";
    auto clipped = formatLogEvent(ev, IpIntel.init, false)[0];
    check(clipped.canFind("…"), "over-long backup error is truncated");
    check(clipped.length <= LOGS_LINE_MAX_BYTES, "failed backup line is capped");
}

private void testBackupEventJson() {
    auto ev = backupOkEvent();
    ev.ts = 1_765_000_000_000;
    auto round = LogEvent.fromJson(parseJsonString(ev.toJson().toString()));
    check(round.type == "backup" && round.stage == "done"
        && round.file == ev.file && round.fileBytes == ev.fileBytes,
        "backup fields round-trip through JSON");

    auto partial = LogEvent.fromJson(parseJsonString(`{"type":"backup"}`));
    check(partial.stage == "" && partial.file == "" && partial.fileBytes == 0,
        "missing backup fields keep their init value");
}

private void testBackupAnnouncePure() {
    check(backupAnnounceKey() == "irc:logs:backup:announced", "announce SET key");
    auto run = parseJsonString(`{"kind":"mongo","status":"failed","stage":"verify",`
        ~ `"startedAt":1725600000000,"finishedAt":1725600060000,"durationMs":60000,`
        ~ `"file":"mongo-test.archive.gz","bytes":123,"message":"FAILED: messages missing"}`);
    check(backupDedupId(run) == "mongo:1725600000000:mongo-test.archive.gz",
        "dedup id, got " ~ backupDedupId(run));
    auto ev = buildBackupEvent(run);
    check(ev.type == "backup" && ev.ts == 1_725_600_060_000 && ev.kind == "mongo"
        && ev.status == "failed" && ev.stage == "verify" && ev.file == "mongo-test.archive.gz"
        && ev.fileBytes == 123 && ev.durationMs == 60000
        && ev.error == "FAILED: messages missing" && ev.text == "FAILED: messages missing",
        "run maps to its event");
    auto unfinished = parseJsonString(`{"kind":"redis","status":"ok","stage":"done",`
        ~ `"startedAt":1725600000000,"finishedAt":0,"durationMs":100,`
        ~ `"file":"r.rdb.gz","bytes":512,"message":""}`);
    check(buildBackupEvent(unfinished).ts == 1_725_600_000_000,
        "zero finishedAt falls back to startedAt");
}
void main() {
    testParseConnectNotice();
    testClassIgnored();
    testIsPrivateIp();
    testGeoClauses();
    testFormatSignup();
    testFormatMail();
    testFormatConnect();
    testFormatNoticeAndUnknown();
    testEventJson();
    testBackupSize();
    testFormatBackupOk();
    testFormatBackupFailed();
    testStyleBanNotice();
    testBackupEventJson();
    testBackupAnnouncePure();
    testXlineAttribution();

    if (failures > 0) {
        writefln("logs format tests: %d FAILED", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("logs format tests: PASS");
}
