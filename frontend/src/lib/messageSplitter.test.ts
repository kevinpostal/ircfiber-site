import { describe, it, expect } from 'vitest';
import { splitIntoMessages, utf8Length, ircPayloadBudget, MESSAGE_LENGTH_TRIGGER } from './messageSplitter';

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** No line may contain an unpaired surrogate — that would mean we split a pair. */
function hasLoneSurrogate(line: string): boolean {
  return [...line].some((c) => {
    const cp = c.codePointAt(0) as number;
    return cp >= 0xd800 && cp <= 0xdfff;
  });
}

describe('utf8Length', () => {
  it('counts bytes, not UTF-16 code units', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('漢')).toBe(3);
    expect(utf8Length('\u{1F600}')).toBe(4);
    // 4 bytes but 2 code units — the bug this module exists to prevent.
    expect('\u{1F600}'.length).toBe(2);
  });
});

describe('ircPayloadBudget', () => {
  it('subtracts every uncontrolled byte of a PRIVMSG line', () => {
    // 512 - 1(':') - 27(hostmask) - 1(' ') - 7('PRIVMSG') - 1(' ')
    //     - 8('#channel') - 2(' :') - 2(CRLF) - 16(safety) = 447
    const hostmask = 'nick!~user@host.example.com';
    expect(bytes(hostmask)).toBe(27);
    expect(ircPayloadBudget({ LINELEN: '512' }, hostmask, '#channel')).toBe(447);
  });

  it('falls back to LINELEN 512 and the 105-byte worst-case hostmask', () => {
    // 512 - 1 - 105 - 1 - 7 - 1 - 8 - 2 - 2 - 16 = 369
    expect(ircPayloadBudget({}, '', '#channel')).toBe(369);
    expect(ircPayloadBudget(undefined, '', '#channel')).toBe(369);
  });

  it('honours a larger advertised LINELEN', () => {
    expect(ircPayloadBudget({ LINELEN: '1024' }, 'nick!~user@host.example.com', '#channel')).toBe(959);
  });

  it('counts multi-byte target names in bytes', () => {
    const ascii = ircPayloadBudget({ LINELEN: '512' }, 'n!u@h', '#ab');
    const cjk = ircPayloadBudget({ LINELEN: '512' }, 'n!u@h', '#漢');
    // '#漢' is 2 code units but 4 bytes vs '#ab' 3 bytes → 1 byte less budget.
    expect(ascii - cjk).toBe(1);
  });

  it('clamps a hostile/tiny LINELEN to 80', () => {
    expect(ircPayloadBudget({ LINELEN: '40' }, 'nick!~user@host.example.com', '#channel')).toBe(80);
    expect(ircPayloadBudget({ LINELEN: '0' }, '', '#channel')).toBe(369); // 0 → falsy → 512
  });
});

