/**
 * The IP-intelligence service: fan-out, caches, quota, Tor exit set.
 *
 * `lookup` runs on the caller's fiber and owns every Redis/Mongo access;
 * the source adapters (`ircfiber.ipintel.sources`) only ever see the
 * network. One never-before-seen IP costs one `runTask` per missing
 * source (phase 1), an optional IPHub tiebreak (phase 2), one `SISMEMBER`
 * against the hourly Tor exit set, and one Mongo write.
 *
 * Redis keys:
 *   irc:ipintel:v1:<ip>                 assembled record, 1 h
 *   irc:ipintel:<src>:<ip>              `{"at":ms,"raw":…}` per source, source TTL
 *   irc:ipintel:quota:<counter>:<ymd>   daily counters, 2 d
 *   irc:ipintel:torexits                SET of exit addresses, refreshed hourly
 *   irc:ipintel:rdap:bootstrap:v4|v6    IANA bootstrap document, 1 d
 *
 * Never throws: every failure lands in `IpIntel.degraded`.
 */
module ircfiber.ipintel.service;

import std.algorithm : canFind;
import std.conv : to;
import std.datetime : Clock, UTC;
import std.string : format, indexOf, split, strip;
import core.time : msecs;

import vibe.core.core : runTask;
import vibe.core.log;
import vibe.core.sync : LocalManualEvent, createManualEvent;
import vibe.data.json : Json;

import ircfiber.bots.core : nowMs;
import ircfiber.fibereye.format : ipGroup;
import ircfiber.ipintel.assemble : SourceResult, assemble, needsTiebreak;
import ircfiber.ipintel.http : httpGetText;
import ircfiber.ipintel.record : IpIntel;
import ircfiber.ipintel.sources;
import ircfiber.ipintel.store : IpIntelStore;
import ircfiber.logs.format : isPrivateIp;
import ircfiber.storage.redis : RedisStorage;

public import ircfiber.ipintel.sources : IpIntelSettings, loadIpIntelSettings;

/// How much a lookup may spend.
enum LookupMode {
    /// Caches and Mongo only; never a network call.
    cached,
    /// Fetch what is missing from the per-source caches.
    enrich,
    /// Refetch everything and add Shodan (manual "Deep lookup").
    deep,
}

/// Assembled-record cache key (1 h).
string ipIntelKey(string ip) @safe pure { return "irc:ipintel:v1:" ~ ip; }
/// Raw per-source cache key.
string ipIntelRawKey(string src, string ip) @safe pure { return "irc:ipintel:" ~ src ~ ":" ~ ip; }
/// The Tor exit SET.
string ipIntelTorKey() @safe pure nothrow { return "irc:ipintel:torexits"; }
/// Daily quota counter.
string ipIntelQuotaKey(string counter, string ymd) @safe pure { return "irc:ipintel:quota:" ~ counter ~ ":" ~ ymd; }
/// IANA RDAP bootstrap cache.
string ipIntelBootstrapKey(string ip) @safe pure {
    return ip.indexOf(':') >= 0 ? "irc:ipintel:rdap:bootstrap:v6" : "irc:ipintel:rdap:bootstrap:v4";
}

/// Shared state of one fan-out. Fibers append to `results` until the
/// caller marks it `closed`; a late result is dropped.
private final class FanOut {
    SourceResult[] results;
    int pending;
    bool closed;
    LocalManualEvent done;
    /// RDAP bootstrap handed to the adapter (null = fetch) and back.
    Json rdapBootstrap;
    Json fetchedBootstrap;
}

/// Lookup, sighting counters and the hourly Tor refresh.
final class IpIntelService {
    private RedisStorage redis;
    private IpIntelStore store;
    private IpIntelSettings s;

    /// `redis` is the caller's connection (pooled per fiber inside vibe);
    /// `store` may be null when Mongo is unavailable.
    this(RedisStorage redis, IpIntelStore store, IpIntelSettings s) {
        this.redis = redis;
        this.store = store;
        this.s = s;
    }

