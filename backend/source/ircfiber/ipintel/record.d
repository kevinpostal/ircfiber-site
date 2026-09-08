/**
 * The canonical IP-intelligence record (`docs/IP_INTEL.md` §2).
 *
 * One `IpIntel` per address, assembled from many sources by
 * `ircfiber.ipintel.assemble`. Every set field carries a `SourceMark` in
 * `provenance` (key `"<group>.<field>"`): a field without provenance is
 * never displayed — no silent defaults, no "unknown" rendered as fact.
 *
 * This module imports only phobos and `vibe.data.json` so it links into
 * the pure test configuration (`ipintel-test`).
 */
module ircfiber.ipintel.record;

import std.conv : to;
import std.math : isNaN;
import vibe.data.json : Json;

/// Who supplied a field, when, for how long — and, for the voted
/// classification flags, who said what.
struct SourceMark {
    /// Source id (`ipinfo`, `proxycheck`, `ripestat_prefix`, …).
    string src;
    /// Fetch time (unix ms).
    long at;
    /// Source TTL, seconds.
    long ttl;
    /// 1 for single-owner fields; for voted flags, agreeing ÷ answering
    /// (0.5 = exactly one voter answered → "unconfirmed").
    double confidence = 1;
    /// Voted fields only: source → "true" / "false".
    string[string] votes;
}

/// The address itself and how we group it.
struct IpIdentity {
    string ip;
    int ipVersion;
    /// BGP-announced prefix (display only; bans use `group`).
    string prefix;
    /// FiberEye's ban/flood key: exact v4 address, v6 `/64`.
    string group;
    /// rDNS, when a source supplied it.
    string hostname;
    bool isBogon;
}

/// Autonomous system and registry data.
struct IpNetwork {
    string asn, asName, asDomain, asType, isp, org, rir, allocatedAt, netname, assignment, rpki;
}

/// Location. Coordinates are stored but never printed to `#staff`.
struct IpGeo {
    string countryCode, continentCode, region, regionCode, city, timezone;
    double latitude = double.nan, longitude = double.nan;
    bool isEu;
}

/// Voted anonymiser flags plus the operator behind them.
struct IpClassification {
    bool isVpn, isProxy, isTor, isRelay, isHosting, isResidentialProxy, isMobile;
    /// proxycheck `operator.name` / ipapi.is `vpn.service`.
    string vpnOperator;
    /// proxycheck `network.type`, lower-cased: hosting | residential | business | "".
    string networkType;
}

/// Vendor reputation plus our own sighting counters.
struct IpReputation {
    /// proxycheck 0–100; -1 = unknown.
    int riskScore = -1;
    int sfsFrequency;
    string sfsLastSeen;
    bool sfsTorExit;
    /// `"dronebl:<code>"`, `"efnetrbl:<code>"` — only when listed.
    string[] dnsbl;
    long vendorFirstSeen, vendorLastSeen, timesSeen;
    /// OUR sightings (FiberEye), not a vendor's.
    long firstSeen, lastSeen, sessionCount;
}

/// Abuse contact for the range.
struct IpContact {
    string abuseEmail;
    string abuseSource;
}

/// Shodan InternetDB — deep lookup only, internal use only.
struct IpInfra {
    int[] ports;
    string[] hostnames;
    string[] tags;
    string[] vulns;
}

/// The assembled record.
struct IpIntel {
    IpIdentity identity;
    IpNetwork network;
    IpGeo geo;
    IpClassification classification;
    IpReputation reputation;
    IpContact contact;
    IpInfra infra;
    /// key = `"<group>.<field>"`, e.g. `"classification.isVpn"`, `"geo.city"`.
    SourceMark[string] provenance;
    /// `"<src>:<reason>"` — timeout | quota | http<code> | parse | nokey.
    string[] degraded;
    int schemaVersion = 1;
    long assembledAt;

    /// True when `provenanceKey` has a source — i.e. the field is renderable.
    bool has(string provenanceKey) const @safe pure nothrow {
        return (provenanceKey in provenance) !is null;
    }

