module services_test;

import std.stdio : writeln, writefln;
import std.string : indexOf;

import vibe.data.json : Json, parseJsonString;

import ircfiber.services.anope;
import ircfiber.services.anope_inventory;

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

/// The request body is JSON-RPC 2.0 with string params, and the Bearer
/// credential is base64 of the raw token — asserted by re-parsing the body
/// (key order is not significant) and by a known base64 vector.
private void testBuildCall() {
    const body_ = buildJsonRpcCall("anope.command", ["alice", "NickServ", "INFO alice"]);
    auto call = parseJsonString(body_);
    check(call["jsonrpc"].get!string == "2.0", "JSON-RPC version");
    check(call["id"].get!string == "gateway", "request id");
    check(call["method"].get!string == "anope.command", "method");
    auto params = call["params"].get!(Json[]);
    check(params.length == 3, "one param per word");
    check(params[0].get!string == "alice"
          && params[1].get!string == "NickServ"
          && params[2].get!string == "INFO alice",
          "params are [account, service, command], in order");

    // A parameter carrying JSON metacharacters must survive the round trip
    // rather than split or escape the body.
    const tricky = buildJsonRpcCall("anope.command", [`a"b\c`, "d"]);
    auto back = parseJsonString(tricky)["params"].get!(Json[]);
    check(back[0].get!string == `a"b\c` && back[1].get!string == "d",
          "parameters are JSON-encoded, not interpolated");

    // The listener B64Decodes everything after "Bearer " before comparing,
    // so the raw token must never go out verbatim.
    check(anopeBearerHeader("test") == "Bearer dGVzdA==",
          "the Bearer credential is base64 of the raw token");
}

/// The three reply shapes: result lines, a JSON-RPC error object (a refusal,
/// not a transport failure), and a body that is no JSON-RPC reply at all.
private void testParseReply() {
    auto ok = parseJsonRpcReply(
        `{"jsonrpc":"2.0","id":"gateway","result":["Nickname probealice registered."]}`);
    check(ok.transportOk, "a result reply parses");
    check(ok.errorCode == 0 && ok.error.length == 0, "no error on success");
    auto lines = ok.result.get!(Json[]);
    check(lines.length == 1 && lines[0].get!string == "Nickname probealice registered.",
          "result lines");

    auto err = parseJsonRpcReply(
        `{"jsonrpc":"2.0","id":"gateway","error":{"code":-32001,"message":"No such command"}}`);
    check(err.transportOk, "a JSON-RPC error is a refusal, not a transport failure");
    check(err.errorCode == -32001 && err.error == "No such command",
          "error object maps to errorCode+message");

    auto bad = parseJsonRpcReply("not json");
    check(!bad.transportOk, "an unparseable body is a transport failure");
    check(bad.transportError.length > 0, "transportError set");

    auto neither = parseJsonRpcReply(`{"jsonrpc":"2.0","id":"gateway"}`);
    check(!neither.transportOk, "a reply with neither result nor error is a transport failure");
}

/// `anope.checkCredentials`: success is `result.account` present; the three
/// documented refusals are determined negatives; an unreachable Anope is
/// undetermined — and none of the failure paths may touch the network.
private void testCheckCredentials() {
    auto good = parseJsonRpcReply(
        `{"jsonrpc":"2.0","id":"gateway","result":{"account":"alice","confirmed":true,"uniqueid":7}}`);
    check(good.transportOk, "credential success parses");
    check(credentialsAuthenticated(good.result),
          "result.account present means the credential works");
    check(!credentialsAuthenticated(parseJsonString(`{}`)),
          "a result naming no account is not authentication");
    check(!credentialsAuthenticated(parseJsonString(`["alice"]`)),
          "a non-object result is not authentication");

    auto denied = parseJsonRpcReply(
        `{"jsonrpc":"2.0","id":"gateway","error":{"code":-32050,"message":"Invalid password"}}`);
    check(denied.transportOk && denied.errorCode != 0
          && denied.error == "Invalid password",
          "Invalid password is a determined refusal, not a transport failure");

    // No I/O without configuration: an unconfigured surface and unsafe
    // arguments both fail closed and undetermined.
    AnopeSettings off;
    bool determined = true;
    check(!anopeCheckAuthentication(off, "alice", "pw", determined) && !determined,
          "unconfigured checkCredentials is undetermined without any I/O");
    check(!anopeCheckAuthentication(off, "a b", "pw", determined) && !determined,
          "unsafe args fail closed without any I/O");
}

