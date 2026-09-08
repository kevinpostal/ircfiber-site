/**
 * Shared IP → FiberEye intel link helpers.
 *
 * Every admin surface that renders a bare IP links public addresses to the
 * cached detail page at `/fibereye/ip/:ip`; private/bogon addresses stay
 * plain text so they never produce a dead link. The private ranges mirror
 * `isPrivateIp` in `backend/source/ircfiber/logs/format.d` — one guard
 * here instead of six drifting copies.
 */
import { href } from './router';

export function ipFamily(ip: string): 'IPv6' | 'IPv4' | '' {
  const s = (ip ?? '').trim();
  if (!s.length) return '';
  return s.indexOf(':') >= 0 ? 'IPv6' : 'IPv4';
}

function isPublicV4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  const o: number[] = [];
  for (const p of parts) {
    if (!p.length || p.length > 3 || !/^\d+$/.test(p)) return false;
    const v = Number(p);
    if (v > 255) return false;
    o.push(v);
  }
  if (o[0] === 0 || o[0] === 10 || o[0] === 127) return false;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
  if (o[0] === 192 && o[1] === 168) return false;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false;
  if (o[0] === 169 && o[1] === 254) return false;
  if (o[0] >= 224) return false;
  return true;
}

function isPublicIp(s: string): boolean {
  if (s.indexOf(':') >= 0) {
    const l = s.toLowerCase();
    if (!/^[0-9a-f:.%]+$/.test(l)) return false;
    if (l === '::1' || l === '::') return false;
    // IPv4-mapped (::ffff:203.0.113.7) → judge the embedded v4 address.
    const lastColon = l.lastIndexOf(':');
    if (lastColon >= 0 && l.slice(lastColon + 1).indexOf('.') >= 0)
      return isPublicV4(l.slice(lastColon + 1));
    if (l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return false;
    if (l.startsWith('ff')) return false; // multicast
    return true;
  }
  return isPublicV4(s);
}

/** Hash href for the FiberEye IP detail page, or null when `ip` is empty,
 *  `unknown`, unparsable, or private — those render as plain text. */
export function fibereyeIpHref(ip: string | null | undefined): string | null {
  const s = (ip ?? '').trim();
  if (!s.length) return null;
  const l = s.toLowerCase();
  if (l === 'unknown' || l === '—' || l === '-') return null;
  if (!isPublicIp(s)) return null;
  return href('/fibereye/ip/' + encodeURIComponent(s));
}

/** One row of `GET /api/admin/fibereye/ip/batch` — the denormalized chip
 *  fields `sessionJson`/`ipJson` already expose, no new JSON keys. */
export interface IpChip {
  ip: string;
  bogon: boolean;
  geoCity: string;
  geoRegion: string;
  geoCountry: string;
  geoOrg: string;
  intelFlags: string;
  intelRisk: number;
  geoPending: boolean;
}

/** `City, CC` / org fallback, mirroring `FiberEye.svelte`'s `geoShort`
 *  minus its placeholder: a provenance-less chip renders nothing. */
export function chipGeo(c: IpChip): string {
  const place = [c.geoCity, c.geoCountry].filter(Boolean).join(', ');
  if (place) return place;
  if (c.geoOrg) return c.geoOrg;
  return '';
}

export type ChipTone = 'primary' | 'danger' | 'muted';

/** `vpn(Mullvad)+tor+hosting` → one chip per confirmed flag, toned by
 *  severity — same mapping as `FiberEye.svelte`'s `flagChips`. */
export function chipFlags(label: string): { text: string; tone: ChipTone }[] {
  if (!label) return [];
  return label.split('+').filter(Boolean).map((f) => {
    const tone: ChipTone = f.startsWith('vpn') ? 'primary'
      : f === 'tor' || f === 'proxy' || f === 'residential-proxy' ? 'danger' : 'muted';
    return { text: f, tone };
  });
}

/** True when the chip carries anything worth printing: geo or flags. */
export function hasChip(c: IpChip | undefined): c is IpChip {
  if (!c || c.bogon) return false;
  return chipGeo(c).length > 0 || (c.intelFlags ?? '').length > 0;
}
