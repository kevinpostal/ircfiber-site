/**
 * img2irc — JS port of https://github.com/waveplate/img2irc v1.3.1
 * Reference: palette.rs IRC99/ANSI256, draw.rs render_blocks/braille/emit_colourized.
 *
 * 2026-08-11 Aristotle study optimizations (STUDY.md / study_improvements.py):
 *  - Coloured ' ' (1B) for solid runs r>=2: -21.7% / -34% pixel-identical (study §1)
 *  - Foreground-only \x03 f (leaves bg): -1-3% alone, -24% combined (§2)
 *  - Shade blocks ░▒▓ + measured ASCII ramp ' =QB*gF' in Viterbi (§3, glyph_coverage.txt)
 *  - Shared row palette (S=12, S²=144 states) + collapsed O(M·K) ViterbiDP (§3,5)
 *  - OKLab Euclidean (§5) — 3.9× faster matcher, enables O(M²) seg DP; scaled ×85000 vs Lab
 *  - Midgard Colors selector (truecolor/xterm256/16/smart) — render-core.js palettes
 *  - Bilateral pre-filter available via comic flag (r2 σ40 ×2, spec §6) but not exposed in UI
 *  Viterbi objective: Σ[ err(glyph,f,b) + w·glyphBytes ] + w·prefixBytes (w≈2.5 knee)
 */
import { getWasm, hasWasmSync, getWasmSync, preloadWasm, tryWasmBatchBestGlyphSync, tryWasmBatchRowPaletteSync, tryWasmBatchNearestSync } from './img2irc.wasm';
if (typeof window !== 'undefined') try { preloadWasm(); } catch {}
const _perf = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
const _shouldLog = () => typeof window !== 'undefined' && ( (window as any).__IMG2IRC_PERF || localStorage.getItem('img2irc:perf') || location.search.includes('perf=1') );
// dev-only WASM hit counters — exposed via window.__IMG2IRC_WASM_STATS when img2irc:wasmStats set
let _wasmHits = 0, _wasmMisses = 0;
if (typeof window !== 'undefined') {
  try { (window as unknown as Record<string, unknown>).__IMG2IRC_WASM_STATS = () => ({ hits: _wasmHits, misses: _wasmMisses, hitRate: _wasmHits/ Math.max(1,_wasmHits+_wasmMisses) }); } catch {}
}
export const IRC99: number[] = [
  0xffffff, 0x000000, 0x00007f, 0x009300, 0xff0000, 0x7f0000, 0x9c009c, 0xfc7f00,
  0xffff00, 0x00fc00, 0x009393, 0x00ffff, 0x0000fc, 0xff00ff, 0x555555, 0xaaaaaa,
  0x470000, 0x472100, 0x474700, 0x324700, 0x004700, 0x00472c, 0x004747, 0x002747,
  0x000047, 0x2e0047, 0x470047, 0x47002a, 0x740000, 0x743a00, 0x747400, 0x517400,
  0x007400, 0x007449, 0x007474, 0x004074, 0x000074, 0x4b0074, 0x740074, 0x740045,
  0xb50000, 0xb56300, 0xb5b500, 0x7db500, 0x00b500, 0x00b571, 0x00b5b5, 0x0063b5,
  0x0000b5, 0x7500b5, 0xb500b5, 0xb5006b, 0xff0000, 0xff8c00, 0xffff00, 0xb2ff00,
  0x00ff00, 0x00ffa0, 0x00ffff, 0x008cff, 0x0000ff, 0xa500ff, 0xff00ff, 0xff0098,
  0xff5959, 0xffb459, 0xffff71, 0xcfff60, 0x6fff6f, 0x65ffc9, 0x6dffff, 0x59b4ff,
  0x5959ff, 0xc459ff, 0xff66ff, 0xff59bc, 0xff9c9c, 0xffd39c, 0xffff9c, 0xe2ff9c,
  0x9cff9c, 0x9cffdb, 0x9cffff, 0x9cd3ff, 0x9c9cff, 0xdc9cff, 0xff9cff, 0xff94d3,
  0x000000, 0x131313, 0x282828, 0x363636, 0x4d4d4d, 0x656565, 0x818181, 0x9f9f9f,
  0xbcbcbc, 0xe2e2e2, 0xffffff,
];
export const ANSI256: number[] = [
  0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
  0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
  0x000000, 0x00005f, 0x000087, 0x0000af, 0x0000d7, 0x0000ff, 0x005f00, 0x005f5f,
  0x005f87, 0x005faf, 0x005fd7, 0x005fff, 0x008700, 0x00875f, 0x008787, 0x0087af,
  0x0087d7, 0x0087ff, 0x00af00, 0x00af5f, 0x00af87, 0x00afaf, 0x00afd7, 0x00afff,
  0x00d700, 0x00d75f, 0x00d787, 0x00d7af, 0x00d7d7, 0x00d7ff, 0x00ff00, 0x00ff5f,
  0x00ff87, 0x00ffaf, 0x00ffd7, 0x00ffff, 0x5f0000, 0x5f005f, 0x5f0087, 0x5f00af,
  0x5f00d7, 0x5f00ff, 0x5f5f00, 0x5f5f5f, 0x5f5f87, 0x5f5faf, 0x5f5fd7, 0x5f5fff,
  0x5f8700, 0x5f875f, 0x5f8787, 0x5f87af, 0x5f87d7, 0x5f87ff, 0x5faf00, 0x5faf5f,
  0x5faf87, 0x5fafaf, 0x5fafd7, 0x5fafff, 0x5fd700, 0x5fd75f, 0x5fd787, 0x5fd7af,
  0x5fd7d7, 0x5fd7ff, 0x5fff00, 0x5fff5f, 0x5fff87, 0x5fffaf, 0x5fffd7, 0x5fffff,
  0x870000, 0x87005f, 0x870087, 0x8700af, 0x8700d7, 0x8700ff, 0x875f00, 0x875f5f,
  0x875f87, 0x875faf, 0x875fd7, 0x875fff, 0x878700, 0x87875f, 0x878787, 0x8787af,
  0x8787d7, 0x8787ff, 0x87af00, 0x87af5f, 0x87af87, 0x87afaf, 0x87afd7, 0x87afff,
  0x87d700, 0x87d75f, 0x87d787, 0x87d7af, 0x87d7d7, 0x87d7ff, 0x87ff00, 0x87ff5f,
  0x87ff87, 0x87ffaf, 0x87ffd7, 0x87ffff, 0xaf0000, 0xaf005f, 0xaf0087, 0xaf00af,
  0xaf00d7, 0xaf00ff, 0xaf5f00, 0xaf5f5f, 0xaf5f87, 0xaf5faf, 0xaf5fd7, 0xaf5fff,
  0xaf8700, 0xaf875f, 0xaf8787, 0xaf87af, 0xaf87d7, 0xaf87ff, 0xafaf00, 0xafaf5f,
  0xafaf87, 0xafafaf, 0xafafd7, 0xafafff, 0xafd700, 0xafd75f, 0xafd787, 0xafd7af,
  0xafd7d7, 0xafd7ff, 0xafff00, 0xafff5f, 0xafff87, 0xafffaf, 0xafffd7, 0xafffff,
  0xd70000, 0xd7005f, 0xd70087, 0xd700af, 0xd700d7, 0xd700ff, 0xd75f00, 0xd75f5f,
  0xd75f87, 0xd75faf, 0xd75fd7, 0xd75fff, 0xd78700, 0xd7875f, 0xd78787, 0xd787af,
  0xd787d7, 0xd787ff, 0xd7af00, 0xd7af5f, 0xd7af87, 0xd7afaf, 0xd7afd7, 0xd7afff,
  0xd7d700, 0xd7d75f, 0xd7d787, 0xd7d7af, 0xd7d7d7, 0xd7d7ff, 0xd7ff00, 0xd7ff5f,
  0xd7ff87, 0xd7ffaf, 0xd7ffd7, 0xd7ffff, 0xff0000, 0xff005f, 0xff0087, 0xff00af,
  0xff00d7, 0xff00ff, 0xff5f00, 0xff5f5f, 0xff5f87, 0xff5faf, 0xff5fd7, 0xff5fff,
  0xff8700, 0xff875f, 0xff8787, 0xff87af, 0xff87d7, 0xff87ff, 0xffaf00, 0xffaf5f,
  0xffaf87, 0xffafaf, 0xffafd7, 0xffafff, 0xffd700, 0xffd75f, 0xffd787, 0xffd7af,
  0xffd7d7, 0xffd7ff, 0xffff00, 0xffff5f, 0xffff87, 0xffffaf, 0xffffd7, 0xffffff,
  0x080808, 0x121212, 0x1c1c1c, 0x262626, 0x303030, 0x3a3a3a, 0x444444, 0x4e4e4e,
  0x585858, 0x626262, 0x6c6c6c, 0x767676, 0x808080, 0x8a8a8a, 0x949494, 0x9e9e9e,
  0xa8a8a8, 0xb2b2b2, 0xbcbcbc, 0xc6c6c6, 0xd0d0d0, 0xdadada, 0xe4e4e4, 0xeeeeee,
];
export const ANSI16: number[] = [
  0x000000, 0xaa0000, 0x00aa00, 0xaa5500,
  0x0000aa, 0xaa00aa, 0x00aaaa, 0xaaaaaa,
  0x555555, 0xff5555, 0x55ff55, 0xffff55,
  0x5555ff, 0xff55ff, 0x55ffff, 0xffffff,
];
/** mIRC 16 — first 16 of IRC99, what IRC clients actually display for \x0300-\x0315 */
export const IRC16: number[] = IRC99.slice(0, 16);
export const XTERM256: number[] = (()=>{ const pal:number[]=[]; const ANSI_16=[[0,0,0],[170,0,0],[0,170,0],[170,85,0],[0,0,170],[170,0,170],[0,170,170],[170,170,170],[85,85,85],[255,85,85],[85,255,85],[255,255,85],[85,85,255],[255,85,255],[85,255,255],[255,255,255]]; for(const c of ANSI_16) pal.push((c[0]<<16)|(c[1]<<8)|c[2]); const levels=[0,95,135,175,215,255]; for(let r=0;r<6;r++) for(let g=0;g<6;g++) for(let b=0;b<6;b++) pal.push((levels[r]<<16)|(levels[g]<<8)|levels[b]); for(let i=0;i<24;i++){const v=8+i*10; pal.push((v<<16)|(v<<8)|v);} return pal; })();
export type RenderMode = 'irc' | 'ansi' | 'ansi24';
export type PixelMode = 'half' | 'full' | 'quarter' | 'braille';
export type SamplingFilter = 'nearest' | 'linear';
export type DitherMode = 'none' | 'bayer4' | 'bayer8' | 'floyd' | 'atkinson' | 'sierra' | 'stucki' | 'jarvis';
export type ColorMatching = 'rgb' | 'lab' | 'oklab';
export type MidgardColorMode = 'truecolor' | 'xterm256' | '16' | 'smart';

export interface Img2IrcOptions {
  width: number; height?: number;
  renderMode: RenderMode; pixelMode: PixelMode; filter: SamplingFilter;
  brightness:number; contrast:number; gamma:number; saturation:number; hue:number;
  invert:boolean; grayscale:boolean; sepia:boolean; normalize:boolean; dither:boolean;
  ditherMode: DitherMode;
  colorMatching: ColorMatching;
  flipH:boolean; flipV:boolean; rotate:number; pixelize:number; blur:number;
  nograyscale:boolean;
  /** Viterbi byte weight w (0=off, 2-4=Aristotle knee, 57-59% saving). 0 disables. */
  viterbiW: number;
  /** Comic / bilateral pre-filter — edge-preserving smoother that lengthens colour runs (spec §6) */
  comic: boolean;
  /** Midgard Colors selector — maps to palette/renderMode/comic as per https://midgardmud.de/tools/ans/ */
  midgardMode?: MidgardColorMode;
  // Transparency — from midgardmud.de smart partial-block edges
  alphaMode: 'opaque' | 'transparent';
  alphaThreshold: number; // 0-255
  trimTransparent: boolean;
  smartEdges: boolean;
  background: string; // hex or 'transparent'
  _smartPaletteA?: number[];
  _smartPaletteB?: number[];
  /** debug only, not serialized — canvas resize ms from caller */
  _debugResizeMs?: number;
}

export function getMidgardPalette(o: Img2IrcOptions): number[] {
  if(o.midgardMode==='smart'){
    if(o.renderMode==='irc' || o.renderMode==='ansi') return IRC99;
    return (o as any)._smartPaletteA || IRC99;
  }
  if((o.midgardMode as string)==='vga256') return XTERM256; // removed DOS/VGA palette — fallback to xterm256
  if((o.midgardMode as string)==='retro') return ANSI16; // legacy: retro removed from UI, maps to 16 for compat
  if(o.midgardMode==='xterm256') return XTERM256;
  if(o.midgardMode==='16') return IRC16; // mIRC 16 — exact IRC display colors, not ANSI CGA
  if((o.midgardMode as string)==='comic') return IRC99; // legacy: comic removed from UI
  if(o.renderMode==='ansi') return ANSI256;
  return IRC99;
}

