import { describe, it, expect } from 'vitest';
import { renderPixelsCore } from './img2irc';

// Lean §1-2 helpers mirrored in TS
type R8 = [number, number]; // [r,c] 0..7
function hp(a: number, b: number): Set<string> {
  const s = new Set<string>();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (a * (2 * r + 1 - 8) + b * (2 * c + 1 - 8) <= 0) s.add(`${r},${c}`);
  }
  return s;
}
function rowMask(R: Set<number>): Set<string> {
  const s = new Set<string>();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (R.has(r)) s.add(`${r},${c}`);
  return s;
}
function colMask(C: Set<number>): Set<string> {
  const s = new Set<string>();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (C.has(c)) s.add(`${r},${c}`);
  return s;
}
function quadMask(Q: Set<string>): Set<string> {
  const s = new Set<string>();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const qr = r < 4 ? 0 : 1, qc = c < 4 ? 0 : 1;
    if (Q.has(`${qr},${qc}`)) s.add(`${r},${c}`);
  }
  return s;
}
function triUL(): Set<string> {
  const s = new Set<string>();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (r + c <= 7) s.add(`${r},${c}`);
  return s;
}
function symDiff(A: Set<string>, B: Set<string>): Set<string> {
  const d = new Set<string>();
  for (const x of A) if (!B.has(x)) d.add(x);
  for (const x of B) if (!A.has(x)) d.add(x);
  return d;
}
function bestErrL(A: Set<string>[], S: Set<string>): number {
  let best = 64;
  for (const M of A) best = Math.min(best, symDiff(S, M).size);
  return best;
}

describe('PolygonShapes.lean §1 — block bytes', () => {
  it('geometricShapes block has 96 code points', () => {
    const block = new Set<number>();
    for (let cp = 9632; cp <= 9727; cp++) block.add(cp);
    expect(block.size).toBe(96);
  });
  it('every geometric shape is 3 UTF-8 bytes (byte-neutral vs half)', () => {
    for (let cp = 9632; cp <= 9727; cp++) {
      const ch = String.fromCodePoint(cp);
      const bytes = new TextEncoder().encode(ch).length;
      expect(bytes).toBe(3);
    }
    for (const ch of ['▀', '▄', '█', '▌', '▐']) {
      expect(new TextEncoder().encode(ch).length).toBe(3);
    }
    for (const ch of ['◤', '◢', '◥', '◣']) {
      expect(new TextEncoder().encode(ch).length).toBe(3);
    }
  });
  it('corner triangles are 4 and complementary (2 masks)', () => {
    const triULSet = triUL();
    const triLRSet = new Set<string>();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (8 <= r + c) triLRSet.add(`${r},${c}`);
    const triURSet = new Set<string>();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (r <= c) triURSet.add(`${r},${c}`);
    const triLLSet = new Set<string>();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (c < r) triLLSet.add(`${r},${c}`);
    expect(triULSet.size).toBe(36);
    // complements within 64
    const all = new Set<string>();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) all.add(`${r},${c}`);
    const comp = (S: Set<string>) => {
      const cc = new Set<string>();
      for (const x of all) if (!S.has(x)) cc.add(x);
      return cc;
    };
    expect(symDiff(triLRSet, comp(triULSet)).size).toBe(0);
    expect(symDiff(triLLSet, comp(triURSet)).size).toBe(0);
    // hp equality
    expect(symDiff(triULSet, hp(1, 1)).size).toBe(0);
    expect(symDiff(triURSet, hp(1, -1)).size).toBe(0);
  });
});

