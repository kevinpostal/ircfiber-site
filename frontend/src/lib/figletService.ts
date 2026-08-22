export type FigletFont = { name:string; height:number; data: Uint8Array };
export class FigletService {
  async loadManifest(url='/figlet-fonts.json'):Promise<Array<{name:string;height:number;url:string}>>{
    try{ const r=await fetch(url); if(!r.ok) return []; const j=await r.json() as any; return j.fonts ?? []; } catch{ return []; }
  }
  async fetchFont(url:string):Promise<Uint8Array|null>{ try{ const r=await fetch(url); if(!r.ok) return null; const b=await r.arrayBuffer(); return new Uint8Array(b);}catch{return null;} }
}
