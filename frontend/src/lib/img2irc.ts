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
 *  - Midgard Colors selector (truecolor/vga256/xterm256/16/retro/comic) — render-core.js palettes
 *  - Comic = bilateral pre-filter r2 σ40 ×2 (§6): landscape -11%, run 2.42→3.54
 *  Viterbi objective: Σ[ err(glyph,f,b) + w·glyphBytes ] + w·prefixBytes (w≈2.5 knee)
 */

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
export const VGA256: number[] = (()=>{ const pal:number[]=[]; const CGA_16=[[0,0,0],[0,0,170],[0,170,0],[0,170,170],[170,0,0],[170,0,170],[170,85,0],[170,170,170],[85,85,85],[85,85,255],[85,255,85],[85,255,255],[255,85,85],[255,85,255],[255,255,85],[255,255,255]]; for(const c of CGA_16) pal.push((c[0]<<16)|(c[1]<<8)|c[2]); for(let i=0;i<16;i++){const v=Math.round(i*255/15); pal.push((v<<16)|(v<<8)|v);} const levels=[0,51,102,153,204,255]; for(let r=0;r<6;r++) for(let g=0;g<6;g++) for(let b=0;b<6;b++) pal.push((levels[r]<<16)|(levels[g]<<8)|levels[b]); for(let i=0;i<8;i++){const v=Math.round(i*40/7); pal.push((v<<16)|(v<<8)|v);} return pal; })();
export const XTERM256: number[] = (()=>{ const pal:number[]=[]; const ANSI_16=[[0,0,0],[170,0,0],[0,170,0],[170,85,0],[0,0,170],[170,0,170],[0,170,170],[170,170,170],[85,85,85],[255,85,85],[85,255,85],[255,255,85],[85,85,255],[255,85,255],[85,255,255],[255,255,255]]; for(const c of ANSI_16) pal.push((c[0]<<16)|(c[1]<<8)|c[2]); const levels=[0,95,135,175,215,255]; for(let r=0;r<6;r++) for(let g=0;g<6;g++) for(let b=0;b<6;b++) pal.push((levels[r]<<16)|(levels[g]<<8)|levels[b]); for(let i=0;i<24;i++){const v=8+i*10; pal.push((v<<16)|(v<<8)|v);} return pal; })();

export type RenderMode = 'irc' | 'ansi' | 'ansi24';
export type PixelMode = 'half' | 'full' | 'quarter' | 'braille';
export type SamplingFilter = 'nearest' | 'linear';
export type DitherMode = 'none' | 'bayer4' | 'bayer8' | 'floyd' | 'atkinson' | 'sierra' | 'stucki' | 'jarvis';
export type ColorMatching = 'rgb' | 'lab' | 'oklab';
export type MidgardColorMode = 'truecolor' | 'vga256' | 'xterm256' | '16' | 'retro' | 'comic';

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
}

