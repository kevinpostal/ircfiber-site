import { describe, it, expect } from 'vitest';
import { renderPixelsCore } from './img2irc';
import { GlyphCatalog } from './glyphCatalog';
describe('img2irc e2e', () => {
  it('glyphs default vs all', async () => {
    const cols=20, rows=10, pW=20, pH=20;
    const d=new Uint8ClampedArray(pW*pH*4);
    for(let y=0;y<pH;y++) for(let x=0;x<pW;x++){ const i=(y*pW+x)*4; d[i]=(x*13)%256; d[i+1]=(y*7)%256; d[i+2]=128; d[i+3]=255; }
    const c=new GlyphCatalog(); await c.load('/glyphs.json').catch(()=>{});
    const def=c.characters(['default']); const all=c.characters(c.groups.map(g=>g.name));
    const a=await renderPixelsCore(d.slice(), pW, pH, cols, rows, 'half', {width:cols, renderMode:'ansi', pixelMode:'half', midgardMode:'xterm256', viterbiW:0, filter:'linear', colorMatching:'oklab', glyphAlphabet:def} as any);
    const b=await renderPixelsCore(d.slice(), pW, pH, cols, rows, 'half', {width:cols, renderMode:'ansi', pixelMode:'half', midgardMode:'xterm256', viterbiW:0, filter:'linear', colorMatching:'oklab', glyphAlphabet:all} as any);
    expect(a.length).toBeGreaterThan(0); expect(b.length).toBeGreaterThan(0);
  }, 10000);
  it('truecolor no crash', async () => {
    const cols=20, rows=10, pW=20, pH=20;
    const d=new Uint8ClampedArray(pW*pH*4);
    for(let y=0;y<pH;y++) for(let x=0;x<pW;x++){ const i=(y*pW+x)*4; d[i]=128; d[i+1]=128; d[i+2]=128; d[i+3]=255; }
    const art=await renderPixelsCore(d, pW, pH, cols, rows, 'half', {width:cols, renderMode:'ansi24', pixelMode:'half', midgardMode:'truecolor', viterbiW:0, filter:'linear', colorMatching:'oklab'} as any);
    expect(art.length).toBeGreaterThan(0);
  }, 10000);
});
