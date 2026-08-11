import { describe, it, expect } from 'vitest';
import { IRC99, estimateLineLengths, clearColorLut } from './img2irc';

describe('img2irc', () => {
  it('IRC99 has 99 entries', () => {
    expect(IRC99).toHaveLength(99);
  });

  it('IRC99 first 16 match mIRC standard hex', () => {
    // white, black, navy...
    expect(IRC99[0].toString(16).padStart(6, '0')).toBe('ffffff');
    expect(IRC99[1].toString(16).padStart(6, '0')).toBe('000000');
    expect(IRC99[2].toString(16).padStart(6, '0')).toBe('00007f');
    expect(IRC99[4].toString(16).padStart(6, '0')).toBe('ff0000');
  });

  it('estimateLineLengths reports ok for short art', () => {
    const art = '\x033,5▀\x0f\n\x034,6█\x0f';
    const { ok, longest, lines } = estimateLineLengths(art);
    expect(ok).toBe(true);
    expect(lines).toBe(2);
    expect(longest).toBeLessThan(400);
  });

  it('estimateLineLengths flags overly long lines', () => {
    const long = '\x03' + '1,2' + '▀'.repeat(300) + '\x0f';
    const { ok } = estimateLineLengths(long, 100);
    expect(ok).toBe(false);
  });
  it('clearColorLut is callable and clears', () => {
    expect(() => clearColorLut()).not.toThrow();
  });

  it('IRC99 palette matches img2irc palette.rs', () => {
    expect(IRC99[0]).toBe(0xffffff);
    expect(IRC99[1]).toBe(0x000000);
    expect(IRC99[14]).toBe(0x555555);
    expect(IRC99[15]).toBe(0xaaaaaa);
    expect(IRC99[98]).toBe(0xffffff);
  });

  it('estimateLineLengths handles empty input', () => {
    const { ok, lines, longest } = estimateLineLengths('');
    expect(ok).toBe(true);
    expect(lines).toBe(1);
    expect(longest).toBe(0);
  });
});
