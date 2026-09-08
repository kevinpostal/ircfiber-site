/**
 * One adapter per IP-intelligence source, plus the settings they read.
 *
 * Every adapter is `SourceResult fetch(ip, settings) nothrow` — the
 * nothrow wrapper is what `runTask` needs — and touches nothing but the
 * network: no Redis, no Mongo. Caches and quota counters are the
 * service's business (`ircfiber.ipintel.service`), on the caller's
 * single fiber.
 *
 * Env (all optional):
 *   IRCFIBER_IPINFO_TOKEN(_FILE)      ipinfo.io Core token
 *   IRCFIBER_IPINFO_URL               default https://ipinfo.io
 *   IRCFIBER_PROXYCHECK_KEY(_FILE)    proxycheck.io key (keyless = 100/day)
 *   IRCFIBER_IPAPI_IS_KEY(_FILE)      ipapi.is key (keyless carries no flags → skipped)
 *   IRCFIBER_IPHUB_KEY(_FILE)         IPHub key (phase-2 tiebreaker; skipped when unset)
 *   IRCFIBER_IPINTEL_TIMEOUT          per-request seconds (default 6)
 *   IRCFIBER_IPINTEL_DEADLINE         whole fan-out seconds (default 10)
 *   IRCFIBER_IPINTEL_TTL              flag-source TTL seconds (default 604800)
 *   IRCFIBER_IPINTEL_CAP_<SRC>        daily cap override per source (0 = unlimited)
 */
module ircfiber.ipintel.sources;

import std.conv : to;
import std.process : environment;
import std.socket : AddressFamily;
import std.string : indexOf, split, strip, toUpper;
import core.time : Duration, seconds;

import vibe.core.net : resolveHost;
import vibe.data.json : Json;

import ircfiber.env : envSecret;
import ircfiber.ipintel.assemble : SourceResult;
import ircfiber.ipintel.cidr : cidrContains;
import ircfiber.ipintel.http : HttpJson, httpGetJson;
import ircfiber.ipintel.record : jstr;

/// Resolved settings for every adapter.
struct IpIntelSettings {
    string ipinfoToken;
    string ipinfoUrl = "https://ipinfo.io";
    string proxycheckKey, ipapiIsKey, iphubKey;
    int timeoutSeconds = 6;
    int deadlineSeconds = 10;
    /// TTL for the flag/geo sources (`ipinfo`, `proxycheck`, `ipapi_is`, `iphub`, RIPEstat).
    long ttlSeconds = 604_800;
    /// Daily cap per source id (`ripestat` is shared by the three RIPEstat calls).
    long[string] caps;

    Duration timeout() const nothrow @nogc pure { return timeoutSeconds.seconds; }
}

private long envLongOr(string name, long dflt) {
    try {
        const raw = environment.get(name, "").strip();
        if (raw.length) return raw.to!long;
    } catch (Exception) {
    }
    return dflt;
}

/// Reads `IpIntelSettings` from the environment.
IpIntelSettings loadIpIntelSettings() {
    IpIntelSettings s;
    s.ipinfoToken = envSecret("IRCFIBER_IPINFO_TOKEN", "").strip();
    auto url = environment.get("IRCFIBER_IPINFO_URL", "").strip();
    if (url.length) {
        while (url.length && url[$ - 1] == '/') url = url[0 .. $ - 1];
        s.ipinfoUrl = url;
    }
    s.proxycheckKey = envSecret("IRCFIBER_PROXYCHECK_KEY", "").strip();
    s.ipapiIsKey = envSecret("IRCFIBER_IPAPI_IS_KEY", "").strip();
    s.iphubKey = envSecret("IRCFIBER_IPHUB_KEY", "").strip();
    s.timeoutSeconds = cast(int) envLongOr("IRCFIBER_IPINTEL_TIMEOUT", 6);
    if (s.timeoutSeconds <= 0) s.timeoutSeconds = 6;
    s.deadlineSeconds = cast(int) envLongOr("IRCFIBER_IPINTEL_DEADLINE", 10);
    if (s.deadlineSeconds <= 0) s.deadlineSeconds = 10;
    s.ttlSeconds = envLongOr("IRCFIBER_IPINTEL_TTL", 604_800);
    if (s.ttlSeconds <= 0) s.ttlSeconds = 604_800;
    foreach (src, dflt; defaultCaps(s))
        s.caps[src] = envLongOr("IRCFIBER_IPINTEL_CAP_" ~ src.toUpper(), dflt);
    return s;
}

