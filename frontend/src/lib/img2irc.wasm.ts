// Dynamic WASM loader — never breaks the build (static import would)
// Tries to load wasm-img2irc/pkg/wasm_img2irc.js via dynamic import();
// falls back to JS on any error (missing file, no WASM support, etc.)
// No `tried` guard — browser module map caches import(); a stale tried=true
// poisons the real wasm after `wasm-pack build` overwrites the shim.
let wasm: any = null;
let wasmPromise: Promise<any> | null = null;

export async function getWasm(): Promise<any> {
  // Allow bench to force JS fallback without importing real WASM
  try {
    if (typeof process !== 'undefined' && (process as any).env?.IMG2IRC_WASM_OFF === '1') return null;
  } catch {}
  if (wasm) return wasm;
  if (wasmPromise) return wasmPromise;
  wasmPromise = (async () => {
    try {
      // @ts-ignore — pkg may not exist until `wasm-pack build`
      const mod = await import('../../wasm-img2irc/pkg/wasm_img2irc.js');
      // Shim detection: old shim exported only `default init()` with no symbols
      if ((mod as any)?._isWasmShim) {
        console.info('[img2irc] WASM shim detected — JS fallback');
        return null;
      }
      await mod.default();
      // Verify real exports exist; shim has none
      if (typeof mod.bilateral_filter !== 'function' && typeof mod.nearest_index !== 'function') {
        console.info('[img2irc] WASM shim (no exports) — JS fallback');
        return null;
      }
      wasm = mod;
      console.info('[img2irc] WASM loaded', Object.keys(mod).filter(k => typeof mod[k]==='function').join(','));
      return wasm;
    } catch (e) {
      console.info('[img2irc] WASM not available, JS fallback', e);
      return null;
    } finally {
      // allow retry on next call if failed — don't poison
      if (!wasm) wasmPromise = null;
    }
  })();
  return wasmPromise;
}

export function hasWasmSync(): boolean { return wasm !== null; }
export function getWasmSync(): unknown { return wasm; }

// Pre-warm — call at app start / worker start without blocking
export function preloadWasm(): void { void getWasm(); }

// Typed wrappers — each checks wasm presence and falls back to false/null
export async function wasmBilateralFilter(data: Uint8ClampedArray, pW: number, pH: number, radius: number, sigma: number, passes: number): Promise<boolean> {
  const w = await getWasm();
  if (w?.bilateral_filter) {
    try {
      w.bilateral_filter(data, pW, pH, radius, sigma, passes);
      return true;
    } catch {}
  }
  return false;
}

export function tryWasmNearestIndexSync(r: number, g: number, b: number, pal: number[] | Uint32Array, mode: string): number | null {
  if (!wasm?.nearest_index) return null;
  try {
    const u32 = pal instanceof Uint32Array ? pal : new Uint32Array(pal);
    return wasm.nearest_index(r, g, b, u32, mode) as number;
  } catch { return null; }
}

export async function wasmNearestIndex(r: number, g: number, b: number, pal: number[] | Uint32Array, mode: string): Promise<number | null> {
  const w = await getWasm();
  if (!w?.nearest_index) return null;
  try {
    const u32 = pal instanceof Uint32Array ? pal : new Uint32Array(pal);
    return w.nearest_index(r, g, b, u32, mode) as number;
  } catch { return null; }
}

export function tryWasmBestGlyphSync(
  r1:number,g1:number,b1:number,r2:number,g2:number,b2:number,
  fR:number,fG:number,fB:number,bR:number,bG:number,bB:number,
  mode:string, w:number
): number | null {
  if (!wasm?.best_glyph_for_state) return null;
  try {
    return wasm.best_glyph_for_state(r1,g1,b1,r2,g2,b2,fR,fG,fB,bR,bG,bB,mode,w) as number;
  } catch { return null; }
}

export function tryWasmSrgbToOkLabSync(r:number,g:number,b:number): number[] | null {
  if (!wasm?.srgb_to_oklab) return null;
  try {
    const v = wasm.srgb_to_oklab(r,g,b) as Float32Array;
    return [v[0], v[1], v[2]];
  } catch { return null; }
}

