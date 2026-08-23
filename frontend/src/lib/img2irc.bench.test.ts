import { describe, it, expect } from 'vitest';
import { renderPixelsCore, getLastTimings } from './img2irc';

describe('img2irc 1254x1568 freeze profiling', () => {
  const allChars = (() => {
    try {
      // @ts-ignore
      const fs = require('fs');
      const j = JSON.parse(fs.readFileSync('frontend/public/glyphs.json','utf8'));
      return j.groups.map((g:any)=>String.fromCodePoint(...g.codepoints.filter((c:number)=>c<0xD800||c>0xDFFF))).join('');
    } catch { return '▀▁▂▃▄▅▆▇▉▊▋▌▍▎🬼'.repeat(100); }
  })();

  function makeBW(pW:number,pH:number){
    const d=new Uint8ClampedArray(pW*pH*4);
    for(let y=0;y<pH;y++) for(let x=0;x<pW;x++){
      const i=(y*pW+x)*4;
      let v=180 + (y/pH)*20 + Math.sin(x*0.3)*10;
      if(Math.abs(x - pW*0.35)<5 && y<pH*0.6) v-=60;
      v+=Math.random()*10-5;
      v=Math.max(0,Math.min(255,v));
      d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
    }
    return d;
  }

  it('1254x1568 at 80x50 half should not freeze', async () => {
    const cols=80, aspect=1568/1254, rows=Math.round(cols*aspect*0.5), pW=cols, pH=rows*2;
    const d=makeBW(pW,pH);
    for(const glyphs of [14,67,1588] as const){
      const alpha=glyphs===14?undefined: allChars.slice(0,glyphs);
      const t0=Date.now();
      const art=await renderPixelsCore(d.slice(), pW, pH, cols, rows, 'half', {
        width:cols, renderMode:'ansi', pixelMode:'half', midgardMode:'xterm256', viterbiW:0.5, filter:'linear', colorMatching:'oklab', glyphAlphabet:alpha
      } as any);
      const ms=Date.now()-t0;
      console.log(`glyphs${glyphs} ${ms}ms len${art.length} ${JSON.stringify(getLastTimings()).slice(0,80)}`);
      expect(ms).toBeLessThan(800);
    }
  }, 10000);

  it('profile all widths', async () => {
    for(const w of [60,80,120]){
      const aspect=1568/1254, rows=Math.round(w*aspect*0.5), pW=w, pH=rows*2;
      const d=makeBW(pW,pH);
      const t0=Date.now();
      await renderPixelsCore(d, pW, pH, w, rows, 'half', {
        width:w, renderMode:'ansi', pixelMode:'half', midgardMode:'xterm256', viterbiW:0.5, filter:'linear', colorMatching:'oklab'
      } as any);
      const ms=Date.now()-t0;
      console.log(`${w}x${rows} ${ms}ms`);
      expect(ms).toBeLessThan(1000);
    }
  }, 10000);
});
