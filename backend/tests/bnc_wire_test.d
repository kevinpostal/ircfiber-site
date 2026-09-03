module bnc_wire_test;

import std.stdio : writeln, writefln;
import std.conv : to;
import std.string : indexOf, startsWith, endsWith;
import std.algorithm : canFind;
import vibe.data.json : Json, parseJsonString;

import ircfiber.bnc.wire;
import ircfiber.bnc.format;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

private void testParseBncPass() {
    auto a = parseBncPass("bnc:abc");
    check(a.ok && a.clientId == "" && a.token == "abc", "bnc:abc");
    auto b = parseBncPass("bnc@laptop:abc");
    check(b.ok && b.clientId == "laptop" && b.token == "abc", "bnc@laptop:abc");
    check(!parseBncPass("bnc@my id:abc").ok, "space in clientid rejected");
    check(!parseBncPass("znc:abc").ok, "znc prefix rejected");
    check(!parseBncPass("bnc:").ok, "empty token rejected");

    // server-time round trip and CHATHISTORY refs
    check(parseServerTime("2026-09-02T14:03:11.412Z") == 1788357791412L, "parseServerTime ms");
    check(parseServerTime("2026-09-02T14:03:11Z") == 1788357791000L, "parseServerTime no frac");
    check(parseServerTime(serverTimeTag(1788357791412L)) == 1788357791412L, "serverTimeTag round trip");
    check(parseServerTime("2026-09-02 14:03:11Z") == 0, "bad separator rejected");
    check(parseServerTime("nope") == 0, "garbage rejected");
    check(parseHistoryRef("*").ok && parseHistoryRef("*").kind == "*", "ref *");
    auto tr = parseHistoryRef("timestamp=2026-09-02T14:03:11.412Z");
    check(tr.ok && tr.kind == "timestamp" && tr.ts == 1788357791412L, "ref timestamp");
    auto mr = parseHistoryRef("msgid=abc123");
    check(mr.ok && mr.kind == "msgid" && mr.msgid == "abc123", "ref msgid");
    check(!parseHistoryRef("timestamp=garbage").ok, "ref bad timestamp");
    check(!parseHistoryRef("msgid=").ok, "ref empty msgid");
    check(!parseHistoryRef("2026-09-02T14:03:11Z").ok, "ref without kind");
    check(playbackTimePrefix(1788357791412L) == "[14:03:11] ", "playback prefix");
    check(!parseBncPass("bnc@:abc").ok, "empty clientid rejected");
    check(!parseBncPass("abc").ok, "no colon rejected");
    check(parseBncPass("bnc@a.b-c_d:1:x").token == "1:x", "token keeps later colons");
}

private void testParseClientLine() {
    auto p = parseClientLine("@t=1 :n!u@h PRIVMSG #c :hi there");
    check(p.command == "PRIVMSG", "command uppercased");
    check(p.params == ["#c", "hi there"], "params with trailing");
    check(p.withoutTags == ":n!u@h PRIVMSG #c :hi there", "withoutTags keeps prefix");
    auto q = parseClientLine("privmsg #c hello");
    check(q.command == "PRIVMSG" && q.params == ["#c", "hello"], "lowercase command");
    auto r = parseClientLine("CAP LS 302");
    check(r.command == "CAP" && r.params == ["LS", "302"], "CAP LS 302");
    auto s = parseClientLine("JOIN #a,#b key");
    check(s.params == ["#a,#b", "key"], "JOIN params");
    check(parseClientLine("").command == "", "empty line");
}

private void testFormatLine() {
    check(formatLine(null, "s", "001", ["nick", "Welcome home"]) == ":s 001 nick :Welcome home", "trailing with space");
    check(formatLine(null, "s", "PONG", ["abc"]) == ":s PONG abc", "no colon for simple last param");
    check(formatLine(null, "", "PONG", [""]) == "PONG :", "empty last param gets colon");
    check(formatLine(null, "", "PRIVMSG", ["#c", ":x"]) == "PRIVMSG #c ::x", "leading colon last param");
    auto tagged = formatLine(["time": "2026-01-01T00:00:00.000Z"], "n!u@h", "PRIVMSG", ["#c", "hi"]);
    check(tagged == "@time=2026-01-01T00:00:00.000Z :n!u@h PRIVMSG #c hi", "tag prefix");
    auto esc = formatLine(["k": "a;b c\\d"], "", "TAGMSG", ["#c"]);
    check(esc.startsWith("@k=a\\:b\\sc\\\\d "), "tag value escaped: " ~ esc);
    string longText;
    foreach (i; 0 .. 700) longText ~= "x";
    auto capped = formatLine(null, "s", "PRIVMSG", ["#c", longText]);
    check(capped.length <= 510, "untagged line capped to 510");
    auto cappedTags = formatLine(["time": "t"], "s", "PRIVMSG", ["#c", longText]);
    check(cappedTags.length <= 510 + "@time=t ".length, "tagged line body capped");
}

