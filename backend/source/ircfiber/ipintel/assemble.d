/**
 * Pure assembly of one `IpIntel` from raw source answers.
 *
 * Each source has one mapper (`applyX`) that reads the vendor's payload
 * shape and claims fields; `assemble` runs the mappers in ownership order
 * (`docs/IP_INTEL.md` §2, the Step 2 table) and a field, once claimed,
 * is never overwritten. The anonymiser flags are a vote: ≥2 answering
 * voters agreeing, or the authoritative Tor exit set, confirm a flag; a
 * single voter is stored as an unconfirmed vote (confidence 0.5).
 *
 * Imports only phobos and `vibe.data.json` — links into `ipintel-test`.
 */
module ircfiber.ipintel.assemble;

import std.algorithm : canFind;
import std.conv : to;
import std.datetime : DateTime, SysTime, UTC;
import std.string : indexOf, replace, split, startsWith, strip, toLower;
import vibe.data.json : Json;

import ircfiber.ipintel.record;

/// One source's answer (raw vendor JSON) or failure.
struct SourceResult {
    string src;
    bool ok;
    /// `timeout` | `quota` | `http<code>` | `parse` | `nokey` | free text.
    string error;
    Json raw;
    long fetchedAt;
    /// Cache TTL of `raw`, seconds.
    long ttl;
}

/// ASN number + operator from ipinfo's `org` string.
struct AsnInfo {
    /// True when at least the number or the operator name is known.
    bool ok;
    /// `AS39351`, carrying the `AS` prefix exactly as ipinfo writes it.
    string asn;
    /// Operator name, e.g. `31173 Services AB`.
    string name;
    /// Operator domain (never set by `asnFromOrg`).
    string domain;
}

/// Splits ipinfo's `org` field into number and operator:
/// `"AS39351 31173 Services AB"` → `AS39351` + `31173 Services AB`.
/// A value with no `AS<digits>` head (`"Mullvad VPN AB"`) is all operator.
AsnInfo asnFromOrg(string org) @safe pure {
    AsnInfo a;
    const s = org.strip();
    if (!s.length) return a;
    const sp = s.indexOf(' ');
    const head = sp < 0 ? s : s[0 .. sp];
    bool asHead = head.length > 2 && head[0 .. 2] == "AS";
    if (asHead)
        foreach (ch; head[2 .. $])
            if (ch < '0' || ch > '9') { asHead = false; break; }
    if (asHead) {
        a.asn = head;
        a.name = sp < 0 ? "" : s[sp + 1 .. $].strip();
    } else {
        a.name = s;
    }
    a.ok = a.asn.length > 0 || a.name.length > 0;
    return a;
}

/// `"39351"` / `39351` → `"AS39351"`; `"AS39351"` unchanged; `""` stays empty.
string asnLabel(string n) @safe pure {
    const s = n.strip();
    if (!s.length) return "";
    if (s.toLower().startsWith("as")) return "AS" ~ s[2 .. $];
    return "AS" ~ s;
}

/// `"2026-06-26T10:00:00Z"`, `"2026-06-26 10:00:00"`, `"2026-06-26"` → unix ms; 0 when unparsable.
long isoToMs(string iso) @safe {
    auto s = iso.strip();
    if (!s.length) return 0;
    if (s.length > 19) s = s[0 .. 19];
    if (s.length == 10) s ~= "T00:00:00";
    s = s.replace(" ", "T");
    try return SysTime(DateTime.fromISOExtString(s), UTC()).toUnixTime!long * 1000;
    catch (Exception) return 0;
}

/// Field claimer: the first source to supply a value owns the field.
private struct Claim {
    IpIntel* r;
    string src;
    long at, ttl;

    bool take(string key) @safe {
        if (key in r.provenance) return false;
        r.provenance[key] = SourceMark(src, at, ttl, 1, null);
        return true;
    }

    void str(string key, ref string field, string value) @safe {
        const v = value.strip();
        if (!v.length) return;
        if (take(key)) field = v;
    }
}

private Claim claim(ref IpIntel r, string src, long at, long ttl) @trusted {
    return Claim(&r, src, at, ttl);
}

// ── per-source mappers ───────────────────────────────────────────────

