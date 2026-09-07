import { describe, it, expect } from 'vitest';
import { DEFAULT_COMPOSE_STYLE, type ComposeStyle } from './composeStyle';
import { renderComposeLines } from './composePipeline';
import { applyCase, applyUnicodeStyle, colorizeLine } from './textEffects';
import { utf8Length } from './messageSplitter';

const style = (patch: Partial<ComposeStyle>): ComposeStyle => ({ ...DEFAULT_COMPOSE_STYLE, ...patch });

describe('renderComposeLines', () => {
  it('solid fg+bg with bold wraps attrs and resets', async () => {
    const r = await renderComposeLines('hi', style({ bold: true, color: { kind: 'solid', fg: 4, bg: 1 } }), 400);
    expect(r.lines).toEqual(['\x02\x0304,01hi\x0F']);
    expect(r.overBudget).toEqual([]);
  });

  it('rainbow classic colours per non-space char, bg omitted when null', async () => {
    const r = await renderComposeLines('ab cd', style({ color: { kind: 'rainbow', palette: 'classic', bg: null } }), 400);
    expect(r.lines).toEqual(['\x0304a\x0307b \x0308c\x0309d\x0F']);
  });

  it('rainbow emits bg once then fg-only changes', () => {
    expect(colorizeLine('ab', { kind: 'rainbow', palette: 'classic', bg: 1 })).toBe('\x0304,01a\x0307b');
  });

  it('gradient endpoints quantize to from/to', () => {
    const out = colorizeLine('abc', { kind: 'gradient', from: 52, to: 60, bg: null });
    expect(out.startsWith('\x0352a')).toBe(true);
    expect(out.endsWith('\x0360c')).toBe(true);
  });

  it('wordCycle assigns a colour per word', () => {
    expect(colorizeLine('aa bb cc', { kind: 'wordCycle', colors: [4, 12], bg: null })).toBe('\x0304aa \x0312bb \x0304cc');
  });

  it('splits an over-budget plain line so every part fits and keeps the prefix', async () => {
    const plain = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' '); // ~1000 chars
    expect(plain.length).toBeGreaterThan(800);
    const r = await renderComposeLines(plain, style({ color: { kind: 'solid', fg: 4, bg: null } }), 400);
    expect(r.lines.length).toBeGreaterThan(1);
    for (const line of r.lines) {
      expect(utf8Length(line)).toBeLessThanOrEqual(400);
      expect(line.startsWith('\x0304')).toBe(true);
      expect(line.endsWith('\x0F')).toBe(true);
    }
    expect(r.overBudget).toEqual([]);
  });

  it('drops blank lines and passes plain text through when nothing is set', async () => {
    const r = await renderComposeLines('a\n\nb', DEFAULT_COMPOSE_STYLE, 400);
    expect(r.lines).toEqual(['a', 'b']);
  });
});

describe('textEffects', () => {
  it('doubleStruck uses the BMP exceptions', () => {
    expect(applyUnicodeStyle('Hz0', 'doubleStruck')).toBe('ℍ𝕫𝟘');
  });

  it('mocking case alternates per letter and skips punctuation', () => {
    expect(applyCase('ab cd', 'mocking')).toBe('aB cD');
    expect(applyCase('a.b', 'mocking')).toBe('a.B');
  });

  it('upsideDown flips and reverses', () => {
    expect(applyUnicodeStyle('ab!', 'upsideDown')).toBe('¡qɐ');
  });
});
