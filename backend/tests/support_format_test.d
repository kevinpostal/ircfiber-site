module support_format_test;

import std.stdio : writeln, writefln;
import std.conv : to;
import std.string : indexOf, startsWith, endsWith;
import std.algorithm : canFind;
import std.utf : validate, count;
import vibe.data.json : Json, parseJsonString;

import ircfiber.db.support_issues : SupportIssueRecord;
import ircfiber.support.events : SupportEvent;
import ircfiber.support.format;
import ircfiber.support.json : sanitizeLine;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

private void testParseBotCommand() {
    auto a = parseBotCommand("!issue 12");
    check(a.ok && a.name == "issue" && a.arg == "12", "!issue 12");
    auto b = parseBotCommand("!ISSUES all");
    check(b.ok && b.name == "issues" && b.arg == "all", "!ISSUES all lower-cases name and arg");
    auto c = parseBotCommand("!help");
    check(c.ok && c.name == "help" && c.arg == "", "!help");
    check(parseBotCommand("!issues").ok, "!issues bare");
    check(parseBotCommand("  !issues open ").ok, "!issues open with padding");

    auto d = parseBotCommand("!issue");
    check(!d.ok && d.name == "issue", "!issue without number rejected but named");
    check(!parseBotCommand("!issue abc").ok, "!issue abc rejected");
    check(!parseBotCommand("!issue 0").ok, "!issue 0 rejected");
    check(!parseBotCommand("!issue -1").ok, "!issue -1 rejected");
    check(!parseBotCommand("!issues bogus").ok, "!issues bogus rejected");
    auto g = parseBotCommand("!adduser bob");
    check(g.ok && g.name == "adduser" && g.arg == "bob", "!adduser bob");
    auto h = parseBotCommand("!nsinfo bob");
    check(h.ok && h.name == "nsinfo" && h.arg == "bob", "!nsinfo bob");
    auto ni = parseBotCommand("!NSINFO Bob");
    check(ni.ok && ni.name == "nsinfo" && ni.arg == "Bob", "!NSINFO Bob lower-cases name, preserves arg");
    check(!parseBotCommand("!adduser").ok, "bare !adduser rejected");
    check(!parseBotCommand("!nsinfo").ok, "bare !nsinfo rejected");
    check(!parseBotCommand("!adduser bob alice").ok, "!adduser two-word arg rejected");
    check(!parseBotCommand("!nsinfo bob alice").ok, "!nsinfo two-word arg rejected");
    import std.array : replicate;
    check(parseBotCommand("!adduser " ~ replicate("a", 32)).ok, "!adduser 32-char nick ok");
    check(!parseBotCommand("!adduser " ~ replicate("a", 33)).ok, "!adduser 33-char nick rejected");
    check(!parseBotCommand("!nsinfo " ~ replicate("a", 33)).ok, "!nsinfo 33-char nick rejected");
    auto nw = parseBotCommand("!new Fix flood pacing");
    check(nw.ok && nw.name == "new" && nw.arg == "Fix flood pacing", "!new keeps arg case");
    auto bg = parseBotCommand("!BUG Upload dialog freezes | on drop");
    check(bg.ok && bg.name == "bug" && bg.arg == "Upload dialog freezes | on drop", "!BUG lower-cases name only");
    check(!parseBotCommand("!new ab").ok, "!new with a 2-char title rejected");
    check(!parseBotCommand("!new").ok, "bare !new rejected");
    auto ha = parseBotCommand("!help admin");
    check(ha.ok && ha.name == "help" && ha.arg == "admin", "!help admin");
    check(!parseBotCommand("!help wat").ok, "!help wat rejected");
    check(parseBotCommand("!prio 14 high").ok, "!prio 14 high");
    check(!parseBotCommand("!prio 14 nope").ok, "!prio with an unknown priority rejected");
    check(!parseBotCommand("!prio 14").ok, "!prio without a priority rejected");
    check(parseBotCommand("!done 14").ok, "!done 14");
    auto dn = parseBotCommand("!done");
    check(!dn.ok && dn.name == "done", "bare !done rejected but named");
    check(parseBotCommand("!close #14").ok && parseBotCommand("!reopen 14").ok, "!close/!reopen");
    check(parseBotCommand("!note 14 check ergo config").ok, "!note 14 <text>");
    check(!parseBotCommand("!note 14").ok, "!note without text rejected");
    auto e = parseBotCommand("hello");
    check(!e.ok && e.name == "", "plain text is not a command");
    auto f = parseBotCommand("!frobnicate now");
    check(!f.ok && f.name == "frobnicate", "unknown !word keeps its name (caller stays silent)");
    check(!parseBotCommand("!").ok, "lone ! rejected");
}

