module bot_nick_test;

import std.stdio : writeln, writefln;

import ircfiber.bots.nick;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

private void testNeedsReclaim() {
    // The whole point: a Guest nick on a live session must trigger reclaim.
    check(nickNeedsReclaim(true, "Guest25885", "FiberSupport"), "guest vs want");
    check(nickNeedsReclaim(true, "Guest21457", "FiberEye"), "guest vs eye");
    check(nickNeedsReclaim(true, "FiberSupport_", "FiberSupport"), "433 fallback still reclaims");
    // No-ops: already home, not registered, or nothing to compare.
    check(!nickNeedsReclaim(true, "FiberSupport", "FiberSupport"), "home nick is quiet");
    check(!nickNeedsReclaim(true, "fibersupport", "FiberSupport"), "case-insensitive match");
    check(!nickNeedsReclaim(false, "Guest25885", "FiberSupport"), "pre-registration is quiet");
    check(!nickNeedsReclaim(true, "", "FiberSupport"), "empty nick is quiet");
    check(!nickNeedsReclaim(true, "Guest1", ""), "empty want is quiet");
}

private void testClassify() {
    // Real Anope wordings, pinned so a wording drift fails loudly.
    check(classifyNickServNotice("NickServ!services@services.ircfiber.com",
        "This nickname is registered and protected. If it is your nick, type /msg NickServ IDENTIFY <password>. Otherwise, please choose a different nick.")
        == NickServNote.identifyRequest, "registered notice");
    check(classifyNickServNotice("NickServ!services@services.ircfiber.com",
        "If you do not change within 20 seconds, I will change your nick.")
        == NickServNote.identifyRequest, "enforce countdown");
    check(classifyNickServNotice("NickServ!services@services.ircfiber.com",
        "Your nickname is now being changed to Guest25885.")
        == NickServNote.identifyRequest, "guest rename notice still asks");
    check(classifyNickServNotice("NickServ!services@services.ircfiber.com",
        "Password accepted - you are now recognized.")
        == NickServNote.identifyOk, "accept wording");
    check(classifyNickServNotice("NickServ!services@services.ircfiber.com",
        "You are already identified.") == NickServNote.identifyOk, "already identified");
    check(classifyNickServNotice("NickServ!services@services.ircfiber.com",
        "Invalid password for FiberSupport.") == NickServNote.identifyBad, "bad password");
    // Sender gate: the same wordings from anyone else must not IDENTIFY.
    check(classifyNickServNotice("ChanServ!services@services.ircfiber.com",
        "Password accepted - you are now recognized.") == NickServNote.none, "chanserv never");
    check(classifyNickServNotice("irc.ircfiber.com",
        "This nickname is registered and protected.") == NickServNote.none, "server never");
    check(classifyNickServNotice("NickServ!services@services.ircfiber.com",
        "Some unrecognized services chatter.") == NickServNote.none, "unknown text");
    // Bare prefix (no hostmask) is still NickServ.
    check(classifyNickServNotice("NickServ", "Please identify yourself.")
        == NickServNote.identifyRequest, "bare prefix");
    // Ok wins over request when a success notice echoes the word "registered".
    check(classifyNickServNotice("NickServ!s@s.h", "You are now identified as the owner of this registered nick.")
        == NickServNote.identifyOk, "ok precedes request");
}

private void testModeGrants() {
    check(modeGrantsRegistered("Guest25885", ["Guest25885", "+r"]), "+r grants");
    check(modeGrantsRegistered("FiberSupport", ["FiberSupport", "+rw"]), "+rw grants");
    check(!modeGrantsRegistered("FiberSupport", ["FiberSupport", "+B"]), "own +B ignored");
    check(!modeGrantsRegistered("FiberEye", ["FiberEye", "+s"]), "snomask ignored");
    check(!modeGrantsRegistered("FiberEye", ["FiberEye", "-r"]), "removal ignored");
    check(!modeGrantsRegistered("FiberEye", ["SomeoneElse", "+r"]), "other target ignored");
    check(modeGrantsRegistered("fibereye", ["FiberEye", "+r"]), "target case-insensitive");
    check(!modeGrantsRegistered("x", ["x"]), "short params ignored");
}

private void testPacing() {
    // The contracts the bot relies on: reclaim beats the 60 s enforce kill,
    // IDENTIFY resends stay clear of Anope's throttle.
    check(NICK_RECLAIM_EVERY_MS == 30_000, "reclaim cadence");
    check(IDENTIFY_RESEND_MIN_MS == 60_000, "identify cadence");
    check(NICK_RECLAIM_EVERY_MS < 60_000, "reclaim wins the enforce race");
}

void main() {
    testNeedsReclaim();
    testClassify();
    testModeGrants();
    testPacing();
    if (failures) {
        writefln("bot nick tests: %d FAILED", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("bot nick tests: PASS");
}
