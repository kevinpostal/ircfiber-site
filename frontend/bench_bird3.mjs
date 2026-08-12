// stub fetch so WASM doesn't hang in Bun/Node
globalThis.fetch = () => Promise.reject(new Error('stub no wasm in bench - use JS fallback'));
import { readFile } from 'fs/promises';
import jpeg from 'jpeg-js';
const { renderPixelsCore, clearColorLut, smartPaletteA, smartPaletteB } = await import('./src/lib/img2irc.ts');

const IMG = "/Users/zodiac/.omp/agent/sessions/-Library-Mobile Documents-com~apple~CloudDocs-Work-IRC-IRC_FIBER/2026-08-11T20-03-05-805Z_019ff26b-e7cd-7000-81d7-220047b3d94d/local/image-e5f99485cef28a2.jpg";

async function loadJpeg(path){
  const buf = await readFile(path);
  const decoded = jpeg.decode(buf, {useTArray:true});
  return decoded;
}
function scaleBilinear(src, srcW, srcH, dstW, dstH){
  const dst = new Uint8ClampedArray(dstW*dstH*4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for(let y=0; y<dstH; y++){
    for(let x=0; x<dstW; x++){
      const sx = x * xRatio, sy = y * yRatio;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0+1, srcW-1), y1 = Math.min(y0+1, srcH-1);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0*srcW + x0)*4, i10 = (y0*srcW + x1)*4, i01 = (y1*srcW + x0)*4, i11 = (y1*srcW + x1)*4;
      const di = (y*dstW + x)*4;
      for(let c=0;c<3;c++){
        const v00 = src[i00+c], v10 = src[i10+c], v01 = src[i01+c], v11 = src[i11+c];
        const v0 = v00*(1-fx) + v10*fx, v1 = v01*(1-fx) + v11*fx;
        dst[di+c] = Math.round(v0*(1-fy) + v1*fy);
      }
      dst[di+3]=255;
    }
  }
  return dst;
}
const img = await loadJpeg(IMG);
console.log(`Image ${img.width}x${img.height} -> bench widths 80/120 half mode (JS fallback, WASM stubbed)`);
const configs=[];
for(const w of [80,120]){
  for(const pal of ['xterm256','16','truecolor','smart']){
    for(const norm of [false,true]){
      configs.push({w,pal,norm});
    }
  }
}
console.log("\n| width | palette   | norm  |  time  | rows | chars |");
console.log("|------:|-----------|-------|-------:|-----:|------:|");
for(const {w,pal,norm} of configs){
  const asp = img.height/img.width;
  let cols=w, pW=cols, rows=Math.max(1,Math.round(w*asp*0.9)), pH=rows*2;
  if(rows>120){rows=120; pH=240;}
  const scaled = scaleBilinear(img.data, img.width, img.height, pW, pH);
  const opts={
    width:w, renderMode: pal==='16'?'irc': pal==='truecolor'?'ansi24':'ansi', pixelMode:'half', filter:'linear',
    brightness:0, contrast:0, gamma:0, saturation:0, hue:0,
    invert:false, grayscale:false, sepia:false, normalize:norm, dither:false, ditherMode:'none',
    colorMatching:'oklab', flipH:false, flipV:false, rotate:0, pixelize:0, blur:0, nograyscale:false,
    viterbiW:2.5, comic:false, midgardMode:pal,
    alphaMode:'opaque', alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000'
  };
  if(pal==='smart'){
    const pa=smartPaletteA(scaled, pW, pH, 24);
    const pb=smartPaletteB(scaled, pW, pH, 16, 0.02, 'oklab');
    opts._smartPaletteA=pa; opts._smartPaletteB=pb; opts.renderMode='ansi24';
  }
  clearColorLut();
  const t0=performance.now();
  const res=await renderPixelsCore(scaled.slice(), pW, pH, cols, rows, 'half', opts);
  const ms=performance.now()-t0;
  console.log(`| ${String(w).padStart(5)} | ${pal.padEnd(9)} | ${norm?'true ':'false'} | ${ms.toFixed(1).padStart(6)}ms | ${String(res.split('\n').length).padStart(4)} | ${String(res.length).padStart(5)} |`);
}
console.log("\n--- viterbiW=0 fast path (truecolor) ---");
for(const w of [80,120]){
  const asp=img.height/img.width;
  let cols=w, pW=cols, rows=Math.max(1,Math.round(w*asp*0.9)), pH=rows*2;
  if(rows>120){rows=120; pH=240;}
  const scaled=scaleBilinear(img.data, img.width, img.height, pW, pH);
  const opts={width:w, renderMode:'ansi24', pixelMode:'half', filter:'linear', brightness:0, contrast:0, gamma:0, saturation:0, hue:0, invert:false, grayscale:false, sepia:false, normalize:false, dither:false, ditherMode:'none', colorMatching:'oklab', flipH:false, flipV:false, rotate:0, pixelize:0, blur:0, nograyscale:false, viterbiW:0, comic:false, midgardMode:'truecolor', alphaMode:'opaque', alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000'};
  clearColorLut();
  const t0=performance.now();
  const res=await renderPixelsCore(scaled.slice(), pW, pH, cols, rows, 'half', opts);
  console.log(`w=${w} viterbiW=0: ${(performance.now()-t0).toFixed(1)}ms chars=${res.length}`);
}