function modeToU8(mode: string): number {
  return mode === 'oklab' ? 2 : mode === 'lab' ? 1 : 0;
}

export function tryWasmBatchNearestSync(
  r: Uint8Array, g: Uint8Array, b: Uint8Array,
  pal: number[] | Uint32Array,
  mode: string,
  out: Uint8Array
): number | null {
  if (!wasm?.batch_nearest) return null;
  try {
    const u32 = pal instanceof Uint32Array ? pal : new Uint32Array(pal);
    const m = modeToU8(mode);
    const n = (wasm.batch_nearest as (r:Uint8Array,g:Uint8Array,b:Uint8Array,p:Uint32Array,mode:number,out:Uint8Array)=>number)(r,g,b,u32,m,out);
    return typeof n === 'number' ? n : null;
  } catch { return null; }
}

export function tryWasmBatchBestGlyphSync(
  r1: Uint8Array, g1: Uint8Array, b1: Uint8Array,
  r2: Uint8Array, g2: Uint8Array, b2: Uint8Array,
  statesF: Uint32Array, statesB: Uint32Array,
  palette: number[] | Uint32Array,
  mode: string,
  w: number,
  outGlyph: Uint8Array,
  outErr: Float32Array,
  outBytes: Uint8Array
): number | null {
  if (!wasm?.batch_best_glyph) return null;
  try {
    const u32 = palette instanceof Uint32Array ? palette : new Uint32Array(palette);
    const m = modeToU8(mode);
    const n = (wasm.batch_best_glyph as (r1:Uint8Array,g1:Uint8Array,b1:Uint8Array,r2:Uint8Array,g2:Uint8Array,b2:Uint8Array,sf:Uint32Array,sb:Uint32Array,p:Uint32Array,mode:number,w:number,og:Uint8Array,oe:Float32Array,ob:Uint8Array)=>number)(r1,g1,b1,r2,g2,b2,statesF,statesB,u32,m,w,outGlyph,outErr,outBytes);
    return typeof n === 'number' && n>0 ? n : null;
  } catch { return null; }
}

export function tryWasmBatchRowPaletteSync(
  rTops: Uint8Array, gTops: Uint8Array, bTops: Uint8Array,
  rBots: Uint8Array, gBots: Uint8Array, bBots: Uint8Array,
  palette: number[] | Uint32Array,
  mode: string,
  size: number,
  nograyscale: boolean,
  out: Uint32Array
): number | null {
  if (!wasm?.batch_row_palette) return null;
  try {
    const u32 = palette instanceof Uint32Array ? palette : new Uint32Array(palette);
    const m = modeToU8(mode);
    const ng = nograyscale ? 1 : 0;
    const n = (wasm.batch_row_palette as (rt:Uint8Array,gt:Uint8Array,bt:Uint8Array,rb:Uint8Array,gb:Uint8Array,bb:Uint8Array,p:Uint32Array,mode:number,size:number,ng:number,out:Uint32Array)=>number)(rTops,gTops,bTops,rBots,gBots,bBots,u32,m,size,ng,out);
    return typeof n === 'number' && n>0 ? n : null;
  } catch { return null; }
}
export function tryWasmBatchBestGlyphPolygonSync(
  masks: BigUint64Array,
  statesF: Uint32Array, statesB: Uint32Array,
  palette: number[] | Uint32Array,
  mode: string,
  w: number,
  outGlyph: Uint8Array,
  outErr: Float32Array,
  outBytes: Uint8Array
): number | null {
  if (!wasm?.batch_best_glyph_polygon) return null;
  try {
    const u32 = palette instanceof Uint32Array ? palette : new Uint32Array(palette);
    const m = modeToU8(mode);
    const n = (wasm.batch_best_glyph_polygon as (masks:BigUint64Array,sf:Uint32Array,sb:Uint32Array,p:Uint32Array,mode:number,w:number,og:Uint8Array,oe:Float32Array,ob:Uint8Array)=>number)(masks,statesF,statesB,u32,m,w,outGlyph,outErr,outBytes);
    return typeof n === 'number' && n>0 ? n : null;
  } catch { return null; }
}
