import { tick } from 'svelte';

export const MOBILE_VIEWPORTS = {
  iphone: { width: 390, height: 844 },
  android: { width: 360, height: 740 },
} as const;

export const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;

let initialViewport: { width: number; height: number } | null = null;

/**
 * Resize the browser viewport to the given CSS size, then settle so the
 * `matchMedia('(max-width: 800px)')` effect in `App.svelte` applies `isNarrow`.
 *
 * Confirmed mechanism (vitest 4 browser tests run inside a same-origin
 * `vitest-iframe`; the `page` object is locator-only with no resize API):
 * resizing the iframe element itself changes the inner layout viewport, so
 * `matchMedia` and CSS layout react for real — no stubbing involved.
 */
export async function setViewport(width: number, height: number): Promise<void> {
  if (!initialViewport) {
    initialViewport = { width: window.innerWidth, height: window.innerHeight };
  }
  const frameEl = window.frameElement as HTMLIFrameElement | null;
  if (frameEl) {
    frameEl.style.width = `${width}px`;
    frameEl.style.height = `${height}px`;
  }
  // If there is no frame element (non-iframe runner), the resize below is a
  // no-op and the viewport stays as-is: drawer-logic asserts still run, but
  // real-layout asserts (overflow, rects) are only meaningful with the
  // iframe resize above.
  window.dispatchEvent(new Event('resize'));
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await tick();
  await tick();
}

/** Restore the viewport size from before the first `setViewport` call. */
export async function restoreViewport(): Promise<void> {
  if (!initialViewport) return;
  const { width, height } = initialViewport;
  const frameEl = window.frameElement as HTMLIFrameElement | null;
  if (frameEl) {
    frameEl.style.width = `${width}px`;
    frameEl.style.height = `${height}px`;
  }
  window.dispatchEvent(new Event('resize'));
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await tick();
  await tick();
}

/** Shared invariant: no horizontal overflow (1px tolerance for subpixel rounding). */
export function assertNoHorizontalOverflow(): void {
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  if (overflow > 1) {
    throw new Error(
      `horizontal overflow: scrollWidth=${document.documentElement.scrollWidth} innerWidth=${window.innerWidth}`,
    );
  }
}

/** Timestamp-overlap assert helper: true when the two rects are disjoint. */
export function rectsDoNotOverlap(a: DOMRect, b: DOMRect): boolean {
  return b.left >= a.right || a.left >= b.right || b.top >= a.bottom || a.top >= b.bottom;
}
