import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_COMPOSE_STYLE, clampArtWrapWidth, type ComposeStyle } from './composeStyle';
import { groupWidths, renderComposeLines } from './composePipeline';
import { applyCase, applyUnicodeStyle, colorizeLine } from './textEffects';
import { utf8Length } from './messageSplitter';

// TheDraw pack is a fetched binary asset: stub the renderer so wrap-grouping
// tests measure deterministic widths (`[word]` per word, joined with spaces).
vi.mock('./tdf', () => ({
  renderTdf: vi.fn(async (text: string) => [`[${text}]`]),
}));
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

  it('renders a 10-row figlet banner unfolded at width 400', async () => {
    const { renderFiglet } = await import('./figlet');
    const expected = (await renderFiglet('IRC FIBER', 'Bloody', { width: 400 })).split('\n');
    expect(expected.length).toBe(10);
    const r = await renderComposeLines('IRC FIBER', style({ font: { kind: 'figlet', font: 'Bloody' } }), 4000);
    expect(r.overBudget).toEqual([]);
    // push() drops blank lines; the banner itself has no blank edges.
    expect(r.lines.map((l) => l.replace(/\s+$/, ''))).toEqual(expected.filter((l) => l.trim() !== ''));
  });

  it('does not fold a wide banner at 80 columns', async () => {
    const { renderFiglet } = await import('./figlet');
    const expected = (await renderFiglet('IRC FIBER', 'Flower Power', { width: 400 })).split('\n');
    // Wide enough that the old width-80 fold would have reflowed it.
    expect(Math.max(...expected.map((l) => l.length))).toBeGreaterThan(80);
    const r = await renderComposeLines('IRC FIBER', style({ font: { kind: 'figlet', font: 'Flower Power' } }), 4000);
    expect(r.overBudget).toEqual([]);
    expect(r.lines.map((l) => l.replace(/\s+$/, ''))).toEqual(expected.filter((l) => l.trim() !== ''));
  });

  it('flags over-budget art rows so styled sends route to pastebin, never split', async () => {
    const r = await renderComposeLines('IRC FIBER', style({ font: { kind: 'figlet', font: 'Bloody' } }), 50);
    expect(r.lines.length).toBeGreaterThan(0);
    // A tiny budget exceeds every wide art row: the send path must open
    // the pastebin dialog on this signal instead of emitting PRIVMSGs.
    expect(r.overBudget.length).toBeGreaterThan(0);
    expect(r.lines.join('\n').trim()).not.toBe('');
  });

  it('folds a figlet banner between words at the wrap width', async () => {
    const { renderFiglet } = await import('./figlet');
    const expected = (await renderFiglet('IRC FIBER', 'Bloody', { width: 40 })).split('\n');
    const r = await renderComposeLines(
      'IRC FIBER',
      style({ font: { kind: 'figlet', font: 'Bloody' }, artWrap: { mode: 'word', width: 40 } }),
      4000,
    );
    expect(r.overBudget).toEqual([]);
    expect(r.lines.map((l) => l.replace(/\s+$/, ''))).toEqual(expected.filter((l) => l.trim() !== ''));
  });

  it('clamps the wrap width into 20–400', async () => {
    expect(clampArtWrapWidth(NaN)).toBe(80);
    expect(clampArtWrapWidth(1)).toBe(20);
    expect(clampArtWrapWidth(80)).toBe(80);
    expect(clampArtWrapWidth(9999)).toBe(400);
  });

  it('packs words greedily without ever cutting one', async () => {
    // [aa bb] [cc]: aa+gap+bb fits 12, adding cc does not.
    expect(groupWidths([4, 4, 4], 4, 12)).toEqual([[0, 1], [2]]);
    // A lone word wider than the limit keeps its own group.
    expect(groupWidths([4, 99, 4], 4, 12)).toEqual([[0], [1], [2]]);
    expect(groupWidths([], 4, 80)).toEqual([]);
  });

  it('wraps TheDraw banners word by word, off sends one banner', async () => {
    const tdfStyle = (wrap: ComposeStyle['artWrap']) =>
      style({ font: { kind: 'tdf', font: 'Stub' }, artWrap: wrap });
    // Stub renders `[word]`; `[aaa]` is 5 cols: aaa+4+bbb = 14 fits 20,
    // adding ccc (14+4+5 = 23) does not — so two groups.
    const wrapped = await renderComposeLines('aaa bbb ccc', tdfStyle({ mode: 'word', width: 20 }), 4000);
    expect(wrapped.lines).toEqual(['[aaa bbb]', '[ccc]']);
    const whole = await renderComposeLines('aaa bbb ccc', tdfStyle({ mode: 'off', width: 80 }), 4000);
    expect(whole.lines).toEqual(['[aaa bbb ccc]']);
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
