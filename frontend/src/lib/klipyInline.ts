/**
 * Klipy share links (`https://klipy.com/gifs/<slug>`) → slugs for inline
 * rendering. The page itself is behind a Cloudflare challenge, so the
 * media comes from the gateway's `/api/embed/klipy?slug=` resolver (KLIPY
 * Items API with the partner key); this module only finds the links.
 */

const KLIPY_RE = /(?<![\w.-])(?:https?:\/\/)?(?:www\.)?klipy\.com\/gifs\/([a-z0-9][a-z0-9-]{0,127})(?![a-z0-9-])/gi;

/** Slugs of every klipy.com/gifs/<slug> link in `text`, in order, deduped. */
export function extractKlipySlugsFromText(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  KLIPY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KLIPY_RE.exec(text)) !== null) {
    const slug = m[1].toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

export interface KlipyRendition { url: string; width: number; height: number }
export interface KlipyEmbed {
  slug: string;
  title: string;
  page: string;
  webp: KlipyRendition | null;
  gif: KlipyRendition | null;
  mp4: KlipyRendition | null;
  poster: KlipyRendition | null;
}

/** Resolver URL for a slug; the response is `KlipyEmbed`, 503 when the
 *  gateway has no KLIPY key, 404 for an unknown slug. */
export function klipyEmbedUrl(slug: string): string {
  return `/api/embed/klipy?slug=${encodeURIComponent(slug)}`;
}
