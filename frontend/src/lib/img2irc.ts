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
/**
 * UniformTail / UniformHead (Lean): ragged edge analysis.
 *  - Right edge: trailing-space trim is safe iff cells show client default (paint_trim / shown_eq_of_paint_trim).
 *    Safe is safeTrim (right-to-left dropWhile isDefaultBlank) — maximal (safeTrim_last_opaque) and
 *    rectangular_of_last_opaque when last cell opaque. Flat tail is optimal (flatTail_optimal, lineBytes_flatTail_sticky).
 *    Cost: tail fill 1B/cell, never more than pairCost + M·glyph. See UNIFORM_EDGE_FILL.md & UniformTail.lean.
 *  - Left edge: dropping n leading cells SHIFTS column n+i→i (view_drop). Invisible only if whole row is default
 *    (paint_drop_eq_iff_all_default) — practically never. Fix is explicit indent re-emit (paint_leftPad_restore,
 *    paint_leftPad_safeTrimHead), mirror of safeTrim (safeTrimHead_eq_reverse). Left margin costs ≥j+1 bytes
 *    (bytes_ge_of_ink_at) and flat indent is optimal (indent_optimal). Both ends opaque ⇒ full rectangle
 *    (rectangular_of_first_last_opaque). Partial first cell headSub=k−x₀%k full iff k∣x₀; clamp replicates edge
 *    (clampLeft_uniform_first_cell) vs const pad (constPadLeft_uniform_first_cell_iff). Margins tile with parity
 *    (margins_add, rightMargin_sub_leftMargin, margins_balanced_iff). See UNIFORM_EDGE_LEFT.md & UniformHead.lean.
 */
import { getWasm, hasWasmSync, getWasmSync, preloadWasm, tryWasmBatchBestGlyphSync, tryWasmBatchRowPaletteSync, tryWasmBatchNearestSync, tryWasmBatchBestGlyphPolygonSync } from './img2irc.wasm';
import { dpSeg } from './segmentation';
import { safeTrim as uniformSafeTrim } from './uniform';
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
export type PixelMode = 'half' | 'full' | 'quarter' | 'braille' | 'polygon' | 'auto';
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
  /** Matte colour for transparent cells: null = bleed (naked space, cheapest, trimmed); hex = opaque matte (renderCellMatte) */
  matte: string | null; // null | '#rrggbb'
  _smartPaletteA?: number[];
  _smartPaletteB?: number[];
  /** debug only, not serialized — canvas resize ms from caller */
  _debugResizeMs?: number;
  // Glyph catalog — optional alphabet filtering
  glyphAlphabet?: string;
  // Auto compression geometries (for pixelMode auto with viterbi)
  autoGeometries?: PixelMode[];
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
  midgardMode: 'xterm256',
  alphaMode: 'opaque', alphaThreshold: 128, trimTransparent: false, smartEdges: true, background: '#000000', matte: null,
};

// ── Utility ───────────────────────────────────────────────────────────────────
const _pack=(r:number,g:number,b:number)=>((r&255)<<16)|((g&255)<<8)|(b&255);
const _unpack=(rgb:number)=>[(rgb>>16)&255,(rgb>>8)&255,(rgb>>0)&255];
const _isNearGray=(rgb:number,tol=16)=>{const[r,g,b]=_unpack(rgb);return Math.max(r,g,b)-Math.min(r,g,b)<=tol;};
const _nearBlack=(r:number,g:number,b:number)=>r<10&&g<10&&b<10;
const toHex6=(r:number,g:number,b:number)=>r.toString(16).padStart(2,'0')+g.toString(16).padStart(2,'0')+b.toString(16).padStart(2,'0');
const luma=(r:number,g:number,b:number)=>0.299*r+0.587*g+0.114*b;
const codeLen=(n:number)=>n<10?1:2;
// ── Transparency.lean (§3) — bleed-through is exactly transparency, matte & opaque escape hatches ──
/** Lean Coverage.bleedsThrough — ¬rendersOpaque */
/** Lean renderPolicySound — bleeds → isEmptyTransparent */
/** Lean opaque_mode_no_bleed / matte_no_bleed — thresh 0 or matte ≠99 ⇒ no bleed */
export function parseMatteHex(hex: string | null): [number,number,number] | null {
  if(!hex || hex==='transparent') return null;
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if(!m) return null;
  const v = parseInt(m[1],16);
  return [(v>>16)&255, (v>>8)&255, v&255];
}
export function getMatteIdx(o: Img2IrcOptions, pal: number[]): number | null {
  const rgb = parseMatteHex((o as any).matte ?? null);
  if(!rgb) return null;
  return nearestIndex(rgb[0],rgb[1],rgb[2], pal, o.colorMatching);
}
/** Lean isEmptyTransparent — both alphas below threshold when alphaMode transparent */
export function isEmptyTransparent(a1:number,a2:number,o: Img2IrcOptions): boolean {
  return (o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false) && (o.alphaMode==='transparent' ? a2 < o.alphaThreshold : false);
}
/** Lean renderCellMatte branch — matte opaque vs bleed */
export function shouldBleed(o: Img2IrcOptions, isEmpty: boolean): boolean {
  return isEmpty && !parseMatteHex((o as any).matte ?? null);
}

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

export function smartPaletteA(d: Uint8ClampedArray, pW:number, pH:number, K=24, mode: ColorMatching='oklab'): number[] {
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
  // Smart palette respects colorMatching: rgb → RGB Euclidean, else OkLab (perceptual, best for truecolor)
  const useRgb = mode==='rgb';
  const convPts: number[][] = useRgb ? pts : pts.map(c=> srgbToOkLab(c[0],c[1],c[2]) as any);
  // deterministic PRNG (xorshift32 seeded from content hash)
  let seed = 0x9e3779b9 ^ (pts.length * 2654435761) >>> 0;
  for(let i=0;i<Math.min(pts.length, 16); i++) seed ^= (pts[i][0]*374761393 + pts[i][1]*668265263 + pts[i][2]*1274126177) >>> 0;
  const rnd = ()=>{ seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed>>>0)/4294967296; };
  const cents: number[][] = [];
  cents.push([...convPts[Math.floor(rnd()*convPts.length)]]);
  const dist2 = new Float64Array(convPts.length).fill(Infinity);
  while(cents.length < Kc){
    let sum=0;
    const last = cents[cents.length-1];
    for(let i=0;i<convPts.length;i++){
      const dl=convPts[i][0]-last[0], da=convPts[i][1]-last[1], db=convPts[i][2]-last[2];
      const d2=dl*dl+da*da+db*db;
      if(d2 < dist2[i]) dist2[i]=d2;
      sum+=dist2[i];
    }
    if(sum===0) break;
    let r = rnd()*sum;
    let pick = convPts.length-1;
    for(let i=0;i<convPts.length;i++){ r-=dist2[i]; if(r<=0){ pick=i; break; } }
    cents.push([...convPts[pick]]);
  }
  for(let iter=0; iter<20; iter++){
    const sums = cents.map(()=>[0,0,0]);
    const counts = new Array(cents.length).fill(0);
    for(let i=0;i<convPts.length;i++){
      let bi=0, bd=Infinity;
      for(let c=0;c<cents.length;c++){ const dl=convPts[i][0]-cents[c][0], da=convPts[i][1]-cents[c][1], db=convPts[i][2]-cents[c][2]; const d2=dl*dl+da*da+db*db; if(d2<bd){bd=d2; bi=c;} }
      sums[bi][0]+=convPts[i][0]; sums[bi][1]+=convPts[i][1]; sums[bi][2]+=convPts[i][2]; counts[bi]++;
    }
    for(let c=0;c<cents.length;c++) if(counts[c]>0){ cents[c][0]=sums[c][0]/counts[c]; cents[c][1]=sums[c][1]/counts[c]; cents[c][2]=sums[c][2]/counts[c]; }
  }
  if(useRgb) return cents.map(c=> ((c[0]|0)<<16)|((c[1]|0)<<8)|(c[2]|0));
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

