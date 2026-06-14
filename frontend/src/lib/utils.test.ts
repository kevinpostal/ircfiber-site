import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  stringHash,
  formatTime12Hour,
  formatDate,
  stripPrefix,
  getUserModePrefix,
  getAvatarColor,
  generateLabel,
  naturalCompare,
  getIrcCloudTypeClass,
  formatNumericText,
  normaliseIdentifier,
  nickColorIndex,
} from './utils';

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes less than', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quote', () => {
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('escapes single quote', () => {
    expect(escapeHtml("it's")).toBe('it&#039;s');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('returns empty for null/undefined', () => {
    expect(escapeHtml(null as unknown as string)).toBe('');
    expect(escapeHtml(undefined as unknown as string)).toBe('');
  });
});

describe('stringHash', () => {
  it('is deterministic', () => {
    expect(stringHash('hello')).toBe(stringHash('hello'));
  });

  it('returns non-negative value', () => {
    expect(stringHash('test')).toBeGreaterThanOrEqual(0);
  });

  it('produces different hashes for different strings', () => {
    expect(stringHash('abc')).not.toBe(stringHash('def'));
  });
});

describe('formatTime12Hour', () => {
  it('returns AM/PM format', () => {
    const date = new Date(2024, 0, 1, 13, 30, 45);
    expect(formatTime12Hour(date)).toBe('1:30:45 PM');
  });

  it('formats midnight as 12 AM', () => {
    const date = new Date(2024, 0, 1, 0, 0, 0);
    expect(formatTime12Hour(date)).toBe('12:00:00 AM');
  });

  it('formats noon as 12 PM', () => {
    const date = new Date(2024, 0, 1, 12, 0, 0);
    expect(formatTime12Hour(date)).toBe('12:00:00 PM');
  });

  it('pads minutes and seconds', () => {
    const date = new Date(2024, 0, 1, 9, 5, 9);
    expect(formatTime12Hour(date)).toBe('9:05:09 AM');
  });
});

describe('formatDate', () => {
  it('formats date with ordinal suffix', () => {
    expect(formatDate('2024-01-01')).toBe('Monday, January 1st, 2024');
    expect(formatDate('2024-01-02')).toBe('Tuesday, January 2nd, 2024');
    expect(formatDate('2024-01-03')).toBe('Wednesday, January 3rd, 2024');
    expect(formatDate('2024-01-04')).toBe('Thursday, January 4th, 2024');
  });

  it('handles 11th, 12th, 13th correctly', () => {
    expect(formatDate('2024-01-11')).toBe('Thursday, January 11th, 2024');
    expect(formatDate('2024-01-12')).toBe('Friday, January 12th, 2024');
    expect(formatDate('2024-01-13')).toBe('Saturday, January 13th, 2024');
  });
});

describe('stripPrefix', () => {
  it('removes ~ prefix', () => {
    expect(stripPrefix('~alice')).toBe('alice');
  });

  it('removes & prefix', () => {
    expect(stripPrefix('&alice')).toBe('alice');
  });

  it('removes @ prefix', () => {
    expect(stripPrefix('@alice')).toBe('alice');
  });

  it('removes % prefix', () => {
    expect(stripPrefix('%alice')).toBe('alice');
  });

  it('removes + prefix', () => {
    expect(stripPrefix('+alice')).toBe('alice');
  });

  it('removes ! prefix', () => {
    expect(stripPrefix('!alice')).toBe('alice');
  });

  it('removes multiple prefixes', () => {
    expect(stripPrefix('@+alice')).toBe('alice');
  });

  it('strips hostmask after !', () => {
    expect(stripPrefix('alice!user@host')).toBe('alice');
  });

  it('returns nick unchanged when no prefix', () => {
    expect(stripPrefix('alice')).toBe('alice');
  });
});

describe('getUserModePrefix', () => {
  it('returns OPER for ! prefix', () => {
    const result = getUserModePrefix('!alice');
    expect(result.category).toBe('OPER');
    expect(result.prefix).toBe('!');
  });

  it('returns OWNER for ~ prefix', () => {
    const result = getUserModePrefix('~alice');
    expect(result.category).toBe('OWNER');
    expect(result.prefix).toBe('~');
  });

  it('returns ADMIN for & prefix', () => {
    const result = getUserModePrefix('&alice');
    expect(result.category).toBe('ADMIN');
    expect(result.prefix).toBe('&');
  });

  it('returns OP for @ prefix', () => {
    const result = getUserModePrefix('@alice');;
    expect(result.category).toBe('OP');
    expect(result.prefix).toBe('@');
  });

  it('returns HALFOP for % prefix', () => {
    const result = getUserModePrefix('%alice');
    expect(result.category).toBe('HALFOP');
    expect(result.prefix).toBe('%');
  });

  it('returns VOICED for + prefix', () => {
    const result = getUserModePrefix('+alice');
    expect(result.category).toBe('VOICED');
    expect(result.prefix).toBe('+');
  });

  it('returns MEMBER for no prefix', () => {
    const result = getUserModePrefix('alice');
    expect(result.category).toBe('MEMBER');
    expect(result.prefix).toBe('');
  });
});

describe('getAvatarColor', () => {
  it('returns a color from the palette', () => {
    const color = getAvatarColor('alice');
    expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('is deterministic for same nick', () => {
    expect(getAvatarColor('alice')).toBe(getAvatarColor('alice'));
  });

  it('may return different colors for different nicks', () => {
    // Different nicks usually get different colors but same is possible
    expect(getAvatarColor('alice')).toBeDefined();
    expect(getAvatarColor('bob')).toBeDefined();
  });
});

describe('generateLabel', () => {
  it('produces UUID-like string', () => {
    const label = generateLabel();
    expect(label).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('produces different values on each call', () => {
    const a = generateLabel();
    const b = generateLabel();
    expect(a).not.toBe(b);
  });
});

describe('naturalCompare', () => {
  it('sorts case-insensitively', () => {
    expect(naturalCompare('Alice', 'bob')).toBeLessThan(0);
    expect(naturalCompare('alice', 'Bob')).toBeLessThan(0);
  });

  it('sorts numbers naturally', () => {
    expect(naturalCompare('item2', 'item10')).toBeLessThan(0);
  });

  it('handles equal strings', () => {
    expect(naturalCompare('same', 'same')).toBe(0);
  });
});

describe('getIrcCloudTypeClass', () => {
  it('returns correct class for welcome command', () => {
    expect(getIrcCloudTypeClass('001')).toBe('type_server_welcome');
  });

  it('returns correct class for JOIN', () => {
    expect(getIrcCloudTypeClass('JOIN')).toBe('type_joined_channel');
  });

  it('returns correct class for PART', () => {
    expect(getIrcCloudTypeClass('PART')).toBe('type_parted_channel');
  });

  it('returns correct class for QUIT', () => {
    expect(getIrcCloudTypeClass('QUIT')).toBe('type_quit');
  });

  it('returns user mode class for non-channel MODE', () => {
    expect(getIrcCloudTypeClass('MODE', ['alice', '+i'])).toBe('type_user_mode');
  });

  it('returns channel mode class for channel MODE', () => {
    expect(getIrcCloudTypeClass('MODE', ['#channel', '+o', 'alice'])).toBe('type_channel_mode');
  });

  it('returns correct CAP subcommand classes', () => {
    expect(getIrcCloudTypeClass('CAP', ['LS'])).toBe('type_cap_ls');
    expect(getIrcCloudTypeClass('CAP', ['REQ'])).toBe('type_cap_req');
    expect(getIrcCloudTypeClass('CAP', ['ACK'])).toBe('type_cap_ack');
    expect(getIrcCloudTypeClass('CAP', ['NEW'])).toBe('type_cap_new');
    expect(getIrcCloudTypeClass('CAP', ['DEL'])).toBe('type_cap_del');
    expect(getIrcCloudTypeClass('CAP', ['NAK'])).toBe('type_cap_nak');
    expect(getIrcCloudTypeClass('CAP', ['OTHER'])).toBe('type_cap');
  });

  it('returns empty string for unknown command', () => {
    expect(getIrcCloudTypeClass('UNKNOWN')).toBe('');
  });
});

describe('formatNumericText', () => {
  it('formats 001 with default text', () => {
    expect(formatNumericText('001', [], '', 'alice')).toBe('Welcome to the network, alice');
  });

  it('uses provided text for 001 when available', () => {
    expect(formatNumericText('001', [], 'Custom welcome', 'alice')).toBe('Custom welcome');
  });

  it('formats 004 with params', () => {
    expect(formatNumericText('004', ['server', 'version', 'umodes', 'cmodes'], '')).toBe('server version umodes cmodes');
  });

  it('formats 311 (WHOIS user)', () => {
    expect(formatNumericText('311', ['alice', 'user', 'host', '*'], 'realname')).toBe('alice is user@host * realname');
  });

  it('formats 317 (idle time)', () => {
    expect(formatNumericText('317', ['alice', '3600'], '')).toBe('alice has been idle 3600 seconds');
  });

  it('formats 330 (logged in as)', () => {
    expect(formatNumericText('330', ['alice', 'account'], '')).toBe('alice is logged in as account');
  });

  it('returns empty string for 366', () => {
    expect(formatNumericText('366', [], 'End of /NAMES')).toBe('');
  });

  it('returns empty string for 376', () => {
    expect(formatNumericText('376', [], 'End of MOTD')).toBe('');
  });

  it('returns text for unhandled numeric', () => {
    expect(formatNumericText('999', [], 'Unknown')).toBe('Unknown');
  });

  it('formats 333 (topic who/time) with correct params layout', () => {
    const out = formatNumericText('333', ['me', '#autism', 'roarie', '1718692000'], '');
    expect(out).toMatch(/^Topic set by roarie at /);
    expect(out).not.toContain('Invalid Date');
    expect(out).not.toContain('#autism');
  });

  it('333 omits the date gracefully when timestamp is missing', () => {
    expect(formatNumericText('333', ['me', '#autism', 'roarie'], '')).toBe('Topic set by roarie');
  });

  it('333 falls back to text when params are missing', () => {
    expect(formatNumericText('333', [], 'fallback')).toBe('fallback');
  });
});

describe('normaliseIdentifier', () => {
  it('lowercases the nick', () => {
    expect(normaliseIdentifier('AShapiro')).toBe('ashapiro');
  });

  it('strips an away-suffix after | or @', () => {
    expect(normaliseIdentifier('alice|away')).toBe('alice');
    expect(normaliseIdentifier('alice@host')).toBe('alice');
  });

  it('strips ornamental leading characters', () => {
    expect(normaliseIdentifier('_alice')).toBe('alice');
    expect(normaliseIdentifier('`alice')).toBe('alice');
    expect(normaliseIdentifier('[alice]')).toBe('alice]');
  });

  it('strips trailing _ and backticks', () => {
    expect(normaliseIdentifier('sq_')).toBe('sq');
    expect(normaliseIdentifier('alice___')).toBe('alice');
    expect(normaliseIdentifier('alice`')).toBe('alice');
  });

  it('falls back to a space for empty input', () => {
    expect(normaliseIdentifier('')).toBe(' ');
    expect(normaliseIdentifier(null)).toBe(' ');
    expect(normaliseIdentifier(undefined)).toBe(' ');
  });
});

describe('nickColorIndex (IRCCloud parity)', () => {
  // Ground-truth pairs harvested from a live IRCCloud session via
  // Playwright (see irccloud_nicks_colors.json). If any of these break
  // it means our hash has drifted from IRCCloud's and avatars/nicks will
  // start rendering in different colours between the two clients.
  const pairs: Array<[string, number]> = [
    ['amita', 19], ['don', 14], ['charlie', 20], ['AShapiro', 22],
    ['RAPEEPORN_SINGH', 18], ['roarie', 11], ['sq_', 9], ['Carlos', 9],
    ['chud', 19], ['scroll', 14], ['bombuzal', 3],
  ];
  for (const [nick, expected] of pairs) {
    it(`maps "${nick}" to c${expected}`, () => {
      expect(nickColorIndex(nick)).toBe(expected);
    });
  }

  it('treats trailing-underscore aliases as the same colour', () => {
    expect(nickColorIndex('alice')).toBe(nickColorIndex('alice_'));
    expect(nickColorIndex('alice')).toBe(nickColorIndex('alice__'));
  });

  it('is case-insensitive', () => {
    expect(nickColorIndex('Alice')).toBe(nickColorIndex('alice'));
    expect(nickColorIndex('ALICE')).toBe(nickColorIndex('alice'));
  });

  it('always returns a non-negative index < 27', () => {
    for (const n of ['', 'a', 'long-nick-name', 'WAY|TOO|MANY|PIPES']) {
      const idx = nickColorIndex(n);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(27);
    }
  });
});