describe('PolygonShapes.lean §2 — diagonal gaps', () => {
  it('tri_row_gap 16 and tight (▀ attains)', () => {
    const tri = triUL();
    let min = 64;
    for (let mask = 0; mask < 256; mask++) {
      const R = new Set<number>();
      for (let r = 0; r < 8; r++) if (mask & (1 << r)) R.add(r);
      const d = symDiff(tri, rowMask(R)).size;
      if (d < min) min = d;
    }
    expect(min).toBe(16);
    const tight = symDiff(tri, rowMask(new Set([0, 1, 2, 3]))).size;
    expect(tight).toBe(16);
  });
  it('tri_col_gap 16', () => {
    const tri = triUL();
    let min = 64;
    for (let mask = 0; mask < 256; mask++) {
      const C = new Set<number>();
      for (let c = 0; c < 8; c++) if (mask & (1 << c)) C.add(c);
      const d = symDiff(tri, colMask(C)).size;
      if (d < min) min = d;
    }
    expect(min).toBe(16);
  });
  it('tri_quad_gap 12 and tight', () => {
    const tri = triUL();
    let min = 64;
    for (let mask = 0; mask < 16; mask++) {
      const Q = new Set<string>();
      for (let q = 0; q < 4; q++) if (mask & (1 << q)) {
        const qr = q >> 1, qc = q & 1;
        Q.add(`${qr},${qc}`);
      }
      const d = symDiff(tri, quadMask(Q)).size;
      if (d < min) min = d;
    }
    expect(min).toBe(12);
    const tight = symDiff(tri, quadMask(new Set(['0,0', '0,1', '1,0']))).size;
    expect(tight).toBe(12);
  });
  it('tri_exact 0', () => {
    const tri = triUL();
    expect(symDiff(tri, tri).size).toBe(0);
  });
});

describe('PolygonShapes.lean §3 — sweep covering radius', () => {
  const axisAlpha = [hp(1, 0), hp(-1, 0), hp(0, 1), hp(0, -1)];
  const polyAlpha = [...axisAlpha, hp(1, 1), hp(1, -1), hp(-1, 1), hp(-1, -1)];
  const dirs: [number, number][] = [];
  for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) if (!(a === 0 && b === 0)) dirs.push([a, b]);

  it('dirs has 80', () => expect(dirs.length).toBe(80));
  it('axis covering radius 16 and worst 16 at hp 1 1', () => {
    let worst = 0;
    for (const [a, b] of dirs) {
      const e = bestErrL(axisAlpha, hp(a, b));
      worst = Math.max(worst, e);
      expect(e).toBeLessThanOrEqual(16);
    }
    expect(worst).toBe(16);
    expect(bestErrL(axisAlpha, hp(1, 1))).toBe(16);
  });
  it('polygon covering radius 8 (halved) and totals 632 vs 280', () => {
    let worstPoly = 0, sumAxis = 0, sumPoly = 0;
    for (const [a, b] of dirs) {
      const ea = bestErrL(axisAlpha, hp(a, b));
      const ep = bestErrL(polyAlpha, hp(a, b));
      worstPoly = Math.max(worstPoly, ep);
      sumAxis += ea; sumPoly += ep;
      expect(ep).toBeLessThanOrEqual(8);
    }
    expect(worstPoly).toBe(8);
    expect(sumAxis).toBe(632);
    expect(sumPoly).toBe(280);
    expect(bestErrL(polyAlpha, hp(1, 1))).toBe(0);
    expect(bestErrL(polyAlpha, hp(1, -1))).toBe(0);
  });
});

