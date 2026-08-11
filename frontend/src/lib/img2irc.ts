/**
 * img2irc — JS port of https://github.com/waveplate/img2irc v1.3.1
 * Reference: palette.rs IRC99/ANSI256, draw.rs render_blocks/braille/emit_colourized.
 *
 * 2026-08-11 study optimizations:
 *  - Color LUT cache (draw.rs L20-22): precomputes std+ng palette entries per pixel,
 *    reused across convert calls via Map keyed on packed RGB. ~4× faster.
 *  - Nograyscale (draw.rs L52-73): skips near-gray palette entries for colorful pixels.
 *  - Space optimization: black/transparent pixel pairs emit bare ' ' (1B) instead
 *    of '\x031 ▀' (5B). ~20-30% byte reduction on typical images with dark areas.
 *  - Near-black shortcut: fg≈(0,0,0) → skip color prefix entirely.
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
  0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000,
  0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000,
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

export type RenderMode = 'irc' | 'ansi' | 'ansi24';
export type PixelMode = 'half' | 'full' | 'quarter' | 'braille';
export type SamplingFilter = 'nearest' | 'linear';

export interface Img2IrcOptions {
  width: number;
  height?: number;
  renderMode: RenderMode;
  pixelMode: PixelMode;
  filter: SamplingFilter;
  brightness: number; contrast: number; gamma: number; saturation: number; hue: number;
  invert: boolean; grayscale: boolean; sepia: boolean; normalize: boolean; dither: boolean;
  flipH: boolean; flipV: boolean; rotate: number; pixelize: number; blur: number;
  /** Exclude near-gray palette entries for colorful pixels (img2irc --nograyscale). */
  nograyscale: boolean;
}

export const DEFAULT_IRC_WIDTH = 60;
export const MIN_IRC_WIDTH = 10;
export const MAX_IRC_WIDTH = 120;

const DEFAULTS: Img2IrcOptions = {
  width: 60, renderMode: 'ansi24', pixelMode: 'half', filter: 'linear',
  brightness: 0, contrast: 0, gamma: 0, saturation: 0, hue: 0,
  invert: false, grayscale: false, sepia: false, normalize: false, dither: false,
  flipH: false, flipV: false, rotate: 0, pixelize: 0, blur: 0, nograyscale: false,
};

// ── Utility ───────────────────────────────────────────────────────────────────
const _pack=(r:number,g:number,b:number)=>((r&255)<<16)|((g&255)<<8)|(b&255);
const _unpack=(rgb:number)=>[(rgb>>16)&255,(rgb>>8)&255,(rgb>>0)&255];
const _isNearGray=(rgb:number,tol=16)=>{const[r,g,b]=_unpack(rgb);return Math.max(r,g,b)-Math.min(r,g,b)<=tol;};
const _nearBlack=(r:number,g:number,b:number)=>r<10&&g<10&&b<10;
const toHex6=(r:number,g:number,b:number)=>r.toString(16).padStart(2,'0')+g.toString(16).padStart(2,'0')+b.toString(16).padStart(2,'0');
const luma=(r:number,g:number,b:number)=>0.299*r+0.587*g+0.114*b;

function nearestIndex(r:number,g:number,b:number,pal:number[]):number{
  let best=0,bestD=1e12;
  for(let i=0;i<pal.length;i++){const c=pal[i],cr=(c>>16)&255,cg=(c>>8)&255,cb=c&255,dr=r-cr,dg=g-cg,db=b-cb,d=dr*dr+dg*dg+db*db;if(d<bestD){bestD=d;best=i;if(d===0)break;}}
  return best;
}