describe('splitIntoMessages — byte budget', () => {
  it('keeps an ASCII line of exactly the budget as one message', () => {
    const line = 'a'.repeat(64);
    expect(splitIntoMessages(line, 64)).toEqual([line]);
  });

  it('splits an ASCII line of budget + 1 into two messages', () => {
    const line = 'a'.repeat(65);
    const out = splitIntoMessages(line, 64);
    expect(out).toEqual(['a'.repeat(64), 'a']);
    expect(out.join('')).toBe(line);
  });

  it('keeps every part within the byte budget for 200 emoji (4 bytes each)', () => {
    const input = '\u{1F600}'.repeat(200);
    expect(bytes(input)).toBe(800);
    const out = splitIntoMessages(input, 400);
    expect(out.length).toBe(2);
    for (const line of out) {
      expect(bytes(line)).toBeLessThanOrEqual(400);
      expect(hasLoneSurrogate(line)).toBe(false);
    }
    expect(out.join('')).toBe(input);
  });

  it('never splits a surrogate pair on an odd budget', () => {
    const input = '\u{1F600}'.repeat(50);
    const out = splitIntoMessages(input, 17); // 17 / 4 = 4 emoji per line
    for (const line of out) {
      expect(bytes(line)).toBeLessThanOrEqual(17);
      expect(hasLoneSurrogate(line)).toBe(false);
      expect([...line].every((c) => c === '\u{1F600}')).toBe(true);
    }
    expect(out.join('')).toBe(input);
  });

  it('keeps every part within the byte budget for CJK (3 bytes each)', () => {
    const input = '漢'.repeat(200);
    expect(bytes(input)).toBe(600);
    const out = splitIntoMessages(input, 400);
    expect(out.length).toBe(2);
    for (const line of out) {
      expect(bytes(line)).toBeLessThanOrEqual(400);
      expect(hasLoneSurrogate(line)).toBe(false);
    }
    expect(out.join('')).toBe(input);
    // A .length-based splitter would have emitted one 600-byte line here.
    expect(input.length).toBeLessThanOrEqual(400);
  });

  it('prefers the last space at or before the budget and stays lossless', () => {
    const out = splitIntoMessages('aaa bbb ccc', 8, false);
    expect(out).toEqual(['aaa bbb ', 'ccc']);
    expect(out.join('')).toBe('aaa bbb ccc');
  });

  it('hard-breaks a single word longer than the budget instead of dropping it', () => {
    const out = splitIntoMessages('aaaaaaaaaaaaaaaaaaaaaa', 5, false);
    expect(out).toEqual(['aaaaa', 'aaaaa', 'aaaaa', 'aaaaa', 'aa']);
    expect(out.join('')).toBe('aaaaaaaaaaaaaaaaaaaaaa');
  });

  it('hard-breaks an over-long word that follows a space break', () => {
    const out = splitIntoMessages('ab cdefghijkl', 5, false);
    expect(out.join('')).toBe('ab cdefghijkl');
    for (const line of out) expect(bytes(line)).toBeLessThanOrEqual(5);
  });

  it('emits an oversized single code point alone rather than looping', () => {
    const out = splitIntoMessages('a\u{1F600}b', 2, false);
    expect(out.join('')).toBe('a\u{1F600}b');
    expect(out).toContain('\u{1F600}');
  });

  it('stays linear on a 100 KB paste', () => {
    const input = ('word '.repeat(20_000)).trimEnd();
    const started = Date.now();
    const out = splitIntoMessages(input, 400, false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.join('')).toBe(input);
    for (const line of out) expect(bytes(line)).toBeLessThanOrEqual(400);
  });
});

describe('splitIntoMessages — newline handling', () => {
  it('gives each line its own message when not packing', () => {
    expect(splitIntoMessages('a\nb', 400, false)).toEqual(['a', 'b']);
  });

  it('preserves interior blank lines (multiline fidelity) and drops trailing ones', () => {
    expect(splitIntoMessages('a\n\nb', 400, false)).toEqual(['a', '', 'b']);
    expect(splitIntoMessages('a\n\n\n', 400, false)).toEqual(['a']);
  });

  it('handles CRLF and bare CR endings', () => {
    expect(splitIntoMessages('a\r\nb\rc', 400, false)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for empty input', () => {
    expect(splitIntoMessages('')).toEqual([]);
    expect(splitIntoMessages('', 400, false)).toEqual([]);
  });
});

describe('splitIntoMessages — packing', () => {
  it('packs short lines into one message', () => {
    expect(splitIntoMessages('hello\nfoo')).toEqual(['hello foo']);
  });

  it('breaks packing on blank lines', () => {
    expect(splitIntoMessages('one\n\ntwo')).toEqual(['one', 'two']);
  });

  it('respects the byte budget when packing', () => {
    const out = splitIntoMessages('aaa\nbbb\nccc\nddd\neee\nfff\nggg\nhhh\niii\njjj', 10);
    expect(out).toEqual(['aaa bbb', 'ccc ddd', 'eee fff', 'ggg hhh', 'iii jjj']);
    for (const m of out) expect(bytes(m)).toBeLessThanOrEqual(10);
  });

  it('packs multi-byte lines by bytes, not code units', () => {
    // 4 CJK lines of 3 chars = 9 bytes each; budget 20 fits two per message
    // (9 + 1 + 9 = 19) but a .length-based packer would fit all four.
    const out = splitIntoMessages('漢字漢\n漢字漢\n漢字漢\n漢字漢', 20);
    expect(out).toEqual(['漢字漢 漢字漢', '漢字漢 漢字漢']);
    for (const m of out) expect(bytes(m)).toBeLessThanOrEqual(20);
  });

  it('does not double the separator after a space break', () => {
    const out = splitIntoMessages('aaa bbb ccc', 8);
    expect(out.join('')).toBe('aaa bbb ccc');
  });
});

describe('MESSAGE_LENGTH_TRIGGER', () => {
  it('matches IRCCloud PastebinView.MESSAGE_LENGTH_TRIGGER', () => {
    expect(MESSAGE_LENGTH_TRIGGER).toBe(1080);
  });
});
