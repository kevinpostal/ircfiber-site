module services_test;

import std.algorithm : count;
import std.stdio : writeln, writefln;
import std.string : indexOf;

import ircfiber.services.anope;
import ircfiber.services.anope_db;

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

    check(!on.hasOper, "no services-oper account unless one is configured");
    AnopeSettings oper = AnopeSettings("http://services:8080/xmlrpc", 10, "admin");
    check(oper.hasOper, "an oper account enables privileged commands");
    auto noOper = anopeOperCommand(on, "SUSPEND alice reason");
    check(!noOper.transportOk && noOper.transportError == "Anope oper account not configured",
          "a privileged command without an oper account fails closed without any I/O");
}

/// Verbatim `NickServ INFO` shape from 2.0.20 (`ns_info.cpp` right-pads the
/// labels, which is why the parser trims them).
private enum nickInfoBody =
    "alice is alice\n"
    ~ "          Account: alice\n"
    ~ "    Email address: a@b.co\n"
    ~ "       Registered: Sep 06 08:54:09 2026 UTC (now)\n";

/// The admin NickServ page renders this parse, and every action decides what
/// to show from it, so a mis-parse is a wrong verdict about a real account.
private void testNickInfo() {
    auto i = parseNickInfo(nickInfoBody);
    check(i.registered, "an Account: line means somebody owns the nick");
    check(i.account == "alice", "Account field");
    check(i.realName == "alice", "tail of the leading '<nick> is <realname>' line");
    check(i.fields["Email address"] == "a@b.co", "padded labels are trimmed");
    check(i.fields["Registered"] == "Sep 06 08:54:09 2026 UTC (now)",
          "a value containing ':' is kept whole");
    check(i.lines.length == 4, "every reply line is kept for the verbatim view");

    auto free = parseNickInfo("Nick \x02bob\x02 isn't registered.");
    check(!free.registered, "the not-registered reply is not an account");
    check(free.account.length == 0, "and carries no account name");

    auto svc = parseNickInfo("Nick \x02NickServ\x02 is part of this Network's Services.");
    check(!svc.registered && svc.account.length == 0,
          "a service bot is not a manageable account");

    auto sus = parseNickInfo(nickInfoBody ~ "        Suspended: bob\n           Reason: spam\n");
    check(sus.fields["Suspended"] == "bob" && sus.fields["Reason"] == "spam",
          "ns_suspend's show fields are parsed");

    // A dual-host session emits `Online from` twice: the last value wins, but
    // both raw lines stay so the verbatim view is not silently lossy.
    auto dual = parseNickInfo("alice is alice\n      Online from: alice@host1\n"
        ~ "      Online from: alice@host2\n");
    check(dual.fields["Online from"] == "alice@host2", "a repeated label keeps the last value");
    check(dual.lines.length == 3, "both Online from lines are kept");
}

