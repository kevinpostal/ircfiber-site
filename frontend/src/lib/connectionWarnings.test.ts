import { describe, expect, it } from 'vitest';
import {
  connectionWarnings,
  renderReason,
  renderRetryCountdown,
  renderSSLVerify,
  FAIL_TYPES,
} from './connectionWarnings';

describe('connectionWarnings — connectionWarnings', () => {
  it('warns about SSL on plaintext port 6667', () => {
    const warnings = connectionWarnings('irc.example.com', 6667, true);
    expect(warnings).toContain("You're trying to connect via SSL on port 6667");
  });

  it('does NOT warn about SSL on the secure port (6697)', () => {
    const warnings = connectionWarnings('irc.example.com', 6697, true);
    expect(warnings.some((w) => w.includes('SSL on port'))).toBe(false);
  });

  it('warns about localhost', () => {
    expect(connectionWarnings('localhost', 6667, false)).toContain(
      'Your hostname looks invalid: localhost',
    );
  });

  it('warns about loopback IPv4 127.0.0.1', () => {
    expect(connectionWarnings('127.0.0.1', 6667, false)).toContain(
      'Your hostname looks invalid: 127.0.0.1',
    );
  });

  it('warns about RFC1918 192.168.x.x', () => {
    expect(connectionWarnings('192.168.1.5', 6667, false)).toContain(
      'Your hostname looks invalid: 192.168.1.5',
    );
  });

  it('warns about RFC1918 10.x.x.x', () => {
    expect(connectionWarnings('10.0.0.1', 6667, false)).toContain(
      'Your hostname looks invalid: 10.0.0.1',
    );
  });

  // RFC 1918 172.16.0.0/12 covers 172.16.0.0 – 172.31.255.255. The old
  // string-prefix version missed 172.30/172.31 (fixed 2026-08-14).
  it('warns about RFC1918 172.16/12 lower bound', () => {
    expect(connectionWarnings('172.16.0.1', 6667, false)).toContain(
      'Your hostname looks invalid: 172.16.0.1',
    );
  });

  it('warns about RFC1918 172.20/12 (old regex range)', () => {
    expect(connectionWarnings('172.20.0.1', 6667, false)).toContain(
      'Your hostname looks invalid: 172.20.0.1',
    );
  });

  it('warns about RFC1918 172.30.x.x (regression: was missed)', () => {
    expect(connectionWarnings('172.30.0.1', 6667, false)).toContain(
      'Your hostname looks invalid: 172.30.0.1',
    );
  });

  it('warns about RFC1918 172.31.x.x (regression: was missed)', () => {
    expect(connectionWarnings('172.31.255.255', 6667, false)).toContain(
      'Your hostname looks invalid: 172.31.255.255',
    );
  });

  it('does not warn for 172.32.x.x (outside RFC 1918 /12)', () => {
    const w = connectionWarnings('172.32.0.1', 6667, false);
    expect(w.some((m) => m.includes('hostname looks invalid'))).toBe(false);
  });

  it('does not warn for 172.2.x.x (not a /12 octet; old regex exclusion kept)', () => {
    const w = connectionWarnings('172.2.0.1', 6667, false);
    expect(w.some((m) => m.includes('hostname looks invalid'))).toBe(false);
  });

  it('still flags an IP embedded in a hostname (127.0.0.1.nip.io)', () => {
    expect(connectionWarnings('127.0.0.1.nip.io', 6667, false)).toContain(
      'Your hostname looks invalid: 127.0.0.1.nip.io',
    );
  });

  it('warns about .local TLD', () => {
    expect(connectionWarnings('box.local', 6667, false)).toContain(
      'Your hostname looks invalid: box.local',
    );
  });

  it('does not warn for a normal hostname', () => {
    const w = connectionWarnings('irc.libera.chat', 6697, true);
    expect(w.some((m) => m.includes('localhost'))).toBe(false);
    expect(w.some((m) => m.includes('hostname looks invalid'))).toBe(false);
  });

  it('handles empty host gracefully', () => {
    const w = connectionWarnings('', 6697, true);
    expect(w.some((m) => m.includes('hostname looks invalid'))).toBe(false);
  });

  it('handles null host gracefully', () => {
    const w = connectionWarnings(null, 6697, true);
    expect(w).toEqual([]);
  });

  it('appends the CTA only when includeConfigCta=true', () => {
    expect(connectionWarnings('irc.example.com', 6697, false)).not.toContain(
      'Check your host, port and ssl settings',
    );
    expect(
      connectionWarnings('irc.example.com', 6697, false, { includeConfigCta: true }),
    ).toContain('Check your host, port and ssl settings');
  });

  it('combines multiple warnings in the right order', () => {
    // localhost + SSL-on-6667 + CTA → 3 entries, in this order.
    const w = connectionWarnings('localhost', 6667, true, { includeConfigCta: true });
    expect(w).toEqual([
      "You're trying to connect via SSL on port 6667",
      'Your hostname looks invalid: localhost',
      'Check your host, port and ssl settings',
    ]);
  });
});

