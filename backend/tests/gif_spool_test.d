module gif_spool_test;

import std.conv : to;
import std.algorithm.searching : canFind;
import std.stdio : writefln, writeln;

import ircfiber.api.gifspool;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

/// The name the gateway writes into a `.job` file is handed to a POSIX shell
/// in the sandbox. Every rejection here is a path-escape or command-injection
/// hazard if it were accepted.
private void testSafeName() {
    check(gifSpoolSafeName("a1b2c3d4.mov"), "generated upload name accepted");
    check(gifSpoolSafeName("ab-cd_ef.gif"), "dash and underscore accepted");
    check(!gifSpoolSafeName("../../etc/passwd"), "parent traversal rejected");
    check(!gifSpoolSafeName("img2irc/x.png"), "subdirectory rejected");
    check(!gifSpoolSafeName(".hidden"), "leading dot rejected");
    check(!gifSpoolSafeName("a b.mov"), "whitespace rejected");
    check(!gifSpoolSafeName("x$(id).mov"), "command substitution rejected");
    check(!gifSpoolSafeName("x;rm -rf /.mov"), "shell separator rejected");
    check(!gifSpoolSafeName("x\n.mov"), "newline rejected (would forge a spec line)");
    check(!gifSpoolSafeName(""), "empty name rejected");
    string long_;
    foreach (i; 0 .. 130) long_ ~= "a";
    check(!gifSpoolSafeName(long_), "over-long name rejected");
}

private void testSpec() {
    check(gifSpoolSpec("in.mov", "out.gif", 30) == "src=in.mov\nout=out.gif\nseconds=30\n",
        "spec body, got " ~ gifSpoolSpec("in.mov", "out.gif", 30));
    check(gifSpoolValue("duration_ms=29930\nformat=mov,mp4,m4a\n", "format") == "mov,mp4,m4a",
        "value lookup");
    check(gifSpoolValue("duration_ms=29930\n", "format").length == 0, "missing key yields nothing");
    // `error` must not be read out of a `status`-only file.
    check(gifSpoolValue("status=0\n", "error").length == 0, "no accidental prefix match");
}

/// The gateway reads the progress file WHILE ffmpeg is appending to it, so the
/// parser's whole job is to ignore the trailing half-written block.
private void testProgress() {
    auto p = parseGifProgress(
        "frame=38\nfps=12.5\nout_time_us=3090000\nspeed=15.1x\nprogress=continue\n"
      ~ "frame=360\nfps=163.7\nout_time_us=29930000\nspeed=13.6x\nprogress=end\n"
      ~ "frame=999\nout_time_us=99000000\n");
    check(p.any, "a complete block was found");
    check(p.ended, "progress=end observed");
    check(p.frame == 360, "last committed frame, got " ~ p.frame.to!string);
    check(p.outTimeMs == 29930, "microseconds converted to ms, got " ~ p.outTimeMs.to!string);
    check(p.speed > 13.5 && p.speed < 13.7, "speed suffix stripped, got " ~ p.speed.to!string);

    check(!parseGifProgress("frame=1\nout_time_us=500000\n").any,
        "a block with no terminator is not reported");
    check(!parseGifProgress("").any, "empty file is not reported");

    // Pass 1 (palettegen) emits its single frame at EOF, so the output
    // timeline never advances. The percentage must stay 0 instead of jumping,
    // which is why the client renders that phase indeterminate.
    auto pal = parseGifProgress("frame=1\nfps=0.00\nout_time_us=0\nspeed=0x\nprogress=continue\n");
    check(pal.any && pal.outTimeMs == 0, "palette pass reports no output time");

    // "N/A" is what ffmpeg prints before the first frame.
    auto na = parseGifProgress("frame=0\nfps=N/A\nspeed=N/A\nout_time_us=N/A\nprogress=continue\n");
    check(na.any && na.speed == 0 && na.outTimeMs == 0, "N/A fields do not poison the snapshot");
}

private void testExit() {
    auto ex = parseGifExit("status=65\nerror=Unsupported media container (hls,applehttp)\n");
    check(ex.present && ex.status == 65, "status parsed");
    check(ex.error.canFind("hls"), "worker message preserved, got " ~ ex.error);
    check(parseGifExit("status=0\n").present, "success is terminal");
    check(parseGifExit("status=0\n").error.length == 0, "success carries no error");
    // Written last and atomically, but a truncated read must not look like success.
    check(!parseGifExit("error=half written\n").present, "missing status is not terminal");
    check(!parseGifExit("status=\n").present, "empty status is not terminal");
    check(!parseGifExit("").present, "absent file is not terminal");
}

private void testExitMessage() {
    check(gifExitMessage(137).canFind("memory"), "OOM kill explained, got " ~ gifExitMessage(137));
    check(gifExitMessage(-9).canFind("memory"), "signalled form explained");
    check(gifExitMessage(124).canFind("too long"), "timeout explained");
    check(gifExitMessage(153).canFind("too big"), "file-size limit explained");
    check(gifExitMessage(1).canFind("code 1"), "unknown status keeps the number");
}

void main() {
    testSafeName();
    testSpec();
    testProgress();
    testExit();
    testExitMessage();
    if (failures > 0) {
        writefln("\n%d check(s) failed", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("gif_spool_test: all checks passed");
}
