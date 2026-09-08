module ipintel_test;

///
/// Unit tests for the IP-intelligence pure layer — the per-source mappers,
/// the ownership order, the classification vote, the record round trip
/// and the CIDR matcher. No Redis, Mongo or network needed:
///   dub --root=backend build --config=ipintel-test && ./backend/ipintel-test
///

import std.stdio : writeln, writefln;
import vibe.data.json : Json, parseJsonString;

import ircfiber.ipintel.assemble : SourceResult, assemble, asnFromOrg, isoToMs, needsTiebreak;
import ircfiber.ipintel.cidr : cidrContains;
import ircfiber.ipintel.record : IpIntel;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

private enum NOW = 1_757_300_000_000L;
private enum IP = "185.65.134.66";

private SourceResult ok(string src, string json, long ttl = 604_800) {
    return SourceResult(src, true, "", parseJsonString(json), NOW - 1000, ttl);
}

// Payload shapes as measured in docs/IP_INTEL.md §7/§9 (proxycheck v3
// keyed by the queried IP; ipapi.is flat; ipinfo Core; RIPEstat `data`).
private string proxycheck(string extra = "") {
    return `{"status":"ok","` ~ IP ~ `":{`
        ~ `"network":{"asn":"AS39351","range":"185.65.134.0/24","provider":"31173 Services AB",`
        ~ `"organisation":"31173 Services Netherlands","type":"Hosting"},`
        ~ `"location":{"country_code":"NL","continent_code":"EU","region_name":"North Holland",`
        ~ `"region_code":"NH","city_name":"Duivendrecht","latitude":52.34,"longitude":4.93,"timezone":"Europe/Amsterdam"},`
        ~ `"detections":{"proxy":false,"vpn":true,"tor":false,"hosting":true,"risk":73,`
        ~ `"first_seen":"2026-06-26T10:00:00Z","last_seen":"2026-09-08T04:30:00Z","times_seen":2379},`
        ~ `"operator":{"name":"Mullvad"}` ~ extra ~ `}}`;
}

private enum IPAPI = `{"ip":"` ~ IP ~ `","rir":"RIPE","is_bogon":false,"is_mobile":false,`
    ~ `"is_datacenter":true,"is_tor":false,"is_proxy":false,"is_vpn":true,`
    ~ `"company":{"name":"Mullvad VPN AB","domain":"mullvad.net","type":"hosting"},`
    ~ `"abuse":{"email":"abuse@mullvad.net"},"vpn":{"service":"Mullvad"},`
    ~ `"asn":{"asn":39351,"org":"31173 Services AB","domain":"31173.se","type":"hosting"},`
    ~ `"location":{"is_eu_member":true,"continent":"EU","country_code":"NL","state":"North Holland",`
    ~ `"city":"Amsterdam","latitude":52.37,"longitude":4.89,"timezone":"Europe/Amsterdam"}}`;

private enum IPINFO = `{"ip":"` ~ IP ~ `","city":"Amsterdam","region":"North Holland","country":"NL",`
    ~ `"loc":"52.3740,4.8897","org":"AS39351 31173 Services AB","timezone":"Europe/Amsterdam"}`;

private enum RIPE_PREFIX = `{"data":{"resource":"185.65.134.0/24","asns":[{"asn":39351,"holder":"ESAB-AS"}]}}`;
private enum RIPE_RPKI = `{"data":{"status":"valid"}}`;
private enum RIPE_ABUSE = `{"data":{"abuse_contacts":["abuse-cust-nl@31173.se"],"authoritative_rir":"ripe"}}`;
private enum RDAP = `{"name":"NET-31173-185-65-134-0-24","type":"ASSIGNED PA","_rir":"ripencc",`
    ~ `"events":[{"eventAction":"registration","eventDate":"2014-07-30T00:00:00Z"},{"eventAction":"last changed","eventDate":"2020-01-01T00:00:00Z"}]}`;