private void testParseNewIssue() {
    auto a = parseNewIssue("Upload freezes | drops on composer");
    check(a.ok && a.title == "Upload freezes" && a.body_ == "drops on composer", "title | details split");
    auto b = parseNewIssue("Rework throttle");
    check(b.ok && b.title == "Rework throttle" && b.body_ == "", "no details part");
    auto c = parseNewIssue("bug Upload freezes");
    check(c.ok && c.title == "bug Upload freezes", "argument is never parsed as a kind: " ~ c.title);
    check(!parseNewIssue("ab").ok, "2-char title rejected");
    check(!parseNewIssue("   ").ok, "blank title rejected");
    import std.array : replicate;
    check(parseNewIssue(replicate("a", 120)).ok, "120-char title ok");
    check(!parseNewIssue(replicate("a", 121)).ok, "121-char title rejected");
    auto inj = parseNewIssue("Evil\r\nPRIVMSG #ops :pwned | body\r\nsecond");
    check(inj.ok && !inj.title.canFind("\r") && !inj.title.canFind("\n"), "title sanitized: " ~ inj.title);
    check(parseNewIssue("t | " ~ replicate("b", 6000)).body_.length == 5000, "details clipped to 5000 bytes");
}

private void testParseIssueRef() {
    auto a = parseIssueRef("#14 high", true);
    check(a.ok && a.number == 14 && a.rest == "high", "#14 high");
    check(!parseIssueRef("14", true).ok, "rest required but missing");
    auto b = parseIssueRef("14", false);
    check(b.ok && b.number == 14 && b.rest == "", "bare number when rest optional");
    check(!parseIssueRef("0", false).ok, "issue 0 rejected");
    check(!parseIssueRef("abc", false).ok, "non-numeric rejected");
    check(!parseIssueRef("", false).ok, "empty rejected");
    check(!parseIssueRef("1234567890", false).ok, "10-digit number rejected");
    auto c = parseIssueRef(" 7   some note text ", true);
    check(c.ok && c.number == 7 && c.rest == "some note text", "padding stripped: \"" ~ c.rest ~ "\"");

    check(normalizePriority("HIGH") == "high", "HIGH → high");
    check(normalizePriority("u") == "urgent", "u → urgent");
    check(normalizePriority(" low ") == "low", "padding stripped");
    check(normalizePriority("x") == "", "unknown priority → empty");
    check(normalizePriority("") == "", "empty priority → empty");
}

private void testHelpLines() {
    auto h = formatHelp("https://ircfiber.com");
    check(h.length == 1 && h[0].canFind("!help admin"), "public help points at !help admin");
    auto a = formatAdminHelp();
    check(a.length == 2, "admin help is two lines: " ~ a.length.to!string);
    if (a.length == 2) {
        check(a[0].canFind("!new") && a[0].canFind("!prio") && a[0].canFind("!note"), "track line: " ~ a[0]);
        check(a[1].canFind("!adduser") && a[1].canFind("!nsinfo"), "services line: " ~ a[1]);
        check(a[0].length <= SUPPORT_LINE_MAX_BYTES, "track line fits one IRC line");
    }
}

private SupportEvent sampleEvent(string type) {
    SupportEvent ev;
    ev.type = type;
    ev.issueId = "6f1c2a3b-0000-4000-8000-000000000012";
    ev.number = 12;
    ev.kind = "bug";
    ev.title = "Upload dialog freezes";
    ev.status = "in_progress";
    ev.priority = "normal";
    ev.actor = "kevin";
    ev.reporter = "zodiac";
    ev.actorIsAdmin = true;
    ev.ts = 1_765_000_000_000;
    return ev;
}

