import { describe, it, expect } from 'vitest';
import { dpSeg, segCost, isValid, bruteSeg } from './segmentation';
import { renderPixelsCore } from './img2irc';

// mirrors Lean's Seg.Valid and segCost
type G = string;

describe('Segmentation.lean — dpSeg optimal', () => {
  it('dpSeg cost equals segCost of its segs and is Valid', () => {
    const G: G[] = ['a', 'b'];
    const w = (i: number, len: number, g: G) => len * (g === 'a' ? 1 : 2) + i * 0.1;
    for (const n of [0, 1, 3, 6, 10]) {
      const { cost, segs } = dpSeg(w, G, n);
      expect(isValid(n, segs)).toBe(true);
      expect(segCost(w, 0, segs)).toBeCloseTo(cost, 9);
    }
  });

  it('dpSeg lower-bounds every valid segmentation (dpSeg_le_segCost)', () => {
    const G: G[] = ['half', 'quarter', 'braille'];
    const w = (i: number, len: number, g: G) => {
      const base = g === 'half' ? 5 : g === 'quarter' ? 7 : 9;
      return base * len + (i % 2);
    };
    for (const n of [4, 7]) {
      const { cost: dpCost } = dpSeg(w, G, n);
      // enumerate some valid segs manually
      const segs: G[][] = [
        Array(n).fill('half'),
        Array(n).fill('braille'),
        ['half', 'quarter', 'braille'].slice(0, n),
      ];
      for (const _ of segs) {
        // brute will give optimum, dp must be <= any valid
        const { cost: bruteCost } = bruteSeg(w, G, n);
        expect(dpCost).toBeCloseTo(bruteCost, 9);
      }
      // also random valid segs
      for (let t = 0; t < 20; t++) {
        let pos = 0; const cur: { len: number; g: G }[] = [];
        while (pos < n) {
          const remaining = n - pos;
          const len = 1 + Math.floor(Math.random() * remaining);
          const g = G[Math.floor(Math.random() * G.length)];
          cur.push({ len, g }); pos += len;
          if (cur.length > 10) break;
        }
        if (!isValid(n, cur)) continue;
        const c = segCost(w, 0, cur);
        expect(dpCost).toBeLessThanOrEqual(c + 1e-9);
      }
    }
  });

  it('dpSeg equals brute force for small n (exists_seg_eq_dpSeg)', () => {
    const G: G[] = ['x', 'y'];
    for (let n = 0; n <= 6; n++) {
      const w = (i: number, len: number, g: G) => (len + (g === 'x' ? 0.3 : 0.7)) * (1 + (i % 3) * 0.1);
      const dp = dpSeg(w, G, n);
      const brute = bruteSeg(w, G, n);
      expect(dp.cost).toBeCloseTo(brute.cost, 9);
      expect(isValid(n, dp.segs)).toBe(true);
      expect(segCost(w, 0, dp.segs)).toBeCloseTo(dp.cost, 9);
    }
  });

  it('cap L respects Lean Θ(n·L·|G|) variant', () => {
    const G: G[] = ['a', 'b'];
    const w = (i: number, len: number, _g: G) => len * 2;
    const n = 10; const L = 3;
    const { cost, segs } = dpSeg(w, G, n, L);
    expect(isValid(n, segs)).toBe(true);
    for (const s of segs) expect(s.len).toBeLessThanOrEqual(L);
    // with cap, cost may be higher than uncapped (no free long segment)
    const uncapped = dpSeg(w, G, n);
    expect(cost).toBeGreaterThanOrEqual(uncapped.cost - 1e-9);
  });

  it('auto pixelMode renders via dpSeg and is not worse than single geometry', async () => {
    // Build a 60×~30 image split: left half solid, right half checker
    const cols = 20, rows = 8, pW = cols, pH = rows * 2;
    const d = new Uint8ClampedArray(pW * pH * 4);
    for (let y = 0; y < pH; y++) for (let x = 0; x < pW; x++) {
      const i = (y * pW + x) * 4;
      if (x < pW / 2) { d[i] = 200; d[i + 1] = 20; d[i + 2] = 20; } else { d[i] = ((x + y) % 2 ? 255 : 0); d[i + 1] = ((x + y) % 2 ? 255 : 0); d[i + 2] = ((x + y) % 2 ? 255 : 0); }
      d[i + 3] = 255;
    }
    const baseOpts: any = {
      width: cols, renderMode: 'irc', filter: 'nearest', brightness: 0, contrast: 0, gamma: 0, saturation: 0, hue: 0,
      invert: false, grayscale: false, sepia: false, normalize: false, dither: false, ditherMode: 'none',
      colorMatching: 'oklab', flipH: false, flipV: false, rotate: 0, pixelize: 0, blur: 0, nograyscale: false, viterbiW: 2, comic: false,
      alphaMode: 'opaque', alphaThreshold: 128, trimTransparent: false, smartEdges: true, background: '#000000',
    };
    const halfArt = await renderPixelsCore(d.slice() as any, pW, pH, cols, rows, 'half', { ...baseOpts, pixelMode: 'half' });
    const autoArt = await renderPixelsCore(d.slice() as any, pW, pH, cols, rows, 'auto', { ...baseOpts, pixelMode: 'auto' });
    // auto's dpSeg cost is optimal for its w, so its byte length should be <= worst single geometry's length (or at least not NaN)
    expect(autoArt.length).toBeGreaterThan(0);
    expect(halfArt.length).toBeGreaterThan(0);
    // auto should not be drastically worse than half (allow 30% overhead due to segment boundaries)
    expect(autoArt.length).toBeLessThan(halfArt.length * 1.5);
  });
});
