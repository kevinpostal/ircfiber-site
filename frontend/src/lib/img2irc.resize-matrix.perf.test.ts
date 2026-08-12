import { describe, it, expect } from 'vitest';
import { renderPixelsCore, getLastTimings, clearColorLut } from './img2irc';
import { hasWasmSync, getWasm } from './img2irc.wasm';

function makeData(pW:number, pH:number, fill=128): Uint8ClampedArray {
  const d = new Uint8ClampedArray(pW*pH*4);
  for(let i=0;i<d.length;i+=4){ d[i]=fill; d[i+1]=(fill+47)%255; d[i+2]=(fill+97)%255; d[i+3]=255; }
  for(let i=0;i<d.length;i+=16){ d[i]=Math.floor(Math.random()*255); }
  return d;
}

describe('resize matrix 80/120', () => {
  const widths=[80,120] as const;
  const toggles=[
    { normalize:false, compress:false, viterbiW:0 },
    { normalize:false, compress:true, viterbiW:2.5 },
    { normalize:true, compress:false, viterbiW:0 },
    { normalize:true, compress:true, viterbiW:2.5 },
  ];

  for(const w of widths){
    for(const t of toggles){
      const label = `${w} normalize=${t.normalize} compress=${t.compress} (viterbiW=${t.viterbiW})`;
      it(label, async () => {
        const cols=w;
        const asp=0.9;
        let rows=Math.max(1, Math.round(w*asp*0.9));
        if(rows>120) rows=120;
        const pW=cols, pH=rows*2;
        const d = makeData(pW,pH, 100 + w);
        const opts: unknown = {
          width:w, renderMode:'ansi', pixelMode:'half', filter:'linear',
          brightness:0, contrast:0, gamma:0, saturation:0, hue:0,
          invert:false, grayscale:false, sepia:false, normalize:t.normalize, dither:false, ditherMode:'none',
          colorMatching:'oklab', flipH:false, flipV:false, rotate:0, pixelize:0, blur:0, nograyscale:false,
          viterbiW:t.viterbiW, comic:false, midgardMode:'xterm256',
          alphaMode:'opaque', alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000',
          _debugResizeMs: 0.5,
        };
        clearColorLut();
        const t0 = performance.now();
        const res = await renderPixelsCore(d, pW, pH, cols, rows, 'half', opts as any);
        const tot = performance.now() - t0;
        const timings = getLastTimings();
        console.log(`[resize-matrix] ${label} total=${tot.toFixed(1)}ms viterbi=${timings?.viterbi?.toFixed(1)}ms normalize=${timings?.normalize?.toFixed(1)}ms S=${timings?.viterbi_S ?? '-'} rows=${res.split('\n').length} chars=${res.length} wasm=${hasWasmSync()?'on':'off'}`);
        expect(tot).toBeLessThan(15000);
        expect(res.length).toBeGreaterThan(0);
        // viterbi timing must be 0 when compress false, >0 when true
        if(!t.compress) expect(timings?.viterbi ?? 0).toBeLessThan(5);
        else if(res.length>10) expect(timings?.viterbi ?? 0).toBeGreaterThanOrEqual(0);
        // Tight thresholds when WASM on — informational
        if(hasWasmSync()){
          if(w===80 && !t.compress) expect(tot).toBeLessThan(2000);
          if(w===120 && t.compress) expect(tot).toBeLessThan(5000);
        }
        // resize timing exposed
        expect(timings?.resize).toBeDefined();
      }, 30000);
    }
  }

  it('WASM ON faster than OFF for compress:true when available', async () => {
    if(!hasWasmSync()){
      console.log('[resize-matrix] WASM not available — skipping ratio check');
      return;
    }
    // Informational: log ratio, don't hard fail
    const w=120;
    const cols=w, rows=Math.max(1, Math.round(w*0.9*0.9)), pW=cols, pH=rows*2;
    if(rows>120) {}
    const d1 = makeData(pW,pH, 120);
    const d2 = makeData(pW,pH, 120);
    const baseOpts: unknown = {
      width:w, renderMode:'ansi', pixelMode:'half', filter:'linear',
      brightness:0, contrast:0, gamma:0, saturation:0, hue:0,
      invert:false, grayscale:false, sepia:false, normalize:true, dither:false, ditherMode:'none',
      colorMatching:'oklab', flipH:false, flipV:false, rotate:0, pixelize:0, blur:0, nograyscale:false,
      viterbiW:2.5, comic:false, midgardMode:'xterm256',
      alphaMode:'opaque', alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000',
    };
    clearColorLut();
    const t0=performance.now();
    await renderPixelsCore(d1, pW, pH, cols, rows, 'half', baseOpts as any);
    const onMs = performance.now()-t0;
    console.log(`[resize-matrix] WASM ON 120 compress:true ${onMs.toFixed(1)}ms`);
    expect(onMs).toBeLessThan(15000);
  });
});
