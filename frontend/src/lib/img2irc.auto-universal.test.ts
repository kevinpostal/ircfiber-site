import { describe, expect, it } from 'vitest';
import { getFilteredGlyphs, UNIVERSAL_GLYPHS, UNIVERSAL_SET, GLYPHS } from './img2irc';

describe('auto universal', () => {
  it('bare auto returns universal', () => {
    const g = getFilteredGlyphs({ pixelMode: 'auto' } as any);
    expect(g).not.toBeNull();
    expect(g!.length).toBe(10);
    expect(g!.every(x=> UNIVERSAL_SET.has(x.ch))).toBe(true);
  });
  it('auto with custom glyphAlphabet respects custom', () => {
    const g = getFilteredGlyphs({ pixelMode: 'auto', glyphAlphabet: '▲' } as any);
    expect(g).not.toBeNull();
    expect(g!.some(x=> x.ch==='▲')).toBe(true);
  });
  it('non-auto without alphabet returns null (fallback to GLYPHS)', () => {
    expect(getFilteredGlyphs({ pixelMode: 'half' } as any)).toBeNull();
    expect(getFilteredGlyphs({ pixelMode: 'quarter' } as any)).toBeNull();
  });
  it('smart without alphabet returns null', () => {
    expect(getFilteredGlyphs({ pixelMode: 'smart' } as any)).toBeNull();
  });
  it('universal glyphs are subset of GLYPHS', () => {
    for (const u of UNIVERSAL_GLYPHS) {
      expect(GLYPHS.some(g=> g.ch===u.ch)).toBe(true);
    }
  });
  it('universal contains exactly space, half, full, left/right halves, shades + braille full', () => {
    const chars = UNIVERSAL_GLYPHS.map(g=>g.ch).sort().join('');
    expect(chars).toContain(' ');
    expect(chars).toContain('▀');
    expect(chars).toContain('▄');
    expect(chars).toContain('█');
    expect(chars).toContain('▌');
    expect(chars).toContain('▐');
    expect(chars).toContain('░');
    expect(chars).toContain('▒');
    expect(chars).toContain('▓');
    expect(chars).toContain('⣿');
    // ensure no exotic triangles/quarters etc
    expect(chars).not.toContain('▲');
    expect(chars).not.toContain('▖');
    // only ⣿ braille allowed, not other braille patterns
    const brailleOther = chars.replace('⣿','');
    expect(brailleOther).not.toMatch(/[\u2800-\u28FF]/);
  });
});