private void testNames() {
    check(adaptNameToken("@+nick!u@h", false, false, "@+") == "@nick", "single prefix, no uhnames");
    check(adaptNameToken("@+nick!u@h", true, false, "@+") == "@+nick", "multi-prefix");
    check(adaptNameToken("@+nick!u@h", true, true, "@+") == "@+nick!u@h", "multi-prefix + uhnames");
    check(adaptNameToken("nick", false, false, "@+") == "nick", "bare nick");
    check(stripPrefix("~@nick!u@h", "~&@%+") == "nick", "stripPrefix");
    check(prefixCharsFromIsupport("(qaohv)~&@%+") == "~&@%+", "prefix chars parsed");
    check(prefixCharsFromIsupport("") == "~&@%+", "prefix chars default");

    string[] toks;
    foreach (i; 0 .. 300) toks ~= "@nick" ~ (cast(char)('a' + i % 26)) ~ "xyz";
    auto lines = chunkNames(":s 353 me = #c :", toks);
    check(lines.length > 1, "chunkNames splits");
    size_t total;
    foreach (l; lines) { check(l.length <= 480, "chunk ≤ 480"); total += l.length; }
    check(chunkNames(":p ", []).length == 0, "no tokens → no lines");
    check(chunkNames(":p ", ["a", "b"]) == [":p a b"], "join with space");
}

private void testServerTime() {
    check(serverTimeTag(0) == "1970-01-01T00:00:00.000Z", "epoch");
    check(serverTimeTag(1_700_000_000_123) == "2023-11-14T22:13:20.123Z", "known ms timestamp: " ~ serverTimeTag(1_700_000_000_123));
}

private FormatCtx ctx(string[] caps...) {
    FormatCtx c;
    c.src = "bnc.test";
    c.nick = "me";
    c.networkName = "Net";
    c.sessionId = "deadbeef";
    foreach (cap; caps) c.caps[cap] = true;
    c.nowMs = 1_000_000;
    return c;
}