/// Free-tier daily caps (0 = unlimited), keyed by quota counter name.
private long[string] defaultCaps(const IpIntelSettings s) {
    return [
        "ipinfo": 4000L,
        "proxycheck": s.proxycheckKey.length ? 950L : 90L,
        "ipapi_is": 950L,
        "iphub": 950L,
        "ripestat": 900L,
        "rdap": 2000L,
        "sfs": 5000L,
        "dronebl": 0L,
        "efnetrbl": 0L,
        "shodan": 200L,
    ];
}

/// Which quota counter a source draws from.
string quotaCounter(string src) @safe pure nothrow {
    switch (src) {
        case "ripestat_prefix": case "ripestat_rpki": case "ripestat_abuse": return "ripestat";
        default: return src;
    }
}

/// Cache TTL of a source's raw answer, seconds.
long sourceTtl(string src, const IpIntelSettings s) @safe pure nothrow {
    switch (src) {
        case "ipinfo": case "proxycheck": case "ipapi_is": case "iphub":
        case "ripestat_prefix": case "ripestat_rpki": return s.ttlSeconds;
        case "ripestat_abuse": case "rdap": return 2_592_000;
        case "sfs": case "dronebl": case "efnetrbl": case "shodan": return 86_400;
        default: return s.ttlSeconds;
    }
}

/// Phase-1 sources, in no particular order. `iphub` is phase 2 and
/// `shodan` is deep-lookup only; neither is listed here.
string[] phaseOneSources(const IpIntelSettings s) @safe {
    string[] out_ = ["proxycheck", "ripestat_prefix", "ripestat_abuse", "rdap", "sfs", "dronebl", "efnetrbl"];
    if (s.ipinfoToken.length) out_ ~= "ipinfo";
    if (s.ipapiIsKey.length) out_ ~= "ipapi_is";
    return out_;
}

/// Every source that can run with the current settings (for the heartbeat).
string[] activeSourceIds(const IpIntelSettings s) @safe {
    auto out_ = phaseOneSources(s) ~ "ripestat_rpki";
    if (s.iphubKey.length) out_ ~= "iphub";
    return out_;
}

private SourceResult fail(string src, string error) nothrow {
    SourceResult r;
    r.src = src;
    r.error = error;
    return r;
}

private SourceResult fromHttp(string src, HttpJson h, long ttl) nothrow {
    SourceResult r;
    r.src = src;
    r.ttl = ttl;
    if (h.error.length) { r.error = h.error; return r; }
    r.ok = true;
    r.raw = h.body;
    return r;
}

// ── adapters ─────────────────────────────────────────────────────────

/// ipinfo Core `/<ip>/json`.
SourceResult fetchIpinfo(string ip, const IpIntelSettings s) nothrow {
    if (!s.ipinfoToken.length) return fail("ipinfo", "nokey");
    string[string] h = ["Authorization": "Bearer " ~ s.ipinfoToken];
    return fromHttp("ipinfo", httpGetJson(s.ipinfoUrl ~ "/" ~ ip ~ "/json", h, s.timeout()),
        sourceTtl("ipinfo", s));
}

/// proxycheck.io v3 — keyless at 100/day, keyed at 1000/day.
SourceResult fetchProxycheck(string ip, const IpIntelSettings s) nothrow {
    string url = "https://proxycheck.io/v3/" ~ ip ~ "?asn=1&risk=1&days=30";
    if (s.proxycheckKey.length) url ~= "&key=" ~ s.proxycheckKey;
    auto r = fromHttp("proxycheck", httpGetJson(url, null, s.timeout()), sourceTtl("proxycheck", s));
    try {
        if (r.ok && r.raw.type == Json.Type.object) {
            const st = jstr(r.raw, "status");
            // "denied"/"error" answers are 200s with a message; a quota-exhausted key says so here.
            if (st.length && st != "ok" && st != "warning") {
                r.ok = false;
                r.error = st == "denied" ? "quota" : st;
            }
        }
    } catch (Exception) {}
    return r;
}

/// ipapi.is — the keyless answer carries no flags, so a key is required.
SourceResult fetchIpapiIs(string ip, const IpIntelSettings s) nothrow {
    if (!s.ipapiIsKey.length) return fail("ipapi_is", "nokey");
    return fromHttp("ipapi_is",
        httpGetJson("https://api.ipapi.is/?q=" ~ ip ~ "&key=" ~ s.ipapiIsKey, null, s.timeout()),
        sourceTtl("ipapi_is", s));
}

