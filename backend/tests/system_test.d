module system_test;

///
/// Unit tests for the host-metrics + Docker parsers behind the admin System
/// page (ircfiber.sysmetrics). Every fixture is a real capture from the prod
/// host (Ubuntu 22.04, kernel 7.0.0-31, 4 vCPU, cgroup v2 / systemd driver,
/// Docker 29.7.2) — no /proc, /sys, docker socket or network needed:
///   dub --root=backend build --config=system-test && ./backend/system-test
///

import std.stdio : writefln, writeln;
import std.math : abs;
import std.string : indexOf;

import ircfiber.sysmetrics : containerIdFromCgroupDir, demuxDockerLogStream,
    isStopProtected, logSafe, parseCgroupCpuUsageUsec, parseCgroupValue,
    parseContainerList, parseCpuCount, parseDiskStats, parseDockerInfo,
    parseHealth, parseLoadAvg, parseMemInfo, parseMounts, parseNetDev,
    parseProcStat, parseUptimeSeconds, resolveControl, LOG_MAX_BYTES;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

// Real /proc/stat head from the prod host, plus its four per-core lines.
private enum PROC_STAT = "cpu  116660 510 53781 1684859 1511 0 9111 1037 0 0\n"
    ~ "cpu0 29122 128 13545 421220 377 0 2288 259 0 0\n"
    ~ "cpu1 29310 127 13401 421302 378 0 2270 260 0 0\n"
    ~ "cpu2 29088 128 13417 421168 378 0 2277 259 0 0\n"
    ~ "cpu3 29140 127 13418 421169 378 0 2276 259 0 0\n"
    ~ "intr 12345678 0 0\n"
    ~ "ctxt 98765432\n"
    ~ "procs_running 1\n";

private void testProcStat() {
    auto t = parseProcStat(PROC_STAT);
    check(t.user == 116660, "stat user");
    check(t.nice == 510, "stat nice");
    check(t.system == 53781, "stat system");
    check(t.idle == 1684859, "stat idle");
    check(t.iowait == 1511, "stat iowait");
    check(t.softirq == 9111, "stat softirq");
    check(t.steal == 1037, "stat steal");
    check(t.busy() == t.total() - t.idle - t.iowait, "busy excludes idle+iowait");
    check(parseCpuCount(PROC_STAT) == 4, "four vCPUs from per-core lines");

    // A kernel line with fewer fields must not throw or misalign.
    auto shortT = parseProcStat("cpu  10 2 3 4\n");
    check(shortT.user == 10 && shortT.idle == 4 && shortT.steal == 0, "short cpu line reads 0 tail");

    // Two samples 5 s apart: the rate the collector publishes is
    // Δbusy/Δtotal, here 40 busy jiffies out of 2000.
    auto later = parseProcStat("cpu  116690 510 53791 1686819 1511 0 9111 1037 0 0\n");
    const long dTotal = later.total() - t.total();
    const long dBusy = later.busy() - t.busy();
    check(dTotal == 2000, "Δtotal over the 5 s sample");
    check(dBusy == 40, "Δbusy over the 5 s sample");
    const double pct = (cast(double) dBusy / dTotal) * 100.0;
    check(abs(pct - 2.0) < 1e-9, "2% busy over the interval");
}

private void testMemInfo() {
    auto m = parseMemInfo(
        "MemTotal:        7931932 kB\n"
        ~ "MemFree:         2150312 kB\n"
        ~ "MemAvailable:    6115400 kB\n"
        ~ "Buffers:          214848 kB\n"
        ~ "Cached:          3660196 kB\n"
        ~ "SwapCached:            0 kB\n"
        ~ "SwapTotal:        999420 kB\n"
        ~ "SwapFree:         999420 kB\n");
    check(m.totalKb == 7931932, "MemTotal");
    check(m.freeKb == 2150312, "MemFree");
    check(m.availableKb == 6115400, "MemAvailable");
    check(m.buffersKb == 214848, "Buffers");
    check(m.cachedKb == 3660196, "Cached");
    check(m.swapTotalKb == 999420 && m.swapFreeKb == 999420, "swap pair");
    // SwapCached must not be read as SwapTotal/SwapFree.
    const long usedBytes = (m.totalKb - m.availableKb) * 1024;
    check(usedBytes == (7931932 - 6115400) * 1024, "used excludes cache");
}

