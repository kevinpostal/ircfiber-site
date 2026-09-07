module signup_test;

import std.algorithm : canFind;
import std.ascii : isAlphaNum;
import std.stdio : writeln, writefln;
import std.string : indexOf;

import ircfiber.mail;
import ircfiber.signup;
import ircfiber.mail_events;
import vibe.data.json : parseJsonString;

/// Same shape as services_test.d: built with -unittest so the `@("…")`
/// unittest blocks in the modules under test run too, hence the pinned
/// testmode that runs both.
extern (C) __gshared string[] rt_options = ["testmode=run-main"];

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

private void testSenderNetPayload() {
    MailSettings s;
    s.provider = "sender";
    s.apiToken = "tok";
    s.fromEmail = "no-reply@ircfiber.com";
    s.fromName = "IRC Fiber";
    MailMessage m = { "alice@x.test", "subj", "body text", "<p>body text</p>" };
    auto p = senderNetPayload(s, m);
    check(p["from"]["email"].get!string == "no-reply@ircfiber.com", "from.email");
    check(p["from"]["name"].get!string == "IRC Fiber", "from.name");
    check(p["to"]["email"].get!string == "alice@x.test", "to.email");
    check(p["subject"].get!string == "subj", "subject");
    check(p["text"].get!string == "body text", "text");
    check(p["html"].get!string == "<p>body text</p>", "html");
    check("attachments" !in p, "no attachments key");
    check("variables" !in p, "no variables key");
}

private void testSenderNetAccepted() {
    check(senderNetAccepted(200,
        `{"success":true,"message":"Email sent","emailId":"x"}`), "200 + success:true");
    check(!senderNetAccepted(200, `{"success":false}`), "success:false rejected");
    check(!senderNetAccepted(401, "{}"), "401 rejected");
    check(!senderNetAccepted(200, "not json"), "unparseable body rejected");
    check(!senderNetAccepted(500, `{"success":true}`), "non-2xx rejected even with success:true");
    check(!senderNetAccepted(200, `{"ok":true}`), "missing success key rejected");
}

private void testResendPayload() {
    MailSettings s;
    s.provider = "resend";
    s.apiToken = "re_key";
    s.fromEmail = "no-reply@ircfiber.com";
    s.fromName = "IRC Fiber";
    MailMessage m = { "alice@x.test", "subj", "body text", "<p>body text</p>" };
    auto p = resendPayload(s, m);
    check(p["from"].get!string == "IRC Fiber <no-reply@ircfiber.com>", "from is one address string");
    check(p["to"].length == 1 && p["to"][0].get!string == "alice@x.test", "to is an array");
    check(p["subject"].get!string == "subj", "subject");
    check(p["text"].get!string == "body text", "text");
    check(p["html"].get!string == "<p>body text</p>", "html");

    // No display name configured: bare address, not "<addr>" with an empty
    // phrase, which Resend rejects as a malformed from.
    s.fromName = "";
    check(resendPayload(s, m)["from"].get!string == "no-reply@ircfiber.com", "nameless from");
}

private void testResendAccepted() {
    check(resendAccepted(200, `{"id":"7b1f…","from":"x","to":["y"]}`), "200 + id");
    check(!resendAccepted(200, `{"id":""}`), "empty id rejected");
    check(!resendAccepted(200, `{"ok":true}`), "missing id rejected");
    check(!resendAccepted(403,
        `{"statusCode":403,"message":"The ircfiber.com domain is not verified.","name":"validation_error"}`),
        "unverified domain rejected");
    check(!resendAccepted(401, `{"message":"API key is invalid"}`), "401 rejected");
    check(!resendAccepted(200, "not json"), "unparseable body rejected");
}

private void testVerificationLink() {
    check(verificationLink("https://ircfiber.com/", "abc")
        == "https://ircfiber.com/verify?token=abc", "trailing slash stripped");
    check(verificationLink("https://ircfiber.com", "abc")
        == "https://ircfiber.com/verify?token=abc", "no trailing slash unchanged");
}