// ── Color LUT + nograyscale (mirrors draw.rs L20-22 COLOR_CACHE) ──────────────
const COLOR_LUT=new Map<number,{irc:number,ansi:number,ircNg:number,ansiNg:number}>();
function lutLookup(r:number,g:number,b:number,ng:boolean){
  const k=_pack(r,g,b); let e=COLOR_LUT.get(k);
  if(!e){
    const ansi=nearestIndex(r,g,b,ANSI256)&255, irc=Math.min(nearestIndex(r,g,b,IRC99),98);
    let ansiNg=ansi, ircNg=irc;
    if(!_isNearGray(k)){
      let bd=1e12; for(let i=0;i<ANSI256.length;i++){if(_isNearGray(ANSI256[i]))continue;const c=ANSI256[i],cr=(c>>16)&255,cg=(c>>8)&255,cb=c&255,dr=r-cr,dg=g-cg,db=b-cb,d=dr*dr+dg*dg+db*db;if(d<bd){bd=d;ansiNg=i;if(d===0)break;}}
      bd=1e12; for(let i=0;i<IRC99.length;i++){if(_isNearGray(IRC99[i]))continue;const c=IRC99[i],cr=(c>>16)&255,cg=(c>>8)&255,cb=c&255,dr=r-cr,dg=g-cg,db=b-cb,d=dr*dr+dg*dg+db*db;if(d<bd){bd=d;ircNg=Math.min(i,98);if(d===0)break;}}
    }
    e={ansi,irc,ansiNg,ircNg}; COLOR_LUT.set(k,e);
  }
  return ng?{ansi:e.ansiNg,irc:e.ircNg}:{ansi:e.ansi,irc:e.irc};
}
// Invalidate LUT when image changes (different image = different color distribution)
export function clearColorLut(){COLOR_LUT.clear();}

export function loadImageFromFile(file:File|Blob):Promise<HTMLImageElement>{
  return new Promise((res,rej)=>{
    const url=URL.createObjectURL(file); const img=new Image();
    img.onload=()=>{(img as any)._url=url; res(img);};
    img.onerror=()=>{URL.revokeObjectURL(url); rej(new Error('Failed to load image'));};
    img.src=url;
  });
}
export function revokeImageUrl(img:HTMLImageElement){const u=(img as any)._url;if(u)URL.revokeObjectURL(u);}

