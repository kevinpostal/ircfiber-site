/**
 * YouTube URL helpers — exact IRCCloud parity from /tmp/irc.js:
 *  matchYouTube → parts.hostname.match(/(?:^|\.)youtube(?:-nocookie)?(?:\.googleapis)?\.com$/i)
 *  youTubeParts → search /[?&]v=([^"&?\/ ]{11})/  or pathname /^\/(?:v|e|shorts)\/([^"&?\/ ]{11})/
 *               youtu.be → pathname /^\//([^"&?\/ ]{11})/
 *  ytStart → parses t=1h2m3s / 90s / 1m30s → seconds
 */

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Loose fallback for non-11 ids (shouldn't happen per IRCCloud, but keeps older links working)
const LOOSE_ID_RE = /^[A-Za-z0-9_-]{6,}$/;

function ytStartToSeconds(startString: string | null | undefined): number | undefined {
  if (!startString) return undefined;
  let s = startString.toLowerCase().trim();
  // IRCCloud ytStart: split on h, then m, then s, handling "1h2m3s", "90s", "1m30s", "90"
  let h = 0, m = 0, sec = 0;
  // h
  const hSplit = s.split('h');
  if (hSplit.length > 1) {
    h = parseInt(hSplit[0], 10) || 0;
    s = hSplit.slice(1).join('h');
  }
  const mSplit = s.split('m');
  if (mSplit.length > 1) {
    // if h was present, s is remainder after h; otherwise s is original
    const mPart = mSplit[0];
    // handle case where mSplit includes 's' part
    const sSplit = mSplit.slice(1).join('m').split('s');
    m = parseInt(mPart, 10) || 0;
    if (sSplit[0]) sec = parseInt(sSplit[0], 10) || 0;
    else if (sSplit.length > 1) sec = parseInt(sSplit[1], 10) || 0;
  } else {
    const sSplit = s.split('s');
    if (sSplit.length > 1) {
      sec = parseInt(sSplit[0], 10) || 0;
    } else {
      // plain number like "90" or "90s" without m/h
      const n = parseInt(s, 10);
      if (!isNaN(n)) sec = n;
    }
  }
  const total = h * 3600 + m * 60 + sec;
  return total > 0 ? total : undefined;
}

export function extractYoutubeId(rawUrl: string): string | null {
  let urlStr = rawUrl.trim();
  if (!/^https?:\/\//i.test(urlStr) && !/^\/\//.test(urlStr)) {
    if (/^(?:www\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com|music\.youtube\.com)\//i.test(urlStr)) {
      urlStr = 'https://' + urlStr.replace(/^\/\//, '');
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
  const search = u.search;
  const pathname = u.pathname;
  const hash = u.hash;

  // IRCCloud exact: matchYouTube
  const isYouTube = /(?:^|\.)youtube(?:-nocookie)?(?:\.googleapis)?\.com$/i.test(host);
  const isYoutuBe = /(?:^|\.)youtu\.be$/i.test(host);

  let vid: string | null = null;
  if (isYouTube) {
    let m = search.match(/[?&]v=([^"&?\/ ]{11})/);
    if (m) vid = m[1];
    else {
      m = pathname.match(/^\/(?:v|e|shorts)\/([^"&?\/ ]{11})/);
      if (m) vid = m[1];
    }
    // fallback for embed/ etc (keep our broader handling as extra, but keep 11-char strict)
    if (!vid) {
      m = pathname.match(/^\/embed\/([^"&?\/ ]{11})/);
      if (m) vid = m[1];
    }
  } else if (isYoutuBe) {
    const m = pathname.match(/^\/([^"&?\/ ]{11})/);
    if (m) vid = m[1];
  }
  if (vid && ID_RE.test(vid)) return vid;
  if (vid && LOOSE_ID_RE.test(vid)) return vid;
  return null;
}

export function extractYoutubeStart(rawUrl: string): number | undefined {
  try {
    const u = new URL(rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl);
    const hash = u.hash;
    const search = u.search;
    let ts: string | null = null;
    let m = hash.match(/[#&]t=([^&]+)/);
    if (m) ts = m[1];
    else {
      m = search.match(/[?&]t=([^&]+)/);
      if (m) ts = m[1];
    }
    if (ts) return ytStartToSeconds(ts);
  } catch {}
  return undefined;
}

export function youtubeEmbedUrl(id: string, startSeconds?: number): string {
  // IRCCloud uses www.youtube.com with origin=https://www.irccloud.com, but for
  // ircfiber.com the origin triggers "Sign in to confirm you're not a bot" on
  // click for some videos (hyPXF5q_1BA: www.youtube.com+origin ircfiber=FAIL,
  // same URL with origin irccloud=PASS, no origin=PASS, nocookie+origin ircfiber=PASS).
  // Isolated e2e via /assets/single-hypx.html confirms: only
  // "www.youtube.com + origin ircfiber" fails after click; all other combos pass.
  // Fix: omit origin entirely (bare embed also passes). This matches the
  // minimal YouTube oembed URL and avoids referer/origin mismatch when testing
  // on http://127.0.0.1:8090 vs https://ircfiber.com.
  const params: Record<string, string> = {
    autohide: '1',
    controls: '1',
    rel: '1',
    showinfo: '1',
    fs: '1',
    iv_load_policy: '3',
    modestbranding: '1',
    autoplay: '0',
  };
  if (startSeconds !== undefined && startSeconds > 0) {
    params.start = String(startSeconds);
  }
  return `https://www.youtube.com/embed/${id}?${new URLSearchParams(params).toString()}`;
}

/**
 * Extract all unique YouTube IDs from a plain text string.
 * Uses autolinker-style URL detection to avoid false positives inside
 * already-linked HTML, then maps through extractYoutubeId.
 */
export function extractYoutubeIdsFromText(text: string): string[] {
  if (!text) return [];
  // Reuse autolinker's split: import lazily to avoid circular dep in tests?
  // Instead do lightweight regex scan here: match youtube-ish URLs
  // Keep it permissive so we catch pasted bare links.
  const YT_URL_RE =
    /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^ \s<>"{}|\\^`\[\]]+|embed\/[A-Za-z0-9_-]+|shorts\/[A-Za-z0-9_-]+|v\/[A-Za-z0-9_-]+)|youtu\.be\/[A-Za-z0-9_-]+|music\.youtube\.com\/watch\?[^ \s<>"{}|\\^`\[\]]+|youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]+)[^\s<>"{}|\\^`\[\]]*/gi;

  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = YT_URL_RE.exec(text)) !== null) {
    let raw = m[0];
    // strip trailing punc like autolinker does
    raw = stripTrailingPunc(raw);
    const id = extractYoutubeId(raw);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function stripTrailingPunc(url: string): string {
  while (url.length > 0) {
    const last = url[url.length - 1];
    if ('.;:!?,\'"'.includes(last)) {
      url = url.slice(0, -1);
    } else if (last === ')') {
      const opens = (url.match(/\(/g) || []).length;
      const closes = (url.match(/\)/g) || []).length;
      if (closes > opens) url = url.slice(0, -1);
      else break;
    } else if (last === ']') {
      const opens = (url.match(/\[/g) || []).length;
      const closes = (url.match(/\]/g) || []).length;
      if (closes > opens) url = url.slice(0, -1);
      else break;
    } else break;
  }
  return url;
}