/// `Access denied.` arrives as an ordinary HTTP 200 reply, so the 403 the
/// admin sees depends entirely on this text test.
private void testOperReplies() {
    AnopeReply denied;
    denied.transportOk = true;
    denied.text = "Access denied.";
    check(anopeAccessDenied(denied), "a refusal is detected in the reply text");
    AnopeReply ok;
    ok.transportOk = true;
    ok.text = "Nick alice is now suspended.";
    check(!anopeAccessDenied(ok), "a success reply is not a refusal");

    // `anopePost` assigns rawText before flattening. INFO is line-oriented, so
    // parsing the flattened text yields nothing — that is why rawText exists.
    auto parsed = parseXmlRpcResponse(
        "<methodResponse><params><param><value><struct><member><name>return</name>"
        ~ "<value><string>alice is alice&amp;#xA;          Account: alice&amp;#xA;"
        ~ "</string></value></member></struct></value></param></params></methodResponse>");
    check(parsed.text.indexOf('\n') >= 0, "the parser itself keeps the newlines");
    const raw = parsed.text;
    const flat = flattenReplyText(raw);
    check(flat.indexOf('\n') < 0, "text is flattened for logging and classification");
    check(parseNickInfo(raw).account == "alice", "INFO parses from the unflattened reply");
    check(parseNickInfo(flat).account.length == 0,
          "and cannot be parsed from the flattened one");

    // Verified against 2.0.20: option first. The reversed form answers
    // `Syntax: SASET option nickname parameters` with HTTP 200 and no
    // `Access denied`, so nothing but this ordering stops a silent no-op that
    // leaves the old password working.
    check(nickServSetPasswordCommand("nsvictim", "Aa1Bb2Cc3") == "SASET PASSWORD nsvictim Aa1Bb2Cc3",
          "SASET takes the option before the nickname");

    // Same shape on the channel side, and the same silent failure: the
    // reversed `SET #chan FOUNDER acct` answers `Syntax: SET option channel
    // parameters` with HTTP 200 and leaves the old founder in place
    // (observed on 2.0.20 while verifying the admin ChanServ section).
    check(chanServSetFounderCommand("#scratchchan", "victim")
              == "SET FOUNDER #scratchchan victim",
          "ChanServ SET takes the option before the channel");
}

/// Verbatim `db_flatfile` shape (`modules/database/db_flatfile.cpp:332-336`).
private enum anopeDbFixture =
    "OBJECT NickCore\n"
    ~ "ID 1\n"
    ~ "DATA display alice\n"
    ~ "DATA pass plain:secrethash\n"
    ~ "DATA email a@b.co\n"
    ~ "DATA memomax 20\n"
    ~ "DATA extensible:NS_SECURE 1\n"
    ~ "END\n"
    ~ "OBJECT NickAlias\n"
    ~ "DATA nick alice\n"
    ~ "DATA last_realname Alice Example\n"
    ~ "DATA last_usermask alice@host\n"
    ~ "DATA time_registered 1788600000\n"
    ~ "DATA last_seen 1788680000\n"
    ~ "DATA nc alice\n"
    ~ "END\n";

private void testAnopeDbRecords() {
    auto recs = parseAnopeDb(anopeDbFixture);
    check(recs.length == 2, "one record per OBJECT");
    check(recs[0].type == "NickCore" && recs[1].type == "NickAlias", "types, in file order");
    check(recs[0].data["display"] == "alice", "NickCore display");
    check(recs[0].data["extensible:NS_SECURE"] == "1", "extensible keys survive");
    check(recs[1].data["nc"] == "alice", "the alias names its core");
    check("ID" !in recs[0].data, "the ID line is not a DATA pair");

    // SaveData only re-emits `DATA <key> ` on a key change, so a value holding
    // a newline continues onto the following physical lines.
    auto cont = parseAnopeDb("OBJECT NickAlias\nDATA nick carol\n"
        ~ "DATA last_quit I am\nleaving now\nDATA nc carol\nEND\n");
    check(cont.length == 1, "one record");
    check(cont[0].data["last_quit"] == "I am\nleaving now",
          "a continued DATA value is captured whole");
    check(cont[0].data["nc"] == "carol", "the next DATA line ends the continuation");
}