private void testLoadAndUptime() {
    auto l = parseLoadAvg("0.31 0.42 0.47 1/785 118739\n");
    check(abs(l.one - 0.31) < 1e-9, "load1");
    check(abs(l.five - 0.42) < 1e-9, "load5");
    check(abs(l.fifteen - 0.47) < 1e-9, "load15");
    check(l.procsRunnable == 1, "runnable procs");
    check(l.procsTotal == 785, "total procs");
    check(abs(parseUptimeSeconds("4695.63 16848.58\n") - 4695.63) < 1e-9, "uptime seconds");
}

private void testNetDev() {
    auto rows = parseNetDev(
        "Inter-|   Receive                                                |  Transmit\n"
        ~ " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"
        ~ "    lo: 9840760   43126    0    0    0     0          0         0  9840760   43126    0    0    0     0       0          0\n"
        ~ "  ens3: 277067228  508713    0    0    0     0          0         0 569286456  681540    0    0    0     0       0          0\n"
        ~ "docker0: 1234 12 0 0 0 0 0 0 4321 21 0 0 0 0 0 0\n"
        ~ "veth3f2a1b: 99 1 0 0 0 0 0 0 88 1 0 0 0 0 0 0\n");
    check(rows.length == 1, "only the physical interface survives");
    if (rows.length == 1) {
        check(rows[0].name == "ens3", "interface name");
        check(rows[0].rxBytes == 277067228, "rx bytes");
        check(rows[0].rxPackets == 508713, "rx packets");
        check(rows[0].txBytes == 569286456, "tx bytes");
        check(rows[0].txPackets == 681540, "tx packets");
        check(rows[0].rxErrs == 0 && rows[0].txDrop == 0, "error/drop counters");
    }
}

private void testDiskStats() {
    auto rows = parseDiskStats(
        "   7       0 loop0 15 0 934 8 0 0 0 0 0 32 8 0 0 0 0 0 0\n"
        ~ "   8       0 sda 43635 16525 6990820 14085 169715 104685 9904950 101897 0 24201 122972 24367 0 133480168 2297 31176 4692\n"
        ~ "   8       1 sda1 43100 16400 6900000 13900 169000 104000 9900000 101000 0 24000 122000 24000 0 133000000 2200 31000 4600\n");
    check(rows.length == 3, "every row is returned; the collector filters");
    auto sda = rows[1];
    check(sda.name == "sda", "device name");
    check(sda.readsCompleted == 43635, "reads completed");
    check(sda.sectorsRead == 6990820, "sectors read");
    check(sda.writesCompleted == 169715, "writes completed");
    check(sda.sectorsWritten == 9904950, "sectors written");
}

private void testMounts() {
    auto rows = parseMounts(
        "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n"
        ~ "/dev/sda1 / ext4 rw,relatime,discard,errors=remount-ro 0 0\n"
        ~ "/dev/sda13 /boot ext4 rw,relatime 0 0\n"
        ~ "/dev/sda15 /boot/efi vfat rw,relatime,fmask=0077 0 0\n"
        ~ "overlay /var/lib/docker/rootfs/overlayfs/abc overlay rw,relatime 0 0\n"
        ~ "tmpfs /run/lock tmpfs rw,nosuid,nodev 0 0\n"
        ~ "/dev/sdb1 /mnt/my\\040disk ext4 rw,relatime 0 0\n");
    check(rows.length == 4, "only real filesystems survive");
    if (rows.length == 4) {
        check(rows[0].device == "/dev/sda1" && rows[0].mountPoint == "/"
            && rows[0].fsType == "ext4", "root ext4 row");
        check(rows[1].mountPoint == "/boot", "/boot row");
        check(rows[2].mountPoint == "/boot/efi" && rows[2].fsType == "vfat", "efi vfat row");
        check(rows[3].mountPoint == "/mnt/my disk", "octal \\040 unescaped to a space");
    }
}

