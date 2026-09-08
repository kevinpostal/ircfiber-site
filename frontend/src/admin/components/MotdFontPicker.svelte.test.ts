/**
 * MotdFontPicker.svelte — the shared FIGlet/TheDraw gallery used by the MOTD
 * raw editor and the builder's banner block.
 *
 * Coverage:
 *  1. Every catalogue entry gets a card carrying its name and its rendered
 *     sample art (the point of the gallery: pick by looking, not by name).
 *  2. Clicking a card reports the entry *and* the banner lines the host has to
 *     insert, rendered at the MOTD's 80-column budget.
 *  3. A filter that matches nothing says so instead of showing an empty grid.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import MotdFontPicker from './MotdFontPicker.svelte';
import { renderFontSample } from '/src/lib/fontCatalog';

const ALPHA = { kind: 'tdf' as const, name: 'Alpha', rows: 5, note: 'alpha.tdf' };
const BETA = { kind: 'tdf' as const, name: 'Beta', rows: 3, note: 'beta.tdf' };

vi.mock('/src/lib/fontCatalog', () => ({
  listArtFonts: vi.fn(async () => [ALPHA, BETA]),
  sortFonts: (entries: typeof ALPHA[]) => entries,
  filterFonts: (entries: typeof ALPHA[], q: string) => {
    const n = q.trim().toLowerCase();
    return n ? entries.filter((e) => e.name.toLowerCase().includes(n)) : entries;
  },
  renderFontSample: vi.fn(async () => ['AAA', 'BBB']),
}));

// motdRecipe statically pulls the FIGlet and TheDraw renderers; the picker only
// needs its colour helper.
vi.mock('/src/admin/lib/motdRecipe', () => ({
  colorize: (text: string, fg: number | null) => (fg === null ? text : `\x03${fg}${text}\x0F`),
}));

const mockedRender = vi.mocked(renderFontSample);

describe('MotdFontPicker.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRender.mockResolvedValue(['AAA', 'BBB']);
  });

  it('renders a card per font with its sample art', async () => {
    render(MotdFontPicker, { action: 'insert', kind: 'tdf', sample: 'IRC', selected: null, onPick: vi.fn() });
    await expect.element(page.getByRole('button', { name: 'Use Alpha' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Use Beta' })).toBeInTheDocument();
    await expect.element(page.getByText('alpha.tdf')).toBeInTheDocument();
    await expect.element(page.getByText('AAA').first()).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(mockedRender).toHaveBeenCalledWith(ALPHA, 'IRC', { width: 80 }),
    );
  });

  it('reports the picked entry with the rendered banner lines', async () => {
    const onPick = vi.fn();
    render(MotdFontPicker, { action: 'insert', kind: 'tdf', sample: 'IRC', selected: null, onPick });
    await page.getByRole('button', { name: 'Use Beta' }).click();
    await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith(BETA, ['AAA', 'BBB']));
  });

  it('reports only the font in pick mode', async () => {
    const onPick = vi.fn();
    render(MotdFontPicker, { action: 'pick', kind: 'tdf', sample: 'IRC', selected: null, onPick });
    await page.getByRole('button', { name: 'Use Alpha' }).click();
    await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith(ALPHA, []));
  });

  it('says so when the filter matches no font', async () => {
    render(MotdFontPicker, { action: 'insert', kind: 'tdf', sample: 'IRC', selected: null, onPick: vi.fn() });
    await expect.element(page.getByRole('button', { name: 'Use Alpha' })).toBeInTheDocument();
    await page.getByPlaceholder('name or file').fill('nosuchfont');
    await expect.element(page.getByText('No font matches “nosuchfont”.')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Use Alpha' })).not.toBeInTheDocument();
  });
});