private void testAnopeAccounts() {
    const fixture = anopeDbFixture
        ~ "OBJECT NickAlias\nDATA nick orphan\nDATA nc ghost\n"
        ~ "DATA time_registered 1788600001\nEND\n"
        ~ "OBJECT NSSuspendInfo\nDATA nick alice\nDATA by admin\nDATA reason spam\n"
        ~ "DATA time 1788681000\nDATA expires 0\nEND\n";
    auto rows = anopeAccountsFromDb(fixture);
    check(rows.length == 2, "one row per NickAlias");
    check(rows[0].nick == "alice" && rows[1].nick == "orphan", "sorted by nick");
    check(rows[0].email == "a@b.co", "joined to its NickCore by nc == display");
    check(rows[0].registeredAt == 1788600000 && rows[0].lastSeenAt == 1788680000,
          "serialized unix times");
    check(rows[0].lastRealName == "Alice Example" && rows[0].lastUsermask == "alice@host",
          "values containing spaces are kept whole");
    check(rows[0].suspended && rows[0].suspendedBy == "admin" && rows[0].suspendReason == "spam",
          "the NSSuspendInfo record flags the account");
    check(rows[0].suspendedAt == 1788681000 && rows[0].suspendExpiresAt == 0,
          "expires 0 means never");
    check(rows[1].email.length == 0, "an alias whose core is missing is still listed");
    check(!rows[1].suspended, "a suspension never leaks onto another row");

    // The password hash is in the fixture and must not reach any field.
    foreach (ref r; rows) {
        const joined = r.nick ~ "|" ~ r.account ~ "|" ~ r.email ~ "|" ~ r.lastRealName
            ~ "|" ~ r.lastUsermask ~ "|" ~ r.suspendedBy ~ "|" ~ r.suspendReason;
        check(joined.indexOf("secrethash") < 0, "no field carries the password hash");
    }

    // IRC nicks are case-insensitive, so both the suspension join and the sort
    // have to be too.
    auto ci = anopeAccountsFromDb(
        "OBJECT NickAlias\nDATA nick charlie\nDATA nc charlie\nEND\n"
        ~ "OBJECT NickAlias\nDATA nick Bob\nDATA nc Bob\nEND\n"
        ~ "OBJECT NSSuspendInfo\nDATA nick BOB\nDATA by admin\nDATA reason x\nEND\n");
    check(ci.length == 2 && ci[0].nick == "Bob" && ci[1].nick == "charlie",
          "sorted case-insensitively, so Bob precedes charlie");
    check(ci[0].suspended, "NSSuspendInfo matches the nick case-insensitively");

    // Anope suspends the NickCore (`ns_suspend.cpp`: `si->what = nc->display`,
    // extension on `nc`), so a grouped alias is just as suspended as the display.
    auto grouped = anopeAccountsFromDb(
        "OBJECT NickAlias\nDATA nick dave\nDATA nc dave\nEND\n"
        ~ "OBJECT NickAlias\nDATA nick dave_away\nDATA nc dave\nEND\n"
        ~ "OBJECT NickAlias\nDATA nick erin\nDATA nc erin\nEND\n"
        ~ "OBJECT NSSuspendInfo\nDATA nick dave\nDATA by admin\nDATA reason x\nEND\n");
    check(grouped.length == 3, "three aliases");
    check(grouped[0].nick == "dave" && grouped[0].suspended, "the display alias is suspended");
    check(grouped[1].nick == "dave_away" && grouped[1].suspended && grouped[1].suspendedBy == "admin",
          "a grouped alias of a suspended account is suspended too");
    check(grouped[2].nick == "erin" && !grouped[2].suspended, "another account is untouched");
}

/// Captured verbatim from prod services over XML-RPC (2026-09-09):
///   command ChanServ admin "INFO #staff"
private enum chanInfoReply =
    "Information for channel #staff:\n"
    ~ "     Founder: Zodiac\n"
    ~ " Description: IRC Fiber staff log feed\n"
    ~ "  Registered: Sep 08 00:31:41 2026 UTC (1 day, 8 hours, 54 minutes ago)\n"
    ~ "   Last used: Sep 09 09:26:10 2026 UTC (now)\n"
    ~ "    Ban type: 2\n"
    ~ "   Mode lock: +ntOPH 200:1w\n"
    ~ "     Options: Peace, Secure founder, Secure ops, Signed kicks, Persistent,"
    ~ " No expire, Topic retention\n"
    ~ "  Last topic: IRC Fiber operations log\n"
    ~ "Topic set by: admin\n";

/// ditto — command ChanServ admin "ACCESS #staff LIST"
private enum chanAccessReply =
    "Access list for #staff:\n"
    ~ "Number  Level  Mask\n"
    ~ "1       SOP    sq\n"
    ~ "2       HOP    FiberEye\n"
    ~ "End of access list\n";

