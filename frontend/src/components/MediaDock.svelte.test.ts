// Drag / resize / remember for the floating YouTube mini player.
//
// Gestures are hand-dispatched PointerEvents (pointerdown on the handle,
// pointermove/pointerup on window) followed by flushSync, as in
// Sidebar.dragHandle.test.ts. Synthetic pointers make setPointerCapture
// throw NotFoundError, which the component swallows — the window listeners
// are the mechanism under test. The real YouTube iframe is present but never
// read into (cross-origin); iframe load is never awaited.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { flushSync } from 'svelte';
import MediaDock from './MediaDock.svelte';
import { mediaDock, dockVideo, loadDockLayout, setDockLayout } from '../stores/mediaDock.svelte';
import { DOCK_LAYOUT_KEY, DOCK_MAX_W, DOCK_MIN_W, DOCK_MARGIN } from '../lib/mediaDockLayout';
import { restoreViewport, setViewport } from '../test/mobileViewport';

const ID = 'sHuu-kKD0Lc';
type PT = 'mouse' | 'touch';

function renderDock() {
  const r = render(MediaDock, { props: { onSwitchBuffer: vi.fn() } });
  flushSync();
  const root = document.querySelector<HTMLDivElement>('.mediaDock');
  const bar = document.querySelector<HTMLDivElement>('.mediaDock__bar');
  const grip = document.querySelector<HTMLButtonElement>('.mediaDock__resize');
  const iframe = document.querySelector<HTMLIFrameElement>('.mediaDock__frame');
  if (!root || !bar || !grip || !iframe) throw new Error('dock did not render');
  return { ...r, root, bar, grip, iframe };
}

function pointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  at: { x: number; y: number },
  pointerType: PT = 'mouse',
): void {
  const pressed = type === 'pointerdown' || type === 'pointermove';
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      isPrimary: true,
      pointerType,
      button: 0,
      buttons: pressed ? 1 : 0,
      clientX: at.x,
      clientY: at.y,
    }),
  );
  flushSync();
}