// ── Clustering.lean (§2.3/§2.5/§3.3,§3.5) — centroids, two-colour threshold, k-means ──
// OkLab squared distance is squared norm of an inner-product space, so Lean holds:
//   sum_sq_dist_decomp, centroid_minimizes, threshold_minimizes, nearest_eq_threshold,
//   exists_optimal_split, kmObjective  (assign/centroid/index steps) + descent antitone/converges.
/** Lean IrcCluster.centroid s x = (|s|⁻¹ • Σ x) — OkLab mean */
export function okLabCentroid(pts: number[][]): number[] {
  if (pts.length===0) return [0,0,0];
  let L=0,a=0,b=0; for(const p of pts){ L+=p[0]; a+=p[1]; b+=p[2]; }
  const n=pts.length; return [L/n, a/n, b/n];
}
/** Σ‖xᵢ−c‖² in OkLab */
export function okLabSumSqDist(pts: number[][], c:number[]): number {
  let s=0; for(const p of pts){ const dL=p[0]-c[0], da=p[1]-c[1], db=p[2]-c[2]; s+=dL*dL+da*da+db*db; } return s;
}
/** Lean sum_sq_dist_decomp: Σ‖x−c‖² = Σ‖x−mean‖² + n‖c−mean‖² */
export function okLabSumSqDistDecomp(pts: number[][], c:number[]): { left:number, right:number, mean:number[] } {
  const m=okLabCentroid(pts);
  const left=okLabSumSqDist(pts,c);
  const sumMean=okLabSumSqDist(pts,m);
  const dmL=c[0]-m[0], dma=c[1]-m[1], dmb=c[2]-m[2];
  const right=sumMean + pts.length*(dmL*dmL+dma*dma+dmb*dmb);
  return { left, right, mean:m };
}
/** Lean thresholdSet / nearestSet : optimal two-colour split is a luminance threshold at largest gap */
export function luminanceThresholdForSplit(lumas:number[]): number {
  if(lumas.length===0) return 127;
  const sorted=[...lumas].sort((a,b)=>a-b);
  let maxGap=-1, idx=0;
  for(let i=1;i<sorted.length;i++){ const g=sorted[i]-sorted[i-1]; if(g>maxGap){maxGap=g; idx=i;}}
  return maxGap>16 ? (sorted[idx]+sorted[idx-1])/2 : 127;
}
/** Lean splitCost / cellCost for luminance (squared error) */
export function luminanceSplitCost(lumas:number[], S:Set<number>, c1:number, c2:number): number {
  let s=0; for(let i=0;i<lumas.length;i++){ const x=lumas[i]; s += S.has(i) ? (x-c1)*(x-c1) : (x-c2)*(x-c2); } return s;
}
export function luminanceCellCost(lumas:number[], S:Set<number>): number {
  let s1=0,c1=0,s2=0,c2=0;
  for(let i=0;i<lumas.length;i++){ if(S.has(i)){s1+=lumas[i]; c1++;} else {s2+=lumas[i]; c2++;} }
  const m1=c1? s1/c1:0, m2=c2? s2/c2:0;
  return luminanceSplitCost(lumas,S,m1,m2);
}
/** Lean kmObjective: Σ‖xᵢ−c[aᵢ]‖² + pen[aᵢ] — pen = wire cost of index (codeLen) */
export function kmObjectiveOkLab(pts:number[][], pen:number[], assign:(i:number)=>number, cents:number[][]): number {
  let s=0; for(let i=0;i<pts.length;i++){ const k=assign(i); const c=cents[k]; const dL=pts[i][0]-c[0], da=pts[i][1]-c[1], db=pts[i][2]-c[2]; s += dL*dL+da*da+db*db + (pen[k] ?? 0); } return s;
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
// Polygon masks: hp(a,b) filter a*(2r+1-8)+b*(2c+1-8) ≤0, 8×8 row-major bigint (bit r*8+c set if inked). ct/cb derived from mask popcount per half (top 32 vs bottom 32) for coverage pruning.
// ── GlyphCoverage.lean (§2.2/§3.2) — lean-exposed pure helpers (mirror Lean defs) ──
/** Lean Glyph.blend c fg bg = c*fg + (1-c)*bg */
export function glyphBlend(c:number, fg:number, bg:number): number { return c*fg + (1-c)*bg; }
/** Lean Glyph.cellCost w ct cb bytes tTop tBot fg bg */
export function glyphCellCost(w:number, ct:number, cb:number, bytes:number, tTop:number, tBot:number, fg:number, bg:number): number {
  return Math.abs(tTop - glyphBlend(ct, fg, bg)) + Math.abs(tBot - glyphBlend(cb, fg, bg)) + w*bytes;
}
/** Lean Glyph.coverages — measured safe alphabet (+ complements) */
export const GLYPH_COVERAGES: number[] = [0, 121/1000, 254/1000, 273/1000, 4945/10000, 5055/10000, 727/1000, 746/1000, 879/1000, 1];
/** Lean Glyph.bandError cmax r = max(r-cmax, 1-2r)/2 */
export function glyphBandError(cmax:number, r:number): number { return Math.max(r - cmax, 1 - 2*r) / 2; }
/** Lean Glyph.optimal_block_coverage r* = (1+cmax)/3 */
export function glyphOptimalBlockCoverage(cmax:number): number { return (1 + cmax) / 3; }
/** Lean Glyph.dominated_of_byte_gap criterion: (|Δct|+|Δcb|)*contrast ≤ w*Δbytes → dominated */
export function glyphDominatedByByteGap(w:number, ct:number, cb:number, bytes:number, ct2:number, cb2:number, bytes2:number, contrast:number): boolean {
  return (Math.abs(ct-ct2) + Math.abs(cb-cb2)) * Math.abs(contrast) <= w * (bytes - bytes2);
}
const GLYPHS: Array<{ch:string, ct:number, cb:number, bytes:number, mask?:bigint}> = [
  // 1-byte: coloured space + ASCII ramp (safe after \x03 — no digit/comma, no leading '/' )
  {ch:' ', ct:0.0,   cb:0.0,   bytes:1, mask:0x0000000000000000n}, // 0.000
  {ch:'=', ct:0.122, cb:0.120, bytes:1}, // 0.121
  {ch:'Q', ct:0.247, cb:0.261, bytes:1}, // 0.254
  {ch:'B', ct:0.294, cb:0.253, bytes:1}, // 0.273 densest safe (0/8 are unsafe digits)
  {ch:'*', ct:0.183, cb:0.010, bytes:1}, // light ▀  (top-bottom +0.173)
  {ch:'g', ct:0.149, cb:0.321, bytes:1}, // light ▄  (top-bottom -0.172)
  {ch:'F', ct:0.245, cb:0.107, bytes:1}, // light ▀ variant
  // 3-byte block elements
  {ch:'▀', ct:1.0,   cb:0.0,   bytes:3, mask:0x00000000ffffffffn}, // half top=fg bottom=bg (32/32 top, 0/32 bottom)
  {ch:'▄', ct:0.0,   cb:1.0,   bytes:3, mask:0xffffffff00000000n}, // complement
  {ch:'▒', ct:0.490, cb:0.499, bytes:3}, // measured DejaVu 0.490/0.499 (avg 0.4945); optimum r*=0.4243 would be 32% lower band error (0.07567 vs 0.11075) per GlyphCoverage.lean but no glyph measures there — known suboptimal gap, closest Unicode to r* is ▒
  // dominated but kept — Viterbi never picks over 1-byte/▀▄ at same ΔE (up to contrast ≈41 per GlyphCoverage.lean)
  {ch:'░', ct:0.183, cb:0.181, bytes:3},
  {ch:'▓', ct:0.796, cb:0.816, bytes:3},
  {ch:'█', ct:1.0,   cb:1.0,   bytes:3, mask:0xffffffffffffffffn}, // never best vs ' ' (same error, 3B vs 1B) — kept to prove dominated
  // Polygon axis: vertical halves (ct==cb==0.5, distinguished by mask)
  {ch:'▌', ct:0.5,   cb:0.5,   bytes:3, mask:0x0f0f0f0f0f0f0f0fn},
  {ch:'▐', ct:0.5,   cb:0.5,   bytes:3, mask:0xf0f0f0f0f0f0f0f0n},
  // Polygon diagonals: corner triangles (hp 1 1 etc). ▌▐ already cover axis; triangles halve worst-case error 16→8.
  {ch:'◤', ct:0.8125, cb:0.3125, bytes:3, mask:0x0103070f1f3f7fffn},
  {ch:'◢', ct:0.1875, cb:0.6875, bytes:3, mask:0xfefcf8f0e0c08000n},
  {ch:'◥', ct:0.8125, cb:0.3125, bytes:3, mask:0x80c0e0f0f8fcfeffn},
  {ch:'◣', ct:0.1875, cb:0.6875, bytes:3, mask:0x7f3f1f0f07030100n},
];
export { GLYPHS };
const _glyphCache = new Map<string, typeof GLYPHS>();
export function glyphsToTable(chars: string): typeof GLYPHS {
  if (!chars) return GLYPHS;
  const hit = _glyphCache.get(chars);
  if (hit) return hit;
  const out: typeof GLYPHS = [];
  const seen = new Set<string>();
  const byCh = new Map<string, typeof GLYPHS[number]>();
  for (const g of GLYPHS) byCh.set(g.ch, g);
  const sp = byCh.get(' ');
  if (sp) { out.push(sp); seen.add(' '); }
  for (const ch of chars) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    const known = byCh.get(ch);
    if (known) out.push(known);
    else out.push({ ch, ct: 0, cb: 1, bytes: 1 });
  }
  if (out.length <= 1) return GLYPHS;
  if (_glyphCache.size >= 8) { const k = _glyphCache.keys().next().value as string; _glyphCache.delete(k); }
  _glyphCache.set(chars, out);
  return out;
}
export function getFilteredGlyphs(o: Img2IrcOptions): typeof GLYPHS | null {
  if (o.glyphAlphabet != null) return glyphsToTable(o.glyphAlphabet);
  return null;
}
export function collectGlyphAlphabet(opts: { glyphAlphabet?: string; glyphGroupsChars?: string; glyphInclude?: string; glyphExclude?: string; glyphIncludeRanges?: string[]; glyphExcludeRanges?: string[] }): string | undefined {
  let base = opts.glyphGroupsChars ?? opts.glyphAlphabet;
  if (base == null) return undefined;
  let chars = base;
  if (opts.glyphInclude || opts.glyphExclude) {
    const incSet = opts.glyphInclude ? new Set([...opts.glyphInclude]) : null;
    const excSet = opts.glyphExclude ? new Set([...opts.glyphExclude]) : null;
    let f=''; for (const ch of chars){ if(incSet && !incSet.has(ch)) continue; if(excSet && excSet.has(ch)) continue; f+=ch; } chars=f;
    if (incSet && chars.length===0) chars=opts.glyphInclude!;
  }
  const incR = opts.glyphIncludeRanges ?? []; const excR = opts.glyphExcludeRanges ?? [];
  if (incR.length || excR.length){
    const parseOne=(t:string)=>{ const m=t.match(/^([0-9a-f]{1,6})-([0-9a-f]{1,6})$/i); if(!m) throw new Error(`Invalid Unicode range "${t}"; use hexadecimal START-END`); const s=parseInt(m[1],16), e=parseInt(m[2],16); if(s>e) throw new Error(`Invalid Unicode range "${t}"; use hexadecimal START-END`); return [s,e] as [number,number]; };
    const incRanges=incR.map(parseOne); const excRanges=excR.map(parseOne);
    let out=''; for(const ch of chars){ const cp=ch.codePointAt(0)!; if(incRanges.length){ let ok=false; for(const [s,e] of incRanges) if(cp>=s&&cp<=e){ok=true;break;} if(!ok) continue; } if(excRanges.length){ let bad=false; for(const [s,e] of excRanges) if(cp>=s&&cp<=e){bad=true;break;} if(bad) continue; } out+=ch; } chars=out;
  }
  return chars || undefined;
}
const GLYPH_BYTES_HALF=3, GLYPH_BYTES_SPACE=1;
export function bestGlyphForState(
  r1:number,g1:number,b1:number, r2:number,g2:number,b2:number,
  f:number,b:number, pal:number[], mode:ColorMatching, w:number, palOkLab?: number[][] | null, glyphs?: typeof GLYPHS
):{err:number, bytes:number, glyph:string}{
  const table = glyphs ?? GLYPHS;
  const useWasm = !glyphs;
  // WASM fast path — pick best glyph index via wasm (8× fewer cbrt), then compute err/bytes from GLYPHS table
  if (useWasm) {
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
  }
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
  for(const g of table){
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
// ── Polygon helpers — mask model for diagonal half-plane cuts ──────────────────
const POPCNT8: Uint8Array = (()=>{ const a=new Uint8Array(256); for(let i=0;i<256;i++){ let c=0,v=i; while(v){c+=v&1; v>>=1;} a[i]=c; } return a; })();
function popcnt64(m: bigint): number {
  let c=0;
  let x=m;
  for(let i=0;i<8;i++){ c+=POPCNT8[Number(x & 0xFFn)]; x >>= 8n; }
  return c;
}
export function maskFromSubpixels(s: Uint8Array): bigint {
  let m=0n;
  for(let i=0;i<64;i++) if(s[i]) m |= 1n << BigInt(i);
  return m;
}
function _bilinearSample(d: Uint8ClampedArray, pW:number, pH:number, fx:number, fy:number): [number,number,number,number] {
  const x0=Math.floor(fx), y0=Math.floor(fy), x1=x0+1, y1=y0+1;
  const ax=fx-x0, ay=fy-y0;
  const i00 = (y0>=0&&y0<pH&&x0>=0&&x0<pW) ? (y0*pW+x0)*4 : -1;
  const i10 = (y0>=0&&y0<pH&&x1>=0&&x1<pW) ? (y0*pW+x1)*4 : -1;
  const i01 = (y1>=0&&y1<pH&&x0>=0&&x0<pW) ? (y1*pW+x0)*4 : -1;
  const i11 = (y1>=0&&y1<pH&&x1>=0&&x1<pW) ? (y1*pW+x1)*4 : -1;
  const s=(idx:number)=> idx>=0 ? [d[idx],d[idx+1],d[idx+2],d[idx+3]] as [number,number,number,number] : [0,0,0,0] as [number,number,number,number];
  const [r00,g00,b00,a00]=s(i00), [r10,g10,b10,a10]=s(i10), [r01,g01,b01,a01]=s(i01), [r11,g11,b11,a11]=s(i11);
  const r = (1-ax)*(1-ay)*r00 + ax*(1-ay)*r10 + (1-ax)*ay*r01 + ax*ay*r11;
  const g = (1-ax)*(1-ay)*g00 + ax*(1-ay)*g10 + (1-ax)*ay*g01 + ax*ay*g11;
  const b = (1-ax)*(1-ay)*b00 + ax*(1-ay)*b10 + (1-ax)*ay*b01 + ax*ay*b11;
  const a = (1-ax)*(1-ay)*a00 + ax*(1-ay)*a10 + (1-ax)*ay*a01 + ax*ay*a11;
  return [r|0,g|0,b|0,a|0];
}
export function _polygonCellMask(d: Uint8ClampedArray, pW:number, pH:number, c:number, r:number, o: Img2IrcOptions): {mask:bigint, fg:[number,number,number], bg:[number,number,number], empty:boolean} {
  let onR=0,onG=0,onB=0,onC=0, offR=0,offG=0,offB=0,offC=0;
  let mask=0n;
  let transCount=0;
  let lumas: number[] = [];
  const samples: Array<[number,number,number,number]> = [];
  for(let sy=0;sy<8;sy++) for(let sx=0;sx<8;sx++){
    const fx = c + (sx+0.5)/8;
    const fy = r + (sy+0.5)/8;
    const [rr,gg,bb,aa] = _bilinearSample(d, pW, pH, fx, fy);
    samples.push([rr,gg,bb,aa]);
    if(o.alphaMode==='transparent' && aa < o.alphaThreshold) transCount++;
    lumas.push(luma(rr,gg,bb));
  }
  if(transCount >= 32) return {mask:0n, fg:[0,0,0], bg:[0,0,0], empty:false}; // smart bg: transparent 8x8 still opaque
  // Clustering.lean IrcCluster.threshold_minimizes / nearest_eq_threshold:
  // optimal two-colour split is a luminance threshold at the largest gap of sorted lumas.
  const sorted=[...lumas].sort((a,b)=>a-b);
  let maxGap=-1, gapIdx=32;
  for(let i=1;i<64;i++){ const gap=sorted[i]-sorted[i-1]; if(gap>maxGap){maxGap=gap; gapIdx=i;}}
  const thresh = maxGap>16 ? (sorted[gapIdx]+sorted[gapIdx-1])/2 : 127;
  for(let i=0;i<64;i++){
    const [rr,gg,bb]=samples[i];
    const isFg = luma(rr,gg,bb) > thresh;
    if(isFg){ mask |= 1n << BigInt(i); onR+=rr; onG+=gg; onB+=bb; onC++; } else { offR+=rr; offG+=gg; offB+=bb; offC++; }
  }
  if(onC===0 || offC===0){
    const avgR = onC ? onR/onC|0 : offR/offC|0;
    const avgG = onC ? onG/onC|0 : offG/offC|0;
    const avgB = onC ? onB/onC|0 : offB/offC|0;
    return {mask:0n, fg:[avgR,avgG,avgB], bg:[avgR,avgG,avgB], empty:false};
  }
  return {mask, fg:[onR/onC|0,onG/onC|0,onB/onC|0], bg:[offR/offC|0,offG/offC|0,offB/offC|0], empty:false};
}
export function bestGlyphForPolygon(
  cellMask: bigint,
  f: number, b: number,
  pal: number[], mode: ColorMatching, w: number, palOkLab?: number[][]|null
): {err:number, bytes:number, glyph:string, mask:bigint} {
  const fRgb=(pal[f]>>16)&255, fG=(pal[f]>>8)&255, fB=pal[f]&255;
  const bRgb=(pal[b]>>16)&255, bG=(pal[b]>>8)&255, bB=pal[b]&255;
  let contrast: number;
  if(mode==='oklab'){
    const fOk = palOkLab && f<pal.length ? palOkLab[f] : srgbToOkLab(fRgb,fG,fB);
    const bOk = palOkLab && b<pal.length ? palOkLab[b] : srgbToOkLab(bRgb,bG,bB);
    contrast = oklabDeltaE2(fOk,bOk) * 85000;
  } else {
    contrast = colorDist2(fRgb,fG,fB,bRgb,bG,bB,mode);
  }
  let bestErr=Infinity, bestB=3, bestG=' ', bestMask=0n;
  for(const g of GLYPHS){
    if(g.mask==null) continue;
    const d = popcnt64(cellMask ^ g.mask);
    const err = d * contrast / 64 + w * g.bytes;
    if(err < bestErr + 1e-9){
      bestErr = err;
      bestB = g.bytes;
      bestG = g.ch;
      bestMask = g.mask;
    }
  }
  const base = popcnt64(cellMask ^ bestMask) * contrast / 64;
  return {err: base, bytes: bestB, glyph: bestG, mask: bestMask};
}
export async function probePolygonGlyphs(): Promise<boolean> {
  try{
    if(typeof document==='undefined') return true;
    const c=document.createElement('canvas'); c.width=64; c.height=32;
    const ctx=c.getContext('2d'); if(!ctx) return true;
    ctx.font='16px "DejaVu Sans Mono", monospace';
    const m1=ctx.measureText('◤◥');
    const m2=ctx.measureText('◣◢');
    const m3=ctx.measureText('▀');
    const w1=m1.width/2, w2=m2.width/2, w3=m3.width;
    const ok = Math.abs(w1 - w3) < 3 && Math.abs(w2 - w3) < 3 && w1 < w3*1.5;
    try{ localStorage.setItem('img2irc:polygonProbe', ok?'1':'0'); } catch{}
    return ok;
  } catch { return true; }
}

/** Greedy Hungarian-inspired palette selection with single-digit bias (PaletteAssignment.lean + OneDigitNonMonotone.lean).
 * Lean: digits j = 1 if j<10 else 2, prefixCost f σ = Σ f·digits, assignCost = prefixCost + λ·Σ f·ΔE,
 * exists_optimal_assignment (Hungarian finite), prefixCost_eq = Σf + Σ_{¬single} f, card_oneDigit_le ≤10,
 * topSum = max weight on ≤10 singles, prefixCost_ge = 2Σf - topSum ≤ prefixCost,
 * greedy_prefix_optimal (max single weight optimal for prefix), greedy_gap_le ≤ λ·Dmax·Σf.
 * OneDigitNonMonotone: restricting to singles can raise cost 23→28 and bytes 3→8 (sticky prefix) — so we bias, not restrict.
 * Picks up to `size` indices minimising Σ f·digits(σ) + λ·f·ΔE, approximated by
 * frequency rank + digit-length penalty. λ≈0.02 biases toward 1-digit without hurting ΔE much (gap ≤0.02·Dmax·Σf).
 */
export function rowPaletteForViterbi(
  tops:Array<[number,number,number,number]>, bots:Array<[number,number,number,number]>,
  pal:number[], ng:boolean, mode:ColorMatching, size=12
):number[]{
  const k=2, freq=new Map<number,number>();
  const lambda=0.02;
  for(let c=0;c<tops.length;c++){
    const [r1,g1,b1]=tops[c], [r2,g2,b2]=bots[c];
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
  o: Img2IrcOptions,
  signal?: AbortSignal
): Promise<string> {
  const _tStart = _perf();
  const _timings: Record<string, number> = {};
  if ((o as Img2IrcOptions)._debugResizeMs != null) _timings['resize'] = (o as Img2IrcOptions)._debugResizeMs as number;
  const _checkAbort = () => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
  const _maybeYield = async (row: number) => { if (row % 16 === 0) await new Promise<void>(res => setTimeout(res, 0)); };
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
  const _activeGlyphs = getFilteredGlyphs(o) ?? GLYPHS;
  const _useCustomGlyphs = _activeGlyphs !== GLYPHS;
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
      _checkAbort(); await _maybeYield(r);
      for(let c=0;c<cols;c++){let br=0x2800,sR=0,sG=0,sB=0,sN=0;
        for(const[dx,dy,bit]of POS){const x=c*2+dx,y=r*4+dy;const[rr,gg,bb,aa]=pxAt(x,y);if((o.alphaMode==='transparent' ? aa < o.alphaThreshold : false))continue;if(luma(rr,gg,bb)>127){br|=bit;sR+=rr;sG+=gg;sB+=bb;sN++;}}
        const code=is16? '\x03'+String(nearestIndex(sR/sN|0,sG/sN|0,sB/sN|0,palB, o.colorMatching)) : is24? '\x04'+toHex6(sR/sN|0,sG/sN|0,sB/sN|0) : '\x03'+String(toEmitIdx(o.renderMode==='ansi'? lutLookup(sR/sN|0,sG/sN|0,sB/sN|0,palB,ng, o.colorMatching).ansi : lutLookup(sR/sN|0,sG/sN|0,sB/sN|0,palB,ng, o.colorMatching).irc, o.renderMode, palB, o.colorMatching));
        if(first||lastCode!==code){ln+=code;lastCode=code;}
        ln+=String.fromCharCode(br);first=false;
      }
      lines.push(ln);
    }
  } else if(pm==='quarter'){
    const qPal=getMidgardPalette(o);
    const qMap=[' ','▘','▝','▀','▖','▌','▞','▛','▗','▚','▐','▜','▄','▙','▟','█'];
    for(let r=0;r<rows;r++){let ln='',lastFg='',lastBg='',first=true;
      _checkAbort(); await _maybeYield(r);
      for(let c=0;c<cols;c++){
        const p=[[pxAt(c*2,r*2),pxAt(c*2+1,r*2)],[pxAt(c*2,r*2+1),pxAt(c*2+1,r*2+1)]];
        const b=[0,1,2,3].map(i=>luma(p[i>>1][i&1][0],p[i>>1][i&1][1],p[i>>1][i&1][2])>127?1:0);
        const bits=b[0]|(b[1]<<1)|(b[2]<<2)|(b[3]<<3), ch=qMap[bits]||' ';
        if(ch===' '){ const avgR=(p[0][0][0]+p[0][1][0]+p[1][0][0]+p[1][1][0])/4|0, avgG=(p[0][0][1]+p[0][1][1]+p[1][0][1]+p[1][1][1])/4|0, avgB=(p[0][0][2]+p[0][1][2]+p[1][0][2]+p[1][1][2])/4|0; const bgS=String(toEmitIdx(lutLookup(avgR,avgG,avgB,qPal,o.nograyscale, o.colorMatching).irc,'irc',qPal, o.colorMatching)); const need=first||lastFg!==bgS||lastBg!==bgS; if(need){ const cd='\x03'+bgS+','+bgS; ln+=cd; lastFg=bgS; lastBg=bgS; } ln+=' '; first=false; continue; }
        let onR=0,onG=0,onB=0,onC=0, offR=0,offG=0,offB=0,offC=0;
        for(let i=0;i<4;i++){const[rr,gg,bb,aa]=p[i>>1][i&1];if((o.alphaMode==='transparent' ? aa < o.alphaThreshold : false))continue;if(b[i]){onR+=rr;onG+=gg;onB+=bb;onC++;}else{offR+=rr;offG+=gg;offB+=bb;offC++;}}
        if(onC===0){ const _matteQ = parseMatteHex((o as any).matte ?? null); if(_matteQ){ const matteIdxQ = nearestIndex(_matteQ[0],_matteQ[1],_matteQ[2], qPal, o.colorMatching); const matteStrQ=String(matteIdxQ); const needQ = first || lastBg!==matteStrQ; if(needQ){ const cd='\x03'+matteStrQ+','+matteStrQ; ln+=cd; lastFg=matteStrQ; lastBg=matteStrQ; } ln+=' '; first=false; continue; } else { ln+=' ';first=false;continue; }}
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
      lines.push(ln);
    }
  } else if(pm==='half'){
    const pal=getMidgardPalette(o);
    const smart24 = (o as any).midgardMode==='smart' && (o as any)._smartPaletteA && o.renderMode==='ansi24';
    const isTrueColor = (o as any).midgardMode==='truecolor' && o.renderMode==='ansi24';
    const totalCells = cols*rows;
    const glyphCount = _activeGlyphs.length;
    const thresh = hasWasmSync() ? 5000 : 1200;
    const useViterbi = o.viterbiW>0 && cols>1 && totalCells <= thresh && glyphCount <= 32 && (smart24 || !is24 || isTrueColor);
    if(useViterbi){
      const _tViterbi = _perf();
      let _tRowPal=0, _tCellGlyph=0, _tDP=0;
      let _maxS = 0;
      for(let r=0;r<rows;r++){
      _checkAbort(); await _maybeYield(r);
        const tops:Array<[number,number,number,number]>=[], bots:Array<[number,number,number,number]>=[];
        for(let c=0;c<cols;c++){ tops.push(pxAt(c,r*2)); bots.push(pxAt(c,r*2+1)); }
        // smart bg: no allEmpty — every row renders opaque (no bleed)
        let S: number[];
        let _tr = _perf();
        if((o as any).midgardMode==='smart' && (o as any)._smartPaletteB && !smart24){
          S = (o as any)._smartPaletteB as number[];
        } else if(smart24){
          const fullA = (o as any)._smartPaletteA as number[];
          const sSize = totalCells > 1200 ? 6 : cols >= 100 ? 12 : 16;
          const top = rankSmartPaletteA(d, pW, pH, fullA, Math.min(sSize, fullA.length), o.colorMatching);
          S = top;
        } else if(isTrueColor){
          const sSize = cols >= 100 ? 4 : 6;
          // Truecolor: use smaller palette for speed (was 12, now 8/6 to keep 60*64=3840 < 65536 and 60*36=2160 for WASM)
          let truePal2 = (o as any)._truePalette as number[] | undefined;
          if(!truePal2){
            truePal2 = smartPaletteA(d, pW, pH, 8, o.colorMatching);
            (o as any)._truePalette = truePal2;
          }
          const top = rankSmartPaletteA(d, pW, pH, truePal2, Math.min(sSize, truePal2.length), o.colorMatching);
          S = top;
        } else {
          const sSize = totalCells > 1200 ? 6 : cols >= 100 ? 10 : 12;
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
        const effPal = isTrueColor ? ((o as any)._truePalette as number[] || pal) : smart24 ? ((o as any)._smartPaletteA as number[]) : pal;
        const _rowPalOkLab = o.colorMatching==='oklab' ? getPalOkLab(effPal) : null;
        // Try batched WASM path — one crossing per row instead of M*S
        let usedBatch = false;
        if (!_useCustomGlyphs && hasWasmSync() && states.length > 0 && M * states.length <= 65536) {
          const r1Arr = new Uint8Array(M), g1Arr = new Uint8Array(M), b1Arr = new Uint8Array(M);
          const r2Arr = new Uint8Array(M), g2Arr = new Uint8Array(M), b2Arr = new Uint8Array(M);
          for(let i=0;i<M;i++){
            let [r1,g1,b1,a1]=tops[i]; let [r2,g2,b2,a2]=bots[i];
            const isEmptyTrans=(o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false) && (o.alphaMode==='transparent' ? a2 < o.alphaThreshold : false);
            const matteRgb = parseMatteHex((o as any).matte ?? null);
            const isEmpty = isEmptyTrans && !matteRgb;
            cellIsEmpty[i]=isEmpty;
            if(isEmptyTrans && matteRgb){ r1=matteRgb[0]; g1=matteRgb[1]; b1=matteRgb[2]; r2=matteRgb[0]; g2=matteRgb[1]; b2=matteRgb[2]; }
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
            let [r1,g1,b1,a1]=tops[i]; let [r2,g2,b2,a2]=bots[i];
            const isEmptyTrans=(o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false) && (o.alphaMode==='transparent' ? a2 < o.alphaThreshold : false);
            const matteRgb = parseMatteHex((o as any).matte ?? null);
            const isEmpty = isEmptyTrans && !matteRgb;
            cellIsEmpty[i]=isEmpty;
            if(isEmpty){ cellGlyph[i]=[]; continue; }
            if(isEmptyTrans && matteRgb){ r1=matteRgb[0]; g1=matteRgb[1]; b1=matteRgb[2]; r2=matteRgb[0]; g2=matteRgb[1]; b2=matteRgb[2]; }
            const rowGlyphs: GlyphInfo[] = new Array(states.length);
            for(let s=0;s<states.length;s++){
              const [f,b]=states[s];
              rowGlyphs[s]=bestGlyphForState(r1,g1,b1,r2,g2,b2,f,b,effPal,o.colorMatching,o.viterbiW, _rowPalOkLab, _useCustomGlyphs ? _activeGlyphs : undefined);
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
        const firstNonEmpty = cellIsEmpty.findIndex(v => !v);
        for(let s=0;s<states.length;s++){
          if(cellIsEmpty[0]){
            dp[s]=0;
          } else {
            const g=cellGlyph[0][s];
            const [f,b]=states[s];
            if(smart24 || isTrueColor){
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
            // Lean extension: spaces carry no cost and preserve IRC state — ViterbiDP has no empty concept
            const nd = dp.slice();
            for(let s=0;s<states.length;s++) back[i][s]=s;
            dp=nd;
            continue;
          }
          // First non-empty after leading spaces must pay full pair prefix (init cost)
          const isFirstNonEmpty = i === firstNonEmpty;
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
            if(isFirstNonEmpty){
              if(smart24 || isTrueColor){
                nd[s]=g.err + o.viterbiW*(g.bytes + 14);
              } else {
                const fgM=_palToIrcEff ? _palToIrcEff[f & 255] : f, bgM=_palToIrcEff ? _palToIrcEff[b & 255] : b;
                const pc=pairPref(fgM,bgM);
                nd[s]=g.err + o.viterbiW*(g.bytes + pc);
              }
              back[i][s]=s;
            } else if(smart24 || isTrueColor){
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
          if(smart24 || isTrueColor){
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
        lines.push(ln);
      }
      _timings['viterbi'] = _perf() - _tViterbi;
      _timings['viterbi_rowPal'] = _tRowPal;
      _timings['viterbi_cellGlyph'] = _tCellGlyph;
      _timings['viterbi_dp'] = _tDP;
      _timings['viterbi_S'] = _maxS;
    } else {
      for(let r=0;r<rows;r++){
      _checkAbort(); await _maybeYield(r);
        let ln='',lastFg='',lastBg='',first=true;
        for(let c=0;c<cols;c++){
          const[r1,g1,b1,a1]=pxAt(c,r*2), [r2,g2,b2,a2]=pxAt(c,r*2+1);
          const _isEmptyTransH = (o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false) && (o.alphaMode==='transparent' ? a2 < o.alphaThreshold : false);
          const _matteRgbH = parseMatteHex((o as any).matte ?? null);
          if(_isEmptyTransH){ if(_matteRgbH){ const matteIdxH = nearestIndex(_matteRgbH[0],_matteRgbH[1],_matteRgbH[2], pal, o.colorMatching); const matteStr=String(matteIdxH); const needH = first || lastBg!==matteStr; if(needH){ const cd='\x03'+matteStr+','+matteStr; if(is24){ const hex=toHex6(_matteRgbH[0],_matteRgbH[1],_matteRgbH[2]); const cd2='\x04'+hex+','+hex; if(first||lastFg!==hex||lastBg!==hex){ln+=cd2;lastFg=hex;lastBg=hex;}} else {ln+=cd;lastFg=matteStr;lastBg=matteStr;}} ln+=' '; first=false; continue; } else { ln+=' ';first=false;continue; }}
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
        lines.push(ln);
      }
    }
  } else if(pm==='polygon'){
    const pal=getMidgardPalette(o);
    const smart24 = (o as unknown as Record<string,unknown>).midgardMode==='smart' && (o as unknown as Record<string,unknown>)._smartPaletteA && o.renderMode==='ansi24';
    const isTrueColor = (o as any).midgardMode==='truecolor' && o.renderMode==='ansi24';
    const totalCells = cols*rows;
    const glyphCount = _activeGlyphs.length;
    const thresh = hasWasmSync() ? 5000 : 1200;
    const useViterbi = o.viterbiW>0 && cols>1 && totalCells <= thresh && glyphCount <= 32 && (smart24 as boolean || !is24 || isTrueColor);
    if(useViterbi){
      const _tViterbi = _perf();
      let _tRowPal=0, _tCellGlyph=0, _tDP=0;
      let _maxS = 0;
      for(let r=0;r<rows;r++){
      _checkAbort(); await _maybeYield(r);
        const cellInfos: Array<{mask:bigint, fg:[number,number,number], bg:[number,number,number], empty:boolean}> = new Array(cols);
        for(let c=0;c<cols;c++) cellInfos[c]=_polygonCellMask(d,pW,pH,c,r,o);
        // smart bg: polygon allEmpty removed
        let S: number[];
        let _tr = _perf();
        if((o as unknown as Record<string,unknown>).midgardMode==='smart' && (o as unknown as Record<string,unknown>)._smartPaletteB && !smart24){
          S = (o as unknown as Record<string,unknown>)._smartPaletteB as number[];
        } else if(smart24){
          const fullA = (o as unknown as Record<string,unknown>)._smartPaletteA as number[];
          const sSize = totalCells > 1200 ? 6 : cols >= 100 ? 12 : 16;
          const top = rankSmartPaletteA(d, pW, pH, fullA, Math.min(sSize, fullA.length), o.colorMatching);
          S = top;
        } else if(isTrueColor){
          const sSize = cols >= 100 ? 4 : 6;
          // Truecolor: use smaller palette for speed (was 12, now 8/6 to keep 60*64=3840 < 65536 and 60*36=2160 for WASM)
          let truePal2 = (o as any)._truePalette as number[] | undefined;
          if(!truePal2){
            truePal2 = smartPaletteA(d, pW, pH, 8, o.colorMatching);
            (o as any)._truePalette = truePal2;
          }
          const top = rankSmartPaletteA(d, pW, pH, truePal2, Math.min(sSize, truePal2.length), o.colorMatching);
          S = top;
        } else {
          const sSize = totalCells > 1200 ? 6 : cols >= 100 ? 10 : 12;
          const tops: Array<[number,number,number,number]> = cellInfos.map(ci=>[ci.fg[0],ci.fg[1],ci.fg[2],255]);
          const bots: Array<[number,number,number,number]> = cellInfos.map(ci=>[ci.bg[0],ci.bg[1],ci.bg[2],255]);
          let _haveS=false;
          if (hasWasmSync() && tops.length === cols && bots.length === cols) {
            const rTops = new Uint8Array(cols), gTops = new Uint8Array(cols), bTops = new Uint8Array(cols);
            const rBots = new Uint8Array(cols), gBots = new Uint8Array(cols), bBots = new Uint8Array(cols);
            for(let c=0;c<cols;c++){ rTops[c]=tops[c][0]; gTops[c]=tops[c][1]; bTops[c]=tops[c][2]; rBots[c]=bots[c][0]; gBots[c]=bots[c][1]; bBots[c]=bots[c][2]; }
            const out = new Uint32Array(sSize);
            const n = tryWasmBatchRowPaletteSync(rTops,gTops,bTops,rBots,gBots,bBots,pal,o.colorMatching,sSize,ng,out);
            if (n !== null && n>0) {
              _wasmHits += n;
              S = Array.from(out.subarray(0,n));
              _haveS=true;
            } else {
              _wasmMisses++;
            }
          }
          if (!_haveS) {
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
        for(let i=0;i<M;i++) cellIsEmpty[i]=cellInfos[i].empty;
        let _tc = _perf();
        const effPal = smart24 ? ((o as unknown as Record<string,unknown>)._smartPaletteA as number[]) : pal;
        const _rowPalOkLab = o.colorMatching==='oklab' ? getPalOkLab(effPal) : null;
        let usedBatch = false;
        if (hasWasmSync() && states.length > 0 && M * states.length <= 65536) {
          const masks = new BigUint64Array(M);
          for(let i=0;i<M;i++) masks[i]=cellInfos[i].mask;
          const Slen = states.length;
          const statesF = new Uint32Array(Slen), statesB = new Uint32Array(Slen);
          for(let s=0;s<Slen;s++){ statesF[s]=states[s][0]; statesB[s]=states[s][1]; }
          const outGlyph = new Uint8Array(M * Slen);
          const outErr = new Float32Array(M * Slen);
          const outBytes = new Uint8Array(M * Slen);
          const n = tryWasmBatchBestGlyphPolygonSync(masks, statesF, statesB, effPal, o.colorMatching, o.viterbiW, outGlyph, outErr, outBytes);
          if (n === M * Slen) {
            _wasmHits += n;
            for(let i=0;i<M;i++){
              if(cellIsEmpty[i]){ cellGlyph[i]=[]; continue; }
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
            if(cellIsEmpty[i]){ cellGlyph[i]=[]; continue; }
            const cm=cellInfos[i].mask;
            const rowGlyphs: GlyphInfo[] = new Array(states.length);
            for(let s=0;s<states.length;s++){
              const [f,b]=states[s];
              const res=bestGlyphForPolygon(cm,f,b,effPal,o.colorMatching,o.viterbiW, _rowPalOkLab);
              rowGlyphs[s]={err:res.err, bytes:res.bytes, glyph:res.glyph};
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
        const firstNonEmpty = cellIsEmpty.findIndex(v => !v);
        for(let s=0;s<states.length;s++){
          if(cellIsEmpty[0]){
            dp[s]=0;
          } else {
            const g=cellGlyph[0][s];
            const [f,b]=states[s];
            if(smart24 || isTrueColor){
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
            const nd = dp.slice();
            for(let s=0;s<states.length;s++) back[i][s]=s;
            dp=nd;
            continue;
          }
          const isFirstNonEmpty = i === firstNonEmpty;
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
            if(isFirstNonEmpty){
              if(smart24 || isTrueColor){
                nd[s]=g.err + o.viterbiW*(g.bytes + 14);
              } else {
                const fgM=_palToIrcEff ? _palToIrcEff[f & 255] : f, bgM=_palToIrcEff ? _palToIrcEff[b & 255] : b;
                const pc=pairPref(fgM,bgM);
                nd[s]=g.err + o.viterbiW*(g.bytes + pc);
              }
              back[i][s]=s;
            } else if(smart24 || isTrueColor){
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
          if(smart24 || isTrueColor){
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
        lines.push(ln);
      }
      _timings['viterbi'] = _perf() - _tViterbi;
      _timings['viterbi_rowPal'] = _tRowPal;
      _timings['viterbi_cellGlyph'] = _tCellGlyph;
      _timings['viterbi_dp'] = _tDP;
      _timings['viterbi_S'] = _maxS;
    } else {
      for(let r=0;r<rows;r++){
      _checkAbort(); await _maybeYield(r);
        let ln='',lastFg='',lastBg='',first=true;
        for(let c=0;c<cols;c++){
          const info=_polygonCellMask(d,pW,pH,c,r,o);
          if(info.empty){ const _matteP = parseMatteHex((o as any).matte ?? null); if(_matteP){ const matteIdxP = nearestIndex(_matteP[0],_matteP[1],_matteP[2], pal, o.colorMatching); const matteStrP=String(matteIdxP); const needP = first || lastBg!==matteStrP; if(needP){ const cd='\x03'+matteStrP+','+matteStrP; ln+=cd; lastFg=matteStrP; lastBg=matteStrP; } ln+=' '; first=false; continue; } else { ln+=' ';first=false;continue; }}
          let fgIdx:number, bgIdx:number;
          if(is24){
            // For truecolor, use direct hex but need indices for bestGlyphForPolygon; use nearest to effPal then emit hex separately via later branch
            fgIdx=nearestIndex(info.fg[0],info.fg[1],info.fg[2],pal,o.colorMatching);
            bgIdx=nearestIndex(info.bg[0],info.bg[1],info.bg[2],pal,o.colorMatching);
          } else if(is16){
            fgIdx=nearestIndex(info.fg[0],info.fg[1],info.fg[2],pal,o.colorMatching);
            bgIdx=nearestIndex(info.bg[0],info.bg[1],info.bg[2],pal,o.colorMatching);
          } else {
            const lf=lutLookup(info.fg[0],info.fg[1],info.fg[2],pal,ng,o.colorMatching);
            const lb=lutLookup(info.bg[0],info.bg[1],info.bg[2],pal,ng,o.colorMatching);
            fgIdx=toEmitIdx(o.renderMode==='ansi'?lf.ansi:lf.irc, o.renderMode, pal, o.colorMatching);
            bgIdx=toEmitIdx(o.renderMode==='ansi'?lb.ansi:lb.irc, o.renderMode, pal, o.colorMatching);
          }
          const res=bestGlyphForPolygon(info.mask, fgIdx, bgIdx, pal, o.colorMatching, o.viterbiW, o.colorMatching==='oklab'?getPalOkLab(pal):null);
          const glyph=res.glyph;
          if(is24){
            const fHex=toHex6(info.fg[0],info.fg[1],info.fg[2]), bHex=toHex6(info.bg[0],info.bg[1],info.bg[2]);
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
            if(glyph===' '){
              const need=first || lastBg!==String(bgIdx);
              if(need){ const cd='\x03'+fgIdx+','+bgIdx; ln+=cd; lastFg=String(fgIdx); lastBg=String(bgIdx); }
              ln+=' ';
            } else {
              const needFull=first || lastFg!==String(fgIdx) || lastBg!==String(bgIdx);
              const needFgOnly=!first && lastBg===String(bgIdx) && lastFg!==String(fgIdx);
              if(needFgOnly){ const cd='\x03'+fgIdx; ln+=cd; lastFg=String(fgIdx); }
              else if(needFull){ const cd='\x03'+fgIdx+','+bgIdx; ln+=cd; lastFg=String(fgIdx); lastBg=String(bgIdx); }
              ln+=glyph;
            }
          }
          first=false;
        }
        lines.push(ln);
      }
    }
    const isTrueColorAuto = (o as any).midgardMode==='truecolor' && o.renderMode==='ansi24';
    const GEOS: PixelMode[] = o.autoGeometries && o.autoGeometries.length ? o.autoGeometries : (isTrueColorAuto && o.viterbiW<=0.5 ? ['braille'] : ['half','quarter','braille','polygon']);
    const capL = 12;
    const palAuto = getMidgardPalette(o);
    const ngA = o.nograyscale;
    for(let r=0;r<rows;r++){
      const tops: Array<[number,number,number,number]>=[], bots: Array<[number,number,number,number]>=[];
      for(let c=0;c<cols;c++){ tops.push(pxAt(c,r*2)); bots.push(pxAt(c,r*2+1)); }
      // Precompute per-cell half costs (greedy palette) — always needed
      type CheapCell = { fgS:string, bgS:string, cost:number };
      const preHalf: (CheapCell|null)[] = new Array(cols);
      for(let i=0;i<cols;i++){
        const [r1,g1,b1,a1]=tops[i]??[0,0,0,255], [r2,g2,b2,a2]=bots[i]??[0,0,0,255];
        const isEmptyH = (o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false) && (o.alphaMode==='transparent' ? a2 < o.alphaThreshold : false) && !parseMatteHex((o as any).matte ?? null);
        if(isEmptyH){ preHalf[i]=null; }
        else {
          const fgIdxH=toEmitIdx(lutLookup(r1,g1,b1,palAuto,ngA,o.colorMatching).irc,'irc',palAuto,o.colorMatching);
          const bgIdxH=toEmitIdx(lutLookup(r2,g2,b2,palAuto,ngA,o.colorMatching).irc,'irc',palAuto,o.colorMatching);
          preHalf[i]={fgS:String(fgIdxH), bgS:String(bgIdxH), cost:0};
        }
      }
      // Fast path: viterbiW=0 => greedy half is optimal and O(n) not O(n·S²)
      if(o.viterbiW===0){
        let ln='', lastFg='', lastBg='', first=true;
        for(let i=0;i<cols;i++){
          const cell=preHalf[i];
          if(!cell){ ln+=' '; first=false; continue; }
          const {fgS, bgS}=cell;
          const needFg=!first&&lastBg===bgS&&lastFg!==fgS, needFull=first||lastFg!==fgS||lastBg!==bgS;
          if(needFg){ const cd='\x03'+fgS; ln+=cd; lastFg=fgS; }
          else if(needFull){ const cd='\x03'+fgS+','+bgS; ln+=cd; lastFg=fgS; lastBg=bgS; }
          ln+='▀'; first=false;
        }
        lines.push(ln);
        continue;
      }
      // Viterbi path — need quarter/braille precomputations + DP
      const preQuarter: (CheapCell|null)[] = new Array(cols);
      const preBraille: (CheapCell|null)[] = new Array(cols);
      for(let i=0;i<cols;i++){
        const [r1,g1,b1,a1]=tops[i]??[0,0,0,255], [r2,g2,b2,a2]=bots[i]??[0,0,0,255];
        const fgS_q=String(toEmitIdx(lutLookup(r1,g1,b1,palAuto,ngA,o.colorMatching).irc,'irc',palAuto,o.colorMatching));
        const bgS_q=String(toEmitIdx(lutLookup(r2,g2,b2,palAuto,ngA,o.colorMatching).irc,'irc',palAuto,o.colorMatching));
        preQuarter[i]={fgS:fgS_q, bgS:bgS_q, cost:0};
        const codeB='\x03'+String(toEmitIdx(lutLookup((r1+r2)/2|0,(g1+g2)/2|0,(b1+b2)/2|0,palAuto,ngA,o.colorMatching).irc,'irc',palAuto,o.colorMatching));
        preBraille[i]={fgS:'', bgS:'', cost:0}; (preBraille[i] as any).code=codeB;
      }
      const cheapHalfCost=(pos:number,len:number):number=>{
        let cost=0, lastFg='',lastBg='',first=true;
        for(let i=0;i<len;i++){
          const cell = preHalf[pos+i];
          if(!cell){ first=false; continue; }
          const {fgS, bgS}=cell;
          if(first||lastFg!==fgS||lastBg!==bgS){
            const needFg=!first&&lastBg===bgS&&lastFg!==fgS;
            const cd=needFg? '\x03'+fgS : '\x03'+fgS+','+bgS;
            cost+=o.viterbiW*cd.length; lastFg=fgS; lastBg=bgS;
          }
          cost+=o.viterbiW*3; first=false;
        }
        return cost;
      };
      const cheapQuarterCost=(pos:number,len:number):number=>{
        let cost=0, lastFg='',lastBg='',first=true;
        for(let i=0;i<len;i++){
          const cell = preQuarter[pos+i];
          if(!cell){ first=false; continue; }
          const {fgS, bgS} = cell;
          const needFg=!first&&lastBg===bgS&&lastFg!==fgS, needFull=first||lastFg!==fgS||lastBg!==bgS;
          if(needFg){ cost+=o.viterbiW*(1+fgS.length); lastFg=fgS; }
          else if(needFull){ cost+=o.viterbiW*(2+fgS.length+bgS.length); lastFg=fgS; lastBg=bgS; }
          cost+=o.viterbiW*3; first=false;
        }
        return cost;
      };
      const cheapBrailleCost=(pos:number,len:number):number=>{
        let cost=0, lastCode='',first=true;
        for(let i=0;i<len;i++){
          const cell = preBraille[pos+i];
          if(!cell){ first=false; continue; }
          const code=(cell as any).code as string;
          if(first||lastCode!==code){ cost+=o.viterbiW*code.length; lastCode=code; }
          cost+=o.viterbiW*3; first=false;
        }
        return cost;
      };
      const cheapPolygonCost=(pos:number,len:number):number=> cheapHalfCost(pos,len);
      const wForRow=(pos:number,len:number,g:PixelMode):number=>{
        if(g==='half') return cheapHalfCost(pos,len);
        if(g==='polygon') return cheapPolygonCost(pos,len);
        if(g==='quarter') return cheapQuarterCost(pos,len);
        if(g==='braille') return cheapBrailleCost(pos,len);
        return Infinity;
      };
      const { segs } = dpSeg(wForRow, GEOS, cols, capL);
      if(segs.length===0){ lines.push(''); continue; }
      const renderHalfSeg=(pos:number,len:number):string=>{
        const sTops=tops.slice(pos,pos+len) as any, sBots=bots.slice(pos,pos+len) as any;
        const M=len; if(M===0) return '';
        let S:number[];
        if((o as any).midgardMode==='smart' && (o as any)._smartPaletteB && !((o as any).midgardMode==='smart' && (o as any)._smartPaletteA && o.renderMode==='ansi24')){
          S=(o as any)._smartPaletteB as number[];
        } else if((o as any).midgardMode==='smart' && (o as any)._smartPaletteA && o.renderMode==='ansi24'){
          const fullA=(o as any)._smartPaletteA as number[]; const sSize=M>=100?12:16; S=rankSmartPaletteA(d,pW,pH,fullA,Math.min(sSize,fullA.length),o.colorMatching);
        } else {
          const sSize=M>=100?10:12; S=rowPaletteForViterbi(sTops,sBots,palAuto,ngA,o.colorMatching,sSize);
        }
        const states: Array<[number,number]> = []; for(const f of S) for(const b of S) states.push([f,b]);
        type GI={err:number,bytes:number,glyph:string}; const cellGlyph: GI[][]=new Array(M); const cellIsEmpty:boolean[]=new Array(M);
        const effPal = ((o as any).midgardMode==='smart' && (o as any)._smartPaletteA && o.renderMode==='ansi24') ? (o as any)._smartPaletteA as number[] : palAuto;
        const rowPalOkLab = o.colorMatching==='oklab' ? getPalOkLab(effPal) : null;
        // try batched WASM for segment (same as half row batch) — one crossing per segment instead of M·S
        let usedBatch=false;
        if(hasWasmSync() && states.length>0 && M*states.length<=65536){
          const r1Arr=new Uint8Array(M), g1Arr=new Uint8Array(M), b1Arr=new Uint8Array(M);
          const r2Arr=new Uint8Array(M), g2Arr=new Uint8Array(M), b2Arr=new Uint8Array(M);
          const isEmptyBatch=new Array(M).fill(false);
          for(let i=0;i<M;i++){
            let [r1,g1,b1,a1]=sTops[i]; let [r2,g2,b2,a2]=sBots[i];
            const isEmptyTrans=(o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false) && (o.alphaMode==='transparent' ? a2 < o.alphaThreshold : false);
            const matteRgb = parseMatteHex((o as any).matte ?? null);
            const isEmpty = isEmptyTrans && !matteRgb;
            isEmptyBatch[i]=isEmpty;
            if(isEmptyTrans && matteRgb){ r1=matteRgb[0]; g1=matteRgb[1]; b1=matteRgb[2]; r2=matteRgb[0]; g2=matteRgb[1]; b2=matteRgb[2]; }
            r1Arr[i]=r1; g1Arr[i]=g1; b1Arr[i]=b1; r2Arr[i]=r2; g2Arr[i]=g2; b2Arr[i]=b2;
            if(isEmpty) cellIsEmpty[i]=true;
          }
          // fill cellIsEmpty already, now try batch for non-empty
          const Slen2=states.length;
          const statesF2=new Uint32Array(Slen2), statesB2=new Uint32Array(Slen2);
          for(let s=0;s<Slen2;s++){ statesF2[s]=states[s][0]; statesB2[s]=states[s][1]; }
          const outGlyph2=new Uint8Array(M*Slen2), outErr2=new Float32Array(M*Slen2), outBytes2=new Uint8Array(M*Slen2);
          const effPal2b=effPal;
          const n2=tryWasmBatchBestGlyphSync(r1Arr,g1Arr,b1Arr,r2Arr,g2Arr,b2Arr,statesF2,statesB2,effPal2b,o.colorMatching,o.viterbiW,outGlyph2,outErr2,outBytes2);
          if(n2===M*Slen2){
            _wasmHits+=n2;
            for(let i=0;i<M;i++){
              if(isEmptyBatch[i]){ cellGlyph[i]=[]; cellIsEmpty[i]=true; continue; }
              const rowGlyphs: GI[]=new Array(Slen2);
              for(let s=0;s<Slen2;s++){
                const idx=i*Slen2+s; const gIdx=outGlyph2[idx]; const g=GLYPHS[gIdx]??GLYPHS[7];
                rowGlyphs[s]={err: outErr2[idx], bytes: outBytes2[idx]||g.bytes, glyph: g.ch};
              }
              cellGlyph[i]=rowGlyphs; cellIsEmpty[i]=false;
            }
            usedBatch=true;
          } else { _wasmMisses++; }
        }
        if(!usedBatch){
          for(let i=0;i<M;i++){
            let [r1,g1,b1,a1]=sTops[i]; let [r2,g2,b2,a2]=sBots[i];
            const isEmptyTrans=(o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false) && (o.alphaMode==='transparent' ? a2 < o.alphaThreshold : false);
            const matteRgb = parseMatteHex((o as any).matte ?? null);
            const isEmpty = isEmptyTrans && !matteRgb;
            cellIsEmpty[i]=isEmpty; if(isEmpty){ cellGlyph[i]=[]; continue; }
            const rowGlyphs: GI[]=new Array(states.length);
            for(let s=0;s<states.length;s++){ const [f,b]=states[s]; rowGlyphs[s]=bestGlyphForState(r1,g1,b1,r2,g2,b2,f,b,effPal,o.colorMatching,o.viterbiW,rowPalOkLab); }
            cellGlyph[i]=rowGlyphs;
          }
        }
        // smart bg: auto allEmpty removed
        const INF=1e18; let dp=new Array(states.length).fill(INF); const back:number[][]=Array.from({length:M},()=>new Array(states.length).fill(-1));
        const palToIrcEff: Uint8Array|null = ((o as any).midgardMode==='smart' && (o as any)._smartPaletteA && o.renderMode==='ansi24') ? null : (o.renderMode==='ansi' ? getPalToIrc(effPal,o.colorMatching) : null);
        const firstNonEmpty=cellIsEmpty.findIndex(v=>!v);
        for(let s=0;s<states.length;s++){
          if(cellIsEmpty[0]) dp[s]=0; else {
            const g=cellGlyph[0][s]; const [f,b]=states[s];
            if(((o as any).midgardMode==='smart' && (o as any)._smartPaletteA && o.renderMode==='ansi24')) dp[s]=g.err + o.viterbiW*(g.bytes+14);
            else { const fgM=palToIrcEff?palToIrcEff[f&255]:f, bgM=palToIrcEff?palToIrcEff[b&255]:b; dp[s]=g.err + o.viterbiW*(g.bytes+pairPref(fgM,bgM)); }
          }
        }
        for(let i=1;i<M;i++){
          if(cellIsEmpty[i]){ const nd=dp.slice(); for(let s=0;s<states.length;s++) back[i][s]=s; dp=nd; continue; }
          const isFirst=i===firstNonEmpty; let gmin=INF,gidx=-1; for(let s=0;s<states.length;s++) if(dp[s]<gmin){gmin=dp[s]; gidx=s;}
          const bMin=new Map<number,{cost:number,idx:number}>(); for(let s=0;s<states.length;s++){ const bg=states[s][1]; const c=dp[s]; const cur=bMin.get(bg); if(!cur||c<cur.cost) bMin.set(bg,{cost:c,idx:s}); }
          const nd=new Array(states.length).fill(INF);
          for(let s=0;s<states.length;s++){
            const [f,b]=states[s]; const g=cellGlyph[i][s];
            if(isFirst){
              if(((o as any).midgardMode==='smart' && (o as any)._smartPaletteA && o.renderMode==='ansi24')){ nd[s]=g.err+o.viterbiW*(g.bytes+14); back[i][s]=s; }
              else { const fgM=palToIrcEff?palToIrcEff[f&255]:f, bgM=palToIrcEff?palToIrcEff[b&255]:b; nd[s]=g.err+o.viterbiW*(g.bytes+pairPref(fgM,bgM)); back[i][s]=s; }
            } else if(((o as any).midgardMode==='smart' && (o as any)._smartPaletteA && o.renderMode==='ansi24')){
              const candStay=bMin.get(b)!.cost+o.viterbiW*7, candSwitch=gmin+o.viterbiW*14; let best=dp[s], bi=s; if(candStay<best){best=candStay; bi=bMin.get(b)!.idx;} if(candSwitch<best){best=candSwitch; bi=gidx;} nd[s]=best+g.err+o.viterbiW*g.bytes; back[i][s]=bi;
            } else {
              const fgM=palToIrcEff?palToIrcEff[f&255]:f, bgM=palToIrcEff?palToIrcEff[b&255]:b; const candStay=bMin.get(b)!.cost+o.viterbiW*fgPref(fgM), candSwitch=gmin+o.viterbiW*pairPref(fgM,bgM); let best=dp[s], bi=s; if(candStay<best){best=candStay; bi=bMin.get(b)!.idx;} if(candSwitch<best){best=candSwitch; bi=gidx;} nd[s]=best+g.err+o.viterbiW*g.bytes; back[i][s]=bi;
            }
          } dp=nd;
        }
        let bestEnd=0; for(let s=1;s<states.length;s++) if(dp[s]<dp[bestEnd]) bestEnd=s;
        const chosen=new Array(M).fill(0); chosen[M-1]=bestEnd; for(let i=M-1;i>0;i--){ if(cellIsEmpty[i]) chosen[i-1]=chosen[i]; else chosen[i-1]=back[i][chosen[i]]; }
        let ln='',lastFg='',lastBg='',first=true;
        for(let c=0;c<M;c++){
          if(cellIsEmpty[c]){ ln+=' '; first=false; continue; }
          const sIdx=chosen[c]; const [fRaw,bRaw]=states[sIdx]; const g=cellGlyph[c][sIdx]; const glyph=g.glyph;
          if(((o as any).midgardMode==='smart' && (o as any)._smartPaletteA && o.renderMode==='ansi24')){
            const fHex=toHex6((effPal[fRaw]>>16)&255,(effPal[fRaw]>>8)&255,effPal[fRaw]&255), bHex=toHex6((effPal[bRaw]>>16)&255,(effPal[bRaw]>>8)&255,effPal[bRaw]&255);
            if(glyph===' '){ const need=first||lastBg!==bHex; if(need){ ln+='\x04'+fHex+','+bHex; lastFg=fHex; lastBg=bHex; } ln+=' '; }
            else { const needFull=first||lastFg!==fHex||lastBg!==bHex, needFg=!first&&lastBg===bHex&&lastFg!==fHex; if(needFg){ ln+='\x04'+fHex; lastFg=fHex; } else if(needFull){ ln+='\x04'+fHex+','+bHex; lastFg=fHex; lastBg=bHex; } ln+=glyph; }
          } else {
            const fg=palToIrcEff?palToIrcEff[fRaw&255]:fRaw, bg=palToIrcEff?palToIrcEff[bRaw&255]:bRaw;
            if(glyph===' '){ const need=first||lastBg!==String(bg); if(need){ ln+='\x03'+fg+','+bg; lastFg=String(fg); lastBg=String(bg); } ln+=' '; }
            else { const needFull=first||lastFg!==String(fg)||lastBg!==String(bg), needFg=!first&&lastBg===String(bg)&&lastFg!==String(fg); if(needFg){ ln+='\x03'+fg; lastFg=String(fg); } else if(needFull){ ln+='\x03'+fg+','+bg; lastFg=String(fg); lastBg=String(bg); } ln+=glyph; }
          } first=false;
        }
        return ln;
      };
      const renderQuarterSeg=(pos:number,len:number):string=>{
        const qPal=palAuto; const qMap=[' ','▘','▝','▀','▖','▌','▞','▛','▗','▚','▐','▜','▄','▙','▟','█'];
        let ln='',lastFg='',lastBg='',first=true;
        for(let c=pos;c<pos+len;c++){
          const idx=c-pos; const [r1,g1,b1]=tops[pos+idx]??[0,0,0,255], [r2,g2,b2]=bots[pos+idx]??[0,0,0,255];
          const p=[[r1,g1,b1],[r1,g1,b1],[r2,g2,b2],[r2,g2,b2]];
          const b=[0,1,2,3].map(i=>luma(p[i][0],p[i][1],p[i][2])>127?1:0);
          const bits=b[0]|(b[1]<<1)|(b[2]<<2)|(b[3]<<3), ch=qMap[bits]||' ';
          if(ch===' '){ const avgR=(r1+r2)/2|0, avgG=(g1+g2)/2|0, avgB=(b1+b2)/2|0; const bgS=String(toEmitIdx(lutLookup(avgR,avgG,avgB,palAuto,o.nograyscale,o.colorMatching).irc,'irc',palAuto,o.colorMatching)); const need=first||lastFg!==bgS||lastBg!==bgS; if(need){ const cd='\x03'+bgS+','+bgS; ln+=cd; lastFg=bgS; lastBg=bgS; } ln+=' '; first=false; continue; }
          let onR=0,onG=0,onB=0,onC=0, offR=0,offG=0,offB=0,offC=0;
          for(let i=0;i<4;i++){ const rr=p[i][0],gg=p[i][1],bb=p[i][2]; if(b[i]){onR+=rr;onG+=gg;onB+=bb;onC++;}else{offR+=rr;offG+=gg;offB+=bb;offC++;}}
          if(onC===0||offC===0){
            const bgS=String(toEmitIdx(lutLookup((onC?onR:offR)/(onC||offC)|0,(onC?onG:offG)/(onC||offC)|0,(onC?onB:offB)/(onC||offC)|0,qPal,ngA,o.colorMatching).irc,'irc',qPal,o.colorMatching));
            const need=first||lastFg!==bgS||lastBg!==bgS; if(need){ const cd='\x03'+bgS+','+bgS; ln+=cd; lastFg=bgS; lastBg=bgS; } ln+=' '; first=false; continue;
          }
          const fgS=String(toEmitIdx(lutLookup(onR/onC|0,onG/onC|0,onB/onC|0,qPal,ngA,o.colorMatching).irc,'irc',qPal,o.colorMatching));
          const bgS=String(toEmitIdx(lutLookup(offR/offC|0,offG/offC|0,offB/offC|0,qPal,ngA,o.colorMatching).irc,'irc',qPal,o.colorMatching));
          const needFg=!first&&lastBg===bgS&&lastFg!==fgS, needFull=first||lastFg!==fgS||lastBg!==bgS;
          if(needFg){ const cd='\x03'+fgS; ln+=cd; lastFg=fgS; }
          else if(needFull){ const cd='\x03'+fgS+','+bgS; ln+=cd; lastFg=fgS; lastBg=bgS; }
          ln+=ch; first=false;
        }
        return ln;
      };
      const renderBrailleSeg=(pos:number,len:number):string=>{
        const palB=palAuto; let ln='',lastCode='',first=true;
        for(let c=pos;c<pos+len;c++){
          const [r1,g1,b1,a1]=tops[c]??[0,0,0,255], [r2,g2,b2]=bots[c]??[0,0,0,255];
          let sR=(r1+r2)/2, sG=(g1+g2)/2, sB=(b1+b2)/2; const code='\x03'+String(toEmitIdx(lutLookup(sR|0,sG|0,sB|0,palB,ngA,o.colorMatching).irc,'irc',palB,o.colorMatching));
          if(first||lastCode!==code){ ln+=code; lastCode=code; }
          ln+=String.fromCharCode(0x2800 | 0xFF); first=false;
        }
        return ln;
      };
      const renderPolygonSeg=(pos:number,len:number):string=> renderHalfSeg(pos,len);
      let pos2=0; let out=''; for(const seg of segs){
        let frag=''; if(seg.g==='half') frag=renderHalfSeg(pos2,seg.len);
        else if(seg.g==='polygon') frag=renderPolygonSeg(pos2,seg.len);
        else if(seg.g==='quarter') frag=renderQuarterSeg(pos2,seg.len);
        else if(seg.g==='braille') frag=renderBrailleSeg(pos2,seg.len);
        out+=frag; pos2+=seg.len;
      }
      lines.push(out);
    }
  } else {
    const fullPal=getMidgardPalette(o);
    for(let y=0;y<pH;y++){let ln='',lastCode='',first=true;
      for(let x=0;x<pW;x++){const[r,g,b,a]=pxAt(x,y);
        if(o.alphaMode==='transparent' ? a < o.alphaThreshold : false){ const _matteF = parseMatteHex((o as any).matte ?? null); if(_matteF){ const matteIdxF = nearestIndex(_matteF[0],_matteF[1],_matteF[2], fullPal, o.colorMatching); const matteStrF=String(matteIdxF); const needF = first || lastBg!==matteStrF; if(needF){ const cd='\x03'+matteStrF+','+matteStrF; ln+=cd; lastFg=matteStrF; lastBg=matteStrF; } ln+='█'; first=false; continue; } else { ln+=' ';first=false;continue; }}
        const cd=is16? '\x03'+String(nearestIndex(r,g,b,fullPal, o.colorMatching)) : is24? '\x04'+toHex6(r,g,b) : '\x03'+String(toEmitIdx(o.renderMode==='ansi'? lutLookup(r,g,b,fullPal,ng, o.colorMatching).ansi : lutLookup(r,g,b,fullPal,ng, o.colorMatching).irc, o.renderMode, fullPal, o.colorMatching));
        if(first||lastCode!==cd){ln+=cd;lastCode=cd;}
        ln+='█'; first=false;
      }
      lines.push(ln);
    }
  }

  // UniformTail §1 vertical analog: only pop wholly empty rows ('') or default-blank space rows (no \x03/\x04 bg).
  // Rows like "\x031,1     " (uniform matte) have non-default bg — popping would create ragged bottom (same theorem vertically).
  // UniformHead rectangular_of_first_last_opaque needs both ends opaque ⇒ keep bottom matte.
  // UniformTail §1: safeTrim per row — trim trailing default-blank spaces (right edge)
  // Lean: paint_trim / safeTrim_last_opaque / rectangular_of_last_opaque / flatTail
  // Coverage: defaultIdx=99 (no explicit bg); bg=1 (black) is NOT default, must survive (trailing_black_not_trimmed)
  {
    for(let idx=0; idx<lines.length; idx++){
      const ln=lines[idx];
      let end=ln.length;
      while(end>0 && ln[end-1]===' ') end--;
      if(end===ln.length) continue;
      const prefix=ln.slice(0,end);
      let lastBg: string|null=null;
      const re=/\x03(\d{1,2})(?:,(\d{1,2}))?/g;
      let m: RegExpExecArray|null;
      while((m=re.exec(prefix))!==null){
        if(m[2]!==undefined) lastBg=m[2];
      }
      const isDefault = lastBg===null;
      if(isDefault) lines[idx]=prefix;
    }
  }
  // UniformTail §2: flatTail optimal completion to rectangular width (square)
  // Ragged right edge after safeTrim: pad each row to cols cells with flatTail of its last state
  // so the grid is rectangular (rectangular_of_first_last_opaque, flatTail_optimal)
  {
    for(let idx=0; idx<lines.length; idx++){
      const ln = lines[idx];
      // Count cells: strip IRC codes, then each remaining char is one cell (half/quarter/braille/full all 1 char per cell)
      const stripped = ln.replace(/\x03\d{1,2}(?:,\d{1,2})?/g, '').replace(/\x04[0-9a-fA-F]{6}(?:,[0-9a-fA-F]{6})?/g, '').replace(/\x0f/g, '');
      const cellCount = [...stripped].length;
      if(cellCount >= cols) continue;
      if(cellCount === 0) continue; // wholly empty row will be handled by bottom pop (vertical flatTail not needed for square height — keep rows count)
      // Find last state fg,bg in the trimmed prefix
      let lastFg: string|null=null, lastBg: string|null=null, isTrueColor=false;
      const reAll=/\x03(\d{1,2})(?:,(\d{1,2}))?|\x04([0-9a-fA-F]{6})(?:,([0-9a-fA-F]{6}))?/g;
      let m: RegExpExecArray|null;
      while((m=reAll.exec(ln))!==null){
        if(m[1]!==undefined){ lastFg=m[1]; lastBg=m[2]??m[1]; isTrueColor=false; }
        else if(m[3]!==undefined){ lastFg=m[3]; lastBg=m[4]??m[3]; isTrueColor=true; }
      }
      if(lastFg===null || lastBg===null) continue; // no state, keep as is (should not happen for non-empty)
      const padCount = cols - cellCount;
      const padCode = isTrueColor ? `\x04${lastFg},${lastBg}` : `\x03${lastFg},${lastBg}`;
      // Only pad if not already at that state (avoid duplicate prefix)
      // flatTail is optimal: 1B per cell after first prefix, so whole pad is padCount + (needs prefix ? padCode.length : 0)
      // Check if ln already ends with padCode
      if(ln.endsWith(padCode)){
        lines[idx] = ln + ' '.repeat(padCount);
      } else {
        lines[idx] = ln + padCode + ' '.repeat(padCount);
      }
    }
  }
  while(lines.length){
    const last = lines[lines.length-1];
    if(last === ''){ lines.pop(); continue; }
    const stripped = last.replace(/[\x03\x04\x0f0-9,a-fA-F]/g,'').trim();
    if(stripped === '' && !last.includes('\x03') && !last.includes('\x04')){ lines.pop(); continue; }
    break;
  }
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

export async function imageToIrcArt(img:HTMLImageElement, opts:Partial<Img2IrcOptions>={}, signal?: AbortSignal):Promise<string>{
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
  else if(pm==='polygon'){cols=w;pW=cols;rows=Math.max(1,Math.round(w*asp*0.9));if(o.height)rows=o.height;pH=rows;}
  else if(pm==='auto'){
    const _isBrailleOnly = o.autoGeometries && (o.autoGeometries as string[]).length===1 && (o.autoGeometries as string[])[0]==='braille';
    if(_isBrailleOnly){ cols=w; pW=cols*2; rows=Math.max(1,Math.round(w*asp*0.45)); if(o.height)rows=o.height; pH=rows*4; }
    else { cols=w;pW=cols;rows=Math.max(1,Math.round(w*asp*0.9));if(o.height)rows=o.height;pH=rows*2; }
  }
  else {cols=w;pW=cols;rows=Math.max(1,Math.round(w*asp*0.5));if(o.height)rows=o.height;pH=rows;}
  if(rows>120){rows=120;pH=pm==='braille'?480:pm==='quarter'?240:pm==='half'?240:pm==='polygon'?120:pm==='auto'?240:120;}
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
    if(!(o as any)._smartPaletteA) (o as any)._smartPaletteA = smartPaletteA(d as any, pW, pH, 24, o.colorMatching);
    if(!(o as any)._smartPaletteB) (o as any)._smartPaletteB = smartPaletteB(d as any, pW, pH, 16, 0.02, o.colorMatching);
  }

  return await renderPixelsCore(d, pW, pH, cols, rows, pm, o, signal);
}

// ── Base94 framing — 9 bytes → 11 chars optimal for 94 printable symbols (Base94.lean) ──
// 94 = printable ASCII minus space (33–126). 9→11 is optimal for short blocks: 256⁹ ≤ 94¹¹ < 256¹⁰ demands 11 chars.
// Rate 9/11 = 0.818 beats base64's 3/4 = 0.75 by 12/11 (+9.09%). Per 400B payload: 327B vs 300B.
const B94_CHARS='!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
const B94_MAP: Record<string,number> = Object.fromEntries([...B94_CHARS].map((c,i)=>[c,i]));
/** Lean Base94.Feasible n m := 256^n ≤ 94^m (decodable) */
export function base94Feasible(n:number, m:number): boolean {
  if(n<0||m<0) return false;
  // use BigInt to avoid overflow (94^61 fits in ~400 bits)
  let a=1n, b=1n;
  for(let i=0;i<n;i++) a*=256n;
  for(let i=0;i<m;i++) b*=94n;
  return a <= b;
}
/** Lean Base94.minChars n = sInf {m | Feasible n m} */
export function base94MinChars(n:number): number {
  if(n<=0) return 0;
  let m=0; while(!base94Feasible(n,m)) m++;
  return m;
}
export function base94Encode(bytes: Uint8Array): string{
  let out='';
  for(let i=0;i<bytes.length;i+=9){
    const chunk=bytes.subarray(i, Math.min(i+9, bytes.length));
    let n=0n; for(let j=0;j<chunk.length;j++) n = (n<<8n) | BigInt(chunk[j]);
    const need = chunk.length===9 ? 11 : base94MinChars(chunk.length);
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
    // For remainder, derive exact bytes from clen via inverse of minChars (avoid floating off-by-one: search n)
    let realBlen=blen;
    if(isLast){
      // find smallest n with minChars(n)==clen (or largest n that fits)
      // brute small n ≤9
      for(let cand=0;cand<=9;cand++) if(base94MinChars(cand)===clen){ realBlen=cand; break; }
      // fallback to floating if not found (should not happen for valid encodings)
      if(base94MinChars(realBlen)!==clen) realBlen=blen;
    }
    const tmp:number[]=[]; for(let k=0;k<realBlen;k++){ tmp.unshift(Number(n & 0xFFn)); n>>=8n; }
    bytes.push(...tmp);
  }
  return new Uint8Array(bytes);
}
export function base94EncodedLength(byteLen: number): number{
  const full=Math.floor(byteLen/9), rem=byteLen%9;
  return full*11 + (rem===0?0:base94MinChars(rem));
}

// ── Erasure coding overhead: Singleton bound (Erasure.lean §2.6) ───────────────
// Lean Erasure.singleton_bound: if every n−r subset determines payload, |P| ≤ |Sym|^(n−r).
// Lean Erasure.messages_ge: if |P| > |Sym|^(k−1) then n ≥ k+r — tolerating r drops costs ≥r extra messages.
/** Lean singleton_bound check: does payload alphabet fit in n−r symbols? */
export function erasureSingletonBoundHolds(payloadCard:number, symCard:number, n:number, r:number): boolean {
  if (n < r) return false;
  if (payloadCard <= 1) return true;
  if (symCard <= 1) return false;
  // |P| ≤ |Sym|^(n−r)
  return payloadCard <= Math.pow(symCard, n - r);
}
/** Lean messages_ge: minimal n to tolerate r drops when payload needs k symbols (k>0, |Sym|>1) */
export function erasureMinMessages(k:number, r:number): number { return k + r; }
/** Overhead in messages for r erasures (Singleton bound: ≥r) */
export function erasureOverhead(r:number): number { return r; }
/** Helpers for byte payloads: k = ⌈payloadBytes·log256 / log symCard⌉ symbols needed (k≥1 if payload>0) */
export function erasureSymbolsNeeded(payloadBytes:number, symCard:number): number {
  if (payloadBytes <= 0) return 0;
  if (symCard <= 1) throw new Error('symCard must be >1');
  return Math.ceil(payloadBytes * Math.log(256) / Math.log(symCard));
}
/** Minimal n for payloadBytes with r erasures under symbol alphabet symCard (e.g. 94 for Base94) */
export function erasureNeededMessages(payloadBytes:number, symCard:number, r:number): number {
  const k = erasureSymbolsNeeded(payloadBytes, symCard);
  return k === 0 ? r : k + r;
}

// ── Inter-line diff — bitmask vs sparse (InterLineDiff.lean) ──
// sparseCost = k·(idx+val), maskCost = ceil(M/6)+k·val (base64 mask). Mask wins iff ceil(M/6) ≤ k·idx.
// Lean: maskBytes M = (M+5)/6 = ⌈M/6⌉ base64 chars (6 bits/char)
export function maskBytes(M: number): number { return Math.floor((M + 5) / 6); }
/** Lean: sparseCost idx val k = k*(idx+val) */
export function sparseCost(idx: number, val: number, k: number): number { return k * (idx + val); }
/** Lean: maskCost M val k = maskBytes M + k*val */
export function maskCost(M: number, val: number, k: number): number { return maskBytes(M) + k * val; }
/** Lean: least_k — threshold ⌈maskBytes M / idx⌉, the least k where mask wins */
export function diffCrossoverK(M:number, idxBytes=2): number{
  const need = maskBytes(M);
  return Math.ceil(need/idxBytes);
}
/** Lean: crossover — maskCost ≤ sparseCost ↔ maskBytes M ≤ k*idx */
export function shouldUseBitmask(M:number, changed:number, idxBytes=2): boolean{
  return maskBytes(M) <= changed*idxBytes;
}
/** Lean: expected_diff_saving — expected cost ((maskBytes+M·p·val)/(M·c)), saving =1−cost */
export function estimateDiffSaving(M:number, p:number, valBytes=1, totalBytesPerCell=2): number{
  const need = maskBytes(M);
  if (M <= 0 || totalBytesPerCell <= 0) return 0;
  const expected = need/(M*totalBytesPerCell) + p*valBytes/totalBytesPerCell;
  return 1 - expected;
}
export function encodeLineDiff(prev: string[], curr: string[]): { useMask: boolean, payload: string }{
  const M=curr.length;
  const changed:number[]=[];
  for(let i=0;i<M;i++) if(prev[i]!==curr[i]) changed.push(i);
  const k=changed.length;
  if(k===0) return {useMask:false, payload:''};
  if(shouldUseBitmask(M,k)){
    // Direct M-bit → ⌈M/6⌉ base64 chars (Lean maskBytes), no byte padding.
    // Pack little-endian 6-bit chunks: bit i = cell i changed.
    let bits=0n; for(const idx of changed) bits |= 1n << BigInt(idx);
    const need = maskBytes(M);
    const b64Chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let maskB64='';
    for(let i=0;i<need;i++) maskB64 += b64Chars[Number((bits >> BigInt(i*6)) & 0x3Fn)];
    return {useMask:true, payload: maskB64 + ':' + changed.map(i=>curr[i]).join('')};
  }
  return {useMask:false, payload: changed.map(i=>`${i}:${curr[i]}`).join(',')};
}


export async function imageToIrcArtFromBitmap(bitmap: ImageBitmap, opts: Partial<Img2IrcOptions> = {}, signal?: AbortSignal): Promise<string> {
  if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas not available');
  const o: Img2IrcOptions = { ...DEFAULTS, ...opts } as any;
  const w = Math.max(MIN_IRC_WIDTH, Math.min(MAX_IRC_WIDTH, o.width));
  const asp = (bitmap.height / bitmap.width) || 1;
  const pm = o.pixelMode;
  let pW:number,pH:number,cols:number,rows:number;
  if(pm==='braille'){cols=w;pW=cols*2;rows=Math.max(1,Math.round(w*asp*0.45));if(o.height)rows=o.height;pH=rows*4;}
  else if(pm==='quarter'){cols=w;pW=cols*2;rows=Math.max(1,Math.round(w*asp*0.5));if(o.height)rows=o.height;pH=rows*2;}
  else if(pm==='half'){cols=w;pW=cols;rows=Math.max(1,Math.round(w*asp*0.9));if(o.height)rows=o.height;pH=rows*2;}
  else if(pm==='polygon'){cols=w;pW=cols;rows=Math.max(1,Math.round(w*asp*0.9));if(o.height)rows=o.height;pH=rows;}
  else if(pm==='auto'){
    const _isBrailleOnly = o.autoGeometries && (o.autoGeometries as string[]).length===1 && (o.autoGeometries as string[])[0]==='braille';
    if(_isBrailleOnly){ cols=w; pW=cols*2; rows=Math.max(1,Math.round(w*asp*0.45)); if(o.height)rows=o.height; pH=rows*4; }
    else { cols=w;pW=cols;rows=Math.max(1,Math.round(w*asp*0.9));if(o.height)rows=o.height;pH=rows*2; }
  }
  else {cols=w;pW=cols;rows=Math.max(1,Math.round(w*asp*0.5));if(o.height)rows=o.height;pH=rows;}
  if(rows>120){rows=120;pH=pm==='braille'?480:pm==='quarter'?240:pm==='half'?240:pm==='polygon'?120:pm==='auto'?240:120;}
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
    if(!(o as any)._smartPaletteA) (o as any)._smartPaletteA = smartPaletteA(d as any, pW, pH, 24, o.colorMatching);
    if(!(o as any)._smartPaletteB) (o as any)._smartPaletteB = smartPaletteB(d as any, pW, pH, 16, 0.02, o.colorMatching);
  }
  return await renderPixelsCore(d, pW, pH, cols, rows, pm, o, signal);
}

export function estimateLineLengths(art:string,maxBytes=IRC_SAFE_PAYLOAD){const ls=art.split('\n');let lg=0;for(const l of ls){const b=new TextEncoder().encode(l).length;if(b>lg)lg=b;}return{ok:lg<=maxBytes,longest:lg,lines:ls.length, total:new TextEncoder().encode(art).length};}
export function stripTrailingReset(line:string){return line.replace(/\x0f$/,'');}
// ── LambdaPareto.lean (§2.4 / §3.7) — λ-sweep: monotonicity, Pareto & bisection ────────
// Lean: IrcRD.cost B D lam x = D x + lam * B x  (D=ΔE distortion, B=wire bytes)
//       IrcRD.Optimal B D lam x  ≔  ∀ y, cost lam x ≤ cost lam y
// The Viterbi DP in renderPixelsCore realises this exactly:
//   dp[s] = g.err + viterbiW * (g.bytes + prefix)   — D + λ·B
// and picks the argmin over S×S states.  Lean's theorems are emergent properties:
//   bytes_antitone      (λ₁<λ₂ → B x₂ ≤ B x₁)        — raising λ never increases bytes
//   distortion_monotone  (0≤λ₁<λ₂ → D x₁ ≤ D x₂)      — raising λ never improves distortion
//   pareto               (λ>0, Optimal → Pareto-optimal) — no y dominates in B and D
//   msgCount_antitone / fits_upward_closed           — bisection on λ is sound
//   msgCount_pack_le     ((R+k-1)/k ≤ R)              — row packing never increases msgs
/** IrcRD.msgCount — number of PRIVMSGs for b bytes at payload budget C per line. */
export function msgCount(C: number, b: number): number {
  if (!(C > 0)) throw new Error('msgCount: C must be > 0');
  if (b <= 0) return 0;
  return Math.ceil(b / C);
}
/** IrcRD.msgCount_pack_le — packing k rows per PRIVMSG never increases message count. */
export function msgCountPacked(R: number, k: number): number {
  if (!(k >= 1)) throw new Error('msgCountPacked: k must be >= 1');
  if (R <= 0) return 0;
  return Math.floor((R + k - 1) / k); // = ⌈R/k⌉, satisfies ⌈R/k⌉ ≤ R  (Lean: msgCount_pack_le)
}
/** Check Lean's msgCount_pack_le inequality directly. */
export function msgCountPackLe(R: number, k: number): boolean {
  return msgCountPacked(R, k) <= R;
}
/** Wire helper: count PRIVMSGs under optimal row-packing for a given art at payload C. */
export function estimatePackedMessages(art: string, C = IRC_SAFE_PAYLOAD, rowsPerMsg = 1): number {
  const { lines } = estimateLineLengths(art, C);
  return msgCountPacked(lines, rowsPerMsg);
}
export function serializeImg2IrcOptions(o: Img2IrcOptions): Record<string, unknown> {
  const { _smartPaletteA, _smartPaletteB, ...rest } = o as any;
  return { ...rest };
}
export function deserializeImg2IrcOptions(j: Record<string, unknown>): Partial<Img2IrcOptions> {
  const clone = { ...j } as any;
  delete clone._smartPaletteA; delete clone._smartPaletteB;
  return clone;
}