private void testChanInfo() {
    auto info = parseChanInfo(chanInfoReply);
    check(info.registered, "the header line decides that the channel is registered");
    check(info.founder == "Zodiac", "Founder is extracted");
    check(info.description == "IRC Fiber staff log feed", "Description is extracted");
    check(info.fields.get("Mode lock", "") == "+ntOPH 200:1w",
          "a value containing spaces and ':' is kept whole");
    check(info.fields.get("Topic set by", "") == "admin", "the last line is a field too");
    check(!info.suspended, "no Suspended field means not suspended");
    check(info.lines.length == 10, "every reply line is kept for display");
    foreach (k, _; info.fields)
        check(k.indexOf("Information for channel") < 0,
              "the header is never turned into a field: " ~ k);

    auto free = parseChanInfo("Channel #nosuchchannel isn't registered.");
    check(!free.registered, "Anope's refusal is not a registration");

    // An oper INFO on a channel whose founder NickCore was dropped carries no
    // Founder line at all, and that channel is still registered.
    auto founderless = parseChanInfo(
        "Information for channel #ghost:\n  Registered: Sep 08 00:31:41 2026 UTC\n");
    check(founderless.registered, "the header, not the founder, decides");
    check(founderless.founder.length == 0, "and the missing Founder is empty, not invented");

    auto suspended = parseChanInfo(
        "Information for channel #x:\n     Founder: sq\n   Suspended: [reason]\n");
    check(suspended.suspended, "a Suspended field flags the channel");
}

private void testChanAccessList() {
    auto rows = parseChanAccessList(chanAccessReply);
    check(rows.length == 2, "one row per numbered line, headers and footer excluded");
    check(rows[0].number == 1 && rows[0].level == "SOP" && rows[0].mask == "sq",
          "columns are read positionally");
    check(rows[1].number == 2 && rows[1].level == "HOP" && rows[1].mask == "FiberEye",
          "and case is preserved");
    check(parseChanAccessList("#x access list is empty.").length == 0,
          "an empty list is an empty array, not an error");
    check(parseChanAccessList("").length == 0, "so is an empty reply");
}

/// `ChannelInfo` shape verbatim from prod's anope.db, including the fact that
/// 2.0.20 writes extensible flags bare (`CS_NO_EXPIRE`, not
/// `extensible:CS_NO_EXPIRE`).
private enum channelDbFixture =
    "OBJECT ChannelInfo\n"
    ~ "ID 3\n"
    ~ "DATA name #staff\n"
    ~ "DATA founder Zodiac\n"
    ~ "DATA description IRC Fiber staff log feed\n"
    ~ "DATA time_registered 1788491709\n"
    ~ "DATA last_used 1788855122\n"
    ~ "DATA last_topic IRC Fiber operations log\n"
    ~ "DATA last_topic_setter admin\n"
    ~ "DATA last_topic_time 1788676622\n"
    ~ "DATA bantype 2\n"
    ~ "DATA bi ChanServ\n"
    ~ "DATA CS_NO_EXPIRE 1\n"
    ~ "DATA PERSIST 1\n"
    ~ "END\n"
    ~ "OBJECT ChannelInfo\n"
    ~ "DATA name #Abandoned\n"
    ~ "DATA description\n"
    ~ "DATA time_registered 1788491000\n"
    ~ "END\n"
    ~ "OBJECT CSSuspendInfo\n"
    ~ "DATA chan #STAFF\n"
    ~ "DATA by admin\n"
    ~ "DATA reason spam wave\n"
    ~ "DATA time 1788681000\n"
    ~ "DATA expires 0\n"
    ~ "END\n"
    ~ "OBJECT ChanAccess\n"
    ~ "DATA provider access/xop\nDATA ci #staff\nDATA mask sq\nDATA data SOP\nEND\n"
    ~ "OBJECT ChanAccess\n"
    ~ "DATA provider access/xop\nDATA ci #Staff\nDATA mask FiberEye\nDATA data HOP\nEND\n";