function centre(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Press on `handle`, move by (dx, dy) in two steps, release. */
function drag(handle: Element, dx: number, dy: number, pointerType: PT = 'mouse'): void {
  const c = centre(handle);
  pointer(handle, 'pointerdown', c, pointerType);
  pointer(window, 'pointermove', { x: c.x + dx / 2, y: c.y + dy / 2 }, pointerType);
  pointer(window, 'pointermove', { x: c.x + dx, y: c.y + dy }, pointerType);
  pointer(window, 'pointerup', { x: c.x + dx, y: c.y + dy }, pointerType);
}

const near = (a: number, b: number, tol = 1): boolean => Math.abs(a - b) <= tol;
const stored = (): string | null => localStorage.getItem(DOCK_LAYOUT_KEY);
const seed = (x: number, y: number, w: number): void => {
  mediaDock.layout = { x, y, w };
};

describe('MediaDock drag / resize / remember', () => {
  beforeEach(async () => {
    await setViewport(1280, 800);
    localStorage.removeItem(DOCK_LAYOUT_KEY);
    mediaDock.layout = null;
    dockVideo({ videoId: ID, startSeconds: 0, origin: null });
  });

  afterEach(async () => {
    mediaDock.video = null;
    mediaDock.layout = null;
    localStorage.removeItem(DOCK_LAYOUT_KEY);
    await restoreViewport();
  });

  it('drags by the bar and persists once on pointerup', () => {
    seed(100, 100, 320);
    const { root, bar, iframe } = renderDock();
    const before = root.getBoundingClientRect();
    expect(near(before.left, 100) && near(before.top, 100)).toBe(true);

    const c = centre(bar);
    pointer(bar, 'pointerdown', c);
    pointer(window, 'pointermove', { x: c.x + 20, y: c.y + 15 });
    pointer(window, 'pointermove', { x: c.x + 40, y: c.y + 30 });
    // Intermediate frames move the dock but write nothing.
    const mid = root.getBoundingClientRect();
    expect(near(mid.left, 140) && near(mid.top, 130), 'moved before release').toBe(true);
    expect(stored(), 'nothing persisted before pointerup').toBeNull();
    expect(root.classList.contains('mediaDock--dragging')).toBe(true);

    pointer(window, 'pointerup', { x: c.x + 40, y: c.y + 30 });
    const after = root.getBoundingClientRect();
    expect(near(after.left, 140) && near(after.top, 130)).toBe(true);
    expect(root.style.left).toBe('140px');
    expect(root.style.top).toBe('130px');
    expect(near(after.width, before.width, 0.5), 'width unchanged by a move').toBe(true);
    expect(mediaDock.layout).toEqual({ x: 140, y: 130, w: 320 });
    expect(JSON.parse(stored() ?? 'null')).toEqual({ x: 140, y: 130, w: 320 });
    expect(root.classList.contains('mediaDock--dragging')).toBe(false);
    // right/bottom are released with the explicit top/left: the box must not
    // be stretched between `top` and the stylesheet's `bottom: 76px`.
    const gap = after.bottom - iframe.getBoundingClientRect().bottom;
    expect(gap, 'dock bottom hugs the iframe bottom').toBeLessThanOrEqual(2);
  });

  it('first drag from the CSS default corner seeds the layout from the rect', () => {
    const { root, bar } = renderDock();
    expect(root.style.left).toBe('');
    expect(root.classList.contains('mediaDock--free')).toBe(false);
    const before = root.getBoundingClientRect();

    drag(bar, -40, -30);

    const l = mediaDock.layout;
    expect(l).not.toBeNull();
    expect(l!.x).toBe(Math.round(before.left) - 40);
    expect(l!.y).toBe(Math.round(before.top) - 30);
    expect(l!.w).toBe(Math.round(before.width));
    expect(JSON.parse(stored() ?? 'null')).toEqual(l);
    const after = root.getBoundingClientRect();
    expect(near(after.left, before.left - 40) && near(after.top, before.top - 30)).toBe(true);
    expect(root.classList.contains('mediaDock--free')).toBe(true);
  });

  it('a press on × is a click, not a grab, and × still closes the dock', async () => {
    seed(100, 100, 320);
    const { root } = renderDock();
    const close = root.querySelector<HTMLButtonElement>('.mediaDock__close')!;
    const before = root.getBoundingClientRect();

    const c = centre(close);
    pointer(close, 'pointerdown', c);
    pointer(window, 'pointermove', { x: c.x + 60, y: c.y + 60 });
    expect(root.classList.contains('mediaDock--dragging')).toBe(false);
    const mid = root.getBoundingClientRect();
    expect(mid.left).toBe(before.left);
    expect(mid.top).toBe(before.top);
    pointer(window, 'pointerup', { x: c.x + 60, y: c.y + 60 });
    expect(stored()).toBeNull();
    expect(mediaDock.layout).toEqual({ x: 100, y: 100, w: 320 });

    await page.getByRole('button', { name: 'Close mini player' }).click();
    flushSync();
    expect(mediaDock.video).toBeNull();
    expect(document.querySelector('.mediaDock')).toBeNull();
  });

  it('a press without movement restores the previous layout and persists nothing', () => {
    const { root, bar } = renderDock();
    const c = centre(bar);
    pointer(bar, 'pointerdown', c);
    expect(root.classList.contains('mediaDock--dragging')).toBe(true);
    pointer(window, 'pointermove', { x: c.x + 1, y: c.y + 1 }); // under the 2px threshold
    pointer(window, 'pointerup', { x: c.x + 1, y: c.y + 1 });
    expect(mediaDock.layout).toBeNull();
    expect(root.style.left).toBe('');
    expect(stored()).toBeNull();
    expect(root.classList.contains('mediaDock--dragging')).toBe(false);
  });

  it('turns off iframe pointer events only while dragging', () => {
    seed(100, 100, 320);
    const { bar, iframe } = renderDock();
    expect(getComputedStyle(iframe).pointerEvents).toBe('auto');
    const c = centre(bar);
    pointer(bar, 'pointerdown', c);
    pointer(window, 'pointermove', { x: c.x + 30, y: c.y + 10 });
    expect(getComputedStyle(iframe).pointerEvents).toBe('none');
    pointer(window, 'pointerup', { x: c.x + 30, y: c.y + 10 });
    expect(getComputedStyle(iframe).pointerEvents).toBe('auto');
  });

  it('pointercancel ends the gesture', () => {
    seed(100, 100, 320);
    const { root, bar, iframe } = renderDock();
    const c = centre(bar);
    pointer(bar, 'pointerdown', c);
    pointer(window, 'pointermove', { x: c.x + 30, y: c.y + 10 });
    expect(root.classList.contains('mediaDock--dragging')).toBe(true);
    pointer(window, 'pointercancel', { x: c.x + 30, y: c.y + 10 });
    expect(root.classList.contains('mediaDock--dragging')).toBe(false);
    expect(getComputedStyle(iframe).pointerEvents).toBe('auto');
    // A later move for the same pointer is ignored once the gesture ended.
    pointer(window, 'pointermove', { x: c.x + 200, y: c.y + 200 });
    expect(near(root.getBoundingClientRect().left, 130)).toBe(true);
  });

  it('resizes from the grip, anchored top-left, keeping 16:9', () => {
    seed(100, 100, 320);
    const { root, grip, iframe } = renderDock();
    drag(grip, 100, 56);
    const r = root.getBoundingClientRect();
    expect(near(r.width, 420, 0.5)).toBe(true);
    expect(near(r.left, 100) && near(r.top, 100), 'top-left anchored').toBe(true);
    expect(root.style.left).toBe('100px');
    expect(root.style.top).toBe('100px');
    expect(root.style.width).toBe('420px');
    const f = iframe.getBoundingClientRect();
    expect(near(f.height, (f.width * 9) / 16), 'iframe stays 16:9').toBe(true);
    expect(mediaDock.layout).toEqual({ x: 100, y: 100, w: 420 });
    expect(JSON.parse(stored() ?? 'null').w).toBe(420);
  });

  it('clamps resize to DOCK_MIN_W / DOCK_MAX_W', () => {
    seed(100, 100, 320);
    const { root, grip } = renderDock();
    drag(grip, 5000, 0);
    expect(mediaDock.layout!.w).toBe(DOCK_MAX_W);
    expect(near(root.getBoundingClientRect().width, DOCK_MAX_W, 0.5)).toBe(true);
    drag(grip, -5000, 0);
    expect(mediaDock.layout!.w).toBe(DOCK_MIN_W);
    expect(near(root.getBoundingClientRect().width, DOCK_MIN_W, 0.5)).toBe(true);
    expect(JSON.parse(stored() ?? 'null').w).toBe(DOCK_MIN_W);
  });

  it('renders an off-screen saved layout inside the viewport without rewriting it', () => {
    seed(5000, 5000, 320);
    const { root } = renderDock();
    const r = root.getBoundingClientRect();
    expect(r.right).toBeLessThanOrEqual(window.innerWidth - DOCK_MARGIN + 0.5);
    expect(r.bottom).toBeLessThanOrEqual(window.innerHeight - DOCK_MARGIN + 0.5);
    expect(r.left).toBeGreaterThanOrEqual(DOCK_MARGIN - 0.5);
    expect(r.top).toBeGreaterThanOrEqual(DOCK_MARGIN - 0.5);
    // The store keeps the user's spot; only the rendered position is clamped.
    expect(mediaDock.layout).toEqual({ x: 5000, y: 5000, w: 320 });
    expect(stored()).toBeNull();
  });

  it('re-fits when the viewport shrinks', async () => {
    seed(700, 400, 500);
    const { root } = renderDock();
    expect(near(root.getBoundingClientRect().left, 700)).toBe(true);
    await setViewport(390, 700);
    await vi.waitFor(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      expect(vw).toBe(390);
      const r = root.getBoundingClientRect();
      expect(r.right).toBeLessThanOrEqual(vw - DOCK_MARGIN + 0.5);
      expect(r.bottom).toBeLessThanOrEqual(vh - DOCK_MARGIN + 0.5);
      expect(r.left).toBeGreaterThanOrEqual(DOCK_MARGIN - 0.5);
      expect(parseFloat(root.style.width)).toBeLessThanOrEqual(vw - 2 * DOCK_MARGIN);
      expect(r.left + r.width).toBeLessThanOrEqual(vw - DOCK_MARGIN + 0.5);
    });
    // In-memory only: the saved spot survives a keyboard-style resize.
    expect(mediaDock.layout).toEqual({ x: 700, y: 400, w: 500 });
    expect(stored()).toBeNull();
  });

  it('keeps the same iframe element and src across a drag and a resize', () => {
    seed(100, 100, 320);
    const { bar, grip, iframe } = renderDock();
    const src = iframe.src;
    expect(src).toContain(ID);
    drag(bar, 40, 30);
    drag(grip, 60, 0);
    expect(document.querySelector('.mediaDock__frame')).toBe(iframe);
    expect(iframe.isConnected).toBe(true);
    expect(iframe.src).toBe(src);
  });

  it('works with touch pointers and blocks touch scrolling on the handles', () => {
    seed(100, 100, 320);
    const { root, bar, grip } = renderDock();
    drag(bar, 50, 20, 'touch');
    expect(mediaDock.layout).toEqual({ x: 150, y: 120, w: 320 });
    expect(near(root.getBoundingClientRect().left, 150)).toBe(true);
    expect(getComputedStyle(bar).touchAction).toBe('none');
    expect(getComputedStyle(grip).touchAction).toBe('none');
  });

  it('exposes the region and the resize grip by role', async () => {
    renderDock();
    await expect.element(page.getByRole('region', { name: 'Mini player' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Resize mini player' })).toBeInTheDocument();
  });

  it('setDockLayout writes the raw dot-key JSON and loadDockLayout rejects junk', () => {
    setDockLayout({ x: 12, y: 34, w: 300 });
    expect(stored()).toBe('{"x":12,"y":34,"w":300}');
    expect(loadDockLayout()).toEqual({ x: 12, y: 34, w: 300 });
    setDockLayout(null);
    expect(stored()).toBeNull();
    expect(loadDockLayout()).toBeNull();
    localStorage.setItem(DOCK_LAYOUT_KEY, '{nope');
    expect(loadDockLayout()).toBeNull();
    setDockLayout({ x: 1, y: 2, w: 3 }, false);
    expect(mediaDock.layout).toEqual({ x: 1, y: 2, w: 3 });
    expect(stored(), 'persist=false leaves storage alone').toBe('{nope');
  });

  it('double-clicking the bar resets to the default corner', () => {
    seed(100, 100, 320);
    const { root, bar } = renderDock();
    localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify({ x: 100, y: 100, w: 320 }));
    bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    flushSync();
    expect(mediaDock.layout).toBeNull();
    expect(stored()).toBeNull();
    expect(root.style.left).toBe('');
    expect(root.classList.contains('mediaDock--free')).toBe(false);
  });

  it('arrow keys on the grip resize by 16px and persist', () => {
    seed(100, 100, 320);
    const { root, grip } = renderDock();
    const key = (k: string) => {
      grip.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      flushSync();
    };
    key('ArrowRight');
    expect(mediaDock.layout).toEqual({ x: 100, y: 100, w: 336 });
    key('ArrowDown');
    expect(mediaDock.layout!.w).toBe(352);
    key('ArrowLeft');
    key('ArrowUp');
    expect(mediaDock.layout!.w).toBe(320);
    expect(near(root.getBoundingClientRect().width, 320, 0.5)).toBe(true);
    expect(JSON.parse(stored() ?? 'null').w).toBe(320);
  });
});
