// Turns the plain compose text into styled IRC lines at send time. Lazy:
// fonts and effects load only when a style is active.
import type { ComposeStyle } from './composeStyle';
import { stripIrcFormatting } from './ircFormatting';
import { splitIntoMessages, utf8Length } from './messageSplitter';
import { applyCase, applyUnicodeStyle, applyZalgo, colorizeLine, wrapAttrs } from './textEffects';

export interface ComposeRender {
  lines: string[];
  /** Indices of `lines` whose UTF-8 length exceeds the budget (engine will wrap). */
  overBudget: number[];
}

const MAX_SPLIT_PASSES = 3;

export async function renderComposeLines(plain: string, style: ComposeStyle, budgetBytes: number): Promise<ComposeRender> {
  const text = applyCase(plain, style.caseMode);
  const font = style.font;

  // Unicode → zalgo → colour → attrs for one non-art line.
  const styleLine = (line: string): string => {
    let s = font.kind === 'unicode' ? applyUnicodeStyle(line, font.style) : line;
    if (style.zalgo !== 0) s = applyZalgo(s, style.zalgo);
    return wrapAttrs(colorizeLine(s, style.color), style);
  };

  const out: string[] = [];
  const overBudget: number[] = [];
  const push = (line: string): void => {
    if (stripIrcFormatting(line).trim() === '') return;
    if (utf8Length(line) > budgetBytes) overBudget.push(out.length);
    out.push(line);
  };

  if (font.kind === 'figlet' || font.kind === 'tdf') {
    let artLines: string[];
    if (font.kind === 'figlet') {
      const { renderFiglet } = await import('./figlet');
      artLines = (await renderFiglet(text, font.font, { width: 80 })).split('\n');
    } else {
      const { renderTdf } = await import('./tdf');
      artLines = await renderTdf(text, font.font);
    }
    for (const line of artLines) {
      // TheDraw lines carry their own colours; FIGlet lines take the picked colour.
      const colored = font.kind === 'tdf' ? line : colorizeLine(line, style.color);
      push(wrapAttrs(colored, style));
    }
    return { lines: out, overBudget };
  }

  for (const plainLine of text.split(/\r\n|\r|\n/)) {
    // Split the *plain* line when the styled form is over budget; the ratio
    // scales the char budget by how much styling inflated the bytes.
    let pending: { plain: string; pass: number }[] = [{ plain: plainLine, pass: 0 }];
    while (pending.length) {
      const next: typeof pending = [];
      for (const { plain: p, pass } of pending) {
        const styled = styleLine(p);
        const styledLen = utf8Length(styled);
        if (styledLen <= budgetBytes || pass >= MAX_SPLIT_PASSES || p.length < 2) {
          push(styled);
          continue;
        }
        const charBudget = Math.max(20, Math.floor((p.length * budgetBytes) / styledLen));
        const chunks = splitIntoMessages(p, charBudget, false);
        if (chunks.length <= 1) {
          push(styled);
          continue;
        }
        for (const c of chunks) next.push({ plain: c, pass: pass + 1 });
      }
      pending = next;
    }
  }
  return { lines: out, overBudget };
}
