module services_test;

import std.algorithm : count;
import std.stdio : writeln, writefln;
import std.string : indexOf;

import ircfiber.services.anope;

/// This binary is built with -unittest so the `@("…")` unittest blocks in
/// ircfiber.services.accounts run too. druntime's default testmode
/// ("test-or-main") would then skip main and silently drop the wire tests
/// below, so pin it to run both.
extern (C) __gshared string[] rt_options = ["testmode=run-main"];

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

/// m_xmlrpc's parser takes every <string> element in document order as a
/// positional parameter, so both the escaping and the element order are
/// load-bearing: an unescaped '<' would split one parameter into two.
private void testBuildCall() {
    const xml = buildXmlRpcCall("command", ["NickServ", "al<ice", "REGISTER p&w x@y"]);
    check(xml ==
        `<?xml version="1.0"?><methodCall><methodName>command</methodName><params>`
        ~ `<param><value><string>NickServ</string></value></param>`
        ~ `<param><value><string>al&lt;ice</string></value></param>`
        ~ `<param><value><string>REGISTER p&amp;w x@y</string></value></param>`
        ~ `</params></methodCall>`,
        "buildXmlRpcCall escapes params and emits them in order");
    check(xml.count("<string>") == 3, "exactly one <string> per param");
    check(anopeXmlEscape(`a&b"c<d>e'f`) == "a&amp;b&quot;c&lt;d&gt;e&#39;f",
          "anopeXmlEscape replaces & first");
}

/// Captured verbatim from anope/anope:2.0.20 —
///   command NickServ probealice "REGISTER <pw> probe@example.com"
/// Note `&amp;#xA;`: the trailing newline is escaped twice.
private enum anopeSuccessBody =
    "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\n<methodResponse>\n<params>\n<param>\n"
    ~ "<value>\n<struct>\n<member>\n<name>result</name>\n<value>\n<string>Success</string>\n"
    ~ "</value>\n</member>\n<member>\n<name>return</name>\n<value>\n"
    ~ "<string>Nickname probealice registered.&amp;#xA;</string>\n</value>\n</member>\n"
    ~ "</struct>\n</value>\n</param>\n</params>\n</methodResponse>\n";

/// Captured verbatim from the same build — command NickServ probealice "FOO>Z".
/// '>' comes back as `&amp;qt;` (`&qt;` is Anope's typo for `&gt;`) and the
/// quotes as `&amp;quot;`, which is the proof that replies are escaped twice.
private enum anopeUnknownCommandBody =
    "<methodResponse><params><param><value><struct><member><name>result</name>"
    ~ "<value><string>Success</string></value></member><member><name>return</name>"
    ~ "<value><string>Unknown command FOOgt&amp;qt;Z. &amp;quot;/msg NickServ HELP"
    ~ "&amp;quot; for help.&amp;#xA;</string></value></member></struct></value>"
    ~ "</param></params></methodResponse>";

private void testParseResponse() {
    auto ok = parseXmlRpcResponse(anopeSuccessBody);
    check(ok.transportOk, "verbatim Anope body parses");
    check(ok.result == "Success", "result member");
    check(ok.text == "Nickname probealice registered.\n",
          "double-escaped newline decodes to one newline, not the literal &#xA;");
    check(ok.error.length == 0, "no error member");

    auto unknown = parseXmlRpcResponse(anopeUnknownCommandBody);
    check(unknown.text == "Unknown command FOOgt>Z. \"/msg NickServ HELP\" for help.\n",
          "decodes Anope's &qt; typo and &quot; through both escape layers");

    // Single-layer entities (what one Sanitize() pass emits) must also decode,
    // and the second pass must leave already-plain text alone.
    check(anopeXmlUnescape("a&#xA;b &qt; c &gt; d &amp; e &#39;f&#39;")
          == "a\nb > c > d & e 'f'", "one unescape pass handles every entity");
    check(decodeAnopeReply("plain text 50%") == "plain text 50%",
          "two passes are a no-op on unescaped text");

    auto malformed = parseXmlRpcResponse("not xml");
    check(!malformed.transportOk, "non-XML body is a transport failure");
    check(malformed.transportError == "malformed XML-RPC response", "transportError set");

    // An unparseable entity must survive verbatim rather than be swallowed.
    auto weird = parseXmlRpcResponse(
        "<methodResponse><member><name>return</name><value><string>50% &nbsp; &#zz; done"
        ~ "</string></value></member></methodResponse>");
    check(weird.text == "50% &nbsp; &#zz; done", "unknown entities pass through");

    // anopeCommand hands callers one line: the obscure-password reply is three.
    check(flattenReplyText("Please try again with a more obscure password.\nPasswords should be"
                           ~ " at least\nfive characters long.\n")
          == "Please try again with a more obscure password. Passwords should be at least"
           ~ " five characters long.",
          "flattenReplyText collapses the multi-line reply and strips the tail");
}

