// ─────────────────────────────────────────────────────────────────────
// suspiciousConnection.test.ts — port of IRCCloud's test cases
// ─────────────────────────────────────────────────────────────────────
//
// Direct coverage of every branch lifted from
// irccloud-webpack-study/app/src/model/connection.js:204-216. Pure
// helpers, lib project.
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { isSuspiciousPort, isSuspiciousHostname } from './suspiciousConnection';

describe('isSuspiciousPort', () => {
  // The pair-of-cases from the plan W2-T01 PART B — pinned by
  // acceptance criteria so a future sign flip in the comparisons
  // fails here, not in the banner component test.

  describe('classic 6667 / 6697 pair', () => {
    it('flags 6667 + SSL=true (SSL on plain port)', () => {
      expect(isSuspiciousPort(6667, true)).not.toBeNull();
    });
    it('does NOT flag 6697 + SSL=true (canonical SSL port)', () => {
      expect(isSuspiciousPort(6697, true)).toBeNull();
    });
    it('flags 6697 + SSL=false (plain on TLS port)', () => {
      expect(isSuspiciousPort(6697, false)).not.toBeNull();
    });
    it('does NOT flag 6667 + SSL=false (canonical plain port)', () => {
      expect(isSuspiciousPort(6667, false)).toBeNull();
    });
  });

  describe('extended plain-IRC range (6660-6669, 7000)', () => {
    it('flags each plain IRC port when SSL=true', () => {
      for (const port of [6660, 6661, 6662, 6663, 6664, 6665, 6666, 6668, 6669, 7000]) {
        expect(isSuspiciousPort(port, true)).not.toBeNull();
      }
    });
    it('does NOT flag them when SSL=false', () => {
      for (const port of [6660, 6661, 6662, 6663, 6664, 6665, 6666, 6668, 6669, 7000]) {
        expect(isSuspiciousPort(port, false)).toBeNull();
      }
    });
  });

  describe('extended SSL range (6690-6699 minus 6697)', () => {
    it('flags each non-6697 SSL port when SSL=false', () => {
      for (const port of [6690, 6691, 6692, 6693, 6694, 6695, 6696, 6698, 6699]) {
        expect(isSuspiciousPort(port, false)).not.toBeNull();
      }
    });
    it('does NOT flag them when SSL=true', () => {
      for (const port of [6690, 6691, 6692, 6693, 6694, 6695, 6696, 6698, 6699]) {
        expect(isSuspiciousPort(port, true)).toBeNull();
      }
    });
  });

  describe('unrelated ports are always clean', () => {
    // Excluded: 6667 (plain default), 6697 (TLS default), 6660-6669
    // and 6690-6699 (plain/TLS ranges) — those are tested in their
    // own describe blocks. 80/443/8080 are HTTP/HTTPS-adjacent; the
    // rest are RFC-assigned but unused for IRC.
    it.each([80, 443, 8080, 22, 25, 53, 9001, 12345])(
      'returns null for port %i',
      (port) => {
        expect(isSuspiciousPort(port, true)).toBeNull();
        expect(isSuspiciousPort(port, false)).toBeNull();
      },
    );
  });

  describe('defensive invalid inputs', () => {
    it('returns null for non-numeric / non-positive ports', () => {
      expect(isSuspiciousPort(Number.NaN, true)).toBeNull();
      expect(isSuspiciousPort(-1, true)).toBeNull();
      expect(isSuspiciousPort(0, true)).toBeNull();
    });
  });

  describe('warning string content', () => {
    it('mentions "SSL" and the port when SSL on plain port', () => {
      const msg = isSuspiciousPort(6667, true);
      expect(msg).toContain('SSL');
      expect(msg).toContain('6667');
    });
    it('mentions "without SSL" and the port when plain on TLS port', () => {
      const msg = isSuspiciousPort(6697, false);
      expect(msg).toContain('SSL');
      expect(msg).toContain('6697');
    });
  });
});

describe('isSuspiciousHostname', () => {
  // Direct port of IRCCloud's test cases from connectionstatusview.js
  // (which exercises the same condition structure).

  it('returns null for a fully-qualified hostname', () => {
    expect(isSuspiciousHostname('irc.example.org')).toBeNull();
    expect(isSuspiciousHostname('chat.example.com')).toBeNull();
    expect(isSuspiciousHostname('a.b.c.d.e.f.g')).toBeNull();
  });

  it('flags a leading dot', () => {
    expect(isSuspiciousHostname('.irc.example.org')).not.toBeNull();
  });
  it('flags a trailing dot', () => {
    expect(isSuspiciousHostname('irc.example.org.')).not.toBeNull();
  });
  it('flags a single-label hostname with no dot and no colon (localhost)', () => {
    expect(isSuspiciousHostname('localhost')).not.toBeNull();
    expect(isSuspiciousHostname('myhost')).not.toBeNull();
  });
  it('does NOT flag IPv6 literals (have a colon)', () => {
    expect(isSuspiciousHostname('::1')).toBeNull();
    expect(isSuspiciousHostname('fe80::1')).toBeNull();
  });
  it('returns null for the empty hostname (defensive — banner has its own copy)', () => {
    expect(isSuspiciousHostname('')).toBeNull();
  });
  it('returns null for non-string input (defensive)', () => {
    expect(isSuspiciousHostname(undefined as unknown as string)).toBeNull();
    expect(isSuspiciousHostname(null as unknown as string)).toBeNull();
    expect(isSuspiciousHostname(42 as unknown as string)).toBeNull();
  });

  describe('warning string content', () => {
    it('includes the hostname when flagging no-dot/no-colon', () => {
      expect(isSuspiciousHostname('localhost')).toContain('localhost');
    });
    it('mentions "leading dot" for leading-dot case', () => {
      expect(isSuspiciousHostname('.irc.example.org') ?? '').toContain('leading dot');
    });
    it('mentions "trailing dot" for trailing-dot case', () => {
      expect(isSuspiciousHostname('irc.example.org.') ?? '').toContain('trailing dot');
    });
  });

  describe('symmetric API (isSSL parameter — currently unused)', () => {
    it('ignores the second parameter — same result with or without it', () => {
      expect(isSuspiciousHostname('localhost', true)).toBe(
        isSuspiciousHostname('localhost', false),
      );
      expect(isSuspiciousHostname('localhost', undefined)).toBe(
        isSuspiciousHostname('localhost'),
      );
    });
  });
});
