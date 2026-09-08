/**
 * One catalogue over both art-font families (FIGlet + TheDraw) for the compose
 * font pickers. Entries carry their row size so lists can be sorted by it, and
 * rendered samples are cached so scrolling the gallery back and forth costs
 * nothing (a FIGlet sample also pulls that font's chunk over the wire).
 *
 * Lazy module: only reachable from the compose style page.
 */
import type { FontMode } from './composeStyle';

export type ArtFontKind = 'figlet' | 'tdf';
export type FontSort = 'rows' | 'name';

export interface FontEntry {
  kind: ArtFontKind;
  /** Value stored in `ComposeStyle.font.font`. */
  name: string;
  /** Glyph rows one line of text occupies (0 = unknown). */
  rows: number;
  /** Secondary label — the TheDraw source file; empty for FIGlet. */
  note: string;
}

const lists = new Map<ArtFontKind, Promise<FontEntry[]>>();

/** Every font of `kind`, in name order; fetched once per session. */
export function listArtFonts(kind: ArtFontKind): Promise<FontEntry[]> {
  let pending = lists.get(kind);
  if (!pending) {
    pending = kind === 'figlet' ? loadFiglet() : loadTdf();
    pending.catch(() => lists.delete(kind));
    lists.set(kind, pending);
  }
  return pending;
}

async function loadFiglet(): Promise<FontEntry[]> {
  const { FIGLET_FONT_NAMES, figletRows } = await import('./figlet');
  return FIGLET_FONT_NAMES.map((name) => ({ kind: 'figlet' as const, name, rows: figletRows(name), note: '' }));
}

async function loadTdf(): Promise<FontEntry[]> {
  const { listTdfFonts } = await import('./tdf');
  return (await listTdfFonts()).map((f) => ({ kind: 'tdf' as const, name: f.name, rows: f.height, note: f.file }));
}

/** Row size first (shortest fonts fit a chat window), then name. */
export function sortFonts(entries: FontEntry[], by: FontSort): FontEntry[] {
  const out = entries.slice();
  out.sort((a, b) =>
    by === 'rows' && a.rows !== b.rows ? a.rows - b.rows : a.name.localeCompare(b.name),
  );
  return out;
}

/** Case-insensitive match on name and note; empty query keeps everything. */
export function filterFonts(entries: FontEntry[], query: string): FontEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q) || e.note.toLowerCase().includes(q));
}

export function fontMode(entry: FontEntry): FontMode {
  return { kind: entry.kind, font: entry.name };
}

const MAX_SAMPLES = 600;
const samples = new Map<string, string[]>();

/**
 * Renders `text` in one font: plain lines for FIGlet, mIRC-coloured lines for
 * TheDraw (those fonts carry their own colours).
 *
 * `opts.width` is the FIGlet wrap column — chat samples stay effectively
 * unwrapped at 400, MOTD banners must be rendered at the 80-column budget they
 * are inserted into. TheDraw glyphs are fixed-size, so it has no effect there.
 */
export async function renderFontSample(
  entry: FontEntry,
  text: string,
  opts: { width?: number } = {},
): Promise<string[]> {
  const width = opts.width ?? 400;
  const key = `${entry.kind}\u0000${entry.name}\u0000${width}\u0000${text}`;
  const hit = samples.get(key);
  if (hit) return hit;
  let lines: string[];
  if (entry.kind === 'figlet') {
    const { renderFiglet } = await import('./figlet');
    lines = (await renderFiglet(text, entry.name, { width })).split('\n');
  } else {
    const { renderTdf } = await import('./tdf');
    lines = await renderTdf(text, entry.name);
  }
  if (samples.size >= MAX_SAMPLES) samples.delete(samples.keys().next().value as string);
  samples.set(key, lines);
  return lines;
}
