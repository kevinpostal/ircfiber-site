/**
 * Minimal syntax highlighter for InspIRCd-style config files.
 *
 * The format is one tag per line — `<name attr="value" ...>` — plus
 * `#` comments, so a small regex tokenizer beats pulling in a
 * highlighting library. Input is HTML-escaped first; output is an HTML
 * string for `{@html}` rendering. Token colors reuse the admin theme
 * utilities (comments muted, tag names primary, attributes info,
 * quoted strings success).
 */
export function highlightIrcdConf(text: string): string {
  return text.split('\n').map(highlightLine).join('\n');
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightLine(line: string): string {
  if (/^\s*#/.test(line)) {
    return `<span class="text-muted italic">${esc(line)}</span>`;
  }
  // Single pass over the escaped text: tag opens (`&lt;name`) and
  // `attr="value"` pairs alternate-matched left to right, so inserted
  // <span> markup is never re-scanned (a stray `&lt;` inside a quoted
  // value stays part of the string token).
  return esc(line).replace(
    /(&lt;\/?)([A-Za-z][\w.-]*)|([\w.-]+)=(&quot;.*?&quot;)/g,
    (m, open, tag, attr, str) =>
      tag !== undefined
        ? `${open}<span class="text-primary font-semibold">${tag}</span>`
        : `<span class="text-info">${attr}</span>=<span class="text-success">${str}</span>`,
  );
}
