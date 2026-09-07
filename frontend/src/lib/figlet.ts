/**
 * FIGlet banner rendering (compose style dialog + admin MOTD editor). The
 * renderer is a static import of this lazy module; every font is its own
 * chunk (see vite.config.ts) fetched the first time it is picked.
 */
import figlet from 'figlet';
import type { FontName } from 'figlet';
import FIGLET_ROWS from 'virtual:figlet-meta';

const modules = import.meta.glob<{ default: string }>('/node_modules/figlet/importable-fonts/*.js');

/** Font name → loader, for all fonts the figlet package ships. */
export const FIGLET_FONTS: Record<string, () => Promise<{ default: string }>> = Object.fromEntries(
  Object.entries(modules).map(([p, load]) => [decodeURIComponent(p.slice(p.lastIndexOf('/') + 1, -3)), load]),
);

export const FIGLET_FONT_NAMES: string[] = Object.keys(FIGLET_FONTS).sort((a, b) => a.localeCompare(b));

/** Rows a font's glyphs occupy (the .flf header height); 0 if unknown. */
export function figletRows(font: string): number {
  return FIGLET_ROWS[font] ?? 0;
}

const loaded = new Set<string>();

/** Renders `text` in `font`; lines are right-trimmed and blank edges dropped. */
export async function renderFiglet(text: string, font: string, opts: { width?: number } = {}): Promise<string> {
  const loader = FIGLET_FONTS[font];
  if (!loader) throw new Error(`unknown font: ${font}`);
  const name = font as FontName;
  if (!loaded.has(font)) {
    figlet.parseFont(name, (await loader()).default);
    loaded.add(font);
  }
  const lines = figlet
    .textSync(text, { font: name, width: opts.width ?? 80, whitespaceBreak: true })
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}