private void testFormatEvent() {
    auto c = ctx("server-time");
    check(formatEvent(parseJsonString(`{"c":"PRIVMSG","phase":"connecting","x":"x"}`), c) == "", "phase dropped");
    check(formatEvent(parseJsonString(`{"c":"001","p":["me","hi"]}`), c) == "", "001 dropped");
    check(formatEvent(parseJsonString(`{"c":"QUIT","n":"bob","hm":"u@h","ch":"#c","x":"bye","p":["bye"]}`), c) == "", "QUIT with ch dropped");
    auto quit = formatEvent(parseJsonString(`{"c":"QUIT","n":"bob","hm":"u@h","x":"bye","p":["bye"],"t":1700000000123}`), c);
    check(quit == "@time=2023-11-14T22:13:20.123Z :bob!u@h QUIT bye", "QUIT forwarded: " ~ quit);

    // Own labeled message, no echo-message → drop.
    auto own = parseJsonString(`{"c":"PRIVMSG","n":"me","hm":"u@h","se":"true","l":"bnc-deadbeef-1","p":["#c","hi"],"x":"hi","ch":"#c","t":1}`);
    check(formatEvent(own, c) == "", "own labeled PRIVMSG dropped without echo-message");
    auto cEcho = ctx("echo-message");
    check(formatEvent(own, cEcho).endsWith(":me!u@h PRIVMSG #c hi"), "own labeled PRIVMSG echoed with echo-message");
    // Another device's message → delivered.
    auto other = parseJsonString(`{"c":"PRIVMSG","n":"me","hm":"u@h","se":"true","l":"web-1","p":["#c","from web"],"x":"from web","ch":"#c","t":1}`);
    check(formatEvent(other, c).endsWith(":me!u@h PRIVMSG #c :from web"), "other-device message delivered");
    // Unlabeled server echo matching recentOwn → dropped once.
    RecentOwn ring;
    auto cRing = ctx();
    cRing.recentOwn = &ring;
    ring.push("#c", "dup", 999_000);
    auto echo = parseJsonString(`{"c":"PRIVMSG","n":"me","hm":"u@h","se":"true","p":["#c","dup"],"x":"dup","ch":"#c","t":1}`);
    check(formatEvent(echo, cRing) == "", "unlabeled echo suppressed once");
    check(formatEvent(echo, cRing) != "", "second copy delivered");

    // Cap gating.
    auto tagmsg = parseJsonString(`{"c":"TAGMSG","n":"bob","hm":"u@h","p":["#c"],"ch":"#c","typing":"active","m":"abc","i":"id"}`);
    check(formatEvent(tagmsg, ctx()) == "", "TAGMSG needs message-tags");
    auto tm = formatEvent(tagmsg, ctx("message-tags"));
    check(tm.canFind("msgid=abc") && tm.canFind("+typing=active") && tm.endsWith(":bob!u@h TAGMSG #c"), "TAGMSG with tags: " ~ tm);
    check(formatEvent(parseJsonString(`{"c":"AWAY","n":"bob","hm":"u@h"}`), ctx()) == "", "AWAY needs away-notify");
    check(formatEvent(parseJsonString(`{"c":"AWAY","n":"bob","hm":"u@h","p":["gone"]}`), ctx("away-notify")) == ":bob!u@h AWAY gone", "AWAY with away-notify");
    check(formatEvent(parseJsonString(`{"c":"INVITE","n":"bob","hm":"u@h","p":["me","#c"]}`), ctx()) == ":bob!u@h INVITE me #c", "INVITE to us always forwarded");
    check(formatEvent(parseJsonString(`{"c":"INVITE","n":"bob","hm":"u@h","p":["other","#c"]}`), ctx()) == "", "INVITE to other needs invite-notify");
    // extended-join trimming.
    check(formatEvent(parseJsonString(`{"c":"JOIN","n":"bob","hm":"u@h","p":["#c","acct","Real Name"],"ch":"#c"}`), ctx()) == ":bob!u@h JOIN #c", "JOIN trimmed without extended-join");
    check(formatEvent(parseJsonString(`{"c":"JOIN","n":"bob","hm":"u@h","p":["#c","acct","Real Name"],"ch":"#c"}`), ctx("extended-join")) == ":bob!u@h JOIN #c acct :Real Name", "JOIN kept with extended-join");
    // Numerics get the server prefix and 353 adapts tokens.
    auto names = formatEvent(parseJsonString(`{"c":"353","p":["me","=","#c","@+bob!u@h carol"],"ch":"#c"}`), ctx());
    check(names == ":bnc.test 353 me = #c :@bob carol", "353 adapted: " ~ names);
    // msgid falls back to i → no msgid tag.
    auto noMsgid = formatEvent(parseJsonString(`{"c":"PRIVMSG","n":"bob","hm":"u@h","p":["#c","x"],"m":"id1","i":"id1","ch":"#c"}`), ctx("message-tags"));
    check(noMsgid == ":bob!u@h PRIVMSG #c x", "no msgid when m==i: " ~ noMsgid);
    // Unknown commands are dropped; status notices are rewritten.
    check(formatEvent(parseJsonString(`{"c":"CONNECTED"}`), ctx()) == "", "CONNECTED dropped");
    check(formatEvent(parseJsonString(`{"c":"DISCONNECT","x":"Ping timeout"}`), ctx()) == ":*status!bnc@bnc.test NOTICE me :Disconnected from Net: Ping timeout", "DISCONNECT notice");
    // The engine emits DISCONNECTED twice per drop; only one notice within 5 s.
    RecentOwn dring;
    auto cD = ctx(); cD.recentOwn = &dring;
    check(formatEvent(parseJsonString(`{"c":"DISCONNECTED","x":"Closing link"}`), cD) != "", "first DISCONNECTED notice sent");
    check(formatEvent(parseJsonString(`{"c":"DISCONNECTED","x":"nick@host"}`), cD) == "", "second DISCONNECTED within 5s suppressed");
    cD.nowMs += 6_000;
    check(formatEvent(parseJsonString(`{"c":"DISCONNECTED","x":"later"}`), cD) != "", "DISCONNECTED after 5s sent again");
    // Upstream ERROR is never forwarded (a client would drop the session).
    check(formatEvent(parseJsonString(`{"c":"ERROR","p":["Closing link: bye"],"x":"Closing link: bye"}`), ctx()) == "", "ERROR not forwarded");
}

