/**
 * TDF word-wrap visual test — `IRC FIBER` at width 80 word-wrap vs off.
 *
 * Location note: the plan named a visual test under src/lib, but
 * `vite.config.ts` assigns src/lib test files to the node `lib`
 * project and the `client` (Playwright Chromium) project excludes
 * src/lib. A `vitest-browser-svelte` render plus screenshot test
 * cannot run from src/lib, so this file lives under src/components
 * where the `client` project picks it up. Name intent and all plan
 * assertions are preserved.
 *
 * Offline: no ircd/network. Screenshots land in a local screenshots dir
 * (gitignored under site gitignore); CI runs assertions only.
 * Run locally with vitest run on this file plus --project=client.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import LongMessageContent from './LongMessageContent.svelte';
import { DEFAULT_COMPOSE_STYLE } from '../lib/composeStyle';
import { renderComposeLines } from '../lib/composePipeline';
import { listTdfFonts, renderTdf } from '../lib/tdf';
import { parseIrcFormatting, stripIrcFormatting } from '../lib/ircFormatting';

const PROBE = 'IRC FIBER';
const WRAP_WIDTH = 80;
const BUDGET = 4000;

const spread = (line: string): number => [...stripIrcFormatting(line)].length;
const safe = (name: string): string => name.replace(/[^A-Za-z0-9]+/g, '_');
const hasInk = (line: string): boolean => stripIrcFormatting(line).trim() !== '';

async function candidateFonts() {
  const all = await listTdfFonts();
  const inRange = all.filter((f) => f.height >= 8 && f.height <= 10);
  expect(inRange.length, 'expected >=1 TDF font with height 8-10, got 0').toBeGreaterThan(0);
  console.log(`tdf-wrap: ${inRange.length} fonts at height 8-10`);
  return { fontA: inRange[0], fontB: inRange[1] ?? inRange[0] };
}

async function diagnoseGlyphs(name: string): Promise<void> {
  // A missing glyph renders as all-blank rows (tdf.ts skips unknown chars):
  // probe each letter alone, stripped of IRC codes.
  for (const ch of 'IRCFIBE') {
    const solo = (await renderTdf(ch, name)).map((l) => stripIrcFormatting(l)).join('').trim();
    if (solo === '') console.log(`tdf-wrap: font ${name} lacks glyph ${ch} (tdfiglet skip, not a wrap bug)`);
  }
}

async function checkWrapped(name: string, height: number): Promise<string[]> {
  const wrapped = await renderComposeLines(
    PROBE,
    { ...DEFAULT_COMPOSE_STYLE, font: { kind: 'tdf', font: name }, artWrap: { mode: 'word', width: WRAP_WIDTH } },
    BUDGET,
  );
  const singleH = (await renderTdf('IRC', name)).length;
  const fiberW = (await renderTdf('FIBER', name)).reduce((m, l) => Math.max(m, spread(l)), 0);
  const ircW = (await renderTdf('IRC', name)).reduce((m, l) => Math.max(m, spread(l)), 0);
  const loneOverWide = ircW > WRAP_WIDTH || fiberW > WRAP_WIDTH;

  if (!loneOverWide) {
    expect(wrapped.lines.length, `font ${name}: two stacked banners`).toBe(2 * singleH);
  } else {
    expect([singleH, 2 * singleH]).toContain(wrapped.lines.length);
  }
  for (const line of wrapped.lines) {
    if (!loneOverWide) expect(spread(line), `font ${name}: row fits ${WRAP_WIDTH}`).toBeLessThanOrEqual(WRAP_WIDTH);
    expect(hasInk(line), `font ${name}: no blank middle rows`).toBe(true);
  }
  const longest = wrapped.lines.reduce((m, l) => Math.max(m, spread(l)), 0);
  console.log(`tdf-wrap: font=${name} height=${height} lines=${wrapped.lines.length} longest=${longest}`);
  expect(longest <= WRAP_WIDTH || loneOverWide).toBe(true);

  // Contrast control: off renders the one wide banner line-for-line.
  const off = await renderComposeLines(
    PROBE,
    { ...DEFAULT_COMPOSE_STYLE, font: { kind: 'tdf', font: name }, artWrap: { mode: 'off', width: WRAP_WIDTH } },
    BUDGET,
  );
  expect(off.lines).toEqual(await renderTdf(PROBE, name));
  return wrapped.lines;
}

async function showArt(lines: string[], shotPath: string): Promise<void> {
  render(LongMessageContent, {
    props: { text: lines.join('\n'), render: (t: string) => parseIrcFormatting(t), isBlockArt: true },
  });
  const host = document.querySelector('.longMessageContent') as HTMLElement | null;
  expect(host, 'art host mounted').not.toBeNull();
  // Production `blockArt` class + pre/mono so columns survive proportional fonts.
  document.body.classList.add('blockArt');
  host!.style.whiteSpace = 'pre';
  host!.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
  // The browser viewport is narrow (page.screenshot ignores fullPage here),
  // so pin a compact mono/pre block: 57-col banners fit without scrolling.
  // Shape/alignment is the wrap proof; mIRC colours need app.css (loaded in
  // production, not in this harness) and are not part of this capture.
  host!.style.fontSize = '9px';
  host!.style.lineHeight = '1.2';
  document.body.style.margin = '0';
  expect(host!.textContent ?? '', 'wrapped art keeps block glyphs').toMatch(/[▐▄█▀#\/\\|<>_\[\]]/);
  await (page as unknown as { screenshot: (o: Record<string, unknown>) => Promise<void> }).screenshot({
    path: shotPath,
    fullPage: true,
  });
}

describe('tdf word-wrap visual', () => {
  it('wraps IRC FIBER into stacked readable banners (fontA)', { timeout: 60000 }, async () => {
    const { fontA } = await candidateFonts();
    await diagnoseGlyphs(fontA.name);
    const lines = await checkWrapped(fontA.name, fontA.height);
    await showArt(lines, `__screenshots__/tdf-wrap-${safe(fontA.name)}-w80.png`);
  });

  it('wraps IRC FIBER into stacked readable banners (fontB)', { timeout: 60000 }, async () => {
    const { fontB } = await candidateFonts();
    await diagnoseGlyphs(fontB.name);
    const lines = await checkWrapped(fontB.name, fontB.height);
    await showArt(lines, `__screenshots__/tdf-wrap-${safe(fontB.name)}-w80.png`);
  });
});