private void testFormatSupportEvent() {
    const url = "https://ircfiber.com/admin#/support/6f1c2a3b-0000-4000-8000-000000000012";

    auto created = formatSupportEvent(sampleEvent("issue_created"), "https://ircfiber.com/");
    check(created.length == 1, "issue_created is one line");
    if (created.length == 1) {
        check(created[0] == "New issue #12 [bug] \"Upload dialog freezes\" — reported by zodiac · " ~ url,
            "issue_created line: " ~ created[0]);
    }

    auto status = formatSupportEvent(sampleEvent("status_changed"), "https://ircfiber.com");
    check(status.length == 1, "status_changed is one line");
    if (status.length == 1) {
        check(status[0] == "Issue #12 → in progress (by kevin) — \"Upload dialog freezes\"",
            "status_changed line: " ~ status[0]);
    }

    auto admin = formatSupportEvent(sampleEvent("comment_added"), "https://ircfiber.com");
    check(admin.length == 1 && admin[0] == "Issue #12 — new reply from kevin (admin) — \"Upload dialog freezes\" · " ~ url,
        "admin comment line: " ~ (admin.length ? admin[0] : "<none>"));

    auto rep = sampleEvent("comment_added");
    rep.actor = "zodiac";
    rep.actorIsAdmin = false;
    rep.reopened = true;
    auto reporter = formatSupportEvent(rep, "https://ircfiber.com");
    check(reporter.length == 1 && reporter[0].canFind("new reply from zodiac (reporter)"), "reporter variant");
    check(reporter.length == 1 && reporter[0].endsWith(" · reopened"), "reopened suffix");

    check(formatSupportEvent(sampleEvent("bogus"), "https://ircfiber.com").length == 0, "unknown type → nothing");

    // Injection: CR/LF and IRC control codes in the title collapse to spaces.
    auto inj = sampleEvent("issue_created");
    inj.title = "Evil\r\nPRIVMSG #ops :pwned\x02bold";
    auto lines = formatSupportEvent(inj, "https://ircfiber.com");
    check(lines.length == 1, "injected title still one line");
    if (lines.length == 1) {
        check(!lines[0].canFind("\r") && !lines[0].canFind("\n") && !lines[0].canFind("\x02"), "control chars stripped");
        check(lines[0].canFind("\"Evil  PRIVMSG #ops :pwned bold\""), "title kept as a single quoted line: " ~ lines[0]);
    }

    auto notice = sampleEvent("notice");
    notice.title = "Maintenance in 10 minutes\r\nPRIVMSG #ops :x";
    auto nl = formatSupportEvent(notice, "https://ircfiber.com");
    check(nl.length == 1 && nl[0] == "Notice from kevin: Maintenance in 10 minutes  PRIVMSG #ops :x", "notice line: " ~ (nl.length ? nl[0] : "<none>"));
    notice.title = "   ";
    check(formatSupportEvent(notice, "https://ircfiber.com").length == 0, "blank notice → nothing");

    // Long titles are cut to 80 code points with an ellipsis, and the whole
    // line stays under the byte cap.
    auto lng = sampleEvent("issue_created");
    foreach (i; 0 .. 30) lng.title ~= "ünïcödé ";
    auto ll = formatSupportEvent(lng, "https://ircfiber.com");
    check(ll.length == 1 && ll[0].length <= SUPPORT_LINE_MAX_BYTES, "long line clipped to byte cap");
    if (ll.length == 1) {
        validate(ll[0]);
        auto q1 = ll[0].indexOf("\"");
        auto q2 = ll[0].indexOf("\"", q1 + 1);
        check(q1 >= 0 && q2 > q1, "quoted title present");
        if (q1 >= 0 && q2 > q1) {
            auto shown = ll[0][q1 + 1 .. q2];
            check(shown.count == 80 && shown.endsWith("…"), "title truncated to 80 code points with ellipsis: " ~ shown.count.to!string);
        }
    }
}

private void testTruncateText() {
    check(truncateText("abc", 3) == "abc", "no cut when it fits");
    check(truncateText("abcdef", 3) == "ab…", "cut keeps max-1 chars plus ellipsis");
    check(truncateText("", 5) == "", "empty");
    check(truncateText("abc", 0) == "", "max 0");
    check(truncateText("héllo wörld", 5) == "héll…", "multibyte counted as one char");
    // Never split a multi-byte sequence: every prefix length must stay valid UTF-8.
    const s = "日本語テキスト🙂と絵文字";
    foreach (n; 1 .. 12) {
        auto t = truncateText(s, n);
        validate(t);
        check(t.count <= n, "truncateText(" ~ n.to!string ~ ") within limit: " ~ t.count.to!string);
    }
    check(clipBytes("日本語", 4) == "日", "clipBytes backs up to a sequence start");
    check(clipBytes("abc", 10) == "abc", "clipBytes no-op when short");
}

private void testRelativeAge() {
    const now = 1_765_000_000_000L;
    check(relativeAge(now - 5_000, now) == "just now", "just now");
    check(relativeAge(now - 5 * 60_000, now) == "5m ago", "5m ago");
    check(relativeAge(now - 3 * 3_600_000, now) == "3h ago", "3h ago");
    check(relativeAge(now - 2 * 86_400_000, now) == "2d ago", "2d ago");
    check(relativeAge(now + 60_000, now) == "just now", "future clamps to just now");
}