export function getMidgardPalette(o: Img2IrcOptions): number[] {
  if(o.midgardMode==='vga256') return VGA256;
  if(o.midgardMode==='xterm256') return XTERM256;
  if(o.midgardMode==='16' || o.midgardMode==='retro') return ANSI16;
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
const DEFAULTS: Img2IrcOptions = {
  width: 60, renderMode: 'ansi24', pixelMode: 'half', filter: 'linear',
  brightness: 0, contrast: 0, gamma: 0, saturation: 0, hue: 0,
  invert: false, grayscale: false, sepia: false, normalize: false, dither: false,
  ditherMode: 'none', colorMatching: 'lab',
  flipH: false, flipV: false, rotate: 0, pixelize: 0, blur: 0, nograyscale: false, viterbiW: 2.5, comic: false,
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
  let best=0,bestD=1e12;
  for(let i=0;i<pal.length;i++){const c=pal[i],cr=(c>>16)&255,cg=(c>>8)&255,cb=c&255, d=colorDist2(r,g,b, cr,cg,cb, mode); if(d<bestD){bestD=d;best=i;if(d===0)break;}}
  return best;
}

// ── Color LUT + nograyscale ───────────────────────────────────────────────────
const COLOR_LUT=new Map<string,{irc:number,ansi:number,ircNg:number,ansiNg:number}>();
function lutLookup(r:number,g:number,b:number,ng:boolean, mode:ColorMatching='rgb'){
  const k=`${r},${g},${b},${mode},${ng}`; let e=COLOR_LUT.get(k);
  if(!e){
    const ansi=nearestIndex(r,g,b,ANSI256, mode)&255, irc=Math.min(nearestIndex(r,g,b,IRC99, mode),98);
    let ansiNg=ansi, ircNg=irc;
    if(!_isNearGray(_pack(r,g,b))){
      let bd=1e12; for(let i=0;i<ANSI256.length;i++){if(_isNearGray(ANSI256[i]))continue;const c=ANSI256[i],cr=(c>>16)&255,cg=(c>>8)&255,cb=c&255, d=colorDist2(r,g,b, cr,cg,cb, mode); if(d<bd){bd=d;ansiNg=i;if(d===0)break;}}
      bd=1e12; for(let i=0;i<IRC99.length;i++){if(_isNearGray(IRC99[i]))continue;const c=IRC99[i],cr=(c>>16)&255,cg=(c>>8)&255,cb=c&255, d=colorDist2(r,g,b, cr,cg,cb, mode); if(d<bd){bd=d;ircNg=Math.min(i,98);if(d===0)break;}}
    }
    e={ansi,irc,ansiNg,ircNg}; COLOR_LUT.set(k,e);
  }
  return ng?{ansi:e.ansiNg,irc:e.ircNg}:{ansi:e.ansi,irc:e.irc};
}
export function clearColorLut(){COLOR_LUT.clear();}
// For IRC, \x03 only supports 0-98. ANSI 256 indices 99-255 must be remapped to nearest 99.
function ansiToIrcIdx(ansiIdx:number):number{
  const c=ANSI256[ansiIdx & 255], r=(c>>16)&255,g=(c>>8)&255,b=c&255;
  return Math.min(nearestIndex(r,g,b,IRC99),98);
}
function toEmitIdx(idx:number, mode:RenderMode):number{
  return mode==='ansi' ? ansiToIrcIdx(idx) : Math.min(idx,98);
}

function kNearest(r:number,g:number,b:number,pal:number[],k:number,ng:boolean, mode:ColorMatching='rgb'):number[]{
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
// Glyphs — measured ink coverage of DejaVu Sans Mono (reference/glyph_coverage.txt)
// A glyph of coverage c shows blend c*fg + (1-c)*bg; swapped needs no entry: ordered (fg,bg) state already realises 1-c.
// The 1-byte shade ramp covers 0.273 max: 55% of blend range [0,0.273]U[0.727,1], mid gap needs 3-byte ▒ (0.494)
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
  {ch:'▒', ct:0.490, cb:0.499, bytes:3}, // mid-tone gap filler (0.494)
  // dominated but kept — Viterbi never picks over 1-byte/▀▄ at same ΔE
  {ch:'░', ct:0.183, cb:0.181, bytes:3},
  {ch:'▓', ct:0.796, cb:0.816, bytes:3},
  {ch:'█', ct:1.0,   cb:1.0,   bytes:3}, // never best vs ' ' (same error, 3B vs 1B) — kept to prove dominated
];
const GLYPH_BYTES_HALF=3, GLYPH_BYTES_SPACE=1;
function bestGlyphForState(
  r1:number,g1:number,b1:number, r2:number,g2:number,b2:number,
  f:number,b:number, pal:number[], mode:ColorMatching, w:number
):{err:number, bytes:number, glyph:string}{
  let bestErr=1e18, bestB=GLYPH_BYTES_HALF, bestG='▀';
  const fR=(pal[f]>>16)&255, fG=(pal[f]>>8)&255, fB=pal[f]&255;
  const bR=(pal[b]>>16)&255, bG=(pal[b]>>8)&255, bB=pal[b]&255;
  for(const g of GLYPHS){
    const ct=g.ct, cb=g.cb;
    const tR=Math.round(fR*ct + bR*(1-ct)), tG=Math.round(fG*ct + bG*(1-ct)), tB=Math.round(fB*ct + bB*(1-ct));
    const boR=Math.round(fR*cb + bR*(1-cb)), boG=Math.round(fG*cb + bG*(1-cb)), boB=Math.round(fB*cb + bB*(1-cb));
    const e=colorDist2(r1,g1,b1, tR,tG,tB, mode) + colorDist2(r2,g2,b2, boR,boG,boB, mode);
    const cand=e + w*g.bytes;
    if(cand < bestErr + w*bestB){ bestErr=e; bestB=g.bytes; bestG=g.ch; }
  }
  return {err:bestErr, bytes:bestB, glyph:bestG};
}
function rowPaletteForViterbi(
  tops:Array<[number,number,number,number]>, bots:Array<[number,number,number,number]>,
  pal:number[], ng:boolean, mode:ColorMatching, size=12
):number[]{
  const k=2, freq=new Map<number,number>();
  for(let c=0;c<tops.length;c++){
    const [r1,g1,b1]=tops[c], [r2,g2,b2]=bots[c];
    if(_nearBlack(r1,g1,b1)&&_nearBlack(r2,g2,b2)) continue;
    for(const idx of kNearest(r1,g1,b1,pal,k,ng,mode)) freq.set(idx,(freq.get(idx)||0)+1);
    for(const idx of kNearest(r2,g2,b2,pal,k,ng,mode)) freq.set(idx,(freq.get(idx)||0)+1);
  }
  const sorted=[...freq.entries()].sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,size).map(e=>e[0]);
  if(sorted.length===0) return [0,1,7].slice(0,size);
  return sorted;
}

