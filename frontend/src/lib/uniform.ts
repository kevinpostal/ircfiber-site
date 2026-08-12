/**
 * UniformTail / UniformHead — TS mirror of Lean UniformTail.lean / UniformHead.lean
 * Covers §1-4 (tail) and §1-5 (head) as referenced in img2irc.ts header.
 */

export type Colour = number;
export interface Cell { fg: Colour; bg: Colour; glyph: number } // glyph 0 = space

export function shown(c: Cell): Colour { return c.glyph === 0 ? c.bg : c.fg; }
export function isDefaultBlank(d: Colour, c: Cell): boolean { return c.glyph === 0 && c.bg === d; }

export function paint(d: Colour, W: number, row: Cell[]): Colour[] {
  const mapped = row.map(shown);
  const pad = Math.max(0, W - row.length);
  return [...mapped, ...Array(pad).fill(d)];
}

export function safeTrim(d: Colour, row: Cell[]): Cell[] {
  let i = row.length;
  while (i > 0 && isDefaultBlank(d, row[i - 1])) i--;
  return row.slice(0, i);
}

export function safeTrimHead(d: Colour, row: Cell[]): Cell[] {
  let i = 0;
  while (i < row.length && isDefaultBlank(d, row[i])) i++;
  return row.slice(i);
}

export function safeTrimBoth(d: Colour, row: Cell[]): Cell[] {
  return safeTrimHead(d, safeTrim(d, row));
}

export function raggedTail(d: Colour, row: Cell[]): number {
  return row.length - safeTrim(d, row).length;
}
export function raggedHead(d: Colour, row: Cell[]): number {
  return row.length - safeTrimHead(d, row).length;
}

export function indentCell(d: Colour): Cell { return { fg: 0, bg: d, glyph: 0 }; }
export function leftPad(d: Colour, n: number, row: Cell[]): Cell[] {
  return [...Array(n).fill(null).map(() => indentCell(d)), ...row];
}
export function flatTail(c: Cell, n: number): Cell[] {
  return Array(n).fill(c);
}

// Cost model §2
export function prefixBytes(fgCost: number, pairCost: number, prev: [Colour, Colour], cur: [Colour, Colour]): number {
  if (prev[0] === cur[0] && prev[1] === cur[1]) return 0;
  if (prev[1] === cur[1]) return fgCost;
  return pairCost;
}
export function lineBytes(gb: (g: number) => number, fgCost: number, pairCost: number, st: [Colour, Colour], row: Cell[]): number {
  let cost = 0;
  let cur: [Colour, Colour] = st;
  for (const c of row) {
    cost += prefixBytes(fgCost, pairCost, cur, [c.fg, c.bg]) + gb(c.glyph);
    cur = [c.fg, c.bg];
  }
  return cost;
}
export function endState(st: [Colour, Colour], row: Cell[]): [Colour, Colour] {
  let cur = st;
  for (const c of row) cur = [c.fg, c.bg];
  return cur;
}

// Padding §3
export function cellsFor(k: number, W: number): number {
  return Math.floor((W + k - 1) / k);
}
export function tailSub(k: number, W: number): number {
  const c = cellsFor(k, W);
  return W - (c - 1) * k;
}
export function clampSample(s: (i: number) => Colour, W: number, i: number): Colour {
  return s(Math.min(i, W - 1));
}
export function constPad(s: (i: number) => Colour, W: number, pad: Colour, i: number): Colour {
  return i < W ? s(i) : pad;
}

// Margins §4 tail / §4 head
export function leftMargin(M: number, C: number): number { return Math.floor((M - C) / 2); }
export function rightMargin(M: number, C: number): number { return M - C - leftMargin(M, C); }

// Near edge §5 head
export function headSub(k: number, x0: number): number { return k - (x0 % k); }
export function cellStart(k: number, x0: number): number { return Math.floor(x0 / k) * k; }
export function spanCells(k: number, x0: number, W: number): number {
  return Math.floor((x0 + W - 1) / k) - Math.floor(x0 / k) + 1;
}
export function clampLeft(s: (i: number) => Colour, x0: number, i: number): Colour {
  return s(Math.max(i, x0));
}
export function constPadLeft(s: (i: number) => Colour, x0: number, pad: Colour, i: number): Colour {
  return x0 <= i ? s(i) : pad;
}
