/**
 * MediaDock layout geometry — pure, framework-free helpers for the floating
 * YouTube mini player (`MediaDock.svelte`).
 *
 * Contract
 * --------
 * - This module imports nothing (in particular nothing from `src/stores` or
 *   any `.svelte` / `.svelte.ts` file) so it runs under the Node `lib` vitest
 *   project as well as in the browser.
 * - A `DockLayout` is the dock's border-box position and width in CSS pixels
 *   relative to the viewport: `{ x: left, y: top, w: width }`. Height is never
 *   stored — it is derived from `w` and the title-bar height (`dockHeightFor`)
 *   so the video keeps a 16:9 aspect ratio.
 * - `.mediaDock` is `box-sizing: border-box` with a 1px border on each side,
 *   so `dockHeightFor(w, barH) = barH + (w - 2) * 9/16 + 2` is the exact
 *   rendered height.
 * - `clampDockLayout` / `resizeDockWidth` keep the dock at least `DOCK_MARGIN`
 *   inside the viewport on every side; when the viewport is too small for even
 *   that, the dock is pinned to the top/left margin (`clampOrPin`) and the
 *   width floors at a hard minimum so the player never collapses to nothing.
 *   Both return rounded integers and never mutate their input.
 * - `parseDockLayout` is a *structural* check on the persisted JSON: an object
 *   with finite numeric `x`, `y`, `w` yields a fresh `{ x, y, w }` (any other
 *   fields are dropped), anything else yields `null`. It performs no range
 *   checks — callers clamp against the live viewport before rendering.
 * - `DOCK_LAYOUT_KEY` is a raw dot-key: it must bypass the `ircfiber:*`
 *   preference helpers (24h TTL, wiped on sign-out) exactly like
 *   `ircfiber.sidebarCollapsed`.
 * - `chipTransform(from, to)` is the CSS transform (with `transform-origin: 0 0`)
 *   that maps viewport box `from` onto viewport box `to`; the minimize / restore
 *   animation plays it forwards / backwards on the dock root. A zero-sized
 *   `from` (element measured while hidden) yields `'none'`.
 */

export interface DockLayout {
  /** Left edge (px from the viewport's left). */
  x: number;
  /** Top edge (px from the viewport's top). */
  y: number;
  /** Border-box width (px). */
  w: number;
}

export interface DockViewport {
  /** `window.innerWidth`. */
  vw: number;
  /** `window.innerHeight`. */
  vh: number;
  /** Rendered height of the dock's title bar (px). */
  barH: number;
}

/** A viewport box in CSS pixels (a plain object, never a `DOMRect`). */
export interface ChipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Duration of the minimize / restore animation (ms). */
export const DOCK_ANIM_MS = 280;
export const DOCK_ANIM_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

/** CSS transform (origin 0 0) that maps box `from` onto box `to`. */
export function chipTransform(from: ChipRect, to: ChipRect): string {
  if (from.width === 0 || from.height === 0) return 'none';
  return `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;
}

/** localStorage key (raw dot-key, see module doc). */
export const DOCK_LAYOUT_KEY = 'ircfiber.mediaDockLayout';
/** Smallest width the user can resize to when the viewport allows it. */
export const DOCK_MIN_W = 200;
/** Largest width the user can resize to. */
export const DOCK_MAX_W = 720;
/** Gap kept between the dock and every viewport edge. */
export const DOCK_MARGIN = 8;
/** Title-bar height assumed before the bar has been measured. */
export const DOCK_BAR_H_FALLBACK = 24;

/** Absolute floor, used only when `vw < DOCK_MIN_W + 2 * DOCK_MARGIN`. */
const DOCK_HARD_MIN_W = 120;
/** 1px border on each side; `.mediaDock` is border-box. */
const BORDER = 2;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Like `clamp`, but when the range inverts (`hi < lo`) pins to `lo`. */
function clampOrPin(v: number, lo: number, hi: number): number {
  return hi < lo ? lo : clamp(v, lo, hi);
}

/** Exact rendered height of a dock `w` px wide with a `barH` px title bar. */
export function dockHeightFor(w: number, barH: number): number {
  return barH + ((w - BORDER) * 9) / 16 + BORDER;
}

/** Widest the dock may be in this viewport (never below the hard minimum). */
export function maxDockWidthFor(vp: DockViewport): number {
  return Math.max(DOCK_HARD_MIN_W, Math.min(DOCK_MAX_W, vp.vw - 2 * DOCK_MARGIN));
}

/**
 * Width to apply while resizing from the bottom-right grip with the top-left
 * corner anchored at `(x, y)`: capped by the max width, the right edge and
 * (via 16:9) the bottom edge, then clamped to `[min(DOCK_MIN_W, cap), cap]`
 * and rounded.
 */
export function resizeDockWidth(w: number, x: number, y: number, vp: DockViewport): number {
  const rightCap = vp.vw - x - DOCK_MARGIN;
  const bottomCap = ((vp.vh - y - DOCK_MARGIN - vp.barH - BORDER) * 16) / 9 + BORDER;
  const cap = Math.max(DOCK_HARD_MIN_W, Math.min(maxDockWidthFor(vp), rightCap, bottomCap));
  return Math.round(clamp(w, Math.min(DOCK_MIN_W, cap), cap));
}

/**
 * Fit a saved/dragged layout inside the viewport: width first, then x and y
 * against the resulting box. Returns a new object; `l` is never mutated.
 */
export function clampDockLayout(l: DockLayout, vp: DockViewport): DockLayout {
  const wMax = maxDockWidthFor(vp);
  const w = Math.round(clamp(l.w, Math.min(DOCK_MIN_W, wMax), wMax));
  const h = dockHeightFor(w, vp.barH);
  const x = Math.round(clampOrPin(l.x, DOCK_MARGIN, vp.vw - w - DOCK_MARGIN));
  const y = Math.round(clampOrPin(l.y, DOCK_MARGIN, vp.vh - h - DOCK_MARGIN));
  return { x, y, w };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Structural parse of the persisted layout string. Returns `{ x, y, w }` when
 * `raw` is a JSON object whose `x`, `y` and `w` are finite numbers (extra
 * fields dropped), otherwise `null`. No range checks.
 */
export function parseDockLayout(raw: string | null): DockLayout | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { x, y, w } = v as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(w)) return null;
  return { x, y, w };
}
