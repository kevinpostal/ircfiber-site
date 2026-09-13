module ircfiber.sysmetrics;

/// Host telemetry + Docker control for the admin System page.
///
/// Everything the page shows is collected in-process by the gateway from
/// three read-only mounts of the host (`/host/proc`, `/host/sys`,
/// `/host/root`) plus the Docker Engine API over `/var/run/docker.sock`.
/// Those mounts only exist on the admin-serving replicas — see
/// `site/deploy/roles/gateway/tasks/container.yml` (`_gateway_spec_volumes_admin`).
/// Without them `sysSnapshot()` publishes `available == false` and a reason,
/// which is the macOS-dev and k8s path.
///
/// Structure copies `ircfiber.egress`: a `__gshared` snapshot behind a
/// `Mutex` created in `shared static this()`, refreshed by one lazily
/// started daemon thread. Nothing here touches the vibe event loop, so it
/// deliberately uses `std.json` (not `vibe.data.json`), `std.process` and
/// plain file reads — the same rule `egress.d` documents for its SOCKS
/// probe. `ircfiber.web.admin.system` owns the vibe `Json` conversion.
///
/// Per-container CPU/memory come from cgroup v2 (`cgroup2fs`, systemd
/// driver on prod): `/sys/fs/cgroup/system.slice/docker-<64hex>.scope/`.
/// A host without the unified hierarchy publishes `statsSource == "none"`
/// and per-container stats stay absent; the rest keeps working.

import core.sync.mutex : Mutex;
import core.thread : Thread;
import core.time : msecs;
import std.array : appender, split;
import std.conv : to;
import std.datetime : Clock;
import std.json : JSONType, JSONValue, parseJSON;
import std.string : endsWith, indexOf, splitLines, startsWith, strip, toLower;

/// Read-only mount of the host's `/proc` (host netns counters live in
/// `/host/proc/1/net/dev` — the container's own `/proc/net/dev` only sees
/// `lo` + `eth0`).
enum HOST_PROC = "/host/proc";
/// Read-only mount of the host's `/sys` (cgroup v2 + `/sys/block`).
enum HOST_SYS = "/host/sys";
/// Read-only mount of the host's `/` so `statvfs` can size real filesystems.
enum HOST_ROOT = "/host/root";
/// Docker Engine socket. `srw-rw---- root:docker`; the gateway runs as uid 0.
enum DOCKER_SOCK = "/var/run/docker.sock";
/// Pinned Docker API version segment. Prod serves 1.55; 1.44 is the floor
/// this code needs. Raise this one constant if a daemon ever rejects it.
enum DOCKER_API = "v1.44";
/// Collector period. The page polls on the shared 5 s admin interval too.
enum SAMPLE_INTERVAL_MS = 5_000;
/// Ring capacity — 60 × 5 s = the last 5 minutes. In-memory only: it resets
/// on every blue/green swap, long-range history is SigNoz's job.
enum HISTORY_POINTS = 60;

// ────────────────────────────────────────────────────────────────────
// Pure parsers. Every one takes the file's text (never a path) so the
// unit tests in tests/system_test.d drive them from real prod captures.
// ────────────────────────────────────────────────────────────────────

/// Aggregate jiffies from `/proc/stat`'s `cpu ` line.
struct CpuTimes {
    long user, nice, system, idle, iowait, irq, softirq, steal;

    long total() const {
        return user + nice + system + idle + iowait + irq + softirq + steal;
    }

    /// Everything that is not idle or waiting on I/O.
    long busy() const {
        return total() - idle - iowait;
    }
}

/// First `cpu ` line of `/proc/stat` (the all-core aggregate). Missing
/// trailing fields read as 0, so a shorter kernel line still parses.
CpuTimes parseProcStat(string text) {
    CpuTimes t;
    foreach (line; text.splitLines()) {
        if (!line.startsWith("cpu ")) continue;
        auto f = line.split();
        long fld(size_t i) { return f.length > i ? toLongSafe(f[i]) : 0L; }
        t.user    = fld(1);
        t.nice    = fld(2);
        t.system  = fld(3);
        t.idle    = fld(4);
        t.iowait  = fld(5);
        t.irq     = fld(6);
        t.softirq = fld(7);
        t.steal   = fld(8);
        break;
    }
    return t;
}

/// Host CPU count from the per-core `cpu0`, `cpu1`, … lines of
/// `/proc/stat`. Read from the kernel rather than Docker's `/info` NCPU so
/// load-per-CPU and per-container CPU% still work when the socket is down.
int parseCpuCount(string text) {
    int n;
    foreach (line; text.splitLines()) {
        if (!line.startsWith("cpu")) continue;
        if (line.length < 4) continue;
        const c = line[3];
        if (c >= '0' && c <= '9') n++;
    }
    return n;
}

/// The `/proc/meminfo` keys an operator acts on. Values stay in kB exactly
/// as the kernel reports them; the collector scales to bytes.
struct MemInfo {
    long totalKb, freeKb, availableKb, buffersKb, cachedKb, swapTotalKb, swapFreeKb;
}

MemInfo parseMemInfo(string text) {
    MemInfo m;
    foreach (line; text.splitLines()) {
        const c = line.indexOf(':');
        if (c <= 0) continue;
        const key = line[0 .. c];
        auto rest = line[c + 1 .. $].split();
        if (rest.length == 0) continue;
        const v = toLongSafe(rest[0]);
        switch (key) {
            case "MemTotal":     m.totalKb     = v; break;
            case "MemFree":      m.freeKb      = v; break;
            case "MemAvailable": m.availableKb = v; break;
            case "Buffers":      m.buffersKb   = v; break;
            case "Cached":       m.cachedKb    = v; break;
            case "SwapTotal":    m.swapTotalKb = v; break;
            case "SwapFree":     m.swapFreeKb  = v; break;
            default: break;
        }
    }
    return m;
}

/// `/proc/loadavg`, including the `runnable/total` process field.
struct LoadAvg {
    double one, five, fifteen;
    long procsRunnable, procsTotal;
}