/// ipinfo Core `/<ip>/json`: geo + hostname (+ bogon).
void applyIpinfo(ref IpIntel r, Json j, long at, long ttl) @safe {
    if (j.type != Json.Type.object) return;
    auto c = claim(r, "ipinfo", at, ttl);
    if (jbool(j, "bogon")) { if (c.take("identity.isBogon")) r.identity.isBogon = true; }
    c.str("identity.hostname", r.identity.hostname, jstr(j, "hostname"));
    c.str("geo.city", r.geo.city, jstr(j, "city"));
    c.str("geo.region", r.geo.region, jstr(j, "region"));
    c.str("geo.countryCode", r.geo.countryCode, jstr(j, "country"));
    c.str("geo.timezone", r.geo.timezone, jstr(j, "timezone"));
    auto loc = jstr(j, "loc").split(',');
    double lat = double.nan, lon = double.nan;
    if (loc.length == 2) {
        try { lat = loc[0].strip().to!double; lon = loc[1].strip().to!double; }
        catch (Exception) { lat = double.nan; lon = double.nan; }
    } else {
        lat = jdouble(j, "latitude");
        lon = jdouble(j, "longitude");
    }
    if (lat == lat && lon == lon) {
        if (c.take("geo.latitude")) r.geo.latitude = lat;
        if (c.take("geo.longitude")) r.geo.longitude = lon;
    }
}

/// ipinfo `org` (`"AS39351 31173 Services AB"`) as the last-resort ASN owner.
void applyIpinfoOrg(ref IpIntel r, Json j, long at, long ttl) @safe {
    if (j.type != Json.Type.object) return;
    auto a = asnFromOrg(jstr(j, "org"));
    if (!a.ok) return;
    auto c = claim(r, "ipinfo", at, ttl);
    c.str("network.asn", r.network.asn, a.asn);
    c.str("network.asName", r.network.asName, a.name);
}

/// The per-IP object inside a proxycheck answer (`{"status":"ok","<ip>":{…}}`).
private Json proxycheckEntry(Json j, string ip) @trusted {
    if (j.type != Json.Type.object) return Json(null);
    auto e = j[ip];
    if (e.type == Json.Type.object) return e;
    foreach (string k, Json v; j)
        if (v.type == Json.Type.object && k != "status") return v;
    return Json(null);
}

/// proxycheck v3: geo, hostname, ASN/prefix, network type, risk, vendor sightings.
void applyProxycheck(ref IpIntel r, Json j, long at, long ttl) @safe {
    auto e = proxycheckEntry(j, r.identity.ip);
    if (e.type != Json.Type.object) return;
    auto c = claim(r, "proxycheck", at, ttl);
    auto net = e["network"];
    auto loc = e["location"];
    auto det = e["detections"];
    c.str("identity.hostname", r.identity.hostname, jstr(net, "hostname"));
    c.str("identity.prefix", r.identity.prefix, jstr(net, "range"));
    c.str("network.asn", r.network.asn, asnLabel(jstr(net, "asn")));
    c.str("network.asName", r.network.asName, jstr(net, "provider"));
    c.str("classification.networkType", r.classification.networkType, jstr(net, "type").toLower());
    c.str("geo.city", r.geo.city, jstr(loc, "city_name"));
    c.str("geo.region", r.geo.region, jstr(loc, "region_name"));
    c.str("geo.regionCode", r.geo.regionCode, jstr(loc, "region_code"));
    c.str("geo.countryCode", r.geo.countryCode, jstr(loc, "country_code"));
    c.str("geo.continentCode", r.geo.continentCode, jstr(loc, "continent_code"));
    c.str("geo.timezone", r.geo.timezone, jstr(loc, "timezone"));
    const lat = jdouble(loc, "latitude"), lon = jdouble(loc, "longitude");
    if (lat == lat && lon == lon) {
        if (c.take("geo.latitude")) r.geo.latitude = lat;
        if (c.take("geo.longitude")) r.geo.longitude = lon;
    }
    if (det.type == Json.Type.object) {
        if (det["risk"].type == Json.Type.int_ || det["risk"].type == Json.Type.float_) {
            if (c.take("reputation.riskScore")) r.reputation.riskScore = cast(int) jlong(det, "risk");
        }
        const fs = isoToMs(jstr(det, "first_seen"));
        const ls = isoToMs(jstr(det, "last_seen"));
        const ts = jlong(det, "times_seen");
        if (fs > 0 && c.take("reputation.vendorFirstSeen")) r.reputation.vendorFirstSeen = fs;
        if (ls > 0 && c.take("reputation.vendorLastSeen")) r.reputation.vendorLastSeen = ls;
        if (ts > 0 && c.take("reputation.timesSeen")) r.reputation.timesSeen = ts;
    }
}

