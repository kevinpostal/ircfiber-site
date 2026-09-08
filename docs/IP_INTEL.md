# IP intelligence — provider study, canonical record, display spec

Scope: everything IRC Fiber knows about an IP address, where it comes from, how long we keep
it, and what each surface is allowed to show. Written to be implemented as-is; every provider
claim is marked **verified** (probed from this repo) or **documented** (provider's own page).

Consumers, in the order they matter:

| # | Consumer | Code | Volume | What it needs |
|---|---|---|---|---|
| 1 | Admin **Mullvad** page | `web/admin/api.d:apiMullvadStatus` | ~4 IPs, polled every few seconds | Is this exit really a Mullvad relay? Which operator/ASN/prefix does the world see? |
| 2 | **FiberLogs** `#staff` | `logs/geo.d`, `logs/format.d` | one lookup per *never-before-seen* signup/connect IP (7-day Redis cache) | One line of geo/ASN/anonymiser context for an oper |
| 3 | **FiberEye** | `fibereye/*`, `web/admin/fibereye.d` | every connect/quit, persisted in Mongo | Durable per-IP/per-prefix record for flood rules, strike escalation, Z-line masks, abuse reports |

Today we use exactly one source: an ipinfo token (Core `/<ip>/json` + Lite `/lite/<ip>`).
**Verified** limits of that token: no `asn` object, no `privacy` object, no `hostname`,
`ipinfo.io/AS<n>/json` → *"Token does not have access to this API"*. So we have geo + ASN and
**no anonymiser classification at all** — `GeoInfo.privacyFlags` (`logs/format.d`) is dead code.

---

## 1. Signup decision

### 1.1 Sign up now — free, no card, real gain

| Provider | Free quota | Gives us | Licence caveat |
|---|---|---|---|
| **proxycheck.io** (free key) | 1 000/day, ≤1 000 IPs per request; 100/day keyless | `detections.{proxy,vpn,tor,hosting,scraper}`, `confidence`, `first_seen`/`last_seen`, **`operator.name`** | Same features free and paid (documented) |
| **IPHub** Basic | 1 000/day, bulk ≤100 k IPs/request | `block` 0/1/2 — a ready-made ircd policy input — plus `proxyType.{proxy,tor,hosting,relay}` | Free tier: per-page checks, not global deny (documented) |
| **ipapi.is** (free key) | 1 000/day | `is_vpn/is_proxy/is_tor/is_datacenter/is_abuser`, `asn.{type,route,abuse}`, `company.type`, `abuse.{email,phone}` | Keyless returns none of the flags (**verified**); commercial grant unconfirmed |
| **MaxMind GeoLite2** (City+ASN, MMDB) | offline, 30 downloads/day | city/lat/lon/`accuracy_radius`, ASN — zero per-query cost, IP never leaves our infra | EULA: refresh ≤30 days (Tue+Fri releases), attribution, City "not recommended for commercial use" |
| **IP2Location LITE + IP2Proxy LITE** | offline, monthly | the only *free offline* `is_proxy`/`proxy_type` (VPN/TOR/PUB/RES) | Mandatory credit line in UI/docs; no redistribution |
| **PeeringDB** account | 40 req/min (20 anonymous) | ASN-level: IX presence, `info_type`, AS-SET, NOC/abuse roles | POC emails are personal data — internal only |
| **AbuseIPDB** free | 1 000/day | `abuseConfidenceScore`, `usageType`, `totalReports`, report excerpts + categories | **Non-commercial only** → admin page/triage, never a product feature |
| **GreyNoise** Community (business email) | 10/day keyless, 50/week keyed | `noise`/`riot`/`classification` — separates background scanners from legitimate SaaS | Research use; quota far below connect volume |
| **IPQualityScore** free | 1 000/month | `fraud_score`, `recent_abuse`, `abuse_velocity`, `active_vpn`/`active_tor` | Production use wants a paid plan |
| **Scamalytics** free | 5 000/month | `score`, `risk`, proxy/vpn/tor/datacenter | Production use wants a paid plan |

### 1.2 Use immediately — no account at all

| Source | Protocol / quota | Gives us | Status |
|---|---|---|---|
| **Team Cymru** `origin.asn.cymru.com`, `asn.cymru.com` | DNS TXT, cacheable, community fair use | ASN, **announced prefix**, registry, allocation date, AS name | **verified**: `39351 \| 185.65.134.0/24 \| SE \| ripencc \| 2014-07-30` |
| **RIPEstat** Data API | keyless HTTPS; register `sourceapp` above 1 000/day; 8 concurrent | `prefix-overview`, **`abuse-contact-finder`**, `rpki-validation`, `as-overview` | **verified**: `abuse=["abuse-cust-nl@31173.se"]`, `rpki=valid`, `block=RIPE NCC (ALLOCATED)` |
| **RIR RDAP** via IANA bootstrap | keyless HTTPS, per-RIR throttles | `name` (netname), `type` (ASSIGNED PA), `parentHandle`, `events[]`, entity roles incl. `abuse` | **verified** on `rdap.db.ripe.net`: `NET-31173-185-65-134-0-24`, parent `185.65.132.0/22` |
| **iptoasn.com** TSV | offline, hourly refresh, **PDDL public domain** | `range_start,range_end,ASN,country,AS_description` | documented; most permissive licence on this page |
| **DB-IP Lite** MMDB/CSV | offline, monthly, **CC-BY 4.0** | country/city/ASN second opinion | needs `IP Geolocation by DB-IP` credit where displayed |
| **Tor bulk exit list** | `check.torproject.org/torbulkexitlist`, ~40 min cadence | canonical Tor-exit set → O(1) local check | **verified**: 1 344 entries |
| **DroneBL** `dnsbl.dronebl.org` | DNSBL, free incl. commercial | IRC drones, spambots, open proxies, compromised routers | **verified**: 0/40 Tor exits listed → it is *not* a Tor/VPN list. Query octet order must be confirmed empirically (docs show forward order, classic DNSBLs reverse) |
| **EFnet RBL** `rbl.efnetrbl.org` | DNSBL | open proxies (7 d TTL), spamtraps, Tor nodes (10 d TTL) | reply-code table + commercial stance unconfirmed |
| **StopForumSpam** | keyless HTTPS, 20 000/day | `appears`, `frequency`, `lastseen`, `torexit`, `confidence` | **verified** on a Tor exit: `frequency=9 torexit=1 confidence=1.14`. Non-commercial licence wording — don't resell |
| **X4BNet/lists_vpn**, **ipverse/as-ip-blocks** | Git raw, CI-refreshed | offline VPN + datacenter CIDR sets; per-ASN prefix sets | zero quota, zero latency — the cheapest "is this hosting/VPN space" answer |
| **Shodan InternetDB** | keyless, ~1 req/s, **non-commercial** | `ports[]`, `cpes[]`, `hostnames[]`, `tags[]`, `vulns[]` | **verified**: Tor exit → `hostnames:["tor.teitel.net"] ports:[22,53,123,9030]` — port 9030 is the Tor dir port. Internal/admin only |
| **ipquery.io** | keyless, commercial use explicitly allowed, bulk ≤10 000 IPs | `risk.{is_vpn,is_tor,is_proxy,is_datacenter,risk_score}` | **verified but weak**: our Mullvad exit → `is_vpn=false is_datacenter=true`; a real Tor exit → `is_tor=false`. Corroborator only, never a sole voter |

### 1.3 Paid — only these are defensible

| Option | Price | Buys | Verdict |
|---|---|---|---|
| **ipapi.is** Basic | $20/mo, 20 k/day | the full flag set at FiberEye volume | **first paid step** if free quotas bind |
| **ipgeolocation.io** Starter | $19/mo | `security.{threat_score,is_*,vpn_provider_names,vpn_confidence_score,vpn_last_seen}` | best *evidence* model (confidence + recency + provider name); confirm plan gating at signup |
| **MaxMind GeoIP2 Anonymous-IP** | ~$150–300/mo (unconfirmed, ask sales) | offline `is_anonymous_vpn`, `is_hosting_provider`, `is_public_proxy`, `is_residential_proxy`, `is_tor_exit_node` | the privacy-cleanest answer — user IPs never leave our infra. Buy when budget exists |
| **Spur.us** | from $125/mo, no free tier | best-in-class VPN/proxy operator attribution | not now; proxycheck already names `Mullvad` for free |
| **ip-api.com PRO** | €13.30/mo | `proxy` + `hosting` + `reverse` (rDNS) | cheapest paid flags, but no `vpn`/`tor` and free tier is disqualified: **verified** HTTPS → `403` (HTTP-only) and non-commercial |

### 1.4 Skip

`ipapi.co` (no risk flags at any tier, up to $399/mo) · `ip.guide` (no docs, no terms, no flags —
**verified** working but unusable as a dependency) · `BGPView` (no findable ToS, unpublished
limits; **verified** `HTTP 000` from here) · `Cloudflare Radar` (aggregate trends, not per-IP) ·
raw `RIS`/`RouteViews` MRT (multi-GB to re-derive what Cymru/RIPEstat already answer) ·
`Spamhaus` public mirrors (must query from our own recursor or a DQS key — public resolvers get
`127.255.255.254`; free DQS key is fine, paid needed for commercial).

### 1.5 The one number that decides everything

Consumer 2 and 3 only pay for a lookup on a **cache miss**, i.e. per *unique new* IP:

```
daily paid lookups ≈ unique new IPs/day × (voters per IP)
```

Two free-key voters (proxycheck + IPHub) = 1 000/day each ⇒ **≈500 new IPs/day** before either
binds, with the offline sets (IP2Proxy/X4BNet/GeoLite2/iptoasn/Tor list) answering the rest at
zero cost. Cross that line and the answer is ipapi.is Basic at $20/mo, not more free accounts —
multi-accounting to raise quota is a ToS breach at AbuseIPDB and most others.

---

## 2. Canonical record

Field groups follow existing norms (MaxMind GeoIP2 `traits`, ipinfo `as`/`anonymous`/`abuse`,
MISP `asn`/`geolocation`/`ip-port`, STIX 2.1 `autonomous-system`, RDAP RFC 9083) so the record
maps onto other tooling instead of inventing names.

```jsonc
{
  "identity": {
    "ip": "185.65.134.66",
    "ipVersion": 4,
    "prefix": "185.65.134.0/24",        // Cymru / RDAP / iptoasn — the BGP-announced prefix
    "group": "185.65.134.0/24",         // ban/flood grouping key: v4 → prefix, v6 → /64
    "hostname": "tor.teitel.net",       // rDNS; null unless a source supplies it
    "isBogon": false
  },
  "network": {
    "asn": "AS39351",
    "asName": "31173 Services AB",
    "asDomain": "31173.se",
    "asType": "hosting",                // isp|hosting|business|education|government
    "isp": "31173 Services AB",
    "org": "31173 Services Netherlands",
    "rir": "ripencc",
    "allocatedAt": "2014-07-30",
    "netname": "NET-31173-185-65-134-0-24",   // RDAP `name`
    "assignment": "ASSIGNED PA",              // RDAP `type`
    "rpki": "valid",                          // valid|invalid|unknown (RIPEstat)
    "ixPresence": ["AMS-IX"],                 // PeeringDB, ASN-keyed
    "isAnycast": false
  },
  "geo": {
    "countryCode": "NL", "continentCode": "EU",
    "region": "North Holland", "regionCode": "NH",
    "city": "Amsterdam",
    "latitude": 52.374, "longitude": 4.8897, "accuracyRadius": 50,
    "timezone": "Europe/Amsterdam",
    "isEu": true
  },
  "classification": {
    "isVpn": true, "vpnOperator": "Mullvad",  // proxycheck `operator.name`
    "isProxy": true, "proxyType": "VPN",
    "isTor": false, "isTorExit": false,
    "isRelay": false,                          // iCloud Private Relay / Google One VPN
    "isHosting": true, "isResidentialProxy": false,
    "isMobile": false, "isSatellite": false,
    "isScanner": false, "isRiot": false        // GreyNoise noise/riot
  },
  "reputation": {
    "abuseScore": 0,                  // 0-100, AbuseIPDB confidence
    "riskScore": 73,                  // 0-100, proxycheck/IPQS/Scamalytics consensus
    "reportCount": 0, "lastReportedAt": null,
    "dnsbl": ["dronebl:none", "efnet:none", "sfs:appears=0"],
    "firstSeen": "2026-08-14T09:12:03Z",   // OUR first sighting (FiberEye), not a vendor's
    "lastSeen":  "2026-09-08T04:31:55Z",
    "sessionCount": 12, "strikes": 0, "zlined": false
  },
  "contact": {
    "abuseEmail": "abuse-cust-nl@31173.se",   // RIPEstat abuse-contact-finder
    "abuseSource": "ripestat"
    // RDAP registrant/admin/tech vCards are NEVER stored here — handles only, internal use
  },
  "provenance": {
    "sources": {
      "network.asn":            { "src": "cymru",      "at": "2026-09-08T04:30:00Z", "ttl": 604800 },
      "geo.city":               { "src": "geolite2",   "at": "2026-09-08T04:30:00Z", "ttl": 604800 },
      "classification.isVpn":   { "src": "proxycheck", "at": "2026-09-08T04:30:01Z", "ttl": 604800,
                                  "votes": { "proxycheck": true, "iphub": true, "ipquery": false },
                                  "confidence": 0.67 },
      "reputation.abuseScore":  { "src": "abuseipdb",  "at": "2026-09-08T04:30:02Z", "ttl": 86400 }
    },
    "degraded": [],                 // sources that failed or were quota-blocked this fetch
    "schemaVersion": 1
  }
}
```

### 2.1 Rules the schema enforces

1. **Every fact carries its source, timestamp and TTL.** A field with no `provenance` entry is
   not displayed — no silent defaults, no "unknown" rendered as fact. This is the rule the
   current Mullvad page breaks with its `185.206.149.176` placeholder block
   (`web/admin/api.d`), which fabricates a city and an IP.
2. **Classification is a vote, not a value.** `isVpn` &c. are set only when ≥2 independent
   voters agree (offline range set / proxycheck / IPHub / ipapi.is), with `confidence` =
   agreeing ÷ answering. One voter ⇒ store the vote, show it as *unconfirmed*.
   Justified by measurement: ipquery.io called a live Tor exit `is_tor=false` and our Mullvad
   exit `is_vpn=false`; proxycheck got both right (`type=VPN operator=Mullvad`, `type=TOR risk=100`).
3. **`identity.group` is the enforcement key**, not the IP: v6 → `/64` (as FiberEye already
   does), v4 → the announced prefix from Cymru. Bans and flood counters live on the group.
4. **Registry country ≠ location.** Cymru/RDAP `country` is registration data; it never
   populates `geo.countryCode` (Team Cymru documents this explicitly).
5. **`reputation.firstSeen`/`lastSeen` are ours** — our own sightings, so the page can say
   "known IP, 12 sessions" without asking a vendor.

### 2.2 Storage

| Store | Key | Contents | TTL |
|---|---|---|---|
| Redis | `irc:ipinfo:core:<ip>` | raw ipinfo Core answer | 7 d (`IRCFIBER_LOGS_GEO_TTL`) — also the FiberLogs first-sighting marker |
| Redis | `irc:ipinfo:asn:<ip>` | raw ipinfo Lite answer | 7 d (shipped) |
| Redis | `irc:ipintel:<src>:<ip>` | one raw vendor answer per source | 7 d flags / 24 h reputation / 30 d registry |
| Redis | `irc:ipintel:v1:<ip>` | assembled record above | 1 h (recompute is cheap once sources are cached) |
| Mongo | `fibereye_ips._id = <ip>` | record + our sighting counters | retention per §4 |
| Mongo | `ipintel_groups._id = <prefix\|/64>` | rolled-up counters, strikes | longer than raw IPs |
| Local files | `/var/lib/ircfiber/ipintel/` | GeoLite2 + DB-IP + IP2Proxy MMDB, iptoasn TSV, Tor exit list, X4BNet/ipverse CIDR sets | cron: Tor hourly, VPN/DC lists + iptoasn daily, MMDBs Tue+Fri (EULA: ≤30 d) |

**Cache-key discipline:** each source gets its own namespace. Warming `logsGeoKey` from any
other consumer silently destroys FiberLogs' first-sighting line — the reason `cachedGeo` exists
for FiberEye and the reason the shipped ASN lookup uses `irc:ipinfo:asn:*`.

---

## 3. Collection ladder

Cheapest and most private first; stop as soon as the question is answered.

```
0. Local  : bogon/private test, our own Mongo record, Redis assembled record
1. Offline: GeoLite2 (geo) · iptoasn/DB-IP (ASN) · IP2Proxy LITE + X4BNet + ipverse (VPN/DC ranges)
            · Tor bulk exit list                                    → cost 0, no disclosure
2. DNS    : Cymru origin+asn (prefix/ASN) · DroneBL · EFnet RBL · Spamhaus DQS (own recursor)
3. Keyless: RIPEstat (prefix, abuse contact, RPKI) · RIR RDAP · StopForumSpam · ipquery.io
4. Keyed  : proxycheck.io → IPHub → ipapi.is   (2 voters per IP; 3rd only on disagreement)
5. Manual : AbuseIPDB · IPQS · Scamalytics · GreyNoise · Shodan InternetDB
            — oper-triggered on an IP-detail page, never automatic
```

Rules: never query a step whose answer a cheaper step already produced · every step 3+ answer is
cached before use · a step that 429s or times out is recorded in `provenance.degraded` and the
record renders without it (never blocks a page or a connect) · connect-time enforcement uses
steps 0–2 only, because they have no per-query quota and no third-party latency in the accept path.

---

## 4. Retention & privacy (GDPR)

IP addresses are personal data (Art. 4(1); dynamic IPs per CJEU *Breyer* C-582/14), and derived
intel keyed to an IP inherits that status. Our basis is **Art. 6(1)(f)** legitimate interest —
network and information security, Recital 47 — not consent.

| Data | Retention | Justification |
|---|---|---|
| Redis enrichment caches | 7 d flags/geo, 24 h reputation, 30 d registry | minimisation: one disclosure per IP per window |
| `fibereye_sessions` raw rows (IP + nick + timestamps) | existing 90 d TTL on `tsAt` | flood/abuse investigation window |
| `fibereye_ips` record | 90 d after `lastSeen`, then group rollup only | storage limitation (Art. 5(1)(e)) |
| Strike/ban records | escalation window + appeal period, then aggregate | proportionality |
| Group counters (prefix, /64) with raw IPs dropped | indefinite | no longer singles out a person |

Hard rules:

1. **Only the IP leaves our infra.** Never a nick, account, channel, message, e-mail or
   timestamp in an enrichment query. Join to identity locally.
2. **Prefer offline databases over APIs** for anything evaluated per connect — with GeoLite2 /
   IP2Proxy / iptoasn / Tor list, the user's IP is never disclosed at all.
3. **No vendor without paperwork.** A vendor answering queries about our users' IPs is a
   processor: Art. 28 DPA, and for non-EU vendors a Chapter V transfer tool (SCCs) plus a
   documented TIA. A vendor that reuses our queries to improve its own dataset is not a
   processor and must be dropped from the per-user path (this is the pointed question to ask
   proxycheck, IPHub, ipapi.is, IPQS and Scamalytics before they see a single user IP).
4. **Staff surfaces are truncated.** City/region/country + ASN + booleans. Never lat/long,
   postal code, or a registry person's contact details for a chat user. `#staff` already carries
   full IPs and is oper-only (`+O`) — keep it that way.
5. **Vendors are named in the privacy policy** with purpose, basis, transfer safeguard and
   retention (Art. 13), and access/erasure/objection must work against `fibereye_ips` too
   (Art. 15–17, 21).
6. **Attribution where results are displayed:** DB-IP Lite CC-BY link, IP2Location LITE credit
   line, MaxMind GeoLite2 attribution, getipintel credit. One admin-footer block satisfies all.
7. **Non-commercial feeds stay internal:** AbuseIPDB free, Shodan InternetDB, StopForumSpam data,
   Spamhaus public mirrors — admin/triage only, never a customer-facing feature or a resold feed.

---

## 5. Display specification

### 5.1 Admin → Mullvad, per egress slot (extends the shipped `ISP / ASN` column)

| Cell | Content | Rule |
|---|---|---|
| Exit IP | `identity.ip` + `hostname` | mono |
| Verdict | `Mullvad` / `not Mullvad` badge (am.i.mullvad.net) | authoritative for our own exits; unchanged |
| ISP / ASN | `network.asName` · `AS…` · `asDomain` | shipped |
| Prefix | `identity.prefix` + `network.rpki` badge | `rpki=invalid` is a red badge — it means the announcement is unverifiable |
| Classification | chips: `VPN(Mullvad)` `hosting` `datacenter`; grey chip when `confidence < 1` | a `hosting`-only exit with no `VPN` chip while the Mullvad badge says verified = the tunnel changed under us |
| Registry | `netname`, `assignment`, `allocatedAt`, `abuseEmail` | text, small |
| Sources | `provenance` summary + `degraded` list, hover for per-field source/age | never show a fact without its source |

### 5.2 Admin → IP detail (FiberEye page, oper-only)

Header: IP, `group`, hostname, our `firstSeen`/`lastSeen`/`sessionCount`, current strikes/Z-line.
Then: **Network** (ASN card + prefix + RPKI + RIR + allocation + IX presence) · **Geo**
(city/region/country + accuracy radius; no map pin below city precision) · **Classification**
(chip grid with per-flag voter table: source, verdict, confidence, `first_seen`/`last_seen`) ·
**Reputation** (abuse score, report count, last report, DNSBL results, StopForumSpam frequency) ·
**Infrastructure** (Shodan `ports`/`tags`/`vulns`, internal-only banner) · **Actions**
(Z-line group, add to watch, copy abuse-report template pre-filled with `contact.abuseEmail`) ·
**Provenance** (table of every field → source → fetched-at → TTL, plus `degraded`).
Manual-tier lookups (§3 step 5) are buttons here, never automatic — each click is a disclosure.

### 5.3 `#staff` line (FiberLogs, oper-only channel, 400-byte cap)

```
Connect: alice!~a@cloak (203.0.113.7) port 6697 class main [Alice]
  ↳ 203.0.113.7 · Austin, Texas, US · AS15169 Google LLC · hosting · abuse 0/100 · new IP
  ↳ 203.0.113.7 · known IP (Austin, US) · 12 sessions since 2026-08-14
```

First sighting gets the full clause; later ones the compact form — the behaviour
`lookupGeo`'s first-sighting marker already implements. Add at most **one** word-set:
`vpn`/`tor`/`hosting`/`proxy` when confirmed by ≥2 voters, plus `abuse <score>/100` when
`abuseScore ≥ 25`. Unconfirmed single votes never reach IRC; they belong on the detail page.

### 5.4 Connect-time enforcement (InspIRCd, not the gateway)

DNSBL and offline sets belong in `custom.conf.j2` as `<dnsbl>` blocks and the existing Tor
gate — the ircd rejects before registration, with no gateway round trip and no vendor latency
in the accept path. FiberEye then *explains* the rejection on the detail page. Never put a
step-4/5 HTTP call in a connect path.

---

## 6. Rollout order

1. **Offline first** (no signup, no disclosure): iptoasn + DB-IP Lite + Tor exit list + X4BNet /
   ipverse cron into `/var/lib/ircfiber/ipintel/`, plus Cymru DNS and RIPEstat abuse-contact
   lookups. Delivers prefix, RPKI, abuse contact, Tor and hosting/VPN-range facts for all three
   consumers at zero cost and zero third-party exposure.
2. **Record + provenance**: implement §2 as the assembled Redis/Mongo record; delete the
   `185.206.149.176` fabrication block in `web/admin/api.d` — with real sources it is a lie
   generator, and `provenance` makes "unknown" displayable honestly.
3. **Two keyed voters**: proxycheck.io + IPHub free keys behind the cache, with the ≥2-vote rule.
   Ask both the Art. 28/query-reuse question first.
4. **Surfaces**: extend the Mullvad column per §5.1, build the IP-detail page per §5.2, extend
   the `#staff` clause per §5.3.
5. **Enforcement**: DroneBL + EFnet RBL + Spamhaus DQS as `<dnsbl>` blocks (own recursor), Tor
   set already gated.
6. **Paid, only if §1.5 binds**: ipapi.is Basic $20/mo, then GeoIP2 Anonymous-IP for the
   privacy-clean offline flag set.

Verification for each step: a throwaway probe against a known Mullvad exit, a known Tor exit and
a residential IP, asserting the record's `classification` matches ground truth — the same
three-IP corpus used to measure the providers above (`185.65.134.66`, `198.98.51.189`,
`71.198.12.34`).

---

## 7. Measured evidence (this repo, 2026-09-08)

| Probe | Result |
|---|---|
| ipinfo Core, our token | `org: "AS39351 31173 Services AB"`; no `asn`/`privacy` objects |
| ipinfo Lite, our token | `asn/as_name/as_domain` — shipped as the `ISP / ASN` column |
| `ipinfo.io/AS39351/json` | `"Token does not have access to this API"` |
| ip-api.com over TLS | `403` → free tier is HTTP-only; `proxy=true hosting=true` for the Mullvad exit, `proxy=false hosting=false` for Comcast, `fail: reserved range` for a tailnet IP |
| proxycheck.io keyless | Mullvad exit → `proxy=yes type=VPN risk=73 operator=Mullvad`; Tor exit → `type=TOR risk=100` |
| ipquery.io keyless | Mullvad exit → `is_vpn=false is_datacenter=true`; Tor exit → `is_tor=false` (unreliable) |
| Team Cymru DNS | `39351 \| 185.65.134.0/24 \| SE \| ripencc \| 2014-07-30` |
| RIPEstat | `abuse=["abuse-cust-nl@31173.se"]`, `rpki=valid`, `block=RIPE NCC (ALLOCATED)` |
| RIPE RDAP | `NET-31173-185-65-134-0-24`, `ASSIGNED PA`, parent `185.65.132.0/22`, abuse/admin/tech entities |
| StopForumSpam keyless | Tor exit → `appears=1 frequency=9 lastseen=2026-05-26 torexit=1 confidence=1.14` |
| Shodan InternetDB keyless | Tor exit → `hostnames:["tor.teitel.net"] ports:[22,53,123,9030]` |
| Tor bulk exit list | 1 344 entries |
| DroneBL | 0/40 Tor exits listed — proxy/drone list, not a Tor list |
| ip.guide / BGPView | ip.guide answered (ASN+CIDR+RIR, no flags); BGPView `HTTP 000` from here |
