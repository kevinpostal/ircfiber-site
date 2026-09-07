import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTdfRecord, renderTdfFont, type TdfFontMeta } from './tdf';
import { stripIrcFormatting } from './ircFormatting';
import { utf8Length } from './messageSplitter';

// The packed fonts (src/lib/tdf-fonts.bin) are the single source the MOTD
// builder and the compose dialog render from; this pins the port against
// tdfiglet's output for a shipped font and guards the whole pack.
const bin = readFileSync(new URL('./tdf-fonts.bin', import.meta.url));
const headerLen = bin.readUInt32LE(0);
const metas = (JSON.parse(bin.subarray(4, 4 + headerLen).toString('utf8')) as { fonts: TdfFontMeta[] }).fonts;
const dataStart = 4 + headerLen;

function loadByStem(stem: string) {
  const meta = metas.find((f) => f.file === stem);
  if (!meta) throw new Error(`no packed font for stem ${stem}`);
  return parseTdfRecord(new Uint8Array(bin.buffer, bin.byteOffset + dataStart + meta.off, meta.len));
}

function maxLineBytes(body: string): number {
  return Math.max(0, ...body.split('\n').map((l) => utf8Length(l)));
}

describe('TheDraw fonts packed for the MOTD builder', () => {
  // Reference: `tdfiglet -c m -e u -f aardvark.tdf IRC` (github.com/tat3r/
  // tdfiglet), colour codes stripped, blank edge rows dropped.
  it('renders glyphs cell-for-cell like tdfiglet', () => {
    const lines = renderTdfFont(loadByStem('aardvark'), 'IRC').map((l) => stripIrcFormatting(l).replace(/\s+$/, ''));
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
    for (const stem of ['aardvark', 'cybrcrme', 'blcktrnc', 'hwplated']) {
      const body = renderTdfFont(loadByStem(stem), 'IRC Fiber').join('\n');
      expect(maxLineBytes(body), stem).toBeLessThanOrEqual(450);
    }
  });
  it('every packed font colours the glyphs it defines', () => {
    expect(metas.length).toBeGreaterThan(1000);
    for (const meta of metas) {
      const font = parseTdfRecord(new Uint8Array(bin.buffer, bin.byteOffset + dataStart + meta.off, meta.len));
      const plain = renderTdfFont(font, 'ABCXYZabcxyz09', { color: false }).join('');
      expect(plain.replace(/\s/g, '').length, meta.name).toBeGreaterThan(0);
      // Fonts cover different subsets (e.g. Andromenia is lowercase-only):
      // every glyph the font does define must arrive coloured.
      const covered = 'ABCXYZabcxyz09'.split('').filter((c) => renderTdfFont(font, c, { color: false }).join('').trim() !== '');
      expect(covered.length, meta.name).toBeGreaterThan(0);
      expect(renderTdfFont(font, covered.join('')).join(''), meta.name).toMatch(/\x03\d\d/);
    }
  });
});