/// proxycheck `network.organisation` as the fallback `org` (after ipapi.is).
void applyProxycheckOrg(ref IpIntel r, Json j, long at, long ttl) @safe {
    auto e = proxycheckEntry(j, r.identity.ip);
    if (e.type != Json.Type.object) return;
    auto c = claim(r, "proxycheck", at, ttl);
    c.str("network.org", r.network.org, jstr(e["network"], "organisation"));
}

/// ipapi.is: geo, ASN, operator details, abuse e-mail (fallback), rir (fallback).
void applyIpapiIs(ref IpIntel r, Json j, long at, long ttl) @safe {
    if (j.type != Json.Type.object) return;
    auto c = claim(r, "ipapi_is", at, ttl);
    auto asn = j["asn"];
    auto loc = j["location"];
    auto company = j["company"];
    if (jbool(j, "is_bogon")) { if (c.take("identity.isBogon")) r.identity.isBogon = true; }
    c.str("network.asn", r.network.asn, asnLabel(jstr(asn, "asn")));
    c.str("network.asName", r.network.asName, jstr(asn, "org"));
    c.str("network.asDomain", r.network.asDomain, jstr(asn, "domain"));
    c.str("network.asType", r.network.asType, jstr(asn, "type").toLower());
    c.str("network.isp", r.network.isp, jstr(asn, "org"));
    c.str("network.org", r.network.org, jstr(company, "name"));
    c.str("network.rir", r.network.rir, jstr(j, "rir").toLower());
    c.str("geo.city", r.geo.city, jstr(loc, "city"));
    c.str("geo.region", r.geo.region, jstr(loc, "state"));
    c.str("geo.countryCode", r.geo.countryCode, jstr(loc, "country_code"));
    c.str("geo.continentCode", r.geo.continentCode, jstr(loc, "continent"));
    c.str("geo.timezone", r.geo.timezone, jstr(loc, "timezone"));
    const lat = jdouble(loc, "latitude"), lon = jdouble(loc, "longitude");
    if (lat == lat && lon == lon) {
        if (c.take("geo.latitude")) r.geo.latitude = lat;
        if (c.take("geo.longitude")) r.geo.longitude = lon;
    }
    bool euPresent;
    const eu = jboolPresent(loc, "is_eu_member", euPresent);
    if (euPresent && c.take("geo.isEu")) r.geo.isEu = eu;
    const abuse = jstr(j["abuse"], "email");
    if (abuse.length && c.take("contact.abuseEmail")) {
        r.contact.abuseEmail = abuse;
        r.contact.abuseSource = "ipapi_is";
    }
}

/// RIPEstat prefix-overview: the announced prefix and its origin AS.
void applyRipestatPrefix(ref IpIntel r, Json j, long at, long ttl) @safe {
    auto d = j.type == Json.Type.object ? j["data"] : Json(null);
    if (d.type != Json.Type.object) return;
    auto c = claim(r, "ripestat_prefix", at, ttl);
    const res = jstr(d, "resource");
    if (res.indexOf('/') > 0) c.str("identity.prefix", r.identity.prefix, res);
    auto asns = d["asns"];
    if (asns.type == Json.Type.array && asns.length > 0 && asns[0].type == Json.Type.object) {
        c.str("network.asn", r.network.asn, asnLabel(jstr(asns[0], "asn")));
        c.str("network.asName", r.network.asName, jstr(asns[0], "holder"));
    }
}

