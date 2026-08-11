export default async function init() {}
// Shim intentionally does NOT export WASM symbols (bilateral_filter, etc.)
//so tryWasmBilateral's `if (mod?.bilateral_filter)` check fails and
// the JS fallback in img2irc.ts runs. After `wasm-pack build --target web`
// this file is overwritten by the real wasm-bindgen glue which DOES export
// those symbols and the WASM path is taken.