private void testAnopeDbChannels() {
    auto rows = anopeChannelsFromDb(channelDbFixture);
    check(rows.length == 2, "one row per ChannelInfo");
    check(rows[0].name == "#Abandoned" && rows[1].name == "#staff",
          "sorted case-insensitively, so #Abandoned precedes #staff");

    auto staff = rows[1];
    check(staff.founder == "Zodiac" && staff.description == "IRC Fiber staff log feed",
          "values containing spaces are kept whole");
    check(staff.registeredAt == 1788491709 && staff.lastUsedAt == 1788855122,
          "serialized unix times");
    check(staff.lastTopic == "IRC Fiber operations log" && staff.lastTopicSetter == "admin"
              && staff.lastTopicAt == 1788676622,
          "the topic trio is carried through");
    check(staff.bot == "ChanServ", "the assigned BotServ bot is reported");
    check(staff.accessCount == 2, "ChanAccess rows are counted case-insensitively");
    check(staff.noExpire && staff.persistent && !staff.isPrivate,
          "bare extensible flags are read, and an absent one stays false");
    check(staff.suspended && staff.suspendedBy == "admin"
              && staff.suspendReason == "spam wave",
          "CSSuspendInfo matches the channel case-insensitively");
    check(staff.suspendedAt == 1788681000 && staff.suspendExpiresAt == 0,
          "expires 0 means never");

    auto abandoned = rows[0];
    check(abandoned.founder.length == 0 && abandoned.successor.length == 0,
          "a channel whose founder core is gone keeps empty names");
    check(abandoned.description.length == 0, "an empty description parses as empty");
    check(abandoned.accessCount == 0 && !abandoned.suspended,
          "and neither join leaks onto it");
}

private void removeQuiet(string path) nothrow {
    import std.file : remove;
    try remove(path);
    catch (Exception) {}
}

/// The inventory must degrade instead of throwing: the mount is optional and
/// the admin page has to explain itself when it is absent.
private void testAnopeInventory() {
    import std.file : tempDir, write;
    import std.path : buildPath;
    import std.process : environment;

    const saved = environment.get("IRCFIBER_ANOPE_DB_PATH", "");
    scope (exit) {
        if (saved.length) environment["IRCFIBER_ANOPE_DB_PATH"] = saved;
        else environment.remove("IRCFIBER_ANOPE_DB_PATH");
    }

    environment.remove("IRCFIBER_ANOPE_DB_PATH");
    auto off = readAnopeInventory();
    check(!off.available && off.reason == "IRCFIBER_ANOPE_DB_PATH is not set",
          "an unset path disables the inventory without throwing");

    environment["IRCFIBER_ANOPE_DB_PATH"] = "/nonexistent/anope.db";
    auto missing = readAnopeInventory();
    check(!missing.available && missing.reason.indexOf("anope.db not found") == 0,
          "a missing file is reported, not thrown");

    const path = buildPath(tempDir(), "nstest-services-test.db");
    write(path, anopeDbFixture);
    scope (exit) removeQuiet(path);
    environment["IRCFIBER_ANOPE_DB_PATH"] = path;
    auto inv = readAnopeInventory();
    check(inv.available && inv.accounts.length == 1 && inv.accounts[0].nick == "alice",
          "a real file is read and parsed");
    check(inv.fileMtime > 0, "the mtime is reported so the UI can show 'as of'");
}

void main() {
    testBuildCall();
    testParseResponse();
    testUserPresence();
    testSignupGuards();
    testErrorReply();
    testSettings();
    testNickInfo();
    testOperReplies();
    testAnopeDbRecords();
    testAnopeAccounts();
    testAnopeInventory();
    testChanInfo();
    testChanAccessList();
    testAnopeDbChannels();
    if (failures) {
        writefln("services tests: %d failures", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("services tests: PASS (0 failures)");
}