/// Captured verbatim: `user probesquat` while a client held that nick and was
/// NOT registered. Nine members, none of them `account`.
private enum anopeUserOnlineBody =
    "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\n<methodResponse>\n<params>\n<param>\n<value>\n"
    ~ "<struct>\n<member>\n<name>chost</name>\n<value>\n<string>pjf62b6r.ztjrdeid.t2aaffnv.hidden"
    ~ "</string>\n</value>\n</member>\n<member>\n<name>host</name>\n<value>\n<string>172.23.0.1"
    ~ "</string>\n</value>\n</member>\n<member>\n<name>ident</name>\n<value>\n<string>probesquat"
    ~ "</string>\n</value>\n</member>\n<member>\n<name>ip</name>\n<value>\n<string>172.23.0.1"
    ~ "</string>\n</value>\n</member>\n<member>\n<name>nick</name>\n<value>\n<string>probesquat"
    ~ "</string>\n</value>\n</member>\n<member>\n<name>signon</name>\n<value>\n<string>1788681090"
    ~ "</string>\n</value>\n</member>\n<member>\n<name>timestamp</name>\n<value>\n<string>1788681090"
    ~ "</string>\n</value>\n</member>\n<member>\n<name>vhost</name>\n<value>\n<string>"
    ~ "pjf62b6r.ztjrdeid.t2aaffnv.hidden</string>\n</value>\n</member>\n<member>\n<name>vident"
    ~ "</name>\n<value>\n<string>probesquat</string>\n</value>\n</member>\n</struct>\n</value>\n"
    ~ "</param>\n</params>\n</methodResponse>";

/// Captured verbatim: `user probenobody` with nobody on that nick. The nick is
/// echoed back, so `nick` alone must never read as "somebody is there".
private enum anopeUserAbsentBody =
    "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\n<methodResponse>\n<params>\n<param>\n<value>\n"
    ~ "<struct>\n<member>\n<name>nick</name>\n<value>\n<string>probenobody</string>\n</value>\n"
    ~ "</member>\n</struct>\n</value>\n</param>\n</params>\n</methodResponse>";

/// The presence oracle behind the hijack guard: registering a nick a stranger
/// holds identifies THEIR session to the new account (observed: numeric 900 +
/// MODE +r on the squatter's socket), so a false "nobody is there" is a
/// security bug, not a cosmetic one.
private void testUserPresence() {
    auto online = parseXmlRpcResponse(anopeUserOnlineBody);
    check(online.transportOk, "user reply parses");
    check(online.members.length == 9, "every member is decoded");
    check(online.members["nick"] == "probesquat", "nick member");
    check(anopeUserOnline(online), "ident/host/ip/signon present → somebody holds the nick");
    check("account" !in online.members, "unregistered session has no account member");

    auto absent = parseXmlRpcResponse(anopeUserAbsentBody);
    check(absent.transportOk, "absent-user reply parses");
    check(absent.members.length == 1 && "nick" in absent.members, "only the echoed nick");
    check(!anopeUserOnline(absent), "echoed nick alone is not presence");

    // Fail closed: an unreachable Anope must never look like a free nick.
    AnopeReply broken;
    broken.transportError = "connection refused";
    check(!anopeUserOnline(broken), "transport failure is never 'nobody there'");
}

/// Guards the signup gate and the command builder. Both are security
/// boundaries: a misclassified INFO reply lets somebody register a username
/// that is already owned on IRC, and an unsanitised argument injects extra
/// parameters into the services command Anope executes.
private void testSignupGuards() {
    check(isSafeServicesArg("alice@example.com"), "an ordinary email is safe");
    check(isSafeServicesArg("Abc123Abc123Abc123Abc12"), "a generated password is safe");
    check(!isSafeServicesArg("a b@c.co"), "a space would add a REGISTER parameter");
    check(!isSafeServicesArg("a@b.co\nDROP alice"), "a newline would add a command");
    check(!isSafeServicesArg("a\tb@c.co"), "a tab would add a parameter");
    check(!isSafeServicesArg("a@b.co\x00"), "a NUL is rejected");
    check(!isSafeServicesArg(""), "an empty argument is never safe to interpolate");

    // Texts below are the decoded form of replies captured from 2.0.20.
    check(classifyNickInfoReply("Nick probefree isn't registered.") == NickRegistration.free,
          "no alias → claimable");
    check(classifyNickInfoReply("Nick NickServ is part of this Network's Services.")
          == NickRegistration.servicesReserved, "service bots are not claimable");
    check(classifyNickInfoReply("probeowned is probeowned    Account: probeowned"
                                ~ "   Registered: Sep 06 08:11:30 2026 UTC (now)")
          == NickRegistration.registered, "an Account: line means somebody owns it");
    // The not-registered reply echoes the queried nick, so matching a bare
    // "account" would deny a legitimate signup for the username "Account".
    check(classifyNickInfoReply("Nick Account isn't registered.") == NickRegistration.free,
          "the echoed nick must not be mistaken for an Account: line");
    check(classifyNickInfoReply("") == NickRegistration.unknown,
          "an empty reply is never treated as claimable");
    check(classifyNickInfoReply("You are not authorized to do that.") == NickRegistration.unknown,
          "an unrecognised reply is never treated as claimable");
}

private void testErrorReply() {
    // m_xmlrpc_main answers an unknown service with an `error` member and no
    // `return`, which anopeCommand's callers must not mistake for output.
    auto r = parseXmlRpcResponse(
        "<methodResponse><params><param><value><struct><member><name>error</name>"
        ~ "<value><string>Invalid service</string></value></member></struct>"
        ~ "</value></param></params></methodResponse>");
    check(r.transportOk, "error reply is still a valid response");
    check(r.error == "Invalid service", "error member");
    check(r.text.length == 0, "no return text");
}

private void testSettings() {
    AnopeSettings off;
    check(!off.configured, "empty rpcUrl disables provisioning");
    AnopeSettings on = AnopeSettings("http://services:8080/xmlrpc", 10);
    check(on.configured, "a URL enables provisioning");
    check(anopeCommand(off, "NickServ", "alice", "REGISTER x").transportOk == false,
          "unconfigured anopeCommand fails closed without any I/O");
}

void main() {
    testBuildCall();
    testParseResponse();
    testUserPresence();
    testSignupGuards();
    testErrorReply();
    testSettings();
    if (failures) {
        writefln("services tests: %d failures", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("services tests: PASS (0 failures)");
}
