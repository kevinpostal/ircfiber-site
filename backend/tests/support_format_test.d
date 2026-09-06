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
    auto e = parseBotCommand("hello");
    check(!e.ok && e.name == "", "plain text is not a command");
    auto f = parseBotCommand("!frobnicate now");
    check(!f.ok && f.name == "frobnicate", "unknown !word keeps its name (caller stays silent)");
    check(!parseBotCommand("!").ok, "lone ! rejected");
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
