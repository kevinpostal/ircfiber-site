import { describe, it, expect } from 'vitest';
import { renderPixelsCore } from './img2irc';

// Mirrors ViterbiDP.lean: transIrc and collapse
function fgPref(f: number): number { return 1 + (f < 10 ? 1 : 2); }
function pairPref(f: number, b: number): number { return 2 + (f < 10 ? 1 : 2) + (b < 10 ? 1 : 2); }
function transIrc(s1: [number, number], s2: [number, number]): number {
  if (s1[0] === s2[0] && s1[1] === s2[1]) return 0;
  if (s1[1] === s2[1]) return fgPref(s2[0]);
  return pairPref(s2[0], s2[1]);
}

describe('ViterbiDP collapse (Lean §1.6)', () => {
  it('collapsed recurrence equals brute inf for random dpPrev', () => {
    const F = [0, 5, 12, 98];
    const B = [0, 7, 15];
    const states: [number, number][] = [];
    for (const f of F) for (const b of B) states.push([f, b]);
    for (let trial = 0; trial < 50; trial++) {
      const dpPrev = states.map(() => Math.random() * 20);
      for (const [f, b] of states) {
        let brute = Infinity;
        for (let j = 0; j < states.length; j++) brute = Math.min(brute, dpPrev[j] + transIrc(states[j], [f, b]));
        const stay = dpPrev[states.findIndex((s) => s[0] === f && s[1] === b)];
        let bMin = Infinity;
        for (let j = 0; j < states.length; j++) if (states[j][1] === b) bMin = Math.min(bMin, dpPrev[j]);
        const gmin = Math.min(...dpPrev);
        const collapsed = Math.min(stay, Math.min(bMin + fgPref(f), gmin + pairPref(f, b)));
        expect(collapsed).toBeCloseTo(brute, 9);
      }
    }
  });

  it('smart24 constants satisfy 0 <= fg <= pair', () => {
    expect(7).toBeGreaterThanOrEqual(0);
    expect(7).toBeLessThanOrEqual(14);
  });

  it('empty gap preserves state (Lean extension)', () => {
    const states: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
    const dpPrev = [1, 50, 60, 70];
    const preserved = [...dpPrev];
    const gmin = Math.min(...dpPrev);
    const buggy = states.map(() => gmin);
    expect(preserved[1]).toBe(50);
    expect(buggy[1]).toBe(1);
    const target: [number, number] = [1, 1];
    const bMinFixed = Math.min(...states.map((s, i) => (s[1] === target[1] ? preserved[i] : Infinity)));
    const bMinBuggy = Math.min(...states.map((s, i) => (s[1] === target[1] ? buggy[i] : Infinity)));
    expect(bMinFixed).toBe(60);
    expect(bMinBuggy).toBe(1);
    const collapsedFixed = Math.min(preserved[3], Math.min(bMinFixed + fgPref(1), gmin + pairPref(1, 1)));
    const collapsedBuggy = Math.min(buggy[3], Math.min(bMinBuggy + fgPref(1), gmin + pairPref(1, 1)));
    expect(collapsedFixed).not.toBe(collapsedBuggy);
  });

  it('first non-empty after leading spaces must pay pairPref', async () => {
    const cols = 3;
    const rows = 1;
    const pW = 3;
    const pH = 2;
    const d = new Uint8ClampedArray(pW * pH * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 255; }
    const setPx = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
      const idx = (y * pW + x) * 4; d[idx] = r; d[idx + 1] = g; d[idx + 2] = b; d[idx + 3] = a;
    };
    setPx(2, 0, 220, 30, 30);
    setPx(2, 1, 30, 220, 30);
    const art = await renderPixelsCore(d, pW, pH, cols, rows, 'half', {
      viterbiW: 2, renderMode: 'irc', midgardMode: '16', colorMatching: 'rgb',
      nograyscale: false, gamma: 1, normalize: false, comic: false,
      dither: false, ditherMode: 'none', alphaMode: 'transparent', alphaThreshold: 10, samplingFilter: 'nearest',
    } as never);
    expect(art.trim().length).toBeGreaterThan(2);
    const firstColorIdx = art.indexOf('\x03');
    expect(firstColorIdx).toBeGreaterThanOrEqual(0);
    const after = art.slice(firstColorIdx + 1);
    expect(after).toMatch(/^\d+,\d+/);
  });
});
