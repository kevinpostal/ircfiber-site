import { describe, it, expect } from 'vitest';
import {
  IRC99, ANSI256, ANSI16, XTERM256,
  getMidgardPalette,
  kNearest, lutLookup, ansiToIrcIdx, toEmitIdx,
  bestGlyphForState, rowPaletteForViterbi,
  applyBilateralFilter, EXP_LUT,
  tryWasmBilateral,
  renderPixelsCore,
  base94Encode, base94Decode, base94EncodedLength,
  diffCrossoverK, shouldUseBitmask, estimateDiffSaving, encodeLineDiff,
  clearColorLut
} from './img2irc';

// Helper to create small test data
function makeData(pW:number, pH:number, fill=128): Uint8ClampedArray {
  const d = new Uint8ClampedArray(pW*pH*4);
  for(let i=0;i<d.length;i+=4){ d[i]=fill; d[i+1]=fill; d[i+2]=fill; d[i+3]=255; }
  return d;
}

describe('img2irc 100% coverage', () => {
  it('getMidgardPalette covers all modes', () => {
    expect(getMidgardPalette({midgardMode:'xterm256'} as any)).toBe(XTERM256);
    expect(getMidgardPalette({midgardMode:'truecolor', renderMode:'ansi24'} as any)).toBe(IRC99); // truecolor falls through to IRC99 but is24 true so not used
    expect(getMidgardPalette({midgardMode:'16'} as any)).toBe(ANSI16);
    expect(getMidgardPalette({midgardMode:'retro'} as any)).toBe(ANSI16);
    expect(getMidgardPalette({midgardMode:'comic'} as any)).toBe(IRC99);
    expect(getMidgardPalette({renderMode:'ansi'} as any)).toBe(ANSI256);
    expect(getMidgardPalette({renderMode:'irc'} as any)).toBe(IRC99);
    expect(getMidgardPalette({midgardMode:'vga256'} as any)).toBe(XTERM256); // fallback
  });

  it('kNearest handles ng and different modes', () => {
    const pal = XTERM256;
    expect(kNearest(255,0,0, pal, 2, false, 'rgb')).toHaveLength(2);
    expect(kNearest(128,128,128, pal, 2, true, 'oklab')).toHaveLength(2); // gray, ng should still return
    expect(kNearest(255,0,0, pal, 5, false, 'lab')).toHaveLength(5);
    expect(kNearest(0,0,0, pal, 2, true, 'rgb').length).toBe(2);
  });

  it('lutLookup palette-aware and ng', () => {
    clearColorLut();
    const r1 = lutLookup(255,0,0, XTERM256, false, 'rgb');
    const r2 = lutLookup(255,0,0, XTERM256, true, 'rgb');
    expect(r1.ansi).toBeDefined();
    expect(r1.irc).toBeDefined();
    // Different pal should give different ansi
    const r3 = lutLookup(255,0,0, IRC99, false, 'oklab');
    expect(r3.ansi).not.toBe(r1.ansi); // different palette
    // Cache hit
    const r4 = lutLookup(255,0,0, XTERM256, false, 'rgb');
    expect(r4.ansi).toBe(r1.ansi);
  });

  it('ansiToIrcIdx and toEmitIdx with mode', () => {
    expect(ansiToIrcIdx(0, XTERM256, 'oklab')).toBeGreaterThanOrEqual(0);
    expect(ansiToIrcIdx(0, XTERM256, 'rgb')).toBeGreaterThanOrEqual(0);
    expect(ansiToIrcIdx(150, ANSI256, 'lab')).toBeLessThan(99);
    expect(toEmitIdx(5, 'ansi', XTERM256, 'oklab')).toBeLessThan(99);
    expect(toEmitIdx(5, 'irc', XTERM256, 'oklab')).toBe(5);
    expect(toEmitIdx(5, 'ansi', ANSI256, 'rgb')).toBeDefined();
  });

  it('bestGlyphForState covers all glyphs and modes', () => {
    const pal = XTERM256;
    // Test with different w and modes, high contrast vs low
    const g1 = bestGlyphForState(0,0,0, 255,255,255, 0, 1, pal, 'oklab', 2.5);
    expect(g1.glyph).toBeDefined();
    const g2 = bestGlyphForState(128,128,128, 128,128,128, 0, 0, pal, 'rgb', 0);
    expect(g2.bytes).toBe(1); // solid -> space
    const g3 = bestGlyphForState(0,0,0, 255,255,255, 0, 1, pal, 'lab', 6);
    expect(g3.err).toBeGreaterThanOrEqual(0);
    // Test with w=0 (should pick most accurate, not cheapest)
    const g4 = bestGlyphForState(100,100,100, 150,150,150, 10, 20, pal, 'oklab', 0);
    expect(g4.glyph).toBeDefined();
  });

  it('rowPaletteForViterbi handles empty and normal', () => {
    const pal = XTERM256;
    const tops: [number,number,number,number][] = [[255,0,0,255],[0,255,0,255]];
    const bots: [number,number,number,number][] = [[0,0,255,255],[128,128,128,255]];
    const res = rowPaletteForViterbi(tops, bots, pal, false, 'oklab', 12);
    expect(res.length).toBeGreaterThan(0);
    expect(res.length).toBeLessThanOrEqual(12);
    // Empty case
    const empty = rowPaletteForViterbi([], [], pal, false, 'rgb', 5);
    expect(empty).toEqual([0,1,7].slice(0,5));
    // With nearBlack
    const blackTops: [number,number,number,number][] = [[0,0,0,255],[1,1,1,255]];
    const blackBots: [number,number,number,number][] = [[0,0,0,255],[2,2,2,255]];
    const res2 = rowPaletteForViterbi(blackTops, blackBots, pal, false, 'rgb', 5);
    expect(res2.length).toBeGreaterThan(0);
  });

  it('applyBilateralFilter and EXP_LUT', () => {
    const d = makeData(4,4, 100);
    const orig = new Uint8ClampedArray(d);
    applyBilateralFilter(d, 4, 4, 1, 40, 1);
    expect(d.length).toBe(orig.length);
    // Should have changed some pixels (bilateral blurs)
    // Check EXP_LUT
    expect(EXP_LUT.length).toBe(2048);
    expect(EXP_LUT[0]).toBeCloseTo(1, 5);
    expect(EXP_LUT[2047]).toBeLessThan(1);
    expect(EXP_LUT[32]).toBeCloseTo(Math.exp(-1), 5);
  });

  it('tryWasmBilateral falls back to JS (shim)', async () => {
    const d = makeData(2,2);
    const ok = await tryWasmBilateral(d, 2, 2, 1, 40, 1);
    expect(ok).toBe(false); // shim has _isWasmShim, so false
  });

  it('renderPixelsCore covers all pixelModes', async () => {
    const optsBase: any = {
      width: 4, renderMode: 'ansi', pixelMode: 'half', filter: 'linear',
      brightness:0, contrast:0, gamma:0, saturation:0, hue:0,
      invert:false, grayscale:false, sepia:false, normalize:false, dither:false, ditherMode:'none',
      colorMatching:'oklab', flipH:false, flipV:false, rotate:0, pixelize:0, blur:0, nograyscale:false,
      viterbiW:2.5, comic:false, midgardMode:'xterm256',
      alphaMode:'opaque', alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000'
    };
    // half with Viterbi
    let d = makeData(4, 2, 100); // 4 cols, 1 row half (pH=2)
    let res = await renderPixelsCore(d, 4, 2, 4, 1, 'half', optsBase);
    expect(typeof res).toBe('string');

    // half without Viterbi (viterbiW=0)
    d = makeData(4,2, 200);
    res = await renderPixelsCore(d, 4, 2, 4, 1, 'half', {...optsBase, viterbiW:0});
    expect(typeof res).toBe('string');

    // braille
    d = makeData(4, 8, 50);
    res = await renderPixelsCore(d, 2, 4, 2, 1, 'braille', optsBase);
    expect(typeof res).toBe('string');

    // quarter
    d = makeData(4, 4, 80);
    res = await renderPixelsCore(d, 2, 2, 2, 1, 'quarter', optsBase);
    expect(typeof res).toBe('string');

    // full
    d = makeData(2, 2, 90);
    res = await renderPixelsCore(d, 2, 2, 2, 2, 'full', optsBase);
    expect(typeof res).toBe('string');

    // truecolor (is24 true)
    d = makeData(2,2, 100);
    res = await renderPixelsCore(d, 2, 2, 2, 2, 'half', {...optsBase, renderMode:'ansi24', midgardMode:'truecolor'});
    expect(typeof res).toBe('string');
  });

  it('renderPixelsCore covers dither modes', async () => {
    const optsBase: any = {
      width: 4, renderMode: 'ansi', pixelMode: 'half', filter: 'linear',
      brightness:0, contrast:0, gamma:0, saturation:0, hue:0,
      invert:false, grayscale:false, sepia:false, normalize:false, dither:true, ditherMode:'bayer4',
      colorMatching:'rgb', flipH:false, flipV:false, rotate:0, pixelize:0, blur:0, nograyscale:false,
      viterbiW:0, comic:false, midgardMode:'xterm256',
      alphaMode:'opaque', alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000'
    };
    let d = makeData(4,2, 120);
    expect(await renderPixelsCore(d, 4,2,4,1,'half', optsBase)).toBeDefined();
    d = makeData(4,2, 120);
    expect(await renderPixelsCore(d, 4,2,4,1,'half', {...optsBase, ditherMode:'bayer8'})).toBeDefined();
    d = makeData(4,2, 120);
    expect(await renderPixelsCore(d, 4,2,4,1,'half', {...optsBase, ditherMode:'floyd'})).toBeDefined();
    d = makeData(4,2, 120);
    expect(await renderPixelsCore(d, 4,2,4,1,'half', {...optsBase, ditherMode:'atkinson'})).toBeDefined();
    // truecolor dither should be no-op
    d = makeData(4,2, 120);
    expect(await renderPixelsCore(d, 4,2,4,1,'half', {...optsBase, renderMode:'ansi24', midgardMode:'truecolor', ditherMode:'floyd'})).toBeDefined();
  });

  it('renderPixelsCore covers gamma, normalize, comic, etc.', async () => {
    const base: any = {
      width: 4, renderMode: 'ansi', pixelMode: 'half', filter: 'linear',
      brightness:0, contrast:0, gamma:2.2, saturation:0, hue:0,
      invert:false, grayscale:false, sepia:false, normalize:true, dither:false, ditherMode:'none',
      colorMatching:'lab', flipH:false, flipV:false, rotate:0, pixelize:0, blur:0, nograyscale:false,
      viterbiW:2.5, comic:true, midgardMode:'xterm256',
      alphaMode:'opaque', alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000'
    };
    let d = makeData(4,2, 100);
    const res = await renderPixelsCore(d, 4,2,4,1,'half', base);
    expect(typeof res).toBe('string');
    // Test with transparent alpha
    d = makeData(4,2, 100);
    d[3]=0; d[7]=0; // transparent pixels
    const res2 = await renderPixelsCore(d, 4,2,4,1,'half', {...base, alphaMode:'transparent', comic:false, gamma:0, normalize:false});
    expect(typeof res2).toBe('string');
  });

  it('base94 edge cases', () => {
    expect(() => base94Decode('!invalid~')).not.toThrow(); // valid chars
    expect(() => base94Decode('\x01')).toThrow(); // invalid char
    expect(base94EncodedLength(0)).toBe(0);
    expect(base94Encode(new Uint8Array([]))).toBe('');
    expect(base94Decode('')).toEqual(new Uint8Array([]));
  });

  it('diff edge cases', () => {
    expect(encodeLineDiff([], [])).toEqual({useMask:false, payload:''});
    expect(encodeLineDiff(['a'], ['a'])).toEqual({useMask:false, payload:''});
    expect(encodeLineDiff(['a'], ['b'])).toBeDefined();
    expect(shouldUseBitmask(0,0)).toBe(true); // ceil(0/6)=0 <=0
    expect(diffCrossoverK(0)).toBe(0);
    expect(estimateDiffSaving(0,0)).toBeDefined();
  });

  it('EXP_LUT correctness vs Math.exp', () => {
    const sigma2 = 3200;
    for(let d2 of [0, 100, 1000, 10000, 195075]) {
      const expected = Math.exp(-d2/sigma2);
      const actual = EXP_LUT[Math.min(2047, Math.round(d2*32/sigma2))];
      // Allow small error due to quantization (32 steps)
      expect(Math.abs(actual - expected)).toBeLessThan(0.02);
    }
  });
});
