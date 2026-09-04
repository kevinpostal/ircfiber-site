module ircfiber.egress;

/// Mullvad SOCKS egress pool as the gateway sees it (`IRCFIBER_MULLVAD_POOL`,
/// same env the engine reads), plus a cached identity probe per exit so the
/// user-facing "Connect via" picker can show where each exit actually comes
/// out (country/city/IP) without blocking a request on N SOCKS round trips.
///
/// Label derivation must match the engine (`mullvadLabelFromHost` in
/// engine/source/ircfiber/irc/connection.d): `tailscale-mullvad-de:1055` →
/// `de`, `100.94.116.56:1080` → `100.94.116.56` (no dash → host before the
/// first dot, else the whole host). `NetworkConfig.egressNodeId` stores that
/// label, or "" (automatic), or DIRECT_EGRESS_ID (bare host IP).

import core.sync.mutex : Mutex;
import core.thread : Thread;
import std.conv : to;
import std.datetime : Clock;
import std.string : split, strip, indexOf, lastIndexOf, toLower, startsWith;
import vibe.core.log;

/// egressNodeId value that pins the un-proxied host IP. Mirrors the engine's
/// DIRECT_EGRESS_LABEL.
enum DIRECT_EGRESS_ID = "direct";

/// Interval after which the cached exit probe is refreshed in the background.
enum EXIT_PROBE_TTL_MS = 10 * 60 * 1000L;

/// Per-exit timeout for the SOCKS identity probe.
enum EXIT_PROBE_TIMEOUT_SECS = 6;

/// One `IRCFIBER_MULLVAD_POOL` entry.
struct PoolEntry {
    /// Short label users/admins pin to (e.g. "de").
    string label;
    string host;
    ushort port;
    /// Best-effort DNS of `host`; "" when unresolved.
    string resolvedIp;
}

/// Raw pool string: env first, then the engine env file on a combined
/// gateway+engine host (the gateway container may run without the var).
string mullvadRawPool() {
    import std.process : environment;
    auto raw = environment.get("IRCFIBER_MULLVAD_POOL", "");
    if (raw.length == 0) {
        try {
            import std.file : readText, exists;
            if (exists("/etc/ircfiber/engine/env-ovh")) {
                foreach (line; readText("/etc/ircfiber/engine/env-ovh").split("\n")) {
                    auto t = line.strip();
                    if (t.startsWith("IRCFIBER_MULLVAD_POOL=")) { raw = t["IRCFIBER_MULLVAD_POOL=".length .. $].strip(); break; }
                }
            }
        } catch (Exception) {}
    }
    return raw;
}

/// Parses `socks5://host:port,...` into entries with engine-compatible labels.
PoolEntry[] parseMullvadPool(string raw) {
    PoolEntry[] out_;
    if (raw.length == 0) return out_;
    foreach (entry; raw.split(",")) {
        auto e = entry.strip();
        if (e.length == 0) continue;
        auto p = e.indexOf("://");
        if (p >= 0) e = e[p + 3 .. $];
        // Optional explicit label: `de@100.94.116.56:1080`. Needed when the
        // host is a bare IP shared by several sidecars on different ports —
        // the dash/dot heuristic below would give them all the same label.
        string explicitLabel = "";
        auto at = e.indexOf("@");
        if (at >= 0) { explicitLabel = e[0 .. at].strip().toLower(); e = e[at + 1 .. $]; }
        auto colon = e.lastIndexOf(":");
        string host = e; ushort port = 1080;
        if (colon >= 0) { host = e[0 .. colon].strip(); try { port = e[colon + 1 .. $].strip().to!ushort; } catch (Exception) {} }
        if (host.length == 0) continue;
        string label = host.toLower();
        auto dash = host.lastIndexOf("-");
        if (explicitLabel.length > 0) label = explicitLabel;
        else if (dash >= 0 && dash + 1 < host.length) label = host[dash + 1 .. $].toLower();
        else { auto dot = host.indexOf("."); if (dot > 0) label = host[0 .. dot].toLower(); }
        string resolvedIp = "";
        try {
            import std.socket : getAddress;
            auto addrs = getAddress(host);
            if (addrs.length > 0) resolvedIp = addrs[0].toAddrString();
        } catch (Exception) {}
        out_ ~= PoolEntry(label, host, port, resolvedIp);
    }
    return out_;
}

