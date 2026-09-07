import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// Lives under src/lib so it runs in the node `lib` project (needs fs for
// the font fixtures); the module under test is admin-only.
import { parseTdf, renderTdf, tdfCovers } from '../admin/lib/tdf';
import { stripMirc, maxLineBytes } from '../admin/lib/mirc';

const load = (name: string) => parseTdf(readFileSync(new URL(`../../../public/tdf/${name}.tdf`, import.meta.url)));

describe('TheDraw font renderer', () => {
  // Reference output from tdfiglet (github.com/tat3r/tdfiglet) for the same
  // font: `tdfiglet -c m -e u -f aardvark.tdf IRC`, colour codes stripped.
  it('renders glyphs cell-for-cell like tdfiglet', () => {
    const lines = renderTdf(load('aardvark'), 'IRC').map(stripMirc);
    expect(lines).toEqual([
      '▐▄▄▌ ▐▄▄▄▄▄▄▌   ▐▄▄▄▄▄▌',
      '▐██▌ ▐██▌ ▐██▌ ▐██▌',
      '▐██▌ ▐██████▌  ▐██▌',
      '▐▀▀▌ ▐▀▀▌ ▐▀▀▌ ▐▀▀▌',
      '▐▄▄▌ ▐▄▄▌ ▐▄▄▌  ▐▄▄▄▄▄▌',
    ]);
  });

  it('emits two-digit mIRC codes so a digit glyph never extends a code', () => {
    const font = load('aardvark');
    const line = renderTdf(font, 'A1').join('\n');
    for (const m of line.matchAll(/\x03(\d*)(?:,(\d*))?/g)) {
      if (m[1]) expect(m[1]).toHaveLength(2);
      if (m[2]) expect(m[2]).toHaveLength(2);
    }
    // Plain rendering carries no codes at all.
    expect(renderTdf(font, 'IRC', { color: false }).join('')).not.toMatch(/\x03/);
  });

  it('keeps a 72-column coloured banner inside the IRC line byte budget', () => {
    // The widest curated fonts at "IRC Fiber" are the ones that matter.
    for (const name of ['aardvark', 'cybrcrme', 'blcktrnc']) {
      const body = renderTdf(load(name), 'IRC Fiber').join('\n');
      expect(maxLineBytes(body)).toBeLessThanOrEqual(450);
    }
  });

  it('reports glyph coverage and skips missing characters like tdfiglet', () => {
    const font = load('aardvark');
    expect(tdfCovers(font, 'IRC Fiber 2026')).toBe(true);
    expect(tdfCovers(font, 'ünïcode')).toBe(false);
    // A space becomes a gap; an uncovered character is dropped, not drawn.
    const withSpace = renderTdf(font, 'I C', { color: false })[1];
    const without = renderTdf(font, 'IC', { color: false })[1];
    expect(withSpace.length).toBeGreaterThan(without.length);
    expect(renderTdf(font, 'IüC', { color: false })).toEqual(renderTdf(font, 'IC', { color: false }));
  });

  it('rejects files that are not TheDraw colour fonts', () => {
    expect(() => parseTdf(new TextEncoder().encode('not a font'))).toThrow(/TheDraw/);
  });
});
