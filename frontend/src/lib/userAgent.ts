// ─────────────────────────────────────────────────────────────────────
// userAgent — friendly one-line summary of a login session's User-Agent
// ─────────────────────────────────────────────────────────────────────
//
// The "Login sessions" panel in Account Settings lists one row per
// session; each row shows the UA string the *server* recorded when the
// session was created. A raw UA ("Mozilla/5.0 (Macintosh; Intel Mac OS
// X 10_15_7) AppleWebKit/537.36 …") is unreadable at a glance, so the
// row shows a summary ("Chrome 152 on macOS") and keeps the raw string
// in a `title` tooltip.
//
// These are strings from the API, NOT the local browser: nothing here
// may touch `navigator`, and the parser must survive UAs from clients
// we have never seen (bots, curl, ancient phones) without throwing.
//
// Pure module — no DOM, no Svelte, no dependencies. Deliberately a
// couple of dozen regexes rather than ua-parser-js: a login list needs
// a name and a major version, not a device database.
// ─────────────────────────────────────────────────────────────────────

export interface UserAgentSummary {
  /** e.g. "Chrome 152", "Safari 18.4", "Firefox 131", "" when unknown */
  browser: string;
  /** e.g. "macOS", "Windows", "Android 15", "iOS 18", "Linux", "" when unknown */
  os: string;
  /** "Chrome 152 on macOS"; falls back to the raw UA when nothing parses, and to "Unknown client" when the UA is empty */
  label: string;
}

/** Longest raw UA we will echo into a one-line row, ellipsis included. */
const MAX_RAW = 80;

/** Clip a raw UA to one row's worth of text, marking the cut with `…`. */
function clip(raw: string): string {
  return raw.length <= MAX_RAW ? raw : `${raw.slice(0, MAX_RAW - 1)}…`;
}

/**
 * First capture of `re`, or `null` when the pattern does not match.
 * A matched pattern whose capture is absent (a token shipped without a
 * version, e.g. bare `Playwright`) yields `''` — distinct from `null`,
 * which is how the callers below tell "not this client" from "this
 * client, version unknown".
 */
function capture(ua: string, re: RegExp): string | null {
  const m = re.exec(ua);
  return m ? (m[1] ?? '') : null;
}

/** `name` plus its version when we found one. */
function named(name: string, version: string): string {
  return version ? `${name} ${version}` : name;
}

/**
 * Crawlers embed whole browser UAs ("… Chrome/131.0.0.0 Safari/537.36;
 * +http://www.google.com/bot.html"), so they must be recognised before
 * the browser chain or every crawler shows up as Chrome.
 */
const BOT_RE = /bot|spider/i;

/**
 * Non-browser clients that legitimately hit the API. Their versions are
 * reported in full — `curl 8.7.1` is meaningful, unlike a browser's
 * four-part marketing version — and `HeadlessChrome` has to be tested
 * before `Chrome`, whose token it contains.
 */
function detectTool(ua: string): string | null {
  const curl = capture(ua, /\bcurl\/([\d.]+)/i);
  if (curl !== null) return named('curl', curl);

  const wget = capture(ua, /\bWget\/([\d.]+)/i);
  if (wget !== null) return named('Wget', wget);

  const requests = capture(ua, /\bpython-requests\/([\d.]+)/i);
  if (requests !== null) return named('python-requests', requests);

  const postman = capture(ua, /\bPostmanRuntime\/([\d.]+)/i);
  if (postman !== null) return named('Postman', postman);

  const playwright = capture(ua, /\bPlaywright(?:\/([\d.]+))?/i);
  if (playwright !== null) return named('Playwright', playwright);

  const headless = capture(ua, /\bHeadlessChrome(?:\/(\d+))?/);
  if (headless !== null) return named('Headless Chrome', headless);

  return null;
}

