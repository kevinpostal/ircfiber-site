/**
 * Mobile keyboard viewport tracking.
 *
 * iOS Safari (and iOS home-screen web apps) never resize the layout
 * viewport when the on-screen keyboard opens: they shrink the *visual*
 * viewport and scroll the page so the focused field stays visible. With a
 * 100dvh app shell that pushes the buffer header off-screen and leaves the
 * composer floating over a half-hidden message list. Chrome/Android only
 * resizes the layout viewport with `interactive-widget=resizes-content`.
 *
 * When the visual viewport is meaningfully shorter than the layout viewport
 * (keyboard up) we publish its height as `--app-height` on <html> and pin
 * the window scroll at 0, so the app shell shrinks to the space above the
 * keyboard: header stays visible, MessageList's ResizeObserver re-pins the
 * bottom, and the composer sits directly on the keyboard. Otherwise the
 * property is cleared and CSS falls back to 100dvh.
 */

/** Minimum layout/visual height delta treated as an open keyboard. */
const KEYBOARD_MIN_PX = 80;

export function installViewportTracker(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const root = document.documentElement;
  let raf = 0;

  const apply = () => {
    raf = 0;
    // Pinch-zoom also shrinks the visual viewport; leave that alone.
    if (vv.scale > 1.01) {
      root.style.removeProperty('--app-height');
      return;
    }
    const h = Math.round(vv.height);
    if (window.innerHeight - h > KEYBOARD_MIN_PX) {
      root.style.setProperty('--app-height', `${h}px`);
      if (window.scrollY !== 0 || vv.offsetTop !== 0) window.scrollTo(0, 0);
    } else {
      root.style.removeProperty('--app-height');
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(apply);
  };

  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  apply();

  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    if (raf) cancelAnimationFrame(raf);
    root.style.removeProperty('--app-height');
  };
}