private void testVoteAgree() {
    // (a) proxycheck + ipapi.is both say VPN → confirmed, operator from proxycheck.
    auto r = assemble(IP, IP, [ok("proxycheck", proxycheck()), ok("ipapi_is", IPAPI)], false, NOW);
    check(r.classification.isVpn, "two agreeing voters confirm isVpn");
    check(r.classification.vpnOperator == "Mullvad", "operator from proxycheck");
    check(r.provenance["classification.isVpn"].confidence == 1, "full agreement → confidence 1");
    check(r.provenance["classification.isVpn"].votes["proxycheck"] == "true", "proxycheck vote recorded");
    check(r.provenance["classification.isVpn"].votes["ipapi_is"] == "true", "ipapi_is vote recorded");
    check(r.classification.isHosting, "hosting confirmed by both");
    check(!r.classification.isTor && r.provenance["classification.isTor"].confidence == 1,
        "two false votes confirm not-tor");
    check(!needsTiebreak([ok("proxycheck", proxycheck()), ok("ipapi_is", IPAPI)], IP),
        "agreeing voters need no IPHub tiebreak");
    check(r.degraded.length == 0, "no degraded sources");
}

private void testVoteSingle() {
    // (b) proxycheck alone → unconfirmed: flag false, confidence 0.5, vote kept.
    auto r = assemble(IP, IP, [ok("proxycheck", proxycheck())], false, NOW);
    check(!r.classification.isVpn, "single voter never confirms");
    auto m = r.provenance["classification.isVpn"];
    check(m.confidence == 0.5, "single voter → confidence 0.5");
    check(m.votes.length == 1 && m.votes["proxycheck"] == "true", "the lone vote is kept");
    check(m.src == "proxycheck", "mark names the voter");
    check(needsTiebreak([ok("proxycheck", proxycheck())], IP), "single voter → IPHub tiebreak");
    check(needsTiebreak([ok("proxycheck", proxycheck()),
        ok("ipapi_is", `{"is_vpn":false,"is_proxy":false,"is_datacenter":true,"is_tor":false}`)], IP),
        "disagreement on isVpn → IPHub tiebreak");
    // Operator still recorded (it is not a vote).
    check(r.classification.vpnOperator == "Mullvad", "operator does not need a vote");
    check(r.flagsLabel() == "", "unconfirmed flags never reach the label");
}

private void testTorAuthoritative() {
    // (c) Tor exit set overrides two false votes.
    auto r = assemble(IP, IP, [ok("proxycheck", proxycheck()), ok("ipapi_is", IPAPI)], true, NOW);
    check(r.classification.isTor, "Tor exit set is authoritative");
    auto m = r.provenance["classification.isTor"];
    check(m.src == "torexits" && m.confidence == 1, "tor mark names the set");
    check(m.votes["torexits"] == "true" && m.votes["proxycheck"] == "false", "dissenting votes kept");
    // Set alone, no voters at all.
    auto only = assemble(IP, IP, [], true, NOW);
    check(only.classification.isTor && only.has("classification.isTor"), "set alone confirms tor");
    check(!only.has("classification.isVpn"), "no voters → no isVpn provenance");
}

