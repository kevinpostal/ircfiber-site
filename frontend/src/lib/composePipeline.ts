// Turns the plain compose text into styled IRC lines at send time. Lazy:
// fonts and effects load only when a style is active.
import { clampArtWrapWidth, type ComposeStyle } from './composeStyle';
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
    // Word-wrap limit from the Font tab; off renders every row whole.
    const wrapOn = style.artWrap?.mode === 'word';
    const wrapWidth = clampArtWrapWidth(style.artWrap?.width ?? 80);
    let artLines: string[];
    if (font.kind === 'figlet') {
      const { renderFiglet } = await import('./figlet');
      // Unwrapped chat art stays unfolded at 400; display-side no-wrap
      // (blockArt + overflow-x:auto) handles narrow viewports. A set wrap
      // limit folds between words via whitespaceBreak — never mid-glyph.
      artLines = (await renderFiglet(text, font.font, { width: wrapOn ? wrapWidth : 400 })).split('\n');
    } else if (wrapOn) {
      artLines = await renderTdfWrapped(text, font.font, wrapWidth);
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

/**
 * Greedy word partition: `widths[i]` is word i in columns, `gap` the columns
 * between joined words. Returns index groups that fit `maxWidth`; a lone
 * word wider than the limit keeps its own group — never cut mid-word.
 */
export function groupWidths(widths: number[], gap: number, maxWidth: number): number[][] {
  const groups: number[][] = [];
  let cur: number[] = [];
  let curW = 0;
  widths.forEach((w, i) => {
    if (cur.length > 0 && curW + gap + w > maxWidth) {
      groups.push(cur);
      cur = [];
      curW = 0;
    }
    cur.push(i);
    curW += (cur.length === 1 ? w : gap + w);
  });
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/**
 * TheDraw grids have no fold column, so wrap between words: measure each
 * word's rendered width, pack groups that fit, render one banner per group.
 */
async function renderTdfWrapped(text: string, name: string, maxWidth: number): Promise<string[]> {
  const { renderTdf } = await import('./tdf');
  const renderWidth = async (s: string): Promise<number> => {
    const lines = await renderTdf(s, name);
    return lines.reduce((m, l) => Math.max(m, [...stripIrcFormatting(l)].length), 0);
  };
  const out: string[] = [];
  for (const para of text.split(/\r\n|\r|\n/)) {
    if (para.trim() === '') continue;
    const words = para.split(/\s+/).filter((w) => w !== '');
    if (words.length <= 1) {
      out.push(...(await renderTdf(para, name)));
      continue;
    }
    const widths: number[] = [];
    for (const w of words) widths.push(await renderWidth(w));
    const groups = groupWidths(widths, 4, maxWidth);
    if (groups.length <= 1) {
      out.push(...(await renderTdf(para, name)));
      continue;
    }
    for (const g of groups) out.push(...(await renderTdf(g.map((i) => words[i]).join(' '), name)));
  }
  return out;
}