/// RIPEstat rpki-validation: `data.status`.
void applyRipestatRpki(ref IpIntel r, Json j, long at, long ttl) @safe {
    auto d = j.type == Json.Type.object ? j["data"] : Json(null);
    if (d.type != Json.Type.object) return;
    auto c = claim(r, "ripestat_rpki", at, ttl);
    c.str("network.rpki", r.network.rpki, jstr(d, "status").toLower());
}

/// RIPEstat abuse-contact-finder: first abuse contact; RIR as a fallback.
void applyRipestatAbuse(ref IpIntel r, Json j, long at, long ttl) @safe {
    auto d = j.type == Json.Type.object ? j["data"] : Json(null);
    if (d.type != Json.Type.object) return;
    auto c = claim(r, "ripestat_abuse", at, ttl);
    auto contacts = jstrings(d, "abuse_contacts");
    if (contacts.length && contacts[0].strip().length && c.take("contact.abuseEmail")) {
        r.contact.abuseEmail = contacts[0].strip();
        r.contact.abuseSource = "ripestat";
    }
    c.str("network.rir", r.network.rir, jstr(d, "authoritative_rir").toLower());
}

/// RDAP `ip/<ip>`: netname, assignment type, registration date, and the
/// RIR the adapter recorded from the bootstrap service host (`_rir`).
void applyRdap(ref IpIntel r, Json j, long at, long ttl) @trusted {
    if (j.type != Json.Type.object) return;
    auto c = claim(r, "rdap", at, ttl);
    c.str("network.netname", r.network.netname, jstr(j, "name"));
    c.str("network.assignment", r.network.assignment, jstr(j, "type"));
    c.str("network.rir", r.network.rir, jstr(j, "_rir"));
    auto events = j["events"];
    if (events.type == Json.Type.array) {
        foreach (e; events) {
            if (e.type != Json.Type.object) continue;
            if (jstr(e, "eventAction") != "registration") continue;
            auto date = jstr(e, "eventDate");
            if (date.length > 10) date = date[0 .. 10];
            c.str("network.allocatedAt", r.network.allocatedAt, date);
            break;
        }
    }
}

/// StopForumSpam: frequency, last seen, Tor-exit marker.
void applySfs(ref IpIntel r, Json j, long at, long ttl) @safe {
    auto ip = j.type == Json.Type.object ? j["ip"] : Json(null);
    if (ip.type != Json.Type.object) return;
    auto c = claim(r, "sfs", at, ttl);
    if (c.take("reputation.sfsFrequency")) r.reputation.sfsFrequency = cast(int) jlong(ip, "frequency");
    if (c.take("reputation.sfsLastSeen")) r.reputation.sfsLastSeen = jstr(ip, "lastseen");
    if (c.take("reputation.sfsTorExit")) r.reputation.sfsTorExit = jbool(ip, "torexit");
}

/// DNSBL adapters answer `{"listed":bool,"code":n}`; only a listing is recorded.
void applyDnsbl(ref IpIntel r, string src, Json j, long at, long ttl) @safe {
    if (j.type != Json.Type.object) return;
    auto c = claim(r, src, at, ttl);
    if (!c.take("reputation.dnsbl." ~ src)) return;
    if (jbool(j, "listed")) r.reputation.dnsbl ~= src ~ ":" ~ jlong(j, "code").to!string;
}

/// Shodan InternetDB (deep lookup only): ports, hostnames, tags, vulns.
void applyShodan(ref IpIntel r, Json j, long at, long ttl) @trusted {
    if (j.type != Json.Type.object) return;
    auto c = claim(r, "shodan", at, ttl);
    if (!c.take("infra")) return;
    auto ports = j["ports"];
    if (ports.type == Json.Type.array)
        foreach (p; ports) if (p.type == Json.Type.int_) r.infra.ports ~= cast(int) p.get!long;
    r.infra.hostnames = jstrings(j, "hostnames");
    r.infra.tags = jstrings(j, "tags");
    r.infra.vulns = jstrings(j, "vulns");
    if (r.infra.hostnames.length) c.str("identity.hostname", r.identity.hostname, r.infra.hostnames[0]);
}

// ── classification vote ──────────────────────────────────────────────

/// One voter's answers: flag → value, only for the flags it answered.
private struct Votes {
    string src;
    bool[string] flags;
}

