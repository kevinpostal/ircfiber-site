// Memoization for pure message-formatting functions.
//
// renderText and isBlockArt are pure functions of the input text: given the
// same string they always return the same result.  Without a cache, the
// MessageRow re-runs autolinkHtml / parseIrcFormatting for every message
// on every render — even when the message text hasn't changed and only an
// adjacent message triggered the re-render.  That work is O(text length)
// per message, so a single re-render of a 200-row window can be tens of
// thousands of regex ops.
//
// The cache is an LRU keyed by the text.  Size is bounded so a 10k-message
// buffer with 10k unique texts doesn't grow it without limit; on miss +
// overflow we evict the oldest entry (Map iteration order = insertion
// order).

const MAX_SIZE = 500;
const renderCache = new Map<string, string>();
const blockArtCache = new Map<string, boolean>();

function evictOldest<K, V>(map: Map<K, V>): void {
  if (map.size === 0) return;
  const first = map.keys().next().value;
  if (first !== undefined) map.delete(first);
}

export function memoRenderText(render: (text: string) => string, text: string): string {
  if (!text) return render(text);
  const hit = renderCache.get(text);
  if (hit !== undefined) return hit;
  const result = render(text);
  if (renderCache.size >= MAX_SIZE) evictOldest(renderCache);
  renderCache.set(text, result);
  return result;
}

export function memoBlockArt(detect: (text: string) => boolean, text: string): boolean {
  if (!text) return detect(text);
  const hit = blockArtCache.get(text);
  if (hit !== undefined) return hit;
  const result = detect(text);
  if (blockArtCache.size >= MAX_SIZE) evictOldest(blockArtCache);
  blockArtCache.set(text, result);
  return result;
}

export function clearFormatCache(): void {
  renderCache.clear();
  blockArtCache.clear();
}

export function getFormatCacheStats(): { renderSize: number; blockArtSize: number } {
  return { renderSize: renderCache.size, blockArtSize: blockArtCache.size };
}