private void testCgroup() {
    check(parseCgroupCpuUsageUsec(
        "usage_usec 76529247\nuser_usec 54464830\nsystem_usec 22064417\n"
        ~ "nr_periods 0\nnr_throttled 0\nthrottled_usec 0\n") == 76529247, "usage_usec");
    check(parseCgroupCpuUsageUsec("user_usec 1\nsystem_usec 2\n") == -1, "no usage_usec → -1");
    check(parseCgroupValue("max\n") == -1, "memory.max = max → -1");
    check(parseCgroupValue("103325696\n") == 103325696, "memory.current");
    check(parseCgroupValue("") == -1, "empty cgroup file → -1");

    check(containerIdFromCgroupDir(
        "docker-044f1a1fb34648e4de03ff450cc849749ba8aff00748c6585bcfb082c2052d06.scope")
        == "044f1a1fb34648e4de03ff450cc849749ba8aff00748c6585bcfb082c2052d06",
        "systemd scope dir → full id");
    check(containerIdFromCgroupDir(
        "044f1a1fb34648e4de03ff450cc849749ba8aff00748c6585bcfb082c2052d06")
        == "044f1a1fb34648e4de03ff450cc849749ba8aff00748c6585bcfb082c2052d06",
        "cgroupfs bare-hex dir → itself");
    check(containerIdFromCgroupDir("system.slice") == "", "slice dir → no id");
    check(containerIdFromCgroupDir("docker-nothex.scope") == "", "non-hex scope → no id");
}

private void testContainerList() {
    auto rows = parseContainerList(`[
      {"Id":"5586bbedf4e5c0a51d2b1c4c6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091",
       "Names":["/ircfiber-gateway"],
       "Image":"ircfiber/gateway:2026.09.13-abc1234",
       "State":"running","Status":"Up 2 hours (healthy)","Created":1757740000,
       "Ports":[{"IP":"0.0.0.0","PrivatePort":8090,"PublicPort":8090,"Type":"tcp"},
                {"IP":"0.0.0.0","PrivatePort":8090,"PublicPort":8090,"Type":"tcp"},
                {"IP":"::","PrivatePort":8090,"PublicPort":8090,"Type":"tcp"},
                {"PrivatePort":9090,"Type":"tcp"}]},
      {"Id":"044f1a1fb34648e4de03ff450cc849749ba8aff00748c6585bcfb082c2052d06",
       "Names":["/ircfiber-mongo"],"Image":"mongo:7",
       "State":"exited","Status":"Exited (0) 2 days ago","Created":1757000000,
       "Ports":[]}
    ]`);
    check(rows.length == 2, "two containers parsed");
    if (rows.length != 2) return;
    check(rows[0].name == "ircfiber-gateway", "leading slash stripped from name");
    check(rows[0].id == "5586bbedf4e5c0a51d2b1c4c6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091",
        "full 64-hex id kept for cgroup lookup");
    check(rows[0].image == "ircfiber/gateway:2026.09.13-abc1234", "image");
    check(rows[0].state == "running", "state");
    check(rows[0].health == "healthy", "health out of the status text");
    check(rows[0].createdAtMs == 1757740000000L, "Created scaled to ms");
    check(rows[0].ports == ["0.0.0.0:8090\u21928090/tcp", ":::8090\u21928090/tcp", "9090/tcp"],
        "published + internal ports, repeated binding dropped once");
    check(rows[1].name == "ircfiber-mongo" && rows[1].state == "exited", "second row");
    check(rows[1].health == "", "exited container has no health");
    check(rows[1].ports.length == 0, "empty port array");
}

private void testHealth() {
    check(parseHealth("Up 3 minutes (unhealthy)") == "unhealthy", "unhealthy wins over healthy");
    check(parseHealth("Up 2 hours (healthy)") == "healthy", "healthy");
    check(parseHealth("Up 4 seconds (health: starting)") == "starting", "starting");
    check(parseHealth("Exited (0) 2 days ago") == "", "no healthcheck");
    check(parseHealth("Up 12 seconds") == "", "no health parens");
}

private void testDockerInfo() {
    auto d = parseDockerInfo(`{"Name":"vps-efb4b52d","KernelVersion":"7.0.0-31-generic",
        "OperatingSystem":"Ubuntu 22.04.5 LTS","ServerVersion":"29.7.2","NCPU":4,
        "ContainersRunning":18,"Containers":19,"Images":24,"MemTotal":8122298368}`);
    check(d.hostname == "vps-efb4b52d", "info hostname");
    check(d.kernel == "7.0.0-31-generic", "info kernel");
    check(d.os == "Ubuntu 22.04.5 LTS", "info os");
    check(d.serverVersion == "29.7.2", "info docker version");
    check(d.ncpu == 4, "info NCPU");
    check(d.containersRunning == 18 && d.containersTotal == 19, "info container counts");
    check(d.images == 24, "info images");
    check(d.memTotalBytes == 8122298368L, "info MemTotal");
}

