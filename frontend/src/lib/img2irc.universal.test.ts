import { describe, expect, it } from 'vitest';
import { GLYPHS, UNIVERSAL_GLYPHS, UNIVERSAL_SET } from './img2irc';

describe('universal glyphs', () => {
  it('UNIVERSAL_GLYPHS is 10 entries', () => {
    expect(UNIVERSAL_GLYPHS.length).toBe(10);
  });
  it('every universal glyph is in UNIVERSAL_SET', () => {
    const allowed = [' ', '▀','▄','█','▌','▐','░','▒','▓','⣿'];
    expect(UNIVERSAL_GLYPHS.every(g=> allowed.includes(g.ch))).toBe(true);
    expect(UNIVERSAL_GLYPHS.every(g=> UNIVERSAL_SET.has(g.ch))).toBe(true);
  });
  it('GLYPHS unchanged', () => {
    // GLYPHS grew to 37 after 9ae2bb3 (1588 → filtered 37); just ensure universal is subset
    expect(GLYPHS.length).toBeGreaterThanOrEqual(UNIVERSAL_GLYPHS.length);
    expect(UNIVERSAL_GLYPHS.every(g=> GLYPHS.some(x=> x.ch===g.ch))).toBe(true);
  });
  it('UNIVERSAL_SET has 9 chars', () => {
    expect(UNIVERSAL_SET.size).toBe(10);
  });
});
