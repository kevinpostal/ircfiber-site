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
import ircfiber.support.mail : SupportMailNotice, SupportMailRecipient, supportMailRecipients,
    supportSubject, supportReporterMail, supportStaffMail;
import ircfiber.models.user : User;
import std.uuid : UUID, parseUUID;

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

private void testNeedsLocalAck() {
    // Prod runs "#support,#ircfiber": the announcement lands in #support, so
    // an oper typing !new in #ircfiber (or in a DM) must be answered there.
    check(!needsLocalAck("#support", "#support"), "primary channel: announcement is the ack");
    check(!needsLocalAck("#SUPPORT", "#support"), "channel names are case-insensitive");
    check(needsLocalAck("#ircfiber", "#support"), "secondary channel gets its own ack");
    check(needsLocalAck("Zodiac", "#support"), "a DM gets its own ack");
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

private User mkUser(string id, string name, string email, bool admin) {
    User u;
    u.id = parseUUID(id);
    u.username = name;
    u.email = email;
    if (admin) u.roles = ["admin"];
    return u;
}

private enum RID = "11111111-1111-4111-8111-111111111111";
private enum AID = "22222222-2222-4222-8222-222222222222";
private enum BID = "33333333-3333-4333-8333-333333333333";

private void testSupportMailRecipients() {
    auto reporter = mkUser(RID, "rep", "rep@example.org", false);
    auto alice = mkUser(AID, "alice", "alice@example.org", true);
    auto bob = mkUser(BID, "bob", "bob@example.org", true);
    auto plain = mkUser("44444444-4444-4444-8444-444444444444", "plain", "plain@example.org", false);

    // Admin acts → reporter only, admin-facing flag off.
    SupportMailNotice n;
    n.type = "comment_added"; n.actorIsAdmin = true; n.actorId = AID; n.reporterId = RID;
    auto r = supportMailRecipients(n, reporter, [alice, bob]);
    check(r.length == 1 && r[0].email == "rep@example.org" && !r[0].staff, "admin reply → reporter");

    // Admin acting on their own report mails nobody.
    auto own = n; own.actorId = RID;
    check(supportMailRecipients(own, reporter, [alice, bob]).length == 0, "actor never mails themself");

    // Reporter with a malformed / empty address → nothing.
    auto noMail = reporter; noMail.email = "";
    check(supportMailRecipients(n, noMail, [alice, bob]).length == 0, "reporter without email skipped");
    auto badMail = reporter; badMail.email = "not an address";
    check(supportMailRecipients(n, badMail, [alice, bob]).length == 0, "malformed reporter email skipped");

    // Reporter acts, unassigned → every admin (non-admin rows ignored), staff flag on.
    SupportMailNotice u;
    u.type = "comment_added"; u.actorIsAdmin = false; u.actorId = RID; u.reporterId = RID;
    auto all = supportMailRecipients(u, reporter, [alice, plain, bob]);
    check(all.length == 2 && all[0].email == "alice@example.org" && all[1].email == "bob@example.org"
        && all[0].staff && all[1].staff, "unassigned → all admins, staff-facing");

    // Assigned → only the assignee.
    auto assigned = u; assigned.assigneeId = BID;
    auto one = supportMailRecipients(assigned, reporter, [alice, bob]);
    check(one.length == 1 && one[0].username == "bob", "assigned → assignee only");

    // Assignee row gone → back to every admin.
    auto gone = u; gone.assigneeId = "99999999-9999-4999-8999-999999999999";
    check(supportMailRecipients(gone, reporter, [alice, bob]).length == 2, "missing assignee → all admins");

    // An admin filing their own report is not mailed about it.
    auto selfReport = u; selfReport.actorId = AID; selfReport.reporterId = AID;
    auto others = supportMailRecipients(selfReport, alice, [alice, bob]);
    check(others.length == 1 && others[0].username == "bob", "admin reporter excluded from staff fan-out");

    // Same address under two admin rows is mailed once.
    auto bobTwin = mkUser("55555555-5555-4555-8555-555555555555", "bob2", "bob@example.org", true);
    check(supportMailRecipients(u, reporter, [bob, bobTwin]).length == 1, "duplicate address mailed once");
}

private void testSupportMailContent() {
    SupportMailNotice n;
    n.type = "comment_added"; n.issueId = "abc-123"; n.number = 42; n.kind = "bug";
    n.title = "Scroll <jumps>"; n.status = "in_progress"; n.priority = "high";
    n.actor = "alice"; n.actorIsAdmin = true; n.reporter = "rep";
    n.text = "Fixed in build 7 — please <re>test.\nSecond line.";

    check(supportSubject(n) == "[IRC Fiber support #42] Reply from alice: Scroll <jumps>", "reply subject");
    auto rm = supportReporterMail(n, "rep@example.org", "https://ircfiber.com/");
    check(rm.toEmail == "rep@example.org", "reporter mail addressed");
    check(rm.text.canFind("alice replied to your report #42 \"Scroll <jumps>\":")
        && rm.text.canFind("    Fixed in build 7 — please <re>test.\n    Second line.\n")
        && rm.text.canFind("Status: in progress")
        && rm.text.canFind("https://ircfiber.com/?/feedback"), "reporter text: lead, quoted body, status, feedback link");
    check(!rm.text.canFind("/admin#/"), "reporter mail never links the admin pane");
    check(rm.html.canFind("Scroll &lt;jumps&gt;") && rm.html.canFind("&lt;re&gt;test")
        && !rm.html.canFind("<re>"), "reporter html escapes title and body");

    auto s = n; s.type = "status_changed"; s.previousStatus = "open"; s.status = "resolved"; s.text = "";
    check(supportSubject(s) == "[IRC Fiber support #42] Status: resolved — Scroll <jumps>", "status subject");
    auto sm = supportReporterMail(s, "rep@example.org", "https://ircfiber.com");
    check(sm.text.canFind("alice set your report #42 \"Scroll <jumps>\" to resolved (was open).")
        && !sm.text.canFind("    "), "status text: transition, no empty quote block");

    SupportMailNotice c;
    c.type = "issue_created"; c.issueId = "abc-123"; c.number = 43; c.kind = "feature";
    c.title = "Dark mode"; c.status = "open"; c.priority = "normal";
    c.actor = "rep"; c.reporter = "rep"; c.text = "Please add it.";
    check(supportSubject(c) == "[IRC Fiber support #43] New feature from rep: Dark mode", "created subject");
    auto cm = supportStaffMail(c, "alice@example.org", "https://ircfiber.com/");
    check(cm.text.canFind("rep filed a new feature report #43 \"Dark mode\":")
        && cm.text.canFind("    Please add it.")
        && cm.text.canFind("Triage: https://ircfiber.com/admin#/support/abc-123"), "staff text: lead, body, admin link");
    check(cm.html.canFind("href=\"https://ircfiber.com/admin#/support/abc-123\""), "staff html admin link");

    auto f = c; f.type = "comment_added"; f.reopened = true; f.text = "Still broken";
    check(supportSubject(f) == "[IRC Fiber support #43] Follow-up from rep (reopened): Dark mode", "reopened subject");
    auto fm = supportStaffMail(f, "alice@example.org", "https://ircfiber.com");
    check(fm.text.canFind("rep followed up on #43 \"Dark mode\" (reopened):"), "reopened staff lead");
}

void main() {
    testParseBotCommand();
    testParseNewIssue();
    testParseIssueRef();
    testHelpLines();
    testFormatSupportEvent();
    testNeedsLocalAck();
    testTruncateText();
    testRelativeAge();
    testUrls();
    testSummaryAndDetail();
    testSanitizeLine();
    testEventJsonRoundTrip();
    testSupportMailRecipients();
    testSupportMailContent();
    if (failures) {
        writefln("support format tests: %d FAILED", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("support format tests: PASS");
}