LoadAvg parseLoadAvg(string text) {
    LoadAvg l;
    auto f = text.split();
    if (f.length > 0) l.one     = toDoubleSafe(f[0]);
    if (f.length > 1) l.five    = toDoubleSafe(f[1]);
    if (f.length > 2) l.fifteen = toDoubleSafe(f[2]);
    if (f.length > 3) {
        const slash = f[3].indexOf('/');
        if (slash > 0) {
            l.procsRunnable = toLongSafe(f[3][0 .. slash]);
            l.procsTotal    = toLongSafe(f[3][slash + 1 .. $]);
        }
    }
    return l;
}

/// First field of `/proc/uptime` — seconds since boot, with centiseconds.
double parseUptimeSeconds(string text) {
    auto f = text.split();
    return f.length > 0 ? toDoubleSafe(f[0]) : 0.0;
}

/// One interface row of `/proc/net/dev`.
struct NetDev {
    string name;
    long rxBytes, rxPackets, rxErrs, rxDrop;
    long txBytes, txPackets, txErrs, txDrop;
}

/// Physical interfaces from `/proc/net/dev`. Loopback and the docker
/// bridge/veth zoo are dropped: their throughput is container-to-container
/// traffic already counted on the real NIC. The two header lines carry no
/// `:` so they fall out of the colon split on their own.
NetDev[] parseNetDev(string text) {
    NetDev[] rows;
    foreach (line; text.splitLines()) {
        const c = line.indexOf(':');
        if (c <= 0) continue;
        const name = line[0 .. c].strip();
        if (name.length == 0 || name.indexOf('|') >= 0) continue;
        if (name == "lo" || name.startsWith("veth") || name.startsWith("br-")
            || name.startsWith("docker")) continue;
        auto f = line[c + 1 .. $].split();
        // rx: bytes packets errs drop fifo frame compressed multicast
        // tx: bytes packets errs drop …
        if (f.length < 12) continue;
        NetDev d;
        d.name      = name;
        d.rxBytes   = toLongSafe(f[0]);
        d.rxPackets = toLongSafe(f[1]);
        d.rxErrs    = toLongSafe(f[2]);
        d.rxDrop    = toLongSafe(f[3]);
        d.txBytes   = toLongSafe(f[8]);
        d.txPackets = toLongSafe(f[9]);
        d.txErrs    = toLongSafe(f[10]);
        d.txDrop    = toLongSafe(f[11]);
        rows ~= d;
    }
    return rows;
}

/// One device row of `/proc/diskstats`. Sectors are 512 B.
struct DiskStat {
    string name;
    long readsCompleted, sectorsRead, writesCompleted, sectorsWritten;
}

/// Every row of `/proc/diskstats`; the collector filters to the devices
/// that exist under `/sys/block` (so partitions and loop devices drop out).
DiskStat[] parseDiskStats(string text) {
    DiskStat[] rows;
    foreach (line; text.splitLines()) {
        auto f = line.split();
        if (f.length < 10) continue;
        DiskStat d;
        d.name            = f[2];
        d.readsCompleted  = toLongSafe(f[3]);
        d.sectorsRead     = toLongSafe(f[5]);
        d.writesCompleted = toLongSafe(f[7]);
        d.sectorsWritten  = toLongSafe(f[9]);
        rows ~= d;
    }
    return rows;
}

/// One mount of `/proc/1/mounts` worth sizing.
struct MountEntry {
    string device, mountPoint, fsType;
}

/// Real filesystems only. Everything else on the prod host is an `overlay`
/// under `/var/lib/docker` (one per container layer) or a kernel pseudo-fs,
/// and reporting those as "disks" is noise, not information.
MountEntry[] parseMounts(string text) {
    static immutable string[] keep = [
        "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "f2fs",
    ];
    MountEntry[] rows;
    foreach (line; text.splitLines()) {
        auto f = line.split();
        if (f.length < 3) continue;
        bool wanted;
        foreach (k; keep) if (f[2] == k) { wanted = true; break; }
        if (!wanted) continue;
        MountEntry m;
        m.device     = unescapeMountField(f[0]);
        m.mountPoint = unescapeMountField(f[1]);
        m.fsType     = f[2];
        rows ~= m;
    }
    return rows;
}

/// `usage_usec` from a cgroup v2 `cpu.stat`; `-1` when the key is absent
/// (v1 host, or a container whose scope disappeared mid-read).
long parseCgroupCpuUsageUsec(string cpuStatText) {
    foreach (line; cpuStatText.splitLines()) {
        if (!line.startsWith("usage_usec")) continue;
        auto f = line.split();
        if (f.length > 1) return toLongSafe(f[1]);
    }
    return -1;
}

/// Single-value cgroup file (`memory.current`, `memory.max`,
/// `pids.current`). The literal `max` (no limit set) reads as `-1`.
long parseCgroupValue(string text) {
    const s = text.strip();
    if (s.length == 0) return -1;
    if (s == "max") return -1;
    return toLongSafe(s);
}

/// Container id out of a cgroup directory name: `docker-<64hex>.scope`
/// (systemd driver, what prod uses) or a bare `<64hex>` (cgroupfs driver).
/// Anything else — `system.slice`, `init.scope`, a kubepods slice — is "".
string containerIdFromCgroupDir(string dirName) {
    if (dirName.startsWith("docker-") && dirName.endsWith(".scope")) {
        const mid = dirName["docker-".length .. $ - ".scope".length];
        return isHex64(mid) ? mid : "";
    }
    return isHex64(dirName) ? dirName : "";
}

/// One entry of `GET /containers/json?all=1`.
struct ContainerRow {
    /// Full 64-hex id — the cgroup directory key. The collector shortens
    /// it for display; actions address containers by name.
    string id;
    string name;
    string image;
    string state;
    string status;
    string health;
    long createdAtMs;
    string[] ports;
}