export const DEFAULT_IRC_WIDTH = 60;
export const MIN_IRC_WIDTH = 10;
export const MAX_IRC_WIDTH = 120;
/** RFC 2812 hard limit 512 incl. prefix+CRLF — soft, many bouncers/servers allow more. */
export const IRC_HARD_LIMIT = 512;
/** Safe payload that fits everywhere — leaves ~112 for PRIVMSG prefix/tags. Soft limit. */
export const IRC_SAFE_PAYLOAD = 400;
const DEFAULTS: Img2ircOptions = {
  width: 60, renderMode: 'ansi', pixelMode: 'half', filter: 'linear',
  brightness: 0, contrast: 0, gamma: 0, saturation: 0, hue: 0,
  invert: false, grayscale: false, sepia: false, normalize: false, dither: false,
  ditherMode: 'none', colorMatching: 'oklab',
  flipH: false, flipV: false, rotate: 0, pixelize: 0, blur: 0, nograyscale: false, viterbiW: 0, comic: false,
  midgardMode: 'xterm256',
  alphaMode: 'opaque', alphaThreshold: 128, trimTransparent: false, smartEdges: true, background: '#000000',
};

// ── Utility ───────────────────────────────────────────────────────────────────
const _pack=(r:number,g:number,b:number)=>((r&255)<<16)|((g&255)<<8)|(b&255);
const _unpack=(rgb:number)=>[(rgb>>16)&255,(rgb>>8)&255,(rgb>>0)&255];
const _isNearGray=(rgb:number,tol=16)=>{const[r,g,b]=_unpack(rgb);return Math.max(r,g,b)-Math.min(r,g,b)<=tol;};
const _nearBlack=(r:number,g:number,b:number)=>r<10&&g<10&&b<10;
const toHex6=(r:number,g:number,b:number)=>r.toString(16).padStart(2,'0')+g.toString(16).padStart(2,'0')+b.toString(16).padStart(2,'0');
const luma=(r:number,g:number,b:number)=>0.299*r+0.587*g+0.114*b;
const codeLen=(n:number)=>n<10?1:2;

// ── Color science ─────────────────────────────────────────────────────────────
// OKLAB — perceptual uniform from midgardmud.de (Björn Ottosson 2020)
function srgbToOkLab(r:number,g:number,b:number){
  const ws = hasWasmSync() ? (getWasmSync() as unknown as Record<string,unknown>) : null;
  if (ws && typeof ws['srgb_to_oklab'] === 'function') {
    try {
      const v = (ws['srgb_to_oklab'] as (r:number,g:number,b:number)=>Float32Array)(r,g,b);
      return [v[0], v[1], v[2]];
    } catch {}
  }
  let R=r/255, G=g/255, B=b/255;
  R = R<=0.04045? R/12.92 : Math.pow((R+0.055)/1.055,2.4);
  G = G<=0.04045? G/12.92 : Math.pow((G+0.055)/1.055,2.4);
  B = B<=0.04045? B/12.92 : Math.pow((B+0.055)/1.055,2.4);
  const l = 0.4122214708*R + 0.5363325363*G + 0.0514459929*B;
  const m = 0.2119034982*R + 0.6806995451*G + 0.1073969566*B;
  const s = 0.0883024619*R + 0.2817188376*G + 0.6299787005*B;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [0.2104542553*l_ + 0.7936177850*m_ -0.0040720468*s_, 1.9779984951*l_ -2.4285922050*m_ +0.4505937099*s_, 0.0259040371*l_ +0.7827717662*m_ -0.8086757660*s_];
}
function oklabDeltaE2(a:number[], b:number[]){const dL=a[0]-b[0], da=a[1]-b[1], db=a[2]-b[2]; return dL*dL+da*da+db*db; }
// Lab (CIE L*a*b*, D65) for the 'lab' matcher
function srgbToLab(r:number,g:number,b:number){
  let Rs=r/255, Gs=g/255, Bs=b/255;
  Rs = Rs<=0.04045? Rs/12.92 : Math.pow((Rs+0.055)/1.055,2.4);
  Gs = Gs<=0.04045? Gs/12.92 : Math.pow((Gs+0.055)/1.055,2.4);
  Bs = Bs<=0.04045? Bs/12.92 : Math.pow((Bs+0.055)/1.055,2.4);
  const X=Rs*0.4124+Gs*0.3576+Bs*0.1805, Y=Rs*0.2126+Gs*0.7152+Bs*0.0722, Z=Rs*0.0193+Gs*0.1192+Bs*0.9505;
  const xn=0.95047, yn=1.0, zn=1.08883;
  const fx=X/xn>0.008856? Math.pow(X/xn,1/3) : 7.787*X/xn+16/116;
  const fy=Y/yn>0.008856? Math.pow(Y/yn,1/3) : 7.787*Y/yn+16/116;
  const fz=Z/zn>0.008856? Math.pow(Z/zn,1/3) : 7.787*Z/zn+16/116;
  return [116*fy-16, 500*(fx-fy), 200*(fy-fz)];
}
function deltaE2(lab1:number[], lab2:number[]){const dL=lab1[0]-lab2[0], da=lab1[1]-lab2[1], db=lab1[2]-lab2[2]; return dL*dL+da*da+db*db;}
function colorDist2(r1:number,g1:number,b1:number, r2:number,g2:number,b2:number, mode:ColorMatching){
  if(mode==='oklab'){ const a=srgbToOkLab(r1,g1,b1), b2v=srgbToOkLab(r2,g2,b2); return oklabDeltaE2(a,b2v) * 85000; }
  if(mode==='lab'){ const a=srgbToLab(r1,g1,b1), b2v=srgbToLab(r2,g2,b2); return deltaE2(a,b2v); }
  const dr=r1-r2,dg=g1-g2,db=b1-b2; return dr*dr+dg*dg+db*db;
}

function nearestIndex(r:number,g:number,b:number,pal:number[], mode:ColorMatching='rgb'):number{
  const ws = hasWasmSync() ? (getWasmSync() as unknown as Record<string,unknown>) : null;
  if (ws && typeof ws['nearest_index'] === 'function') {
    try {
      let u32: Uint32Array | undefined = _palU32Weak.get(pal);
      if (!u32) { u32 = new Uint32Array(pal); _palU32Weak.set(pal, u32); }
      const idx = (ws['nearest_index'] as (r:number,g:number,b:number,p:Uint32Array,m:string)=>number)(r,g,b, u32, mode);
      if (typeof idx === 'number' && idx >= 0 && idx < pal.length) { _wasmHits++; return idx; }
    } catch { _wasmMisses++; }
  } else if (ws) { _wasmMisses++; }
  let best=0,bestD=1e12;
  for(let i=0;i<pal.length;i++){const c=pal[i],cr=(c>>16)&255,cg=(c>>8)&255,cb=c&255, d=colorDist2(r,g,b, cr,cg,cb, mode); if(d<bestD){bestD=d;best=i;if(d===0)break;}}
  return best;
}
const _palU32Weak = new WeakMap<number[], Uint32Array>();

// ── Color LUT + nograyscale ───────────────────────────────────────────────────
const COLOR_LUT=new Map<string,{irc:number,ansi:number,ircNg:number,ansiNg:number}>();
export function lutLookup(r:number,g:number,b:number,pal:number[],ng:boolean, mode:ColorMatching='rgb'){
  const palId = pal===XTERM256 ? 'xterm' : pal===ANSI256 ? 'ansi' : pal===IRC99 ? 'irc99' : pal===ANSI16 ? 'ansi16' : `len${pal.length}`;
  const k=`${r},${g},${b},${palId},${mode},${ng}`; let e=COLOR_LUT.get(k);
  if(!e){
    const ansi=nearestIndex(r,g,b,pal, mode)&255, irc=Math.min(nearestIndex(r,g,b,IRC99, mode),98);
    let ansiNg=ansi, ircNg=irc;
    if(!_isNearGray(_pack(r,g,b))){
      let bd=1e12; for(let i=0;i<pal.length;i++){if(_isNearGray(pal[i]))continue;const c=pal[i],cr=(c>>16)&255,cg=(c>>8)&255,cb=c&255, d=colorDist2(r,g,b, cr,cg,cb, mode); if(d<bd){bd=d;ansiNg=i;if(d===0)break;}}
      bd=1e12; for(let i=0;i<IRC99.length;i++){if(_isNearGray(IRC99[i]))continue;const c=IRC99[i],cr=(c>>16)&255,cg=(c>>8)&255,cb=c&255, d=colorDist2(r,g,b, cr,cg,cb, mode); if(d<bd){bd=d;ircNg=Math.min(i,98);if(d===0)break;}}
    }
    e={ansi,irc,ansiNg,ircNg}; COLOR_LUT.set(k,e);
  }
  return ng?{ansi:e.ansiNg,irc:e.ircNg}:{ansi:e.ansi,irc:e.irc};
}
export function clearColorLut(){COLOR_LUT.clear();}
const _palOkLabCache = new Map<string, number[][]>();
const _palOkLabWeak = new WeakMap<number[], number[][]>();
function getPalOkLab(pal: number[]): number[][] {
  const isKnown = pal===XTERM256 || pal===ANSI256 || pal===IRC99 || pal===ANSI16;
  if(!isKnown){ const w=_palOkLabWeak.get(pal); if(w) return w; const arr2: number[][] = pal.map(c => { const v = srgbToOkLab((c>>16)&255,(c>>8)&255,c&255); return v; }); _palOkLabWeak.set(pal, arr2); return arr2; }
  const key = pal===XTERM256 ? 'xterm' : pal===ANSI256 ? 'ansi' : pal===IRC99 ? 'irc99' : 'ansi16';
  let arr = _palOkLabCache.get(key);
  if (!arr) {
    arr = pal.map(c => { const v = srgbToOkLab((c>>16)&255,(c>>8)&255,c&255); return v; });
    if (_palOkLabCache.size > 4) _palOkLabCache.clear();
    _palOkLabCache.set(key, arr);
  }
  return arr;
}
const _palToIrcCache = new Map<string, Uint8Array>();
const _palToIrcWeak = new WeakMap<number[], Map<string, Uint8Array>>();
function getPalToIrc(pal: number[], mode: ColorMatching): Uint8Array {
  const isKnown2 = pal===XTERM256 || pal===ANSI256 || pal===IRC99 || pal===ANSI16;
  if(!isKnown2){ let byMode=_palToIrcWeak.get(pal); if(!byMode){ byMode=new Map(); _palToIrcWeak.set(pal, byMode); } let a2=byMode.get(mode); if(a2) return a2; const arrW=new Uint8Array(pal.length); for(let i=0;i<pal.length;i++) arrW[i]=ansiToIrcIdx(i,pal,mode); byMode.set(mode, arrW); return arrW; }
  const key = (pal===XTERM256 ? 'xterm' : pal===ANSI256 ? 'ansi' : pal===IRC99 ? 'irc99' : 'ansi16') + ':' + mode;
  let arr = _palToIrcCache.get(key);
  if (!arr) {
    arr = new Uint8Array(pal.length);
    for(let i=0;i<pal.length;i++) arr[i] = ansiToIrcIdx(i, pal, mode);
    if (_palToIrcCache.size > 8) _palToIrcCache.clear();
    _palToIrcCache.set(key, arr);
  }
  return arr;
}
// For IRC, \x03 only supports 0-98. ANSI 256 indices 99-255 must be remapped to nearest 99.
export function ansiToIrcIdx(ansiIdx:number, srcPal:number[]=ANSI256, colorMode:ColorMatching='rgb'):number{
  const c=srcPal[ansiIdx & 255], r=(c>>16)&255,g=(c>>8)&255,b=c&255;
  return Math.min(nearestIndex(r,g,b,IRC99,colorMode),98);
}
export function toEmitIdx(idx:number, mode:RenderMode, srcPal:number[]=ANSI256, colorMode:ColorMatching='rgb'):number{
  return mode==='ansi' ? ansiToIrcIdx(idx, srcPal, colorMode) : Math.min(idx,98);
}

// ── Smart palettes ──────────────────────────────────────────────────────────
// Palette A: OKLab k-means K=24 (truecolor \x04). Palette B: mIRC-99 subset K≈16 (\x03).
// Both derived once per image; deterministic (seeded) so slider drags are stable.