/// IPHub v2 (phase-2 tiebreaker).
SourceResult fetchIphub(string ip, const IpIntelSettings s) nothrow {
    if (!s.iphubKey.length) return fail("iphub", "nokey");
    string[string] h = ["X-Key": s.iphubKey];
    return fromHttp("iphub", httpGetJson("https://v2.api.iphub.info/ip/" ~ ip, h, s.timeout()),
        sourceTtl("iphub", s));
}

private enum RIPESTAT = "https://stat.ripe.net/data/";

/// RIPEstat prefix-overview, then (same fiber) rpki-validation for the
/// prefix it found. The RPKI answer is returned as a second result so it
/// caches under its own key.
SourceResult[] fetchRipestatPrefixAndRpki(string ip, const IpIntelSettings s) nothrow {
    SourceResult[] out_;
    auto p = fromHttp("ripestat_prefix",
        httpGetJson(RIPESTAT ~ "prefix-overview/data.json?resource=" ~ ip ~ "&sourceapp=ircfiber", null, s.timeout()),
        sourceTtl("ripestat_prefix", s));
    out_ ~= p;
    if (!p.ok) { out_ ~= fail("ripestat_rpki", "skipped"); return out_; }
    string prefix, asn;
    try {
        auto d = p.raw["data"];
        prefix = jstr(d, "resource");
        auto asns = d["asns"];
        if (asns.type == Json.Type.array && asns.length > 0) asn = jstr(asns[0], "asn");
    } catch (Exception) {}
    if (prefix.indexOf('/') < 0 || !asn.length) { out_ ~= fail("ripestat_rpki", "unannounced"); return out_; }
    out_ ~= fromHttp("ripestat_rpki",
        httpGetJson(RIPESTAT ~ "rpki-validation/data.json?resource=AS" ~ asn ~ "&prefix=" ~ prefix
            ~ "&sourceapp=ircfiber", null, s.timeout()),
        sourceTtl("ripestat_rpki", s));
    return out_;
}

/// RIPEstat abuse-contact-finder.
SourceResult fetchRipestatAbuse(string ip, const IpIntelSettings s) nothrow {
    return fromHttp("ripestat_abuse",
        httpGetJson(RIPESTAT ~ "abuse-contact-finder/data.json?resource=" ~ ip ~ "&sourceapp=ircfiber", null, s.timeout()),
        sourceTtl("ripestat_abuse", s));
}

/// IANA RDAP bootstrap URL for the address family.
string rdapBootstrapUrl(string ip) @safe pure nothrow {
    return ip.indexOf(':') >= 0 ? "https://data.iana.org/rdap/ipv6.json" : "https://data.iana.org/rdap/ipv4.json";
}

/// Registry behind an RDAP service host.
string rirOfHost(string host) @safe pure {
    if (host.indexOf("ripe.net") >= 0) return "ripencc";
    if (host.indexOf("arin.net") >= 0) return "arin";
    if (host.indexOf("apnic.net") >= 0) return "apnic";
    if (host.indexOf("afrinic.net") >= 0) return "afrinic";
    if (host.indexOf("lacnic.net") >= 0) return "lacnic";
    return host;
}

/// Picks the RDAP service whose CIDR list covers `ip` from an IANA
/// bootstrap document; `""` when none does.
string rdapServiceFor(Json bootstrap, string ip) @trusted {
    if (bootstrap.type != Json.Type.object) return "";
    auto services = bootstrap["services"];
    if (services.type != Json.Type.array) return "";
    foreach (svc; services) {
        if (svc.type != Json.Type.array || svc.length < 2) continue;
        auto cidrs = svc[0];
        auto urls = svc[1];
        if (cidrs.type != Json.Type.array || urls.type != Json.Type.array || urls.length == 0) continue;
        foreach (c; cidrs) {
            if (c.type != Json.Type.string) continue;
            if (!cidrContains(c.get!string, ip)) continue;
            // Prefer https.
            foreach (u; urls)
                if (u.type == Json.Type.string && u.get!string.indexOf("https://") == 0) return u.get!string;
            return urls[0].type == Json.Type.string ? urls[0].get!string : "";
        }
    }
    return "";
}