private void testGrouping() {
    Json[] evs = [
        parseJsonString(`{"c":"PRIVMSG","ch":"#a","n":"x"}`),
        parseJsonString(`{"c":"PRIVMSG","n":"bob"}`),
        parseJsonString(`{"c":"PRIVMSG","ch":"#a","n":"y"}`),
    ];
    auto g = groupByBuffer(evs);
    check(g.length == 2 && g["#a"].length == 2 && g["bob"].length == 1, "groupByBuffer keys");
    check(bufferOrder(evs) == ["#a", "bob"], "bufferOrder first-seen");
}

private void testMissedRows() {
    // msgid keys before eid: live + backfill copies share one key.
    auto live = parseJsonString(`{"c":"PRIVMSG","ch":"#superbowl","n":"roarie","x":"hi","m":"AAA","eid":100,"t":1000}`);
    auto backfill = parseJsonString(`{"c":"PRIVMSG","ch":"#superbowl","n":"roarie","x":"hi","m":"AAA","eid":200,"t":1000,"batch":"chathistory"}`);
    check(bncRowKey(live) == "mAAA", "msgid wins over eid");
    check(bncRowKey(live) == bncRowKey(backfill), "live and backfill share key");
    auto noeid = parseJsonString(`{"c":"PRIVMSG","n":"b","x":"y","m":"BBB"}`);
    check(bncRowKey(noeid) == "mBBB", "msgid without eid");
    auto nomsg = parseJsonString(`{"c":"PRIVMSG","n":"b","x":"y","eid":7,"t":9}`);
    check(bncRowKey(nomsg) == "e7", "eid fallback");
    check(isBncChatRow(live), "PRIVMSG is chat");
    check(isBncChatRow(parseJsonString(`{"c":"NOTICE","n":"b"}`)), "NOTICE is chat");
    check(!isBncChatRow(parseJsonString(`{"c":"TAGMSG","n":"b"}`)), "TAGMSG not chat");
    check(!isBncChatRow(parseJsonString(`{"c":"PRIVMSG","phase":"connecting"}`)), "phase rows not chat");
    check(!isBncChatRow(parseJsonString(`{"c":"JOIN","n":"b"}`)), "JOIN not chat");

    // Reconnect filter: seenTs = 1500 (cursor row timestamp). The page is
    // what getAfterEidForNetwork returns, so the pre-away live row (eid <=
    // cursor) is absent; only its backfill copy (fresh eid) shows up.
    Json[] page = [
        parseJsonString(`{"c":"PRIVMSG","ch":"#c","n":"a","x":"old live backfill","m":"M1","eid":201,"t":1000,"batch":"chathistory"}`),
        parseJsonString(`{"c":"PRIVMSG","ch":"#c","n":"a","x":"missed live","m":"M2","eid":202,"t":2000}`),
        parseJsonString(`{"c":"PRIVMSG","ch":"#c","n":"a","x":"missed live mistagged","m":"M3","eid":203,"t":2000,"batch":"chathistory"}`),
        parseJsonString(`{"c":"PRIVMSG","ch":"#c","n":"a","x":"missed backfill copy","m":"M2","eid":204,"t":2000,"batch":"chathistory"}`),
        parseJsonString(`{"c":"TAGMSG","ch":"#c","n":"a","eid":205,"t":2000}`),
    ];
    auto keep = filterMissedRows(page, 1500);
    check(keep.length == 2, "missed set collapses to 2 unique: " ~ keep.length.to!string);
    if (keep.length == 2) {
        check(keep[0]["m"].get!string == "M2", "live copy kept first");
        check(keep[1]["m"].get!string == "M3", "mis-tagged missed row kept");
    }
    // Unknown cursor timestamp: legacy skip-all-batched.
    auto keepUnknown = filterMissedRows(page, -1);
    check(keepUnknown.length == 1, "unknown seenTs keeps unbatched only: " ~ keepUnknown.length.to!string);
    if (keepUnknown.length == 1)
        check(keepUnknown[0]["m"].get!string == "M2", "legacy fallback row");
}

void main() {
    testParseBncPass();
    testParseClientLine();
    testFormatLine();
    testNames();
    testServerTime();
    testFormatEvent();
    testGrouping();
    testMissedRows();
    if (failures) {
        writefln("bnc wire tests: %d FAILED", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("bnc wire tests: PASS");
}
