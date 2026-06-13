import type { LinkPart, EmbedType } from '../types';

// Channel prefix chars (default #, can be overridden by ISUPPORT CHANTYPES)
let chanPrefixChars = '#';

export function setChanPrefixChars(chars: string): void {
  chanPrefixChars = chars;
}

// URL detection regex -- matches protocols and bare domain.tld patterns
const URL_REGEX = /(?:https?:\/\/|ftp:\/\/|ircs?:\/\/|magnet:\?)[^\s<>"{}|\\^`\[\]]+|(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:com|org|net|io|dev|app|co|us|uk|de|fr|info|me|tv|cc|gg|fm|am|chat|name|edu|gov|mil|int|eu|asia|mobi|tel|xyz|online|site|tech|space|fun|store|social)\b)(?:\/[^\s<>"{}|\\^`\[\]]*)?/gi;

// Email regex
const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

// Disallowed protocols
const DISALLOWED_PROTOCOLS = ['javascript:', 'vbscript:', 'data:'];

/**
 * Split text into plain text and link parts.
 */
export function splitTextOnLinks(text: string): LinkPart[] {
  if (!text) return [{ text: '', isLink: false }];

  const parts: LinkPart[] = [];
  let lastIndex = 0;

  const combined = findAllMatches(text);

  for (const match of combined) {
    if (match.index > lastIndex) {
      const plainText = text.slice(lastIndex, match.index);
      parts.push(...splitOnChannels(plainText));
    }

    if (match.type === 'url') {
      const cleaned = cleanUrl(match.value);
      if (cleaned) {
        parts.push({
          text: match.value,
          isLink: true,
          url: cleaned,
          embedType: detectEmbed(cleaned),
        });
      } else {
        parts.push({ text: match.value, isLink: false });
      }
    } else if (match.type === 'email') {
      parts.push({
        text: match.value,
        isLink: true,
        url: `mailto:${match.value}`,
        isEmail: true,
      });
    }

    lastIndex = match.index + match.value.length;
  }

  if (lastIndex < text.length) {
    parts.push(...splitOnChannels(text.slice(lastIndex)));
  }

  return parts.length ? parts : [{ text, isLink: false }];
}

interface TextMatch {
  value: string;
  index: number;
  type: 'url' | 'email';
}

function findAllMatches(text: string): TextMatch[] {
  const matches: TextMatch[] = [];

  URL_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_REGEX.exec(text)) !== null) {
    let url = m[0];
    url = stripTrailingPunc(url);
    matches.push({ value: url, index: m.index, type: 'url' });
  }

  EMAIL_REGEX.lastIndex = 0;
  while ((m = EMAIL_REGEX.exec(text)) !== null) {
    const emailStart = m.index;
    const emailEnd = m.index + m[0].length;

    // Skip if this email is fully contained within an existing match
    const containedInExisting = matches.some(existing =>
      emailStart >= existing.index && emailEnd <= existing.index + existing.value.length
    );
    if (containedInExisting) continue;

    // Remove any existing URLs that are fully contained within this email
    for (let i = matches.length - 1; i >= 0; i--) {
      const existing = matches[i];
      if (existing.type === 'url' &&
          existing.index >= emailStart &&
          existing.index + existing.value.length <= emailEnd) {
        matches.splice(i, 1);
      }
    }

    matches.push({ value: m[0], index: m.index, type: 'email' });
  }

  matches.sort((a, b) => a.index - b.index);
  return matches;
}

/** Split plain text on IRC channel names */
function splitOnChannels(text: string): LinkPart[] {
  if (!chanPrefixChars) return [{ text, isLink: false }];

  const parts: LinkPart[] = [];
  const escapedChars = chanPrefixChars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const chanRegex = new RegExp(`(?:^|(?<=\\s))([${escapedChars}][^\\s<>"',]+)`, 'g');

  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = chanRegex.exec(text)) !== null) {
    const chan = m[1];
    if (/^#\d+$/.test(chan) || /^#[0-9a-fA-F]{3,6}$/.test(chan)) continue;

    if (m.index > lastIdx) {
      parts.push({ text: text.slice(lastIdx, m.index), isLink: false });
    }
    parts.push({ text: chan, isLink: true, isChannel: true });
    lastIdx = m.index + m[0].length;
  }

  if (lastIdx < text.length) {
    parts.push({ text: text.slice(lastIdx), isLink: false });
  }

  return parts.length ? parts : [{ text, isLink: false }];
}

/** Strip trailing punctuation from URL, respecting balanced parens */
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
    } else {
      break;
    }
  }
  return url;
}

/** Validate and clean a URL */
function cleanUrl(url: string): string | null {
  const lower = url.toLowerCase();
  for (const proto of DISALLOWED_PROTOCOLS) {
    if (lower.startsWith(proto)) return null;
  }

  if (!url.match(/^[a-zA-Z]+:\/\//)) {
    url = 'https://' + url;
  }

  return url;
}

/** Detect embed type from URL for rich previews */
export function detectEmbed(url: string): EmbedType {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname;

    if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.includes('imgur.com') || host === 'i.imgur.com') return 'imgur';
    if (host.includes('twitter.com') || host === 'x.com') return 'twitter';
    if (host.includes('wikipedia.org')) return 'wikipedia';
    if (host.includes('reddit.com') || host === 'redd.it') return 'reddit';
    if (host.includes('spotify.com') || host === 'open.spotify.com') return 'spotify';
    if (host === 'gist.github.com') return 'gist';
    if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?.*)?$/i.test(path)) return 'image';

    return 'none';
  } catch {
    return 'none';
  }
}

