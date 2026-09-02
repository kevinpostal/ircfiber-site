/**
 * Shared scroll helpers — mirrors IRCCloud's `scrollTo(y, {animate:true})`
 * (jQuery animate, duration 100, "swing" easing, afterAnimate callback).
 */

let activeRaf: number | null = null;

export function cancelScrollAnimation(): void {
  if (activeRaf !== null) {
    cancelAnimationFrame(activeRaf);
    activeRaf = null;
  }
}

export function animateScrollTo(
  container: HTMLElement,
  target: number,
  duration = 100,
  afterAnimate?: () => void,
  onFrame?: () => void,
): void {
  cancelScrollAnimation();
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    container.scrollTop = target;
    afterAnimate?.();
    return;
  }
  const start = container.scrollTop;
  const startTime = performance.now();
  function step(now: number): void {
    const t = Math.min((now - startTime) / duration, 1);
    const eased = 0.5 - Math.cos(Math.PI * t) / 2; // jQuery "swing"
    container.scrollTop = start + (target - start) * eased;
    onFrame?.();
    if (t < 1) activeRaf = requestAnimationFrame(step);
    else {
      activeRaf = null;
      afterAnimate?.();
    }
  }
  activeRaf = requestAnimationFrame(step);
}

export function dividerPos(container: HTMLElement, divider: HTMLElement): number {
  // IRCCloud uses jQuery r.position().top which is offsetTop relative to
  // the scroll container (offsetParent). Use offsetTop when available;
  // fallback to boundingRect for detached/transformed cases.
  const offset = (divider as HTMLElement).offsetTop;
  if (offset && container.contains(divider)) return Math.round(offset);
  return Math.round(
    divider.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop,
  );
}
