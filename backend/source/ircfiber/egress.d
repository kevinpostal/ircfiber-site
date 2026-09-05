module ircfiber.egress;

/// Mullvad egress as the gateway sees it: the *slot* registry and location
/// catalog the engine publishes to Redis, merged with a cached SOCKS identity
/// probe per slot so the user-facing "Connect via" picker can show where each
/// exit actually comes out without blocking a request on N round trips.
///
/// A slot is one long-lived SOCKS sidecar (`IRCFIBER_MULLVAD_POOL`, the same
/// env the engine reads); the engine retargets an *idle* slot to whichever
/// Mullvad city a user pinned. `NetworkConfig.egressNodeId` therefore stores
/// a location pin, not a slot label: "" (automatic), DIRECT_EGRESS_ID, a
/// two-letter country code, or `<countryCode>-<cityCode>`.
///
/// Label derivation must still match the engine (`mullvadLabelFromHost` in
/// engine/source/ircfiber/irc/connection.d): `tailscale-mullvad-de:1055` →
/// `de`, `100.94.116.56:1080` → `100.94.116.56` (no dash → host before the
/// first dot, else the whole host), because slot labels are the hash fields
/// of the published registry and the keys of the probe cache.

import core.sync.mutex : Mutex;
import core.thread : Thread;
import std.conv : to;
import std.datetime : Clock;
import std.string : split, strip, indexOf, lastIndexOf, toLower, startsWith;
import vibe.data.json : Json, parseJsonString;

import ircfiber.irc.registry : ServerRegistry;
import ircfiber.redis.protocol : RedisKeys;
import ircfiber.storage.redis : RedisStorage;
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

/// Interval the merged slot/catalog view is cached for. Short enough that
/// `activeConns` in the picker tracks reality, long enough that a dialog
/// polling every 10 s costs one Redis round trip per poll.
enum EGRESS_VIEW_TTL_MS = 5_000L;

/// One egress slot: what the engine published, plus what the gateway probed.
struct EgressSlot {
    /// Engine that owns the slot.
    string serverId;
    /// Internal slot name from IRCFIBER_MULLVAD_POOL ("de").
    string label;
    string host;
    ushort port;
    /// Current exit location id ("de-ber"); "" when unknown (static slot).
    string locationId;
    /// Current exit relay host name ("de-ber-wg-003").
    string hostname;
    string country;
    string countryCode;
    string city;
    /// Engine can retarget this slot to another location.
    bool controllable;
    /// "ready" | "retargeting" | "error".
    string state;
    /// Live connections currently egressing through the slot.
    int activeConns;
    /// Slot is reserved or in its sticky hold until this unix-ms stamp.
    long heldUntilMs;
    /// Public IP the IRC server would see; "" until probed.
    string exitIp;
    /// Probe reached the internet through this slot.
    bool healthy;
    /// Unix ms of the last probe; 0 = never.
    long checkedAtMs;
    /// Engine or probe error; "" when fine.
    string error;
}

/// One pickable location in the catalog.
struct EgressLocationRow {
    /// `<countryCode>-<cityCode>` — the value a city pin carries.
    string id;
    string country;
    string countryCode;
    string city;
    /// Relays backing the city (informational).
    int relays;
}

/// Everything `GET /api/egress` and the pin validators need.
struct EgressView {
    EgressSlot[] slots;
    /// Union across engines, deduped by id, sorted country then city.
    EgressLocationRow[] locations;
    int slotCount;
    /// Slots that could be retargeted to a brand-new location right now.
    int freeSlots;
    /// At least one slot is retargetable — i.e. new locations are pickable.
    bool controllable;
}

/// Derives the view's aggregate fields and dedupes/sorts the catalog. Pure so
/// the 409/400 decisions can be unit-tested without Redis (see
/// tests/egress_test.d).
EgressView egressViewFrom(EgressSlot[] slots, EgressLocationRow[] locations, long nowMs) {
    EgressView v;
    v.slots = slots;
    v.slotCount = cast(int) slots.length;
    foreach (s; slots) {
        if (!s.controllable) continue;
        v.controllable = true;
        if (s.activeConns == 0 && s.heldUntilMs <= nowMs && s.state != "retargeting")
            v.freeSlots++;
    }
    bool[string] seen;
    foreach (l; locations) {
        if (l.id.length == 0 || (l.id in seen) !is null) continue;
        seen[l.id] = true;
        v.locations ~= l;
    }
    import std.algorithm : sort;
    v.locations.sort!((a, b) => a.country == b.country ? a.city < b.city : a.country < b.country);
    return v;
}

/// True when `id` is a pin this deployment can honour: "" (automatic) and
/// DIRECT_EGRESS_ID always; the label of a static (non-controllable) slot,
/// which is how such a slot is addressed since its location cannot be read;
/// a two-letter country pin when some location has that country code; a city
/// pin when that exact id exists.
///
/// Permissive only when this deployment genuinely cannot judge: no slots at
/// all, or retargetable slots whose engine has not published its catalog yet
/// (a freshly started engine must not lock users out of their stored pins).
/// A static-only pool has no catalog by design, so there its labels are the
/// whole truth and anything else is rejected.
bool isKnownEgressId(string id, EgressView v) {
    if (id.length == 0 || id == DIRECT_EGRESS_ID) return true;
    foreach (s; v.slots)
        if (!s.controllable && s.label == id) return true;
    if (v.slots.length == 0) return true;
    if (v.controllable && v.locations.length == 0) return true;
    foreach (l; v.locations) {
        if (l.id == id) return true;
        if (id.length == 2 && l.countryCode == id) return true;
    }
    return false;
}