export function smartPaletteA(d: Uint8ClampedArray, pW:number, pH:number, K=24): number[] {
  const pts: number[][] = [];
  for(let y=0;y<pH;y++) for(let x=0;x<pW;x++){
    const i=(y*pW+x)*4;
    if(d[i+3] < 128) continue;
    pts.push([d[i], d[i+1], d[i+2]]);
  }
  if(pts.length===0) return [0];
  // cap K at distinct colours so centroids don't collapse
  const seen = new Set<string>();
  for(const c of pts) seen.add(c[0]+','+c[1]+','+c[2]);
  const Kc = Math.min(K, seen.size, pts.length);
  const oklab: number[][] = pts.map(c=> srgbToOkLab(c[0],c[1],c[2]) as any);
  // deterministic PRNG (xorshift32 seeded from content hash)
  let seed = 0x9e3779b9 ^ (pts.length * 2654435761) >>> 0;
  for(let i=0;i<Math.min(pts.length, 16); i++) seed ^= (pts[i][0]*374761393 + pts[i][1]*668265263 + pts[i][2]*1274126177) >>> 0;
  const rnd = ()=>{ seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed>>>0)/4294967296; };
  const cents: number[][] = [];
  cents.push([...oklab[Math.floor(rnd()*oklab.length)]]);
  const dist2 = new Float64Array(oklab.length).fill(Infinity);
  while(cents.length < Kc){
    let sum=0;
    const last = cents[cents.length-1];
    for(let i=0;i<oklab.length;i++){
      const dl=oklab[i][0]-last[0], da=oklab[i][1]-last[1], db=oklab[i][2]-last[2];
      const d2=dl*dl+da*da+db*db;
      if(d2 < dist2[i]) dist2[i]=d2;
      sum+=dist2[i];
    }
    if(sum===0) break;
    let r = rnd()*sum;
    let pick = oklab.length-1;
    for(let i=0;i<oklab.length;i++){ r-=dist2[i]; if(r<=0){ pick=i; break; } }
    cents.push([...oklab[pick]]);
  }
  for(let iter=0; iter<20; iter++){
    const sums = cents.map(()=>[0,0,0]);
    const counts = new Array(cents.length).fill(0);
    for(let i=0;i<oklab.length;i++){
      let bi=0, bd=Infinity;
      for(let c=0;c<cents.length;c++){ const dl=oklab[i][0]-cents[c][0], da=oklab[i][1]-cents[c][1], db=oklab[i][2]-cents[c][2]; const d2=dl*dl+da*da+db*db; if(d2<bd){bd=d2; bi=c;} }
      sums[bi][0]+=oklab[i][0]; sums[bi][1]+=oklab[i][1]; sums[bi][2]+=oklab[i][2]; counts[bi]++;
    }
    for(let c=0;c<cents.length;c++) if(counts[c]>0){ cents[c][0]=sums[c][0]/counts[c]; cents[c][1]=sums[c][1]/counts[c]; cents[c][2]=sums[c][2]/counts[c]; }
  }
  return cents.map(c=>{ const [r,g,b]=oklabToSrgb(c[0],c[1],c[2]); return (r<<16)|(g<<8)|b; });
}

export function smartPaletteB(d: Uint8ClampedArray, pW:number, pH:number, K=16, lambda=0.02, mode:ColorMatching='oklab'): number[] {
  const freq = new Map<number, number>();
  for(let y=0;y<pH;y++) for(let x=0;x<pW;x++){
    const i=(y*pW+x)*4;
    if(d[i+3] < 128) continue;
    for(const idx of kNearest(d[i], d[i+1], d[i+2], IRC99, 2, false, mode)) freq.set(idx, (freq.get(idx)||0)+1);
  }
  if(freq.size===0) return [0,1,7].slice(0, Math.min(K,3));
  const scored = [...freq.entries()].map(([idx,f])=>({idx,f,score: f / (1 + lambda*codeLen(idx))}));
  scored.sort((a,b)=> b.score-a.score || b.f-a.f || a.idx-b.idx);
  return scored.slice(0, Math.min(K, scored.length)).map(s=>s.idx);
}

export function kNearest(r:number,g:number,b:number,pal:number[],k:number,ng:boolean, mode:ColorMatching='rgb'):number[]{
  const cand:Array<{i:number,d:number}>=[];
  const isGray=_isNearGray(_pack(r,g,b));
  for(let i=0;i<pal.length;i++){
    if(ng && !isGray && _isNearGray(pal[i])) continue;
    const c=pal[i],cr=(c>>16)&255,cg=(c>>8)&255,cb=c&255, d=colorDist2(r,g,b, cr,cg,cb, mode);
    cand.push({i,d});
  }
  cand.sort((a,b)=>a.d-b.d);
  if(cand.length < k && ng && !isGray){
    for(let i=0;i<pal.length;i++){
      if(cand.some(c=>c.i===i)) continue;
      const c=pal[i],cr=(c>>16)&255,cg=(c>>8)&255,cb=c&255, d=colorDist2(r,g,b, cr,cg,cb, mode);
      cand.push({i,d});
    }
    cand.sort((a,b)=>a.d-b.d);
  }
  return cand.slice(0,k).map(c=>c.i);
}

// ── Wire model helpers ────────────────────────────────────────────────────────
function pairPref(f:number,b:number){ return 2+codeLen(f)+codeLen(b); }
function fgPref(f:number){ return 1+codeLen(f); }
function blendRgb(f:number,b:number,r:number,pal:number[]){
  const cf=pal[f], cb=pal[b];
  const r1=(cf>>16)&255, g1=(cf>>8)&255, b1=cf&255;
  const r2=(cb>>16)&255, g2=(cb>>8)&255, b2=cb&255;
  return [Math.round(r1*r + r2*(1-r)), Math.round(g1*r + g2*(1-r)), Math.round(b1*r + b2*(1-r))];
}
/** OKLab-correct blend: blend in OKLab space then convert back via linear sRGB. */
function oklabToSrgb(L:number,a:number,b:number):[number,number,number]{
  const l_ = L + 0.3963377774*a + 0.2158037573*b;
  const m_ = L - 0.1055613458*a - 0.0638541728*b;
  const s_ = L - 0.0894841775*a - 1.2914855480*b;
  const l = l_*l_*l_, m = m_*m_*m_, s = s_*s_*s_;
  let R =  4.0767416621*l - 3.3077115913*m + 0.2309699292*s;
  let G = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s;
  let B = -0.0041960863*l - 0.7034186147*m + 1.7076147010*s;
  const toSrgb = (c:number)=> c<=0.0031308 ? 12.92*c : 1.055*Math.pow(c,1/2.4)-0.055;
  return [Math.max(0,Math.min(255, Math.round(toSrgb(R)*255))), Math.max(0,Math.min(255, Math.round(toSrgb(G)*255))), Math.max(0,Math.min(255, Math.round(toSrgb(B)*255)))];
}
// Glyphs — measured ink coverage of DejaVu Sans Mono (reference/glyph_coverage.txt)
// A glyph of coverage c shows blend c*fg + (1-c)*bg; swapped needs no entry: ordered (fg,bg) state already realises 1-c.
// The 1-byte shade ramp covers 0.273 max: 55% of blend range [0,0.273]U[0.727,1], mid gap needs 3-byte block (optimal 0.4243, measured ▒ 0.494)
// Aristotle GlyphCoverage.lean: optimal_block_coverage r*=(1+cmax)/3≈0.4243, band error (1-2·cmax)/6=0.07567 vs 0.11075 for ▒ (−32%); no DejaVu block measures near r* — closest available is ▒ at 0.490/0.499, so DP uses measured value (known gap: +46% over optimum, see measured_optimal_block)
const GLYPHS: Array<{ch:string, ct:number, cb:number, bytes:number}> = [
  // 1-byte: coloured space + ASCII ramp (safe after \x03 — no digit/comma, no leading '/' )
  {ch:' ', ct:0.0,   cb:0.0,   bytes:1}, // 0.000
  {ch:'=', ct:0.122, cb:0.120, bytes:1}, // 0.121
  {ch:'Q', ct:0.247, cb:0.261, bytes:1}, // 0.254
  {ch:'B', ct:0.294, cb:0.253, bytes:1}, // 0.273 densest safe (0/8 are unsafe digits)
  {ch:'*', ct:0.183, cb:0.010, bytes:1}, // light ▀  (top-bottom +0.173)
  {ch:'g', ct:0.149, cb:0.321, bytes:1}, // light ▄  (top-bottom -0.172)
  {ch:'F', ct:0.245, cb:0.107, bytes:1}, // light ▀ variant
  // 3-byte block elements
  {ch:'▀', ct:1.0,   cb:0.0,   bytes:3}, // half top=fg bottom=bg
  {ch:'▄', ct:0.0,   cb:1.0,   bytes:3}, // complement
  {ch:'▒', ct:0.490, cb:0.499, bytes:3}, // measured DejaVu 0.490/0.499 (avg 0.4945); optimum r*=0.4243 would be 32% lower band error (0.07567 vs 0.11075) per GlyphCoverage.lean but no glyph measures there — known suboptimal gap, closest Unicode to r* is ▒
  // dominated but kept — Viterbi never picks over 1-byte/▀▄ at same ΔE (up to contrast ≈41 per GlyphCoverage.lean)
  {ch:'░', ct:0.183, cb:0.181, bytes:3},
  {ch:'▓', ct:0.796, cb:0.816, bytes:3},
  {ch:'█', ct:1.0,   cb:1.0,   bytes:3}, // never best vs ' ' (same error, 3B vs 1B) — kept to prove dominated
];
const GLYPH_BYTES_HALF=3, GLYPH_BYTES_SPACE=1;
export function bestGlyphForState(
  r1:number,g1:number,b1:number, r2:number,g2:number,b2:number,
  f:number,b:number, pal:number[], mode:ColorMatching, w:number, palOkLab?: number[][] | null
):{err:number, bytes:number, glyph:string}{
  // WASM fast path — pick best glyph index via wasm (8× fewer cbrt), then compute err/bytes from GLYPHS table
  const ws = hasWasmSync() ? (getWasmSync() as unknown as Record<string,unknown>) : null;
  if (ws && typeof ws['best_glyph_for_state'] === 'function') {
    try {
      const fRgb=(pal[f]>>16)&255, fG2=(pal[f]>>8)&255, fB2=pal[f]&255;
      const bRgb=(pal[b]>>16)&255, bG2=(pal[b]>>8)&255, bB2=pal[b]&255;
      const idx = (ws['best_glyph_for_state'] as (r1:number,g1:number,b1:number,r2:number,g2:number,b2:number,fr:number,fg:number,fb:number,br:number,bg:number,bb:number,m:string,w:number)=>number)(r1,g1,b1,r2,g2,b2,fRgb,fG2,fB2,bRgb,bG2,bB2,mode,w);
      if (typeof idx === 'number' && idx >=0 && idx < GLYPHS.length) {
        _wasmHits++;
        const g = GLYPHS[idx];
        let tR:number,tG:number,tB:number, boR:number,boG:number,boB:number;
        if(mode==='oklab'){
          let fOk: number[]|null=null, bOk: number[]|null=null;
          if (palOkLab && f < pal.length && b < pal.length) { fOk=palOkLab[f]; bOk=palOkLab[b]; }
          else {
            const fOk2 = srgbToOkLab(fRgb,fG2,fB2); const bOk2 = srgbToOkLab(bRgb,bG2,bB2);
            fOk=fOk2; bOk=bOk2;
          }
          if (fOk && bOk) {
            const Lt=fOk[0]*g.ct + bOk[0]*(1-g.ct), At=fOk[1]*g.ct + bOk[1]*(1-g.ct), Bt=fOk[2]*g.ct + bOk[2]*(1-g.ct);
            const Lb=fOk[0]*g.cb + bOk[0]*(1-g.cb), Ab=fOk[1]*g.cb + bOk[1]*(1-g.cb), Bb=fOk[2]*g.cb + bOk[2]*(1-g.cb);
            [tR,tG,tB]=oklabToSrgb(Lt,At,Bt); [boR,boG,boB]=oklabToSrgb(Lb,Ab,Bb);
          } else {
            tR=Math.round(fRgb*g.ct + bRgb*(1-g.ct)); tG=Math.round(fG2*g.ct + bG2*(1-g.ct)); tB=Math.round(fB2*g.ct + bB2*(1-g.ct));
            boR=Math.round(fRgb*g.cb + bRgb*(1-g.cb)); boG=Math.round(fG2*g.cb + bG2*(1-g.cb)); boB=Math.round(fB2*g.cb + bB2*(1-g.cb));
          }
        } else {
          tR=Math.round(fRgb*g.ct + bRgb*(1-g.ct)); tG=Math.round(fG2*g.ct + bG2*(1-g.ct)); tB=Math.round(fB2*g.ct + bB2*(1-g.ct));
          boR=Math.round(fRgb*g.cb + bRgb*(1-g.cb)); boG=Math.round(fG2*g.cb + bG2*(1-g.cb)); boB=Math.round(fB2*g.cb + bB2*(1-g.cb));
        }
        const e=colorDist2(r1,g1,b1, tR,tG,tB, mode) + colorDist2(r2,g2,b2, boR,boG,boB, mode);
        return {err:e, bytes:g.bytes, glyph:g.ch};
      }
    } catch { _wasmMisses++; }
  } else if (ws) { _wasmMisses++; }
  let bestErr=1e18, bestB=GLYPH_BYTES_HALF, bestG='▀';
  const fRgb=(pal[f]>>16)&255, fG2=(pal[f]>>8)&255, fB2=pal[f]&255;
  const bRgb=(pal[b]>>16)&255, bG2=(pal[b]>>8)&255, bB2=pal[b]&255;
  let fOk: number[] | null = null, bOk: number[] | null = null;
  if (mode==='oklab') {
    if (palOkLab && f < pal.length && b < pal.length) {
      fOk = palOkLab[f]; bOk = palOkLab[b];
    } else {
      fOk = srgbToOkLab(fRgb,fG2,fB2); bOk = srgbToOkLab(bRgb,bG2,bB2);
    }
  }
  for(const g of GLYPHS){
    const ct=g.ct, cb=g.cb;
    let tR:number,tG:number,tB:number, boR:number,boG:number,boB:number;
    if(mode==='oklab' && fOk && bOk){
      const Lt=fOk[0]*ct + bOk[0]*(1-ct), At=fOk[1]*ct + bOk[1]*(1-ct), Bt=fOk[2]*ct + bOk[2]*(1-ct);
      const Lb=fOk[0]*cb + bOk[0]*(1-cb), Ab=fOk[1]*cb + bOk[1]*(1-cb), Bb=fOk[2]*cb + bOk[2]*(1-cb);
      [tR,tG,tB]=oklabToSrgb(Lt,At,Bt); [boR,boG,boB]=oklabToSrgb(Lb,Ab,Bb);
    } else {
      tR=Math.round(fRgb*ct + bRgb*(1-ct)); tG=Math.round(fG2*ct + bG2*(1-ct)); tB=Math.round(fB2*ct + bB2*(1-ct));
      boR=Math.round(fRgb*cb + bRgb*(1-cb)); boG=Math.round(fG2*cb + bG2*(1-cb)); boB=Math.round(fB2*cb + bB2*(1-cb));
    }
    const e=colorDist2(r1,g1,b1, tR,tG,tB, mode) + colorDist2(r2,g2,b2, boR,boG,boB, mode);
    const cand=e + w*g.bytes;
    if(cand < bestErr + w*bestB){ bestErr=e; bestB=g.bytes; bestG=g.ch; }
  }
  return {err:bestErr, bytes:bestB, glyph:bestG};
}
/** Greedy Hungarian-inspired palette selection with single-digit bias (PaletteAssignment.lean).
 * Picks up to `size` indices minimising Σ f·digits(σ) + λ·f·ΔE, approximated by
 * frequency rank + digit-length penalty. λ≈0.02 biases toward 1-digit without hurting ΔE much.
 */
