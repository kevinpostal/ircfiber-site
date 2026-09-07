/**
 * TheDraw (.TDF) colour font renderer — a port of tdfiglet's reader
 * (github.com/tat3r/tdfiglet, BSD) producing mIRC-coloured lines.
 *
 * File layout (one font per file is all we read, like tdfiglet):
 *   0..19   magic  "\x13TheDraw FONTS file\x1a"
 *   24      name length, 25.. name
 *   41      font type (0 outline, 1 block, 2 colour — only 2 supported)
 *   42      spacing between glyphs
 *   43..44  block size (u16 LE)
 *   45..232 94 × u16 LE glyph offsets for "!".."~" (0xffff = missing)
 *   233..   glyph data: width, height, then cells (CP437 char, attr) with
 *           0x0d as row break and 0x00 terminating the glyph.
 *
 * Attribute byte: low nibble fg, high nibble bg, in TheDraw's (CGA)
 * order; mapped to mIRC colour numbers exactly as tdfiglet does.
 */

const MAGIC = '\x13TheDraw FONTS file\x1a';
const CHARLIST = '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
const NUM_CHARS = 94;

// CGA order: BLK BLU GRN CYN RED MAG BRN GRY, then bright variants.
const FG_MIRC = [1, 2, 3, 10, 5, 6, 7, 15, 14, 12, 9, 11, 4, 13, 8, 0];
const BG_MIRC = FG_MIRC;

/** CP437 → Unicode for the upper half; 0x20..0x7e map to themselves. */
const CP437_HIGH = [
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7, 0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
  0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9, 0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
  0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba, 0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556, 0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
  0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f, 0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
  0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b, 0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
  0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4, 0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
  0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248, 0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0,
];

function cp437(b: number): string {
  if (b < 0x20) return ' ';
  if (b < 0x7f) return String.fromCharCode(b);
  if (b === 0x7f) return '\u2302';
  return String.fromCharCode(CP437_HIGH[b - 0x80]);
}

export interface TdfGlyph {
  width: number;
  height: number;
  /** Row-major `width × font.height` cells. */
  cells: { ch: string; attr: number }[];
}

export interface TdfFont {
  name: string;
  spacing: number;
  /** Tallest glyph — every glyph is padded to this many rows. */
  height: number;
  glyphs: (TdfGlyph | null)[];
}

/** Parses the first colour font in a .TDF buffer. Throws on other types. */
export function parseTdf(buf: ArrayBuffer | Uint8Array): TdfFont {
  // A Node Buffer may be a view into a shared pool: respect its offset.
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < MAGIC.length; i++) {
    if (b[i] !== MAGIC.charCodeAt(i)) throw new Error('not a TheDraw font file');
  }
  const nameLen = b[24];
  const name = String.fromCharCode(...b.subarray(25, 25 + Math.min(nameLen, 16)));
  const type = b[41];
  if (type !== 2) throw new Error(`unsupported TheDraw font type ${type} (colour fonts only)`);
  const spacing = b[42];
  const offsets: number[] = [];
  for (let i = 0; i < NUM_CHARS; i++) offsets.push(b[45 + i * 2] | (b[46 + i * 2] << 8));
  const data = 233;

  let height = 0;
  for (let i = 0; i < NUM_CHARS; i++) {
    if (offsets[i] === 0xffff) continue;
    const p = data + offsets[i];
    if (p + 2 > b.length) throw new Error('glyph offset past end of file');
    if (b[p + 1] > height) height = b[p + 1];
  }

  const glyphs: (TdfGlyph | null)[] = [];
  for (let i = 0; i < NUM_CHARS; i++) {
    if (offsets[i] === 0xffff) { glyphs.push(null); continue; }
    let p = data + offsets[i];
    const width = b[p++];
    const gh = b[p++];
    const cells = Array.from({ length: width * height }, () => ({ ch: ' ', attr: 0 }));
    let row = 0, col = 0;
    while (p < b.length && b[p] !== 0) {
      const ch = b[p++];
      if (ch === 0x0d) { row++; col = 0; continue; }
      const attr = b[p++];
      if (row < height && col < width) cells[row * width + col] = { ch: cp437(ch), attr };
      col++;
    }
    glyphs.push({ width, height: gh, cells });
  }
  return { name, spacing, height, glyphs };
}

/** Always two digits per index so a following digit glyph can't extend the code. */
function two(n: number): string { return String(n).padStart(2, '0'); }
/** `\x03FG,BG`; `withBg=false` emits `\x03FG`, which leaves the background as is. */
function mircCode(attr: number, withBg: boolean): string {
  const fg = two(FG_MIRC[attr & 0x0f]);
  return withBg ? `\x03${fg},${two(BG_MIRC[(attr & 0xf0) >> 4])}` : `\x03${fg}`;
}

/** True when the font can render every character of `text` (spaces always can). */
export function tdfCovers(font: TdfFont, text: string): boolean {
  for (const c of text) {
    if (c === ' ') continue;
    const i = CHARLIST.indexOf(c);
    if (i === -1 || !font.glyphs[i]) return false;
  }
  return true;
}

export interface TdfRenderOptions {
  /** Cells for a space (TDF fonts have no space glyph); default 2 + spacing. */
  spaceWidth?: number;
  /** Emit mIRC colour codes (default true); false gives plain block art. */
  color?: boolean;
}

/**
 * Renders `text` as `font.height` lines. Characters the font lacks are
 * skipped (tdfiglet behaviour). Colour codes are emitted on change only —
 * foreground-only (3 chars) when the background is unchanged — and reset
 * at the end of each line, since IRC's 512-byte line is what bounds how
 * many colour runs a banner row can carry.
 */
export function renderTdf(font: TdfFont, text: string, opts: TdfRenderOptions = {}): string[] {
  const color = opts.color ?? true;
  const spaceWidth = opts.spaceWidth ?? 2 + font.spacing;
  const glyphs: (TdfGlyph | 'space')[] = [];
  for (const c of text) {
    if (c === ' ') { glyphs.push('space'); continue; }
    const g = font.glyphs[CHARLIST.indexOf(c)];
    if (g) glyphs.push(g);
  }
  const lines: string[] = [];
  const bgOf = (attr: number) => (attr & 0xf0) >> 4;
  for (let row = 0; row < font.height; row++) {
    let out = '';
    // Colour state: -1 = default (no foreground set, black background).
    let last = -1;
    const curBg = () => (last === -1 ? 0 : bgOf(last));
    const pad = (n: number) => {
      if (n <= 0) return;
      if (color && curBg() !== 0) { out += '\x03'; last = -1; }
      out += ' '.repeat(n);
    };
    glyphs.forEach((g, gi) => {
      if (g === 'space') { pad(spaceWidth); return; }
      for (let x = 0; x < g.width; x++) {
        const cell = g.cells[row * g.width + x];
        if (color) {
          if (cell.ch === ' ') {
            // Blank cell: only its background shows.
            if (bgOf(cell.attr) !== curBg()) { out += mircCode(cell.attr, true); last = cell.attr; }
          } else if (cell.attr !== last) {
            out += mircCode(cell.attr, bgOf(cell.attr) !== curBg());
            last = cell.attr;
          }
        }
        out += cell.ch;
      }
      if (gi < glyphs.length - 1) pad(font.spacing);
    });
    // Trailing blanks on a black background are invisible: drop them (and
    // any code that only coloured them) before the closing reset.
    if (curBg() === 0) out = out.replace(/(\x03\d{2}(,\d{2})?)?\s+$/, '');
    if (color && last !== -1 && !out.endsWith('\x03')) out += '\x03';
    lines.push(out);
  }
  return lines;
}
