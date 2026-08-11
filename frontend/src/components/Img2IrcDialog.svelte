<script lang="ts">
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import { imageToIrcArt, loadImageFromFile, revokeImageUrl, clearColorLut, estimateLineLengths, DEFAULT_IRC_WIDTH, MIN_IRC_WIDTH, MAX_IRC_WIDTH, IRC_HARD_LIMIT, IRC_SAFE_PAYLOAD, type RenderMode, type PixelMode, type DitherMode, type ColorMatching, type MidgardColorMode } from '../lib/img2irc';
  // Worker is loaded lazily via dynamic import to keep main bundle small and not break if Worker unsupported
  import { sendMessage } from '../stores/wsConnection.svelte';
  import { ircState } from '../stores/ircStore.svelte';
  import { generateLabel } from '../lib/utils';

  interface Props { file: File|Blob; filename:string; onClose:()=>void; onBack?:()=>void; }
  let { file, filename, onClose, onBack }: Props = $props();

  let width=$state(DEFAULT_IRC_WIDTH);
  let renderMode=$state<RenderMode>('ansi');
  let pixelMode=$state<PixelMode>('half');
  let midgardMode=$state<MidgardColorMode>('xterm256');
  let brightness=$state(0), contrast=$state(0), saturation=$state(0), hue=$state(0), gamma=$state(0), blur=$state(0), pixelize=$state(0);
  let grayscale=$state(false), invert=$state(false), sepia=$state(false), normalize=$state(false), dither=$state(false), nograyscale=$state(false), flipH=$state(false), flipV=$state(false), comicFilter=$state<'none'|'comic'>('none');
  let ditherMode=$state<DitherMode>('none'), colorMatching=$state<ColorMatching>('oklab');
  let viterbiW=$state(2.5);
  let rotate=$state('0');
  let filter=$state('linear');
  let showAdv=$state(false);

  $effect(()=>{
    void midgardMode;
    if((midgardMode as string)==='vga256'){ midgardMode='xterm256'; return; } // removed DOS/VGA — migrate to xterm256
    if(midgardMode==='truecolor'){ renderMode='ansi24'; if(comicFilter==='comic') comicFilter='none'; }
    else if(midgardMode==='xterm256'){ renderMode='ansi'; comicFilter='none'; }
    else if(midgardMode==='16'){ renderMode='irc'; comicFilter='none'; }
    else if(midgardMode==='retro'){ renderMode='irc'; comicFilter='none'; pixelMode='half'; }
    else if(midgardMode==='comic'){ renderMode='ansi24'; comicFilter='comic'; }
  });
  let art=$state(''), htmlPreview=$state(''), loading=$state(true), isConverting=$state(false), error=$state<string|null>(null), copied=$state(false), sending=$state(false), sentCount=$state(0);
  let hasAlpha=$state(false);
  let gen=0;
  let debounce: ReturnType<typeof setTimeout>|null=null;
  let _worker: Worker | null = null;
  // Cleanup worker and timers on destroy — prevents leak when dialog is opened/closed repeatedly
  $effect(() => {
    return () => {
      if (debounce) { clearTimeout(debounce); debounce = null; }
      try { _worker?.terminate(); } catch {}
      _worker = null;
      gen++; // cancel any in-flight converts
    };
  });
  function getWorker(): Worker | null {
    if (_worker) return _worker;
    try {
      // Vite handles ?worker&url — dynamic, no static import to break build
      _worker = new Worker(new URL('../lib/img2irc.worker.ts', import.meta.url), { type: 'module' });
      _worker.onerror = () => { try { _worker?.terminate(); } catch {}; _worker = null; };
    } catch { _worker = null; }
    return _worker;
  }
  async function convertViaWorker(img: HTMLImageElement, opts: any, expectedGen: number): Promise<string | null> {
    const estimatedPixels = (opts.width || 60) * Math.max(1, Math.round((opts.width || 60) * ((img.naturalHeight||img.height)/(img.naturalWidth||img.width)||1) * 0.9)) * 2;
    const reasonNotWorker = (()=>{ if(estimatedPixels < 4000 && !opts.comic) return `small image (${estimatedPixels}px <4000 && !comic)`; if(!getWorker()) return 'Worker failed to create'; if(typeof OffscreenCanvas==='undefined') return 'OffscreenCanvas unavailable'; if(typeof createImageBitmap==='undefined') return 'createImageBitmap unavailable'; return null; })();
    if (reasonNotWorker) {
      console.info(`[img2irc] Worker skip: ${reasonNotWorker} — main thread fallback | img ${img.naturalWidth}x${img.naturalHeight} -> ${opts.width} cols, ~${estimatedPixels}px, comic=${opts.comic}, mode=${opts.colorMatching}, pm=${opts.pixelMode}, viterbiW=${opts.viterbiW}`);
      return null;
    }
    const w = getWorker();
    if (!w) { console.info('[img2irc] Worker miss: getWorker() null after check'); return null; }
    let bitmap: ImageBitmap | null = null;
    let handler: ((e: MessageEvent) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const _tWStart = performance.now();
    try {
      console.info(`[img2irc] Worker: creating ImageBitmap for ${img.naturalWidth}x${img.naturalHeight}...`);
      bitmap = await createImageBitmap(img);
      console.info(`[img2irc] Worker: ImageBitmap ${bitmap.width}x${bitmap.height} created in ${(performance.now()-_tWStart).toFixed(1)}ms, posting to worker...`);
      if (expectedGen !== gen) { try { bitmap.close(); } catch {} console.info('[img2irc] Worker abort: gen changed after bitmap create'); return null; }
      const id = Math.random();
      const res = await new Promise<string>((resolve, reject) => {
        handler = (e: MessageEvent) => {
          const d: any = e.data;
          if (d.id !== id) return;
          if (handler) w.removeEventListener('message', handler as any);
          if (timer) clearTimeout(timer);
          const elapsed = (performance.now()-_tWStart).toFixed(1);
          if (d.ok) { console.info(`[img2irc] Worker success: ${elapsed}ms off-thread`); resolve(d.result); }
          else { console.info(`[img2irc] Worker error: ${d.error} after ${elapsed}ms`); reject(new Error(d.error)); }
        };
        w.addEventListener('message', handler as any);
        w.postMessage({ id, bitmap: bitmap!, opts }, [bitmap as any]);
        bitmap = null;
        timer = setTimeout(() => {
          if (handler) w.removeEventListener('message', handler as any);
          console.info(`[img2irc] Worker timeout after 15000ms — falling back to main thread (Viterbi was ${opts.viterbiW} for ${opts.width} cols)`);
          reject(new Error('worker timeout'));
        }, 15000);
      });
      return res;
    } catch (e) {
      console.info(`[img2irc] Worker exception: ${String(e)}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      if (handler) { try { w.removeEventListener('message', handler as any); } catch {} }
      if (bitmap) { try { bitmap.close(); } catch {} }
      console.info(`[img2irc] Worker total: ${(performance.now()-_tWStart).toFixed(1)}ms`);
    }
  }

  function schedule(){
    if(fitting) return;
    const my=++gen;
    if(debounce) clearTimeout(debounce);
    if(htmlPreview) isConverting=true;
    debounce=setTimeout(async()=>{
      if(my!==gen) return;
      await convert(my);
    }, 70);
  }
  // Fast preview for interactive adjustment: when user is actively dragging
  // (isConverting true or debounce pending), use greedy (viterbiW=0) for <50ms preview,
  // then full Viterbi in background when idle. This makes slider feedback near-realtime.
  function getPreviewOpts(base: any, isFast: boolean) {
    if (!isFast) return base;
    return { ...base, viterbiW: 0, comic: false, dither: false }; // greedy, no bilateral/dither for speed
  }
  $effect(()=>{ void width; void renderMode; void pixelMode; void midgardMode; void brightness; void contrast; void saturation; void hue; void gamma; void blur; void pixelize; void grayscale; void invert; void sepia; void normalize; void dither; void ditherMode; void colorMatching; void nograyscale; void flipH; void flipV; void rotate; void filter; void viterbiW; void comicFilter; schedule(); });
  $effect(()=>{ const c=++gen; void convert(c); return ()=>{gen++; if(debounce) clearTimeout(debounce);}; });

  async function convert(expected=gen){
    const cur=expected;
    if(!htmlPreview) loading=true;
    error=null;
    try{
      const img=await loadImageFromFile(file as File);
      if(cur!==gen){ revokeImageUrl(img); return; }
      // detect alpha for professional auto-hide
      try{
        const c=document.createElement('canvas'); c.width=Math.min(64, img.naturalWidth); c.height=Math.min(64, img.naturalHeight);
        const cx=c.getContext('2d')!; cx.drawImage(img,0,0,c.width,c.height);
        const d=cx.getImageData(0,0,c.width,c.height).data;
        let found=false; for(let i=3;i<d.length;i+=4) if(d[i]<250){found=true;break;}
        hasAlpha=found;
      } catch {}
      try{
        const baseOpts={ width, renderMode, pixelMode, midgardMode, filter: filter as any, brightness, contrast, saturation, hue, gamma: gamma||0, blur, pixelize, grayscale, invert, sepia, normalize, dither, ditherMode, colorMatching, nograyscale, flipH, flipV, rotate: Number(rotate), viterbiW, comic: comicFilter==='comic', alphaMode: hasAlpha?'transparent':'opaque' as const, alphaThreshold:128, trimTransparent:false, smartEdges:true, background:'#000000' } as const;
        const isInteractive = isConverting || debounce !== null;
        const opts = getPreviewOpts(baseOpts, isInteractive);
        if (isInteractive) console.info(`[img2irc] Fast preview: viterbiW=0 (greedy) for ${opts.width} cols — full Viterbi on idle`);
        // Try off-main-thread Worker with transferable ImageBitmap (no copy) — falls back to main thread
        // Pass expectedGen so worker can abort if user changed sliders while bitmap was being created
        let res: string | null = null;
        const _tWorker = performance.now();
        try { res = await convertViaWorker(img, opts, cur); } catch {}
        if (res !== null) {
          console.info(`[img2irc] Worker success: ${(performance.now()-_tWorker).toFixed(1)}ms off-thread`);
        } else {
          console.info(`[img2irc] Worker miss — falling back to main thread`);
        }
        if (cur!==gen) { revokeImageUrl(img); return; }
        if (res == null) {
          res = await imageToIrcArt(img, opts);
        }
        // If we did fast preview, schedule a full-quality refine in background when idle
        if (isInteractive && opts.viterbiW === 0 && baseOpts.viterbiW !== 0) {
          setTimeout(() => { if (gen === cur) void convert(cur); }, 300);
        }
        htmlPreview=res.split('\n').map(l=>`<div class="ircArtLine">${parseIrcFormatting(l)}</div>`).join('');
      } finally { revokeImageUrl(img); }
    } catch(e:any){ if(cur===gen){ error=e?.message??'Failed'; }}
    if(cur===gen){ loading=false; isConverting=false; }
  }

  const stats=$derived(estimateLineLengths(art));
  const hardStats=$derived(estimateLineLengths(art, IRC_HARD_LIMIT));
  const activeTarget=$derived(ircState.activeBuffer.bufferName||'');
  const activeNetworkId=$derived(ircState.activeBuffer.networkId||'');

  // ── Smart fit: adjust compression / width / colour mode until longest line ≤ 512 ──
  // Ladder is quality-preserving: cheapest quality cost first. Viterbi w uses bisection (LambdaPareto.lean: bytes_antitone)
  // so we binary-search the minimal w that fits before touching geometry.
  let fitBusy=$state(false);
  let fitting=false;
  async function smartFit(){
    if(!art || fitBusy) return;
    fitBusy=true; fitting=true;
    try{
      let steps=0;
      while(steps++ < 14){
        const longest=estimateLineLengths(art).longest;
        if(longest<=IRC_HARD_LIMIT) break;
        // Try bisection on w first if indexed and w<6
        const indexed = renderMode!=='ansi24' && midgardMode!=='truecolor' && midgardMode!=='comic';
        if(indexed && viterbiW < 6){
          const ok = await bisectViterbiW();
          if(ok) continue; // re-measure after bisection
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
    await new Promise(r=>setTimeout(r,30)); my=++gen; await convert(my);
    return found;
  }
  function pickFitStep(): (()=>void)|null{
    const indexed = renderMode!=='ansi24' && midgardMode!=='truecolor' && midgardMode!=='comic';
    // 1. bump Viterbi byte weight (indexed only) — smallest quality loss (fallback if bisection already tried)
    if(indexed && viterbiW < 6) return ()=>{ viterbiW=Math.min(6, Math.round((viterbiW+0.5)*2)/2); };
    // 2. shrink width
    if(width > MIN_IRC_WIDTH + 4) return ()=>{ width=Math.max(MIN_IRC_WIDTH, width-4); };
    // 3. comic bilateral pre-filter lengthens runs (indexed only)
    if(indexed && comicFilter!=='comic') return ()=>{ comicFilter='comic'; };
    // 4. switch truecolor/256 → 16 colours (biggest byte lever, biggest quality hit)
    if(midgardMode==='truecolor' || midgardMode==='xterm256') return ()=>{ midgardMode='16'; };
    // 5. last resort: minimum width
    if(width > MIN_IRC_WIDTH) return ()=>{ width=MIN_IRC_WIDTH; };
    return null;
  }

  async function copy(){
    try{ await navigator.clipboard.writeText(art); copied=true; setTimeout(()=>copied=false,1200);}catch{
      const ta=document.getElementById('ircArtRaw') as HTMLTextAreaElement|null; if(ta){ ta.select(); document.execCommand('copy'); copied=true; setTimeout(()=>copied=false,1200);}
    }
  }
  async function send(){
    if(!art||!activeNetworkId||!activeTarget) return;
    sending=true; sentCount=0;
    const lines=art.split('\n');
    const BURST=5, BD=35, SD=110;
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(!line.replace(/[\x03\x04\x0f0-9,a-fA-F ]/g,'').trim() && line.trim()==='') continue;
      sendMessage(activeNetworkId, activeTarget, line, generateLabel());
      sentCount=i+1;
      if(i<lines.length-1) await new Promise(r=>setTimeout(r, i<BURST?BD:SD));
    }
    sending=false; onClose();
  }
  function resetAll(){
    width=DEFAULT_IRC_WIDTH;
    renderMode='ansi';
    pixelMode='half';
    midgardMode='xterm256';
    brightness=0; contrast=0; saturation=0; hue=0; gamma=0; blur=0; pixelize=0;
    grayscale=false; invert=false; sepia=false; normalize=false; dither=false; ditherMode='none'; colorMatching='oklab'; nograyscale=false; flipH=false; flipV=false; comicFilter='none'; rotate='0'; filter='linear'; viterbiW=2.5;
  }
  function handleKey(e:KeyboardEvent){ if(e.key==='Escape') onClose(); }
  function handleOverlayClick(e:MouseEvent){ if(e.target===e.currentTarget) onClose(); }
</script>

<svelte:window onkeydown={handleKey} />

<div class="overlay" role="dialog" aria-modal="true" onclick={handleOverlayClick}>
  <div class="dialog">
    <header>
      <h2>Convert to IRC <span class="sub">• {filename}</span></h2>
      <button class="x" onclick={onClose} aria-label="Close">×</button>
    </header>

    <div class="bar">
      <label class="ctrl"><span>Width</span><input class="slider" type="range" min={MIN_IRC_WIDTH} max={MAX_IRC_WIDTH} step="2" bind:value={width} /><b class="val">{width}</b></label>
      <label class="ctrl">
        <select bind:value={midgardMode} class="sel" aria-label="Colors">
          <option value="truecolor" data-i18n="colors.truecolor">True-Color (24-bit)</option>
          <option value="xterm256" data-i18n="colors.xterm256">ANSI/xterm 256</option>
          <option value="16" data-i18n="colors.16">16 colors</option>
          <option value="retro" data-i18n="colors.retro">Retro / Demoscene</option>
          <option value="comic" data-i18n="colors.comic">Comic / Pop Art</option>
        </select>
      </label>
      <label class="ctrl">
        <select bind:value={pixelMode} class="sel">
          <option value="half">Half ▀</option>
          <option value="quarter">Quarter ▖</option>
          <option value="braille">Braille ⣿</option>
          <option value="full">Full █</option>
        </select>
      </label>
      <button class="advBtn" onclick={()=>showAdv=!showAdv}>{showAdv?'▴ Simple':'▾ Advanced'}</button>
      <button class="fitBtn" onclick={smartFit} disabled={fitBusy||!art} title="Auto-fit under 512 B: bump compression, shrink width, switch to cheaper colours">{fitBusy?'Fitting…':'⚡ Fit'}</button>
      <button class="resetBtn" onclick={resetAll} title="Reset all presets to defaults">↺ Reset</button>
      <span class="stats" class:warn={!stats.ok}>{#if art}{stats.lines}×{width} • {stats.longest}B{/if}</span>
      {#if isConverting}<span class="pulse" aria-label="Updating">● updating</span>{/if}
    </div>

    {#if art}
    <div class="budget" class:over={!hardStats.ok} title="Longest line vs RFC 2812 512-byte hard limit — 400 is safe everywhere.">
      <div class="budget-track"><div class="budget-fill" style="width:{Math.min(100, (hardStats.longest/IRC_HARD_LIMIT)*100)}%"></div></div>
      <span class="budget-label">{hardStats.longest} / {IRC_HARD_LIMIT} <span class="safe">({IRC_SAFE_PAYLOAD} safe)</span> {#if hardStats.ok}✓{:else}⚠ over{/if}</span>
      {#if !hardStats.ok}<button class="link" onclick={smartFit} disabled={fitBusy}>⚡ Fit</button>{/if}
    </div>
    {/if}

    {#if showAdv}
      <div class="adv">
        <div class="row">
          <label><span>Bright</span><input class="slider sm" type="range" min="-100" max="100" bind:value={brightness} /><em>{brightness>0?`+${brightness}`:brightness}</em></label>
          <label><span>Contrast</span><input class="slider sm" type="range" min="-100" max="100" bind:value={contrast} /><em>{contrast>0?`+${contrast}`:contrast}</em></label>
          <label><span>Saturate</span><input class="slider sm" type="range" min="-100" max="100" bind:value={saturation} /><em>{saturation>0?`+${saturation}`:saturation}</em></label>
          <label><span>Hue</span><input class="slider sm" type="range" min="0" max="360" bind:value={hue} /><em>{hue}°</em></label>
        </div>
        <div class="row">
          <label><span>Gamma</span><input class="slider sm" type="range" min="0" max="4" step="0.1" bind:value={gamma} /><em>{gamma||'off'}</em></label>
          <label><span>Blur</span><input class="slider sm" type="range" min="0" max="6" step="1" bind:value={blur} /><em>{blur? `${blur}px`:'off'}</em></label>
          <label><span>Pixelize</span><input class="slider sm" type="range" min="0" max="16" step="1" bind:value={pixelize} /><em>{pixelize||'off'}</em></label>
            <label><span>Rotate</span><select bind:value={rotate} class="sel sm"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>
        </div>
        <div class="row">
          <label title="Viterbi byte-aware — w≈2-4 is 57-59% saving"><span>Compress</span><input class="slider sm" type="range" min="0" max="6" step="0.5" bind:value={viterbiW} disabled={renderMode==='ansi24'} /><em>{renderMode==='ansi24' ? '—' : viterbiW===0?'off':viterbiW}</em></label>
          <label><span>Dither</span><select bind:value={ditherMode} class="sel sm"><option value="none">None</option><option value="bayer4">Bayer 4</option><option value="bayer8">Bayer 8</option><option value="floyd">Floyd</option><option value="atkinson">Atkinson</option></select></label>
          <label><span>Match</span><select bind:value={colorMatching} class="sel sm"><option value="rgb">RGB</option><option value="lab">Lab</option><option value="oklab">OKLab</option></select></label>
        </div>
        <div class="row checks">
          <label><input type="checkbox" bind:checked={grayscale}/> Gray</label>
          <label><input type="checkbox" bind:checked={invert}/> Invert</label>
          <label><input type="checkbox" bind:checked={sepia}/> Sepia</label>
          <label><input type="checkbox" bind:checked={normalize}/> Normalize</label>
          <label title="Edge-preserving smoother — flattens gradients, lengthens colour runs without blurring edges. 2× bilateral radius 2 σ40: landscape -11% (spec §6)">Comic <select class="sel sm" bind:value={comicFilter}><option value="none">Off</option><option value="comic">Comic</option></select></label>
          <label title="Dithering is byte-adverse on IRC: it breaks colour runs (STUDY §8). Shade blocks buy the same tones at zero prefix cost."><input type="checkbox" bind:checked={dither}/> Dither {#if dither && viterbiW>0}<span class="warn" title="Byte-adverse with Viterbi — disables run compression">⚠</span>{/if}</label>
          <label title="Skip near-gray palette colors for richer color (--nograyscale)"><input type="checkbox" bind:checked={nograyscale}/> <span class="t">NoGray</span></label>
          <label><input type="checkbox" bind:checked={flipH}/> Flip H</label>
          <label><input type="checkbox" bind:checked={flipV}/> Flip V</label>
          <label>Filter <select bind:value={filter} class="sel sm"><option value="linear">Linear</option><option value="nearest">Nearest</option></select></label>
          <button class="link" onclick={resetAdv}>Reset all</button>
        </div>
      </div>
    {/if}

    <div class="previewWrap" class:converting={isConverting}>
      {#if loading}
        <div class="msg">Converting…</div>
      {:else if error}
        <div class="err">{error}</div>
      {:else}
        <div class="artWrap"><div class="art">{@html htmlPreview}</div></div>
      {/if}
      {#if isConverting && !loading}<div class="updatingBadge">Updating…</div>{/if}
    </div>

    <details class="raw"><summary>Raw {renderMode==='ansi24'?'\\x04':'\\x03'} codes</summary><textarea id="ircArtRaw" readonly value={art} rows={Math.min(10, art.split('\n').length+1)}></textarea></details>

    <footer>
      {#if onBack}<button class="btn" onclick={onBack}>← Back</button>{/if}
      <button class="btn" onclick={copy} disabled={!art||loading}>{copied?'Copied!':'Copy'}</button>
      <button class="btn primary" onclick={send} disabled={!art||loading||sending||!activeTarget}>
        {#if sending}Sending {sentCount}/{stats.lines}…{:else}Send to {activeTarget||'channel'} ({stats.lines}){/if}
      </button>
      <button class="btn ghost" onclick={onClose}>Close</button>
    </footer>
    <p class="hint">{renderMode==='ansi24'?'True-color 24-bit':renderMode==='ansi'?'256-color':'99-color'} • {pixelMode} • Burst 5×70ms then 220ms</p>
  </div>
</div>

<style>
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:10000;padding:12px}
  .dialog{background:#1a1d21;border:1px solid #2c2f35;border-radius:8px;width:min(900px,98vw);max-height:94vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,.6)}
  header{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #2c2f35}
  header h2{margin:0;font-size:13px;color:#e6e6e6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .sub{font-weight:400;color:#8b949e;font-size:11px}
  .x{background:0;border:0;color:#8b949e;font-size:22px;cursor:pointer;line-height:1;padding:0 4px}
  .x:hover{color:#fff}
  .bar{display:flex;flex-wrap:wrap;gap:10px 14px;padding:8px 12px;background:#15181c;border-bottom:1px solid #21252c;align-items:center}
  .ctrl{display:flex;gap:6px;align-items:center;font-size:11px;color:#b0b8c1}
  .val{min-width:22px;text-align:right;font-weight:600;color:#e6e6e6;font-size:11px}
  .sel{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer}
  .sel.sm{padding:2px 6px}
  .sel:focus{outline:none;border-color:#58a6ff}
  .advBtn{background:#21262d;border:1px solid #30363d;color:#c9d1d9;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer}
  .advBtn:hover{background:#30363d}
  .resetBtn{background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;transition:all .12s}
  .resetBtn:hover{background:#2a1215;border-color:#5a2a2e;color:#ff7b72}
  .fitBtn{background:#1f3a5f;border:1px solid #2d5a9e;color:#58a6ff;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;transition:all .12s}
  .fitBtn:hover:not(:disabled){background:#2d5a9e;color:#fff}
  .fitBtn:disabled{opacity:.5;cursor:default}
  .stats{font-size:10px;color:#8b949e;margin-left:auto}
  .stats.warn{color:#f0883e}
  .budget{display:flex;align-items:center;gap:10px;padding:6px 14px;background:#0f1216;border-bottom:1px solid #21252c;font-size:11px}
  .budget.over{background:#1a1500;border-bottom-color:#3d2e1a}
  .budget-track{flex:1;height:6px;background:#21262d;border-radius:999px;overflow:hidden;max-width:360px;box-shadow:inset 0 1px 1px rgba(0,0,0,.3)}
  .budget-fill{height:100%;background:#3fb950;transition:width .2s, background .2s}
  .budget.over .budget-fill{background:#d29922}
  .budget-label{color:#8b949e;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:11px}
  .budget.over .budget-label{color:#d29922}
  .budget .safe{color:#6e7681}
  .budget .link{margin-left:auto;background:0;border:0;color:#58a6ff;font-size:11px;cursor:pointer}
  .budget .link:hover{text-decoration:underline}
  .budget .link:disabled{opacity:.5;cursor:default}
  .pulse{font-size:10px;color:#58a6ff;animation:pulse 1s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}
  .adv{padding:10px 12px;background:#0f1216;border-bottom:1px solid #21252c;display:flex;flex-direction:column;gap:10px}
  .adv .row{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center}
  .adv label{font-size:11px;color:#b0b8c1;display:flex;gap:6px;align-items:center;white-space:nowrap}
  .adv label span{min-width:52px;color:#8b949e}
  .adv em{font-style:normal;color:#6e7681;min-width:34px;font-size:10px;font-variant-numeric:tabular-nums}
  .adv .checks label{font-size:11px; position:relative; cursor:pointer; user-select:none; padding-left:2px}
  .adv input[type=checkbox]{
    -webkit-appearance:none; appearance:none;
    width:16px; height:16px; border-radius:4px;
    border:1.5px solid #30363d; background:#21262d;
    display:inline-grid; place-content:center;
    cursor:pointer; flex-shrink:0;
    transition:background .14s, border-color .14s, box-shadow .14s, transform .08s;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.04);
  }
  .adv input[type=checkbox]:hover{border-color:#3d84e6; background:#283040; transform:translateY(-0.5px)}
  .adv input[type=checkbox]:active{transform:scale(.96)}
  .adv input[type=checkbox]:focus-visible{outline:none; box-shadow:0 0 0 2px rgba(88,166,255,.25), inset 0 1px 0 rgba(255,255,255,.04)}
  .adv input[type=checkbox]:checked{background:#58a6ff; border-color:#58a6ff; box-shadow:0 1px 6px rgba(88,166,255,.35)}
  .adv input[type=checkbox]:checked:hover{background:#6ea8ff; border-color:#6ea8ff}
  .adv input[type=checkbox]::before{
    content:""; width:7px; height:4px;
    border:solid #fff; border-width:0 0 1.8px 1.8px;
    transform:rotate(-45deg) scale(0); transition:transform .12s ease-out;
    margin-top:-1px;
  }
  .adv input[type=checkbox]:checked::before{transform:rotate(-45deg) scale(1)}
  .adv .checks label:has(input:checked){color:#d1d9e6}
  /* Nice sliders — no flicker, smooth thumb */
  .slider{
    -webkit-appearance:none; appearance:none;
    height:6px; background:#2c2f35; border-radius:999px; outline:none;
    cursor:pointer; transition:background .15s;
  }
  .slider:hover{background:#353a44}
  .slider:focus{box-shadow:0 0 0 2px rgba(88,166,255,.25)}
  .slider::-webkit-slider-thumb{
    -webkit-appearance:none; appearance:none;
    width:14px; height:14px; border-radius:50%;
    background:#e6e6e6; border:2px solid #1a1d21;
    box-shadow:0 1px 4px rgba(0,0,0,.5);
    cursor:pointer; transition:transform .12s, background .12s, box-shadow .12s;
  }
  .slider::-moz-range-thumb{
    width:14px; height:14px; border-radius:50%;
    background:#e6e6e6; border:2px solid #1a1d21;
    box-shadow:0 1px 4px rgba(0,0,0,.5);
    cursor:pointer; transition:transform .12s;
  }
  .slider::-moz-range-track{height:6px;background:#2c2f35;border-radius:999px}
  .slider:hover::-webkit-slider-thumb{transform:scale(1.12); background:#fff; box-shadow:0 2px 6px rgba(0,0,0,.6)}
  .slider:active::-webkit-slider-thumb{transform:scale(1.22)}
  .slider:hover::-moz-range-thumb{transform:scale(1.12)}
  .slider.sm{width:90px}

  .previewWrap{
    position:relative; flex:1; min-height:180px; max-height:42vh;
    background:#000; padding:0;
    overflow:auto; overscroll-behavior:contain;
    scrollbar-width:thin; scrollbar-color:#30363d #000;
    border-top:1px solid #21252c; border-bottom:1px solid #21252c;
  }
  .previewWrap::-webkit-scrollbar{width:8px;height:8px}
  .previewWrap::-webkit-scrollbar-thumb{background:#30363d;border-radius:999px;border:1px solid #000}
  .previewWrap::-webkit-scrollbar-thumb:hover{background:#3d4451}
  .previewWrap::-webkit-scrollbar-corner{background:#000}
  .previewWrap.converting .artWrap{opacity:.88; transition:opacity .18s}
  .artWrap{display:block; min-width:max-content; min-height:max-content; padding:12px}
  .art{display:inline-block; font:11px/11px "Hack","SF Mono",Menlo,Consolas,monospace; white-space:pre; text-align:left}
  .msg,.err{color:#8b949e;padding:20px;font-size:12px} .err{color:#ff7b72}
  .updatingBadge{position:absolute;top:8px;right:10px;background:rgba(88,166,255,.15);border:1px solid rgba(88,166,255,.3);color:#58a6ff;font-size:10px;padding:3px 7px;border-radius:999px;backdrop-filter:blur(4px);pointer-events:none}
  .raw{border-top:1px solid #21252c;padding:6px 12px;background:#15181c}
  .raw summary{font-size:11px;color:#58a6ff;cursor:pointer}
  .raw textarea{margin-top:6px;width:100%;background:#0e0e0e;color:#8b949e;border:1px solid #2c2f35;border-radius:4px;font:10px/1.3 "Hack",monospace;padding:6px;white-space:pre;overflow:auto}
  footer{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #2c2f35;justify-content:flex-end;flex-wrap:wrap}
  .btn{font-size:12px;padding:5px 12px;border-radius:6px;border:1px solid transparent;cursor:pointer;font-weight:500;transition:background .12s, border-color .12s}
  .btn:disabled{opacity:.5;cursor:default}
  .btn.primary{background:#238636;color:#fff;border-color:#2ea043}
  .btn.primary:hover:not(:disabled){background:#2ea043}
  .btn{background:#21262d;color:#c9d1d9;border-color:#30363d}
  .btn:hover:not(:disabled){background:#30363d}
  .btn.ghost{background:0;color:#8b949e;border-color:transparent}
  .btn.ghost:hover{color:#c9d1d9}
  .hint{margin:0;padding:0 12px 10px;font-size:10px;color:#6e7681;text-align:right}
</style>