// Bilateral pre-filter — edge-preserving smoother (spec §6, Midgard comic mode)
// Single pass radius 2 sigma 40: landscape 15 930→14 184 B (-11%), run 2.42→3.54
function applyBilateralFilter(d: Uint8ClampedArray, pW:number, pH:number, radius=2, sigma=40, passes=1): void {
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
            const wt=Math.exp(-d2/sigma2);
            accR+=wt*r; accG+=wt*g; accB+=wt*b; wsum+=wt;
          }
        }
        tmp[i]=Math.round(accR/wsum); tmp[i+1]=Math.round(accG/wsum); tmp[i+2]=Math.round(accB/wsum); tmp[i+3]=src[i+3];
      }
    }
    d.set(tmp);
  }
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
  let d=id.data;

  if(o.gamma!==0&&o.gamma!==1){const g=o.gamma;for(let i=0;i<d.length;i+=4){d[i]=255*Math.pow(d[i]/255,1/g);d[i+1]=255*Math.pow(d[i+1]/255,1/g);d[i+2]=255*Math.pow(d[i+2]/255,1/g);}}
  if(o.normalize){let mn=255,mx=0;for(let i=0;i<d.length;i+=4){const l=luma(d[i],d[i+1],d[i+2]);if(l<mn)mn=l;if(l>mx)mx=l;}const rng=Math.max(1,mx-mn);for(let i=0;i<d.length;i+=4){d[i]=((d[i]-mn)*255)/rng;d[i+1]=((d[i+1]-mn)*255)/rng;d[i+2]=((d[i+2]-mn)*255)/rng;}}
  if(o.comic){
    // Comic / bilateral: edge-preserving smoother — flattens gradients, lengthens runs
    // without blurring edges (spec §6, O(W·H·r²)). 2 passes radius 2 sigma 40 matches
    // measured landscape 15 930→14 184 B (-11%) run 2.42→3.54, ΔE 14.78→17.53
    applyBilateralFilter(d, pW, pH, 2, 40, 2);
  }
  const ditherMode = o.dither ? (o.ditherMode==='none' ? 'bayer4' : o.ditherMode) : 'none';
  if(ditherMode!=='none'){
    if(ditherMode==='bayer4'){
      const bayer=[[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
      for(let y=0;y<pH;y++){ for(let x=0;x<pW;x++){ const i=(y*pW+x)*4; const tt=(bayer[y%4][x%4]/16 -0.5)*28; d[i]=Math.max(0,Math.min(255,d[i]+tt)); d[i+1]=Math.max(0,Math.min(255,d[i+1]+tt)); d[i+2]=Math.max(0,Math.min(255,d[i+2]+tt)); }}
    } else if(ditherMode==='bayer8'){
      const bayer8=[[0,32,8,40,2,34,10,42],[48,16,56,24,50,18,58,26],[12,44,4,36,14,46,6,38],[60,28,52,20,62,30,54,22],[3,35,11,43,1,33,9,41],[51,19,59,27,49,17,57,25],[15,47,7,39,13,45,5,37],[63,31,55,23,61,29,53,21]];
      for(let y=0;y<pH;y++){ for(let x=0;x<pW;x++){ const i=(y*pW+x)*4; const tt=(bayer8[y%8][x%8]/64 -0.5)*28; d[i]=Math.max(0,Math.min(255,d[i]+tt)); d[i+1]=Math.max(0,Math.min(255,d[i+1]+tt)); d[i+2]=Math.max(0,Math.min(255,d[i+2]+tt)); }}
    } else if(ditherMode==='floyd'){
      if(o.renderMode==='ansi24' || o.midgardMode==='truecolor' || o.midgardMode==='comic'){ /* no palette to dither to in truecolor */ }
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
    }
  }
  src.getContext('2d')!.putImageData(id,0,0);
  id=src.getContext('2d')!.getImageData(0,0,pW,pH);
  d=id.data;

  const pxAt=(x:number,y:number):[number,number,number,number]=>{
    if(x<0||y<0||x>=pW||y>=pH)return[0,0,0,0];
    const i=(y*pW+x)*4;return[d[i],d[i+1],d[i+2],d[i+3]];
  };

  const is24=o.renderMode==='ansi24' || o.midgardMode==='truecolor' || o.midgardMode==='comic', ng=o.nograyscale;
  const lines:string[]=[];

  if(pm==='braille'){
    const POS:Array<[number,number,number]>=[[0,0,0x01],[0,1,0x02],[0,2,0x04],[1,0,0x08],[1,1,0x10],[1,2,0x20],[0,3,0x40],[1,3,0x80]];
    for(let r=0;r<rows;r++){let ln='',lastCode='',first=true;
      for(let c=0;c<cols;c++){let br=0x2800,sR=0,sG=0,sB=0,sN=0;
        for(const[dx,dy,bit]of POS){const x=c*2+dx,y=r*4+dy;const[rr,gg,bb,aa]=pxAt(x,y);if((o.alphaMode==='transparent' ? aa < o.alphaThreshold : false))continue;if(luma(rr,gg,bb)>127){br|=bit;sR+=rr;sG+=gg;sB+=bb;sN++;}}
        if(sN===0||br===0x2800){ln+=' ';first=false;continue;}
        const code=is24? '\x04'+toHex6(sR/sN|0,sG/sN|0,sB/sN|0) : '\x03'+String(toEmitIdx(o.renderMode==='ansi'? lutLookup(sR/sN|0,sG/sN|0,sB/sN|0,ng, o.colorMatching).ansi : lutLookup(sR/sN|0,sG/sN|0,sB/sN|0,ng, o.colorMatching).irc, o.renderMode));
        if(first||lastCode!==code){ln+=code;lastCode=code;}
        ln+=String.fromCharCode(br);first=false;
      }
      ln=ln.replace(/[ ]+$/g,'');lines.push(ln);
    }
  } else if(pm==='quarter'){
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
          } else {
            // indexed: never emit █ — use space+bg (1B vs 3B, bg sticky)
            const bgS=String(toEmitIdx(o.renderMode==='ansi'? lutLookup(onR/onC|0,onG/onC|0,onB/onC|0,ng, o.colorMatching).ansi : lutLookup(onR/onC|0,onG/onC|0,onB/onC|0,ng, o.colorMatching).irc, o.renderMode));
            const cd='\x03'+bgS+','+bgS;
            if(first||lastFg!==bgS||lastBg!==bgS){ln+=cd;lastFg=bgS;lastBg=bgS;}
            ln+=' ';first=false;continue;
          }
        } else {
          const fgS=is24? toHex6(onR/onC|0,onG/onC|0,onB/onC|0) : String(toEmitIdx(o.renderMode==='ansi'? lutLookup(onR/onC|0,onG/onC|0,onB/onC|0,ng, o.colorMatching).ansi : lutLookup(onR/onC|0,onG/onC|0,onB/onC|0,ng, o.colorMatching).irc, o.renderMode));
          const bgS=is24? toHex6(offR/offC|0,offG/offC|0,offB/offC|0) : String(toEmitIdx(o.renderMode==='ansi'? lutLookup(offR/offC|0,offG/offC|0,offB/offC|0,ng, o.colorMatching).ansi : lutLookup(offR/offC|0,offG/offC|0,offB/offC|0,ng, o.colorMatching).irc, o.renderMode));
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
    const useViterbi = o.viterbiW>0 && !is24 && cols>1;
    if(useViterbi){
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
        const S=rowPaletteForViterbi(tops,bots,pal,ng,o.colorMatching,12);
        const states: Array<[number,number]> = [];
        for(const f of S) for(const b of S) states.push([f,b]);
        const M=cols;
        type GlyphInfo={err:number, bytes:number, glyph:string};
        const cellGlyph: GlyphInfo[][] = new Array(M);
        const cellIsEmpty: boolean[] = new Array(M);
        for(let i=0;i<M;i++){
          const [r1,g1,b1,a1]=tops[i], [r2,g2,b2,a2]=bots[i];
          const isEmpty=(o.alphaMode==='transparent'?a1<o.alphaThreshold:false)&&(o.alphaMode==='transparent'?a2<o.alphaThreshold:false) || (_nearBlack(r1,g1,b1)&&_nearBlack(r2,g2,b2));
          cellIsEmpty[i]=isEmpty;
          if(isEmpty){ cellGlyph[i]=[]; continue; }
          const rowGlyphs: GlyphInfo[] = new Array(states.length);
          for(let s=0;s<states.length;s++){
            const [f,b]=states[s];
            rowGlyphs[s]=bestGlyphForState(r1,g1,b1,r2,g2,b2,f,b,pal,o.colorMatching,o.viterbiW);
          }
          cellGlyph[i]=rowGlyphs;
        }
        // DP with predecessor-independent collapsed transition (study_improvements.py)
        const INF=1e18;
        let dp=new Array(states.length).fill(INF);
        const back: number[][] = Array.from({length:M},()=>new Array(states.length).fill(-1));
        for(let s=0;s<states.length;s++){
          if(cellIsEmpty[0]){
            dp[s]=0;
          } else {
            const g=cellGlyph[0][s];
            const [f,b]=states[s];
            const fgM=o.renderMode==='ansi'? ansiToIrcIdx(f): f, bgM=o.renderMode==='ansi'? ansiToIrcIdx(b): b;
            const pc=pairPref(fgM,bgM);
            dp[s]=g.err + o.viterbiW*(g.bytes + pc);
          }
        }
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
            const fgM=o.renderMode==='ansi'? ansiToIrcIdx(f): f, bgM=o.renderMode==='ansi'? ansiToIrcIdx(b): b;
            const g=cellGlyph[i][s];
            const candStay=bMinCost.get(b)!.cost + o.viterbiW*fgPref(fgM);
            const candSwitch=gmin + o.viterbiW*pairPref(fgM,bgM);
            let best=dp[s];
            let bestIdxPrev=s;
            if(candStay < best){ best=candStay; bestIdxPrev=bMinCost.get(b)!.idx; }
            if(candSwitch < best){ best=candSwitch; bestIdxPrev=gidx; }
            nd[s]=best + g.err + o.viterbiW*g.bytes;
            back[i][s]=bestIdxPrev;
          }
          dp=nd;
        }
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
          const fg=o.renderMode==='ansi'? ansiToIrcIdx(fRaw): fRaw, bg=o.renderMode==='ansi'? ansiToIrcIdx(bRaw): bRaw;
          if(glyph===' '){
            const need=first || lastBg!==String(bg);
            if(need){
              const cd='\x03'+fg+','+bg;
              ln+=cd; lastFg=String(fg); lastBg=String(bg);
            }
            ln+=' ';
          } else {
            // ▀ ▄ ░▒▓ + ASCII ramp all need fg+bg; use fg-only when bg sticky
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
          first=false;
        }
        ln=ln.replace(/[ ]+$/g,''); lines.push(ln);
      }
    } else {
      // greedy fallback
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
          } else {
            const l1=lutLookup(r1,g1,b1,ng, o.colorMatching), l2=lutLookup(r2,g2,b2,ng, o.colorMatching);
            const fgRaw=o.renderMode==='ansi'?l1.ansi:l1.irc; const fg=toEmitIdx(fgRaw, o.renderMode); const bgRaw=o.renderMode==='ansi'?l2.ansi:l2.irc; const bg=toEmitIdx(bgRaw, o.renderMode);
            if((o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false)||(o.alphaMode==='transparent' ? a2 < o.alphaThreshold : false)){
              const u=(o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false)?bg:fg; const cd='\x03'+u; if(first||lastFg!==String(u)||lastBg!==''){ln+=cd;lastFg=String(u);lastBg='';}ln+=(o.alphaMode==='transparent' ? a1 < o.alphaThreshold : false)?'▄':'▀';
            } else if(fg===bg){
              // never emit █ — use space+bg (1B vs 3B, bg sticky)
              const need=first || lastBg!==String(bg);
              if(need){ const cd='\x03'+fg+','+bg; ln+=cd; lastFg=String(fg); lastBg=String(bg); }
              ln+=' ';
            } else {
              // fg-only optimization for row continuity
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
    for(let y=0;y<pH;y++){let ln='',lastCode='',first=true;
      for(let x=0;x<pW;x++){const[r,g,b,a]=pxAt(x,y);
        if((o.alphaMode==='transparent' ? a < o.alphaThreshold : false)||_nearBlack(r,g,b)){ln+=' ';continue;}
        const cd=is24? '\x04'+toHex6(r,g,b) : '\x03'+String(toEmitIdx(o.renderMode==='ansi'? lutLookup(r,g,b,ng, o.colorMatching).ansi : lutLookup(r,g,b,ng, o.colorMatching).irc, o.renderMode));
        if(first||lastCode!==cd){ln+=cd;lastCode=cd;}
        ln+='█'; first=false;
      }
      ln=ln.replace(/[ ]+$/g,'');lines.push(ln);
    }
  }

  while(lines.length&&lines[lines.length-1].replace(/[\x03\x04\x0f0-9,a-fA-F]/g,'').trim()==='')lines.pop();
  return lines.join('\n');
}

export function estimateLineLengths(art:string,maxBytes=IRC_SAFE_PAYLOAD){const ls=art.split('\n');let lg=0;for(const l of ls){const b=new TextEncoder().encode(l).length;if(b>lg)lg=b;}return{ok:lg<=maxBytes,longest:lg,lines:ls.length, total:new TextEncoder().encode(art).length};}
export function stripTrailingReset(line:string){return line.replace(/\x0f$/,'');}
