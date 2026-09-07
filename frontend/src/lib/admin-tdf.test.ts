import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTdf, renderTdfFont } from './tdf';
import { stripMirc, maxLineBytes } from '../admin/lib/mirc';

// Real font fixtures from public/tdf (the admin MOTD builder's curated set);
// tdf.test.ts covers the format with synthetic fonts, this pins the port
// against tdfiglet's output for a shipped font.
function load(name: string) {
  const buf = readFileSync(new URL(`../../../public/tdf/${name}.tdf`, import.meta.url));
  // A Node Buffer can be a view into a shared pool: hand over an exact copy.
  return parseTdf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

describe('TheDraw fonts shipped for the MOTD builder', () => {
  // Reference: `tdfiglet -c m -e u -f aardvark.tdf IRC` (github.com/tat3r/
  // tdfiglet), colour codes stripped, blank edge rows dropped.
  it('renders glyphs cell-for-cell like tdfiglet', () => {
    const lines = renderTdfFont(load('aardvark'), 'IRC').map((l) => stripMirc(l).replace(/\s+$/, ''));
    expect(lines).toEqual([
      '▐▄▄▌ ▐▄▄▄▄▄▄▌   ▐▄▄▄▄▄▌',
      '▐██▌ ▐██▌ ▐██▌ ▐██▌',
      '▐██▌ ▐██████▌  ▐██▌',
      '▐▀▀▌ ▐▀▀▌ ▐▀▀▌ ▐▀▀▌',
      '▐▄▄▌ ▐▄▄▌ ▐▄▄▌  ▐▄▄▄▄▄▌',
    ]);
  });

  it('keeps a 72-column coloured banner inside the IRC line byte budget', () => {
    // The widest curated fonts at "IRC Fiber" are the ones that matter:
    // `:server 372 <32-char nick> :` leaves ~450 bytes of a 512-byte line.
    for (const name of ['aardvark', 'cybrcrme', 'blcktrnc', 'hwplated']) {
      const body = renderTdfFont(load(name), 'IRC Fiber').join('\n');
      expect(maxLineBytes(body), name).toBeLessThanOrEqual(450);
    }
  });

  it('every curated font renders the full alphabet in colour', () => {
    const index = JSON.parse(readFileSync(new URL('../admin/lib/tdf-fonts.json', import.meta.url), 'utf8')) as { name: string }[];
    expect(index.length).toBe(60);
    for (const { name } of index) {
      const font = load(name);
      const plain = renderTdfFont(font, 'ABCXYZabcxyz09', { color: false }).join('');
      expect(plain.replace(/\s/g, '').length, name).toBeGreaterThan(0);
      expect(renderTdfFont(font, 'IRC').join('')).toMatch(/\x03\d\d/);
    }
  });
});