    /// `"vpn(Mullvad)+tor+hosting"` of the confirmed flags; `""` when none.
    string flagsLabel() const @safe pure {
        string s;
        void add(string name) {
            if (s.length) s ~= "+";
            s ~= name;
        }
        if (classification.isVpn)
            add(classification.vpnOperator.length ? "vpn(" ~ classification.vpnOperator ~ ")" : "vpn");
        if (classification.isProxy) add("proxy");
        if (classification.isTor) add("tor");
        if (classification.isRelay) add("relay");
        if (classification.isHosting) add("hosting");
        if (classification.isResidentialProxy) add("residential-proxy");
        if (classification.isMobile) add("mobile");
        return s;
    }

    /// Nested shape of `docs/IP_INTEL.md` §2. NaN coordinates are omitted.
    Json toJson() const @safe {
        auto j = Json.emptyObject;
        auto id = Json.emptyObject;
        id["ip"] = Json(identity.ip);
        id["ipVersion"] = Json(identity.ipVersion);
        id["prefix"] = Json(identity.prefix);
        id["group"] = Json(identity.group);
        id["hostname"] = Json(identity.hostname);
        id["isBogon"] = Json(identity.isBogon);
        j["identity"] = id;

        auto n = Json.emptyObject;
        n["asn"] = Json(network.asn);
        n["asName"] = Json(network.asName);
        n["asDomain"] = Json(network.asDomain);
        n["asType"] = Json(network.asType);
        n["isp"] = Json(network.isp);
        n["org"] = Json(network.org);
        n["rir"] = Json(network.rir);
        n["allocatedAt"] = Json(network.allocatedAt);
        n["netname"] = Json(network.netname);
        n["assignment"] = Json(network.assignment);
        n["rpki"] = Json(network.rpki);
        j["network"] = n;

        auto g = Json.emptyObject;
        g["countryCode"] = Json(geo.countryCode);
        g["continentCode"] = Json(geo.continentCode);
        g["region"] = Json(geo.region);
        g["regionCode"] = Json(geo.regionCode);
        g["city"] = Json(geo.city);
        g["timezone"] = Json(geo.timezone);
        if (!isNaN(geo.latitude)) g["latitude"] = Json(geo.latitude);
        if (!isNaN(geo.longitude)) g["longitude"] = Json(geo.longitude);
        g["isEu"] = Json(geo.isEu);
        j["geo"] = g;

        auto c = Json.emptyObject;
        c["isVpn"] = Json(classification.isVpn);
        c["isProxy"] = Json(classification.isProxy);
        c["isTor"] = Json(classification.isTor);
        c["isRelay"] = Json(classification.isRelay);
        c["isHosting"] = Json(classification.isHosting);
        c["isResidentialProxy"] = Json(classification.isResidentialProxy);
        c["isMobile"] = Json(classification.isMobile);
        c["vpnOperator"] = Json(classification.vpnOperator);
        c["networkType"] = Json(classification.networkType);
        j["classification"] = c;

        auto r = Json.emptyObject;
        r["riskScore"] = Json(reputation.riskScore);
        r["sfsFrequency"] = Json(reputation.sfsFrequency);
        r["sfsLastSeen"] = Json(reputation.sfsLastSeen);
        r["sfsTorExit"] = Json(reputation.sfsTorExit);
        r["dnsbl"] = stringArray(reputation.dnsbl);
        r["vendorFirstSeen"] = Json(reputation.vendorFirstSeen);
        r["vendorLastSeen"] = Json(reputation.vendorLastSeen);
        r["timesSeen"] = Json(reputation.timesSeen);
        r["firstSeen"] = Json(reputation.firstSeen);
        r["lastSeen"] = Json(reputation.lastSeen);
        r["sessionCount"] = Json(reputation.sessionCount);
        j["reputation"] = r;

        auto ct = Json.emptyObject;
        ct["abuseEmail"] = Json(contact.abuseEmail);
        ct["abuseSource"] = Json(contact.abuseSource);
        j["contact"] = ct;

        auto inf = Json.emptyObject;
        auto ports = Json.emptyArray;
        foreach (p; infra.ports) ports ~= Json(p);
        inf["ports"] = ports;
        inf["hostnames"] = stringArray(infra.hostnames);
        inf["tags"] = stringArray(infra.tags);
        inf["vulns"] = stringArray(infra.vulns);
        j["infra"] = inf;

        auto prov = Json.emptyObject;
        foreach (key, m; provenance) {
            auto mj = Json.emptyObject;
            mj["src"] = Json(m.src);
            mj["at"] = Json(m.at);
            mj["ttl"] = Json(m.ttl);
            mj["confidence"] = Json(m.confidence);
            if (m.votes.length) {
                auto v = Json.emptyObject;
                foreach (s, vote; m.votes) v[s] = Json(vote);
                mj["votes"] = v;
            }
            prov[key] = mj;
        }
        j["provenance"] = prov;
        j["degraded"] = stringArray(degraded);
        j["schemaVersion"] = Json(schemaVersion);
        j["assembledAt"] = Json(assembledAt);
        return j;
    }

