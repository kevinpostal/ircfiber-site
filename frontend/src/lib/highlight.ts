/**
 * Custom Highlight API helper for nick mentions.
 * Uses CSS Custom Highlights (CSS.highlights) when available,
 * falling back to existing <span class="mention"> markup for
 * browsers without the API. Tests that expect .mention spans keep
 * passing — this is an additive enhancement.
 */

export function supportsHighlightAPI(): boolean {
  try {
    const cssWithHighlights = CSS as unknown as { highlights?: Map<string, unknown> };
    return typeof CSS !== 'undefined' && !!cssWithHighlights.highlights;
  } catch {
    return false;
  }
}

/**
 * Highlight every occurrence of `nick` inside `root` using the
 * CSS Custom Highlight API. Each match creates a Range that is
 * added to a Highlight named 'mention', styled via
 * `::highlight(mention) { background: gold; }` in app.css.
 *
 * No-ops when the API is unavailable (fallback spans remain).
 * Call `clearHighlights()` to remove. Safe to call repeatedly.
 */
export function highlightMentions(root: HTMLElement, nick: string): void {
  if (!root || !nick) return;
  if (!supportsHighlightAPI()) return;
  try {
    const cssHighlights = CSS as unknown as { highlights?: Map<string, unknown> & { has: (k:string)=>boolean; get:(k:string)=>unknown; set:(k:string,v:unknown)=>void; delete:(k:string)=>void } };
    const highlights = cssHighlights.highlights;
    if (!highlights) return;
    if (highlights.has('mention')) {
      const existing = highlights.get('mention');
      if (existing) {
      }
    }
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nickLower = nick.toLowerCase();
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const text = node.textContent || '';
      const lower = text.toLowerCase();
      let idx = 0;
      while (true) {
        const found = lower.indexOf(nickLower, idx);
        if (found === -1) break;
        const before = found === 0 ? '' : lower[found - 1];
        const after = found + nick.length >= lower.length ? '' : lower[found + nick.length];
        const isWordChar = (c: string) => /[a-z0-9_\[\]{}]/.test(c);
        if ((before && isWordChar(before)) || (after && isWordChar(after))) {
          idx = found + 1;
          continue;
        }
        const range = new Range();
        range.setStart(node, found);
        range.setEnd(node, found + nick.length);
        ranges.push(range);
        idx = found + nick.length;
      }
    }
    if (ranges.length === 0) {
      highlights.delete('mention');
      return;
    }
    const winWithHighlight = window as unknown as { Highlight?: new (...ranges: Range[]) => unknown };
    const HL = winWithHighlight.Highlight;
    if (typeof HL === 'function') {
      const hl = new HL(...ranges);
      highlights.set('mention', hl);
    }
  } catch {
  }
}

export function clearHighlights(): void {
  if (!supportsHighlightAPI()) return;
  try {
    const cssHighlights = CSS as unknown as { highlights?: Map<string, unknown> & { delete:(k:string)=>void } };
    const highlights = cssHighlights.highlights;
    if (highlights) highlights.delete('mention');
  } catch {}
}