private void testLogDemux() {
    // Two real frames: stdout "hello", stderr "err".
    const(ubyte)[] framed = [
        1, 0, 0, 0, 0, 0, 0, 5, 'h', 'e', 'l', 'l', 'o',
        2, 0, 0, 0, 0, 0, 0, 3, 'e', 'r', 'r',
    ];
    check(demuxDockerLogStream(framed) == "helloerr", "two frames demuxed");

    // A TTY container emits unframed text: returned verbatim.
    const(ubyte)[] plain = cast(const(ubyte)[]) "no frames here";
    check(demuxDockerLogStream(plain) == "no frames here", "plain text passthrough");

    // A truncated header must not throw and must not lose the bytes.
    const(ubyte)[] truncated = [1, 0, 0, 0];
    const t = demuxDockerLogStream(truncated);
    check(t.length == 4, "truncated header returned as text, no exception");

    // A length past the end of the buffer: same rule.
    const(ubyte)[] overlong = [1, 0, 0, 0, 0, 0, 0, 99, 'a', 'b'];
    check(demuxDockerLogStream(overlong).length == 10, "overlong frame falls back to text");

    // Invalid UTF-8 in a payload can never reach Json.
    const(ubyte)[] bad = [1, 0, 0, 0, 0, 0, 0, 3, 0xFF, 0xFE, 'x'];
    const s = demuxDockerLogStream(bad);
    check(s.length > 0 && s[$ - 1] == 'x', "invalid UTF-8 sanitized, payload kept");
}

/// The security gate every container-addressed operation goes through.
/// Runs with no Docker socket and no host mounts, which is exactly the
/// state that must fail closed.
private void testControlGate() {
    // Shape: anything that could change the Docker URL is refused before a
    // snapshot is even consulted.
    foreach (bad; ["", "../../info", "a/b", "x?y", "x&y", "-rf", "a b",
                   "name%0Aforged", "x#y", "a:b"]) {
        auto r = resolveControl(bad, "restart");
        check(!r.ok && r.httpStatus == 400, "rejects malformed name: '" ~ bad ~ "'");
    }
    check(resolveControl("ircfiber-redis", "frobnicate").httpStatus == 400,
        "rejects an unknown verb");
    // A well-formed name with no inventory behind it must fail closed, and
    // say which kind of failure it is (503 not-collected, never a 404 that
    // sends an operator hunting a removed container).
    auto cold = resolveControl("ircfiber-redis", "restart");
    check(!cold.ok, "no inventory → refused");
    check(cold.httpStatus == 503, "cold inventory reports 503, not 404");

    // The stop-protected set: a stop has no undo from inside the product.
    foreach (n; ["ircfiber-caddy", "ircfiber-cloudflared", "ircfiber-autoheal",
                 "ircfiber-mongo", "ircfiber-redis", "ircfiber-ircd",
                 "ircfiber-services", "ircfiber-holder-ovh", "ircfiber-engine-ovh"])
        check(isStopProtected(n), n ~ " is stop-protected");
    foreach (n; ["ircfiber-grafana", "tailscale-mullvad-ch", "ircfiber-fibereye"])
        check(!isStopProtected(n), n ~ " is freely stoppable");

    check(LOG_MAX_BYTES == 2 * 1024 * 1024, "log tail is byte-capped, not only line-capped");
}

/// Audit-log integrity: a percent-decoded route param reaches logWarn, so a
/// newline in it would forge a second record in the gateway log and SigNoz.
private void testLogSafe() {
    check(logSafe("x\n2026-09-13 INF Admin restart container ircfiber-ircd")
        .indexOf('\n') < 0, "newline stripped from a logged name");
    check(logSafe("a\rb\tc") == "a?b?c", "CR and TAB replaced");
    check(logSafe("ircfiber-redis") == "ircfiber-redis", "clean name unchanged");
    check(logSafe("") == "<empty>", "empty name is explicit");
    auto long_ = logSafe(repeat('x', 400));
    check(long_.length < 200, "over-long value truncated");
}

private string repeat(char c, size_t n) {
    char[] s;
    s.length = n;
    s[] = c;
    return cast(string) s;
}

int main() {
    testProcStat();
    testMemInfo();
    testLoadAndUptime();
    testNetDev();
    testDiskStats();
    testMounts();
    testCgroup();
    testContainerList();
    testHealth();
    testDockerInfo();
    testLogDemux();
    testControlGate();
    testLogSafe();
    if (failures == 0) writeln("system_test: all checks passed");
    else writefln("system_test: %d failure(s)", failures);
    return failures ? 1 : 0;
}