    /// Source ids that can run with the current keys.
    string[] activeSources() const { return activeSourceIds(s); }

    /// Counts a sighting in Mongo. `firstSighting` = the row was created now.
    void recordSighting(string ip, long tsMs, out bool firstSighting) {
        firstSighting = false;
        const addr = ip.strip();
        if (!addr.length || isPrivateIp(addr) || store is null) return;
        try firstSighting = store.touch(addr, tsMs);
        catch (Exception e) logWarn("ipintel: recordSighting failed for %s: %s", addr, e.msg);
    }

    /// ditto, `firstSighting` = no Mongo row existed before this call.
    IpIntel lookup(string ip, LookupMode mode) {
        bool first;
        return lookup(ip, mode, first);
    }

    /// The record for `ip`. Private/empty addresses return a bogon record
    /// with no provenance and cost nothing.
    IpIntel lookup(string ip, LookupMode mode, out bool firstSighting) {
        firstSighting = false;
        const addr = ip.strip();
        if (!addr.length || isPrivateIp(addr)) {
            IpIntel r;
            r.identity.ip = addr;
            r.identity.group = addr;
            r.identity.ipVersion = addr.indexOf(':') >= 0 ? 6 : 4;
            r.identity.isBogon = true;
            return r;
        }
        try return lookupImpl(addr, mode, firstSighting);
        catch (Exception e) {
            logWarn("ipintel: lookup failed for %s: %s", addr, e.msg);
            IpIntel r;
            r.identity.ip = addr;
            r.identity.group = ipGroup(addr);
            r.identity.ipVersion = addr.indexOf(':') >= 0 ? 6 : 4;
            r.degraded ~= "service:" ~ e.msg;
            return r;
        }
    }

