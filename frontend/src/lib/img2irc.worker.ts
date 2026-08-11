/// <reference lib="webworker" />
// Off-main-thread worker — receives ImageBitmap + opts, runs heavy pipeline
// off the UI thread using OffscreenCanvas + WASM (dynamic import fallback).
// Transferable ImageBitmap avoids copy.

import { imageToIrcArtFromBitmap } from './img2irc';

export type WorkerReq = { id: number; bitmap: ImageBitmap; opts: any };
export type WorkerRes = {
  id: number; ok: boolean; result?: string; error?: string;
  /** Derived smart palettes (midgardMode='smart') — returned so the dialog can cache them once per image. */
  paletteA?: number[];
  paletteB?: number[];
};

self.onmessage = async (e: MessageEvent<WorkerReq>) => {
  const { id, bitmap, opts } = e.data;
  try {
    // Try the worker-safe OffscreenCanvas path first
    let result: string;
    try {
      result = await imageToIrcArtFromBitmap(bitmap, opts);
    } catch (err) {
      // Fallback: worker full pipeline not wired — signal fallback
      throw err;
    }
    const o: any = opts;
    (self as any).postMessage({ id, ok: true, result, paletteA: o._smartPaletteA, paletteB: o._smartPaletteB } as WorkerRes);
  } catch (err: any) {
    (self as any).postMessage({ id, ok: false, error: err?.message ?? String(err) } as WorkerRes);
  } finally {
    try { bitmap.close(); } catch {}
  }
};