ContainerRow[] parseContainerList(string json) {
    ContainerRow[] rows;
    auto j = parseJSON(json);
    if (j.type != JSONType.array) return rows;
    foreach (e; j.array) {
        if (e.type != JSONType.object) continue;
        ContainerRow r;
        r.id     = jstr(e, "Id");
        r.image  = jstr(e, "Image");
        r.state  = jstr(e, "State");
        r.status = jstr(e, "Status");
        r.health = parseHealth(r.status);
        r.createdAtMs = jlong(e, "Created") * 1000;
        if (auto names = "Names" in e.object) {
            if (names.type == JSONType.array && names.array.length > 0
                && names.array[0].type == JSONType.string) {
                auto n = names.array[0].str;
                r.name = n.startsWith("/") ? n[1 .. $] : n;
            }
        }
        if (auto ports = "Ports" in e.object) r.ports = formatPorts(*ports);
        rows ~= r;
    }
    return rows;
}

/// Health out of the list API's `Status` text ("Up 2 hours (healthy)"):
/// the list endpoint carries no health field of its own, and
/// `/containers/<id>/json` would cost one extra curl per container per
/// refresh. `""` when the container has no healthcheck.
string parseHealth(string status) {
    const s = status.toLower();
    if (s.indexOf("(unhealthy)") >= 0) return "unhealthy";
    if (s.indexOf("(healthy)") >= 0) return "healthy";
    if (s.indexOf("health: starting") >= 0 || s.indexOf("(starting)") >= 0) return "starting";
    return "";
}

/// Published ports as `1.2.3.4:8090→8090/tcp`, or `6667/tcp` when the port
/// is container-internal. Order preserved, duplicates dropped (Docker lists
/// an IPv4 and an IPv6 binding for the same mapping).
string[] formatPorts(JSONValue portsArray) {
    string[] out_;
    if (portsArray.type != JSONType.array) return out_;
    foreach (p; portsArray.array) {
        if (p.type != JSONType.object) continue;
        const priv = jlong(p, "PrivatePort");
        if (priv == 0) continue;
        const pub = jlong(p, "PublicPort");
        auto type = jstr(p, "Type");
        if (type.length == 0) type = "tcp";
        string entry;
        if (pub != 0) {
            const ip = jstr(p, "IP");
            entry = (ip.length ? ip ~ ":" : "") ~ pub.to!string
                ~ "\u2192" ~ priv.to!string ~ "/" ~ type;
        } else {
            entry = priv.to!string ~ "/" ~ type;
        }
        bool dup;
        foreach (e; out_) if (e == entry) { dup = true; break; }
        if (!dup) out_ ~= entry;
    }
    return out_;
}

/// The handful of `GET /info` fields worth one call per minute.
struct DockerInfo {
    string hostname, kernel, os, serverVersion;
    int ncpu;
    long containersRunning, containersTotal, images, memTotalBytes;
}

DockerInfo parseDockerInfo(string json) {
    DockerInfo d;
    auto j = parseJSON(json);
    if (j.type != JSONType.object) return d;
    d.hostname          = jstr(j, "Name");
    d.kernel            = jstr(j, "KernelVersion");
    d.os                = jstr(j, "OperatingSystem");
    d.serverVersion     = jstr(j, "ServerVersion");
    d.ncpu              = cast(int) jlong(j, "NCPU");
    d.containersRunning = jlong(j, "ContainersRunning");
    d.containersTotal   = jlong(j, "Containers");
    d.images            = jlong(j, "Images");
    d.memTotalBytes     = jlong(j, "MemTotal");
    return d;
}

/// Docker's multiplexed log stream: 8-byte header (`[0]` stream type
/// 0/1/2, `[4..8]` big-endian payload length) then payload. A TTY container
/// emits unframed output instead, so an implausible stream byte or a length
/// past the end means "the rest is plain text" rather than a parse error.
/// The result is sanitized: a container can log arbitrary bytes and invalid
/// UTF-8 must never reach `Json`.
string demuxDockerLogStream(const(ubyte)[] raw) {
    import std.encoding : sanitize;
    auto app = appender!string();
    size_t i;
    while (i + 8 <= raw.length) {
        if (raw[i] > 2) break;
        const size_t len = (cast(size_t) raw[i + 4] << 24)
            | (cast(size_t) raw[i + 5] << 16)
            | (cast(size_t) raw[i + 6] << 8)
            | cast(size_t) raw[i + 7];
        if (i + 8 + len > raw.length) break;
        app.put(cast(string) raw[i + 8 .. i + 8 + len].idup);
        i += 8 + len;
    }
    if (i < raw.length) app.put(cast(string) raw[i .. $].idup);
    return sanitize(app.data);
}

// ────────────────────────────────────────────────────────────────────
// Snapshot shape. `ircfiber.web.admin.system.snapshotToJson` mirrors this
// field for field, and so does the frontend's `SystemSnapshot` interface.
// ────────────────────────────────────────────────────────────────────

// Every `double` carries an explicit `= 0`: D's default float init is NaN,
// which vibe serializes as JSON `null` — the page types these as plain
// numbers, and a rate that simply has no previous sample yet is 0, not
// "unknown".
struct HostInfo {
    string hostname, kernel, os, dockerVersion;
    int ncpu;
    double uptimeSeconds = 0;
    long containersRunning, containersTotal, images;
}

struct CpuSample {
    double percent = 0, userPercent = 0, systemPercent = 0, iowaitPercent = 0, stealPercent = 0;
    double load1 = 0, load5 = 0, load15 = 0, load1PerCpu = 0;
    long procsRunnable, procsTotal;
}

struct MemorySample {
    long totalBytes, usedBytes, availableBytes;
    double percent = 0;
    long swapTotalBytes, swapUsedBytes;
    double swapPercent = 0;
}

struct FilesystemSample {
    string device, mountPoint, fsType;
    long totalBytes, usedBytes, freeBytes;
    double percent = 0;
}

struct NetworkSample {
    string name;
    long rxBytes, txBytes;
    double rxBytesPerSec = 0, txBytesPerSec = 0;
    long rxErrors, txErrors, rxDropped, txDropped;
}

struct DiskSample {
    string name;
    double readBytesPerSec = 0, writeBytesPerSec = 0, readsPerSec = 0, writesPerSec = 0;
}

