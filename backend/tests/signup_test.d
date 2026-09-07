module signup_test;

import std.algorithm : canFind;
import std.ascii : isAlphaNum;
import std.stdio : writeln, writefln;
import std.string : indexOf;

import ircfiber.mail;
import ircfiber.signup;
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

void main() {
    testSenderNetPayload();
    testSenderNetAccepted();
    testVerificationLink();
    testVerificationEmail();
    testPendingSignupJson();
    testSignupToken();
    testMailConfigured();
    testKeyShapes();
    if (failures == 0)
        writeln("signup_test: all checks passed");
    else
        writefln("signup_test: %d FAILURES", failures);
    import core.stdc.stdlib : exit;
    exit(failures == 0 ? 0 : 1);
}