export function rowPaletteForViterbi(
  tops:Array<[number,number,number,number]>, bots:Array<[number,number,number,number]>,
  pal:number[], ng:boolean, mode:ColorMatching, size=12
):number[]{
  const k=2, freq=new Map<number,number>();
  const lambda=0.02;
  for(let c=0;c<tops.length;c++){
    const [r1,g1,b1]=tops[c], [r2,g2,b2]=bots[c];
    if(_nearBlack(r1,g1,b1)&&_nearBlack(r2,g2,b2)) continue;
    for(const idx of kNearest(r1,g1,b1,pal,k,ng,mode)) freq.set(idx,(freq.get(idx)||0)+1);
    for(const idx of kNearest(r2,g2,b2,pal,k,ng,mode)) freq.set(idx,(freq.get(idx)||0)+1);
  }
  const scored=[...freq.entries()].map(([idx,f])=>({idx,f,score:f / (1 + lambda*codeLen(idx))}));
  scored.sort((a,b)=>b.score-a.score||b.f-a.f||a.idx-b.idx);
  const sorted=scored.slice(0,size).map(e=>e.idx);
  if(sorted.length===0) return [0,1,7].slice(0,size);
  return sorted;
}

// Bilateral pre-filter — edge-preserving smoother (spec §6, Midgard comic mode)
// Tries WASM (wasm-img2irc/pkg) via getWasm() cache — never breaks build, no per-call import
export async function tryWasmBilateral(d: Uint8ClampedArray, pW:number, pH:number, radius:number, sigma:number, passes:number): Promise<boolean> {
  try {
    const mod = await getWasm();
    if (!mod?.bilateral_filter) return false;
    mod.bilateral_filter(d, pW, pH, radius, sigma, passes);
    return true;
  } catch { return false; }
}
// Precomputed exp LUT for bilateral: wt = exp(-d2/sigma2), d2 in [0, 195075] (255^2*3), sigma2=3200
// d2*32/sigma2 maps to [0, 1952], clamp to 2047. Cuts 720K Math.exp → array lookup for 120×120×2.
export const EXP_LUT = (()=>{ const a=new Float64Array(2048); for(let i=0;i<2048;i++) a[i]=Math.exp(-i/32); return a; })();
export function applyBilateralFilter(d: Uint8ClampedArray, pW:number, pH:number, radius=2, sigma=40, passes=1): void {
  const sigma2 = 2*sigma*sigma;
  const tmp = new Uint8ClampedArray(d.length);
  for(let pass=0; pass<passes; pass++){
    const src = new Uint8ClampedArray(d);
    for(let y=0;y<pH;y++){
      for(let x=0;x<pW;x++){
        const i=(y*pW+x)*4;
        const r0=src[i], g0=src[i+1], b0=src[i+2];
        let accR=0, accG=0, accB=0, wsum=0;
        for(let dy=-radius; dy<=radius; dy++){
          const yy=y+dy; if(yy<0||yy>=pH) continue;
          for(let dx=-radius; dx<=radius; dx++){
            const xx=x+dx; if(xx<0||xx>=pW) continue;
            const j=(yy*pW+xx)*4;
            const r=src[j], g=src[j+1], b=src[j+2];
            const d2=(r-r0)*(r-r0)+(g-g0)*(g-g0)+(b-b0)*(b-b0);
            const wt=EXP_LUT[Math.min(2047, Math.round(d2*32/sigma2))];
            accR+=wt*r; accG+=wt*g; accB+=wt*b; wsum+=wt;
          }
        }
        tmp[i]=Math.round(accR/wsum); tmp[i+1]=Math.round(accG/wsum); tmp[i+2]=Math.round(accB/wsum); tmp[i+3]=src[i+3];
      }
    }
    d.set(tmp);
  }
}

