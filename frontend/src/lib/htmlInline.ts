/**
 * HTML inline helpers — mirrors textInline but for HTML files.
 */

const HTML_EXTS = ['html', 'htm', 'xhtml'];

const HTML_EXT_RE = /\.(?:html|htm|xhtml)$/i;

const HTML_URL_RE = new RegExp(`\\.(${HTML_EXTS.join('|')})($|\\?|#)`, 'i');

function isHtmlParts(pathname: string, search: string, hash: string): boolean {
  const p = pathname.toLowerCase();
  const s = search.toLowerCase();
  const h = hash.toLowerCase();
  return HTML_URL_RE.test(p) || HTML_URL_RE.test(s) || HTML_URL_RE.test(h);
}

/**
 * Normalize a raw URL string to a canonical https HTML URL if it looks like
 * an HTML file per extension. Returns null if not HTML.
 */
export function normalizeHtmlUrl(rawUrl: string): string | null {
  let urlStr = rawUrl.trim();
  if (!urlStr) return null;
  if (!/^https?:\/\//i.test(urlStr) && !/^\/\//.test(urlStr)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(urlStr)) urlStr = 'https://' + urlStr;
    else return null;
  }
  if (urlStr.startsWith('//')) urlStr = 'https:' + urlStr;

  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return null;
  }
  if (/^(javascript|vbscript|data):/i.test(u.protocol)) return null;

  const isLoopback = /^(localhost|127\.0\.0\.1|::1)$/i.test(u.hostname) || u.hostname.startsWith('127.');
  if (!isLoopback) u.protocol = 'https:';
  if (isHtmlParts(u.pathname, u.search, u.hash)) return u.href;
  // Also accept /uploads/ paths ending with html ext
  if (u.pathname.startsWith('/uploads/') && HTML_EXT_RE.test(u.pathname)) return u.href;
  return null;
}

function stripTrailingPunc(url: string): string {
  return url.replace(/[.,;!?]+$/, '').replace(/[)]+$/, (m) => {
    // Balance parentheses: if url has more '(' than ')', keep one
    const open = (url.match(/\(/g) || []).length;
    const close = (url.match(/\)/g) || []).length;
    return close > open ? m.slice(1) : m;
  });
}

/**
 * Extract unique normalized html URLs from plain text.
 */
export function extractHtmlUrlsFromText(text: string): string[] {
  const urlRe = /(?:https?:\/\/|\/\/|www\.)[^\s<>"']+/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text))) {
    let raw = m[0];
    raw = stripTrailingPunc(raw);
    const normalized = normalizeHtmlUrl(raw);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export { HTML_EXT_RE };
