/**
 * mIRC colour codes for the MOTD preview: strip for measuring, render to
 * HTML for display. Only `\x03fg[,bg]` and the `\x0f` reset are handled —
 * that is all the builder emits and all TheDraw art needs.
 */

/** Standard 16-colour mIRC palette as rendered by the chat client. */
export const MIRC_PALETTE = [
  '#ffffff', '#000000', '#00007f', '#009300', '#ff0000', '#7f0000', '#9c009c', '#fc7f00',
  '#ffff00', '#00fc00', '#009393', '#00ffff', '#0000fc', '#ff00ff', '#7f7f7f', '#d2d2d2',
];

const CODE = /\x03(\d{1,2})?(?:,(\d{1,2}))?/g;

/** Text without colour codes. */
export function stripMirc(s: string): string {
  return s.replace(CODE, '').replace(/\x0f/g, '');
}

/** Visible width in cells (code points, codes stripped). */
export function visibleWidth(s: string): number {
  return [...stripMirc(s)].length;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One line → HTML with coloured spans. */
export function mircLineToHtml(line: string): string {
  let out = '';
  let fg: number | null = null;
  let bg: number | null = null;
  let open = false;
  const restyle = () => {
    if (open) { out += '</span>'; open = false; }
    if (fg !== null || bg !== null) {
      out += `<span style="${fg !== null ? `color:${MIRC_PALETTE[fg]};` : ''}${bg !== null ? `background:${MIRC_PALETTE[bg]};` : ''}">`;
      open = true;
    }
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\x03') {
      const m = /^\x03(\d{1,2})?(?:,(\d{1,2}))?/.exec(line.slice(i))!;
      if (m[1] === undefined) { fg = null; bg = null; }
      else { fg = +m[1] % 16; if (m[2] !== undefined) bg = +m[2] % 16; }
      i += m[0].length;
      restyle();
      continue;
    }
    if (ch === '\x0f') { fg = null; bg = null; restyle(); i++; continue; }
    out += esc(ch);
    i++;
  }
  if (open) out += '</span>';
  return out;
}

/** Whole body → HTML (lines joined with `\n`, for a `<pre>`). */
export function mircToHtml(body: string): string {
  return body.split('\n').map(mircLineToHtml).join('\n');
}

/** Longest line in bytes (UTF-8, codes included) — what the IRC line limit sees. */
export function maxLineBytes(body: string): number {
  const enc = new TextEncoder();
  let max = 0;
  for (const l of body.split('\n')) max = Math.max(max, enc.encode(l).length);
  return max;
}

/** Wraps `text` in a foreground colour; `null` leaves it uncoloured. */
export function colorize(text: string, fg: number | null): string {
  if (fg === null || !text) return text;
  return `\x03${String(fg).padStart(2, '0')}${text}\x03`;
}