describe('connectionWarnings — renderReason', () => {
  it('translates econnrefused', () => {
    expect(renderReason('econnrefused')).toBe('Connection refused');
  });

  it('translates econnreset', () => {
    expect(renderReason('econnreset')).toBe('Connection reset by peer');
  });

  it('translates tls_alert', () => {
    expect(renderReason('tls_alert')).toBe('TLS handshake failed');
  });

  it('translates cert_expired', () => {
    expect(renderReason('cert_expired')).toBe('Server certificate has expired');
  });

  it('passes unknown reason through verbatim', () => {
    expect(renderReason('something else')).toBe('something else');
  });

  it('returns empty string for empty / null / undefined', () => {
    expect(renderReason('')).toBe('');
    expect(renderReason(null)).toBe('');
    expect(renderReason(undefined)).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(renderReason('  econnrefused  ')).toBe('Connection refused');
  });

  it('case-insensitive lookup', () => {
    expect(renderReason('ECONNREFUSED')).toBe('Connection refused');
  });
});

describe('connectionWarnings — renderSSLVerify', () => {
  it('formats "<type>: <error>"', () => {
    expect(
      renderSSLVerify({ type: 'CERT_HAS_EXPIRED', error: 'expired on 2026-01-01' }),
    ).toBe('CERT_HAS_EXPIRED: expired on 2026-01-01');
  });

  it('falls back to just type when error missing', () => {
    expect(renderSSLVerify({ type: 'TLSV1_ALERT', error: '' })).toBe('TLSV1_ALERT');
  });

  it('falls back to just error when type missing', () => {
    expect(renderSSLVerify({ type: '', error: 'unknown CA' })).toBe('unknown CA');
  });

  it('returns generic message when null', () => {
    expect(renderSSLVerify(null)).toBe('TLS verification failed');
  });

  it('returns generic message when undefined', () => {
    expect(renderSSLVerify(undefined)).toBe('TLS verification failed');
  });

  it('returns generic message when both fields empty', () => {
    expect(renderSSLVerify({ type: '', error: '' })).toBe('TLS verification failed');
  });
});

describe('connectionWarnings — renderRetryCountdown', () => {
  it('formats countdown with ordinals', () => {
    const now = 1_000;
    expect(
      renderRetryCountdown({ attemptCount: 1, nextRetryAtMs: 11_000, delayMs: 10_000 }, now),
    ).toBe('Reconnecting in 10s… (1st attempt)');
    expect(
      renderRetryCountdown({ attemptCount: 2, nextRetryAtMs: 11_000, delayMs: 10_000 }, now),
    ).toBe('Reconnecting in 10s… (2nd attempt)');
    expect(
      renderRetryCountdown({ attemptCount: 3, nextRetryAtMs: 11_000, delayMs: 10_000 }, now),
    ).toBe('Reconnecting in 10s… (3rd attempt)');
    expect(
      renderRetryCountdown({ attemptCount: 4, nextRetryAtMs: 11_000, delayMs: 10_000 }, now),
    ).toBe('Reconnecting in 10s… (4th attempt)');
  });

  it('uses 11th/12th/13th (special teens)', () => {
    const now = 0;
    expect(
      renderRetryCountdown({ attemptCount: 11, nextRetryAtMs: 10_000, delayMs: 10_000 }, now),
    ).toBe('Reconnecting in 10s… (11th attempt)');
    expect(
      renderRetryCountdown({ attemptCount: 12, nextRetryAtMs: 10_000, delayMs: 10_000 }, now),
    ).toBe('Reconnecting in 10s… (12th attempt)');
    expect(
      renderRetryCountdown({ attemptCount: 13, nextRetryAtMs: 10_000, delayMs: 10_000 }, now),
    ).toBe('Reconnecting in 10s… (13th attempt)');
  });

  it('uses 21st/22nd/23rd (post-teen ordinals)', () => {
    const now = 0;
    expect(
      renderRetryCountdown({ attemptCount: 21, nextRetryAtMs: 10_000, delayMs: 10_000 }, now),
    ).toBe('Reconnecting in 10s… (21st attempt)');
    expect(
      renderRetryCountdown({ attemptCount: 22, nextRetryAtMs: 10_000, delayMs: 10_000 }, now),
    ).toBe('Reconnecting in 10s… (22nd attempt)');
  });

  it('clamps to 0s when nextRetryAtMs is in the past', () => {
    expect(
      renderRetryCountdown({ attemptCount: 1, nextRetryAtMs: 0, delayMs: 1_000 }, 5_000),
    ).toBe('Reconnecting in 0s… (1st attempt)');
  });

  it('rounds up to nearest second', () => {
    // now=1000, nextRetryAtMs=1500 → remainingMs=500 → ceil(0.5)=1
    expect(
      renderRetryCountdown({ attemptCount: 1, nextRetryAtMs: 1_500, delayMs: 500 }, 1_000),
    ).toBe('Reconnecting in 1s… (1st attempt)');
  });

  it('returns empty string for null/undefined', () => {
    expect(renderRetryCountdown(null)).toBe('');
    expect(renderRetryCountdown(undefined)).toBe('');
  });
});

describe('connectionWarnings — FAIL_TYPES constant', () => {
  it('exposes the canonical fail-type identifiers', () => {
    expect(FAIL_TYPES.KILLED).toBe('killed');
    expect(FAIL_TYPES.SSL_CERTIFICATE_ERROR).toBe('ssl_certificate_error');
    expect(FAIL_TYPES.CONNECTION_BLOCKED).toBe('connection_blocked');
    expect(FAIL_TYPES.CONNECTING_FAILED).toBe('connecting_failed');
    expect(FAIL_TYPES.SOCKET_CLOSED).toBe('socket_closed');
    expect(FAIL_TYPES.GAVE_UP_RETRYING).toBe('gave_up_retrying');
  });
});