    /// Inverse of `toJson`; missing or mistyped fields keep their init value.
    static IpIntel fromJson(Json j) @trusted {
        IpIntel r;
        if (j.type != Json.Type.object) return r;
        auto id = j["identity"];
        r.identity.ip = jstr(id, "ip");
        r.identity.ipVersion = cast(int) jlong(id, "ipVersion");
        r.identity.prefix = jstr(id, "prefix");
        r.identity.group = jstr(id, "group");
        r.identity.hostname = jstr(id, "hostname");
        r.identity.isBogon = jbool(id, "isBogon");

        auto n = j["network"];
        r.network.asn = jstr(n, "asn");
        r.network.asName = jstr(n, "asName");
        r.network.asDomain = jstr(n, "asDomain");
        r.network.asType = jstr(n, "asType");
        r.network.isp = jstr(n, "isp");
        r.network.org = jstr(n, "org");
        r.network.rir = jstr(n, "rir");
        r.network.allocatedAt = jstr(n, "allocatedAt");
        r.network.netname = jstr(n, "netname");
        r.network.assignment = jstr(n, "assignment");
        r.network.rpki = jstr(n, "rpki");

        auto g = j["geo"];
        r.geo.countryCode = jstr(g, "countryCode");
        r.geo.continentCode = jstr(g, "continentCode");
        r.geo.region = jstr(g, "region");
        r.geo.regionCode = jstr(g, "regionCode");
        r.geo.city = jstr(g, "city");
        r.geo.timezone = jstr(g, "timezone");
        r.geo.latitude = jdouble(g, "latitude");
        r.geo.longitude = jdouble(g, "longitude");
        r.geo.isEu = jbool(g, "isEu");

        auto c = j["classification"];
        r.classification.isVpn = jbool(c, "isVpn");
        r.classification.isProxy = jbool(c, "isProxy");
        r.classification.isTor = jbool(c, "isTor");
        r.classification.isRelay = jbool(c, "isRelay");
        r.classification.isHosting = jbool(c, "isHosting");
        r.classification.isResidentialProxy = jbool(c, "isResidentialProxy");
        r.classification.isMobile = jbool(c, "isMobile");
        r.classification.vpnOperator = jstr(c, "vpnOperator");
        r.classification.networkType = jstr(c, "networkType");

        auto rp = j["reputation"];
        r.reputation.riskScore = rp.type == Json.Type.object && rp["riskScore"].type != Json.Type.undefined
            ? cast(int) jlong(rp, "riskScore") : -1;
        r.reputation.sfsFrequency = cast(int) jlong(rp, "sfsFrequency");
        r.reputation.sfsLastSeen = jstr(rp, "sfsLastSeen");
        r.reputation.sfsTorExit = jbool(rp, "sfsTorExit");
        r.reputation.dnsbl = jstrings(rp, "dnsbl");
        r.reputation.vendorFirstSeen = jlong(rp, "vendorFirstSeen");
        r.reputation.vendorLastSeen = jlong(rp, "vendorLastSeen");
        r.reputation.timesSeen = jlong(rp, "timesSeen");
        r.reputation.firstSeen = jlong(rp, "firstSeen");
        r.reputation.lastSeen = jlong(rp, "lastSeen");
        r.reputation.sessionCount = jlong(rp, "sessionCount");

        auto ct = j["contact"];
        r.contact.abuseEmail = jstr(ct, "abuseEmail");
        r.contact.abuseSource = jstr(ct, "abuseSource");

        auto inf = j["infra"];
        if (inf.type == Json.Type.object && inf["ports"].type == Json.Type.array)
            foreach (p; inf["ports"]) if (p.type == Json.Type.int_) r.infra.ports ~= cast(int) p.get!long;
        r.infra.hostnames = jstrings(inf, "hostnames");
        r.infra.tags = jstrings(inf, "tags");
        r.infra.vulns = jstrings(inf, "vulns");

        auto prov = j["provenance"];
        if (prov.type == Json.Type.object) {
            foreach (string key, Json mj; prov) {
                if (mj.type != Json.Type.object) continue;
                SourceMark m;
                m.src = jstr(mj, "src");
                m.at = jlong(mj, "at");
                m.ttl = jlong(mj, "ttl");
                const conf = jdouble(mj, "confidence");
                m.confidence = isNaN(conf) ? 1 : conf;
                auto v = mj["votes"];
                if (v.type == Json.Type.object)
                    foreach (string s, Json vote; v) if (vote.type == Json.Type.string) m.votes[s] = vote.get!string;
                r.provenance[key] = m;
            }
        }
        r.degraded = jstrings(j, "degraded");
        const sv = jlong(j, "schemaVersion");
        if (sv > 0) r.schemaVersion = cast(int) sv;
        r.assembledAt = jlong(j, "assembledAt");
        return r;
    }
}