private void testVerificationEmail() {
    const link = "https://ircfiber.com/verify?token=TOKEN123";
    auto m = verificationEmail("al<ice", "al@x.test", link);
    check(m.toEmail == "al@x.test", "toEmail set");
    check(m.subject == "Confirm your IRC Fiber account", "subject exact");
    check(m.text.canFind(link), "text carries the raw link");
    check(m.text.canFind("al<ice"), "text greets the raw username");
    check(m.text.canFind("expires in 24 hours"), "text names the expiry");
    check(m.html.canFind("al&lt;ice"), "html escapes the username");
    check(!m.html.canFind("al<ice"), "html carries no raw angle bracket");
    check(m.html.canFind(`href="` ~ link ~ `"`), "html links the token URL");
    check(m.html.canFind("expires in 24 hours"), "html names the expiry");
}

private void testPendingSignupJson() {
    PendingSignup p = { "alice", "a@b.co", "hash", "1.2.3.4", 1788680000L };
    auto rt = PendingSignup.fromJson(p.toJson());
    check(rt.username == "alice", "username round-trips");
    check(rt.email == "a@b.co", "email round-trips");
    check(rt.passwordHash == "hash", "passwordHash round-trips");
    check(rt.signupIp == "1.2.3.4", "signupIp round-trips");
    check(rt.createdAt == 1788680000L, "createdAt round-trips");
    bool threw = false;
    try PendingSignup.fromJson(parseJsonString(`{}`));
    catch (Exception) threw = true;
    check(threw, "fromJson of {} throws");
}

private void testSignupToken() {
    const a = newSignupToken();
    const b = newSignupToken();
    check(a.length == 40, "token is 40 chars");
    check(a != b, "two draws differ");
    foreach (char c; a) {
        if (!isAlphaNum(c)) {
            check(false, "token is alnum only");
            break;
        }
    }
}

private void testMailConfigured() {
    MailSettings empty;
    check(!empty.configured, "empty provider is not configured");
    MailSettings log;
    log.provider = "log";
    check(log.configured, "log provider needs no token");
    MailSettings sender;
    sender.provider = "sender";
    check(!sender.configured, "sender without a token is not configured");
    sender.apiToken = "tok";
    check(sender.configured, "sender with a token is configured");
}

private void testKeyShapes() {
    check(pendingKey("abc") == "signup:pending:abc", "pendingKey");
    check(sentKey("a@b.co") == "signup:sent:a@b.co", "sentKey");
    check(ipKey("1.2.3.4") == "signup:ip:1.2.3.4", "ipKey");
}

private void testEmailWellFormed() {
    check(emailWellFormed("a@b.co"), "plain address accepted");
    check(!emailWellFormed("ab.co"), "no @ rejected");
    check(!emailWellFormed("a@bco"), "no dot rejected");
    check(!emailWellFormed("a b@c.co"), "embedded space rejected");
    check(!emailWellFormed("a@b.co\n"), "trailing newline rejected");
    check(!emailWellFormed(""), "empty rejected");
}

private void testMailEventJson() {
    MailEvent e = {
        atMs: 1788680000000L, kind: "signup_verification", toEmail: "a@b.co",
        username: "alice", provider: "sender", status: "failed",
        error: "sender.net rejected the message", durationMs: 412,
        sourceIp: "1.2.3.4",
    };
    auto rt = MailEvent.fromJson(e.toJson());
    check(rt.atMs == 1788680000000L, "atMs round-trips");
    check(rt.kind == "signup_verification", "kind round-trips");
    check(rt.toEmail == "a@b.co", "toEmail round-trips");
    check(rt.username == "alice", "username round-trips");
    check(rt.provider == "sender", "provider round-trips");
    check(rt.status == "failed", "status round-trips");
    check(rt.error == "sender.net rejected the message", "error round-trips");
    check(rt.durationMs == 412, "durationMs round-trips");
    check(rt.sourceIp == "1.2.3.4", "sourceIp round-trips");

    auto empty = MailEvent.fromJson(parseJsonString(`{}`));
    check(empty.atMs == 0 && empty.durationMs == 0, "missing numbers read as 0");
    check(empty.kind.length == 0 && empty.toEmail.length == 0
        && empty.username.length == 0 && empty.provider.length == 0
        && empty.status.length == 0 && empty.error.length == 0
        && empty.sourceIp.length == 0, "missing strings read as empty");
}

