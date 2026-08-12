import { readFile } from 'fs/promises';
import jpeg from 'jpeg-js';
import { renderPixelsCore, clearColorLut } from './src/lib/img2irc.ts';
import { getWasm } from './src/lib/img2irc.wasm.ts';

const IMG = "/Users/zodiac/.omp/agent/sessions/-Library-Mobile Documents-com~apple~CloudDocs-Work-IRC-IRC_FIBER/2026-08-11T20-03-05-805Z_019ff26b-e7cd-7000-81d7-220047b3d94d/local/image-e5f99485cef28a2.jpg";

async function loadJpeg(path){
  const buf = await readFile(path);
  const decoded = jpeg.decode(buf, {useTArray:true});
  // decoded.data is Uint8Array RGBA, width, height
  return decoded;
}

function scaleBilinear(src, srcW, srcH, dstW, dstH){
  const dst = new Uint8ClampedArray(dstW*dstH*4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for(let y=0; y<dstH; y++){
    for(let x=0; x<dstW; x++){
      const sx = x * xRatio;
      const sy = y * yRatio;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0+1, srcW-1), y1 = Math.min(y0+1, srcH-1);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0*srcW + x0)*4, i10 = (y0*srcW + x1)*4, i01 = (y1*srcW + x0)*4, i11 = (y1*srcW + x1)*4;
      const di = (y*dstW + x)*4;
      for(let c=0;c<3;c++){
        const v00 = src[i00+c], v10 = src[i10+c], v01 = src[i01+c], v11 = src[i11+c];
        const v0 = v00*(1-fx) + v10*fx;
        const v1 = v01*(1-fx) + v11*fx;
        dst[di+c] = Math.round(v0*(1-fy) + v1*fy);
      }
async function bench(){
  console.log("preloading WASM...");
  try{ await Promise.race([getWasm(), new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),2000))]); console.log("WASM loaded or timed out"); }catch(e){ console.log("WASM failed/timeout", String(e).slice(0,80))}

async function bench(){
  console.log("preloading WASM...");
  try{ await getWasm(); console.log("WASM loaded"); }catch(e){ console.log("WASM failed",e)}
  const img = await loadJpeg(IMG);
  console.log(`Image ${img.width}x${img.height}`);
  const configs = [];
  for(const w of [80,120]){
    for(const pal of ['xterm256','16','truecolor','smart']){
      for(const norm of [false,true]){
        configs.push({w, pal, norm});
      }
    }
  }
  // Also test without Viterbi for reference
  // configs pushed

  console.log("\n| width | palette   | normalize |   time | rows | chars | Viterbi% |");
  console.log("|------:|-----------|-----------|-------:|-----:|------:|---------:|");

  for(const {w,pal,norm} of configs){
    const asp = img.height / img.width; // 1.289
    let cols=w, pW=cols, rows = Math.max(1, Math.round(w*asp*0.9)), pH=rows*2;
    if(rows>120){ rows=120; pH=240; }
    const scaled = scaleBilinear(img.data, img.width, img.height, pW, pH);
    // opts matching imageToIrcArt defaults
    const opts = {
      width:w, renderMode: pal==='16'?'irc': pal==='truecolor'?'ansi24':'ansi', pixelMode:'half', filter:'linear',
      brightness:0, contrast:0, gamma:0, saturation:0, hue:0,
      invert:false, grayscale:false, sepia:false, normalize:norm, dither:false, ditherMode:'none',
      colorMatching:'oklab', flipH:false, flipV:false, rotate:0, pixelize:0, blur:0, nograyscale:false,
      viterbiW:2.5, comic:false, midgardMode:pal,
      alphaMode:'opaque', alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000'
    };
    // need to handle smart palettes: they are generated inside imageToIrcArt; we replicate
    if(pal==='smart'){
      // We need to import smartPalette functions - cheat by calling renderPixelsCore which will generate lazily?
      // Actually imageToIrcArt does smartPaletteA/B generation before renderPixelsCore if _smartPaletteA missing.
      // renderPixelsCore expects opts._smartPaletteA to be pre-filled if smart, otherwise it uses fallback IRC99.
      // To match real flow, we need to generate them.
      const { smartPaletteA, smartPaletteB } = await import('./src/lib/img2irc.ts');
      // Use scaled data as source (already pW*pH)
      const pa = smartPaletteA(scaled, pW, pH, 24);
      const pb = smartPaletteB(scaled, pW, pH, 16, 0.02, 'oklab');
      opts._smartPaletteA = pa;
      opts._smartPaletteB = pb;
      opts.renderMode='ansi24';
    }
    clearColorLut();
    const t0 = performance.now();
    // warmup? Run once to fill caches
    const res = await renderPixelsCore(scaled.slice(), pW, pH, cols, rows, 'half', opts);
    const t1 = performance.now();
    const ms = t1 - t0;
    const rowsOut = res.split('\n').length;
    const chars = res.length;
    // try to capture Viterbi timing from console? renderPixelsCore logs when >100ms; we capture via manual timing inside - but we can estimate
    console.log(`| ${String(w).padStart(5)} | ${pal.padEnd(9)} | ${norm?'true     ':'false    '} | ${ms.toFixed(1).padStart(6)}ms | ${String(rowsOut).padStart(4)} | ${String(chars).padStart(5)} |   —    |`);
  }

  // Additional: test disabling Viterbi for 120 width truecolor (should be instant)
  console.log("\n--- Fast path (viterbiW=0) for reference ---");
  for(const w of [80,120]){
    const asp = img.height / img.width;
    let cols=w, pW=cols, rows = Math.max(1, Math.round(w*asp*0.9)), pH=rows*2;
    if(rows>120){ rows=120; pH=240; }
    const scaled = scaleBilinear(img.data, img.width, img.height, pW, pH);
    const opts = {
      width:w, renderMode:'ansi24', pixelMode:'half', filter:'linear',
      brightness:0, contrast:0, gamma:0, saturation:0, hue:0,
      invert:false, grayscale:false, sepia:false, normalize:false, dither:false, ditherMode:'none',
      colorMatching:'oklab', flipH:false, flipV:false, rotate:0, pixelize:0, blur:0, nograyscale:false,
      viterbiW:0, comic:false, midgardMode:'truecolor',
      alphaMode:'opaque', alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000'
    };
    clearColorLut();
    const t0 = performance.now();
    const res = await renderPixelsCore(scaled.slice(), pW, pH, cols, rows, 'half', opts);
    console.log(`w=${w} truecolor viterbiW=0: ${(performance.now()-t0).toFixed(1)}ms rows=${res.split('\n').length} chars=${res.length}`);
  }
}

bench().catch(e=>{console.error(e); process.exit(1)});