    private IpIntel lookupImpl(string ip, LookupMode mode, out bool firstSighting) {
        bool found;
        IpIntel stored;
        if (store !is null) stored = store.get(ip, found);
        firstSighting = !found;
        if (mode == LookupMode.cached) {
            if (redis !is null) {
                auto cached = redis.getJson(ipIntelKey(ip));
                if (cached.type == Json.Type.object) {
                    auto r = IpIntel.fromJson(cached);
                    if (found) copyCounters(r, stored);
                    return r;
                }
            }
            if (found && stored.assembledAt > 0) return stored;
            IpIntel r;
            r.identity.ip = ip;
            r.identity.group = ipGroup(ip);
            r.identity.ipVersion = ip.indexOf(':') >= 0 ? 6 : 4;
            if (found) copyCounters(r, stored);
            return r;
        }

        const now = nowMs();
        SourceResult[] results;
        string[] missing;
        bool[string] fetchedNow;

        foreach (src; phaseOneSources(s)) {
            if (mode != LookupMode.deep) {
                if (src == "ripestat_prefix") {
                    SourceResult p, k;
                    if (cachedRaw("ripestat_prefix", ip, p) && cachedRaw("ripestat_rpki", ip, k)) {
                        results ~= p;
                        results ~= k;
                        continue;
                    }
                } else {
                    SourceResult c;
                    if (cachedRaw(src, ip, c)) { results ~= c; continue; }
                }
            }
            missing ~= src;
        }
        if (mode == LookupMode.deep) missing ~= "shodan";

        // Phase 1.
        auto fo = new FanOut;
        fo.done = createManualEvent();
        if (missing.canFind("rdap") && redis !is null) {
            try fo.rdapBootstrap = redis.getJson(ipIntelBootstrapKey(ip));
            catch (Exception) {}
        }
        string[] spawned;
        foreach (src; missing) {
            const units = src == "ripestat_prefix" ? 2 : 1;
            if (!takeQuota(quotaCounter(src), units)) {
                results ~= SourceResult(src, false, "quota");
                if (src == "ripestat_prefix") results ~= SourceResult("ripestat_rpki", false, "quota");
                continue;
            }
            fo.pending++;
            spawned ~= src;
            fetchedNow[src] = true;
            if (src == "ripestat_prefix") fetchedNow["ripestat_rpki"] = true;
            runTask(&fetchOne, fo, src, ip);
        }
        if (spawned.length) {
            const deadline = now + s.deadlineSeconds * 1000L;
            int ec = fo.done.emitCount;
            while (fo.pending > 0) {
                const remaining = deadline - nowMs();
                if (remaining <= 0) break;
                ec = fo.done.wait(remaining.msecs, ec);
            }
            fo.closed = true;
            results ~= fo.results;
            foreach (src; spawned) {
                if (!has(results, src)) results ~= SourceResult(src, false, "timeout");
                if (src == "ripestat_prefix" && !has(results, "ripestat_rpki"))
                    results ~= SourceResult("ripestat_rpki", false, "timeout");
            }
            if (fo.fetchedBootstrap.type == Json.Type.object && redis !is null) {
                try redis.setJson(ipIntelBootstrapKey(ip), fo.fetchedBootstrap, 86_400);
                catch (Exception e) logWarn("ipintel: bootstrap cache write failed: %s", e.msg);
            }
        }

        // Phase 2: IPHub only when the two flag sources disagree (or one is missing).
        if (s.iphubKey.length && (mode == LookupMode.deep || needsTiebreak(results, ip))) {
            SourceResult c;
            if (mode != LookupMode.deep && cachedRaw("iphub", ip, c)) {
                results ~= c;
            } else if (!takeQuota("iphub", 1)) {
                results ~= SourceResult("iphub", false, "quota");
            } else {
                auto r = fetchIphub(ip, s);
                r.fetchedAt = nowMs();
                fetchedNow["iphub"] = true;
                results ~= r;
            }
        }

        bool torExit;
        if (redis !is null) {
            try torExit = redis.getDb().sisMember!string(ipIntelTorKey(), ip);
            catch (Exception e) logWarn("ipintel: tor set read failed: %s", e.msg);
        }

        auto rec = assemble(ip, ipGroup(ip), results, torExit, nowMs());
        if (found) copyCounters(rec, stored);

        if (redis !is null) {
            foreach (ref r; results) {
                if (!r.ok || !(r.src in fetchedNow)) continue;
                auto wrap = Json.emptyObject;
                wrap["at"] = Json(r.fetchedAt);
                wrap["raw"] = r.raw;
                try redis.setJson(ipIntelRawKey(r.src, ip), wrap, r.ttl > 0 ? r.ttl : s.ttlSeconds);
                catch (Exception e) logWarn("ipintel: raw cache write failed (%s): %s", r.src, e.msg);
            }
            try redis.setJson(ipIntelKey(ip), rec.toJson(), 3600);
            catch (Exception e) logWarn("ipintel: record cache write failed: %s", e.msg);
        }
        if (store !is null) store.save(ip, rec);
        return rec;
    }

    private static void copyCounters(ref IpIntel dst, const IpIntel src) @safe pure nothrow {
        dst.reputation.firstSeen = src.reputation.firstSeen;
        dst.reputation.lastSeen = src.reputation.lastSeen;
        dst.reputation.sessionCount = src.reputation.sessionCount;
    }

    private static bool has(const SourceResult[] results, string src) @safe pure nothrow {
        foreach (ref r; results) if (r.src == src) return true;
        return false;
    }

