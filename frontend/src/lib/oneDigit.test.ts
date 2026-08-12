import { describe, it, expect } from 'vitest';

// Mirrors OneDigitNonMonotone.lean
const colour = [40, 60, 50] as const;
const prefixBytes = [2, 2, 3] as const;
const target = [45, 55, 45, 55] as const;
function err(t: number, c: number): number { return Math.abs(t - c); }
function bytes(a: number[]): number {
  let s = prefixBytes[a[0]];
  for (let i = 1; i < 4; i++) if (a[i] !== a[i - 1]) s += prefixBytes[a[i]];
  return s;
}
function error(a: number[]): number {
  let s = 0;
  for (let i = 0; i < 4; i++) s += err(target[i], colour[a[i]]);
  return s;
}
function cost(a: number[]): number { return error(a) + bytes(a); }

describe('OneDigitNonMonotone.lean', () => {
  it('full_optimum 23 with bestFull constant 2 (3 bytes)', () => {
    const bestFull = [2, 2, 2, 2];
    expect(cost(bestFull)).toBe(23);
    expect(bytes(bestFull)).toBe(3);
    for (let a0 = 0; a0 < 3; a0++) for (let a1 = 0; a1 < 3; a1++) for (let a2 = 0; a2 < 3; a2++) for (let a3 = 0; a3 < 3; a3++) {
      const a = [a0, a1, a2, a3];
      expect(cost(a)).toBeGreaterThanOrEqual(23);
    }
  });
  it('restricted_optimum 28 with bestRestricted 0,1,0,1 (8 bytes)', () => {
    const bestRestricted = [0, 1, 0, 1];
    expect(cost(bestRestricted)).toBe(28);
    expect(bytes(bestRestricted)).toBe(8);
    expect(bestRestricted.every(v => v !== 2)).toBe(true);
    for (let a0 = 0; a0 < 2; a0++) for (let a1 = 0; a1 < 2; a1++) for (let a2 = 0; a2 < 2; a2++) for (let a3 = 0; a3 < 2; a3++) {
      const a = [a0, a1, a2, a3];
      expect(cost(a)).toBeGreaterThanOrEqual(28);
    }
  });
  it('restricted_optimum_bytes every restricted optimum spends 8', () => {
    const opts: number[][] = [];
    for (let a0 = 0; a0 < 2; a0++) for (let a1 = 0; a1 < 2; a1++) for (let a2 = 0; a2 < 2; a2++) for (let a3 = 0; a3 < 2; a3++) {
      const a = [a0, a1, a2, a3];
      if (cost(a) === 28) opts.push(a);
    }
    expect(opts.length).toBeGreaterThan(0);
    for (const a of opts) expect(bytes(a)).toBe(8);
  });
  it('one_digit_backfires: 23<28 and 3<8', () => {
    const bestFull = [2, 2, 2, 2];
    const bestRestricted = [0, 1, 0, 1];
    expect(cost(bestFull)).toBeLessThan(cost(bestRestricted));
    expect(bytes(bestFull)).toBeLessThan(bytes(bestRestricted));
  });
  it('rowPaletteForViterbi does not restrict to singles only (avoids non-monotonicity)', async () => {
    const { rowPaletteForViterbi } = await import('./img2irc');
    const pal = Array.from({ length: 99 }, (_, i) => (i * 0x010101) & 0xffffff);
    const tops: [number, number, number, number][] = Array.from({ length: 20 }, (_, i) => [i * 12, i * 7, i * 13, 255] as any);
    const bots: typeof tops = Array.from({ length: 20 }, (_, i) => [i * 11, i * 8, i * 12, 255] as any);
    const S = rowPaletteForViterbi(tops as any, bots as any, pal, false, 'rgb', 12);
    expect(S.length).toBeGreaterThan(0);
    expect(S.length).toBeLessThanOrEqual(12);
    expect(S.length).toBe(12);
  });
});
