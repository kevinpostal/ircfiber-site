// Dynamic WASM loader — never breaks the build (static import would)
// Tries to load wasm-img2irc/pkg/wasm_img2irc.js via dynamic import();
// falls back to JS on any error (missing file, no WASM support, etc.)
let wasm: any = null;
let tried = false;

export async function getWasm(): Promise<any> {
  if (tried) return wasm;
  tried = true;
  try {
    // @ts-ignore — pkg may not exist until `wasm-pack build`
    const mod = await import('../../wasm-img2irc/pkg/wasm_img2irc.js');
    await mod.default();
    wasm = mod;
    console.info('[img2irc] WASM loaded');
  } catch (e) {
    console.info('[img2irc] WASM not available, JS fallback', e);
    wasm = null;
  }
  return wasm;
}

export function hasWasmSync(): boolean { return wasm !== null; }

// JS fallback exports that mirror the WASM API so callers can branch
// without caring which backend is active.
export async function wasmBilateralFilter(data: Uint8ClampedArray, pW: number, pH: number, radius: number, sigma: number, passes: number): Promise<boolean> {
  const w = await getWasm();
  if (w?.bilateral_filter) {
    try {
      // WASM expects Uint8Array view; pass with transfer semantics
      w.bilateral_filter(data, pW, pH, radius, sigma, passes);
      return true;
    } catch {}
  }
  return false;
}