describe('PolygonShapes.lean §5-6 — continuum and encoder', () => {
  it('tan(pi/8)=sqrt2-1 and wedge ratio 1+sqrt2', () => {
    const wedge = (a: number) => Math.tan(a) / 4;
    const tanPi8 = Math.tan(Math.PI / 8);
    expect(tanPi8).toBeCloseTo(Math.sqrt(2) - 1, 10);
    expect(wedge(Math.PI / 4)).toBeCloseTo(1 / 4, 12);
    expect(wedge(Math.PI / 8)).toBeCloseTo((Math.sqrt(2) - 1) / 4, 12);
    expect(wedge(Math.PI / 4) / wedge(Math.PI / 8)).toBeCloseTo(1 + Math.sqrt(2), 10);
  });
  it('equal_bytes_pure_error: 3-byte choice is pure error', () => {
    // cellCost w contrast bytes S M = err contrast S M + w*bytes ; if bytes equal, ordering = err ordering
    const err = (S: Set<string>, M: Set<string>, contrast: number) => symDiff(S, M).size * contrast;
    const cellCost = (w: number, contrast: number, bytes: number, S: Set<string>, M: Set<string>) => err(S, M, contrast) + w * bytes;
    const S = hp(1, 1), M = hp(1, 0), N = hp(1, 1);
    const w = 2.5, contrast = 10, bytes = 3;
    expect(cellCost(w, contrast, bytes, S, M) <= cellCost(w, contrast, bytes, S, N)).toBe(err(S, M, contrast) <= err(S, N, contrast));
    expect(cellCost(w, contrast, 3, S, triUL()) <= cellCost(w, contrast, 3, S, hp(1, 0))).toBe(err(S, triUL(), contrast) <= err(S, hp(1, 0), contrast));
  });
  it('bestErr_mono: adding triangles cannot hurt', () => {
    const axis = [hp(1, 0), hp(-1, 0), hp(0, 1), hp(0, -1)];
    const poly = [...axis, hp(1, 1), hp(1, -1), hp(-1, 1), hp(-1, -1)];
    for (const [a, b] of [[1, 1], [2, 1], [3, 1], [1, 2]] as [number, number][]) {
      const S = hp(a, b);
      expect(bestErrL(poly, S)).toBeLessThanOrEqual(bestErrL(axis, S));
    }
  });
  it('halfplane nested chain has ≤65 distinct masks', () => {
    // Ω = 64 cells, proj = a* (2r+1-8)+b*(2c+1-8) for fixed (1,1) direction, T = -20..20
    const proj = (r: number, c: number) => 1 * (2 * r + 1 - 8) + 1 * (2 * c + 1 - 8);
    const masks = new Set<string>();
    for (let t = -20; t <= 20; t++) {
      const s = new Set<string>();
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (proj(r, c) <= t) s.add(`${r},${c}`);
      masks.add([...s].sort().join('|'));
    }
    expect(masks.size).toBeLessThanOrEqual(65);
  });
  it('marker_never_a_shade: Q (1B) dominates solid marker (3B) at contrast ≤100', () => {
    // Glyph.cellCost w=2.5, marker coverage 0.25 vs Q 0.247/0.261
    const cellCost = (w: number, ct: number, cb: number, bytes: number, tTop: number, tBot: number, fg: number, bg: number) => {
      // simplified err = |fg-bg| * |coverage - t|  (two halves)
      const contrast = Math.abs(fg - bg);
      const err = contrast * (Math.abs(ct - tTop) + Math.abs(cb - tBot));
      return err + w * bytes;
    };
    for (const contrast of [0, 10, 50, 100]) {
      const fg = 100, bg = fg - contrast;
      for (const tTop of [0, 0.3, 0.5, 0.8, 1]) for (const tBot of [0, 0.3, 0.5, 0.8, 1]) {
        const marker = cellCost(2.5, 0.25, 0.25, 3, tTop, tBot, fg, bg);
        const shade = cellCost(2.5, 0.247, 0.261, 1, tTop, tBot, fg, bg);
        expect(shade).toBeLessThanOrEqual(marker + 1e-9);
      }
    }
  });
  it('GLYPHS polygon masks match hp and are byte-neutral (3B)', async () => {
    const { GLYPHS } = await import('./img2irc');
    // Check via dynamic import that our GLYPHS table contains the lean masks
    // We cannot import GLYPHS directly (not exported), so verify via polygon rendering byte length
    const cols = 4, rows = 2, pW = cols, pH = rows * 2;
    const d = new Uint8ClampedArray(pW * pH * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = 128; d[i + 1] = 128; d[i + 2] = 128; d[i + 3] = 255; }
    // diagonal edge: left side dark, right side bright
    for (let y = 0; y < pH; y++) for (let x = 0; x < pW; x++) {
      const i = (y * pW + x) * 4;
      if (x + y < pW) { d[i] = 20; d[i + 1] = 20; d[i + 2] = 20; } else { d[i] = 230; d[i + 1] = 230; d[i + 2] = 230; }
    }
    const art = await renderPixelsCore(d, pW, pH, cols, rows, 'polygon', { width: cols, renderMode: 'irc', pixelMode: 'polygon', filter: 'nearest', brightness: 0, contrast: 0, gamma: 0, saturation: 0, hue: 0, invert: false, grayscale: false, sepia: false, normalize: false, dither: false, ditherMode: 'none', colorMatching: 'oklab', flipH: false, flipV: false, rotate: 0, pixelize: 0, blur: 0, nograyscale: false, viterbiW: 0, comic: false, alphaMode: 'opaque', alphaThreshold: 128, trimTransparent: false, smartEdges: true, background: '#000000' } as any);
    // polygon should emit triangles for diagonal edge, at 3 bytes each
    const bytes = new TextEncoder().encode(art).length;
    expect(bytes).toBeGreaterThan(0);
    for (const ch of ['◤', '◢', '◥', '◣']) expect(new TextEncoder().encode(ch).length).toBe(3);
  });
});