// ── tolerant Json readers, shared with the mappers ───────────────────

/// String field or `""` (absent, null, wrong type). Numbers are stringified.
string jstr(Json o, string key) @safe {
    if (o.type != Json.Type.object) return "";
    auto v = o[key];
    switch (v.type) {
        case Json.Type.string: return v.get!string;
        case Json.Type.int_: return v.get!long.to!string;
        case Json.Type.float_: return v.get!double.to!string;
        default: return "";
    }
}

/// Integer field or 0. A numeric string is parsed; a float is truncated.
long jlong(Json o, string key) @safe {
    if (o.type != Json.Type.object) return 0;
    auto v = o[key];
    switch (v.type) {
        case Json.Type.int_: return v.get!long;
        case Json.Type.float_: return cast(long) v.get!double;
        case Json.Type.string:
            try return v.get!string.to!long;
            catch (Exception) return 0;
        default: return 0;
    }
}

/// Float field or NaN. A numeric string is parsed.
double jdouble(Json o, string key) @safe {
    if (o.type != Json.Type.object) return double.nan;
    auto v = o[key];
    switch (v.type) {
        case Json.Type.int_: return cast(double) v.get!long;
        case Json.Type.float_: return v.get!double;
        case Json.Type.string:
            try return v.get!string.to!double;
            catch (Exception) return double.nan;
        default: return double.nan;
    }
}

/// Bool field. `"yes"`/`"true"`/`1` count as true. `present` reports
/// whether the field carried a bool-ish value at all.
bool jbool(Json o, string key) @safe {
    bool present;
    return jboolPresent(o, key, present);
}

/// ditto
bool jboolPresent(Json o, string key, out bool present) @safe {
    present = false;
    if (o.type != Json.Type.object) return false;
    auto v = o[key];
    switch (v.type) {
        case Json.Type.bool_: present = true; return v.get!bool;
        case Json.Type.int_: present = true; return v.get!long != 0;
        case Json.Type.string: {
            const s = v.get!string;
            if (s == "yes" || s == "true" || s == "1") { present = true; return true; }
            if (s == "no" || s == "false" || s == "0") { present = true; return false; }
            return false;
        }
        default: return false;
    }
}

/// Array-of-strings field or `[]`.
string[] jstrings(Json o, string key) @trusted {
    string[] out_;
    if (o.type != Json.Type.object) return out_;
    auto v = o[key];
    if (v.type != Json.Type.array) return out_;
    foreach (e; v) if (e.type == Json.Type.string) out_ ~= e.get!string;
    return out_;
}

private Json stringArray(const string[] items) @safe {
    auto a = Json.emptyArray;
    foreach (s; items) a ~= Json(s);
    return a;
}