function rankSmartPaletteA(d: Uint8ClampedArray, pW:number, pH:number, pal:number[], topN:number, mode:ColorMatching): number[] {
  const counts=new Array(pal.length).fill(0);
  for(let y=0;y<pH;y++) for(let x=0;x<pW;x++){ const i=(y*pW+x)*4; if(d[i+3]<128) continue; let bi=0,bd=Infinity; for(let c=0;c<pal.length;c++){ const cr=(pal[c]>>16)&255,cg=(pal[c]>>8)&255,cb=pal[c]&255,d2=colorDist2(d[i],d[i+1],d[i+2],cr,cg,cb,mode); if(d2<bd){bd=d2; bi=c;}} counts[bi]++; }
  const ranked=counts.map((c,i)=>({c,i})).sort((a,b)=>b.c-a.c||a.i-b.i);
  return ranked.slice(0, Math.min(topN, pal.length)).map(e=>e.i);
}
// Shared core — single source of truth for both entry points (main thread + Worker)
let _lastTimings: Record<string, number> | null = null;
export function getLastTimings(): Record<string, number> | null { return _lastTimings ? { ..._lastTimings } : null; }
export async function renderPixelsCore(
  d: Uint8ClampedArray,
  pW: number, pH: number,
  cols: number, rows: number,
  pm: PixelMode,
  o: Img2IrcOptions
): Promise<string> {
  const _tStart = _perf();
  const _timings: Record<string, number> = {};
  if ((o as Img2IrcOptions)._debugResizeMs != null) _timings['resize'] = (o as Img2IrcOptions)._debugResizeMs as number;
  let _t = _perf();
  // Kick WASM load in parallel with gamma/normalize (no await yet) — hot loops later will hit sync cache
  // Ensure preload if not already — fire-and-forget before await
  if (!hasWasmSync()) void getWasm().catch(()=>null);
  const _wasmPreload = getWasm().catch(()=>null);
  if (COLOR_LUT.size>8000) COLOR_LUT.clear();
  _timings['lutClear'] = _perf() - _t; _t = _perf();
  if(o.gamma!==0&&o.gamma!==1){const g=o.gamma;for(let i=0;i<d.length;i+=4){d[i]=255*Math.pow(d[i]/255,1/g);d[i+1]=255*Math.pow(d[i+1]/255,1/g);d[i+2]=255*Math.pow(d[i+2]/255,1/g);}}
  _timings['gamma'] = _perf() - _t; _t = _perf();
  if(o.normalize){let mn=255,mx=0;for(let i=0;i<d.length;i+=4){const l=luma(d[i],d[i+1],d[i+2]);if(l<mn)mn=l;if(l>mx)mx=l;}const rng=Math.max(1,mx-mn);for(let i=0;i<d.length;i+=4){d[i]=((d[i]-mn)*255)/rng;d[i+1]=((d[i+1]-mn)*255)/rng;d[i+2]=((d[i+2]-mn)*255)/rng;}}
  _timings['normalize'] = _perf() - _t; _t = _perf();
  if(o.comic){
    const wasmOk = await tryWasmBilateral(d, pW, pH, 2, 40, 2);
    if (!wasmOk) applyBilateralFilter(d, pW, pH, 2, 40, 2);
  }
  _timings['bilateral'] = _perf() - _t; _t = _perf();
  const ditherMode = o.dither ? (o.ditherMode==='none' ? 'bayer4' : o.ditherMode) : 'none';
  if(ditherMode!=='none'){
    if(ditherMode==='bayer4'){
      const bayer=[[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
      for(let y=0;y<pH;y++){ for(let x=0;x<pW;x++){ const i=(y*pW+x)*4; const tt=(bayer[y%4][x%4]/16 -0.5)*28; d[i]=Math.max(0,Math.min(255,d[i]+tt)); d[i+1]=Math.max(0,Math.min(255,d[i+1]+tt)); d[i+2]=Math.max(0,Math.min(255,d[i+2]+tt)); }}
    } else if(ditherMode==='bayer8'){
      const bayer8=[[0,32,8,40,2,34,10,42],[48,16,56,24,50,18,58,26],[12,44,4,36,14,46,6,38],[60,28,52,20,62,30,54,22],[3,35,11,43,1,33,9,41],[51,19,59,27,49,17,57,25],[15,47,7,39,13,45,5,37],[63,31,55,23,61,29,53,21]];
      for(let y=0;y<pH;y++){ for(let x=0;x<pW;x++){ const i=(y*pW+x)*4; const tt=(bayer8[y%8][x%8]/64 -0.5)*28; d[i]=Math.max(0,Math.min(255,d[i]+tt)); d[i+1]=Math.max(0,Math.min(255,d[i+1]+tt)); d[i+2]=Math.max(0,Math.min(255,d[i+2]+tt)); }}
    } else if(ditherMode==='floyd'){
      if(o.renderMode==='ansi24' || o.midgardMode==='truecolor'){ }
      else {
        const w2=pW, h2=pH, data2=new Float32Array(d);
        const pal=getMidgardPalette(o);
        for(let y=0;y<h2;y++){ for(let x=0;x<w2;x++){ const i=(y*w2+x)*4; const r=data2[i], g=data2[i+1], b=data2[i+2]; const idx=nearestIndex(r,g,b, pal, o.colorMatching); const pr=(pal[idx]>>16)&255, pg=(pal[idx]>>8)&255, pb=pal[idx]&255; const er=r-pr, eg=g-pg, eb=b-pb; data2[i]=pr; data2[i+1]=pg; data2[i+2]=pb; if(x+1<w2){ data2[i+4]+=er*7/16; data2[i+5]+=eg*7/16; data2[i+6]+=eb*7/16; } if(y+1<h2){ if(x>0){ data2[i+w2*4-4]+=er*3/16; data2[i+w2*4-3]+=eg*3/16; data2[i+w2*4-2]+=eb*3/16;} data2[i+w2*4]+=er*5/16; data2[i+w2*4+1]+=eg*5/16; data2[i+w2*4+2]+=eb*5/16; if(x+1<w2){ data2[i+w2*4+4]+=er*1/16; data2[i+w2*4+5]+=eg*1/16; data2[i+w2*4+6]+=eb*1/16; } } } }
        for(let i=0;i<d.length;i++) d[i]=Math.max(0,Math.min(255, data2[i]));
      }
    } else if(ditherMode==='atkinson'){
      const w2=pW, h2=pH, data2=new Float32Array(d);
      const pal=getMidgardPalette(o);
      for(let y=0;y<h2;y++){ for(let x=0;x<w2;x++){ const i=(y*w2+x)*4; const r=data2[i], g=data2[i+1], b=data2[i+2]; const idx=nearestIndex(r,g,b, pal, o.colorMatching); const pr=(pal[idx]>>16)&255, pg=(pal[idx]>>8)&255, pb=pal[idx]&255; const er=r-pr, eg=g-pg, eb=b-pb; data2[i]=pr; data2[i+1]=pg; data2[i+2]=pb; const d1=er/8, dg1=eg/8, db1=eb/8; if(x+1<w2){ data2[i+4]+=d1; data2[i+5]+=dg1; data2[i+6]+=db1; } if(x+2<w2){ data2[i+8]+=d1; data2[i+9]+=dg1; data2[i+10]+=db1; } if(y+1<h2){ if(x>0){ data2[i+w2*4-4]+=d1; data2[i+w2*4-3]+=dg1; data2[i+w2*4-2]+=db1;} data2[i+w2*4]+=d1; data2[i+w2*4+1]+=dg1; data2[i+w2*4+2]+=db1; if(x+1<w2){ data2[i+w2*4+4]+=d1; data2[i+w2*4+5]+=dg1; data2[i+w2*4+6]+=db1; } } } }
      for(let i=0;i<d.length;i++) d[i]=Math.max(0,Math.min(255, data2[i]));
    } else if(ditherMode==='sierra'){
      if(o.renderMode==='ansi24' || o.midgardMode==='truecolor'){ }
      else {
        const w2=pW, h2=pH, data2=new Float32Array(d);
        const pal=getMidgardPalette(o);
        for(let y=0;y<h2;y++){ for(let x=0;x<w2;x++){ const i=(y*w2+x)*4; const r=data2[i], g=data2[i+1], b=data2[i+2]; const idx=nearestIndex(r,g,b, pal, o.colorMatching); const pr=(pal[idx]>>16)&255, pg=(pal[idx]>>8)&255, pb=pal[idx]&255; const er=r-pr, eg=g-pg, eb=b-pb; data2[i]=pr; data2[i+1]=pg; data2[i+2]=pb;
          if(x+1<w2){ data2[i+4]+=er*5/32; data2[i+5]+=eg*5/32; data2[i+6]+=eb*5/32; }
          if(x+2<w2){ data2[i+8]+=er*3/32; data2[i+9]+=eg*3/32; data2[i+10]+=eb*3/32; }
          if(y+1<h2){
            if(x-2>=0){ data2[i+w2*4-8]+=er*2/32; data2[i+w2*4-7]+=eg*2/32; data2[i+w2*4-6]+=eb*2/32; }
            if(x-1>=0){ data2[i+w2*4-4]+=er*4/32; data2[i+w2*4-3]+=eg*4/32; data2[i+w2*4-2]+=eb*4/32; }
            data2[i+w2*4]+=er*5/32; data2[i+w2*4+1]+=eg*5/32; data2[i+w2*4+2]+=eb*5/32;
            if(x+1<w2){ data2[i+w2*4+4]+=er*4/32; data2[i+w2*4+5]+=eg*4/32; data2[i+w2*4+6]+=eb*4/32; }
            if(x+2<w2){ data2[i+w2*4+8]+=er*2/32; data2[i+w2*4+9]+=eg*2/32; data2[i+w2*4+10]+=eb*2/32; }
          }
          if(y+2<h2){
            if(x-1>=0){ data2[i+w2*8-4]+=er*1/32; data2[i+w2*8-3]+=eg*1/32; data2[i+w2*8-2]+=eb*1/32; }
            data2[i+w2*8]+=er*2/32; data2[i+w2*8+1]+=eg*2/32; data2[i+w2*8+2]+=eb*2/32;
            if(x+1<w2){ data2[i+w2*8+4]+=er*1/32; data2[i+w2*8+5]+=eg*1/32; data2[i+w2*8+6]+=eb*1/32; }
          }
        } }
        for(let i=0;i<d.length;i++) d[i]=Math.max(0,Math.min(255, data2[i]));
      }
    } else if(ditherMode==='stucki'){
      if(o.renderMode==='ansi24' || o.midgardMode==='truecolor'){ }
      else {
        const w2=pW, h2=pH, data2=new Float32Array(d);
        const pal=getMidgardPalette(o);
        for(let y=0;y<h2;y++){ for(let x=0;x<w2;x++){ const i=(y*w2+x)*4; const r=data2[i], g=data2[i+1], b=data2[i+2]; const idx=nearestIndex(r,g,b, pal, o.colorMatching); const pr=(pal[idx]>>16)&255, pg=(pal[idx]>>8)&255, pb=pal[idx]&255; const er=r-pr, eg=g-pg, eb=b-pb; data2[i]=pr; data2[i+1]=pg; data2[i+2]=pb;
          if(x+1<w2){ data2[i+4]+=er*8/42; data2[i+5]+=eg*8/42; data2[i+6]+=eb*8/42; }
          if(x+2<w2){ data2[i+8]+=er*4/42; data2[i+9]+=eg*4/42; data2[i+10]+=eb*4/42; }
          if(y+1<h2){
            if(x-2>=0){ data2[i+w2*4-8]+=er*2/42; data2[i+w2*4-7]+=eg*2/42; data2[i+w2*4-6]+=eb*2/42; }
            if(x-1>=0){ data2[i+w2*4-4]+=er*4/42; data2[i+w2*4-3]+=eg*4/42; data2[i+w2*4-2]+=eb*4/42; }
            data2[i+w2*4]+=er*8/42; data2[i+w2*4+1]+=eg*8/42; data2[i+w2*4+2]+=eb*8/42;
            if(x+1<w2){ data2[i+w2*4+4]+=er*4/42; data2[i+w2*4+5]+=eg*4/42; data2[i+w2*4+6]+=eb*4/42; }
            if(x+2<w2){ data2[i+w2*4+8]+=er*2/42; data2[i+w2*4+9]+=eg*2/42; data2[i+w2*4+10]+=eb*2/42; }
          }
          if(y+2<h2){
            if(x-2>=0){ data2[i+w2*8-8]+=er*1/42; data2[i+w2*8-7]+=eg*1/42; data2[i+w2*8-6]+=eb*1/42; }
            if(x-1>=0){ data2[i+w2*8-4]+=er*2/42; data2[i+w2*8-3]+=eg*2/42; data2[i+w2*8-2]+=eb*2/42; }
            data2[i+w2*8]+=er*4/42; data2[i+w2*8+1]+=eg*4/42; data2[i+w2*8+2]+=eb*4/42;
            if(x+1<w2){ data2[i+w2*8+4]+=er*2/42; data2[i+w2*8+5]+=eg*2/42; data2[i+w2*8+6]+=eb*2/42; }
            if(x+2<w2){ data2[i+w2*8+8]+=er*1/42; data2[i+w2*8+9]+=eg*1/42; data2[i+w2*8+10]+=eb*1/42; }
          }
        } }
        for(let i=0;i<d.length;i++) d[i]=Math.max(0,Math.min(255, data2[i]));
      }
    } else if(ditherMode==='jarvis'){
      if(o.renderMode==='ansi24' || o.midgardMode==='truecolor'){ }
      else {
        const w2=pW, h2=pH, data2=new Float32Array(d);
        const pal=getMidgardPalette(o);
        for(let y=0;y<h2;y++){ for(let x=0;x<w2;x++){ const i=(y*w2+x)*4; const r=data2[i], g=data2[i+1], b=data2[i+2]; const idx=nearestIndex(r,g,b, pal, o.colorMatching); const pr=(pal[idx]>>16)&255, pg=(pal[idx]>>8)&255, pb=pal[idx]&255; const er=r-pr, eg=g-pg, eb=b-pb; data2[i]=pr; data2[i+1]=pg; data2[i+2]=pb;
          if(x+1<w2){ data2[i+4]+=er*7/48; data2[i+5]+=eg*7/48; data2[i+6]+=eb*7/48; }
          if(x+2<w2){ data2[i+8]+=er*5/48; data2[i+9]+=eg*5/48; data2[i+10]+=eb*5/48; }
          if(y+1<h2){
            if(x-2>=0){ data2[i+w2*4-8]+=er*3/48; data2[i+w2*4-7]+=eg*3/48; data2[i+w2*4-6]+=eb*3/48; }
            if(x-1>=0){ data2[i+w2*4-4]+=er*5/48; data2[i+w2*4-3]+=eg*5/48; data2[i+w2*4-2]+=eb*5/48; }
            data2[i+w2*4]+=er*7/48; data2[i+w2*4+1]+=eg*7/48; data2[i+w2*4+2]+=eb*7/48;
            if(x+1<w2){ data2[i+w2*4+4]+=er*5/48; data2[i+w2*4+5]+=eg*5/48; data2[i+w2*4+6]+=eb*5/48; }
            if(x+2<w2){ data2[i+w2*4+8]+=er*3/48; data2[i+w2*4+9]+=eg*3/48; data2[i+w2*4+10]+=eb*3/48; }
          }
          if(y+2<h2){
            if(x-2>=0){ data2[i+w2*8-8]+=er*1/48; data2[i+w2*8-7]+=eg*1/48; data2[i+w2*8-6]+=eb*1/48; }
            if(x-1>=0){ data2[i+w2*8-4]+=er*3/48; data2[i+w2*8-3]+=eg*3/48; data2[i+w2*8-2]+=eb*3/48; }
            data2[i+w2*8]+=er*5/48; data2[i+w2*8+1]+=eg*5/48; data2[i+w2*8+2]+=eb*5/48;
            if(x+1<w2){ data2[i+w2*8+4]+=er*3/48; data2[i+w2*8+5]+=eg*3/48; data2[i+w2*8+6]+=eb*3/48; }
            if(x+2<w2){ data2[i+w2*8+8]+=er*1/48; data2[i+w2*8+9]+=eg*1/48; data2[i+w2*8+10]+=eb*1/48; }
          }
        } }
        for(let i=0;i<d.length;i++) d[i]=Math.max(0,Math.min(255, data2[i]));
      }
    }
  }
  // Ensure WASM is loaded before Viterbi/nearest hot loops — await the preload started at top
  try { await _wasmPreload; } catch {}
  _timings['wasmPreload'] = _perf() - _t; _t = _perf();
  const pxAt=(x:number,y:number):[number,number,number,number]=>{
    if(x<0||y<0||x>=pW||y>=pH)return[0,0,0,0];
    const i=(y*pW+x)*4;return[d[i],d[i+1],d[i+2],d[i+3]];
  };
  const is24=o.renderMode==='ansi24' || o.midgardMode==='truecolor', ng=o.nograyscale;
  const is16=o.midgardMode==='16';
  const lines:string[]=[];
  if(pm==='braille'){
    const palB=getMidgardPalette(o);
    const POS:Array<[number,number,number]>=[[0,0,0x01],[0,1,0x02],[0,2,0x04],[1,0,0x08],[1,1,0x10],[1,2,0x20],[0,3,0x40],[1,3,0x80]];
    for(let r=0;r<rows;r++){let ln='',lastCode='',first=true;
      for(let c=0;c<cols;c++){let br=0x2800,sR=0,sG=0,sB=0,sN=0;
        for(const[dx,dy,bit]of POS){const x=c*2+dx,y=r*4+dy;const[rr,gg,bb,aa]=pxAt(x,y);if((o.alphaMode==='transparent' ? aa < o.alphaThreshold : false))continue;if(luma(rr,gg,bb)>127){br|=bit;sR+=rr;sG+=gg;sB+=bb;sN++;}}
        const code=is16? '\x03'+String(nearestIndex(sR/sN|0,sG/sN|0,sB/sN|0,palB, o.colorMatching)) : is24? '\x04'+toHex6(sR/sN|0,sG/sN|0,sB/sN|0) : '\x03'+String(toEmitIdx(o.renderMode==='ansi'? lutLookup(sR/sN|0,sG/sN|0,sB/sN|0,palB,ng, o.colorMatching).ansi : lutLookup(sR/sN|0,sG/sN|0,sB/sN|0,palB,ng, o.colorMatching).irc, o.renderMode, palB, o.colorMatching));
        if(first||lastCode!==code){ln+=code;lastCode=code;}
        ln+=String.fromCharCode(br);first=false;
      }
      ln=ln.replace(/[ ]+$/g,'');lines.push(ln);
    }
  } else if(pm==='quarter'){
    const qPal=getMidgardPalette(o);
    const qMap=[' ','▘','▝','▀','▖','▌','▞','▛','▗','▚','▐','▜','▄','▙','▟','█'];
    for(let r=0;r<rows;r++){let ln='',lastFg='',lastBg='',first=true;
      for(let c=0;c<cols;c++){
        const p=[[pxAt(c*2,r*2),pxAt(c*2+1,r*2)],[pxAt(c*2,r*2+1),pxAt(c*2+1,r*2+1)]];
        const b=[0,1,2,3].map(i=>luma(p[i>>1][i&1][0],p[i>>1][i&1][1],p[i>>1][i&1][2])>127?1:0);
        const bits=b[0]|(b[1]<<1)|(b[2]<<2)|(b[3]<<3), ch=qMap[bits]||' ';
        if(ch===' '){ln+=' ';first=false;continue;}
        let onR=0,onG=0,onB=0,onC=0, offR=0,offG=0,offB=0,offC=0;
        for(let i=0;i<4;i++){const[rr,gg,bb,aa]=p[i>>1][i&1];if((o.alphaMode==='transparent' ? aa < o.alphaThreshold : false))continue;if(b[i]){onR+=rr;onG+=gg;onB+=bb;onC++;}else{offR+=rr;offG+=gg;offB+=bb;offC++;}}
        if(onC===0){ln+=' ';first=false;continue;}
        if(offC===0){
          if(is24){
            const cd='\x04'+toHex6(onR/onC|0,onG/onC|0,onB/onC|0);
            if(first||lastFg!==cd||lastBg!==''){ln+=cd;lastFg=cd;lastBg='';}
            ln+='█';first=false;continue;
          } else if(is16){
            const bgS=String(nearestIndex(onR/onC|0,onG/onC|0,onB/onC|0,qPal, o.colorMatching));
            const cd='\x03'+bgS+','+bgS;
            if(first||lastFg!==bgS||lastBg!==bgS){ln+=cd;lastFg=bgS;lastBg=bgS;}
            ln+=' ';first=false;continue;
          } else {
            const bgS=String(toEmitIdx(o.renderMode==='ansi'? lutLookup(onR/onC|0,onG/onC|0,onB/onC|0,qPal,ng, o.colorMatching).ansi : lutLookup(onR/onC|0,onG/onC|0,onB/onC|0,qPal,ng, o.colorMatching).irc, o.renderMode, qPal, o.colorMatching));
            const cd='\x03'+bgS+','+bgS;
            if(first||lastFg!==bgS||lastBg!==bgS){ln+=cd;lastFg=bgS;lastBg=bgS;}
            ln+=' ';first=false;continue;
          }
        } else if(is16){
          const fgS=String(nearestIndex(onR/onC|0,onG/onC|0,onB/onC|0,qPal, o.colorMatching));
          const bgS=String(nearestIndex(offR/offC|0,offG/offC|0,offB/offC|0,qPal, o.colorMatching));
          const cd='\x03'+fgS+','+bgS;
          const fgF=fgS, bgF=bgS;
          if(first||lastFg!==fgF||lastBg!==bgF){ln+=cd;lastFg=fgF;lastBg=bgF;}
        } else {
          const fgS=is24? toHex6(onR/onC|0,onG/onC|0,onB/onC|0) : String(toEmitIdx(o.renderMode==='ansi'? lutLookup(onR/onC|0,onG/onC|0,onB/onC|0,qPal,ng, o.colorMatching).ansi : lutLookup(onR/onC|0,onG/onC|0,onB/onC|0,qPal,ng, o.colorMatching).irc, o.renderMode, qPal, o.colorMatching));
          const bgS=is24? toHex6(offR/offC|0,offG/offC|0,offB/offC|0) : String(toEmitIdx(o.renderMode==='ansi'? lutLookup(offR/offC|0,offG/offC|0,offB/offC|0,qPal,ng, o.colorMatching).ansi : lutLookup(offR/offC|0,offG/offC|0,offB/offC|0,qPal,ng, o.colorMatching).irc, o.renderMode, qPal, o.colorMatching));
          const cd=is24? '\x04'+fgS+','+bgS : '\x03'+fgS+','+bgS;
          const fgF=fgS, bgF=bgS;
          if(first||lastFg!==fgF||lastBg!==bgF){ln+=cd;lastFg=fgF;lastBg=bgF;}
        }
        ln+=ch;first=false;
      }
      ln=ln.replace(/[ ]+$/g,'');lines.push(ln);
    }
  } else if(pm==='half'){
    const pal=getMidgardPalette(o);
    const smart24 = (o as any).midgardMode==='smart' && (o as any)._smartPaletteA && o.renderMode==='ansi24';
    const useViterbi = o.viterbiW>0 && cols>1 && (smart24 || !is24);
    if(useViterbi){
      const _tViterbi = _perf();
      let _tRowPal=0, _tCellGlyph=0, _tDP=0;
      let _maxS = 0;
      for(let r=0;r<rows;r++){
        const tops:Array<[number,number,number,number]>=[], bots:Array<[number,number,number,number]>=[];
        for(let c=0;c<cols;c++){ tops.push(pxAt(c,r*2)); bots.push(pxAt(c,r*2+1)); }
        let allEmpty=true;
        for(let c=0;c<cols;c++){
          const [r1,g1,b1,a1]=tops[c], [r2,g2,b2,a2]=bots[c];
          const emp=(o.alphaMode==='transparent'?a1<o.alphaThreshold:false)&&(o.alphaMode==='transparent'?a2<o.alphaThreshold:false);
          const blk=_nearBlack(r1,g1,b1)&&_nearBlack(r2,g2,b2);
          if(!emp && !blk){ allEmpty=false; break; }
        }
        if(allEmpty){ lines.push(''); continue; }
        let S: number[];
        let _tr = _perf();
        if((o as any).midgardMode==='smart' && (o as any)._smartPaletteB && !smart24){
          S = (o as any)._smartPaletteB as number[];
        } else if(smart24){
          const fullA = (o as any)._smartPaletteA as number[];
          // Adaptive S: 120 cols → 12 states (vs 16) to keep 144 vs 256 states manageable
          const sSize = cols >= 100 ? 12 : 16;
          const top = rankSmartPaletteA(d, pW, pH, fullA, Math.min(sSize, fullA.length), o.colorMatching);
          S = top;
        } else {
          const sSize = cols >= 100 ? 10 : 12;
          let usedRowPalBatch = false;
          if (hasWasmSync() && tops.length === cols && bots.length === cols) {
            const rTops = new Uint8Array(cols), gTops = new Uint8Array(cols), bTops = new Uint8Array(cols);
            const rBots = new Uint8Array(cols), gBots = new Uint8Array(cols), bBots = new Uint8Array(cols);
            for(let c=0;c<cols;c++){ rTops[c]=tops[c][0]; gTops[c]=tops[c][1]; bTops[c]=tops[c][2]; rBots[c]=bots[c][0]; gBots[c]=bots[c][1]; bBots[c]=bots[c][2]; }
            const out = new Uint32Array(sSize);
            const n = tryWasmBatchRowPaletteSync(rTops,gTops,bTops,rBots,gBots,bBots,pal,o.colorMatching,sSize,ng,out);
            if (n !== null && n>0) {
              _wasmHits += n;
              S = Array.from(out.subarray(0,n));
              usedRowPalBatch = true;
            } else {
              _wasmMisses++;
            }
          }
          if (!usedRowPalBatch) {
            S = rowPaletteForViterbi(tops,bots,pal,ng,o.colorMatching,sSize);
          }
        }
        _tRowPal += _perf() - _tr;
        if (S.length > _maxS) _maxS = S.length;
        const states: Array<[number,number]> = [];
        for(const f of S) for(const b of S) states.push([f,b]);
        const M=cols;
        type GlyphInfo={err:number, bytes:number, glyph:string};
        const cellGlyph: GlyphInfo[][] = new Array(M);
        const cellIsEmpty: boolean[] = new Array(M);
        let _tc = _perf();
        const effPal = smart24 ? ((o as any)._smartPaletteA as number[]) : pal;
        const _rowPalOkLab = o.colorMatching==='oklab' ? getPalOkLab(effPal) : null;
        // Try batched WASM path — one crossing per row instead of M*S
        let usedBatch = false;
        if (hasWasmSync() && states.length > 0 && M * states.length <= 65536) {
          const r1Arr = new Uint8Array(M), g1Arr = new Uint8Array(M), b1Arr = new Uint8Array(M);
          const r2Arr = new Uint8Array(M), g2Arr = new Uint8Array(M), b2Arr = new Uint8Array(M);
          for(let i=0;i<M;i++){
            const [r1,g1,b1,a1]=tops[i], [r2,g2,b2,a2]=bots[i];
            const isEmpty=(o.alphaMode==='transparent'?a1<o.alphaThreshold:false)&&(o.alphaMode==='transparent'?a2<o.alphaThreshold:false) || (_nearBlack(r1,g1,b1)&&_nearBlack(r2,g2,b2));
            cellIsEmpty[i]=isEmpty;
            r1Arr[i]=r1; g1Arr[i]=g1; b1Arr[i]=b1;
            r2Arr[i]=r2; g2Arr[i]=g2; b2Arr[i]=b2;
            if(isEmpty) cellGlyph[i]=[];
          }
          // Fill any remaining empty entries already handled; need cellGlyph for non-empty later
          const Slen = states.length;
          const statesF = new Uint32Array(Slen), statesB = new Uint32Array(Slen);
          for(let s=0;s<Slen;s++){ statesF[s]=states[s][0]; statesB[s]=states[s][1]; }
          const outGlyph = new Uint8Array(M * Slen);
          const outErr = new Float32Array(M * Slen);
          const outBytes = new Uint8Array(M * Slen);
          const n = tryWasmBatchBestGlyphSync(r1Arr,g1Arr,b1Arr,r2Arr,g2Arr,b2Arr,statesF,statesB,effPal,o.colorMatching,o.viterbiW,outGlyph,outErr,outBytes);
          if (n === M * Slen) {
            _wasmHits += n;
            for(let i=0;i<M;i++){
              if(cellIsEmpty[i]) continue;
              const rowGlyphs: GlyphInfo[] = new Array(Slen);
              for(let s=0;s<Slen;s++){
                const idx = i*Slen + s;
                const gIdx = outGlyph[idx];
                const g = GLYPHS[gIdx] ?? GLYPHS[7];
                rowGlyphs[s]={err: outErr[idx], bytes: outBytes[idx] || g.bytes, glyph: g.ch};
              }
              cellGlyph[i]=rowGlyphs;
            }
            usedBatch = true;
          } else {
            _wasmMisses++;
          }
        }
        if (!usedBatch) {
          for(let i=0;i<M;i++){
            const [r1,g1,b1,a1]=tops[i], [r2,g2,b2,a2]=bots[i];
            const isEmpty=(o.alphaMode==='transparent'?a1<o.alphaThreshold:false)&&(o.alphaMode==='transparent'?a2<o.alphaThreshold:false) || (_nearBlack(r1,g1,b1)&&_nearBlack(r2,g2,b2));
            cellIsEmpty[i]=isEmpty;
            if(isEmpty){ cellGlyph[i]=[]; continue; }
            const rowGlyphs: GlyphInfo[] = new Array(states.length);
            for(let s=0;s<states.length;s++){
              const [f,b]=states[s];
              rowGlyphs[s]=bestGlyphForState(r1,g1,b1,r2,g2,b2,f,b,effPal,o.colorMatching,o.viterbiW, _rowPalOkLab);
            }
            cellGlyph[i]=rowGlyphs;
          }
        }
        _tCellGlyph += _perf() - _tc;
        const INF=1e18;
        let dp=new Array(states.length).fill(INF);
        const back: number[][] = Array.from({length:M},()=>new Array(states.length).fill(-1));
        const _palToIrc = o.renderMode==='ansi' ? getPalToIrc(pal, o.colorMatching) : null;
        const _palToIrcEff: Uint8Array | null = smart24 ? null : (o.renderMode==='ansi' ? getPalToIrc(effPal, o.colorMatching) : null);
        for(let s=0;s<states.length;s++){
          if(cellIsEmpty[0]){
            dp[s]=0;
          } else {
            const g=cellGlyph[0][s];
            const [f,b]=states[s];
            if(smart24){
              dp[s]=g.err + o.viterbiW*(g.bytes + 14);
            } else {
              const fgM=_palToIrcEff ? _palToIrcEff[f & 255] : f, bgM=_palToIrcEff ? _palToIrcEff[b & 255] : b;
              const pc=pairPref(fgM,bgM);
              dp[s]=g.err + o.viterbiW*(g.bytes + pc);
            }
          }
        }
        let _tdp = _perf();
        for(let i=1;i<M;i++){
          if(cellIsEmpty[i]){
            const bestIdx=dp.indexOf(Math.min(...dp));
            const nd=new Array(states.length).fill(INF);
            for(let s=0;s<states.length;s++){ nd[s]=dp[bestIdx]; back[i][s]=bestIdx; }
            dp=nd;
            continue;
          }
          let gmin=INF, gidx=-1;
          for(let s=0;s<states.length;s++) if(dp[s]<gmin){gmin=dp[s]; gidx=s;}
          const bMinCost=new Map<number,{cost:number,idx:number}>();
          for(let s=0;s<states.length;s++){
            const bg=states[s][1];
            const c=dp[s];
            const cur=bMinCost.get(bg);
            if(!cur || c<cur.cost) bMinCost.set(bg,{cost:c, idx:s});
          }
          const nd=new Array(states.length).fill(INF);
          for(let s=0;s<states.length;s++){
            const [f,b]=states[s];
            const g=cellGlyph[i][s];
            if(smart24){
              const candStay=bMinCost.get(b)!.cost + o.viterbiW*7;
              const candSwitch=gmin + o.viterbiW*14;
              let best=dp[s];
              let bestIdxPrev=s;
              if(candStay < best){ best=candStay; bestIdxPrev=bMinCost.get(b)!.idx; }
              if(candSwitch < best){ best=candSwitch; bestIdxPrev=gidx; }
              nd[s]=best + g.err + o.viterbiW*g.bytes;
              back[i][s]=bestIdxPrev;
            } else {
              const fgM=_palToIrcEff ? _palToIrcEff[f & 255] : f, bgM=_palToIrcEff ? _palToIrcEff[b & 255] : b;
              const candStay=bMinCost.get(b)!.cost + o.viterbiW*fgPref(fgM);
              const candSwitch=gmin + o.viterbiW*pairPref(fgM,bgM);
              let best=dp[s];
              let bestIdxPrev=s;
              if(candStay < best){ best=candStay; bestIdxPrev=bMinCost.get(b)!.idx; }
              if(candSwitch < best){ best=candSwitch; bestIdxPrev=gidx; }
              nd[s]=best + g.err + o.viterbiW*g.bytes;
              back[i][s]=bestIdxPrev;
            }
          }
          dp=nd;
        }
        _tDP += _perf() - _tdp;

        let bestEnd=0; for(let s=1;s<states.length;s++) if(dp[s]<dp[bestEnd]) bestEnd=s;
        const chosenIdx=new Array(M).fill(0);
        chosenIdx[M-1]=bestEnd;
        for(let i=M-1;i>0;i--){
          if(cellIsEmpty[i]){ chosenIdx[i-1]=chosenIdx[i]; }
          else { chosenIdx[i-1]=back[i][chosenIdx[i]]; }
        }
        let ln='', lastFg='', lastBg='', first=true;
        for(let c=0;c<M;c++){
          if(cellIsEmpty[c]){ ln+=' '; first=false; continue; }
          const sIdx=chosenIdx[c];
          const [fRaw,bRaw]=states[sIdx];
          const g=cellGlyph[c][sIdx];
          const glyph=g.glyph;
          if(smart24){
            const fHex=toHex6((effPal[fRaw]>>16)&255,(effPal[fRaw]>>8)&255,effPal[fRaw]&255);
            const bHex=toHex6((effPal[bRaw]>>16)&255,(effPal[bRaw]>>8)&255,effPal[bRaw]&255);
            if(glyph===' '){
              const need=first || lastBg!==bHex;
              if(need){ const cd='\x04'+fHex+','+bHex; ln+=cd; lastFg=fHex; lastBg=bHex; }
              ln+=' ';
            } else {
              const needFull=first || lastFg!==fHex || lastBg!==bHex;
              const needFgOnly=!first && lastBg===bHex && lastFg!==fHex;
              if(needFgOnly){ const cd='\x04'+fHex; ln+=cd; lastFg=fHex; }
              else if(needFull){ const cd='\x04'+fHex+','+bHex; ln+=cd; lastFg=fHex; lastBg=bHex; }
              ln+=glyph;
            }
          } else {
            const fg=_palToIrcEff ? _palToIrcEff[fRaw & 255] : fRaw, bg=_palToIrcEff ? _palToIrcEff[bRaw & 255] : bRaw;
            if(glyph===' '){
              const need=first || lastBg!==String(bg);
              if(need){
                const cd='\x03'+fg+','+bg;
                ln+=cd; lastFg=String(fg); lastBg=String(bg);
              }
              ln+=' ';
            } else {
              const needFull=first || lastFg!==String(fg) || lastBg!==String(bg);
              const needFgOnly=!first && lastBg===String(bg) && lastFg!==String(fg);
              if(needFgOnly){
                const cd='\x03'+fg;
                ln+=cd; lastFg=String(fg);
              } else if(needFull){
                const cd='\x03'+fg+','+bg;
                ln+=cd; lastFg=String(fg); lastBg=String(bg);
              }
              ln+=glyph;
            }
          }
          first=false;
        }
        ln=ln.replace(/[ ]+$/g,''); lines.push(ln);
      }
      _timings['viterbi'] = _perf() - _tViterbi;
      _timings['viterbi_rowPal'] = _tRowPal;
      _timings['viterbi_cellGlyph'] = _tCellGlyph;
      _timings['viterbi_dp'] = _tDP;
      _timings['viterbi_S'] = _maxS;
    } else {
      for(let r=0;r<rows;r++){
        let ln='',lastFg='',lastBg='',first=true;
        for(let c=0;c<cols;c++){
          const[r1,g1,b1,a1]=pxAt(c,r*2), [r2,g2,b2,a2]=pxAt(c,r*2+1);
          if((o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false)&&(o.alphaMode==='transparent' ? a2 < o.alphaThreshold : false)){ln+=' ';first=false;continue;}
          if(_nearBlack(r1,g1,b1)&&_nearBlack(r2,g2,b2)){ln+=' ';first=false;continue;}
          if(is24){
            const fg=toHex6(r1,g1,b1), bg=toHex6(r2,g2,b2);
            if((o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false)){const c='\x04'+bg; if(first||lastFg!==c.slice(1)||lastBg!==''){ln+=c;lastFg=c.slice(1);lastBg='';}ln+='▄';}
            else if((o.alphaMode==='transparent' ? a2 < o.alphaThreshold : false)){const c='\x04'+fg; if(first||lastFg!==c.slice(1)||lastBg!==''){ln+=c;lastFg=c.slice(1);lastBg='';}ln+='▀';}
            else if(fg===bg){const c='\x04'+fg; if(first||lastFg!==fg||lastBg!==''){ln+=c;lastFg=fg;lastBg='';}ln+='█';}
            else {const c='\x04'+fg+','+bg; if(first||lastFg!==fg||lastBg!==bg){ln+=c;lastFg=fg;lastBg=bg;}ln+='▀';}
          } else if(is16){
            const fg=nearestIndex(r1,g1,b1,pal, o.colorMatching), bg=nearestIndex(r2,g2,b2,pal, o.colorMatching);
            if((o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false)||(o.alphaMode==='transparent' ? a2 < o.alphaThreshold : false)){
              const u=(o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false)?bg:fg; const cd='\x03'+u; if(first||lastFg!==String(u)||lastBg!==''){ln+=cd;lastFg=String(u);lastBg='';}ln+=(o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false)?'▄':'▀';
            } else if(fg===bg){
              const need=first || lastBg!==String(bg);
              if(need){ const cd='\x03'+fg+','+bg; ln+=cd; lastFg=String(fg); lastBg=String(bg); }
              ln+=' ';
            } else {
              const needFgOnly=!first && lastBg===String(bg) && lastFg!==String(fg);
              if(needFgOnly){
                const cd='\x03'+fg; ln+=cd; lastFg=String(fg);
              } else if(first||lastFg!==String(fg)||lastBg!==String(bg)){
                const cd='\x03'+fg+','+bg; ln+=cd; lastFg=String(fg); lastBg=String(bg);
              }
              ln+='▀';
            }
          } else {
            const l1=lutLookup(r1,g1,b1,pal,ng, o.colorMatching), l2=lutLookup(r2,g2,b2,pal,ng, o.colorMatching);
            const fgRaw=o.renderMode==='ansi'?l1.ansi:l1.irc; const fg=toEmitIdx(fgRaw, o.renderMode, pal, o.colorMatching); const bgRaw=o.renderMode==='ansi'?l2.ansi:l2.irc; const bg=toEmitIdx(bgRaw, o.renderMode, pal, o.colorMatching);
            if((o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false)||(o.alphaMode==='transparent' ? a2 < o.alphaThreshold : false)){
              const u=(o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false)?bg:fg; const cd='\x03'+u; if(first||lastFg!==String(u)||lastBg!==''){ln+=cd;lastFg=String(u);lastBg='';}ln+=(o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false)?'▄':'▀';
            } else if(fg===bg){
              const need=first || lastBg!==String(bg);
              if(need){ const cd='\x03'+fg+','+bg; ln+=cd; lastFg=String(fg); lastBg=String(bg); }
              ln+=' ';
            } else {
              const needFgOnly=!first && lastBg===String(bg) && lastFg!==String(fg);
              if(needFgOnly){
                const cd='\x03'+fg; ln+=cd; lastFg=String(fg);
              } else if(first||lastFg!==String(fg)||lastBg!==String(bg)){
                const cd='\x03'+fg+','+bg; ln+=cd; lastFg=String(fg); lastBg=String(bg);
              }
              ln+='▀';
            }
          }
          first=false;
        }
        ln=ln.replace(/[ ]+$/g,'');lines.push(ln);
      }
    }
  } else {
    const fullPal=getMidgardPalette(o);
    for(let y=0;y<pH;y++){let ln='',lastCode='',first=true;
      for(let x=0;x<pW;x++){const[r,g,b,a]=pxAt(x,y);
        if((o.alphaMode==='transparent' ? a < o.alphaThreshold : false)||_nearBlack(r,g,b)){ln+=' ';continue;}
        const cd=is16? '\x03'+String(nearestIndex(r,g,b,fullPal, o.colorMatching)) : is24? '\x04'+toHex6(r,g,b) : '\x03'+String(toEmitIdx(o.renderMode==='ansi'? lutLookup(r,g,b,fullPal,ng, o.colorMatching).ansi : lutLookup(r,g,b,fullPal,ng, o.colorMatching).irc, o.renderMode, fullPal, o.colorMatching));
        if(first||lastCode!==cd){ln+=cd;lastCode=cd;}
        ln+='█'; first=false;
      }
      ln=ln.replace(/[ ]+$/g,'');lines.push(ln);
    }
  }

  while(lines.length&&lines[lines.length-1].replace(/[\x03\x04\x0f0-9,a-fA-F]/g,'').trim()==='')lines.pop();
  _timings['emit'] = _perf() - _t;
  _timings['total'] = _perf() - _tStart;
  _lastTimings = { ..._timings };
  if (_shouldLog() || _timings['total'] > 100) {
    const ctx = `pW=${pW} pH=${pH} cols=${cols} rows=${rows} pm=${pm} viterbiW=${o.viterbiW} pal=${getMidgardPalette(o).length} mode=${o.colorMatching} comic=${o.comic} dither=${o.ditherMode} ${typeof OffscreenCanvas!=='undefined'?'OffscreenCanvas':'no-OffscreenCanvas'} ${typeof Worker!=='undefined'?'Worker':'no-Worker'}`;
    const line = Object.entries(_timings).sort((a,b)=>b[1]-a[1]).map(([k,v])=> `${k}:${v.toFixed(1)}ms`).join(' | ');
    console.info(`[img2irc] ${_timings['total'].toFixed(1)}ms total | ${ctx} | ${line}`);
    // Also warn if Viterbi dominates (>80% of total) — suggests need for faster path or smaller S
    if (_timings['viterbi'] && _timings['viterbi'] > _timings['total']*0.8) {
      console.info(`[img2irc] Viterbi dominates (${(_timings['viterbi']/_timings['total']*100).toFixed(0)}%) — cellGlyph:${_timings['viterbi_cellGlyph']?.toFixed(1)}ms rowPal:${_timings['viterbi_rowPal']?.toFixed(1)}ms dp:${_timings['viterbi_dp']?.toFixed(1)}ms — consider viterbiW=0 (greedy) or smaller S for initial preview`);
    }
  }
  return lines.join('\n');
}


export function loadImageFromFile(file:File|Blob):Promise<HTMLImageElement>{
  return new Promise((res,rej)=>{
    const url=URL.createObjectURL(file); const img=new Image();
    img.onload=()=>{(img as any)._url=url; res(img);};
    img.onerror=()=>{URL.revokeObjectURL(url); rej(new Error('Failed to load image'));};
    img.src=url;
  });
}
export function revokeImageUrl(img:HTMLImageElement){const u=(img as any)._url;if(u)URL.revokeObjectURL(u);}

function cssFilter(o:Img2IrcOptions):string{
  const f:string[]=[];
  if(o.brightness!==0)f.push(`brightness(${100+o.brightness}%)`);
  if(o.contrast!==0)f.push(`contrast(${100+o.contrast}%)`);
  if(o.saturation!==0)f.push(`saturate(${100+o.saturation}%)`);
  if(o.hue!==0)f.push(`hue-rotate(${o.hue}deg)`);
  if(o.invert)f.push('invert(100%)'); if(o.grayscale)f.push('grayscale(100%)'); if(o.sepia)f.push('sepia(100%)');
  if(o.blur>0)f.push(`blur(${o.blur}px)`);
  return f.join(' ')||'none';
}

export async function imageToIrcArt(img:HTMLImageElement, opts:Partial<Img2IrcOptions>={}):Promise<string>{
  // Auto-clear LUT if it grew large (prevents unbounded growth across many images)
  if(COLOR_LUT.size>8000) COLOR_LUT.clear();
  const o:Img2IrcOptions={...DEFAULTS,...opts};
  const w=Math.max(MIN_IRC_WIDTH,Math.min(MAX_IRC_WIDTH,o.width));
  const asp=(img.naturalHeight||img.height)/(img.naturalWidth||img.width)||1;
  const pm=o.pixelMode;

  let pW:number,pH:number,cols:number,rows:number;
  if(pm==='braille'){cols=w;pW=cols*2;rows=Math.max(1,Math.round(w*asp*0.45));if(o.height)rows=o.height;pH=rows*4;}
  else if(pm==='quarter'){cols=w;pW=cols*2;rows=Math.max(1,Math.round(w*asp*0.5));if(o.height)rows=o.height;pH=rows*2;}
  else if(pm==='half'){cols=w;pW=cols;rows=Math.max(1,Math.round(w*asp*0.9));if(o.height)rows=o.height;pH=rows*2;}
  else {cols=w;pW=cols;rows=Math.max(1,Math.round(w*asp*0.5));if(o.height)rows=o.height;pH=rows;}
  if(rows>120){rows=120;pH=pm==='braille'?480:pm==='quarter'?240:pm==='half'?240:120;}
  // Handle 90/270 rotate by swapping dimensions so the art isn't clipped
  const isRot90 = o.rotate===90 || o.rotate===270;
  if(isRot90){
    const tmpCols=cols; cols=rows; rows=tmpCols;
    const tmpW=pW; pW=pH; pH=tmpW;
  }

  let eW=pW,eH=pH;
  if(o.pixelize>0){const s=Math.max(2,o.pixelize);eW=Math.max(1,Math.round(pW/s));eH=Math.max(1,Math.round(pH/s));}
  const _tResize0 = _perf();
  const cvs=document.createElement('canvas');cvs.width=eW;cvs.height=eH;
  const ctx=cvs.getContext('2d')!;
  ctx.imageSmoothingEnabled=o.filter!=='nearest';
  (ctx as any).imageSmoothingQuality=o.filter==='nearest'?'low':'high';
  ctx.filter=cssFilter(o);
  if(o.alphaMode==='opaque'){
    ctx.fillStyle=o.background||'#000';ctx.fillRect(0,0,eW,eH);
  } else {
    ctx.clearRect(0,0,eW,eH);
  }
  ctx.save();
  ctx.translate(eW/2, eH/2);
  if(o.rotate) ctx.rotate(o.rotate*Math.PI/180);
  ctx.scale(o.flipH?-1:1, o.flipV?-1:1);
  ctx.drawImage(img, -eW/2, -eH/2, eW, eH);
  ctx.restore();
  ctx.filter='none';
  let src=cvs;
  if(o.pixelize>0){
    const up=document.createElement('canvas');up.width=pW;up.height=pH;
    const uc=up.getContext('2d')!;uc.imageSmoothingEnabled=false;
    uc.drawImage(cvs,0,0,pW,pH);src=up;
  }

  let id=src.getContext('2d')!.getImageData(0,0,pW,pH);
  const _tResize = _perf() - _tResize0;
  (o as unknown as Record<string,unknown>)._debugResizeMs = _tResize;
  let d=id.data;
  if(o.midgardMode==='smart'){
    if(!(o as any)._smartPaletteA) (o as any)._smartPaletteA = smartPaletteA(d as any, pW, pH, 24);
    if(!(o as any)._smartPaletteB) (o as any)._smartPaletteB = smartPaletteB(d as any, pW, pH, 16, 0.02, o.colorMatching);
  }

  return await renderPixelsCore(d, pW, pH, cols, rows, pm, o);
}

// ── Base94 framing — 9 bytes → 11 chars optimal for 94 printable symbols (Base94.lean) ──
// 94 = printable ASCII minus space (33–126). 9→11 is optimal for short blocks: 256⁹ ≤ 94¹¹ < 256¹⁰ demands 11 chars.
// Rate 9/11 = 0.818 beats base64's 3/4 = 0.75 by 12/11 (+9.09%). Per 400B payload: 327B vs 300B.
const B94_CHARS='!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
const B94_MAP: Record<string,number> = Object.fromEntries([...B94_CHARS].map((c,i)=>[c,i]));
export function base94Encode(bytes: Uint8Array): string{
  let out='';
  for(let i=0;i<bytes.length;i+=9){
    const chunk=bytes.subarray(i, Math.min(i+9, bytes.length));
    let n=0n; for(let j=0;j<chunk.length;j++) n = (n<<8n) | BigInt(chunk[j]);
    const need = chunk.length===9 ? 11 : Math.ceil(chunk.length* Math.log(256)/Math.log(94));
    let s=''; for(let k=0;k<need;k++){ s = B94_CHARS[Number(n % 94n)] + s; n/=94n; }
    out+=s;
  }
  return out;
}
export function base94Decode(str: string): Uint8Array{
  const bytes:number[]=[];
  for(let i=0;i<str.length;){
    const isLast = str.length - i < 11;
    const clen = isLast ? str.length - i : 11;
    const chunk=str.slice(i, i+clen); i+=clen;
    let n=0n; for(const c of chunk){ const v=B94_MAP[c]; if(v===undefined) throw new Error(`invalid base94 char: ${c}`); n = n*94n + BigInt(v); }
    const blen = clen===11 ? 9 : Math.floor(clen * Math.log(94)/Math.log(256));
    const tmp:number[]=[]; for(let k=0;k<blen;k++){ tmp.unshift(Number(n & 0xFFn)); n>>=8n; }
    bytes.push(...tmp);
  }
  return new Uint8Array(bytes);
}
export function base94EncodedLength(byteLen: number): number{
  const full=Math.floor(byteLen/9), rem=byteLen%9;
  return full*11 + (rem===0?0:Math.ceil(rem*Math.log(256)/Math.log(94)));
}

// ── Inter-line diff — bitmask vs sparse (InterLineDiff.lean) ──
// sparseCost = k·(idx+val), maskCost = ceil(M/6)+k·val (base64 mask). Mask wins iff ceil(M/6) ≤ k·idx.
export function diffCrossoverK(M:number, idxBytes=2): number{
  const maskOverhead=Math.ceil(M/6);
  return Math.ceil(maskOverhead/idxBytes);
}
export function shouldUseBitmask(M:number, changed:number, idxBytes=2): boolean{
  return Math.ceil(M/6) <= changed*idxBytes;
}
export function estimateDiffSaving(M:number, p:number, valBytes=1, totalBytesPerCell=2): number{
  const maskOverhead=Math.ceil(M/6);
  const expected = maskOverhead/(M*totalBytesPerCell) + p*valBytes/totalBytesPerCell;
  return 1 - expected;
}
export function encodeLineDiff(prev: string[], curr: string[]): { useMask: boolean, payload: string }{
  const M=curr.length;
  const changed:number[]=[];
  for(let i=0;i<M;i++) if(prev[i]!==curr[i]) changed.push(i);
  const k=changed.length;
  if(k===0) return {useMask:false, payload:''};
  if(shouldUseBitmask(M,k)){
    let bits=0n; for(const idx of changed) bits |= 1n << BigInt(idx);
    const maskBytes=Math.ceil(M/8);
    const mask=new Uint8Array(maskBytes);
    for(let i=0;i<maskBytes;i++) mask[i]= Number((bits >> BigInt(i*8)) & 0xFFn);
    const b64Chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let maskB64=''; let buf=0, blen=0;
    for(const by of mask){ buf=(buf<<8)|by; blen+=8; while(blen>=6){ blen-=6; maskB64+=b64Chars[(buf>>blen)&63]; } }
    if(blen>0) maskB64+=b64Chars[(buf<<(6-blen))&63];
    return {useMask:true, payload: maskB64 + ':' + changed.map(i=>curr[i]).join('')};
  }
  return {useMask:false, payload: changed.map(i=>`${i}:${curr[i]}`).join(',')};
}


export async function imageToIrcArtFromBitmap(bitmap: ImageBitmap, opts: Partial<Img2IrcOptions> = {}): Promise<string> {
  if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas not available');
  const o: Img2IrcOptions = { ...DEFAULTS, ...opts } as any;
  const w = Math.max(MIN_IRC_WIDTH, Math.min(MAX_IRC_WIDTH, o.width));
  const asp = (bitmap.height / bitmap.width) || 1;
  const pm = o.pixelMode;
  let pW:number,pH:number,cols:number,rows:number;
  if(pm==='braille'){cols=w;pW=cols*2;rows=Math.max(1,Math.round(w*asp*0.45));if(o.height)rows=o.height;pH=rows*4;}
  else if(pm==='quarter'){cols=w;pW=cols*2;rows=Math.max(1,Math.round(w*asp*0.5));if(o.height)rows=o.height;pH=rows*2;}
  else if(pm==='half'){cols=w;pW=cols;rows=Math.max(1,Math.round(w*asp*0.9));if(o.height)rows=o.height;pH=rows*2;}
  else {cols=w;pW=cols;rows=Math.max(1,Math.round(w*asp*0.5));if(o.height)rows=o.height;pH=rows;}
  if(rows>120){rows=120;pH=pm==='braille'?480:pm==='quarter'?240:pm==='half'?240:120;}
  const isRot90 = o.rotate===90 || o.rotate===270;
  if(isRot90){ const tmpCols=cols; cols=rows; rows=tmpCols; const tmpW=pW; pW=pH; pH=tmpW; }
  let eW=pW,eH=pH;
  if(o.pixelize>0){const s=Math.max(2,o.pixelize);eW=Math.max(1,Math.round(pW/s));eH=Math.max(1,Math.round(pH/s));}
  const _tResize0 = _perf();
  const cvs: any = new (OffscreenCanvas as any)(eW, eH);
  const ctx: any = cvs.getContext('2d')!;
  ctx.imageSmoothingEnabled = o.filter!=='nearest';
  ctx.filter = cssFilter(o);
  if(o.alphaMode==='opaque'){ ctx.fillStyle=o.background||'#000'; ctx.fillRect(0,0,eW,eH); } else { ctx.clearRect(0,0,eW,eH); }
  ctx.save(); ctx.translate(eW/2, eH/2);
  if(o.rotate) ctx.rotate(o.rotate*Math.PI/180);
  ctx.scale(o.flipH?-1:1, o.flipV?-1:1);
  ctx.drawImage(bitmap, -eW/2, -eH/2, eW, eH);
  ctx.restore(); ctx.filter='none';
  let src: any = cvs;
  if(o.pixelize>0){
    const up: any = new (OffscreenCanvas as any)(pW, pH);
    const uc: any = up.getContext('2d')!; uc.imageSmoothingEnabled=false; uc.drawImage(cvs,0,0,pW,pH); src=up;
  }
  let id: any = src.getContext('2d')!.getImageData(0,0,pW,pH);
  const _tResize = _perf() - _tResize0;
  (o as unknown as Record<string,unknown>)._debugResizeMs = _tResize;
  let d: any = id.data;
  if(o.midgardMode==='smart'){
    if(!(o as any)._smartPaletteA) (o as any)._smartPaletteA = smartPaletteA(d as any, pW, pH, 24);
    if(!(o as any)._smartPaletteB) (o as any)._smartPaletteB = smartPaletteB(d as any, pW, pH, 16, 0.02, o.colorMatching);
  }
  return await renderPixelsCore(d, pW, pH, cols, rows, pm, o);
}

export function estimateLineLengths(art:string,maxBytes=IRC_SAFE_PAYLOAD){const ls=art.split('\n');let lg=0;for(const l of ls){const b=new TextEncoder().encode(l).length;if(b>lg)lg=b;}return{ok:lg<=maxBytes,longest:lg,lines:ls.length, total:new TextEncoder().encode(art).length};}
export function stripTrailingReset(line:string){return line.replace(/\x0f$/,'');}
export function serializeImg2IrcOptions(o: Img2IrcOptions): Record<string, unknown> {
  const { _smartPaletteA, _smartPaletteB, ...rest } = o as any;
  return { ...rest };
}
export function deserializeImg2IrcOptions(j: Record<string, unknown>): Partial<Img2IrcOptions> {
  const clone = { ...j } as any;
  delete clone._smartPaletteA; delete clone._smartPaletteB;
  return clone;
}