struct ContainerSample {
    /// Short 12-hex id, for display only.
    string id;
    string name, image, state, status, health;
    long createdAtMs;
    string[] ports;
    /// False when no cgroup files resolved: CPU/memory/PIDs publish as null
    /// rather than a misleading zero.
    bool hasStats;
    double cpuPercent = 0;
    long memBytes;
    /// `-1` = cgroup `max`, i.e. no container limit; percent is then
    /// computed against host MemTotal.
    long memLimitBytes = -1;
    double memPercent = 0;
    long pids;
    /// This gateway container — can never be stopped or restarted from here.
    bool self;
    bool controllable;
    /// `stop` is refused server-side (see STOP_PROTECTED) while `restart`
    /// and `start` are allowed. Published so the page disables the same
    /// button the backend refuses.
    bool stopProtected;
    /// Human reason the state buttons are disabled; "" when controllable.
    string controlReason;
}

struct HistoryPoint {
    long atMs;
    double cpuPercent = 0, memPercent = 0, rxBytesPerSec = 0, txBytesPerSec = 0;
}

struct SysSnapshot {
    /// False when the host mounts are missing (macOS dev, k8s) — `reason`
    /// says which mount and where to add it.
    bool available;
    string reason;
    /// Unix ms of this sample; 0 = the collector has not published yet.
    long collectedAtMs;
    /// "cgroup2" when at least one container's cgroup resolved, else "none".
    string statsSource;
    /// Last Docker socket/parse error; host metrics publish regardless.
    string dockerError;
    /// "host" when the counters came from the host netns, "container" when
    /// the `/host/proc/1/net/dev` read fell back to our own namespace.
    string networkSource;
    HostInfo host;
    CpuSample cpu;
    MemorySample memory;
    FilesystemSample[] filesystems;
    NetworkSample[] network;
    DiskSample[] disks;
    ContainerSample[] containers;
    HistoryPoint[] history;
}

/// Outcome of a container state change, with the status the route returns.
struct ActionResult {
    bool ok;
    int httpStatus;
    string message;
}

// ────────────────────────────────────────────────────────────────────
// Collector
// ────────────────────────────────────────────────────────────────────

private __gshared SysSnapshot gSnap;
private __gshared Mutex gSnapLock;
private __gshared bool gCollectorStarted;

shared static this() {
    gSnapLock = new Mutex();
}

/// Current snapshot. Returns a copy immediately and starts the collector on
/// the first call, so — exactly like `egressExits()` — the very first
/// caller sees `collectedAtMs == 0` and the next 5 s poll has data.
SysSnapshot sysSnapshot() {
    SysSnapshot copy;
    bool start;
    synchronized (gSnapLock) {
        copy = gSnap;
        if (!gCollectorStarted) {
            gCollectorStarted = true;
            start = true;
        }
    }
    if (start) {
        try {
            auto t = new Thread(&collectLoop);
            t.isDaemon = true;
            t.start();
        } catch (Exception) {
            synchronized (gSnapLock) gCollectorStarted = false;
        }
    }
    return copy;
}

/// Container state/status for the Mullvad page, which needs exactly these
/// two fields for its sidecars and must not open a second Docker client.
/// Returns false when the container is absent or Docker is unreachable,
/// with the reason in `status`.
bool dockerContainerState(string name, out string state, out string status) {
    auto snap = sysSnapshot();
    foreach (c; snap.containers) {
        if (c.name != name) continue;
        state = c.state;
        status = c.status;
        return true;
    }
    if (snap.collectedAtMs == 0) {
        // First call after a restart: the collector has not published yet.
        // "missing" here would send an operator hunting a removed container.
        state = "unknown";
        status = "inventory not collected yet";
        return false;
    }
    if (snap.dockerError.length > 0) {
        state = "unknown";
        status = "docker unavailable";
        return false;
    }
    state = "missing";
    status = "";
    return false;
}

/// Containers whose `stop` has no undo from inside the product. Docker never
/// restarts a container that was stopped through the API, and with
/// `ircfiber-caddy` or `ircfiber-cloudflared` down the Start button that
/// would fix it is no longer reachable — recovery needs host SSH. Stopping
/// `ircfiber-autoheal` silently disables automated recovery for every
/// container on the box. `restart` and `start` stay available for all of
/// them; only `stop` is refused. Enforced here, server-side: the page's
/// confirmation dialog is a courtesy, not a control.
static immutable string[] STOP_PROTECTED = [
    "ircfiber-caddy", "ircfiber-cloudflared", "ircfiber-autoheal",
    "ircfiber-mongo", "ircfiber-redis", "ircfiber-ircd", "ircfiber-services",
    "ircfiber-holder-ovh", "ircfiber-engine-ovh",
];

/// True when `stop` is refused for this container. Exposed so the snapshot
/// can publish the same reason the enforcement uses.
bool isStopProtected(string name) {
    foreach (p; STOP_PROTECTED) if (p == name) return true;
    return false;
}

/// Strips control characters from a request-supplied value before it reaches
/// a log line, and caps its length. vibe's router percent-decodes route
/// params, so `%0A` arrives as a real newline: without this a caller could
/// forge a second, fabricated audit record in the gateway log and in SigNoz.
string logSafe(string raw) {
    import std.array : appender;
    if (raw.length == 0) return "<empty>";
    auto app = appender!string();
    size_t emitted;
    foreach (char ch; raw) {
        if (emitted >= 128) { app.put("…"); break; }
        app.put(ch < 0x20 || ch == 0x7f ? '?' : ch);
        emitted++;
    }
    return app.data;
}

/// Hard cap on a log tail. `tail` bounds lines, not bytes, and a single line
/// has no length limit — the ircd and the bouncer log connection-time
/// material supplied by unauthenticated IRC users. Without this the response
/// path allocates several multiples of the raw size in one burst.
enum LOG_MAX_BYTES = 2 * 1024 * 1024;