/// Reads a voter's flags out of its raw payload; `null` src when the
/// payload carries no classification at all.
private Votes votesOf(const SourceResult sr, string ip) @safe {
    Votes v;
    v.src = sr.src;
    Json j = sr.raw;
    bool present;
    void flag(string name, Json o, string key) @safe {
        const b = jboolPresent(o, key, present);
        if (present) v.flags[name] = b;
    }
    switch (sr.src) {
        case "proxycheck": {
            auto e = proxycheckEntry(j, ip);
            auto det = e.type == Json.Type.object ? e["detections"] : Json(null);
            if (det.type != Json.Type.object) break;
            flag("isVpn", det, "vpn");
            flag("isProxy", det, "proxy");
            flag("isTor", det, "tor");
            flag("isHosting", det, "hosting");
            break;
        }
        case "ipapi_is":
            flag("isVpn", j, "is_vpn");
            flag("isProxy", j, "is_proxy");
            flag("isTor", j, "is_tor");
            flag("isHosting", j, "is_datacenter");
            flag("isMobile", j, "is_mobile");
            break;
        case "iphub": {
            auto pt = j.type == Json.Type.object ? j["proxyType"] : Json(null);
            if (pt.type == Json.Type.object) {
                flag("isProxy", pt, "proxy");
                flag("isTor", pt, "tor");
                flag("isHosting", pt, "hosting");
                flag("isRelay", pt, "relay");
                flag("isResidentialProxy", pt, "residentialProxy");
            }
            // block: 0 residential, 1 non-residential (hosting/proxy), 2 = mixed (no opinion).
            const block = jlong(j, "block");
            if (j.type == Json.Type.object && j["block"].type == Json.Type.int_ && block != 2) {
                if (!("isHosting" in v.flags)) v.flags["isHosting"] = block == 1;
                if (!("isProxy" in v.flags)) v.flags["isProxy"] = block == 1;
            }
            break;
        }
        default:
            break;
    }
    return v;
}

/// True when phase 2 (IPHub) should run: proxycheck and ipapi.is
/// disagree on any of isVpn/isProxy/isHosting, or only one of them answered.
bool needsTiebreak(const SourceResult[] results, string ip) @safe {
    Votes[] voters;
    foreach (ref sr; results) {
        if (!sr.ok || (sr.src != "proxycheck" && sr.src != "ipapi_is")) continue;
        auto v = votesOf(sr, ip);
        if (v.flags.length) voters ~= v;
    }
    if (voters.length < 2) return true;
    foreach (name; ["isVpn", "isProxy", "isHosting"]) {
        auto a = name in voters[0].flags;
        auto b = name in voters[1].flags;
        if (a is null || b is null) return true;
        if (*a != *b) return true;
    }
    return false;
}

private void applyVotes(ref IpIntel r, const SourceResult[] results, bool torExit, long now) @safe {
    Votes[] voters;
    long at = now, ttl;
    foreach (ref sr; results) {
        if (!sr.ok) continue;
        if (sr.src != "proxycheck" && sr.src != "ipapi_is" && sr.src != "iphub") continue;
        auto v = votesOf(sr, r.identity.ip);
        if (!v.flags.length) continue;
        voters ~= v;
        if (sr.fetchedAt > 0 && sr.fetchedAt < at) at = sr.fetchedAt;
        if (sr.ttl > 0 && (ttl == 0 || sr.ttl < ttl)) ttl = sr.ttl;
    }
    static immutable names = ["isVpn", "isProxy", "isTor", "isRelay", "isHosting", "isResidentialProxy", "isMobile"];
    foreach (name; names) {
        SourceMark m;
        m.at = at;
        m.ttl = ttl;
        int answering, yes;
        foreach (ref v; voters) {
            if (auto f = name in v.flags) {
                answering++;
                if (*f) yes++;
                m.votes[v.src] = *f ? "true" : "false";
            }
        }
        const authoritative = name == "isTor" && torExit;
        if (authoritative) {
            m.votes["torexits"] = "true";
            m.src = "torexits";
            m.ttl = ttl ? ttl : 10_800;
        }
        if (!answering && !authoritative) continue;
        bool value;
        if (authoritative) {
            value = true;
            m.confidence = 1;
        } else if (answering == 1) {
            value = false;
            m.confidence = 0.5;
            m.src = voters.length ? firstVoter(voters, name) : "";
        } else {
            value = yes >= 2;
            const agreeing = value ? yes : answering - yes;
            m.confidence = cast(double) agreeing / answering;
            m.src = firstVoter(voters, name);
        }
        setFlag(r.classification, name, value);
        r.provenance["classification." ~ name] = m;
    }
}