private void testUrls() {
    check(adminIssueUrl("https://ircfiber.com/", "abc") == "https://ircfiber.com/admin#/support/abc", "trailing slash stripped");
    check(adminIssueUrl("https://ircfiber.com", "abc") == "https://ircfiber.com/admin#/support/abc", "no trailing slash");
    check(feedbackUrl("https://ircfiber.com/") == "https://ircfiber.com/?/feedback", "feedback url");
    auto help = formatHelp("https://ircfiber.com");
    check(help.length == 1 && help[0].canFind("!issues [open|all]") && help[0].canFind("!issue <n>")
        && help[0].endsWith("https://ircfiber.com/?/feedback"), "help line: " ~ help[0]);
}

private SupportIssueRecord sampleIssue(long number, string status) {
    SupportIssueRecord r;
    r.id = "id-" ~ number.to!string;
    r.number = number;
    r.kind = "bug";
    r.title = "Title " ~ number.to!string;
    r.status = status;
    r.priority = "high";
    r.reporterUsername = "zodiac";
    r.createdAt = 1_765_000_000_000L - 2 * 3_600_000;
    return r;
}

private void testSummaryAndDetail() {
    const now = 1_765_000_000_000L;
    long[string] counts = ["open": 3L, "in_progress": 1L, "resolved": 12L, "closed": 2L];
    SupportIssueRecord[] recent;
    foreach (i; 0 .. 7) recent ~= sampleIssue(20 - i, "open");
    auto s = formatIssuesSummary(counts, recent, now, "https://ircfiber.com");
    check(s.length == 1 + SUPPORT_SUMMARY_ROWS, "summary head + 5 rows: " ~ s.length.to!string);
    if (s.length) check(s[0] == "Support: 3 open · 1 in progress · 12 resolved · 2 closed", "summary head: " ~ s[0]);
    if (s.length > 1) check(s[1] == "#20 [bug] Title 20 — zodiac, 2h ago", "summary row: " ~ s[1]);

    auto empty = formatIssuesSummary(counts, [], now, "https://ircfiber.com");
    check(empty.length == 2 && empty[1].startsWith("No matching issues"), "empty recent → hint row");

    auto r = sampleIssue(12, "open");
    auto d = formatIssueDetail(r, now, "https://ircfiber.com");
    check(d.length == 1 && d[0] == "#12 [bug · open · high] Title 12 — reported by zodiac 2h ago · assignee: — · https://ircfiber.com/admin#/support/id-12",
        "detail unassigned: " ~ (d.length ? d[0] : "<none>"));
    r.assigneeUsername = "kevin";
    r.status = "in_progress";
    auto d2 = formatIssueDetail(r, now, "https://ircfiber.com");
    check(d2.length == 1 && d2[0].canFind("[bug · in progress · high]") && d2[0].canFind("assignee: kevin"),
        "detail assigned: " ~ (d2.length ? d2[0] : "<none>"));
}

private void testSanitizeLine() {
    check(sanitizeLine("  a\r\nb\tc\x03d  ") == "a  b c d", "controls → spaces, stripped");
    check(sanitizeLine("plain") == "plain", "plain unchanged");
    check(sanitizeLine("ünï\ncödé") == "ünï cödé", "multibyte preserved");
}

private void testEventJsonRoundTrip() {
    auto ev = sampleEvent("comment_added");
    ev.reopened = true;
    auto back = SupportEvent.fromJson(parseJsonString(ev.toJson().toString()));
    check(back == ev, "SupportEvent JSON round trip");

    auto partial = SupportEvent.fromJson(parseJsonString(`{"type":"issue_created","number":7,"title":"t"}`));
    check(partial.type == "issue_created" && partial.number == 7 && partial.title == "t"
        && partial.actor == "" && !partial.actorIsAdmin && !partial.reopened && partial.ts == 0,
        "fromJson tolerates missing fields");
    check(SupportEvent.fromJson(parseJsonString(`[1,2]`)) == SupportEvent.init, "non-object → init");
}

void main() {
    testParseBotCommand();
    testParseNewIssue();
    testParseIssueRef();
    testHelpLines();
    testFormatSupportEvent();
    testTruncateText();
    testRelativeAge();
    testUrls();
    testSummaryAndDetail();
    testSanitizeLine();
    testEventJsonRoundTrip();
    if (failures) {
        writefln("support format tests: %d FAILED", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("support format tests: PASS");
}
