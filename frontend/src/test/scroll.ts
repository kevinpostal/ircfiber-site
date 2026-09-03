/**
 * Press a navigation key on the message container the way the scroll
 * suites do (`logScroll(el, 'ArrowUp')`). Dispatches a bubbling keydown
 * so component-level key handlers on `#messages` (or its ancestors) run
 * exactly as they would for a real keypress.
 */
export function logScroll(el: HTMLElement | null, key: string): void {
  if (!el) throw new Error('logScroll: no element');
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