private void testSummarize() {
    const nowMs = 1788700000000L;
    const hour = 3_600_000L;
    MailEvent[] events = [
        // Newest first, as LRANGE returns them.
        MailEvent(nowMs - hour, "signup_verification", "new@b.co", "newbie", "sender", "sent", "", 120, "1.1.1.1"),
        MailEvent(nowMs - 2 * hour, "admin_test", "probe@b.co", "", "sender", "failed", "domain not verified", 90, "2.2.2.2"),
        MailEvent(nowMs - 5 * hour, "signup_verification", "old@b.co", "older", "sender", "sent", "", 150, "3.3.3.3"),
        MailEvent(nowMs - 30 * hour, "signup_verification", "stale@b.co", "stale", "sender", "failed", "connection refused", 10_000, "4.4.4.4"),
    ];
    auto s = summarize(events, nowMs);
    check(s.sent24h == 2, "sent24h counts both recent sends");
    check(s.failed24h == 1, "failed24h excludes the 30h-old failure");
    check(s.windowSize == 4, "windowSize is the whole window");
    check(s.sentWindow == 2 && s.failedWindow == 2, "window counts include the stale failure");
    check(s.lastError == "domain not verified", "lastError is the newest failure");
    check(s.lastFailedAtMs == nowMs - 2 * hour, "lastFailedAt is the newest failure");
    check(s.lastSentAtMs == nowMs - hour, "lastSentAt is the newest send");

    auto none = summarize(null, nowMs);
    check(none.windowSize == 0 && none.sent24h == 0 && none.lastError.length == 0,
        "empty window summarizes to zeros");
}

private void testMailEventsWindow() {
    auto first = mailEventsWindow(120, 0, 50);
    check(first.start == 0 && first.end == 50, "page 0 is the newest 50 rows");
    check(first.pageCount == 3, "120 rows at 50/page is 3 pages");

    auto last = mailEventsWindow(120, 2, 50);
    check(last.start == 100 && last.end == 120, "the last page stops at the log's end");

    // The log is capped and trimmed under readers: a stale page number must
    // land on the last page, not on an empty table.
    auto past = mailEventsWindow(120, 9, 50);
    check(past.page == 2 && past.start == 100 && past.end == 120,
        "a page past the end clamps to the last page");

    auto empty = mailEventsWindow(0, 3, 50);
    check(empty.start == 0 && empty.end == 0 && empty.page == 0 && empty.pageCount == 0,
        "an empty log has no pages");

    auto exact = mailEventsWindow(100, 1, 50);
    check(exact.pageCount == 2 && exact.start == 50 && exact.end == 100,
        "an exact multiple does not grow a trailing empty page");
}

void main() {
    testSenderNetPayload();
    testResendPayload();
    testResendAccepted();
    testSenderNetAccepted();
    testVerificationLink();
    testVerificationEmail();
    testPendingSignupJson();
    testSignupToken();
    testMailConfigured();
    testKeyShapes();
    testEmailWellFormed();
    testMailEventJson();
    testSummarize();
    testMailEventsWindow();
    if (failures == 0)
        writeln("signup_test: all checks passed");
    else
        writefln("signup_test: %d FAILURES", failures);
    import core.stdc.stdlib : exit;
    exit(failures == 0 ? 0 : 1);
}