/// RDAP `ip/<ip>` via the IANA bootstrap. `bootstrap` is the cached
/// document (null = fetch it); a freshly fetched one is handed back in
/// `fetchedBootstrap` so the caller can cache it.
SourceResult fetchRdap(string ip, const IpIntelSettings s, Json bootstrap, ref Json fetchedBootstrap) nothrow {
    try {
        if (bootstrap.type != Json.Type.object) {
            auto b = httpGetJson(rdapBootstrapUrl(ip), null, s.timeout());
            if (b.error.length) return fail("rdap", "bootstrap:" ~ b.error);
            bootstrap = b.body;
            fetchedBootstrap = b.body;
        }
        auto service = rdapServiceFor(bootstrap, ip);
        if (!service.length) return fail("rdap", "noservice");
        if (service[$ - 1] != '/') service ~= "/";
        string[string] h = ["Accept": "application/rdap+json, application/json"];
        auto r = fromHttp("rdap", httpGetJson(service ~ "ip/" ~ ip, h, s.timeout(), 2), sourceTtl("rdap", s));
        if (r.ok && r.raw.type == Json.Type.object) {
            // Host of the service URL → registry.
            auto host = service;
            const scheme = host.indexOf("://");
            if (scheme >= 0) host = host[scheme + 3 .. $];
            const slash = host.indexOf('/');
            if (slash >= 0) host = host[0 .. slash];
            r.raw["_rir"] = Json(rirOfHost(host));
        }
        return r;
    } catch (Exception e) {
        return fail("rdap", "error");
    }
}

/// StopForumSpam.
SourceResult fetchSfs(string ip, const IpIntelSettings s) nothrow {
    return fromHttp("sfs", httpGetJson("https://api.stopforumspam.org/api?ip=" ~ ip ~ "&json", null, s.timeout()),
        sourceTtl("sfs", s));
}

/// Reverses a dotted quad for a DNSBL query; `""` for anything else.
string reverseOctets(string ip) @safe pure {
    auto parts = ip.strip().split('.');
    if (parts.length != 4) return "";
    return parts[3] ~ "." ~ parts[2] ~ "." ~ parts[1] ~ "." ~ parts[0];
}

/// A DNSBL A-record lookup. Listed → `{"listed":true,"code":x}` from the
/// `127.0.0.x` answer; NXDOMAIN or any resolver failure → not listed.
/// IPv4 only; IPv6 is reported as not listed.
private SourceResult fetchDnsbl(string src, string zone, string ip, const IpIntelSettings s) nothrow {
    SourceResult r;
    r.src = src;
    r.ttl = sourceTtl(src, s);
    r.ok = true;
    try {
        auto raw = Json.emptyObject;
        raw["listed"] = Json(false);
        r.raw = raw;
        const rev = reverseOctets(ip);
        if (!rev.length) return r;
        try {
            auto addr = resolveHost(rev ~ "." ~ zone, AddressFamily.INET, true, s.timeout());
            const text = addr.toAddressString();
            auto parts = text.split('.');
            if (parts.length == 4 && parts[0] == "127") {
                raw["listed"] = Json(true);
                raw["code"] = Json(parts[3].to!int);
            }
        } catch (Exception) {
            // NXDOMAIN (not listed) and resolver trouble look alike here; both
            // are "no evidence of a listing".
        }
        r.raw = raw;
    } catch (Exception) {}
    return r;
}

/// DroneBL.
SourceResult fetchDronebl(string ip, const IpIntelSettings s) nothrow {
    return fetchDnsbl("dronebl", "dnsbl.dronebl.org", ip, s);
}

/// EFnet RBL.
SourceResult fetchEfnetrbl(string ip, const IpIntelSettings s) nothrow {
    return fetchDnsbl("efnetrbl", "rbl.efnetrbl.org", ip, s);
}

/// Shodan InternetDB — deep lookups only (non-commercial licence).
SourceResult fetchShodan(string ip, const IpIntelSettings s) nothrow {
    auto h = httpGetJson("https://internetdb.shodan.io/" ~ ip, null, s.timeout());
    if (h.status == 404) {
        SourceResult r;
        r.src = "shodan";
        r.ok = true;
        r.raw = Json.emptyObject;
        r.ttl = sourceTtl("shodan", s);
        return r;
    }
    return fromHttp("shodan", h, sourceTtl("shodan", s));
}
