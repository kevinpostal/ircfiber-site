/**
 * MOTD builder recipes: a list of blocks rendered to the plain-text-plus-
 * mIRC-colour body a template stores. The recipe JSON is saved on the
 * template (`recipe`) so it can be reopened; `random` font picks are
 * resolved at render time, which is what "Generate N variants" repeats.
 */
import { FIGLET_FONT_NAMES, renderFiglet } from '../../lib/figlet';
import { listTdfFonts, renderTdf } from '../../lib/tdf';
import { stripIrcFormatting } from '../../lib/ircFormatting';
import { colorizeLine } from '../../lib/textEffects';

export type Align = 'left' | 'center';

export type BannerBlock = {
  kind: 'banner';
  engine: 'tdf' | 'figlet';
  text: string;
  /** Font name, or 'random' for a pick from `pool` (empty pool = every font). */
  font: string;
  pool: string[];
  align: Align;
  /** mIRC foreground for figlet banners; TheDraw art carries its own colours. */
  color: number | null;
};
export type TextBlock = { kind: 'text'; text: string; align: Align; color: number | null };
export type RuleBlock = { kind: 'rule'; char: string; color: number | null };
export type KvBlock = { kind: 'kv'; rows: { k: string; v: string }[]; fill: string; color: number | null };
export type SpacerBlock = { kind: 'spacer'; lines: number };
export type Block = BannerBlock | TextBlock | RuleBlock | KvBlock | SpacerBlock;

export type Frame = 'none' | 'single' | 'double' | 'heavy' | 'hash';

export interface Recipe {
  /** Rendering width in cells (also the rule length and centring width). */
  width: number;
  frame: Frame;
  frameColor: number | null;
  blocks: Block[];
}

export const RULE_CHARS = ['─', '═', '━', '=', '-', '#', '~', '·', '▀', '▄', '░', '▒'];

/** Every packed TheDraw font name; the pack loads on first render. */
let tdfNamesCache: string[] | null = null;
export async function tdfFontNames(): Promise<string[]> {
  if (!tdfNamesCache) tdfNamesCache = (await listTdfFonts()).map((f) => f.name);
  return tdfNamesCache;
}

/** Visible width in cells (colour codes stripped; code points). */
function visibleWidth(s: string): number {
  return [...stripIrcFormatting(s)].length;
}

/** Wraps `text` in a foreground colour; `null` leaves it uncoloured. */
export function colorize(text: string, fg: number | null): string {
  if (fg === null || !text) return text;
  const colored = colorizeLine(text, { kind: 'solid', fg, bg: null });
  return colored.includes('\x03') ? `${colored}\x0F` : colored;
}
export { FIGLET_FONT_NAMES };

export function defaultRecipe(): Recipe {
  return {
    width: 72,
    frame: 'none',
    frameColor: null,
    blocks: [
      { kind: 'banner', engine: 'tdf', text: 'IRC Fiber', font: 'random', pool: [], align: 'center', color: null },
      { kind: 'spacer', lines: 1 },
      { kind: 'text', text: 'Welcome to IRC Fiber — enterprise-grade IRC for the IRC Fiber community.', align: 'center', color: null },
      { kind: 'rule', char: '─', color: 14 },
      { kind: 'text', text: 'irc.ircfiber.com  ·  InspIRCd 4 + Anope services  ·  TLS on 6697\nWeb client: https://ircfiber.com   Support: admin@ircfiber.com', align: 'left', color: null },
      { kind: 'spacer', lines: 1 },
      { kind: 'kv', fill: '.', color: null, rows: [
        { k: 'Register your nick', v: '/msg NickServ REGISTER <password> [email]' },
        { k: 'Register a channel', v: '/msg ChanServ REGISTER #channel' },
        { k: 'Join a channel', v: '/join #channelname' },
        { k: 'Get help', v: '/msg NickServ HELP   ·   /join #support' },
      ] },
      { kind: 'rule', char: '─', color: 14 },
      { kind: 'text', text: 'Rules\n  1. Be respectful to other users.\n  2. No spam, flooding, or abuse.\n  3. Follow the network operator instructions.', align: 'left', color: null },
    ],
  };
}

