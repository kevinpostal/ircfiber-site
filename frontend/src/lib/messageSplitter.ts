// IRCCloud-style message splitter: takes a pastebin editor's contents and
// breaks it into multiple IRC messages, each ≤ maxLen (default 400 chars
// to leave headroom for IRC's 512-byte protocol limit + CRLF + tags).
//
// Rules (mirrors IRCCloud's line-based splitter):
//   1. Split on newlines.
//   2. If a single line is longer than maxLen, hard-break it at maxLen.
//   3. If `pack` is true (default), greedily join consecutive short lines
//      with a single space until the next would overflow maxLen — this
//      matches IRCCloud's "send as text" behavior for prose/paragraphs.
//   4. If `pack` is false, each non-empty line is its own message.  This
//      is what art paste needs: a multi-line ASCII/ANSI block where the
//      last line is structurally significant (e.g. a metadata strip) and
//      must NOT be joined with the line above it.

const DEFAULT_MAX_LEN = 400; // safe under 512; > irc max 512 with crlf+tags

// IRCCloud parity: PastebinView.MESSAGE_LENGTH_TRIGGER = 1080 (≈3 lines of
// text).  When input text contains a newline or exceeds this length, the
// "post a snippet?" confirmation dialog is shown.
export const MESSAGE_LENGTH_TRIGGER = 1080;

export function splitIntoMessages(
  text: string,
  maxLen: number = DEFAULT_MAX_LEN,
  pack: boolean = true,
): string[] {
  const rawLines = text.split(/\r?\n/);
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line === '') {
      // Preserve blank lines as their own empty entry so the no-pack path
      // can still emit a deliberate empty message if needed.  We only
      // filter them at the very end (trailing blank at EOF).
      lines.push('');
      continue;
    }
    if (line.length <= maxLen) {
      lines.push(line);
      continue;
    }
    // Hard-break long lines at maxLen boundaries
    let remaining = line;
    while (remaining.length > maxLen) {
      lines.push(remaining.slice(0, maxLen));
      remaining = remaining.slice(maxLen);
    }
    lines.push(remaining);
  }

  if (!pack) {
    // Strict line-by-line: drop trailing empty lines, keep interior blanks
    // as their own empty messages (so a deliberate blank between art
    // rows is preserved verbatim).
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  // Greedy pack: join consecutive short lines with " " until the next
  // one would overflow maxLen.
  const messages: string[] = [];
  let buf = '';
  for (const line of lines) {
    if (line === '') {
      // Blank line: flush current buffer as its own message
      if (buf) { messages.push(buf); buf = ''; }
      // Skip the empty itself — we don't want trailing blanks
      continue;
    }
    const sep = buf ? ' ' : '';
    if (buf.length + sep.length + line.length > maxLen) {
      if (buf) messages.push(buf);
      buf = line;
    } else {
      buf = buf + sep + line;
    }
  }
  if (buf) messages.push(buf);
  return messages;
}
