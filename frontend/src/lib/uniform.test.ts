import { describe, it, expect } from 'vitest';
import {
  paint, shown, isDefaultBlank, safeTrim, safeTrimHead, safeTrimBoth,
  raggedTail, raggedHead, leftPad, indentCell, flatTail, lineBytes, prefixBytes, endState,
  cellsFor, tailSub, clampSample, constPad, leftMargin, rightMargin,
  headSub, cellStart, spanCells, clampLeft, constPadLeft,
} from './uniform';
import type { Cell, Colour } from './uniform';

describe('UniformTail §1 — paint and safeTrim', () => {
  it('shown and isDefaultBlank', () => {
    const c: Cell = { fg: 2, bg: 5, glyph: 0 };
    expect(shown(c)).toBe(5);
    expect(isDefaultBlank(5, c)).toBe(true);
    expect(isDefaultBlank(4, c)).toBe(false);
    const c2: Cell = { fg: 2, bg: 5, glyph: 1 };
    expect(shown(c2)).toBe(2);
    expect(isDefaultBlank(5, c2)).toBe(false);
  });
  it('paint length and paint_trim', () => {
    const d: Colour = 0;
    const pre: Cell[] = [{ fg: 1, bg: 2, glyph: 1 }, { fg: 3, bg: 4, glyph: 1 }];
    const tail: Cell[] = [{ fg: 0, bg: 0, glyph: 0 }, { fg: 0, bg: 0, glyph: 0 }];
    const W = 5;
    expect(paint(d, W, [...pre, ...tail])).toEqual(paint(d, W, pre));
  });
  it('safeTrim is right-to-left dropWhile and paint_safeTrim', () => {
    const d: Colour = 0;
    const row: Cell[] = [
      { fg: 1, bg: 2, glyph: 1 },
      { fg: 0, bg: 0, glyph: 0 },
      { fg: 0, bg: 0, glyph: 0 },
    ];
    expect(safeTrim(d, row)).toEqual([{ fg: 1, bg: 2, glyph: 1 }]);
    const W = 4;
    expect(paint(d, W, safeTrim(d, row))).toEqual(paint(d, W, row));
  });
  it('safeTrim_last_opaque and safeTrim_eq_self_of_last_opaque', () => {
    const d: Colour = 0;
    const row: Cell[] = [{ fg: 1, bg: 2, glyph: 1 }];
    expect(safeTrim(d, row)).toEqual(row);
    const row2: Cell[] = [{ fg: 1, bg: 0, glyph: 0 }];
    // isDefaultBlank true, so trimmed
    expect(safeTrim(d, row2)).toEqual([]);
  });
  it('rectangular_of_last_opaque', () => {
    const d: Colour = 0;
    const M = 3;
    const rows: Cell[][] = [
      [{ fg: 1, bg: 2, glyph: 1 }, { fg: 1, bg: 2, glyph: 1 }, { fg: 1, bg: 2, glyph: 1 }],
      [{ fg: 3, bg: 4, glyph: 1 }, { fg: 3, bg: 4, glyph: 1 }, { fg: 3, bg: 4, glyph: 1 }],
    ];
    for (const r of rows) expect(safeTrim(d, r).length).toBe(M);
  });
  it('raggedTail', () => {
    const d: Colour = 0;
    const row: Cell[] = [{ fg: 1, bg: 0, glyph: 0 }, { fg: 0, bg: 0, glyph: 0 }];
    expect(raggedTail(d, row)).toBe(2);
    expect(raggedTail(d, [{ fg: 1, bg: 2, glyph: 1 }])).toBe(0);
  });
});

describe('UniformTail §2 — cost', () => {
  it('prefixBytes and lineBytes and flatTail', () => {
    const gb = (g: number) => (g === 0 ? 1 : 3);
    const fgCost = 2, pairCost = 5;
    const st: [Colour, Colour] = [0, 0];
    const row: Cell[] = [{ fg: 1, bg: 2, glyph: 1 }];
    expect(prefixBytes(fgCost, pairCost, st, [1, 2])).toBe(pairCost);
    expect(prefixBytes(fgCost, pairCost, [1, 2], [1, 2])).toBe(0);
    expect(prefixBytes(fgCost, pairCost, [0, 0], [1, 0])).toBe(fgCost);
    const c: Cell = { fg: 5, bg: 6, glyph: 1 };
    expect(flatTail(c, 3).length).toBe(3);
  });
  it('cellsFor and tailSub', () => {
    expect(cellsFor(4, 10)).toBe(3); // ceil(10/4)=3
    expect(tailSub(4, 10)).toBe(2); // 10 -2*4=2
    expect(tailSub(4, 8)).toBe(4);
  });
  it('clampSample vs constPad', () => {
    const s = (i: number) => i;
    const W = 5;
    // clamp replicates last
    expect(clampSample(s, W, 10)).toBe(4);
    expect(clampSample(s, W, 2)).toBe(2);
    expect(constPad(s, W, 99, 2)).toBe(2);
    expect(constPad(s, W, 99, 10)).toBe(99);
  });
});

describe('UniformHead — left edge', () => {
  it('safeTrimHead and leftPad', () => {
    const d: Colour = 0;
    const row: Cell[] = [{ fg: 0, bg: 0, glyph: 0 }, { fg: 0, bg: 0, glyph: 0 }, { fg: 1, bg: 2, glyph: 1 }];
    expect(safeTrimHead(d, row)).toEqual([{ fg: 1, bg: 2, glyph: 1 }]);
    expect(raggedHead(d, row)).toBe(2);
    const padded = leftPad(d, 2, [{ fg: 1, bg: 2, glyph: 1 }]);
    expect(padded.length).toBe(3);
    expect(padded[0]).toEqual(indentCell(d));
  });
  it('safeTrimBoth rectangular', () => {
    const d: Colour = 0;
    const row: Cell[] = [{ fg: 1, bg: 2, glyph: 1 }, { fg: 1, bg: 2, glyph: 1 }];
    expect(safeTrimBoth(d, row)).toEqual(row);
  });
  it('margins', () => {
    expect(leftMargin(10, 6)).toBe(2);
    expect(rightMargin(10, 6)).toBe(2);
    expect(leftMargin(10, 5)).toBe(2);
    expect(rightMargin(10, 5)).toBe(3);
  });
  it('headSub and spanCells', () => {
    expect(headSub(4, 6)).toBe(2); // 4-2=2
    expect(cellStart(4, 6)).toBe(4);
    expect(spanCells(4, 1, 10)).toBeGreaterThanOrEqual(cellsFor(4, 10));
  });
  it('clampLeft vs constPadLeft', () => {
    const s = (i: number) => i * 10;
    expect(clampLeft(s, 5, 2)).toBe(50); // max(2,5)=5 =>50
    expect(clampLeft(s, 5, 10)).toBe(100);
    expect(constPadLeft(s, 5, 99, 2)).toBe(99);
    expect(constPadLeft(s, 5, 99, 10)).toBe(100);
  });
});
