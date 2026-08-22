export class FontService {
  hostedFonts = new Map<string, URL>([
    ['cascadia', new URL('/assets/fonts/CascadiaMono.woff2', import.meta.url)],
    ['iosevka', new URL('/assets/fonts/Iosevka.woff2', import.meta.url)],
    ['unifont', new URL('/assets/fonts/unifont.woff2', import.meta.url)],
  ]);
  async populateGoogleFonts(select: HTMLSelectElement, status: HTMLElement): Promise<void> {
    if (!(import.meta as any).env?.VITE_ENABLE_GOOGLE_FONTS) { status.textContent='Google fonts disabled'; return; }
    try {
      const res = await fetch('https://cdn.jsdelivr.net/npm/google-font-metadata@latest/data/google-fonts-v2.json');
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json() as Record<string, any>;
      const monos = Object.entries(j).filter(([,v]: any)=>v.category==='monospace').map(([k])=>k).sort();
      for (const name of monos){ const o=document.createElement('option'); o.value=name; o.textContent=name; select.appendChild(o); }
      status.textContent=`${monos.length} Google fonts`;
    } catch (e:any){ status.textContent='Google fonts unavailable'; }
  }
  async loadFont(key: string): Promise<ArrayBuffer> {
    const url = this.hostedFonts.get(key);
    if (!url) throw new Error(`font ${key} not hosted`);
    const r = await fetch(String(url));
    if (!r.ok) throw new Error(`font fetch ${r.status}`);
    return r.arrayBuffer();
  }
}