/// Normalises a client-supplied egress choice: "", "auto", "random" → "";
/// everything else lower-cased and stripped.
string normalizeEgressId(string raw) {
    auto v = raw.strip().toLower();
    if (v == "auto" || v == "random") return "";
    return v;
}

/// True when `id` is "", DIRECT_EGRESS_ID, or a label in the configured pool.
bool isKnownEgressId(string id) {
    if (id.length == 0 || id == DIRECT_EGRESS_ID) return true;
    foreach (e; parseMullvadPool(mullvadRawPool())) if (e.label == id) return true;
    return false;
}

/// What a user sees for one exit in the "Connect via" picker.
struct ExitInfo {
    /// Pool label == egressNodeId value.
    string id;
    string host;
    ushort port;
    /// Public IP the IRC server would see; "" until probed.
    string ip;
    string country;
    string city;
    /// Probe reached the internet through this exit.
    bool healthy;
    /// Unix ms of the last probe; 0 = never.
    long checkedAtMs;
    /// Last probe error, "" when healthy.
    string error;
}

private __gshared ExitInfo[] gExits;
private __gshared long gExitsProbedAtMs;
private __gshared bool gProbeRunning;
private __gshared Mutex gExitsLock;

shared static this() { gExitsLock = new Mutex(); }

/// Snapshot of the pool for the picker. Returns immediately from cache and
/// kicks off a background probe when the cache is stale or empty, so the
/// first caller after a gateway start sees unprobed rows (`ip == ""`) and
/// the next poll fills them in.
ExitInfo[] egressExits() {
    auto entries = parseMullvadPool(mullvadRawPool());
    ExitInfo[] out_;
    bool needProbe;
    synchronized (gExitsLock) {
        const now = Clock.currTime.toUnixTime!long * 1000;
        needProbe = !gProbeRunning && (gExitsProbedAtMs == 0 || now - gExitsProbedAtMs > EXIT_PROBE_TTL_MS);
        if (needProbe) gProbeRunning = true;
        foreach (e; entries) {
            ExitInfo info;
            info.id = e.label; info.host = e.host; info.port = e.port;
            foreach (ref cached; gExits) if (cached.id == e.label) { info = cached; break; }
            out_ ~= info;
        }
    }
    if (needProbe) {
        try {
            auto t = new Thread({ probeExits(entries); });
            t.isDaemon = true;
            t.start();
        } catch (Exception ex) {
            synchronized (gExitsLock) gProbeRunning = false;
            logWarn("egress: could not start exit probe: %s", ex.msg);
        }
    }
    return out_;
}

/// Runs on a plain thread: one curl through each exit to am.i.mullvad.net.
/// std.json (not vibe) so nothing here touches the event loop.
private void probeExits(PoolEntry[] entries) nothrow {
    ExitInfo[] results;
    foreach (e; entries) {
        ExitInfo info;
        info.id = e.label; info.host = e.host; info.port = e.port;
        try {
            import std.process : execute;
            import std.json : parseJSON, JSONType;
            auto r = execute(["curl", "-s", "--max-time", EXIT_PROBE_TIMEOUT_SECS.to!string,
                "--socks5-hostname", e.host ~ ":" ~ e.port.to!string,
                "https://am.i.mullvad.net/json"]);
            if (r.status == 0 && r.output.strip().length > 2) {
                auto j = parseJSON(r.output);
                if ("ip" in j && j["ip"].type == JSONType.string) info.ip = j["ip"].str;
                if ("country" in j && j["country"].type == JSONType.string) info.country = j["country"].str;
                if ("city" in j && j["city"].type == JSONType.string) info.city = j["city"].str;
                info.healthy = info.ip.length > 0;
                if (!info.healthy) info.error = "probe returned no IP";
            } else {
                info.error = r.status == 0 ? "empty probe response" : "curl exit " ~ r.status.to!string;
            }
        } catch (Exception ex) {
            info.error = ex.msg;
        }
        info.checkedAtMs = Clock.currTime.toUnixTime!long * 1000;
        results ~= info;
    }
    try {
        synchronized (gExitsLock) {
            gExits = results;
            gExitsProbedAtMs = Clock.currTime.toUnixTime!long * 1000;
            gProbeRunning = false;
        }
    } catch (Exception) {}
}