/// The slot that would serve `pin` today without retargeting anything: a
/// static slot named by its label, or a slot already sitting on the pinned
/// location. Null when honouring the pin would require a retarget.
const(EgressSlot)* matchingSlot(string pin, ref EgressView v) {
    if (pin.length == 0 || pin == DIRECT_EGRESS_ID) return null;
    foreach (i, ref s; v.slots)
        if (!s.controllable && s.label == pin) return &v.slots[i];
    foreach (i, ref s; v.slots) {
        if (s.locationId.length == 0) continue;
        if (s.locationId == pin) return &v.slots[i];
        if (pin.length == 2 && s.locationId.length > 3
            && s.locationId[0 .. 2] == pin && s.locationId[2] == '-')
            return &v.slots[i];
    }
    return null;
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

shared static this() {
    gExitsLock = new Mutex();
    gViewLock = new Mutex();
}

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

private __gshared EgressView gView;
private __gshared long gViewAtMs;
private __gshared Mutex gViewLock;

/// Reads one engine's published slot registry. Empty when the engine is
/// older than the slot feature or its 60 s key expired.
private EgressSlot[] readSlots(RedisStorage redis, string serverId) {
    EgressSlot[] out_;
    string[string] fields;
    try {
        fields = redis.hgetAll(RedisKeys.egressSlots(serverId));
    } catch (Exception e) {
        logWarn("egress: slot registry read failed for %s: %s", serverId, e.msg);
        return out_;
    }
    foreach (label, raw; fields) {
        try {
            auto j = parseJsonString(raw);
            EgressSlot s;
            s.serverId = serverId;
            s.label = label;
            s.host = j["host"].opt!string("");
            s.port = cast(ushort) j["port"].opt!long(0);
            s.locationId = j["locationId"].opt!string("");
            s.hostname = j["hostname"].opt!string("");
            s.country = j["country"].opt!string("");
            s.countryCode = j["countryCode"].opt!string("");
            s.city = j["city"].opt!string("");
            s.controllable = j["controllable"].opt!bool(false);
            s.state = j["state"].opt!string("ready");
            s.activeConns = cast(int) j["activeConns"].opt!long(0);
            s.heldUntilMs = j["heldUntilMs"].opt!long(0);
            s.error = j["error"].opt!string("");
            out_ ~= s;
        } catch (Exception e) {
            logWarn("egress: bad slot JSON for %s/%s: %s", serverId, label, e.msg);
        }
    }
    return out_;
}

/// Reads one engine's published location catalog.
private EgressLocationRow[] readCatalog(RedisStorage redis, string serverId) {
    EgressLocationRow[] out_;
    try {
        auto j = redis.getJson(RedisKeys.egressCatalog(serverId));
        if (j.type != Json.Type.array) return out_;
        foreach (e; j) {
            EgressLocationRow r;
            r.id = e["id"].opt!string("");
            r.country = e["country"].opt!string("");
            r.countryCode = e["countryCode"].opt!string("");
            r.city = e["city"].opt!string("");
            r.relays = cast(int) e["relays"].opt!long(0);
            if (r.id.length) out_ ~= r;
        }
    } catch (Exception e) {
        logWarn("egress: catalog read failed for %s: %s", serverId, e.msg);
    }
    return out_;
}

/// Slots synthesised from the gateway's own pool env, used for an engine that
/// publishes no registry (older engine, or the key expired). They degrade the
/// picker to the pre-slot behaviour — listed, never retargetable — instead of
/// leaving it blank.
private EgressSlot[] syntheticSlots(string serverId) {
    EgressSlot[] out_;
    foreach (e; parseMullvadPool(mullvadRawPool())) {
        EgressSlot s;
        s.serverId = serverId;
        s.label = e.label;
        s.host = e.host;
        s.port = e.port;
        s.state = "ready";
        out_ ~= s;
    }
    return out_;
}

/// Merged slot + catalog view across every registered engine, with the
/// gateway's SOCKS probe results folded in by slot label. Cached for
/// EGRESS_VIEW_TTL_MS; also drives the background probe refresh.
EgressView egressView(RedisStorage redis, ServerRegistry reg) {
    const now = Clock.currTime.toUnixTime!long * 1000;
    synchronized (gViewLock) {
        if (gViewAtMs != 0 && now - gViewAtMs < EGRESS_VIEW_TTL_MS) return gView;
    }
    // Keeps the identity probe warm and gives us exitIp/healthy per label.
    auto probed = egressExits();
    string[] serverIds;
    try {
        foreach (s; reg.getAllServers()) if (s.serverId.length > 0) serverIds ~= s.serverId;
    } catch (Exception e) {
        logWarn("egress: server registry read failed: %s", e.msg);
    }
    EgressSlot[] slots;
    EgressLocationRow[] locations;
    foreach (sid; serverIds) {
        auto published = readSlots(redis, sid);
        slots ~= published.length > 0 ? published : syntheticSlots(sid);
        locations ~= readCatalog(redis, sid);
    }
    // No engine registered at all: still show the configured pool.
    if (serverIds.length == 0) slots = syntheticSlots("");
    foreach (ref s; slots) {
        foreach (p; probed) {
            if (p.id != s.label) continue;
            s.exitIp = p.ip;
            s.healthy = p.healthy;
            s.checkedAtMs = p.checkedAtMs;
            if (s.error.length == 0) s.error = p.error;
            // A static slot has no engine-readable location; the SOCKS probe
            // (am.i.mullvad.net) still knows where it comes out, so the
            // picker can name the place instead of showing a bare label.
            if (s.city.length == 0) s.city = p.city;
            if (s.country.length == 0) s.country = p.country;
            break;
        }
    }
    auto v = egressViewFrom(slots, locations, now);
    synchronized (gViewLock) {
        gView = v;
        gViewAtMs = now;
    }
    return v;
}
