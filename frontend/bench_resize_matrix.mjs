import { readFile } from 'fs/promises';
import { renderPixelsCore, clearColorLut, getLastTimings } from './src/lib/img2irc.ts';
import { getWasm, hasWasmSync } from './src/lib/img2irc.wasm.ts';

const IMG = "/Users/zodiac/.omp/agent/sessions/-Library-Mobile Documents-com~apple~CloudDocs-Work-IRC-IRC_FIBER/2026-08-11T20-03-05-805Z_019ff26b-e7cd-7000-81d7-220047b3d94d/local/image-e5f99485cef28a2.jpg";

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
      dst[di+3]=255;
    }
  }
  return dst;
}

function makeData(pW,pH, fill=128){
  const d = new Uint8ClampedArray(pW*pH*4);
  for(let i=0;i<d.length;i+=4){ d[i]=fill; d[i+1]=(fill+37)%255; d[i+2]=(fill+91)%255; d[i+3]=255; }
  for(let i=0;i<d.length;i+=16){ d[i]=Math.floor(Math.random()*255); d[i+1]=Math.floor(Math.random()*255); }
  return d;
}

async function loadImageData(pW,pH, img){
  if(img){
    const t0=performance.now();
    const scaled = scaleBilinear(img.data, img.width, img.height, pW, pH);
    const t1=performance.now();
    return { data: scaled, resizeMs: t1-t0, via: 'bilinear' };
  }
  const d = makeData(pW,pH);
  return { data: d, resizeMs: 0, via: 'synthetic' };
}

async function runMatrix(label){
  const wasmOn = hasWasmSync();
  console.log(`\n## ${label} (wasm: ${wasmOn ? 'on' : 'off (JS fallback)'})`);
  console.log(`| width | normalize | compress(viterbiW) | wasm | resize | normalizePhase | viterbi | total | rows | chars |`);
  console.log(`|------:|-----------|-------------------:|------|-------:|---------------:|--------:|------:|-----:|------:|`);
  let img=null;
  try{
    const jpeg = (await import('jpeg-js')).default;
    const buf = await readFile(IMG);
    const dec = jpeg.decode(buf, {useTArray:true});
    img = dec;
    console.log(`# Image ${img.width}x${img.height} via jpeg-js, resize via scaleBilinear (Node)`);
  }catch(e){
    console.log(`# Image not found or jpeg-js missing — using synthetic gradient (makeData) — ${String(e).slice(0,80)}`);
  }
  const widths=[80,120];
  const toggles=[
    { normalize:false, compress:false },
    { normalize:false, compress:true },
    { normalize:true, compress:false },
    { normalize:true, compress:true },
  ];
  for(const w of widths){
    for(const t of toggles){
      try {
        const asp = img ? (img.height/img.width) : 0.9;
        let cols=w, pW=cols, rows=Math.max(1, Math.round(w*asp*0.9)), pH=rows*2;
        if(!img){ rows=Math.max(1, Math.round(w*0.9)); pH=rows*2; }
        if(rows>120){ rows=120; pH=240; }
        const { data: scaled, resizeMs, via } = await loadImageData(pW,pH, img);
        const viterbiW = t.compress ? 2.5 : 0;
        const opts={
          width:w, renderMode:'ansi', pixelMode:'half', filter:'linear',
          brightness:0, contrast:0, gamma:0, saturation:0, hue:0,
          invert:false, grayscale:false, sepia:false, normalize:t.normalize, dither:false, ditherMode:'none',
          colorMatching:'oklab', flipH:false, flipV:false, rotate:0, pixelize:0, blur:0, nograyscale:false,
          viterbiW, comic:false, midgardMode:'xterm256',
          alphaMode:'opaque', alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000',
          _debugResizeMs: resizeMs,
        };
        clearColorLut();
        const t0=performance.now();
        const res = await renderPixelsCore(scaled.slice(), pW, pH, cols, rows, 'half', opts);
        const t1=performance.now();
        const total = t1-t0;
        const timings = getLastTimings() || {};
        const viterbi = timings.viterbi ?? 0;
        const normPh = timings.normalize ?? 0;
        const resizePh = timings.resize ?? resizeMs;
        const rowsOut=res.split('\n').length;
        const chars=res.length;
        const wasmStr = wasmOn ? 'on' : 'off';
        const resizeStr = via==='synthetic' && resizeMs===0 ? 'N/A' : `${resizePh.toFixed(1)}ms`;
        console.log(`| ${String(w).padStart(5)} | ${t.normalize?'true     ':'false    '} | ${t.compress?'2.5     ':'0       '} | ${wasmStr.padEnd(4)} | ${resizeStr.padStart(6)} | ${normPh.toFixed(1).padStart(6)}ms | ${viterbi.toFixed(1).padStart(6)}ms | ${total.toFixed(1).padStart(6)}ms | ${String(rowsOut).padStart(4)} | ${String(chars).padStart(5)} |`);
      } catch(e){ console.error('iteration failed', e.stack||e); }
    }
  }
}

async function main(){
  const forceOff = process.env.IMG2IRC_WASM_OFF==='1';
  const isChild = process.env.BENCH_CHILD==='1';
  const runBoth = process.argv.includes('--both') || (!forceOff && !isChild);
  if(runBoth){
    const { spawnSync } = await import('child_process');
    console.log('# Running WASM_OFF pass (spawned child with IMG2IRC_WASM_OFF=1)...');
    const off = spawnSync(process.execPath, [process.argv[1]], { env: {...process.env, IMG2IRC_WASM_OFF:'1', BENCH_CHILD:'1'}, encoding:'utf-8', cwd: process.cwd(), timeout: 120000 });
    process.stdout.write(off.stdout||'');
    process.stderr.write(off.stderr||'');
    if(off.error) console.error('off spawn error', off.error);
    console.log('\n# Running WASM_ON pass (spawned child)...');
    const on = spawnSync(process.execPath, [process.argv[1]], { env: {...process.env, IMG2IRC_WASM_OFF:undefined, BENCH_CHILD:'1'}, encoding:'utf-8', cwd: process.cwd(), timeout: 120000 });
    process.stdout.write(on.stdout||'');
    process.stderr.write(on.stderr||'');
    if(on.error) console.error('on spawn error', on.error);
    return;
  }
  if(forceOff){
    console.log('# IMG2IRC_WASM_OFF=1 — JS fallback only (BENCH_CHILD)');
    await runMatrix('WASM_OFF');
    return;
  }
  console.log('# WASM_ON child — preloading WASM...');
  try{ await Promise.race([getWasm(), new Promise((_,rej)=>setTimeout(()=>rej(new Error('wasm timeout')),2000))]); console.log(`# WASM preload done — hasWasmSync=${hasWasmSync()}`); }catch(e){ console.log(`# WASM preload failed/timeout — hasWasmSync=${hasWasmSync()} ${String(e).slice(0,80)}`); }
  await runMatrix('WASM_ON');
}

main().catch(e=>{console.error(e); process.exit(1)});
