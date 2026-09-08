/**
 * ipIntelLink — private/bogon guard and family checks for FiberEye IP links.
 * Pure string in/out, no DOM needed.
 */
import { describe, expect, it } from 'vitest';
import { fibereyeIpHref, ipFamily, chipGeo, chipFlags, hasChip } from './ipIntelLink';
import type { IpChip } from './ipIntelLink';

describe('fibereyeIpHref', () => {
  it('links public IPv4 addresses to the detail page', () => {
    expect(fibereyeIpHref('8.8.8.8')).toBe('#/fibereye/ip/8.8.8.8');
    expect(fibereyeIpHref('203.0.113.7')).toBe('#/fibereye/ip/203.0.113.7');
  });

  it('links public IPv6 addresses URL-encoded', () => {
    expect(fibereyeIpHref('2606:4700:4700::1111')).toBe('#/fibereye/ip/2606%3A4700%3A4700%3A%3A1111');
  });

  it('leaves private, loopback and CGNAT addresses unlinked', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255',
        '100.64.0.1', '169.254.10.20', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1']) {
      expect(fibereyeIpHref(ip)).toBeNull();
    }
  });

  it('keeps the 172.15/172.32 boundaries public', () => {
    expect(fibereyeIpHref('172.15.0.1')).not.toBeNull();
    expect(fibereyeIpHref('172.32.0.1')).not.toBeNull();
  });

  it('leaves empty, unknown and unparsable input unlinked', () => {
    for (const ip of ['', '  ', 'unknown', 'Unknown', '—', '-', 'not-an-ip', 'h.example.com']) {
      expect(fibereyeIpHref(ip)).toBeNull();
    }
  });
});

describe('ipFamily', () => {
  it('matches the historical indexOf check', () => {
    expect(ipFamily('1.2.3.4')).toBe('IPv4');
    expect(ipFamily('::1')).toBe('IPv6');
    expect(ipFamily('')).toBe('');
  });
});

const chip = (over: Partial<IpChip>): IpChip => ({
  ip: '8.8.8.8', bogon: false, geoCity: '', geoRegion: '', geoCountry: '',
  geoOrg: '', intelFlags: '', intelRisk: -1, geoPending: false, ...over,
});

describe('chip helpers', () => {
  it('prefers City, CC and falls back to org', () => {
    expect(chipGeo(chip({ geoCity: 'Austin', geoCountry: 'US' }))).toBe('Austin, US');
    expect(chipGeo(chip({ geoOrg: 'Google LLC' }))).toBe('Google LLC');
    expect(chipGeo(chip({}))).toBe('');
  });

  it('tones flags by severity like FiberEye', () => {
    const tones = Object.fromEntries(chipFlags('vpn(Mullvad)+tor+hosting').map((f) => [f.text, f.tone]));
    expect(tones).toEqual({ 'vpn(Mullvad)': 'primary', tor: 'danger', hosting: 'muted' });
    expect(chipFlags('')).toEqual([]);
  });

  it('hides bogon and provenance-less chips', () => {
    expect(hasChip(undefined)).toBe(false);
    expect(hasChip(chip({ bogon: true, geoCity: 'Austin', geoCountry: 'US' }))).toBe(false);
    expect(hasChip(chip({}))).toBe(false);
    expect(hasChip(chip({ geoCity: 'Austin', geoCountry: 'US' }))).toBe(true);
    expect(hasChip(chip({ intelFlags: 'tor' }))).toBe(true);
  });
});
