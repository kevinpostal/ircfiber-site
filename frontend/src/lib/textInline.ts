/**
 * Text file inline helpers — mirrors imageInline but for hosted text/code files.
 *
 * Detects URLs that look like text/code files (by extension) and should be
 * rendered inline with syntax highlighting. Handles both our upload URLs
 * (https://ircfiber.com/uploads/<uuid>.<ext>) and external text URLs.
 */

const TEXT_EXTS = [
  'txt', 'text', 'log', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx',
  'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'php', 'rb', 'sh', 'bash',
  'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'sql', 'toml',
  'ini', 'conf', 'cfg', 'csv', 'dockerfile', 'makefile', 'py', 'pl', 'pm',
  'swift', 'kt', 'kts', 'scala', 'dart', 'r', 'jl', 'hs', 'erl', 'elm', 'vue',
  'svelte', 'astro', 'tf', 'nix', 'proto', 'zig', 'nim', 'coffee', 'jade',
  'pug', 'twig', 'hbs', 'lua', 'perl', 'ps1', 'tex', 'diff', 'patch',
];

const TEXT_EXT_RE = new RegExp(`\\.(${TEXT_EXTS.join('|').replace('dockerfile', 'dockerfile').replace('makefile', 'makefile')})$`, 'i');
// More permissive: match any of the exts, with optional query/hash
const TEXT_URL_RE = new RegExp(`\\.(${TEXT_EXTS.join('|')})($|\\?|#)`, 'i');

function isTextParts(pathname: string, search: string, hash: string): boolean {
  const p = pathname.toLowerCase();
  const s = search.toLowerCase();
  const h = hash.toLowerCase();
  return TEXT_URL_RE.test(p) || TEXT_URL_RE.test(s) || TEXT_URL_RE.test(h);
}

export function normalizeTextUrl(rawUrl: string): string | null {
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
  // Only inline text snippets we have uploaded (under /uploads/).
  // External URLs like https://www.elecrow.com/...2300mah.html must NOT
  // be fetched and rendered inline — they are not our snippets.
  if (!u.pathname.startsWith('/uploads/')) return null;
  const isLoopback = /^(localhost|127\.0\.0\.1|::1)$/i.test(u.hostname) || u.hostname.startsWith('127.');
  if (!isLoopback) u.protocol = 'https:';
  if (isTextParts(u.pathname, u.search, u.hash)) return u.href;
  // Our uploads are always with extension, but be permissive for /uploads/<id> without extension
  return u.href;
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
 * Extract unique normalized https text file URLs from plain text.
 */
export function extractTextUrlsFromText(text: string): string[] {
  const urlRe = /(?:https?:\/\/|\/\/|www\.)[^\s<>"']+/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text))) {
    let raw = m[0];
    raw = stripTrailingPunc(raw);
    const normalized = normalizeTextUrl(raw);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export { TEXT_EXT_RE };
