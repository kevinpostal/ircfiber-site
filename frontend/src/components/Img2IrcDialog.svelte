<script lang="ts">
  import { untrack } from 'svelte';
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import { imageToIrcArt, loadImageFromFile, revokeImageUrl, clearColorLut, estimateLineLengths, getLastTimings, DEFAULT_IRC_WIDTH, MIN_IRC_WIDTH, MAX_IRC_WIDTH, IRC_HARD_LIMIT, IRC_SAFE_PAYLOAD, type RenderMode, type PixelMode, type DitherMode, type ColorMatching, type MidgardColorMode, serializeImg2IrcOptions } from '../lib/img2irc';
  import { sendMessage } from '../stores/wsConnection.svelte';
  import { ircState } from '../stores/ircStore.svelte';
  import { generateLabel } from '../lib/utils';
  import { createIrcArtSave, updateIrcArtSave } from '../stores/api';
  interface Props { file: File|Blob; filename:string; onClose:()=>void; onBack?:()=>void; initialParams?: Record<string, unknown>; initialName?: string; editId?: string; onSaved?:()=>void; initialArt?: string; thumbnailUrl?: string; }
  let { file, filename, onClose, onBack, initialParams, initialName, editId, onSaved, initialArt, thumbnailUrl }: Props = $props();

  let width=$state(DEFAULT_IRC_WIDTH);
  let renderMode=$state<RenderMode>('ansi');
  let pixelMode=$state<PixelMode>('half');
  let midgardMode=$state<MidgardColorMode>('xterm256');
  let brightness=$state(0), contrast=$state(0), saturation=$state(0), hue=$state(0), gamma=$state(0), blur=$state(0), pixelize=$state(0);
  let grayscale=$state(false), invert=$state(false), sepia=$state(false), normalize=$state(false), nograyscale=$state(false), flipH=$state(false), flipV=$state(false);
  let ditherMode=$state<DitherMode>('none'), colorMatching=$state<ColorMatching>('oklab');
  let viterbiW=$state(0);
  let rotate=$state('0');
  let filter=$state('linear');
  let scrollPreset=$state(2);
  const SCROLL_PRESETS = [
    { label: 'Instant', bd: 0, sd: 0, hint: '0ms · instant' },
    { label: 'Fast',    bd: 18, sd: 60, hint: '60ms/line' },
    { label: 'Normal',  bd: 35, sd: 110, hint: '110ms · default' },
    { label: 'Smooth',  bd: 55, sd: 220, hint: '220ms · gentle' },
    { label: 'Cinema',  bd: 90, sd: 450, hint: '450ms · dramatic' },
  ] as const;
  let dither=$derived(ditherMode !== 'none');
  // Viterbi compression only for paletted modes + smart truecolor; truecolor greedy
  let compressionDisabled=$derived(renderMode==='ansi24' && midgardMode!=='smart');
  let accTone=$state(false);
  let accFx=$state(false);
  let accOut=$state(false);
  let _initApplied=$state(false);
  $effect(()=>{
    if(_initApplied || !initialParams) return;
    _initApplied=true;
    const p=initialParams as any;
    if(p.width!=null) width=p.width;
    if(p.renderMode) renderMode=p.renderMode;
    if(p.pixelMode){
      if(['half','full','quarter','braille','polygon'].includes(p.pixelMode)) pixelMode=p.pixelMode;
      else pixelMode='half';
    }
    if(p.midgardMode) midgardMode=p.midgardMode;
    if(p.filter) filter=p.filter;
    if(p.brightness!=null) brightness=p.brightness;
    if(p.contrast!=null) contrast=p.contrast;
    if(p.saturation!=null) saturation=p.saturation;
    if(p.hue!=null) hue=p.hue;
    if(p.gamma!=null) gamma=p.gamma;
    if(p.blur!=null) blur=p.blur;
    if(p.pixelize!=null) pixelize=p.pixelize;
    if(p.grayscale!=null) grayscale=p.grayscale;
    if(p.invert!=null) invert=p.invert;
    if(p.sepia!=null) sepia=p.sepia;
    if(p.normalize!=null) normalize=p.normalize;
    if(p.nograyscale!=null) nograyscale=p.nograyscale;
    if(p.flipH!=null) flipH=p.flipH;
    if(p.flipV!=null) flipV=p.flipV;
    if(p.rotate!=null) rotate=String(p.rotate);
    if(p.ditherMode) ditherMode=p.ditherMode;
    if(p.colorMatching) colorMatching=p.colorMatching;
    if(p.viterbiW!=null) viterbiW=p.viterbiW;
  });
  $effect(()=>{
    void midgardMode;
    if((midgardMode as string)==='vga256'){ midgardMode='xterm256'; return; }
    if((midgardMode as string)==='retro'){ midgardMode='16'; return; }
    if((midgardMode as string)==='comic'){ midgardMode='truecolor'; return; }
    if(midgardMode==='truecolor'){ renderMode='ansi24'; }
    else if(midgardMode==='xterm256'){ renderMode='ansi'; }
    else if(midgardMode==='16'){ renderMode='irc'; }
    else if(midgardMode==='smart'){ renderMode='ansi24'; }
  });
  let art=$state(initialArt ?? ''), htmlPreview=$state(initialArt ? initialArt.split('\n').map(l=>`<div class="ircArtLine">${parseIrcFormatting(l)}</div>`).join('') : ''), loading=$state(initialArt ? false : true), isConverting=$state(false), error=$state<string|null>(null), copied=$state(false), sending=$state(false), sentCount=$state(0);
  let saving=$state(false), saveError=$state<string|null>(null), saveOk=$state(false), saveName=$state((initialName ?? filename.replace(/\.[^.]+$/,'')) || 'IRC Art');
  let hasAlpha=$state(false);
  let isDummyFile=$derived((file as File)?.name==='dummy.png');
  let gen=0;
  let debounce: ReturnType<typeof setTimeout>|null=null;
  let settleTimer: ReturnType<typeof setTimeout>|null=null;
  let smartPalCache: { A: number[]; B: number[] } | null = null;
  let _worker: Worker | null = null;
  let lastTimings=$state<Record<string,number>|null>(null);
  // render cache for instant compare (e.g. RGB vs OKLab) — keyed by opts + hasAlpha, per-file
  let renderCache=new Map<string,{art:string,html:string}>();
  let _lastFile: File|Blob|null=null;
  function makeCacheKeyForOpts(o:any, alpha:boolean):string{
    return `${o.width}|${o.renderMode}|${o.pixelMode}|${o.midgardMode}|${o.filter}|${o.brightness}|${o.contrast}|${o.saturation}|${o.hue}|${o.gamma}|${o.blur}|${o.pixelize}|${o.grayscale?1:0}|${o.invert?1:0}|${o.sepia?1:0}|${o.normalize?1:0}|${o.dither?1:0}|${o.ditherMode}|${o.colorMatching}|${o.nograyscale?1:0}|${o.flipH?1:0}|${o.flipV?1:0}|${o.rotate}|${o.viterbiW}|${alpha?1:0}`;
  }
  function makeCacheKey():string{
    // keep key small and stable — order matters
    return makeCacheKeyForOpts({width, renderMode, pixelMode, midgardMode, filter: filter as any, brightness, contrast, saturation, hue, gamma: gamma||0, blur, pixelize, grayscale, invert, sepia, normalize, dither, ditherMode, colorMatching, nograyscale, flipH, flipV, rotate: Number(rotate), viterbiW, comic: false, alphaMode: hasAlpha?'transparent':'opaque' as const, alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000'}, hasAlpha);
  }
  $effect(()=>{ // clear cache when file changes
    void file;
    if(file!==_lastFile){
      renderCache.clear();
      smartPalCache=null;
      _lastFile=file as any;
    }
  });
  $effect(() => {
    return () => {
      if (debounce) { clearTimeout(debounce); debounce = null; }
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      try { _worker?.terminate(); } catch {}
      _worker = null;
      gen++;
    };
  });
  function getWorker(): Worker | null {
    if (_worker) return _worker;
    try {
      _worker = new Worker(new URL('../lib/img2irc.worker.ts', import.meta.url), { type: 'module' });
      _worker.onerror = () => { try { _worker?.terminate(); } catch {}; _worker = null; };
    } catch { _worker = null; }
    return _worker;
  }
  async function convertViaWorker(img: HTMLImageElement, opts: any, expectedGen: number): Promise<{ art: string; paletteA?: number[]; paletteB?: number[] } | null> {
    // Always try worker for heavy work — even small images benefit from off-main-thread WASM (246ms for 80 still janks)
    // The 4000px threshold was for old per-cell WASM (5× slower), now batched WASM is 13× faster but still blocks main thread.
    const w = getWorker();
    if (!w) return null;
    if(typeof OffscreenCanvas==='undefined') return null;
    if(typeof createImageBitmap==='undefined') return null;
    let bitmap: ImageBitmap | null = null;
    let handler: ((e: MessageEvent) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const _tWStart = performance.now();
    try {
      bitmap = await createImageBitmap(img);
      if (expectedGen !== gen) { try { bitmap.close(); } catch {} return null; }
      const id = Math.random();
      const res = await new Promise<{ art: string; paletteA?: number[]; paletteB?: number[] }>((resolve, reject) => {
        handler = (e: MessageEvent) => {
          const d: any = e.data;
          if (d.id !== id) return;
          if (handler) w.removeEventListener('message', handler as any);
          if (timer) clearTimeout(timer);
          if (d.ok) resolve({ art: d.result, paletteA: d.paletteA, paletteB: d.paletteB });
          else reject(new Error(d.error));
        };
        w.addEventListener('message', handler as any);
        w.postMessage({ id, bitmap: bitmap!, opts }, [bitmap as any]);
        bitmap = null;
        timer = setTimeout(() => {
          if (handler) w.removeEventListener('message', handler as any);
          reject(new Error('worker timeout'));
        }, 15000);
      });
      return res;
    } catch { return null; } finally {
      if (timer) clearTimeout(timer);
      if (handler) { try { w.removeEventListener('message', handler as any); } catch {} }
      if (bitmap) { try { bitmap.close(); } catch {} }
    }
  }

  let fitBusy=$state(false);
  let fitting=false;
  function schedule(){
    if(isDummyFile){ isConverting=false; loading=false; return; }
    if(fitting) return;
    if(settleTimer){ clearTimeout(settleTimer); settleTimer=null; }
    const my=++gen;
    if(debounce) clearTimeout(debounce);
    if(htmlPreview) isConverting=true;
    debounce=setTimeout(async()=>{
      if(my!==gen) return;
      await convert(my);
    }, 70);
  }
  $effect(()=>{ void width; void renderMode; void pixelMode; void midgardMode; void brightness; void contrast; void saturation; void hue; void gamma; void blur; void pixelize; void grayscale; void invert; void sepia; void normalize; void ditherMode; void colorMatching; void nograyscale; void flipH; void flipV; void rotate; void filter; void viterbiW; void file; untrack(()=>schedule()); });
  async function convert(expected=gen){
    const cur=expected;
    if(cur!==gen) return;
    if(settleTimer){ clearTimeout(settleTimer); settleTimer=null; }
    const isDummy = (()=>{ try{ const f=file as File; return f && f.name==='dummy.png'; } catch{ return false; }})();
    if(editId && initialArt && isDummy){
      if(!htmlPreview){
        art = initialArt;
        htmlPreview = initialArt.split('\n').map(l=>`<div class="ircArtLine">${parseIrcFormatting(l)}</div>`).join('');
      }
      loading=false; isConverting=false;
      return;
    }
    if(editId && initialArt && !htmlPreview){
      art = initialArt;
      htmlPreview = initialArt.split('\n').map(l=>`<div class="ircArtLine">${parseIrcFormatting(l)}</div>`).join('');
      loading=false; isConverting=false;
    }
    if(!htmlPreview) loading=true;
    try{
      const img=await loadImageFromFile(file as File);
      if(cur!==gen){ revokeImageUrl(img); return; }
      try{
        const c=document.createElement('canvas'); c.width=Math.min(64, img.naturalWidth); c.height=Math.min(64, img.naturalHeight);
        const cx=c.getContext('2d')!; cx.drawImage(img,0,0,c.width,c.height);
        const d=cx.getImageData(0,0,c.width,c.height).data;
        let found=false; for(let i=3;i<d.length;i+=4) if(d[i]<250){found=true;break;}
        hasAlpha=found;
      } catch {}
      try{
        const opts={ width, renderMode, pixelMode, midgardMode, filter: filter as any, brightness, contrast, saturation, hue, gamma: gamma||0, blur, pixelize, grayscale, invert, sepia, normalize, dither, ditherMode, colorMatching, nograyscale, flipH, flipV, rotate: Number(rotate), viterbiW, comic: false, alphaMode: hasAlpha?'transparent':'opaque' as const, alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000' } as const;
        const _kHit=makeCacheKey();
        const _hit=renderCache.get(_kHit);
        if(_hit){
          if(cur!==gen) return;
          art=_hit.art;
          htmlPreview=_hit.html;
          if(cur===gen){ loading=false; isConverting=false; }
          return;
        }
        let res: string | null = null;
        try {
          const wr = await convertViaWorker(img, opts, cur);
          if(cur!==gen) return;
          if (wr != null) {
            res = wr.art;
            if (wr.paletteA && wr.paletteB) smartPalCache = { A: wr.paletteA, B: wr.paletteB };
          }
        } catch {}
        if(cur!==gen) return;
        if (res == null) {
          res = await imageToIrcArt(img, opts);
          if(cur!==gen) return;
          if(midgardMode==='smart' && !smartPalCache && (opts as any)._smartPaletteA && (opts as any)._smartPaletteB){
            smartPalCache = { A: (opts as any)._smartPaletteA, B: (opts as any)._smartPaletteB };
          }
        }
        if(cur!==gen) return;
        art=res;
        htmlPreview=res.split('\n').map(l=>`<div class="ircArtLine">${parseIrcFormatting(l)}</div>`).join('');
        try{ lastTimings = getLastTimings(); } catch {}
        try{ const k2=makeCacheKey(); if(!renderCache.has(k2)){ if(renderCache.size>=24){ const f=renderCache.keys().next().value; if(f) renderCache.delete(f); } renderCache.set(k2,{art:res, html:htmlPreview}); } }catch{}
        // Background precache for instant preset switching — single-axis variations, idle-yielded, cancellable via gen
        void precachePresets(file, opts, cur, hasAlpha);
      } finally { revokeImageUrl(img); }
    } catch(e:any){ if(cur===gen) error=e?.message??'Failed'; }
    if(cur===gen){ loading=false; isConverting=false; }
  }

  async function precachePresets(baseFile: File|Blob, baseOpts: any, curGen: number, baseHasAlpha: boolean) {
    try {
      if (typeof navigator !== 'undefined' && (navigator as any).deviceMemory && (navigator as any).deviceMemory < 4) return;
    } catch {}
    const presets: any[] = [];
    const mids: MidgardColorMode[] = ['xterm256','16','truecolor','smart'];
    for (const m of mids) if (m !== baseOpts.midgardMode) {
      const rm: RenderMode = m==='truecolor' ? 'ansi24' : m==='smart' ? 'ansi24' : m==='16' ? 'irc' : 'ansi';
      presets.push({...baseOpts, midgardMode: m, renderMode: rm});
    }
    for (const cm of ['rgb','lab','oklab'] as ColorMatching[]) if (cm !== baseOpts.colorMatching) presets.push({...baseOpts, colorMatching: cm});
    for (const pm of ['half','polygon','quarter','braille','full'] as PixelMode[]) if (pm !== baseOpts.pixelMode) presets.push({...baseOpts, pixelMode: pm});
    for (const w of [60,80,100,120]) if (w !== baseOpts.width) presets.push({...baseOpts, width: w});
    const toCache = presets.slice(0, 16);
    let pImg: HTMLImageElement | null = null;
    try {
      pImg = await loadImageFromFile(baseFile as File);
      if (curGen !== gen) { if(pImg) revokeImageUrl(pImg); return; }
      for (const preset of toCache) {
        if (curGen !== gen) break;
        const key = makeCacheKeyForOpts(preset, baseHasAlpha);
        if (renderCache.has(key)) continue;
        await new Promise<void>(r => {
          const w = window as any;
          if (w.requestIdleCallback) w.requestIdleCallback(()=>r(), {timeout: 100});
          else setTimeout(r, 0);
        });
        if (curGen !== gen) break;
        if (renderCache.size >= 24) break;
        try {
          // Off-main-thread via worker so UI stays responsive (was imageToIrcArt on main thread → 246ms jank per preset)
          let res: string | null = null;
          try {
            const wr = await convertViaWorker(pImg!, preset, curGen);
            if (wr) res = wr.art;
            else res = await imageToIrcArt(pImg!, preset);
          } catch {
            res = await imageToIrcArt(pImg!, preset);
          }
          if (curGen !== gen) break;
          const html = res.split('\n').map(l=>`<div class="ircArtLine">${parseIrcFormatting(l)}</div>`).join('');
          const k = makeCacheKeyForOpts(preset, baseHasAlpha);
          if (!renderCache.has(k) && renderCache.size < 24) renderCache.set(k, {art: res, html});
        } catch {}
      }
    } catch {} finally {
      if (pImg) try{ revokeImageUrl(pImg); }catch{}
    }
  }


  const stats=$derived(estimateLineLengths(art));
  const hardStats=$derived(estimateLineLengths(art, IRC_HARD_LIMIT));
  const activeTarget=$derived(ircState.activeBuffer.bufferName||'');
  const activeNetworkId=$derived(ircState.activeBuffer.networkId||'');
  const pct=$derived(Math.min(100, (hardStats.longest/IRC_HARD_LIMIT)*100));
  const overBudget=$derived(!hardStats.ok);
  const safeOver=$derived(stats.longest > IRC_SAFE_PAYLOAD);

  async function smartFit(){
    if(!art || fitBusy) return;
    try{
      let steps=0;
      while(steps++ < 14){
        const longest=estimateLineLengths(art).longest;
        if(longest<=IRC_HARD_LIMIT) break;
        const viterbiCapable = midgardMode!=='truecolor';
        if(viterbiCapable && viterbiW < 6){
          const ok = await bisectViterbiW();
          if(ok) continue;
        }
        const step=pickFitStep();
        if(!step) break;
        step();
        await new Promise(r=>setTimeout(r, 30));
        const my=++gen;
        await convert(my);
        if(my!==gen) return;
      }
    } finally { fitting=false; fitBusy=false; }
  }
  async function bisectViterbiW(): Promise<boolean>{
    const lo=viterbiW, hi=6;
    let best=hi, found=false;
    const savedW=viterbiW;
    viterbiW=hi; await new Promise(r=>setTimeout(r, 30)); let my=++gen; await convert(my); if(my!==gen) return false;
    if(estimateLineLengths(art).longest <= IRC_HARD_LIMIT){ found=true; best=hi; }
    else { viterbiW=savedW; await new Promise(r=>setTimeout(r,30)); my=++gen; await convert(my); return false; }
    let l=lo, h=hi;
    for(let iter=0; iter<4; iter++){
      const mid=Math.round(((l+h)/2)*2)/2;
      if(mid===l || mid===h) break;
      viterbiW=mid; await new Promise(r=>setTimeout(r,30)); my=++gen; await convert(my); if(my!==gen) return false;
      if(estimateLineLengths(art).longest <= IRC_HARD_LIMIT){ best=mid; h=mid; found=true; } else l=mid;
    }
    if(found) viterbiW=best;
    else viterbiW=savedW;
    await new Promise(r=>setTimeout(r,30)); my=++gen; await convert(my); if(my!==gen) return false;
    return found;
  }
  function pickFitStep(): (()=>void)|null{
    const viterbiCapable = midgardMode!=='truecolor';
    if(viterbiCapable && viterbiW < 6) return ()=>{ viterbiW=Math.min(6, Math.round((viterbiW+0.5)*2)/2); };
    if(width > MIN_IRC_WIDTH + 4) return ()=>{ width=Math.max(MIN_IRC_WIDTH, width-4); };
    if(midgardMode==='smart') return ()=>{ midgardMode='xterm256'; };
    if(midgardMode==='truecolor' || midgardMode==='xterm256') return ()=>{ midgardMode='16'; };
    if(width > MIN_IRC_WIDTH) return ()=>{ width=MIN_IRC_WIDTH; };
    return null;
  }
  async function send(){
    if(!art||!activeNetworkId||!activeTarget) return;
    sending=true; sentCount=0;
    const lines=art.split('\n');
    const { bd: BD, sd: SD } = SCROLL_PRESETS[scrollPreset];
    const BURST=5;
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(!line.replace(/[\x03\x04\x0f0-9,a-fA-F ]/g,'').trim() && line.trim()==='') continue;
      sendMessage(activeNetworkId, activeTarget, line, generateLabel());
      sentCount=i+1;
      if(i<lines.length-1){
        const delay = i<BURST ? BD : SD;
        if(delay>0) await new Promise(r=>setTimeout(r, delay));
      }
    }
    sending=false; onClose();
  }
  async function makeThumbnailBlob(): Promise<Blob|null> {
    try {
      const img=await loadImageFromFile(file as File);
      const c=document.createElement('canvas');
      const maxW=120;
      const scale=Math.min(1, maxW / img.naturalWidth);
      c.width=Math.max(1, Math.round(img.naturalWidth*scale));
      c.height=Math.max(1, Math.round(img.naturalHeight*scale));
      const ctx=c.getContext('2d')!;
      ctx.drawImage(img,0,0,c.width,c.height);
      revokeImageUrl(img);
      return await new Promise<Blob|null>(res=>{
        try{ c.toBlob(b=>res(b), 'image/png'); } catch { res(null); }
      });
    } catch { return null; }
  }
  async function handleSave(){
    if(!art || saving || overBudget) return;
    saving=true; saveError=null; saveOk=false;
    try{
      const params=serializeImg2IrcOptions({ width, renderMode, pixelMode, midgardMode, filter: filter as any, brightness, contrast, saturation, hue, gamma: gamma||0, blur, pixelize, grayscale, invert, sepia, normalize, dither, ditherMode, colorMatching, nograyscale, flipH, flipV, rotate: Number(rotate), viterbiW, comic:false, alphaMode: hasAlpha?'transparent':'opaque', alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000' } as any);
      let thumb: Blob|null=null;
      const isDummyFile = (()=>{ try{ const f=file as File; return f && f.name==='dummy.png'; } catch{ return false; }})();
      if(!isDummyFile){ try{ thumb=await makeThumbnailBlob(); } catch {} }
      if(editId){
        await updateIrcArtSave(editId, { name: saveName, art, params, thumbnailBlob: thumb ?? undefined });
      } else {
        await createIrcArtSave({ name: saveName, art, params, originalFile: file as File, thumbnailBlob: thumb ?? undefined, networkId: activeNetworkId, buffer: activeTarget, originalFilename: filename, originalMime: (file as File).type || 'image/png' });
      }
      saveOk=true; setTimeout(()=>saveOk=false,2000);
      onSaved?.();
    } catch(e:any){ saveError=e?.message??'Save failed'; }
    finally{ saving=false; }
  }
  function resetAll(){
    width=DEFAULT_IRC_WIDTH;
    renderMode='ansi';
    pixelMode='half';
    midgardMode='xterm256';
    brightness=0; contrast=0; saturation=0; hue=0; gamma=0; blur=0; pixelize=0;
    grayscale=false; invert=false; sepia=false; normalize=false; ditherMode='none'; colorMatching='oklab'; nograyscale=false; flipH=false; flipV=false; rotate='0'; filter='linear'; viterbiW=0; scrollPreset=2;
    accTone=false; accFx=false; accOut=false;
  }
  function handleKey(e:KeyboardEvent){ if(e.key==='Escape') onClose(); }
  function handleOverlayClick(e:MouseEvent){ if(e.target===e.currentTarget) onClose(); }

  const colorOpts: Array<{v:MidgardColorMode,label:string,sub:string}> = [
    { v:'xterm256', label:'ANSI 256', sub:'xterm' },
    { v:'16', label:'16 colors', sub:'mIRC' },
    { v:'truecolor', label:'True-Color', sub:'24-bit' },
    { v:'smart', label:'Smart', sub:'auto' },
  ];
  const pixelOpts: Array<{v:PixelMode,label:string,glyph:string,hint?:string}> = [
    { v:'half', label:'Half', glyph:'▀' },
    { v:'polygon', label:'Polygon', glyph:'◤', hint:'smoother diagonals, same bytes' },
    { v:'quarter', label:'Quarter', glyph:'▖' },
    { v:'braille', label:'Braille', glyph:'⣿' },
    { v:'full', label:'Full', glyph:'█' },
  ];
</script>

<svelte:window onkeydown={handleKey} />

<div class="overlay" role="dialog" aria-modal="true" onclick={handleOverlayClick}>
  <div class="dialog">
    <header>
      <div class="head-left">
        <h2>Image → IRC</h2>
        <span class="fname" title={filename}>{filename}</span>
        <span class="badge">{renderMode==='ansi24'?'True-color':renderMode==='ansi'?'256-color':'99-color'} · {pixelMode}</span>
      </div>
      <button class="x" onclick={onClose} aria-label="Close">×</button>
    </header>
    {#if isDummyFile}
      <div class="dummyNotice" data-testid="dummy-notice">Original image not available — preview is static. You can still rename and save the art.</div>
    {/if}
    <!-- Primary controls -->
    <div class="primary" class:hasThumb={!!thumbnailUrl}>
      <div class="primary-main">
      <div class="p-row two-col">
        <div class="p-col">
          <span class="p-label">Colors</span>
          <div class="pill-group" role="radiogroup" aria-label="Colors">
            {#each colorOpts as o}
              <button class="pill" class:on={midgardMode===o.v} onclick={()=>midgardMode=o.v} role="radio" aria-checked={midgardMode===o.v}>{o.label}</button>
            {/each}
          </div>
        </div>
        <div class="p-col">
          <span class="p-label">Normalize</span>
          <div class="pill-group" role="radiogroup" aria-label="Normalize">
            <button class="pill" class:on={!normalize} onclick={()=>normalize=false} role="radio" aria-checked={!normalize}>Off</button>
            <button class="pill" class:on={normalize} onclick={()=>normalize=true} role="radio" aria-checked={normalize}>On</button>
          </div>
          <span class="p-hint">auto-contrast luma stretch</span>
        </div>
      </div>
      <div class="p-row">
        <span class="p-label">Detail</span>
        <div class="pill-group sm" role="radiogroup" aria-label="Detail">
          {#each pixelOpts as o}
            <button class="pill" class:on={pixelMode===o.v} onclick={()=>pixelMode=o.v} role="radio" aria-checked={pixelMode===o.v}><span class="glyph">{o.glyph}</span> {o.label}</button>
          {/each}
        </div>
      </div>
      <div class="p-row">
        <span class="p-label">Matching</span>
        <div class="pill-group sm" role="radiogroup" aria-label="Color matching">
          <button class="pill" class:on={colorMatching==='rgb'} onclick={()=>colorMatching='rgb'} role="radio" aria-checked={colorMatching==='rgb'}>RGB</button>
          <button class="pill" class:on={colorMatching==='lab'} onclick={()=>colorMatching='lab'} role="radio" aria-checked={colorMatching==='lab'}>Lab</button>
          <button class="pill" class:on={colorMatching==='oklab'} onclick={()=>colorMatching='oklab'} role="radio" aria-checked={colorMatching==='oklab'}>OKLab</button>
        </div>
        <span class="p-hint">OKLab perceptual — best for 256/16</span>
      </div>
      <div class="p-row split">
        <label class="field width-field"><span>Width</span><input class="slider" type="range" min={MIN_IRC_WIDTH} max={MAX_IRC_WIDTH} step="2" bind:value={width} /><b>{width}</b></label>
        <label class="field comp-field" title={compressionDisabled ? 'Compression N/A for True-Color/Comic (greedy, no palette to optimize) — use ANSI 256 / 16 / Smart to enable Viterbi' : 'Viterbi byte-aware compression — higher = shorter lines, w≈2–4 is the sweet spot (57–59% saving). Off at 0.'}>
          <span>Compression</span>
          <input class="slider comp" type="range" min="0" max="6" step="0.5" bind:value={viterbiW} disabled={compressionDisabled} />
          <b class:off={viterbiW===0 || compressionDisabled}>{compressionDisabled?'—':viterbiW===0?'off':viterbiW}</b>
        </label>
        <div class="primary-actions">
          <button class="btn-fit" onclick={smartFit} disabled={fitBusy||!art}>{fitBusy?'Fitting…':'⚡ Fit'}</button>
          <button class="btn-ghost" onclick={resetAll} title="Reset to defaults">↺</button>
        </div>
      </div>
      <div class="p-row scroll-row">
        <span class="p-label">Scroll</span>
        <input class="slider scroll" type="range" min="0" max="4" step="1" bind:value={scrollPreset} aria-label="Scroll speed" />
        <span class="scroll-value" data-testid="scroll-label">{SCROLL_PRESETS[scrollPreset].label}</span>
        <span class="p-hint">{SCROLL_PRESETS[scrollPreset].hint}</span>
        <div class="scroll-ticks" aria-hidden="true">
          {#each SCROLL_PRESETS as p,i}
            <button class="tick" class:on={i===scrollPreset} onclick={()=>scrollPreset=i} title="{p.label}: {p.hint} — burst {p.bd}ms then {p.sd}ms">{p.label}</button>
          {/each}
        </div>
      </div>
      </div>
      {#if thumbnailUrl}
        <img
          class="primaryThumb"
          src={(() => { try { return new URL(thumbnailUrl).pathname; } catch { return thumbnailUrl; } })()}
          alt="Thumbnail"
          loading="lazy"
          onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      {/if}
    </div>

    <!-- byte budget -->
    {#if art}
      <div class="budget" data-testid="budget" class:over={overBudget} class:softWarn={safeOver && !overBudget}>
        <div class="budget-track"><div class="budget-fill" style="width:{pct}%"></div></div>
        <span class="budget-label" class:warn={overBudget}>{hardStats.longest} / {IRC_HARD_LIMIT}<span class="safe"> · {stats.lines} lines · {width} cols</span></span>
        {#if isConverting}<span class="pulse">● updating</span>{:else if overBudget}<button class="link" onclick={smartFit} disabled={fitBusy}>⚡ Fit to 512</button>{:else}<span class="ok">✓</span>{/if}
        {#if lastTimings && (typeof window !== 'undefined' && ( (window as unknown as Record<string,unknown>).__IMG2IRC_PERF || (typeof localStorage !== 'undefined' && localStorage.getItem('img2irc:perf')) || (typeof location !== 'undefined' && location.search.includes('perf=1'))))}
          <span class="perf" data-testid="perf-badge" title={Object.entries(lastTimings ?? {}).map(([k,v])=>`${k}:${(v as number).toFixed(1)}ms`).join(' | ')}>{lastTimings?.total?.toFixed(0) ?? '?'}ms total · viterbi:{(lastTimings?.viterbi ?? 0).toFixed(0)}ms · resize:{(lastTimings?.resize ?? 0).toFixed(0)}ms · {lastTimings?.viterbi_S ? `S=${lastTimings.viterbi_S}` : ''}</span>
        {/if}
      </div>
    {/if}

    <div class="previewWrap" class:converting={isConverting}>
      {#if loading}
        <div class="msg" data-testid="loading">Converting…</div>
      {:else if error}
        <div class="err" data-testid="error">{error}</div>
      {:else}
        <div class="artWrap"><div class="art" data-testid="art">{@html htmlPreview}</div></div>
      {/if}
    </div>

    <!-- Advanced — clean accordion, collapsed by default -->
    <div class="accordion">
      <button class="acc-head" onclick={()=>accTone=!accTone} aria-expanded={accTone}><span class="chev">{accTone?'▾':'▸'}</span> Tone &amp; color <span class="acc-hint">brightness · contrast · saturation · gamma</span></button>
      {#if accTone}
        <div class="acc-body">
          <div class="grid4">
            <label><span>Brightness</span><input class="slider sm" type="range" min="-100" max="100" bind:value={brightness} /><em>{brightness>0?`+${brightness}`:brightness}</em></label>
            <label><span>Contrast</span><input class="slider sm" type="range" min="-100" max="100" bind:value={contrast} /><em>{contrast>0?`+${contrast}`:contrast}</em></label>
            <label><span>Saturation</span><input class="slider sm" type="range" min="-100" max="100" bind:value={saturation} /><em>{saturation>0?`+${saturation}`:saturation}</em></label>
            <label><span>Hue</span><input class="slider sm" type="range" min="0" max="360" bind:value={hue} /><em>{hue}°</em></label>
            <label><span>Gamma</span><input class="slider sm" type="range" min="0" max="4" step="0.1" bind:value={gamma} /><em>{gamma||'off'}</em></label>
            <label class="check"><input type="checkbox" bind:checked={grayscale}/> Grayscale</label>
            <label class="check"><input type="checkbox" bind:checked={invert}/> Invert</label>
            <label class="check"><input type="checkbox" bind:checked={sepia}/> Sepia</label>
            <label class="check" title="Skip near-gray palette entries for richer color"><input type="checkbox" bind:checked={nograyscale}/> No gray</label>
          </div>
        </div>
      {/if}
      <button class="acc-head" onclick={()=>accFx=!accFx} aria-expanded={accFx}><span class="chev">{accFx?'▾':'▸'}</span> Transform <span class="acc-hint">blur · pixelize · rotate · flip · sampling</span></button>
      {#if accFx}
        <div class="acc-body">
          <div class="grid4">
            <label><span>Blur</span><input class="slider sm" type="range" min="0" max="6" step="1" bind:value={blur} /><em>{blur? `${blur}px`:'off'}</em></label>
            <label><span>Pixelize</span><input class="slider sm" type="range" min="0" max="16" step="1" bind:value={pixelize} /><em>{pixelize||'off'}</em></label>
            <label><span>Rotate</span><select bind:value={rotate} class="sel sm"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>
            <label><span>Sampling</span><select bind:value={filter} class="sel sm"><option value="linear">Linear</option><option value="nearest">Nearest</option></select></label>
            <label class="check"><input type="checkbox" bind:checked={flipH}/> Flip H</label>
            <label class="check"><input type="checkbox" bind:checked={flipV}/> Flip V</label>
          </div>
        </div>
      {/if}
      <button class="acc-head" onclick={()=>accOut=!accOut} aria-expanded={accOut}><span class="chev">{accOut?'▾':'▸'}</span> Output <span class="acc-hint">dither</span></button>
      {#if accOut}
        <div class="acc-body">
          <div class="grid4">
            <label><span>Dither</span><select bind:value={ditherMode} class="sel sm"><option value="none">Off</option><option value="bayer4">Bayer 4×4</option><option value="bayer8">Bayer 8×8</option><option value="floyd">Floyd-Steinberg</option><option value="atkinson">Atkinson</option><option value="sierra">Sierra</option><option value="stucki">Stucki</option><option value="jarvis">Jarvis</option></select></label>
          </div>
          <p class="acc-note">Dithering breaks color runs and is byte-adverse with compression — prefer shade blocks for the same tones.</p>
        </div>
      {/if}
    </div>
    <details class="raw"><summary>Raw {renderMode==='ansi24'?'\\x04':'\\x03'} codes</summary><textarea id="ircArtRaw" readonly value={art} rows={Math.min(10, art.split('\n').length+1)}></textarea></details>
    <div class="saveRow">
      <input class="saveName" bind:value={saveName} placeholder="Name" aria-label="Save name" />
      <button class="btn saveBtn" onclick={handleSave} disabled={saving || !art || overBudget}>{#if saving}Saving…{:else if saveOk}Saved ✓{:else if editId}Update{:else}Save{/if}</button>
      {#if saveError}<span class="saveErr">{saveError}</span>{/if}
      {#if overBudget}<span class="saveErr">Fit to 512 first</span>{/if}
    </div>

    <footer>
      {#if onBack}<button class="btn" onclick={onBack}>← Back</button>{/if}
      <div class="foot-left">
        <span class="hint">{renderMode==='ansi24'?'True-Color':renderMode==='ansi'?'256-color':'99-color'} · {pixelMode} · {SCROLL_PRESETS[scrollPreset].label} · {SCROLL_PRESETS[scrollPreset].sd===0 ? 'instant' : `burst 5×${SCROLL_PRESETS[scrollPreset].bd}ms then ${SCROLL_PRESETS[scrollPreset].sd}ms`}</span>
      </div>
      <button class="btn" onclick={copy} disabled={!art||loading}>{copied?'Copied!':'Copy'}</button>
      <button class="btn primary" onclick={send} disabled={!art||loading||sending||!activeTarget}>
        {#if sending}Sending {sentCount}/{stats.lines}…{:else}Send to {activeTarget||'channel'} ({stats.lines}){/if}
      </button>
      <button class="btn ghost" onclick={onClose}>Close</button>
    </footer>
  </div>
</div>

<style>
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.68);display:flex;align-items:center;justify-content:center;z-index:10000;padding:12px;backdrop-filter:blur(2px)}
  .dialog{background:#0f1115;border:1px solid #1f242d;border-radius:12px;width:min(980px,98vw);height:96vh;max-height:96vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.7)}
  header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #1e232b;background:#0f1115}
  .head-left{display:flex;align-items:baseline;gap:10px;min-width:0}
  header h2{margin:0;font-size:13px;font-weight:700;color:#e6edf3;letter-spacing:-.01em}
  .fname{font-size:11px;color:#7d8590;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
  .badge{font-size:10px;color:#8b949e;background:#1a1f29;border:1px solid #232a36;border-radius:999px;padding:2px 8px;white-space:nowrap}
  .x{background:0;border:0;color:#7d8590;font-size:22px;cursor:pointer;line-height:1;padding:0 6px;border-radius:6px}
  .x:hover{color:#e6edf3;background:#1a1f29}
  .dummyNotice{margin:0 16px;padding:8px 12px;background:#1a1400;border:1px solid #3d2a0a;color:#d29922;border-radius:8px;font-size:11px;line-height:1.4}
  .primary{padding:12px 16px;background:#0d0f13;border-bottom:1px solid #1e232b;display:flex;flex-direction:column;gap:12px}
  .primary.hasThumb{flex-direction:row;align-items:flex-start;gap:16px}
  .primary-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:12px}
  .primaryThumb{width:96px;height:96px;object-fit:cover;border-radius:6px;border:1px solid #1e232b;background:#010409;flex-shrink:0;align-self:flex-start}
  .p-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .p-row.split{flex-wrap:wrap}
  .p-row.two-col{justify-content:space-between;gap:16px 24px}
  .p-col{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .p-row.scroll-row{gap:10px 12px}
  .scroll-value{font-size:11px;font-weight:600;color:#e6edf3;min-width:52px;text-align:left}
  .scroll{flex:1;min-width:140px;max-width:260px}
  .scroll-ticks{display:flex;gap:4px;flex-wrap:wrap}
  .tick{font-size:9px;font-weight:500;padding:3px 7px;border-radius:999px;border:1px solid #232a36;background:transparent;color:#7d8590;cursor:pointer;transition:all .14s;line-height:1}
  .tick:hover{border-color:#2d3648;color:#c9d1d9;background:#141821}
  .tick.on{background:#e6edf3;border-color:#e6edf3;color:#0f1115;font-weight:600}
  .p-hint{font-size:10px;color:#4d555f;margin-left:4px;white-space:nowrap}
  .pill-group{display:flex;gap:4px;flex-wrap:wrap}
  .pill{font-size:11px;font-weight:500;padding:5px 10px;border-radius:999px;border:1px solid #232a36;background:#141821;color:#9aa4b2;cursor:pointer;transition:all .14s}
  .pill.on{background:#e6edf3;color:#0f1115;border-color:#e6edf3;font-weight:600;box-shadow:0 1px 8px rgba(230,237,243,.15)}
  .pill .glyph{font-size:11px;margin-right:2px}
  .field{display:flex;align-items:center;gap:8px;font-size:11px;color:#9aa4b2;white-space:nowrap}
  .field span{color:#7d8590;font-weight:500}
  .field b{min-width:20px;text-align:right;color:#e6edf3;font-size:11px}
  .field b.off{color:#7d8590;font-weight:400}
  .width-field{flex:1 1 260px}
  .comp-field{flex:0 1 150px}
  .width-field .slider{flex:1;min-width:140px}
  .comp-field .slider{flex:0 0 90px;width:90px;min-width:70px}
  .btn-fit{background:#1a2a44;border:1px solid #2a4a7a;color:#58a6ff;border-radius:8px;padding:6px 12px;font-size:11px;font-weight:600;cursor:pointer;transition:all .14s}
  .btn-fit:hover:not(:disabled){background:#243a5e;color:#fff;border-color:#3a6ab8}
  .btn-fit:disabled{opacity:.45;cursor:default}
  .btn-ghost{background:#141821;border:1px solid #232a36;color:#7d8590;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}
  .btn-ghost:hover{color:#c9d1d9;border-color:#2d3648}

  .budget{display:flex;align-items:center;gap:10px;padding:7px 16px;background:#0a0c0f;border-bottom:1px solid #1e232b;font-size:11px}
  .budget.over{background:#1a1205;border-bottom-color:#3d2a0a}
  .budget.softWarn{background:#141210;border-bottom-color:#2a2210}
  .budget-track{flex:1;height:5px;background:#1a1f29;border-radius:999px;overflow:hidden;max-width:420px;box-shadow:inset 0 1px 1px rgba(0,0,0,.4)}
  .budget-fill{height:100%;background:#3fb950;transition:width .25s, background .2s}
  .budget.over .budget-fill{background:#d29922}
  .budget.softWarn .budget-fill{background:#c9a84c}
  .budget-label{color:#7d8590;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:11px}
  .perf{font-size:10px;color:#8b949e;background:#141821;border:1px solid #232a36;border-radius:999px;padding:2px 6px;white-space:nowrap;font-variant-numeric:tabular-nums}
  .budget-label.warn{color:#d29922}
  .budget .safe{color:#4d555f}
  .budget .ok{color:#3fb950;font-size:11px}
  .budget .link{background:0;border:0;color:#58a6ff;font-size:11px;cursor:pointer;font-weight:600}
  .budget .link:hover{text-decoration:underline}
  .pulse{font-size:10px;color:#58a6ff;animation:pulse 1s ease-in-out infinite;margin-left:auto}
  @keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}
  .previewWrap{position:relative;flex:1 1 auto;min-height:280px;background:#000;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#232a36 #000;border-bottom:1px solid #1e232b;display:flex;align-items:center;justify-content:center}
  .previewWrap::-webkit-scrollbar-thumb{background:#232a36;border-radius:999px}
  .previewWrap:has(.artWrap){display:block}
  .artWrap{display:block;min-width:max-content;min-height:max-content;padding:14px}
  .art{display:inline-block;font:11px/11px "Hack","SF Mono",Menlo,Consolas,monospace;white-space:pre;text-align:left}
  .msg,.err{color:#7d8590;padding:24px;font-size:12px;text-align:center} .err{color:#ff7b72}
  .msg.updating{display:flex;align-items:center;justify-content:center;gap:8px;color:#58a6ff;font-size:11px}
  .spinner{width:12px;height:12px;border:1.5px solid rgba(88,166,255,.3);border-top-color:#58a6ff;border-radius:50%;animation:spin .7s linear infinite;display:inline-block}
  @keyframes spin{to{transform:rotate(360deg)}}

  .accordion{border-top:1px solid #1e232b;background:#0d0f13}
  .acc-head{width:100%;display:flex;align-items:center;gap:8px;padding:9px 16px;background:0;border:0;border-bottom:1px solid #1a1f29;color:#9aa4b2;font-size:11px;font-weight:500;cursor:pointer;text-align:left;transition:background .12s}
  .acc-head:hover{background:#11151c;color:#c9d1d9}
  .acc-head[aria-expanded="true"]{color:#e6edf3;background:#11151c;border-bottom-color:#1e232b}
  .chev{font-size:10px;color:#7d8590;width:12px;text-align:center}
  .acc-hint{margin-left:auto;font-size:10px;color:#4d555f;font-weight:400;white-space:nowrap}
  .acc-body{padding:12px 16px;border-bottom:1px solid #1a1f29;background:#0a0c0f}
  .grid4{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}
  .grid4 label{font-size:11px;color:#9aa4b2;display:flex;gap:6px;align-items:center;white-space:nowrap}
  .grid4 label span{min-width:52px;color:#7d8590;font-size:11px}
  .grid4 em{font-style:normal;color:#4d555f;min-width:34px;font-size:10px;font-variant-numeric:tabular-nums}
  .grid4 label.check{cursor:pointer;user-select:none}
  .grid4 input[type=checkbox]{-webkit-appearance:none;appearance:none;width:15px;height:15px;border-radius:4px;border:1.5px solid #232a36;background:#141821;display:inline-grid;place-content:center;cursor:pointer;flex-shrink:0;transition:all .14s}
  .grid4 input[type=checkbox]:hover{border-color:#2d3648;background:#1a1f29}
  .grid4 input[type=checkbox]:checked{background:#e6edf3;border-color:#e6edf3}
  .grid4 input[type=checkbox]::before{content:"";width:7px;height:4px;border:solid #0f1115;border-width:0 0 1.8px 1.8px;transform:rotate(-45deg) scale(0);transition:transform .12s}
  .grid4 input[type=checkbox]:checked::before{transform:rotate(-45deg) scale(1)}
  .acc-note{margin:10px 0 0;font-size:10px;color:#4d555f;line-height:1.4}

  .sel{background:#141821;color:#c9d1d9;border:1px solid #232a36;border-radius:7px;padding:4px 8px;font-size:11px;cursor:pointer}
  .sel.sm{padding:3px 6px}
  .sel:focus{outline:none;border-color:#2d3648}

  .slider{-webkit-appearance:none;appearance:none;height:5px;background:#1a1f29;border-radius:999px;outline:none;cursor:pointer;transition:background .15s}
  .slider:hover{background:#232a36}
  .slider:focus{box-shadow:0 0 0 2px rgba(88,166,255,.18)}
  .slider:disabled{opacity:.35;cursor:not-allowed}
  .slider:disabled::-webkit-slider-thumb{cursor:not-allowed}
  .slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:13px;height:13px;border-radius:50%;background:#e6edf3;border:2px solid #0f1115;box-shadow:0 1px 4px rgba(0,0,0,.5);cursor:pointer;transition:transform .12s, background .12s}
  .slider::-moz-range-thumb{width:13px;height:13px;border-radius:50%;background:#e6edf3;border:2px solid #0f1115;box-shadow:0 1px 4px rgba(0,0,0,.5);cursor:pointer}
  .slider::-moz-range-track{height:5px;background:#1a1f29;border-radius:999px}
  .slider:hover:not(:disabled)::-webkit-slider-thumb{transform:scale(1.12);background:#fff}
  .slider:active:not(:disabled)::-webkit-slider-thumb{transform:scale(1.2)}
  .slider.sm{width:88px}
  .slider.comp{flex:1;min-width:80px}
  .raw{border-top:1px solid #1e232b;padding:8px 16px;background:#0d0f13}
  .raw summary{font-size:11px;color:#58a6ff;cursor:pointer;user-select:none}
  .raw textarea{margin-top:8px;width:100%;background:#000;color:#7d8590;border:1px solid #1e232b;border-radius:6px;font:10px/1.3 "Hack",monospace;padding:8px;white-space:pre;overflow:auto}
  .saveRow{display:flex;gap:8px;align-items:center;padding:10px 16px;border-top:1px solid #1e232b;background:#0d0f13;flex-wrap:wrap}
  .saveName{flex:1;min-width:120px;background:#010409;color:#e6edf3;border:1px solid #232a36;border-radius:6px;padding:6px 10px;font-size:12px}
  .saveName:focus{outline:none;border-color:#58a6ff}
  .saveBtn{min-width:80px}
  .saveErr{font-size:11px;color:#f85149}

  footer{display:flex;gap:8px;padding:12px 16px;border-top:1px solid #1e232b;justify-content:flex-end;align-items:center;flex-wrap:wrap;background:#0f1115}
  .foot-left{margin-right:auto}
  .hint{font-size:10px;color:#4d555f}
  .btn{font-size:12px;padding:6px 14px;border-radius:8px;border:1px solid transparent;cursor:pointer;font-weight:500;transition:all .12s}
  .btn:disabled{opacity:.45;cursor:default}
  .btn.primary{background:#238636;color:#fff;border-color:#2ea043;font-weight:600}
  .btn.primary:hover:not(:disabled){background:#2ea043}
  .btn{background:#1a1f29;color:#c9d1d9;border-color:#232a36}
  .btn:hover:not(:disabled){background:#232a36;border-color:#2d3648}
  .btn.ghost{background:0;color:#7d8590;border-color:transparent}
  .btn.ghost:hover{color:#c9d1d9;background:#1a1f29}
</style>
