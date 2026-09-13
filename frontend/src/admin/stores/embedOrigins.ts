/**
 * Iframe-embedding allowlist — which partner origins may frame the site.
 * Persists to Redis `irc:config:embedOrigins` via /api/admin/config/embed-origins.
 *
 * An empty list means embedding is fully blocked (X-Frame-Options: DENY).
 * /admin is never embeddable regardless of this list.
 */
import { writable } from 'svelte/store';
import { api, ApiError } from '../lib/api-client';

/** Hard ceiling enforced by the backend — at most this many origins. */
export const EMBED_ORIGINS_MAX = 16;

export interface EmbedOriginsConfig {
  origins: string[];
  key: string;
  max: number;
}

export const embedOriginsConfig = writable<EmbedOriginsConfig | null>(null);
export const embedOriginsLoading = writable(false);
export const embedOriginsError = writable<string | null>(null);
export const embedOriginsSaving = writable(false);

export async function fetchEmbedOrigins(): Promise<void> {
  embedOriginsLoading.set(true);
  embedOriginsError.set(null);
  try {
    const data = await api.get<EmbedOriginsConfig>('/api/admin/config/embed-origins');
    embedOriginsConfig.set(data);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    embedOriginsError.set(msg);
  } finally {
    embedOriginsLoading.set(false);
  }
}

export async function saveEmbedOrigins(origins: string[]): Promise<void> {
  embedOriginsSaving.set(true);
  embedOriginsError.set(null);
  try {
    await api.post('/api/admin/config/embed-origins', { origins });
    await fetchEmbedOrigins();
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    embedOriginsError.set(msg);
    throw e;
  } finally {
    embedOriginsSaving.set(false);
  }
}

/**
 * Client-side mirror of the backend's origin rule (instant feedback; the
 * server stays authoritative): `scheme://host[:port]`, https only except
 * http for localhost/127.0.0.1, lowercase, no path, no trailing slash,
 * no wildcards. Returns the problem, or null when the entry is fine.
 */
export function validateEmbedOrigin(value: string): string | null {
  const v = value.trim();
  if (!v) return 'Enter an origin as scheme://host[:port] — e.g. https://partner.example.';
  if (v !== v.toLowerCase()) return 'Origins must be lowercase.';
  if (v.includes('*')) return 'No wildcards — list each origin exactly.';
  if (/\s/.test(v)) return 'No spaces — an origin is scheme://host[:port].';
  const sep = v.indexOf('://');
  if (sep < 0) return 'Missing scheme — use https://host (http only for localhost).';
  const scheme = v.slice(0, sep);
  const rest = v.slice(sep + 3);
  if (scheme !== 'https' && scheme !== 'http') return 'Scheme must be https (http is only allowed for localhost).';
  if (!rest) return 'Missing host — use scheme://host[:port].';
  if (rest.includes('/')) return 'No path or trailing slash — just scheme://host[:port].';
  if (rest.includes('@')) return 'No userinfo — just scheme://host[:port].';
  if (rest.includes('?') || rest.includes('#')) return 'No query or fragment — just scheme://host[:port].';
  // Split host from the optional port.
  let host = rest;
  let port = '';
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close < 0) return 'Unclosed IPv6 literal — wrap it in [ ].';
    port = host.slice(close + 1);
    host = host.slice(0, close + 1);
    if (port && !/^:\d+$/.test(port)) return 'The port must be digits — e.g. https://partner.example:8443.';
  } else if (host.includes(':')) {
    const parts = host.split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return 'Only one port — use scheme://host[:port].';
    if (!/^\d+$/.test(parts[1])) return 'The port must be digits — e.g. https://partner.example:8443.';
    host = parts[0];
    port = ':' + parts[1];
  }
  if (!host) return 'Missing host — use scheme://host[:port].';
  if (port) {
    const n = Number(port.slice(1));
    if (!Number.isInteger(n) || n < 1 || n > 65535) return 'The port must be 1–65535.';
  }
  if (host.startsWith('[')) {
    if (!/^\[[0-9a-f:.]+\]$/.test(host)) return 'Not an IPv6 literal.';
  } else if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) {
    return 'Not a host — letters, digits, dots and hyphens.';
  }
  const bare = host;
  const isLocal = bare === 'localhost' || bare === '127.0.0.1';
  if (scheme === 'http' && !isLocal) return 'http is only for localhost/127.0.0.1 — everything else must be https.';
  return null;
}