private void testOwnership() {
    // (d) ipinfo owns geo over proxycheck; RIPEstat owns ASN over proxycheck.
    auto r = assemble(IP, IP, [
        ok("proxycheck", proxycheck()), ok("ipinfo", IPINFO), ok("ipapi_is", IPAPI),
        ok("ripestat_prefix", RIPE_PREFIX), ok("ripestat_rpki", RIPE_RPKI),
        ok("ripestat_abuse", RIPE_ABUSE, 2_592_000), ok("rdap", RDAP, 2_592_000),
        ok("sfs", `{"success":1,"ip":{"frequency":9,"lastseen":"2026-05-26 10:00:00","torexit":1,"appears":1}}`, 86_400),
        ok("dronebl", `{"listed":false}`, 86_400), ok("efnetrbl", `{"listed":true,"code":3}`, 86_400),
        SourceResult("iphub", false, "nokey"),
    ], false, NOW);
    check(r.geo.city == "Amsterdam", "ipinfo city wins over proxycheck");
    check(r.provenance["geo.city"].src == "ipinfo", "geo.city provenance is ipinfo");
    check(r.geo.regionCode == "NH" && r.provenance["geo.regionCode"].src == "proxycheck",
        "a field ipinfo lacks falls through to proxycheck");
    check(r.geo.isEu && r.provenance["geo.isEu"].src == "ipapi_is", "isEu from ipapi.is");
    check(r.network.asn == "AS39351" && r.provenance["network.asn"].src == "ripestat_prefix",
        "RIPEstat owns the ASN");
    check(r.network.asName == "ESAB-AS", "RIPEstat holder is the AS name");
    check(r.identity.prefix == "185.65.134.0/24" && r.provenance["identity.prefix"].src == "ripestat_prefix",
        "RIPEstat owns the prefix");
    check(r.network.asDomain == "31173.se" && r.network.asType == "hosting", "ipapi.is owns domain/type");
    check(r.network.org == "Mullvad VPN AB" && r.provenance["network.org"].src == "ipapi_is",
        "ipapi.is company wins over proxycheck organisation");
    check(r.network.isp == "31173 Services AB", "isp is the AS operator");
    check(r.network.rpki == "valid", "rpki from RIPEstat");
    check(r.network.rir == "ripencc" && r.provenance["network.rir"].src == "rdap", "rdap owns rir");
    check(r.network.netname == "NET-31173-185-65-134-0-24" && r.network.assignment == "ASSIGNED PA",
        "rdap netname/assignment");
    check(r.network.allocatedAt == "2014-07-30", "rdap registration date, date part only");
    check(r.contact.abuseEmail == "abuse-cust-nl@31173.se" && r.contact.abuseSource == "ripestat",
        "RIPEstat abuse contact wins over ipapi.is");
    check(r.classification.networkType == "hosting", "network type lower-cased");
    check(r.reputation.riskScore == 73, "risk score");
    check(r.reputation.timesSeen == 2379 && r.reputation.vendorFirstSeen == isoToMs("2026-06-26T10:00:00Z"),
        "vendor sightings");
    check(r.reputation.sfsFrequency == 9 && r.reputation.sfsTorExit, "sfs fields");
    check(r.reputation.dnsbl == ["efnetrbl:3"], "only listings are recorded");
    check(r.degraded == ["iphub:nokey"], "failed source lands in degraded");
    check(!r.has("infra"), "no shodan → no infra provenance");
    check(r.identity.ipVersion == 4 && r.identity.group == IP, "identity basics");

    // Without RIPEstat, proxycheck owns the ASN; without both, ipinfo's org string.
    auto pc = assemble(IP, IP, [ok("proxycheck", proxycheck()), ok("ipinfo", IPINFO)], false, NOW);
    check(pc.network.asn == "AS39351" && pc.provenance["network.asn"].src == "proxycheck", "proxycheck ASN fallback");
    auto io = assemble(IP, IP, [ok("ipinfo", IPINFO)], false, NOW);
    check(io.network.asName == "31173 Services AB" && io.provenance["network.asName"].src == "ipinfo",
        "ipinfo org string is the last-resort ASN");
}