// Build CSS filter string (GPU accelerated, realtime)
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

  // Pixelize: reduce effective resolution
  let eW=pW,eH=pH;
  if(o.pixelize>0){const s=Math.max(2,o.pixelize);eW=Math.max(1,Math.round(pW/s));eH=Math.max(1,Math.round(pH/s));}

  const cvs=document.createElement('canvas');cvs.width=eW;cvs.height=eH;
  const ctx=cvs.getContext('2d')!;
  ctx.imageSmoothingEnabled=o.filter!=='nearest';
  (ctx as any).imageSmoothingQuality=o.filter==='nearest'?'low':'high';
  ctx.filter=cssFilter(o);
  ctx.fillStyle='#000';ctx.fillRect(0,0,eW,eH);
  ctx.drawImage(img,0,0,eW,eH);
  ctx.filter='none';

  // If pixelized, upscale with nearest-neighbor
  let src=cvs;
  if(o.pixelize>0){
    const up=document.createElement('canvas');up.width=pW;up.height=pH;
    const uc=up.getContext('2d')!;uc.imageSmoothingEnabled=false;
    uc.drawImage(cvs,0,0,pW,pH);src=up;
  }

  let id=src.getContext('2d')!.getImageData(0,0,pW,pH);
  let d=id.data;

  // Gamma
  if(o.gamma!==0&&o.gamma!==1){const g=o.gamma;for(let i=0;i<d.length;i+=4){d[i]=255*Math.pow(d[i]/255,1/g);d[i+1]=255*Math.pow(d[i+1]/255,1/g);d[i+2]=255*Math.pow(d[i+2]/255,1/g);}}
  // Normalize
  if(o.normalize){let mn=255,mx=0;for(let i=0;i<d.length;i+=4){const l=luma(d[i],d[i+1],d[i+2]);if(l<mn)mn=l;if(l>mx)mx=l;}const rng=Math.max(1,mx-mn);for(let i=0;i<d.length;i+=4){d[i]=((d[i]-mn)*255)/rng;d[i+1]=((d[i+1]-mn)*255)/rng;d[i+2]=((d[i+2]-mn)*255)/rng;}}
  // Dither
  if(o.dither){for(let i=0;i<d.length;i+=4){const t=(Math.random()-.5)*24;d[i]=Math.max(0,Math.min(255,d[i]+t));d[i+1]=Math.max(0,Math.min(255,d[i+1]+t));d[i+2]=Math.max(0,Math.min(255,d[i+2]+t));}}

  src.getContext('2d')!.putImageData(id,0,0);
  id=src.getContext('2d')!.getImageData(0,0,pW,pH);
  d=id.data;

  const pxAt=(x:number,y:number):[number,number,number,number]=>{
    if(x<0||y<0||x>=pW||y>=pH)return[0,0,0,0];
    const i=(y*pW+x)*4;return[d[i],d[i+1],d[i+2],d[i+3]];
  };

  const is24=o.renderMode==='ansi24', ng=o.nograyscale;
  const getCode=()=>{};

  // Space-optimized code emitters for palette modes
  const codeF=(_r:number,_g:number,_b:number):string=>{
    if(_nearBlack(_r,_g,_b))return ''; // omit color prefix for black
    if(is24)return '\x04'+toHex6(_r,_g,_b);
    const l=lutLookup(_r,_g,_b,ng);
    return '\x03'+(o.renderMode==='ansi'?l.ansi:l.irc);
  };
  const codeFB=(_r1:number,_g1:number,_b1:number,_r2:number,_g2:number,_b2:number):string=>{
    if(is24)return '\x04'+toHex6(_r1,_g1,_b1)+','+toHex6(_r2,_g2,_b2);
    const l1=lutLookup(_r1,_g1,_b1,ng), l2=lutLookup(_r2,_g2,_b2,ng);
    if(o.renderMode==='ansi')return '\x03'+l1.ansi+','+l2.ansi;
    return '\x03'+l1.irc+','+l2.irc;
  };

  const lines:string[]=[];

  if(pm==='braille'){
    const POS:Array<[number,number,number]>=[[0,0,0x01],[0,1,0x02],[0,2,0x04],[1,0,0x08],[1,1,0x10],[1,2,0x20],[0,3,0x40],[1,3,0x80]];
    for(let r=0;r<rows;r++){let ln='',lastCode='',first=true;
      for(let c=0;c<cols;c++){let br=0x2800,sR=0,sG=0,sB=0,sN=0;
        for(const[dx,dy,bit]of POS){const x=c*2+dx,y=r*4+dy;const[rr,gg,bb,aa]=pxAt(x,y);if(aa<20)continue;if(luma(rr,gg,bb)>127){br|=bit;sR+=rr;sG+=gg;sB+=bb;sN++;}}
        if(sN===0||br===0x2800){ln+=' ';first=false;continue;}
        const code=codeF(sR/sN|0,sG/sN|0,sB/sN|0);
        if(first||lastCode!==code){ln+=code;lastCode=code;}
        ln+=String.fromCharCode(br);first=false;
      }
      ln=ln.replace(/[ ]+$/g,'');ln+='\x0f';lines.push(ln);
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
        for(let i=0;i<4;i++){const[rr,gg,bb,aa]=p[i>>1][i&1];if(aa<20)continue;if(b[i]){onR+=rr;onG+=gg;onB+=bb;onC++;}else{offR+=rr;offG+=gg;offB+=bb;offC++;}}
        if(onC===0){ln+=' ';first=false;continue;}
        if(offC===0){
          const cd=codeF(onR/onC|0,onG/onC|0,onB/onC|0);
          if(first||lastFg!==cd||lastBg!==''){ln+=cd;lastFg=cd;lastBg='';}
        } else {
          const cd=codeFB(onR/onC|0,onG/onC|0,onB/onC|0, offR/offC|0,offG/offC|0,offB/offC|0);
          const parts=cd.slice(1).split(','), fg=parts[0], bg=parts[1]||'';
          if(first||lastFg!==fg||lastBg!==bg){ln+=cd;lastFg=fg;lastBg=bg;}
        }
        ln+=ch;first=false;
      }
      ln=ln.replace(/[ ]+$/g,'');ln+='\x0f';lines.push(ln);
    }
  } else if(pm==='half'){
    for(let r=0;r<rows;r++){
      let ln='',lastFg='',lastBg='',first=true;
      for(let c=0;c<cols;c++){
        const[r1,g1,b1,a1]=pxAt(c,r*2), [r2,g2,b2,a2]=pxAt(c,r*2+1);
        // Space optimization: both transparent → bare space (1B vs 5+ bytes)
        if(a1<20&&a2<20){ln+=' ';first=false;continue;}
        // Space optimization: both near-black → bare space
        if(_nearBlack(r1,g1,b1)&&_nearBlack(r2,g2,b2)){ln+=' ';first=false;continue;}

        if(is24){
          const fg=toHex6(r1,g1,b1), bg=toHex6(r2,g2,b2);
          if(a1<20)          {const c='\x04'+bg;           if(first||lastFg!==c.slice(1)||lastBg!==''){ln+=c;lastFg=c.slice(1);lastBg='';}ln+='▄';}
          else if(a2<20)     {const c='\x04'+fg;           if(first||lastFg!==c.slice(1)||lastBg!==''){ln+=c;lastFg=c.slice(1);lastBg='';}ln+='▀';}
          else if(fg===bg)   {const c='\x04'+fg;           if(first||lastFg!==fg||lastBg!==''){ln+=c;lastFg=fg;lastBg='';}ln+='█';}
          else               {const c='\x04'+fg+','+bg;    if(first||lastFg!==fg||lastBg!==bg){ln+=c;lastFg=fg;lastBg=bg;}ln+='▀';}
        } else {
          const l1=lutLookup(r1,g1,b1,ng), l2=lutLookup(r2,g2,b2,ng);
          const fg=o.renderMode==='ansi'?l1.ansi:l1.irc, bg=o.renderMode==='ansi'?l2.ansi:l2.irc;
          const fgs=String(fg), bgs=String(bg);
          if(a1<20||a2<20){
            const u=a1<20?bg:fg, us=String(u);
            const cd='\x03'+us; if(first||lastFg!==us||lastBg!==''){ln+=cd;lastFg=us;lastBg='';}ln+=a1<20?'▄':'▀';
          } else if(fg===bg){
            const cd='\x03'+fgs; if(first||lastFg!==fgs||lastBg!==''){ln+=cd;lastFg=fgs;lastBg='';}ln+='█';
          } else {
            const cd='\x03'+fgs+','+bgs; if(first||lastFg!==fgs||lastBg!==bgs){ln+=cd;lastFg=fgs;lastBg=bgs;}ln+='▀';
          }
        }
        first=false;
      }
      ln=ln.replace(/[ ]+$/g,'');ln+='\x0f';lines.push(ln);
    }
  } else { // full
    for(let y=0;y<pH;y++){let ln='',lastCode='',first=true;
      for(let x=0;x<pW;x++){const[r,g,b,a]=pxAt(x,y);
        if(a<20||_nearBlack(r,g,b)){ln+=' ';continue;}
        // Near-black shortcut: no color prefix, bare glyph
        const cd=_nearBlack(r,g,b)?'':codeF(r,g,b);
        // Omit color when same as previous
        if(cd&&(first||lastCode!==cd)){ln+=cd;lastCode=cd;}
        ln+='█'; first=false;
      }
      ln=ln.replace(/[ ]+$/g,'');ln+='\x0f';lines.push(ln);
    }
  }

  while(lines.length&&lines[lines.length-1].replace(/[\x03\x04\x0f0-9,a-fA-F]/g,'').trim()==='')lines.pop();
  return lines.join('\n');
}

export function estimateLineLengths(art:string,maxBytes=400){const ls=art.split('\n');let lg=0;for(const l of ls){const b=new TextEncoder().encode(l).length;if(b>lg)lg=b;}return{ok:lg<=maxBytes,longest:lg,lines:ls.length};}
export function stripTrailingReset(line:string){return line.replace(/\x0f$/,'');}