/// Shared authorization for every container-addressed operation — the three
/// action verbs AND the log tail. Every caller goes through this: an
/// operation that skips it is a hole, which is exactly how the log route was
/// ungated in the first cut.
///
/// `verb` is `start`, `stop`, `restart` or `logs`. `ok` means proceed;
/// otherwise `httpStatus`/`message` are ready to serve.
ActionResult resolveControl(string name, string verb) {
    ActionResult r;
    if (!validContainerName(name)) {
        r.httpStatus = 400;
        r.message = "invalid container name";
        return r;
    }
    const bool isLogs = verb == "logs";
    if (!isLogs && verb != "start" && verb != "stop" && verb != "restart") {
        r.httpStatus = 400;
        r.message = "unknown action: " ~ verb;
        return r;
    }
    auto snap = sysSnapshot();
    foreach (c; snap.containers) {
        if (c.name != name) continue;
        // Reading our own log is useful and harmless; changing our own state
        // is never allowed.
        if (c.self && !isLogs) {
            r.httpStatus = 409;
            r.message = "refusing to " ~ verb ~ " this gateway container";
            return r;
        }
        if (!c.controllable && !(isLogs && c.self)) {
            r.httpStatus = 403;
            r.message = "refusing to " ~ verb ~ " " ~ name ~ ": " ~ c.controlReason;
            return r;
        }
        if (verb == "stop" && isStopProtected(name)) {
            r.httpStatus = 409;
            r.message = "refusing to stop " ~ name
                ~ ": a stop has no undo from here (nothing restarts it and the"
                ~ " control path may run through it) — use restart";
            return r;
        }
        r.ok = true;
        r.httpStatus = 200;
        return r;
    }
    // Not in the inventory. Distinguish "not collected yet" from "gone":
    // the first call after a restart always sees an empty snapshot.
    if (snap.collectedAtMs == 0) {
        r.httpStatus = 503;
        r.message = "container inventory not collected yet — retry in a few seconds";
    } else if (snap.dockerError.length > 0) {
        r.httpStatus = 503;
        r.message = "docker socket unavailable: " ~ snap.dockerError;
    } else {
        r.httpStatus = 404;
        r.message = "no such container: " ~ name;
    }
    return r;
}

/// start | stop | restart one container. Runs on a request fiber, so it uses
/// vibe's fiber-aware `execute`: Phobos' would park the whole event-loop
/// thread for the full `--max-time` and stall every other user.
ActionResult containerAction(string name, string action) {
    auto gate = resolveControl(name, action);
    if (!gate.ok) return gate;

    ActionResult r;
    import vibe.core.process : execute, Config;
    string code;
    try {
        // `?t=10` is the stop grace period (ignored by /start).
        auto proc = execute([
            "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
            "--max-time", "20", "-X", "POST", "--unix-socket", DOCKER_SOCK,
            "http://d/" ~ DOCKER_API ~ "/containers/" ~ name ~ "/" ~ action ~ "?t=10",
        ], null, Config.none, 64);
        if (proc.status != 0) {
            r.httpStatus = 503;
            r.message = "docker socket unavailable: curl exit "
                ~ proc.status.to!string ~ " " ~ proc.output.strip();
            return r;
        }
        code = proc.output.strip();
    } catch (Exception e) {
        r.httpStatus = 503;
        r.message = "docker socket unavailable: " ~ e.msg;
        return r;
    }

    switch (code) {
        // 304 = already in that state; the operator got what they asked for.
        case "204": case "304":
            r.ok = true;
            r.httpStatus = 200;
            r.message = action ~ " accepted";
            return r;
        case "404":
            r.httpStatus = 404;
            r.message = "no such container: " ~ name;
            return r;
        case "409":
            r.httpStatus = 409;
            r.message = "docker rejected " ~ action ~ " of " ~ name ~ " (conflict)";
            return r;
        default:
            r.httpStatus = 500;
            r.message = "docker returned HTTP " ~ (code.length ? code : "no status")
                ~ " for " ~ action ~ " of " ~ name;
            return r;
    }
}

/// Outcome of a log tail. A status, not an exception, so a bad name reads as
/// 400 and a dead socket as 503 instead of both arriving as one 503.
struct LogsResult {
    bool ok;
    int httpStatus;
    string message;
    string text;
}

/// Demuxed, sanitized, byte-capped tail of one container's logs. Subject to
/// the same allowlist as the state actions.
LogsResult containerLogs(string name, int tail) {
    LogsResult out_;
    auto gate = resolveControl(name, "logs");
    if (!gate.ok) {
        out_.httpStatus = gate.httpStatus;
        out_.message = gate.message;
        return out_;
    }
    if (tail < 1) tail = 1;
    import vibe.core.process : execute, Config;
    try {
        auto proc = execute([
            "curl", "-s", "--max-time", "10", "--unix-socket", DOCKER_SOCK,
            "http://d/" ~ DOCKER_API ~ "/containers/" ~ name
                ~ "/logs?stdout=1&stderr=1&timestamps=1&tail=" ~ tail.to!string,
        ], null, Config.none, LOG_MAX_BYTES);
        if (proc.status != 0) {
            out_.httpStatus = 503;
            out_.message = "docker socket unavailable: curl exit " ~ proc.status.to!string;
            return out_;
        }
        out_.text = demuxDockerLogStream(cast(const(ubyte)[]) proc.output);
        if (proc.output.length >= LOG_MAX_BYTES)
            out_.text ~= "\n… [truncated at " ~ (LOG_MAX_BYTES / 1024).to!string ~ " KiB]";
        out_.ok = true;
        out_.httpStatus = 200;
        return out_;
    } catch (Exception e) {
        out_.httpStatus = 503;
        out_.message = "docker socket unavailable: " ~ e.msg;
        return out_;
    }
}

// Collector-thread state. Thread-local by default in D, and only the
// collector thread ever touches it, so the rate maths needs no lock.
private struct RawSample {
    long atMs;
    CpuTimes cpu;
    NetDev[] net;
    DiskStat[] disks;
    long[string] containerCpuUsec;
}

private RawSample gPrev;
private DockerInfo gInfo;
private long gInfoAtMs;
private HistoryPoint[HISTORY_POINTS] gRing;
private size_t gRingCount;
private size_t gRingNext;