/** Parses a stored recipe; returns null when it is not a usable recipe. */
export function parseRecipe(json: string): Recipe | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as Recipe;
    if (!r || !Array.isArray(r.blocks)) return null;
    return { width: r.width || 72, frame: r.frame || 'none', frameColor: r.frameColor ?? null, blocks: r.blocks };
  } catch {
    return null;
  }
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function alignLine(line: string, align: Align, width: number): string {
  if (align !== 'center') return line;
  const pad = Math.floor((width - visibleWidth(line)) / 2);
  return pad > 0 ? ' '.repeat(pad) + line : line;
}

export interface RenderResult {
  body: string;
  /** Fonts actually used, in block order — becomes part of a variant's name. */
  fonts: string[];
}

/** Renders a banner block; returns its lines and the font used. */
async function renderBanner(b: BannerBlock, rng: () => number): Promise<{ lines: string[]; font: string }> {
  const all = b.engine === 'tdf' ? await tdfFontNames() : FIGLET_FONT_NAMES;
  const pool = b.pool.filter((f) => all.includes(f));
  const font = b.font === 'random' ? pick(pool.length ? pool : all, rng) : b.font;
  if (b.engine === 'tdf') {
    // Saved recipes predate the pack and store the source file stem;
    // renderTdf resolves stems as well as font names.
    return { lines: await renderTdf(b.text, font), font };
  }
  const art = await renderFiglet(b.text, font);
  return { lines: art.split('\n').map((l) => colorize(l, b.color)), font };
}

/** Renders the recipe to a template body. Deterministic for a given `rng`. */
export async function renderRecipe(recipe: Recipe, rng: () => number = Math.random): Promise<RenderResult> {
  const width = Math.max(20, Math.min(120, recipe.width || 72));
  const lines: string[] = [];
  const fonts: string[] = [];
  for (const b of recipe.blocks) {
    switch (b.kind) {
      case 'banner': {
        const r = await renderBanner(b, rng);
        fonts.push(r.font);
        for (const l of r.lines) lines.push(alignLine(l, b.align, width));
        break;
      }
      case 'text':
        for (const l of b.text.split('\n')) lines.push(alignLine(colorize(l, b.color), b.align, width));
        break;
      case 'rule':
        lines.push(colorize((b.char || '─').repeat(width), b.color));
        break;
      case 'kv': {
        const kw = Math.max(0, ...b.rows.map((r) => [...r.k].length));
        for (const r of b.rows) {
          const fill = (b.fill || ' ').repeat(Math.max(0, kw - [...r.k].length + 3));
          lines.push(colorize(`${r.k} ${fill}  ${r.v}`, b.color));
        }
        break;
      }
      case 'spacer':
        for (let i = 0; i < Math.max(1, Math.min(10, b.lines)); i++) lines.push('');
        break;
    }
  }
  return { body: frame(lines, recipe.frame, recipe.frameColor, width).join('\n') + '\n', fonts };
}

const FRAMES: Record<Exclude<Frame, 'none'>, { tl: string; tr: string; bl: string; br: string; h: string; v: string }> = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
  heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
  hash: { tl: '#', tr: '#', bl: '#', br: '#', h: '#', v: '#' },
};

function frame(lines: string[], kind: Frame, color: number | null, width: number): string[] {
  if (kind === 'none') return lines.map((l) => l.replace(/\s+$/, ''));
  const f = FRAMES[kind];
  const inner = width;
  const side = (s: string) => colorize(s, color);
  const out = [side(f.tl + f.h.repeat(inner + 2) + f.tr)];
  for (const l of lines) {
    const pad = Math.max(0, inner - visibleWidth(l));
    // A colour run must not leak into the border: reset before the padding.
    const safe = /\x03/.test(l) && !l.endsWith('\x0F') ? `${l}\x0F` : l;
    out.push(`${side(f.v)} ${safe}${' '.repeat(pad)} ${side(f.v)}`);
  }
  out.push(side(f.bl + f.h.repeat(inner + 2) + f.br));
  return out;
}

/** Human-facing summary of a recipe's banner fonts for variant names. */
export function fontsLabel(fonts: string[]): string {
  return fonts.length ? fonts.join(' + ') : 'text';
}

/** Longest visible line of a rendered body, in cells. */
export function bodyWidth(body: string): number {
  return Math.max(0, ...body.split('\n').map((l) => visibleWidth(l)));
}
