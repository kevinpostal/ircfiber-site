import { describe, it, expect, vi } from 'vitest';

// The module imports the packed fonts via `?url`; stub it so node never
// resolves the binary asset.
vi.mock('./tdf-fonts.bin?url', () => ({ default: '/tdf-fonts.bin' }));

const { parseTdfRecord, renderTdfFont } = await import('./tdf');

/** One colour-font record (no file magic): name `T`, spacing 1, glyph for `A` only. */
function record(): Uint8Array {
  const glyph = [
    2, 2, // width, height
    0x23, 0x1f, 0x23, 0x1f, 0x0d, // "##" fg 15 (→0) on bg 1 (→2), row break
    0x20, 0x00, 0x23, 0x4e, // " " default, "#" fg 14 (→8) on bg 4 (→5)
    0x00,
  ];
  const b = new Uint8Array(213 + glyph.length);
  b[4] = 1;
  b[5] = 'T'.charCodeAt(0);
  b[21] = 2;
  b[22] = 1;
  b[23] = glyph.length & 0xff;
  b[24] = glyph.length >> 8;
  for (let i = 0; i < 94; i++) { b[25 + i * 2] = 0xff; b[26 + i * 2] = 0xff; }
  const a = 'A'.charCodeAt(0) - 33;
  b[25 + a * 2] = 0; b[26 + a * 2] = 0;
  b.set(glyph, 213);
  return b;
}

describe('tdf', () => {
  const font = parseTdfRecord(record());

  it('parses name, spacing and height', () => {
    expect(font.name).toBe('T');
    expect(font.spacing).toBe(1);
    expect(font.height).toBe(2);
  });

  it('renders cells with two-digit colour codes and a reset per line', () => {
    expect(renderTdfFont(font, 'A')).toEqual(['\x0300,02##\x0F', ' \x0308,05#\x0F']);
  });

  it('separates glyphs by spacing and spaces by a 4-column gap', () => {
    expect(renderTdfFont(font, 'A A')[0]).toBe('\x0300,02##\x03     \x0300,02##\x0F');
  });

  it('skips characters the font lacks', () => {
    expect(renderTdfFont(font, 'A?')).toEqual(renderTdfFont(font, 'A'));
  });
});