private void collectLoop() {
    for (;;) {
        try {
            collectOnce();
        } catch (Exception) {
            // A transient read failure must never kill the collector; the
            // next pass republishes, and per-section failures are already
            // caught below.
        }
        Thread.sleep(SAMPLE_INTERVAL_MS.msecs);
    }
}

private void collectOnce() {
    const long now = nowMs();
    SysSnapshot snap;
    snap.collectedAtMs = now;
    snap.statsSource = "none";

    string statText;
    try {
        statText = readAllText(HOST_PROC ~ "/stat");
    } catch (Exception e) {
        snap.reason = "host /proc is not mounted into this container "
            ~ "(see site/deploy/roles/gateway/tasks/container.yml): " ~ e.msg;
        publish(snap);
        return;
    }
    snap.available = true;

    RawSample cur;
    cur.atMs = now;
    cur.cpu = parseProcStat(statText);
    const bool hasPrev = gPrev.atMs > 0 && now > gPrev.atMs;
    const double dtSec = hasPrev ? (now - gPrev.atMs) / 1000.0 : 0.0;

    int ncpu = parseCpuCount(statText);

    // CPU — percentages against the jiffy delta, zero on the first sample.
    if (hasPrev) {
        const long dTotal = cur.cpu.total() - gPrev.cpu.total();
        if (dTotal > 0) {
            snap.cpu.percent       = pctOf(cur.cpu.busy() - gPrev.cpu.busy(), dTotal);
            snap.cpu.userPercent   = pctOf(cur.cpu.user - gPrev.cpu.user, dTotal);
            snap.cpu.systemPercent = pctOf(cur.cpu.system - gPrev.cpu.system, dTotal);
            snap.cpu.iowaitPercent = pctOf(cur.cpu.iowait - gPrev.cpu.iowait, dTotal);
            snap.cpu.stealPercent  = pctOf(cur.cpu.steal - gPrev.cpu.steal, dTotal);
        }
    }

    try {
        auto mi = parseMemInfo(readAllText(HOST_PROC ~ "/meminfo"));
        snap.memory.totalBytes     = mi.totalKb * 1024;
        snap.memory.availableBytes = mi.availableKb * 1024;
        // Excludes page cache — the number an operator acts on.
        snap.memory.usedBytes      = (mi.totalKb - mi.availableKb) * 1024;
        snap.memory.percent        = pctOf(snap.memory.usedBytes, snap.memory.totalBytes);
        snap.memory.swapTotalBytes = mi.swapTotalKb * 1024;
        snap.memory.swapUsedBytes  = (mi.swapTotalKb - mi.swapFreeKb) * 1024;
        snap.memory.swapPercent    = pctOf(snap.memory.swapUsedBytes, snap.memory.swapTotalBytes);
    } catch (Exception) {}

    try {
        auto la = parseLoadAvg(readAllText(HOST_PROC ~ "/loadavg"));
        snap.cpu.load1         = la.one;
        snap.cpu.load5         = la.five;
        snap.cpu.load15        = la.fifteen;
        snap.cpu.procsRunnable = la.procsRunnable;
        snap.cpu.procsTotal    = la.procsTotal;
    } catch (Exception) {}

    try {
        snap.host.uptimeSeconds = parseUptimeSeconds(readAllText(HOST_PROC ~ "/uptime"));
    } catch (Exception) {}

    // Network — the host netns, not ours. Our own /proc/net/dev only has
    // `lo` + `eth0`, so a fallback read is flagged as such in the payload.
    try {
        string netText;
        try {
            netText = readAllText(HOST_PROC ~ "/1/net/dev");
            snap.networkSource = "host";
        } catch (Exception) {
            netText = readAllText("/proc/net/dev");
            snap.networkSource = "container";
        }
        cur.net = parseNetDev(netText);
        foreach (nd; cur.net) {
            NetworkSample ns;
            ns.name      = nd.name;
            ns.rxBytes   = nd.rxBytes;
            ns.txBytes   = nd.txBytes;
            ns.rxErrors  = nd.rxErrs;
            ns.txErrors  = nd.txErrs;
            ns.rxDropped = nd.rxDrop;
            ns.txDropped = nd.txDrop;
            if (dtSec > 0) {
                foreach (p; gPrev.net) {
                    if (p.name != nd.name) continue;
                    ns.rxBytesPerSec = rate(nd.rxBytes - p.rxBytes, dtSec);
                    ns.txBytesPerSec = rate(nd.txBytes - p.txBytes, dtSec);
                    break;
                }
            }
            snap.network ~= ns;
        }
    } catch (Exception) {}

    // Disk I/O — whole devices only (a row with no /sys/block entry is a
    // partition; loop/ram devices are noise).
    try {
        cur.disks = parseDiskStats(readAllText(HOST_PROC ~ "/diskstats"));
        foreach (ds; cur.disks) {
            if (ds.name.startsWith("loop") || ds.name.startsWith("ram")) continue;
            if (!isDirSafe(HOST_SYS ~ "/block/" ~ ds.name)) continue;
            DiskSample d;
            d.name = ds.name;
            if (dtSec > 0) {
                foreach (p; gPrev.disks) {
                    if (p.name != ds.name) continue;
                    d.readBytesPerSec  = rate((ds.sectorsRead - p.sectorsRead) * 512, dtSec);
                    d.writeBytesPerSec = rate((ds.sectorsWritten - p.sectorsWritten) * 512, dtSec);
                    d.readsPerSec      = rate(ds.readsCompleted - p.readsCompleted, dtSec);
                    d.writesPerSec     = rate(ds.writesCompleted - p.writesCompleted, dtSec);
                    break;
                }
            }
            snap.disks ~= d;
        }
    } catch (Exception) {}

    snap.filesystems = collectFilesystems();

    // Docker: container list every pass, /info at most once a minute.
    string listBody;
    try {
        import std.process : execute;
        auto proc = execute([
            "curl", "-s", "--max-time", "5", "--unix-socket", DOCKER_SOCK,
            // Never `size=1`: it makes the daemon walk every layer.
            "http://d/" ~ DOCKER_API ~ "/containers/json?all=1",
        ]);
        if (proc.status != 0)
            snap.dockerError = "curl exit " ~ proc.status.to!string
                ~ " on " ~ DOCKER_SOCK ~ ": " ~ proc.output.strip();
        else
            listBody = proc.output;
    } catch (Exception e) {
        snap.dockerError = e.msg;
    }

    if (gInfo.serverVersion.length == 0 || now - gInfoAtMs > 60_000) {
        try {
            import std.process : execute;
            auto proc = execute([
                "curl", "-s", "--max-time", "5", "--unix-socket", DOCKER_SOCK,
                "http://d/" ~ DOCKER_API ~ "/info",
            ]);
            if (proc.status == 0 && proc.output.strip().length > 2) {
                gInfo = parseDockerInfo(proc.output);
                gInfoAtMs = now;
            }
        } catch (Exception) {}
    }
    snap.host.hostname      = gInfo.hostname;
    snap.host.kernel        = gInfo.kernel;
    snap.host.os            = gInfo.os;
    snap.host.dockerVersion = gInfo.serverVersion;
    snap.host.images        = gInfo.images;
    if (ncpu == 0) ncpu = gInfo.ncpu;
    snap.host.ncpu = ncpu;
    if (ncpu > 0) snap.cpu.load1PerCpu = snap.cpu.load1 / ncpu;

    if (listBody.strip().length > 0) {
        ContainerRow[] rows;
        try {
            rows = parseContainerList(listBody);
        } catch (Exception e) {
            snap.dockerError = "unparseable container list: " ~ e.msg;
        }
        auto cgroups = scanCgroupDirs();
        const selfId = readSelfContainerId();
        bool anyStats;
        foreach (row; rows) {
            ContainerSample cs;
            cs.id           = row.id.length > 12 ? row.id[0 .. 12] : row.id;
            cs.name         = row.name;
            cs.image        = row.image;
            cs.state        = row.state;
            cs.status       = row.status;
            cs.health       = row.health;
            cs.createdAtMs  = row.createdAtMs;
            cs.ports        = row.ports;

            // Both tests, so a future explicit `hostname:` in the container
            // spec cannot unprotect the gateway.
            cs.self = (selfId.length >= 8 && row.id.startsWith(selfId))
                || row.name == "ircfiber-gateway" || row.name == "ircfiber-gateway-green";
            if (cs.self) {
                cs.controlReason = "this gateway container";
            } else if (!row.name.startsWith("ircfiber-") && !row.name.startsWith("tailscale-mullvad-")) {
                cs.controlReason = "name outside the ircfiber-/tailscale-mullvad- allowlist";
            } else {
                cs.controllable = true;
                cs.stopProtected = isStopProtected(row.name);
            }

            if (row.state == "running") {
                if (auto dir = row.id in cgroups) {
                    long usec = -1, memCur = -1, memMax = -1, pids = -1;
                    try usec   = parseCgroupCpuUsageUsec(readAllText(*dir ~ "/cpu.stat"));
                    catch (Exception) {}
                    try memCur = parseCgroupValue(readAllText(*dir ~ "/memory.current"));
                    catch (Exception) {}
                    try memMax = parseCgroupValue(readAllText(*dir ~ "/memory.max"));
                    catch (Exception) {}
                    try pids   = parseCgroupValue(readAllText(*dir ~ "/pids.current"));
                    catch (Exception) {}

                    if (usec >= 0) {
                        cur.containerCpuUsec[row.id] = usec;
                        if (auto prevUsec = row.id in gPrev.containerCpuUsec) {
                            // Percent of total host CPU capacity (0-100),
                            // not per-core: 200% on a 4-vCPU box is wrong.
                            if (dtSec > 0 && ncpu > 0 && usec >= *prevUsec)
                                cs.cpuPercent = (usec - *prevUsec)
                                    / (dtSec * 1_000_000.0 * ncpu) * 100.0;
                        }
                    }
                    if (memCur >= 0) {
                        cs.memBytes      = memCur;
                        cs.memLimitBytes = memMax;
                        const long base = memMax > 0 ? memMax : snap.memory.totalBytes;
                        cs.memPercent = pctOf(memCur, base);
                    }
                    if (pids >= 0) cs.pids = pids;
                    cs.hasStats = usec >= 0 || memCur >= 0;
                    if (cs.hasStats) anyStats = true;
                }
            }
            if (cs.state == "running") snap.host.containersRunning++;
            snap.host.containersTotal++;
            snap.containers ~= cs;
        }
        if (anyStats) snap.statsSource = "cgroup2";
    }

    // History — skipped on the very first pass, whose rates are all zero
    // and would draw a phantom trough for the next 5 minutes.
    if (hasPrev) {
        HistoryPoint hp;
        hp.atMs       = now;
        hp.cpuPercent = snap.cpu.percent;
        hp.memPercent = snap.memory.percent;
        foreach (ns; snap.network) {
            hp.rxBytesPerSec += ns.rxBytesPerSec;
            hp.txBytesPerSec += ns.txBytesPerSec;
        }
        ringPush(hp);
    }
    snap.history = ringOrdered();

    gPrev = cur;
    publish(snap);
}