/**
 * Wrap nicknames found in message text with mention spans, with IRCCloud-style
 * nick color classes (c0..c26). Runs after autolinkHtml so it operates on the
 * same split-by-tag-bounds principle — existing <a> and <span> tags are
 * preserved.
 *
 * @param text  HTML text (output of autolinkHtml, already containing links etc.)
 * @param nicks  Set of lowercase nicks that exist in the current buffer
 */
let _cachedNickSerial = '';
let _cachedNickPattern: RegExp | null = null;

function buildNickPattern(sorted: string[]): RegExp {
  return new RegExp(
    `(?<=^|[^a-zA-Z0-9_\\\\[\\]\\\\{}])(${sorted.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[^a-zA-Z0-9_\\\\[\\]\\\\{}])`,
    'gi'
  );
}

export function mentionNicks(text: string, nicks: Set<string>): string {
  if (!text || !nicks || nicks.size === 0) return text;
  const sorted = [...nicks].sort((a, b) => b.length - a.length);
  const serial = sorted.join('\x00');
  if (serial !== _cachedNickSerial || !_cachedNickPattern) {
    _cachedNickSerial = serial;
    _cachedNickPattern = buildNickPattern(sorted);
  }
  return _mentionNicksImpl(text, _cachedNickPattern);
}

export function mentionNicksWithPattern(text: string, pattern: RegExp): string {
  if (!text) return text;
  return _mentionNicksImpl(text, pattern);
}

function _mentionNicksImpl(text: string, nickPattern: RegExp): string {
  const TAG_RE = /<[^>]+>/g;
  let result = '';
  let lastIdx = 0;
  let insideAnchor = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    if (m.index > lastIdx) {
      const segment = text.slice(lastIdx, m.index);
      if (insideAnchor === 0) {
        result += mentionTextSegment(segment, nickPattern);
      } else {
        result += segment;
      }
    }
    const tag = m[0].toLowerCase();
    if (tag.startsWith('</a')) {
      insideAnchor--;
    } else if (tag.startsWith('<a ') || tag === '<a>') {
      insideAnchor++;
    }
    result += m[0];
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    const segment = text.slice(lastIdx);
    if (insideAnchor === 0) {
      result += mentionTextSegment(segment, nickPattern);
    } else {
      result += segment;
    }
  }
  return result;
}

function mentionTextSegment(segment: string, pattern: RegExp): string {
  pattern.lastIndex = 0;
  let result = '';
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(segment)) !== null) {
    if (m.index > lastIdx) {
      result += segment.slice(lastIdx, m.index);
    }
    const nick = m[1];
    const colorIndex = hashStr(nick) % 27;
    result += `<span class="buffer bufferLink mention c${colorIndex} user link">${nick}</span>`;
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < segment.length) {
    result += segment.slice(lastIdx);
  }
  return result || segment;
}

function hashStr(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = s.charCodeAt(i) + ((hash << 6) + (hash << 16) - hash);
  }
  return Math.abs(hash);
}

/**
 * Render text with auto-linked URLs, channels, and emails as HTML.
 *
 * The input may already contain HTML (e.g. produced by parseIrcFormatting,
 * which emits <span> tags around colored runs and escapes text content).
 * To avoid double-escaping, we split on tag boundaries and only run the
 * autolink pass over text segments. Text segments are assumed to already
 * be HTML-escaped, so we do NOT re-escape non-link portions.
 */
export function autolinkHtml(text: string): string {
  if (!text) return '';
  const TAG_RE = /<[^>]+>/g;
  let result = '';
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    if (m.index > lastIdx) {
      result += autolinkTextSegment(text.slice(lastIdx, m.index));
    }
    result += m[0];
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    result += autolinkTextSegment(text.slice(lastIdx));
  }
  return result;
}

function autolinkTextSegment(segment: string): string {
  const parts = splitTextOnLinks(segment);
  return parts.map(part => {
    if (!part.isLink) return part.text;
    if (part.isChannel) {
      return `<a href="javascript:void(0)" class="channelLink" data-channel="${part.text}">${part.text}</a>`;
    }
    if (part.isEmail) {
      return `<a href="${part.url!}" class="emailLink">${part.text}</a>`;
    }
    const hasCredentials = part.url?.match(/:\/\/([^@]+)@/);
    const display = hasCredentials
      ? part.text.replace(/(:\/\/)([^@]+)@/, '$1<span class="urlUserPassHidden" title="credentials hidden">[credentials]</span>@')
      : part.text;
    return `<a href="${part.url!}" target="_blank" rel="noopener noreferrer" class="urlLink">${display}</a>`;
  }).join('');
}
