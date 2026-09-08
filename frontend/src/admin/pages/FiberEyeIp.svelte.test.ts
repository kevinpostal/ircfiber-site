/**
 * FiberEyeIp.svelte — per-address detail with the IP-intelligence record.
 *
 * Coverage:
 *  1. Confirmed flags render as chips with the operator; a single-voter
 *     (confidence 0.5) flag renders as an unconfirmed `?` chip; every
 *     provenanced field names its source in the provenance table.
 *  2. A field without provenance renders an em dash, never a default.
 *  3. Deep lookup posts the exact address and replaces the record.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import FiberEyeIp from './FiberEyeIp.svelte';
import { api } from '/src/admin/lib/api-client';

vi.mock('/src/admin/lib/api-client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class extends Error {
    readonly status: number;
    constructor(m: string, s: number) { super(m); this.status = s; }
  },
}));

vi.mock('/src/admin/stores/ui', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

const mockedGet = vi.mocked(api.get);
const mockedPost = vi.mocked(api.post);

const NOW = Date.now();
const mark = (src: string, over: Record<string, unknown> = {}) => ({ src, at: NOW - 60_000, ttl: 604_800, confidence: 1, ...over });

const intel = (over: Record<string, unknown> = {}) => ({
  identity: { ip: '185.65.134.66', ipVersion: 4, prefix: '185.65.134.0/24', group: '185.65.134.66', hostname: '', isBogon: false },
  network: {
    asn: 'AS39351', asName: '31173 Services AB', asDomain: '31173.se', asType: 'hosting', isp: '31173 Services AB',
    org: 'Mullvad VPN AB', rir: 'ripencc', allocatedAt: '2014-07-30', netname: 'NET-31173-185-65-134-0-24',
    assignment: 'ASSIGNED PA', rpki: 'valid',
  },
  geo: { countryCode: 'NL', continentCode: 'EU', region: 'North Holland', regionCode: 'NH', city: 'Amsterdam', timezone: 'Europe/Amsterdam', isEu: true },
  classification: {
    isVpn: true, isProxy: false, isTor: false, isRelay: false, isHosting: true,
    isResidentialProxy: false, isMobile: false, vpnOperator: 'Mullvad', networkType: 'hosting',
  },
  reputation: {
    riskScore: 73, sfsFrequency: 0, sfsLastSeen: '', sfsTorExit: false, dnsbl: [],
    vendorFirstSeen: NOW - 86_400_000 * 70, vendorLastSeen: NOW - 3_600_000, timesSeen: 2379,
    firstSeen: NOW - 86_400_000 * 3, lastSeen: NOW - 60_000, sessionCount: 12,
  },
  contact: { abuseEmail: 'abuse-cust-nl@31173.se', abuseSource: 'ripestat' },
  infra: { ports: [], hostnames: [], tags: [], vulns: [] },
  provenance: {
    'network.asn': mark('ripestat_prefix'),
    'network.asName': mark('ripestat_prefix'),
    'identity.prefix': mark('ripestat_prefix'),
    'network.rpki': mark('ripestat_rpki'),
    'geo.city': mark('ipinfo'),
    'geo.countryCode': mark('ipinfo'),
    'classification.isVpn': mark('proxycheck', { votes: { proxycheck: 'true', ipapi_is: 'true' } }),
    'classification.isHosting': mark('proxycheck', { votes: { proxycheck: 'true', ipapi_is: 'true' } }),
    // Only proxycheck answered on Tor: stored as an unconfirmed vote.
    'classification.isTor': mark('proxycheck', { confidence: 0.5, votes: { proxycheck: 'true' } }),
    'classification.vpnOperator': mark('proxycheck'),
    'reputation.riskScore': mark('proxycheck'),
    'contact.abuseEmail': mark('ripestat_abuse', { ttl: 2_592_000 }),
  },
  degraded: ['iphub:nokey'],
  schemaVersion: 1,
  assembledAt: NOW - 60_000,
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  ip: '185.65.134.66',
  rollup: {
    ipGroup: '185.65.134.66', ip: '185.65.134.66', ipVersion: 4,
    firstSeen: NOW - 86_400_000 * 3, lastSeen: NOW - 60_000, connects: 12, shortSessions: 1,
    lastNick: 'alice', lastAccount: '', lastRealname: 'Alice', lastClass: 'main',
    geoCity: 'Amsterdam', geoRegion: 'North Holland', geoCountry: 'NL', geoOrg: 'AS39351 31173 Services AB',
    geoTimezone: 'Europe/Amsterdam', geoPending: false,
    intelAsn: 'AS39351', intelFlags: 'vpn(Mullvad)+hosting', intelOperator: 'Mullvad', intelPrefix: '185.65.134.0/24',
    intelRisk: 73, intelAt: NOW - 60_000,
    strikes: 0, bannedUntil: 0, lastBanId: '',
  },
  sessions: [],
  distinctNicks: ['alice'],
  distinctAccounts: [],
  bans: [],
  zline: null,
  intel: intel(),
  intelSources: ['proxycheck', 'ripestat_prefix', 'ripestat_rpki', 'ripestat_abuse', 'rdap', 'sfs', 'dronebl', 'efnetrbl', 'ipinfo'],
  ...over,
});

describe('FiberEyeIp.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders confirmed flags as chips, a single vote as unconfirmed, and names every source', async () => {
    mockedGet.mockResolvedValue(detail());
    render(FiberEyeIp, { ip: '185.65.134.66' });
    await expect.element(page.getByText('vpn(Mullvad)', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('tor?', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('hosting', { exact: true })).toBeInTheDocument();
    // The provenance row for the ASN names RIPEstat, not the vendor that also carried it.
    const asnRow = page.getByRole('row', { name: /network\.asn/ });
    await expect.element(asnRow).toBeInTheDocument();
    await expect.element(asnRow.getByText('ripestat_prefix', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('73/100', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('Degraded: iphub:nokey')).toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith('/api/admin/fibereye/ip', { ip: '185.65.134.66' });
  });

  it('renders an em dash for a field with no provenance', async () => {
    const rec = intel();
    delete (rec.provenance as Record<string, unknown>)['network.rpki'];
    mockedGet.mockResolvedValue(detail({ intel: rec }));
    render(FiberEyeIp, { ip: '185.65.134.66' });
    await expect.element(page.getByText('vpn(Mullvad)', { exact: true })).toBeInTheDocument();
    // `network.rpki` still says "valid" in the record, but without a mark it must not be shown.
    await expect.element(page.getByText('valid', { exact: true })).not.toBeInTheDocument();
    // Netname carries no mark in the fixture either.
    await expect.element(page.getByText('NET-31173-185-65-134-0-24')).not.toBeInTheDocument();
  });

  it('deep lookup posts the exact address and swaps in the fresh record', async () => {
    mockedGet.mockResolvedValue(detail());
    const fresh = intel({
      infra: { ports: [22, 9030], hostnames: ['tor.example'], tags: ['tor'], vulns: [] },
      degraded: [],
    });
    (fresh.provenance as Record<string, unknown>)['infra'] = mark('shodan', { ttl: 86_400 });
    mockedPost.mockResolvedValue({ intel: fresh });
    render(FiberEyeIp, { ip: '185.65.134.66' });
    await expect.element(page.getByText('vpn(Mullvad)', { exact: true })).toBeInTheDocument();
    await page.getByRole('button', { name: 'Deep lookup', exact: true }).click();
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/admin/fibereye/ip/deep', { ip: '185.65.134.66' }));
    await expect.element(page.getByText('22, 9030', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText(/Shodan InternetDB is non-commercial/)).toBeInTheDocument();
  });
});