private FilesystemSample[] collectFilesystems() {
    FilesystemSample[] rows;
    version (Posix) {
        import core.sys.posix.sys.statvfs : statvfs, statvfs_t;
        import std.string : toStringz;
        MountEntry[] mounts;
        try {
            mounts = parseMounts(readAllText(HOST_PROC ~ "/1/mounts"));
        } catch (Exception) {
            return rows;
        }
        foreach (m; mounts) {
            bool seen;
            foreach (r; rows) if (r.mountPoint == m.mountPoint) { seen = true; break; }
            if (seen) continue;
            const path = m.mountPoint == "/" ? HOST_ROOT : HOST_ROOT ~ m.mountPoint;
            statvfs_t st;
            // A row whose statvfs fails is skipped, never reported as zero.
            if (statvfs(path.toStringz, &st) != 0) continue;
            const long frsize = cast(long) st.f_frsize;
            if (frsize <= 0) continue;
            FilesystemSample fs;
            fs.device     = m.device;
            fs.mountPoint = m.mountPoint;
            fs.fsType     = m.fsType;
            fs.totalBytes = cast(long) st.f_blocks * frsize;
            fs.freeBytes  = cast(long) st.f_bavail * frsize;
            fs.usedBytes  = (cast(long) st.f_blocks - cast(long) st.f_bfree) * frsize;
            fs.percent    = pctOf(fs.usedBytes, fs.totalBytes);
            rows ~= fs;
        }
    }
    return rows;
}

