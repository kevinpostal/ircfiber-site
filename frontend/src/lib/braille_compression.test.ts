import { describe, it, expect } from 'vitest';
import { renderPixelsCore, estimateLineLengths } from './img2irc';
import type { Img2IrcOptions } from './img2irc';

function makeRainbow(pW: number, pH: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(pW * pH * 4);
  for (let y = 0; y < pH; y++) for (let x = 0; x < pW; x++) {
    const i = (y * pW + x) * 4;
    const hue = (x / pW) * 6;
    const c = 1, x1 = c * (1 - Math.abs((hue % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hue < 1) { r = c; g = x1; }
    else if (hue < 2) { r = x1; g = c; }
    else if (hue < 3) { g = c; b = x1; }
    else if (hue < 4) { g = x1; b = c; }
    else if (hue < 5) { r = x1; b = c; }
    else { r = c; b = x1; }
    d[i] = Math.round(r * 255);
    d[i + 1] = Math.round(g * 255);
    d[i + 2] = Math.round(b * 255);
    d[i + 3] = 255;
  }
  return d;
}

function baseOpts(viterbiW: number, pixelMode: string, midgardMode: string): Img2IrcOptions {
  return {
    width: 40,
    renderMode: midgardMode === 'truecolor' ? 'ansi24' : 'irc',
    pixelMode: pixelMode as Img2IrcOptions['pixelMode'],
    filter: 'nearest',
    brightness: 0, contrast: 0, gamma: 0, saturation: 0, hue: 0,
    invert: false, grayscale: false, sepia: false, normalize: false, dither: false, ditherMode: 'none',
    colorMatching: 'oklab',
    flipH: false, flipV: false, rotate: '0',
    pixelize: 0, blur: 0, nograyscale: false, comic: false,
    midgardMode: midgardMode as Img2IrcOptions['midgardMode'],
    alphaMode: 'opaque', alphaThreshold: 128, trimTransparent: false, smartEdges: true, background: '#000000',
    viterbiW,
  } as unknown as Img2IrcOptions;
}

describe('braille_compression — 512B perf verify (400→183)', () => {
  it('truecolor braille 40x10 rainbow: viterbiW 6 compresses vs 0 and fits 512', async () => {
    const cols = 40, rows = 10;
    const pW = cols * 2, pH = rows * 4;
    const d0 = makeRainbow(pW, pH);
    const d6 = makeRainbow(pW, pH);
    const art0 = await renderPixelsCore(d0, pW, pH, cols, rows, 'braille', baseOpts(0, 'braille', 'truecolor'));
    const art6 = await renderPixelsCore(d6, pW, pH, cols, rows, 'braille', baseOpts(6, 'braille', 'truecolor'));
    const len0 = new TextEncoder().encode(art0).length;
    const len6 = new TextEncoder().encode(art6).length;
    const e0 = estimateLineLengths(art0, 512);
    const e6 = estimateLineLengths(art6, 512);
    // 512B hard limit must hold after compression; w=6 must be strictly smaller than w=0 (Viterbi quantization)
    expect(len6).toBeLessThan(len0);
    expect(len6).toBeLessThanOrEqual(512 * e6.lines); // total fits within 512 per line budget in sense
    expect(e6.longest).toBeLessThanOrEqual(512);
    expect(e0.longest).toBeLessThanOrEqual(512); // even uncompressed should fit for 40 cols, but compressed must be smaller
    expect(e6.longest).toBeLessThan(e0.longest);
    // Keep existing 400→183 logic: longest after smartCompress should be well below 400 (safe payload)
    // For 40x10 truecolor braille, uncompressed 281 → compressed ~162 (as measured)
    expect(e6.longest).toBeLessThan(400);
  });

  it('half / quarter / eighth via renderPixelsCore with blocks', async () => {
    const cols = 20, rowsHalf = Math.round(cols * 0.9), rowsQuarter = Math.round(cols * 0.5);
    // half
    {
      const pW = cols, pH = rowsHalf * 2;
      const d = makeRainbow(pW, pH);
      const art = await renderPixelsCore(d, pW, pH, cols, rowsHalf, 'half', baseOpts(2, 'half', 'xterm256'));
      expect(art.length).toBeGreaterThan(0);
      expect(estimateLineLengths(art, 512).longest).toBeLessThanOrEqual(512);
    }
    // quarter
    {
      const pW = cols * 2, pH = rowsQuarter * 2;
      const d = makeRainbow(pW, pH);
      const art = await renderPixelsCore(d, pW, pH, cols, rowsQuarter, 'quarter', baseOpts(0, 'quarter', 'xterm256'));
      expect(art.length).toBeGreaterThan(0);
      expect(estimateLineLengths(art, 512).longest).toBeLessThanOrEqual(512);
    }
    // eighth (BlockKind)
    {
      const pW = cols, pH = rowsHalf;
      const d = makeRainbow(pW, pH);
      const art = await renderPixelsCore(d, pW, pH, cols, rowsHalf, 'eighth' as never, baseOpts(0, 'eighth', 'xterm256'));
      expect(art.length).toBeGreaterThan(0);
      expect(estimateLineLengths(art, 512).longest).toBeLessThanOrEqual(512);
    }
  });

  it('estimateLineLengths longest <=512 after smartCompress-like width (80 cols braille)', async () => {
    const cols = 40, rows = 10, pW = cols * 2, pH = rows * 4;
    const d = makeRainbow(pW, pH);
    const art = await renderPixelsCore(d, pW, pH, cols, rows, 'braille', baseOpts(6, 'braille', 'truecolor'));
    const { longest, ok } = estimateLineLengths(art, 512);
    expect(ok).toBe(true);
    expect(longest).toBeLessThanOrEqual(512);
  });
});
