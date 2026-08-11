<script lang="ts">
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import { imageToIrcArt, loadImageFromFile, revokeImageUrl, clearColorLut, estimateLineLengths, DEFAULT_IRC_WIDTH, MIN_IRC_WIDTH, MAX_IRC_WIDTH, type RenderMode, type PixelMode } from '../lib/img2irc';
  import { sendMessage } from '../stores/wsConnection.svelte';
  import { ircState } from '../stores/ircStore.svelte';
  import { generateLabel } from '../lib/utils';

  interface Props { file: File|Blob; filename:string; onClose:()=>void; onBack?:()=>void; }
  let { file, filename, onClose, onBack }: Props = $props();

  let width=$state(DEFAULT_IRC_WIDTH);
  let renderMode=$state<RenderMode>('ansi24');
  let pixelMode=$state<PixelMode>('half');
  let brightness=$state(0), contrast=$state(0), saturation=$state(0), hue=$state(0), gamma=$state(0), blur=$state(0), pixelize=$state(0);
  let grayscale=$state(false), invert=$state(false), sepia=$state(false), normalize=$state(false), dither=$state(false), nograyscale=$state(false), flipH=$state(false), flipV=$state(false);
  let rotate=$state('0');
  let filter=$state('linear');
  let showAdv=$state(false);

  let art=$state(''), htmlPreview=$state(''), loading=$state(true), isConverting=$state(false), error=$state<string|null>(null), copied=$state(false), sending=$state(false), sentCount=$state(0);
  let gen=0;
  let debounce: ReturnType<typeof setTimeout>|null=null;

  function schedule(){
    const my=++gen;
    if(debounce) clearTimeout(debounce);
    // keep converting indicator subtle, don't flash "Converting…"
    if(htmlPreview) isConverting=true;
    debounce=setTimeout(async()=>{
      if(my!==gen) return;
      await convert(my);
    }, 70);
  }
  $effect(()=>{ void width; void renderMode; void pixelMode; void brightness; void contrast; void saturation; void hue; void gamma; void blur; void pixelize; void grayscale; void invert; void sepia; void normalize; void dither; void nograyscale; void flipH; void flipV; void rotate; void filter; schedule(); });
  $effect(()=>{ const c=++gen; void convert(c); return ()=>{gen++; if(debounce) clearTimeout(debounce);}; });

  async function convert(expected=gen){
    const cur=expected;
    if(!htmlPreview) loading=true;
    error=null;
    try{
      const img=await loadImageFromFile(file as File);
      if(cur!==gen){ revokeImageUrl(img); return; }
      try{
        const res=await imageToIrcArt(img, { width, renderMode, pixelMode, filter: filter as any, brightness, contrast, saturation, hue, gamma: gamma||0, blur, pixelize, grayscale, invert, sepia, normalize, dither, nograyscale, flipH, flipV, rotate: Number(rotate) });
        if(cur!==gen) return;
        art=res;
        htmlPreview=res.split('\n').map(l=>`<div class="ircArtLine">${parseIrcFormatting(l)}</div>`).join('');
      } finally { revokeImageUrl(img); }
    } catch(e:any){ if(cur===gen){ error=e?.message??'Failed'; }}
    if(cur===gen){ loading=false; isConverting=false; }
  }

  const stats=$derived(estimateLineLengths(art));
  const activeTarget=$derived(ircState.activeBuffer.bufferName||'');
  const activeNetworkId=$derived(ircState.activeBuffer.networkId||'');

  async function copy(){
    try{ await navigator.clipboard.writeText(art); copied=true; setTimeout(()=>copied=false,1200);}catch{
      const ta=document.getElementById('ircArtRaw') as HTMLTextAreaElement|null; if(ta){ ta.select(); document.execCommand('copy'); copied=true; setTimeout(()=>copied=false,1200);}
    }
  }
  async function send(){
    if(!art||!activeNetworkId||!activeTarget) return;
    sending=true; sentCount=0;
    const lines=art.split('\n');
    const BURST=5, BD=70, SD=220;
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(!line.replace(/[\x03\x04\x0f0-9,a-fA-F ]/g,'').trim() && line.trim()==='') continue;
      sendMessage(activeNetworkId, activeTarget, line, generateLabel());
      sentCount=i+1;
      if(i<lines.length-1) await new Promise(r=>setTimeout(r, i<BURST?BD:SD));
    }
    sending=false; onClose();
  }
  function resetAdv(){ brightness=0; contrast=0; saturation=0; hue=0; gamma=0; blur=0; pixelize=0; grayscale=false; invert=false; sepia=false; normalize=false; dither=false; nograyscale=false; flipH=false; flipV=false; rotate='0'; filter='linear'; }
</script>

<svelte:window onkeydown={handleKey} />

<div class="overlay" role="dialog" aria-modal="true">
  <div class="dialog">
    <header>
      <h2>Convert to IRC <span class="sub">• {filename}</span></h2>
      <button class="x" onclick={onClose} aria-label="Close">×</button>
    </header>

    <div class="bar">
      <label class="ctrl"><span>Width</span><input class="slider" type="range" min={MIN_IRC_WIDTH} max={MAX_IRC_WIDTH} step="2" bind:value={width} /><b class="val">{width}</b></label>
      <label class="ctrl">
        <select bind:value={renderMode} class="sel">
          <option value="ansi24">True color</option>
          <option value="ansi">256 colors</option>
          <option value="irc">IRC 99</option>
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
      <span class="stats" class:warn={!stats.ok}>{#if art}{stats.lines}×{width} • {stats.longest}B{/if}</span>
      {#if isConverting}<span class="pulse" aria-label="Updating">● updating</span>{/if}
    </div>

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
        <div class="row checks">
          <label><input type="checkbox" bind:checked={grayscale}/> Gray</label>
          <label><input type="checkbox" bind:checked={invert}/> Invert</label>
          <label><input type="checkbox" bind:checked={sepia}/> Sepia</label>
          <label><input type="checkbox" bind:checked={normalize}/> Normalize</label>
          <label><input type="checkbox" bind:checked={dither}/> Dither</label>
          <label title="Skip near-gray palette colors for richer color (--nograyscale)"><input type="checkbox" bind:checked={nograyscale}/> <span class="t">NoGray</span></label>
          <label><input type="checkbox" bind:checked={flipH}/> Flip H</label>
          <label><input type="checkbox" bind:checked={flipV}/> Flip V</label>
          <label>Filter <select bind:value={filter} class="sel sm"><option value="linear">Linear</option><option value="nearest">Nearest</option></select></label>
          <button class="link" onclick={resetAdv}>Reset</button>
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
  .stats{font-size:10px;color:#8b949e;margin-left:auto}
  .stats.warn{color:#f0883e}
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