/// fullId → cgroup directory, for both cgroup drivers. Scanned once per
/// refresh: the per-container files are then plain reads.
private string[string] scanCgroupDirs() {
    import std.file : dirEntries, SpanMode, DirEntry;
    import std.path : baseName;
    string[string] map;
    static immutable string[] roots = [
        HOST_SYS ~ "/fs/cgroup/system.slice",  // systemd driver (prod)
        HOST_SYS ~ "/fs/cgroup/docker",        // cgroupfs driver
    ];
    foreach (root; roots) {
        try {
            foreach (DirEntry e; dirEntries(root, SpanMode.shallow)) {
                if (!e.isDir) continue;
                const id = containerIdFromCgroupDir(baseName(e.name));
                if (id.length > 0) map[id] = e.name;
            }
        } catch (Exception) {}
    }
    return map;
}

/// Our own container id. `/etc/hostname` is the short id unless the spec
/// sets an explicit `hostname:`; the name match in `collectOnce` covers
/// that case.
private string readSelfContainerId() {
    try {
        return readAllText("/etc/hostname").strip();
    } catch (Exception) {
        return "";
    }
}

private void publish(SysSnapshot snap) {
    synchronized (gSnapLock) gSnap = snap;
}

private void ringPush(HistoryPoint hp) {
    gRing[gRingNext] = hp;
    gRingNext = (gRingNext + 1) % HISTORY_POINTS;
    if (gRingCount < HISTORY_POINTS) gRingCount++;
}

private HistoryPoint[] ringOrdered() {
    auto out_ = new HistoryPoint[gRingCount];
    const size_t start = (gRingNext + HISTORY_POINTS - gRingCount) % HISTORY_POINTS;
    foreach (i; 0 .. gRingCount)
        out_[i] = gRing[(start + i) % HISTORY_POINTS];
    return out_;
}

// ────────────────────────────────────────────────────────────────────
// Small shared helpers
// ────────────────────────────────────────────────────────────────────

/// Reads a whole file in chunks. `/proc` files report size 0, so this never
/// trusts a stat-based length.
private string readAllText(string path) {
    import std.stdio : File;
    auto f = File(path, "rb");
    scope (exit) f.close();
    auto app = appender!(char[])();
    ubyte[8192] buf;
    for (;;) {
        auto chunk = f.rawRead(buf[]);
        if (chunk.length == 0) break;
        app.put(cast(char[]) chunk);
    }
    return cast(string) app.data;
}

private bool isDirSafe(string path) {
    import std.file : exists, isDir;
    try return exists(path) && isDir(path);
    catch (Exception) return false;
}

/// Docker names are `[A-Za-z0-9][A-Za-z0-9_.-]*`. Enforced before the name
/// reaches a URL path segment.
private bool validContainerName(string name) {
    if (name.length == 0 || name.length > 128) return false;
    foreach (i, ch; name) {
        const bool alnum = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
            || (ch >= '0' && ch <= '9');
        if (alnum) continue;
        if (i > 0 && (ch == '_' || ch == '.' || ch == '-')) continue;
        return false;
    }
    return true;
}

private bool isHex64(string s) {
    if (s.length != 64) return false;
    foreach (ch; s) {
        const bool hex = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')
            || (ch >= 'A' && ch <= 'F');
        if (!hex) return false;
    }
    return true;
}

/// `/proc/*/mounts` octal-escapes space, tab, newline and backslash.
private string unescapeMountField(string s) {
    if (s.indexOf('\\') < 0) return s;
    auto app = appender!string();
    for (size_t i = 0; i < s.length;) {
        if (s[i] == '\\' && i + 3 < s.length
            && s[i + 1] >= '0' && s[i + 1] <= '7'
            && s[i + 2] >= '0' && s[i + 2] <= '7'
            && s[i + 3] >= '0' && s[i + 3] <= '7') {
            app.put(cast(char) ((s[i + 1] - '0') * 64 + (s[i + 2] - '0') * 8 + (s[i + 3] - '0')));
            i += 4;
        } else {
            app.put(s[i]);
            i++;
        }
    }
    return app.data;
}

private long toLongSafe(string s) {
    try return s.strip().to!long;
    catch (Exception) return 0;
}

private double toDoubleSafe(string s) {
    try return s.strip().to!double;
    catch (Exception) return 0.0;
}

private double pctOf(long part, long whole) {
    if (whole <= 0) return 0.0;
    const double p = (cast(double) part / cast(double) whole) * 100.0;
    return p < 0 ? 0.0 : p;
}

/// Per-second rate, clamped at 0: a counter reset (container restart,
/// 32-bit wrap) must not publish a negative throughput.
private double rate(long delta, double dtSec) {
    if (dtSec <= 0 || delta < 0) return 0.0;
    return delta / dtSec;
}

private long nowMs() {
    return Clock.currTime.toUnixTime!long * 1000;
}

private string jstr(JSONValue j, string key) {
    if (j.type != JSONType.object) return "";
    if (auto p = key in j.object)
        if (p.type == JSONType.string) return p.str;
    return "";
}

private long jlong(JSONValue j, string key) {
    if (j.type != JSONType.object) return 0;
    if (auto p = key in j.object) {
        switch (p.type) {
            case JSONType.integer:  return p.integer;
            case JSONType.uinteger: return cast(long) p.uinteger;
            case JSONType.float_:   return cast(long) p.floating;
            case JSONType.string:   return toLongSafe(p.str);
            default: return 0;
        }
    }
    return 0;
}
