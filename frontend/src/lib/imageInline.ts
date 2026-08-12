/**
 * Image inline helpers — IRCCloud parity.
 *
 * IRCCloud source (`/tmp/irc.js` INx5 module):
 *   image_ext_parts = ['jpe?g','gif','png','webp']
 *   IMAGE_EXT_RE = new RegExp('\.' + re.c(re.oneOf(image_ext_parts)) + '$')
 *   isImage(urlParts) = RE.test(pathname.toLowerCase())
 *                    || RE.test(search.toLowerCase())
 *                    || RE.test(hash.toLowerCase())
 *   imageUrl() — rewrites for dropbox / pbs.twimg / droplr / steam /
 *                googleusercontent / reddituploads, then generic isImage
 *                check, forcing https. Returns urlParts.href if image else
 *                undefined. File/attachment URLs are excluded earlier.
 */

const IMAGE_EXT_PARTS = ['jpe?g', 'gif', 'png', 'webp'];
// Mirrors IRCCloud's `re.c(re.oneOf(...))` + '$' — built manually to avoid
// pulling in the re helper. Equivalent to /\.(?:jpe?g|gif|png|webp)$/i
const IMAGE_EXT_RE = /\.(?:jpe?g|gif|png|webp)$/i;

function isImageParts(pathname: string, search: string, hash: string): boolean {
  const p = pathname.toLowerCase();
  const s = search.toLowerCase();
  const h = hash.toLowerCase();
  return IMAGE_EXT_RE.test(p) || IMAGE_EXT_RE.test(s) || IMAGE_EXT_RE.test(h);
}

/**
 * Normalize a raw URL string to a canonical https image URL if it looks like
 * an image per IRCCloud's `imageUrl` logic. Returns null if not an image.
 * Also applies the known host rewrites (dropbox, pbs.twimg, droplr) so a
 * bare dropbox.com/s/... link still inlines.
 */
export function normalizeImageUrl(rawUrl: string): string | null {
  let urlStr = rawUrl.trim();
  if (!urlStr) return null;

  // Bare domain like example.com/foo.jpg — autolinker prepends http://
  // We mirror that so a bare image link still counts.
  if (!/^https?:\/\//i.test(urlStr) && !/^\/\//.test(urlStr)) {
    // Only auto-prepend if it looks like a domain + path
    if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\//.test(urlStr)) {
      urlStr = 'https://' + urlStr;
    } else {
      return null;
    }
  }
  if (urlStr.startsWith('//')) urlStr = 'https:' + urlStr;

  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  // Disallow javascript:/data: etc — same as autolinker
  if (/^(javascript|vbscript|data):/i.test(u.protocol)) return null;

  // Rewrites — exact IRCCloud parity from imageUrl()
  // dropbox.com/s/<id>/<file> -> dl.dropboxusercontent.com/s/<id>/<file>
  if (/^(?:www\.)?dropbox\.com$/i.test(host)) {
    const m = u.pathname.match(/^\/s\/([^\/&]+)\/([^\/&]+)\/?$/);
    if (m) return `https://dl.dropboxusercontent.com/s/${m[1]}/${m[2]}`;
  }
  // pbs.twimg.com/media/<id> -> pbs.twimg.com/media/<id>?format=jpg&name=small
  if (/^pbs\.twimg\.com$/i.test(host)) {
    const m = u.pathname.match(/^\/media\/([^\/:]+)(:\w+)?\/?$/);
    if (m) return `https://pbs.twimg.com/media/${m[1]}?format=jpg&name=small`;
  }
  // droplr.com / d.pr /i/<id> -> d.pr/i/<id>+
  if (/^droplr\.com$/i.test(host) || /^d\.pr$/i.test(host)) {
    const m = u.pathname.match(/^\/i\/([^\/+]+)/);
    if (m) return `https://d.pr/i/${m[1]}+`;
  }
  // steam / googleusercontent / reddituploads — just force https and return href if isImage elsewhere;
  // for these hosts IRCCloud returns href even when not strictly an image ext (steam ugc path check),
  // but we keep it simple: if host matches and pathname looks like steam ugc, allow.
  if (/\.steam(?:powered|usercontent)\.com$/i.test(host)) {
    const steamMatch = u.pathname.match(/^\/ugc\/([^\/&]+)\/([^\/&]+)\/?/);
    if (steamMatch) {
      u.protocol = 'https:';
      return u.href;
    }
  }
  if (/^lh\d+\.(googleusercontent|ggpht)\.com$/i.test(host) || /i\.reddituploads\.com$/i.test(host)) {
    u.protocol = 'https:';
    return u.href;
  }
  // Generic extension check — keep http for loopback so http://127.0.0.1:8090 uploads don't break with fake https.
  const isLoopback = /^(localhost|127\.0\.0\.1|::1)$/i.test(u.hostname) || u.hostname.startsWith('127.');
  if (!isLoopback) u.protocol = 'https:';
  if (isImageParts(u.pathname, u.search, u.hash)) return u.href;
  return null;
}

function stripTrailingPunc(url: string): string {
  // Mirrors autolinker stripTrailingPunc + IRCCloud cutBackUrl QUOTES handling:
  // peel balanced trailing ) ] } > " ' ` and unbalanced trailing .,!?:;*_
  let s = url;
  // Strip trailing punctuation that is never part of a URL path
  while (/[.,!?:;*_]+$/.test(s)) {
    // Keep balanced closing brackets only if opening exists
    const last = s[s.length - 1];
    if (last === ')' && (s.match(/\(/g)?.length ?? 0) >= (s.match(/\)/g)?.length ?? 0)) break;
    if (last === ']' && (s.match(/\[/g)?.length ?? 0) >= (s.match(/\]/g)?.length ?? 0)) break;
    if (last === '}' && (s.match(/\{/g)?.length ?? 0) >= (s.match(/\}/g)?.length ?? 0)) break;
    s = s.slice(0, -1);
  }
  // Strip trailing quote/bracket if the opener count would go negative
  s = s.replace(/[\)\]\}"'`]+$/, (tail) => {
    let out = tail;
    while (out.length) {
      const ch = out[out.length - 1];
      const opener = ({ ')': '(', ']': '[', '}': '{', '"': '"', "'": "'", '`': '`' } as Record<string, string>)[ch];
      if (!opener) break;
      const opens = (s.slice(0, -out.length + (out.length - tail.length) + s.length).match(new RegExp('\\' + opener, 'g'))?.length ?? 0);
      const closes = (s.match(new RegExp('\\' + ch, 'g'))?.length ?? 0);
      if (closes > opens) out = out.slice(0, -1);
      else break;
    }
    return out;
  });
  return s;
}

/**
 * Extract unique normalized https image URLs from plain text.
 * Mirrors IRCCloud's `splitTextOnUrls` scan but filtered through
 * normalizeImageUrl so only image-ish URLs surface.
 */
export function extractImageUrlsFromText(text: string): string[] {
  if (!text) return [];
  // Permissive URL scanner — same family as youtube's YT_URL_RE but
  // catches any http(s):// + bare domain links. Keep it tight enough
  // to avoid false positives on IRC formatting.
  const URL_RE =
    /(?:https?:\/\/|\/\/)[^\s<>"{}|\\^`\[\]]+|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s<>"{}|\\^`\[\]]*)?/gi;

  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // Reset lastIndex for global re-used across calls
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    let raw = m[0];
    // Autolinker would validate and strip punc; we do the same
    raw = stripTrailingPunc(raw);
    const normalized = normalizeImageUrl(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
export { IMAGE_EXT_RE };