    /// One fan-out fiber: run the adapter, hand the result back, wake the waiter.
    private void fetchOne(FanOut fo, string src, string ip) nothrow {
        SourceResult[] out_;
        try {
            switch (src) {
                case "ipinfo": out_ ~= fetchIpinfo(ip, s); break;
                case "proxycheck": out_ ~= fetchProxycheck(ip, s); break;
                case "ipapi_is": out_ ~= fetchIpapiIs(ip, s); break;
                case "ripestat_prefix": out_ ~= fetchRipestatPrefixAndRpki(ip, s); break;
                case "ripestat_abuse": out_ ~= fetchRipestatAbuse(ip, s); break;
                case "rdap": out_ ~= fetchRdap(ip, s, fo.rdapBootstrap, fo.fetchedBootstrap); break;
                case "sfs": out_ ~= fetchSfs(ip, s); break;
                case "dronebl": out_ ~= fetchDronebl(ip, s); break;
                case "efnetrbl": out_ ~= fetchEfnetrbl(ip, s); break;
                case "shodan": out_ ~= fetchShodan(ip, s); break;
                default: out_ ~= SourceResult(src, false, "unknown"); break;
            }
        } catch (Exception e) {
            out_ = [SourceResult(src, false, "error")];
        }
        const at = nowMs();
        foreach (ref r; out_) r.fetchedAt = at;
        if (!fo.closed) fo.results ~= out_;
        fo.pending--;
        try fo.done.emit(); catch (Exception) {}
    }

    /// Reads one source's raw cache into a `SourceResult`.
    private bool cachedRaw(string src, string ip, out SourceResult r) {
        if (redis is null) return false;
        try {
            auto wrap = redis.getJson(ipIntelRawKey(src, ip));
            if (wrap.type != Json.Type.object || wrap["raw"].type == Json.Type.undefined) return false;
            r.src = src;
            r.ok = true;
            r.raw = wrap["raw"];
            r.fetchedAt = wrap["at"].type == Json.Type.int_ ? wrap["at"].get!long : 0;
            r.ttl = sourceTtl(src, s);
            return true;
        } catch (Exception e) {
            logWarn("ipintel: raw cache read failed (%s): %s", src, e.msg);
            return false;
        }
    }

    /// Spends `units` of today's cap for `counter`; false at the cap.
    private bool takeQuota(string counter, int units) {
        const cap = s.caps.get(counter, 0L);
        if (cap <= 0 || redis is null) return true;
        try {
            auto db = redis.getDb();
            const key = ipIntelQuotaKey(counter, today());
            const n = db.incr(key, units);
            if (n <= units) db.expire(key, 172_800);
            if (n > cap) {
                if (n - units < cap) logWarn("ipintel: daily cap reached for %s (%s)", counter, cap);
                return false;
            }
            return true;
        } catch (Exception e) {
            logWarn("ipintel: quota counter failed for %s: %s", counter, e.msg);
            return false;
        }
    }

    private static string today() {
        auto t = Clock.currTime(UTC());
        return format("%04d%02d%02d", t.year, cast(int) t.month, t.day);
    }

    /// Downloads the Tor bulk exit list into `irc:ipintel:torexits` (3 h
    /// TTL, so a stale set outlives two missed refreshes and then fails
    /// safe to "not a known exit"). An empty or failed download keeps the
    /// old set.
    void refreshTorExits() {
        if (redis is null) return;
        int status;
        const text = httpGetText("https://check.torproject.org/torbulkexitlist", null, s.timeout(), status);
        if (status < 200 || status >= 300 || !text.length) {
            logWarn("ipintel: tor exit list download failed (HTTP %s) — keeping the old set", status);
            return;
        }
        string[] batch;
        long total;
        try {
            auto db = redis.getDb();
            const next = ipIntelTorKey() ~ ":next";
            db.del(next);
            foreach (line; text.split('\n')) {
                const ipLine = line.strip();
                if (!ipLine.length || ipLine[0] == '#') continue;
                batch ~= ipLine;
                if (batch.length >= 500) { total += db.sadd(next, batch); batch = null; }
            }
            if (batch.length) total += db.sadd(next, batch);
            if (total == 0) {
                logWarn("ipintel: tor exit list parsed to zero entries — keeping the old set");
                db.del(next);
                return;
            }
            db.rename(next, ipIntelTorKey());
            db.expire(ipIntelTorKey(), 10_800);
            logInfo("ipintel: tor exit set refreshed (%s entries)", total);
        } catch (Exception e) {
            logWarn("ipintel: tor exit set refresh failed: %s", e.msg);
        }
    }
}
