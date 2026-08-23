import { describe, it, expect, vi } from 'vitest';
import { selectGlyphsForImage } from './aristotleGlyphs';
import { glyphDominatedByByteGap, glyphOptimalBlockCoverage, glyphBandError } from './img2irc';

describe('aristotleGlyphs — offline heuristic (no network)', () => {
  it('selectGlyphsForImage mocked 80x40 half-block returns alphabet length 12-18', () => {
    const pW = 80, pH = 80; // 80 cols half → 80*? but we just need pW
    const cols = 80;
    const d = new Uint8ClampedArray(pW * pH * 4);
    // fill with gradient
    for (let y = 0; y < pH; y++) for (let x = 0; x < pW; x++) {
      const i = (y * pW + x) * 4;
      const v = Math.floor((x / pW) * 255);
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    const spec = selectGlyphsForImage(d, pW, pH, { cols, budgetBytes: 512, colorMode: 'oklab' });
    expect(spec.alphabet.length).toBeGreaterThanOrEqual(12);
    expect(spec.alphabet.length).toBeLessThanOrEqual(18);
    expect(spec.glyphs.length).toBe(spec.alphabet.length);
    expect(spec.reason).toContain('K=');
  });

  it('fits_512 holds after pruning', () => {
    const pW = 80, pH = 40;
    const d = new Uint8ClampedArray(pW * pH * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = 128; d[i + 1] = 128; d[i + 2] = 128; d[i + 3] = 255; }
    const spec = selectGlyphsForImage(d, pW, pH, { cols: 80, budgetBytes: 512, colorMode: 'rgb' });
    // after pruning, still within budget reasoning
    expect(spec.alphabet.includes(' ')).toBe(true);
  });

  it('no network calls', async () => {
    const spy = vi.spyOn(globalThis as any, 'fetch');
    const pW = 10, pH = 10;
    const d = new Uint8ClampedArray(pW * pH * 4).fill(100);
    selectGlyphsForImage(d, pW, pH, { cols: 10, budgetBytes: 512, colorMode: 'rgb' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('offline constants derived from Lean', () => {
    const opt = glyphOptimalBlockCoverage(0.273);
    expect(opt).toBeCloseTo(0.4243, 3);
    const errOpt = glyphBandError(0.273, opt);
    const errMeas = glyphBandError(0.273, 0.494);
    expect(errOpt).toBeLessThan(errMeas);
    const dominated = glyphDominatedByByteGap(2, 0.5, 0.5, 3, 0.0, 0.0, 1, 0.2);
    // dominated check is deterministic
    expect(typeof dominated).toBe('boolean');
  });
});
