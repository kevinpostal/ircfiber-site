/**
 * Split highlight.js output into one HTML fragment per source line.
 *
 * Wrapping a paste means each logical line becomes its own row, so the
 * gutter number can sit beside a block that may be several visual rows
 * tall (this is what ACE does, and what IRCCloud's paste viewer shows).
 * That requires per-line HTML — but highlight.js emits one blob in which
 * a token can span newlines, e.g. a block comment:
 *
 *     <span class="hljs-comment">/* line one
 *     line two *​/</span>
 *
 * Naively splitting on "\n" would leave the first line with an unclosed
 * span and the second with a stray closing tag, and the browser's error
 * recovery would bleed the comment colour across the rest of the file.
 * So we track the open tags and close/reopen them at every newline.
 *
 * highlight.js only ever emits `<span class="...">` elements plus escaped
 * text, which is why matching tags with a regex is sufficient here.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';

  const appendText = (text: string): void => {
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        current += '</span>'.repeat(open.length);
        lines.push(current);
        current = open.join('');
      }
      current += parts[i];
    }
  };

  const tag = /<\/?span[^>]*>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html)) !== null) {
    appendText(html.slice(last, match.index));
    if (match[0].startsWith('</')) open.pop();
    else open.push(match[0]);
    current += match[0];
    last = tag.lastIndex;
  }
  appendText(html.slice(last));
  lines.push(current);

  return lines;
}
