export type TextOverlay = { id:string; text:string; x:number; y:number; width:number; height:number; foreground?:[number,number,number]; background?:[number,number,number]; wrap:boolean; autoGrow:boolean; figlet:boolean; figletFont?:string; bold:boolean; italic:boolean; underline:boolean; renderedText?:string };
export function defaultOverlay(overrides?: Partial<TextOverlay>): TextOverlay {
  return { id: Math.random().toString(36).slice(2), text:'Text', x:0, y:0, width:4, height:1, foreground:[255,255,255], background: undefined, wrap:true, autoGrow:true, figlet:false, bold:false, italic:false, underline:false, ...overrides };
}
export function renderableOverlays(overlays: TextOverlay[]): TextOverlay[] { return overlays.filter(o=>o.text.trim().length>0); }
export function hexToRgb(hex:string):[number,number,number]{ const m=hex.replace('#',''); const n=parseInt(m,16); return [(n>>16)&255,(n>>8)&255,n&255]; }
export function rgbToHex(r:number,g:number,b:number):string{ return '#'+r.toString(16).padStart(2,'0')+g.toString(16).padStart(2,'0')+b.toString(16).padStart(2,'0'); }
