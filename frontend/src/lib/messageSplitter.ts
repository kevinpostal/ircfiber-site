// Byte-correct IRC line splitter.
//
// The ENGINE is the authority for splitting an outbound logical message into
// protocol lines (it knows the server's ISUPPORT LINELEN and its fake-lag
// budget, and can use an IRCv3 draft/multiline BATCH).  This module exists for
// the client-side cases that still need to reason about line counts or that
// deliberately emit one command per line (art scrollers), plus for previews.
//
// Everything here counts UTF-8 BYTES, not `String.length` (UTF-16 code units).
// A line of 200 emoji is 200 code units but 800 bytes and would silently blow
// past IRC's 512-byte line limit if measured with `.length`.
//
// Rules:
//   1. Split on newlines (CRLF or LF).
//   2. If a single line exceeds the byte budget, break it — preferring the
//      last space at or before the budget, hard-breaking only when a single
//      word does not fit.  The space is kept at the END of the emitted line,
//      which is what IRCv3's draft/multiline-concat splitting recommendation
//      (and the engine's splitter) expects: concatenating the parts
//      reproduces the original text byte for byte.
//   3. If `pack` is true (default), greedily join consecutive short lines with
//      a single space until the next would overflow the budget — IRCCloud's
//      "send as text" behaviour for prose.
//   4. If `pack` is false, each line is its own message and interior blank
//      lines are preserved as empty entries (art / multiline fidelity).

const DEFAULT_MAX_BYTES = 400; // safe under the 512-byte protocol line limit

// IRCCloud parity: PastebinView.MESSAGE_LENGTH_TRIGGER = 1080 (≈3 lines of
// text).  When input text contains a newline or exceeds this length, the
// "post a snippet?" confirmation dialog is shown.  This gates a UI prompt on
// character count, so it deliberately stays a character count.
export const MESSAGE_LENGTH_TRIGGER = 1080;

const TEXT_ENCODER = new TextEncoder();

/** UTF-8 byte length of `s`. */
export function utf8Length(s: string): number {
  return TEXT_ENCODER.encode(s).length;
}

/**
 * UTF-8 byte cost of one code point, derived from its value so the scanner
 * never has to encode (which would make splitting a 100 KB paste quadratic).
 * Lone surrogates encode as U+FFFD = 3 bytes.
 */
function charBytes(ch: string): number {
  const cp = ch.codePointAt(0) as number;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

function charsBytes(chars: string[]): number {
  let n = 0;
  for (const c of chars) n += charBytes(c);
  return n;
}

// IRCv3 recommends assuming a worst-case source prefix when the client does
// not know its own hostmask: 20 (nick) + 1 ('!') + 20 (user) + 1 ('@') + 63
// (host) = 105 bytes.
const WORST_CASE_HOSTMASK_BYTES = 105;

// Headroom for anything we cannot see from here: message tags the server or a
// relay bouncer may prepend, an ident/host that changed since registration,
// CAP-negotiated prefixes.
const SAFETY = 16;

/**
 * Usable payload bytes for one PRIVMSG to `target` on a server advertising
 * `isupport`, assuming the server echoes our line back prefixed with
 * `hostmask`.  Budget is the line limit minus every byte we do not control:
 *
 *   linelen                  ISUPPORT LINELEN, default 512 (RFC 1459 limit)
 *   - 1                      leading ':' of the source prefix
 *   - utf8Length(hostmask)   'nick!user@host' (worst case when unknown)
 *   - 1                      space after the prefix
 *   - 'PRIVMSG'.length       the command (7)
 *   - 1                      space after the command
 *   - utf8Length(target)     '#channel' or a nick
 *   - 2                      ' :' before the trailing parameter
 *   - 2                      trailing CRLF
 *   - SAFETY                 16 bytes of headroom (tags, ident drift)
 *
 * Clamped to at least 80 bytes so a hostile/broken LINELEN cannot produce a
 * zero or negative budget (which would make the splitter emit garbage).
 */
export function ircPayloadBudget(
  isupport: Record<string, string> | undefined,
  hostmask: string,
  target: string,
): number {
  const linelen = parseInt(isupport?.LINELEN ?? '', 10) || 512;
  const prefixBytes = hostmask ? utf8Length(hostmask) : WORST_CASE_HOSTMASK_BYTES;
  const budget =
    linelen -
    1 - // ':'
    prefixBytes -
    1 - // ' '
    'PRIVMSG'.length -
    1 - // ' '
    utf8Length(target) -
    2 - // ' :'
    2 - // CRLF
    SAFETY;
  return Math.max(80, budget);
}

/**
 * Break one line so every part is <= `maxBytes` UTF-8 bytes.  Prefers the last
 * space at or before the budget (kept as the last byte of the emitted part so
 * concatenation is lossless); hard-breaks mid-word only when a word does not
 * fit.  Never splits a surrogate pair: the scan walks code points.
 */
function breakLine(line: string, maxBytes: number): string[] {
  const out: string[] = [];
  let chunk: string[] = [];
  let bytes = 0;
  let lastSpace = -1; // index in `chunk` just after the last space seen

  for (const ch of line) {
    const w = charBytes(ch);
    if (bytes + w > maxBytes) {
      if (chunk.length === 0) {
        // A single code point wider than the whole budget: emit it alone
        // rather than loop forever.
        out.push(ch);
        continue;
      }
      const cut = lastSpace > 0 ? lastSpace : chunk.length;
      out.push(chunk.slice(0, cut).join(''));
      chunk = chunk.slice(cut);
      bytes = charsBytes(chunk);
      lastSpace = -1;
      if (bytes + w > maxBytes && chunk.length > 0) {
        // The carried-over word fragment still leaves no room: hard-break it.
        out.push(chunk.join(''));
        chunk = [];
        bytes = 0;
      }
      if (bytes + w > maxBytes) {
        out.push(ch);
        continue;
      }
    }
    chunk.push(ch);
    bytes += w;
    if (ch === ' ') lastSpace = chunk.length;
  }
  if (chunk.length > 0) out.push(chunk.join(''));
  return out;
}

export function splitIntoMessages(
  text: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
  pack: boolean = true,
): string[] {
  const budget = Math.max(1, Math.floor(maxBytes));
  const lines: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') {
      // Preserve blank lines as their own empty entry so the no-pack path can
      // emit a deliberate empty message.  Trailing blanks are dropped below.
      lines.push('');
      continue;
    }
    if (utf8Length(line) <= budget) {
      lines.push(line);
      continue;
    }
    for (const part of breakLine(line, budget)) lines.push(part);
  }

  if (!pack) {
    // Strict line-by-line: drop trailing empty lines, keep interior blanks as
    // their own empty messages (a deliberate blank between art rows is
    // preserved verbatim).
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  // Greedy pack: join consecutive short lines with " " until the next would
  // overflow the byte budget.
  const messages: string[] = [];
  let buf = '';
  let bufBytes = 0;
  for (const line of lines) {
    if (line === '') {
      // Blank line: flush the current buffer as its own message.
      if (buf) { messages.push(buf); buf = ''; bufBytes = 0; }
      continue;
    }
    const lineBytes = utf8Length(line);
    // A part produced by a space-break already ends with its separator; don't
    // double it.
    const sep = buf && !buf.endsWith(' ') ? ' ' : '';
    if (buf && bufBytes + sep.length + lineBytes > budget) {
      messages.push(buf);
      buf = line;
      bufBytes = lineBytes;
    } else {
      buf = buf + sep + line;
      bufBytes += sep.length + lineBytes;
    }
  }
  if (buf) messages.push(buf);
  return messages;
}
