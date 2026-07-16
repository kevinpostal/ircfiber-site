// ─────────────────────────────────────────────────────────────────────
// renderReasons.test.ts — exhaustive table coverage (W2-T01, TG1)
// ─────────────────────────────────────────────────────────────────────
//
// TG1 explicitly pins `renderReason` and `renderSSLVerify` behaviour
// against the IRCCloud tables so a future regression points at the
// helper test, not the banner test. Every RENDER_REASONS key returns
// its expected human string; the unknown-reason passthrough is
// asserted explicitly so neither path silently rewrites.
//
// Pure helpers, lib project (Node, fast).
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { renderReason, renderSSLVerify } from './renderReasons';

describe('renderReason (TG1 — IRCCloud RENDER_REASONS parity)', () => {
  // Pinned by the plan's TG1 acceptance criterion — three explicit
  // cases the helper test must lock down so a regression in renderReasons
  // fails THIS file, not the banner component test.
  it('maps econnrefused → Connection refused', () => {
    expect(renderReason('econnrefused')).toBe('Connection refused');
  });
  it('maps nxdomain → Invalid hostname', () => {
    expect(renderReason('nxdomain')).toBe('Invalid hostname');
  });
  it('maps ssl_certificate_error → SSL certificate error', () => {
    expect(renderReason('ssl_certificate_error')).toBe('SSL certificate error');
  });

  // Exhaustive coverage — every key in the lifted RENDER_REASONS table
  // (irccloud-webpack-study/app/src/view/renderreasons.js:17-32).
  // Pins the helper against accidental truncation when an editor
  // refactors the switch statement.
  it('returns the IRCCloud string for every known reason key', () => {
    const expected: Record<string, string> = {
      pool_lost:             'Connection pool failed',
      no_pool:               'No available connection pools',
      enetdown:              'Network down',
      etimedout:             'Timed out',
      timeout:               'Timed out',
      closed:                'Connection closed',
      enotconn:              'Connection unavailable',
      ehostunreach:          'Host unreachable',
      econnrefused:          'Connection refused',
      nxdomain:              'Invalid hostname',
      einval:                'Invalid hostname',
      ssl_certificate_error: 'SSL certificate error',
      ssl_error:             'SSL error',
      crash:                 'Connection crashed',
    };
    for (const [reason, human] of Object.entries(expected)) {
      expect(renderReason(reason)).toBe(human);
    }
  });

  // TG1 explicit: unknown reasons must NOT be rewritten — they fall
  // through unchanged so legacy / non-standard engine-emitted reasons
  // still surface in the banner.
  it('returns the input string unchanged for unknown reasons', () => {
    expect(renderReason('unknown_thing')).toBe('unknown_thing');
    expect(renderReason('ECONNRESET')).toBe('ECONNRESET');
    expect(renderReason('Connection reset by peer')).toBe('Connection reset by peer');
    expect(renderReason('')).toBe('');
  });

  it('handles non-string values defensively', () => {
    // The banner code guards `failInfo.reason === 'string'` before
    // calling, but renderReason itself does not blow up on a stray
    // null/undefined (passes-through to empty string) so future
    // call-sites that forget the guard don't crash the banner.
    expect(renderReason(undefined as unknown as string)).toBe('');
    expect(renderReason(null as unknown as string)).toBe('');
    expect(renderReason(42 as unknown as string)).toBe('');
  });
});

describe('renderSSLVerify', () => {
  it('returns the nested-key string for bad_cert.cert_expired (the canonical case)', () => {
    // TG1 + W3-T01 acceptance: the banner renders
    //   "Strict transport security error: Certificate expired"
    // for the canonical Wave-1 smoke case.
    expect(renderSSLVerify({ type: 'bad_cert', error: 'cert_expired' }))
      .toBe('Certificate expired');
  });

  it('returns the IRCCloud string for every bad_cert error code', () => {
    const expected: Record<string, string> = {
      unknown_ca:                'Unknown certificate authority',
      selfsigned_peer:           'Self signed certificate',
      cert_expired:              'Certificate expired',
      invalid_issuer:            'Invalid certificate issuer',
      invalid_signature:         'Invalid certificate signature',
      name_not_permitted:        'Invalid certificate alternative hostname',
      missing_basic_constraint:  'Missing certificate basic contraints',
      invalid_key_usage:         'Invalid certificate key usage',
    };
    for (const [error, human] of Object.entries(expected)) {
      expect(renderSSLVerify({ type: 'bad_cert', error })).toBe(human);
    }
  });

  it('returns the IRCCloud string for every ssl_verify_hostname error code', () => {
    const expected: Record<string, string> = {
      unable_to_match_altnames:      'Certificate hostname mismatch',
      unable_to_match_common_name:   'Certificate hostname mismatch',
      unable_to_decode_common_name:  'Invalid certificate hostname',
    };
    for (const [error, human] of Object.entries(expected)) {
      expect(renderSSLVerify({ type: 'ssl_verify_hostname', error })).toBe(human);
    }
  });

  it('returns "type: error" for unknown SSL-verify pairs', () => {
    expect(renderSSLVerify({ type: 'unknown_type', error: 'unknown_error' }))
      .toBe('unknown_type: unknown_error');
    // Known type with an unknown error code falls back to the same
    // pattern (banner still displays something useful).
    expect(renderSSLVerify({ type: 'bad_cert', error: 'totally_new_error' }))
      .toBe('bad_cert: totally_new_error');
  });

  it('returns empty string for null / undefined / malformed input', () => {
    // Engine omits `sslVerifyError` from the wire for non-SSL failures
    // (see protocols.d toJson, plan section C); the TS interface marks
    // the field optional so the JSON may be missing entirely. Banner
    // code shouldn't call this with null, but defend against it.
    expect(renderSSLVerify(null)).toBe('');
    expect(renderSSLVerify(undefined)).toBe('');
    expect(renderSSLVerify({} as unknown as { type: string; error: string })).toBe('');
    expect(renderSSLVerify({ type: 'bad_cert' } as unknown as { type: string; error: string })).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────
// The critic's OE1 fix scope was to ship ONLY renderReason +
// renderSSLVerify. The below skipped-export test pins that scope so a
// future PR can't accidentally re-introduce renderRestricted /
// renderRestrictedShort / renderPostError without updating this test
// (a forced reminder that those exports require a consumer).
// ─────────────────────────────────────────────────────────────────────

describe('renderReasons module shape (OE1 trim scope guard)', () => {
  it('only exports renderReason + renderSSLVerify', async () => {
    // Dynamic import + symbol enumeration so the test fails the moment
    // someone re-adds a dropped export — prevents the Wave-4/5 banner
    // work from accidentally depending on a helper that doesn't exist.
    const mod = await import('./renderReasons');
    expect(Object.keys(mod).sort()).toEqual(['renderReason', 'renderSSLVerify']);
  });
});