/// The presence oracle behind the hijack guard: registering a nick a
/// stranger holds must never read as free, so `unknown` — never `offline` —
/// is what an unreachable Anope reports.
private void testUserPresence() {
    auto online = parseJsonRpcReply(
        `{"jsonrpc":"2.0","id":"gateway","result":{"nick":"probesquat","ident":"probesquat",`
        ~ `"host":"172.23.0.1","account":null,"channels":["#dmz"]}}`);
    check(classifyUserPresence(online) == AnopePresence.online,
          "result present means a live session holds the nick");

    auto offline = parseJsonRpcReply(
        `{"jsonrpc":"2.0","id":"gateway","error":{"code":-32099,"message":"No such user"}}`);
    check(classifyUserPresence(offline) == AnopePresence.offline,
          "No such user means nobody holds the nick");

    // Fail closed: an unreachable Anope must never look like a free nick.
    auto broken = parseJsonRpcReply("not json");
    check(classifyUserPresence(broken) == AnopePresence.unknown,
          "transport failure is never 'nobody there'");

    auto other = parseJsonRpcReply(
        `{"jsonrpc":"2.0","id":"gateway","error":{"code":-32601,`
        ~ `"message":"No authorization for method: anope.user"}}`);
    check(classifyUserPresence(other) == AnopePresence.unknown,
          "any other refusal is unknown, not offline");

    // No I/O without configuration: an unconfigured surface and an unsafe
    // nick both answer unknown without touching the network.
    check(anopeUserPresence(AnopeSettings.init, "alice") == AnopePresence.unknown,
          "unconfigured presence is unknown without any I/O");
    check(anopeUserPresence(AnopeSettings("http://services:8080/jsonrpc", "tok"), "a b")
          == AnopePresence.unknown,
          "an unsafe nick is unknown without any I/O");
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

    // Texts below are the decoded form of replies captured from Anope.
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

private void testSettings() {
    AnopeSettings off;
    check(!off.configured, "empty settings disable the surface");
    AnopeSettings noToken = AnopeSettings("http://services:8080/jsonrpc", "", 10);
    check(!noToken.configured, "a URL without a token stays disabled");
    AnopeSettings on = AnopeSettings("http://services:8080/jsonrpc", "tok", 10);
    check(on.configured, "a URL plus a token enables the surface");
    check(anopeCommand(off, "NickServ", "alice", "REGISTER x").transportOk == false,
          "unconfigured anopeCommand fails closed without any I/O");

    check(!on.hasOper, "no services-oper account unless one is configured");
    AnopeSettings oper = AnopeSettings("http://services:8080/jsonrpc", "tok", 10, "admin");
    check(oper.hasOper, "an oper account enables privileged commands");
    auto noOper = anopeOperCommand(on, "SUSPEND alice reason");
    check(!noOper.transportOk && noOper.transportError == "Anope oper account not configured",
          "a privileged command without an oper account fails closed without any I/O");
}

/// Verbatim `NickServ INFO` shape (`ns_info.cpp` right-pads the labels,
/// which is why the parser trims them).
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

/// `Access denied.` arrives as an ordinary result, so the 403 the admin sees
/// depends entirely on this text test.
private void testOperReplies() {
    AnopeReply denied;
    denied.transportOk = true;
    denied.text = "Access denied.";
    check(anopeAccessDenied(denied), "a refusal is detected in the reply text");
    AnopeReply ok;
    ok.transportOk = true;
    ok.text = "Nick alice is now suspended.";
    check(!anopeAccessDenied(ok), "a success reply is not a refusal");

    // `AnopeReply.text` is flattened for logging and classification while
    // `rawText` stays line-oriented for the INFO parser — parsing the
    // flattened text yields nothing, that is why rawText exists.
    const raw = "alice is alice\n          Account: alice\n";
    const flat = flattenReplyText(raw);
    check(flat.indexOf('\n') < 0, "text is flattened for logging and classification");
    check(parseNickInfo(raw).account == "alice", "INFO parses from the unflattened reply");
    check(parseNickInfo(flat).account.length == 0,
          "and cannot be parsed from the flattened one");

    // Option first: the reversed form answers
    // `Syntax: SASET option nickname parameters` and changes nothing, so
    // nothing but this ordering stops a silent no-op that leaves the old
    // password working.
    check(nickServSetPasswordCommand("nsvictim", "Aa1Bb2Cc3") == "SASET PASSWORD nsvictim Aa1Bb2Cc3",
          "SASET takes the option before the nickname");

    // Same shape on the channel side, and the same silent failure: the
    // reversed `SET #chan FOUNDER acct` answers `Syntax: SET option channel
    // parameters` and leaves the old founder in place.
    check(chanServSetFounderCommand("#scratchchan", "victim")
              == "SET FOUNDER #scratchchan victim",
          "ChanServ SET takes the option before the channel");

    // 2.1 confirms DROP with a random code and only prints the prompt for
    // a bare `DROP <target>` (or 2.0's `DROP <x> <x>`); OVERRIDE is what
    // makes the services-oper account's drop actually land.
    check(nickServDropCommand("nsvictim") == "DROP nsvictim OVERRIDE",
          "NickServ DROP skips the confirmation code with OVERRIDE");
    check(chanServDropCommand("#scratchchan") == "DROP #scratchchan OVERRIDE",
          "ChanServ DROP skips the confirmation code with OVERRIDE");

    // Without `* ALL` 2.1 hides the XOP rows the channel setup script
    // grants and answers `No matching entries` for every staff channel.
    check(chanServAccessListCommand("#staff") == "ACCESS #staff LIST * ALL",
          "ACCESS LIST asks for every provider's rows");
}

/// `anope.listAccounts ["full"]` plus `anope.listSuspendedAccounts []`,
/// shaped exactly as the RPC documents them: accounts with nicks,
/// extensions, opertype and users; one suspended-accounts entry per display.
private enum accountsFixture =
    `{`
    ~ `"alice":{"display":"alice","email":"a@b.co","lastmail":0,"registered":1788600000,`
    ~ `"uniqueid":1,"language":null,"extensions":{"NS_NO_EXPIRE":true},`
    ~ `"nicks":{"alice":{"lastseen":1788680000,"registered":1788600000,"extensions":{},`
    ~ `"vhost":null},"alice_away":{"lastseen":1788600001,"registered":1788600002}},`
    ~ `"opertype":{"name":"Services Root","commands":[],"privileges":[]},"users":[]},`
    ~ `"Bob":{"display":"Bob","email":null,"lastmail":0,"registered":1788600010,`
    ~ `"uniqueid":2,"language":null,"extensions":{},`
    ~ `"nicks":{"Bob":{"lastseen":1788600050,"registered":1788600010}},`
    ~ `"opertype":null,"users":["Bob"]}`
    ~ `}`;

private enum suspendedFixture =
    `{"alice":{"by":"admin","reason":"spam","time":1788681000,"expires":0}}`;

private void testAccountInventory() {
    auto rows = buildAccountInventory(parseJsonString(accountsFixture),
                                      parseJsonString(suspendedFixture));
    check(rows.length == 3, "one row per grouped alias");
    check(rows[0].nick == "alice" && rows[1].nick == "alice_away" && rows[2].nick == "Bob",
          "sorted by nick, case-insensitively");
    check(rows[0].account == "alice" && rows[0].email == "a@b.co",
          "joined to its account for the email");
    check(rows[0].registeredAt == 1788600000 && rows[0].lastSeenAt == 1788680000,
          "the alias's own registered/lastseen times");
    check(rows[0].suspended && rows[0].suspendedBy == "admin" && rows[0].suspendReason == "spam",
          "the suspended-accounts entry flags the account");
    check(rows[0].suspendedAt == 1788681000 && rows[0].suspendExpiresAt == 0,
          "expires 0 means never");
    check(rows[1].account == "alice" && rows[1].suspended
          && rows[1].registeredAt == 1788600002,
          "a grouped alias of a suspended account is suspended too");
    check(rows[2].email.length == 0 && !rows[2].suspended,
          "a null email parses as empty and a suspension never leaks onto another row");

    // IRC nicks are case-insensitive, so both the suspension join and the
    // sort have to be too.
    auto ci = buildAccountInventory(
        parseJsonString(`{"BOB":{"display":"BOB","email":null,"nicks":{"BOB":{}}}}`),
        parseJsonString(`{"bob":{"by":"admin","reason":"x","time":1,"expires":0}}`));
    check(ci.length == 1 && ci[0].suspended,
          "the suspended-accounts map matches the display case-insensitively");
}

/// Captured shape of `command ChanServ admin "INFO #staff"` — the prose the
/// per-channel view still parses, unchanged in 2.1.
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

/// `anope.listRegisteredChannels ["full"]`, shaped exactly as `rpc_registered`
/// documents it: suspended entries, extensions flags, and the topic as an
/// object — versus null when the channel holds none.
private enum channelsFixture =
    `{`
    ~ `"#staff":{"name":"#staff","founder":"Zodiac","successor":null,`
    ~ `"description":"IRC Fiber staff log feed",`
    ~ `"registered":1788491709,"lastused":1788855122,`
    ~ `"topic":{"value":"IRC Fiber operations log","setby":"admin","setat":1788676622},`
    ~ `"bot":"FIBERSERV","accesscount":2,"users":0,`
    ~ `"suspended":{"by":"admin","reason":"spam wave","time":1788681000,"expires":0},`
    ~ `"extensions":{"CS_NO_EXPIRE":true,"PERSIST":true}},`
    ~ `"#Abandoned":{"name":"#Abandoned","founder":null,"successor":null,`
    ~ `"description":null,"registered":1788491000,"lastused":1788491000,`
    ~ `"topic":null,"bot":null,"accesscount":0,"users":0,`
    ~ `"suspended":null,"extensions":{}}`
    ~ `}`;

private void testChannelInventory() {
    auto rows = buildChannelInventory(parseJsonString(channelsFixture));
    check(rows.length == 2, "one row per registered channel");
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
    check(staff.bot == "FIBERSERV", "the assigned BotServ bot is reported");
    check(staff.accessCount == 2, "the access count is carried through");
    check(staff.noExpire && staff.persistent && !staff.isPrivate,
          "extensions flags are read, and an absent one stays false");
    check(staff.suspended && staff.suspendedBy == "admin"
              && staff.suspendReason == "spam wave",
          "a non-null suspended object flags the channel");
    check(staff.suspendedAt == 1788681000 && staff.suspendExpiresAt == 0,
          "expires 0 means never");

    auto abandoned = rows[0];
    check(abandoned.founder.length == 0 && abandoned.successor.length == 0,
          "a channel whose founder core is gone keeps empty names");
    check(abandoned.description.length == 0, "a null description parses as empty");
    check(abandoned.lastTopic.length == 0 && abandoned.lastTopicAt == 0,
          "and a null topic parses as empty");
    check(!abandoned.suspended, "a null suspended object means not suspended");
}

void main() {
    testBuildCall();
    testParseReply();
    testCheckCredentials();
    testUserPresence();
    testSignupGuards();
    testSettings();
    testNickInfo();
    testOperReplies();
    testAccountInventory();
    testChanInfo();
    testChanAccessList();
    testChannelInventory();
    if (failures) {
        writefln("services tests: %d failures", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("services tests: PASS (0 failures)");
}