private string firstVoter(const Votes[] voters, string name) @safe pure {
    foreach (ref v; voters) if (name in v.flags) return v.src;
    return "";
}

private void setFlag(ref IpClassification c, string name, bool v) @safe pure nothrow {
    switch (name) {
        case "isVpn": c.isVpn = v; break;
        case "isProxy": c.isProxy = v; break;
        case "isTor": c.isTor = v; break;
        case "isRelay": c.isRelay = v; break;
        case "isHosting": c.isHosting = v; break;
        case "isResidentialProxy": c.isResidentialProxy = v; break;
        case "isMobile": c.isMobile = v; break;
        default: break;
    }
}

/// `classification.vpnOperator`: proxycheck `operator.name` when it
/// detected a VPN/Tor, else ipapi.is `vpn.service`.
private void applyOperator(ref IpIntel r, const SourceResult[] results) @safe {
    foreach (ref sr; results) {
        if (!sr.ok || sr.src != "proxycheck") continue;
        auto e = proxycheckEntry(sr.raw, r.identity.ip);
        if (e.type != Json.Type.object) continue;
        auto det = e["detections"];
        if (jbool(det, "vpn") || jbool(det, "tor")) {
            auto c = claim(r, sr.src, sr.fetchedAt, sr.ttl);
            c.str("classification.vpnOperator", r.classification.vpnOperator, jstr(e["operator"], "name"));
        }
    }
    foreach (ref sr; results) {
        if (!sr.ok || sr.src != "ipapi_is" || sr.raw.type != Json.Type.object) continue;
        auto c = claim(r, sr.src, sr.fetchedAt, sr.ttl);
        c.str("classification.vpnOperator", r.classification.vpnOperator, jstr(sr.raw["vpn"], "service"));
    }
}

// ── assembly ─────────────────────────────────────────────────────────

private const(SourceResult)* find(const SourceResult[] results, string src) @trusted pure nothrow {
    foreach (ref sr; results) if (sr.ok && sr.src == src) return &sr;
    return null;
}

/// Builds the record for `ip` from every `ok` result, in ownership order.
/// `!ok` results land in `degraded` as `"<src>:<error>"`.
IpIntel assemble(string ip, string group, const SourceResult[] results, bool torExit, long nowMs) @safe {
    IpIntel r;
    r.identity.ip = ip;
    r.identity.ipVersion = ip.indexOf(':') >= 0 ? 6 : 4;
    r.identity.group = group;
    r.assembledAt = nowMs;

    void run(string src, void function(ref IpIntel, Json, long, long) @safe f) @safe {
        if (auto sr = find(results, src)) f(r, sr.raw, sr.fetchedAt ? sr.fetchedAt : nowMs, sr.ttl);
    }
    run("ripestat_prefix", &applyRipestatPrefix);
    run("ipinfo", &applyIpinfo);
    run("proxycheck", &applyProxycheck);
    run("rdap", &applyRdap);
    run("ripestat_abuse", &applyRipestatAbuse);
    run("ipapi_is", &applyIpapiIs);
    run("proxycheck", &applyProxycheckOrg);
    run("ipinfo", &applyIpinfoOrg);
    run("ripestat_rpki", &applyRipestatRpki);
    run("sfs", &applySfs);
    foreach (src; ["dronebl", "efnetrbl"])
        if (auto sr = find(results, src)) applyDnsbl(r, src, sr.raw, sr.fetchedAt ? sr.fetchedAt : nowMs, sr.ttl);
    run("shodan", &applyShodan);
    applyVotes(r, results, torExit, nowMs);
    applyOperator(r, results);

    foreach (ref sr; results)
        if (!sr.ok) r.degraded ~= sr.src ~ ":" ~ (sr.error.length ? sr.error : "failed");
    return r;
}
