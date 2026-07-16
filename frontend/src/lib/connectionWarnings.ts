// Connection-status text + warning helpers used by ConnectionStatus.svelte.
//
// Mirrors the layered reasoning IRCCloud does in its ConnectionStatusView:
//   1. The headline text comes from `renderReason` (a small cleanup pass
//      over engine-reported reason strings) or one of the rich fail-info
//      branches (`killed`, `ssl_certificate_error`, `connection_blocked`,
//      `connecting_failed`, `socket_closed`).
//   2. Inline warnings from `connectionWarnings` are appended *as
//      separate lines* in the same banner — they never replace the
//      headline. They surface configuration mistakes (SSL on a plaintext
//      port, suspicious hostnames) plus a "Check your host, port and
//      ssl settings" CTA when the connection actually failed.
//
// All functions are pure and side-effect free; the consuming component
// drives reactivity.

export interface SSLVerifyError {
  type: string;
  error: string;
}

export interface FailInfo {
  type: string;
  reason?: string;
  killedReason?: string;
  sslVerifyError?: SSLVerifyError;
  /**
   * W3-rev1: when `type === 'ip_retry'`, the engine surfaces the IP
   * that just failed so the banner can show "Connecting to {ip} failed
   * ({error}); resolving a new IP…". Optional — older builds may not
   * emit an IP, in which case the banner falls back to the generic
   * "Connecting failed; resolving a new IP…".
   */
  ip?: string;
}

export interface RetryStatus {
  attemptCount: number;
  nextRetryAtMs: number;
  delayMs: number;
}

/**
 * Map of known fail-type constants. The engine currently emits a free-form
 * `failInfo.type` string; we keep the set closed here so the type-checker
 * can warn on typos and the test suite can pin behaviour against stable
 * identifiers (rather than brittle string literals).
 */
export const FAIL_TYPES = {
  KILLED: 'killed',
  SSL_CERTIFICATE_ERROR: 'ssl_certificate_error',
  CONNECTION_BLOCKED: 'connection_blocked',
  CONNECTING_FAILED: 'connecting_failed',
  SOCKET_CLOSED: 'socket_closed',
  GAVE_UP_RETRYING: 'gave_up_retrying',
} as const;

export type FailType = (typeof FAIL_TYPES)[keyof typeof FAIL_TYPES];

/**
 * Internal: replace engine reason codes with user-facing copy.
 *
 * Mirrors the small cleanup table IRCCloud's `renderReason` carries —
 * the engine emits terse, sometimes cryptic reason codes (e.g.
 * `econnrefused`, `tls_alert`) and the UI wraps them in a sentence.
 * Anything we don't recognise passes through verbatim; the banner is
 * already expected to be self-explanatory for known IRC numerics.
 */
const REASON_TRANSLATIONS: Record<string, string> = {
  econnrefused: 'Connection refused',
  econnreset: 'Connection reset by peer',
  enetunreach: 'Network unreachable',
  ehostunreach: 'Host unreachable',
  etimedout: 'Connection timed out',
  tls_alert: 'TLS handshake failed',
  dns_error: 'Could not resolve hostname',
  cert_expired: 'Server certificate has expired',
  cert_unknown_authority: 'Server certificate is not trusted',
  hostname_mismatch: 'Server certificate does not match the hostname',
};

export function renderReason(reason: string | undefined | null): string {
  if (!reason) return '';
  const trimmed = reason.trim();
  if (!trimmed) return '';
  const key = trimmed.toLowerCase();
  return REASON_TRANSLATIONS[key] ?? trimmed;
}

/**
 * Format an SSL verification error for the banner. IRCCloud concatenates
 * the error `type` and `error` strings; we follow the same shape but
 * prefer a sentence ("<type>: <error>") so the banner reads naturally.
 */
export function renderSSLVerify(err: SSLVerifyError | undefined | null): string {
  if (!err) return 'TLS verification failed';
  const t = (err.type || '').trim();
  const e = (err.error || '').trim();
  if (t && e) return `${t}: ${e}`;
  return t || e || 'TLS verification failed';
}

/**
 * Render a friendly "Reconnecting in 12s… (3rd attempt)" countdown line
 * from the engine's `retryStatus` payload. `now` is the client clock used
 * for the remaining-seconds calculation so tests can pin behaviour with
 * a fake clock.
 */
export function renderRetryCountdown(
  retry: RetryStatus | undefined | null,
  now: number = Date.now(),
): string {
  if (!retry) return '';
  const remainingMs = Math.max(0, retry.nextRetryAtMs - now);
  const remainingSec = Math.ceil(remainingMs / 1000);
  const attempt = Math.max(1, retry.attemptCount);
  // Suffix mirrors IRCCloud's "(2nd attempt)" pattern. We intentionally
  // collapse to English ordinals to match IRCCloud rather than carrying
  // a localised list — the engine's number is the source of truth.
  const ordinal = ordinalSuffix(attempt);
  return `Reconnecting in ${remainingSec}s… (${attempt}${ordinal} attempt)`;
}

function ordinalSuffix(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

/**
 * Returns a list of inline warning strings to append to the banner.
 * Pass `sslOn=true` when SSL/TLS is enabled on this network so we can
 * warn about plaintext-port mismatches.
 *
 * Mirrors the layer of helpful nudges IRCCloud appends:
 *   - SSL enabled on the standard plaintext port (almost always wrong)
 *   - Hostname looks like localhost / a loopback / RFC1918 (rare for IRC)
 *   - When the connection actually failed, a CTA link to re-check config
 */
export function connectionWarnings(
  host: string | undefined | null,
  port: number | undefined | null,
  sslOn: boolean,
  options: { includeConfigCta?: boolean } = {},
): string[] {
  const warnings: string[] = [];

  const safeHost = (host || '').trim();
  const safePort = Number.isFinite(port) ? Number(port) : 0;

  if (sslOn && safePort === 6667) {
    warnings.push("You're trying to connect via SSL on port 6667");
  }

  if (safeHost) {
    const lower = safeHost.toLowerCase();
    const looksLocal =
      lower === 'localhost' ||
      lower === '127.0.0.1' ||
      lower === '0.0.0.0' ||
      lower === '::1' ||
      lower.startsWith('127.') ||
      lower.startsWith('192.168.') ||
      lower.startsWith('10.') ||
      lower.startsWith('172.16.') ||
      lower.startsWith('172.17.') ||
      lower.startsWith('172.18.') ||
      lower.startsWith('172.19.') ||
      lower.startsWith('172.2') && /^172\.2[0-9]\./.test(lower) ||
      lower.endsWith('.local') ||
      lower.endsWith('.lan') ||
      lower.endsWith('.internal');
    if (looksLocal) {
      warnings.push(`Your hostname looks invalid: ${safeHost}`);
    }
  }

  if (options.includeConfigCta) {
    // Always append the CTA when asked. IRCCloud renders this as a
    // separate line with an actual link to the network-edit drawer; we
    // surface it as text and let the consumer route it via an
    // `onEditNetwork(networkId)` callback if available.
    warnings.push('Check your host, port and ssl settings');
  }

  return warnings;
}