module backups_test;

///
/// Unit tests for the admin Backups pure helpers
/// (ircfiber.web.admin.backups). No k8s, Redis or Mongo needed:
///   dub --root=backend build --config=backups-test && ./backend/backups-test
///

import std.stdio : writeln, writefln;

import vibe.data.json : Json, parseJsonString;

import ircfiber.web.admin.backups : backupKind, nextDailyRunMs,
    parseK8sTimeMs, freshnessState, normalizeRun;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

private long msAt(int y, int mo, int d, int h, int mi) {
    import std.datetime : DateTime, TimeOfDay, Date, UTC;
    import std.datetime.systime : SysTime;
    return SysTime(DateTime(Date(y, mo, d), TimeOfDay(h, mi, 0)), UTC()).toUnixTime() * 1000;
}

private void testNextDailyRun() {
    // 03:17 schedule, now past it → tomorrow 03:17 UTC.
    long now = msAt(2026, 9, 7, 4, 0);
    check(nextDailyRunMs("17 3 * * *", now) == msAt(2026, 9, 8, 3, 17), "past 03:17 rolls to tomorrow");
    // Now before it → today 03:17 UTC.
    now = msAt(2026, 9, 7, 2, 0);
    check(nextDailyRunMs("17 3 * * *", now) == msAt(2026, 9, 7, 3, 17), "before 03:17 stays today");
    // Redis job schedule parses too.
    check(nextDailyRunMs("37 3 * * *", now) == msAt(2026, 9, 7, 3, 37), "redis schedule today");
    // Anything beyond M H * * * has no estimate.
    check(nextDailyRunMs("*/5 * * * *", now) == -1, "step schedule rejected");
    check(nextDailyRunMs("17 3 * * 1", now) == -1, "weekday schedule rejected");
    check(nextDailyRunMs("not a schedule", now) == -1, "malformed rejected");
    check(nextDailyRunMs("17 25 * * *", now) == -1, "hour 25 rejected");
    check(nextDailyRunMs("", now) == -1, "empty rejected");
}

private void testFreshness() {
    long now = msAt(2026, 9, 7, 12, 0);
    // A failed run newer than the last success wins over a fresh success.
    check(freshnessState(now - 3600_000, now - 1800_000, "failed", now) == "failed",
        "failed run newer than success wins");
    // ... but a success after the failure clears it.
    check(freshnessState(now - 1800_000, now - 3600_000, "failed", now) == "ok",
        "success after failure clears");
    check(freshnessState(0, 0, "", now) == "never", "no success is never");
    check(freshnessState(0, now - 1000, "failed", now) == "failed",
        "failed with no success is failed, not never");
    check(freshnessState(now - 31 * 3600_000L, now - 31 * 3600_000L, "ok", now) == "late",
        "31h old success is late");
    check(freshnessState(now - 25 * 3600_000L, now - 25 * 3600_000L, "ok", now) == "ok",
        "25h old success is ok");
}

private void testBackupKind() {
    check(backupKind("mongo-20260907-031701.archive.gz") == "mongo", "mongo archive");
    check(backupKind("redis-20260907-021628.rdb") == "redis", "redis archive");
    check(backupKind("ircfiber-mongo-backup") == "mongo", "mongo cronjob");
    check(backupKind("ircfiber-redis-backup") == "redis", "redis cronjob");
    check(backupKind("something-else") == "", "unrelated name");
    check(backupKind("") == "", "empty name");
}

private void testParseK8sTime() {
    check(parseK8sTimeMs("2026-09-07T03:18:38Z") == msAt(2026, 9, 7, 3, 18) + 38_000,
        "rfc3339 parses");
    check(parseK8sTimeMs("") == -1, "empty is -1");
    check(parseK8sTimeMs("not-a-time") == -1, "garbage is -1");
}

private void testNormalizeRun() {
    // A record without a kind is skipped, not crashed on.
    check(normalizeRun(parseJsonString(`{"status":"ok"}`)).type == Json.Type.undefined,
        "no kind skipped");
    check(normalizeRun(parseJsonString(`[1,2]`)).type == Json.Type.undefined,
        "non-object skipped");
    // A string bytes field is coerced to a number.
    auto r = normalizeRun(parseJsonString(
        `{"kind":"redis","status":"ok","stage":"done","bytes":"9639469","startedAt":1788751020000}`));
    check(r.type != Json.Type.undefined, "valid record kept");
    check(r["bytes"].get!long == 9639469, "string bytes coerced");
    check(r["status"].get!string == "ok", "status kept");
    check(r["message"].get!string == "", "missing message defaults");
    // Unknown fields are dropped, status defaults to unknown.
    auto q = normalizeRun(parseJsonString(`{"kind":"mongo","extra":{"x":1}}`));
    check(q["status"].get!string == "unknown", "status defaults to unknown");
    bool hasExtra = true;
    try { auto e = q["extra"]; hasExtra = e.type != Json.Type.undefined; }
    catch (Exception) { hasExtra = false; }
    check(!hasExtra, "unknown fields dropped");
}

void main() {
    testNextDailyRun();
    testFreshness();
    testBackupKind();
    testParseK8sTime();
    testNormalizeRun();
    if (failures == 0) writeln("backups-test: all checks passed");
    else writefln("backups-test: %d FAILURES", failures);
    import core.stdc.stdlib : exit;
    if (failures != 0) exit(1);
}