/**
 * Browser name + major version, or `''`.
 *
 * Order is the whole trick: every Chromium fork keeps `Chrome/` in its
 * UA (Edge adds `Edg/`, Opera `OPR/`, Samsung `SamsungBrowser/`) and
 * Chrome itself keeps `Safari/`. Testing from most specific token to
 * least is what stops Edge from being reported as Chrome and Chrome
 * from being reported as Safari.
 *
 * Versions are captured as `(\d+)` so a four-part `152.0.0.0` reduces
 * to `152`; an optional group keeps a version-less token (`Firefox`
 * with no slash) from dropping the browser entirely.
 */
function detectBrowser(ua: string): string {
  // `EdgA` (Android), `EdgiOS`, and legacy EdgeHTML's `Edge/` are all Edge.
  const edge = capture(ua, /\bEdg(?:e|A|iOS)?(?:\/(\d+))?/);
  if (edge !== null) return named('Edge', edge);

  const opera = capture(ua, /\bOPR(?:\/(\d+))?/);
  if (opera !== null) return named('Opera', opera);

  const samsung = capture(ua, /\bSamsungBrowser(?:\/(\d+))?/);
  if (samsung !== null) return named('Samsung Internet', samsung);

  // CriOS is Chrome on iOS (WebKit underneath, but the user calls it Chrome).
  const chrome = capture(ua, /\b(?:Chrome|CriOS)(?:\/(\d+))?/);
  if (chrome !== null) return named('Chrome', chrome);

  const firefox = capture(ua, /\b(?:Firefox|FxiOS)(?:\/(\d+))?/);
  if (firefox !== null) return named('Firefox', firefox);

  if (/\bSafari\b/.test(ua)) {
    // Safari's `Safari/605.1.15` is the WebKit build; the product
    // version users recognise ("18.4") lives in `Version/`. Keep the
    // minor — Safari ships features in point releases — but drop a
    // pointless trailing `.0`.
    const version = capture(ua, /\bVersion\/(\d+(?:\.\d+)?)/);
    return named('Safari', version === null ? '' : version.replace(/\.0$/, ''));
  }

  return '';
}

/**
 * Platform name, or `''`.
 *
 * Ordering again: an iPhone UA says "like Mac OS X", an Android UA says
 * "Linux; Android 15", and a ChromeOS UA says "X11; CrOS" — so the
 * narrower platform must be tested before the family it borrows from.
 */
function detectOs(ua: string): string {
  if (/\bWindows\b/.test(ua)) return 'Windows';

  if (/\b(?:iPhone|iPad|iPod)\b/.test(ua)) {
    // "CPU iPhone OS 18_1 like Mac OS X" / "CPU OS 18_1 like Mac OS X".
    const version = capture(ua, /\bOS (\d+)/);
    return named('iOS', version ?? '');
  }
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS';

  if (/\bAndroid\b/.test(ua)) {
    const version = capture(ua, /\bAndroid (\d+(?:\.\d+)?)/);
    return named('Android', version ?? '');
  }
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS';

  const bsd = capture(ua, /\b(FreeBSD|OpenBSD|NetBSD)\b/);
  if (bsd) return bsd;

  if (/\bLinux\b/.test(ua)) return 'Linux';

  return '';
}

/**
 * Summarise a recorded `User-Agent` for the login-sessions list.
 *
 * Never throws and never returns an empty `label`: an unrecognised UA
 * falls back to the raw string (clipped to one row) so a session is
 * always identifiable by *something*, and a missing UA reads
 * "Unknown client" rather than a blank row.
 */
export function describeUserAgent(ua: string): UserAgentSummary {
  const raw = (ua ?? '').trim();
  if (raw === '') return { browser: '', os: '', label: 'Unknown client' };

  // Crawlers are not sessions a human recognises by browser name; show
  // the raw claim so an operator can see exactly who called.
  if (BOT_RE.test(raw)) return { browser: '', os: '', label: clip(raw) };

  const browser = detectTool(raw) ?? detectBrowser(raw);
  const os = detectOs(raw);

  const label = browser && os ? `${browser} on ${os}` : browser || os || clip(raw);
  return { browser, os, label };
}