private void testRoundTrip() {
    // (e) toJson → fromJson equality on a full record.
    auto r = assemble(IP, IP, [
        ok("proxycheck", proxycheck()), ok("ipinfo", IPINFO), ok("ipapi_is", IPAPI),
        ok("ripestat_prefix", RIPE_PREFIX), ok("rdap", RDAP, 2_592_000),
        ok("shodan", `{"ports":[22,9030],"hostnames":["tor.example"],"tags":["tor"],"vulns":[]}`, 86_400),
        SourceResult("sfs", false, "timeout"),
    ], true, NOW);
    auto back = IpIntel.fromJson(parseJsonString(r.toJson().toString()));
    check(back == r, "record survives a JSON round trip");
    check(back.provenance["classification.isTor"].votes == r.provenance["classification.isTor"].votes,
        "votes survive the round trip");
    check(back.infra.ports == [22, 9030] && back.infra.hostnames == ["tor.example"], "infra survives");
    check(back.degraded == ["sfs:timeout"], "degraded survives");
    auto j = r.toJson();
    check(j["geo"]["latitude"].type == Json.Type.float_, "coordinates emitted when known");
    auto bare = IpIntel.init.toJson();
    check(bare["geo"]["latitude"].type == Json.Type.undefined, "NaN coordinates are omitted");
    // `IpIntel.init` never equals itself (NaN coordinates), so compare the JSON form.
    check(IpIntel.fromJson(bare).toJson().toString() == bare.toString(), "empty record round trips");
    check(IpIntel.fromJson(Json(null)).toJson().toString() == bare.toString(), "null is the empty record");
}

private void testCidr() {
    // (f)
    check(cidrContains("185.65.132.0/22", "185.65.134.66"), "v4 /22 contains");
    check(!cidrContains("185.65.132.0/22", "185.65.136.1"), "v4 /22 excludes the next block");
    check(!cidrContains("2001:db8::/32", "2001:db9::1"), "v6 /32 excludes");
    check(cidrContains("2001:db8::/32", "2001:db8:ffff::1"), "v6 /32 contains");
    check(cidrContains("2001:db8::1", "2001:0db8:0:0:0:0:0:1"), "bare v6 address is /128");
    check(cidrContains("0.0.0.0/0", "8.8.8.8"), "v4 /0 covers everything");
    check(!cidrContains("10.0.0.0/8", "2001:db8::1"), "mixed families never match");
    check(!cidrContains("10.0.0.0/33", "10.1.1.1"), "over-long mask is malformed");
    check(!cidrContains("junk", "10.1.1.1"), "garbage is malformed");
}

private void testFlagsLabel() {
    // (g)
    auto r = assemble(IP, IP, [ok("proxycheck", proxycheck()), ok("ipapi_is", IPAPI)], false, NOW);
    check(r.flagsLabel() == "vpn(Mullvad)+hosting", "flags label: " ~ r.flagsLabel());
    auto tor = assemble(IP, IP, [ok("proxycheck", proxycheck()), ok("ipapi_is", IPAPI)], true, NOW);
    check(tor.flagsLabel() == "vpn(Mullvad)+tor+hosting", "tor joins the label: " ~ tor.flagsLabel());
    check(IpIntel.init.flagsLabel() == "", "no flags → empty label");
}

private void testHelpers() {
    check(asnFromOrg("AS39351 31173 Services AB").asn == "AS39351", "asnFromOrg number");
    check(asnFromOrg("Mullvad VPN AB").asn == "" && asnFromOrg("Mullvad VPN AB").name == "Mullvad VPN AB",
        "asnFromOrg without AS head");
    check(isoToMs("2026-06-26T10:00:00Z") == 1_782_468_000_000L, "iso with Z");
    check(isoToMs("2026-06-26 10:00:00") == 1_782_468_000_000L, "iso with space");
    check(isoToMs("2026-06-26") == 1_782_432_000_000L, "date only");
    check(isoToMs("nope") == 0, "garbage date");
    // Private / bogon input still produces a bare record.
    auto priv = assemble("10.0.0.1", "10.0.0.1", [], false, NOW);
    check(priv.identity.ip == "10.0.0.1" && priv.provenance.length == 0, "no sources → no provenance");
}

void main() {
    testVoteAgree();
    testVoteSingle();
    testTorAuthoritative();
    testOwnership();
    testRoundTrip();
    testCidr();
    testFlagsLabel();
    testHelpers();
    if (failures) {
        writefln("%d check(s) failed", failures);
        import core.stdc.stdlib : exit;
        exit(1);
    }
    writeln("ipintel: all checks passed");
}
