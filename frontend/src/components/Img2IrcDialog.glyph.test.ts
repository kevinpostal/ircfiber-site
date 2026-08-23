import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Img2IrcDialog from './Img2IrcDialog.svelte';

async function makeTestFile(): Promise<File> {
  const c = document.createElement('canvas');
  // Top black bottom white for half-block test (80x144 for half with width 80)
  c.width = 80;
  c.height = 144;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0,0,80,72);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,72,80,72);
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob null'))), 'image/png');
  const blob = await promise;
  return new File([blob], 'test.png', { type: 'image/png' });
}

describe('Img2IrcDialog glyph selection', () => {
  it('preview changes when glyphBlocks change', async () => {
    const file = await makeTestFile();
    render(Img2IrcDialog, { file, filename: 'test.png', onClose: () => {} });
    await expect.element(page.getByTestId('art')).toBeInTheDocument({ timeout: 8000 });

    const getArt = () => (page.getByTestId('art').element() as HTMLElement).innerHTML;

    // Ensure Half Detail is selected (glyphBlocks relevant for half)
    const halfRadio = page.getByRole('radio', { name: 'Half' });
    await expect.element(halfRadio).toBeInTheDocument();
    await halfRadio.click();
    await expect.element(halfRadio).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => getArt().length > 0, { timeout: 5000 }).toBe(true);

    const beforeHalf = getArt();

    const fullCb = page.getByTestId('block-full');
    await expect.element(fullCb).toBeInTheDocument({ timeout: 2000 });
    console.log('beforeHalf', beforeHalf.slice(0,100), 'len', beforeHalf.length);
    await fullCb.click();
    await expect.poll(() => {
      const cur = getArt();
      console.log('poll full', cur.slice(0,100), 'len', cur.length, 'eq', cur===beforeHalf);
      return cur !== beforeHalf;
    }, { timeout: 8000 }).toBe(true);
    const afterFull = getArt();
    console.log('afterFull', afterFull.slice(0,100), 'len', afterFull.length);
    expect(afterFull).not.toBe(beforeHalf);

    const triCb = page.getByTestId('block-triangle');
    await expect.element(triCb).toBeInTheDocument();
    const beforeTri = getArt();
    await triCb.click();
    await expect.poll(() => getArt() !== beforeTri, { timeout: 8000 }).toBe(true);
    const afterTri = getArt();
    expect(afterTri).not.toBe(beforeTri);
    expect(afterTri).not.toBe(afterFull);
  }, 20000);

  it('braille toggle changes preview', async () => {
    const file = await makeTestFile();
    render(Img2IrcDialog, { file, filename: 'test.png', onClose: () => {} });
    await expect.element(page.getByTestId('art')).toBeInTheDocument({ timeout: 8000 });
    const getArt = () => (page.getByTestId('art').element() as HTMLElement).innerHTML;
    const halfRadio = page.getByRole('radio', { name: 'Half' });
    await halfRadio.click();
    await expect.element(halfRadio).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => getArt().length > 0, { timeout: 5000 }).toBe(true);
    const before = getArt();
    const braille = page.getByTestId('braille-toggle');
    await expect.element(braille).toBeInTheDocument();
    await braille.click();
    await expect.poll(() => getArt() !== before, { timeout: 8000 }).toBe(true);
    const after = getArt();
    expect(after).toMatch(/[\u2800-\u28FF]/);
    await braille.click();
    await expect.poll(() => getArt() !== after, { timeout: 8000 }).toBe(true);
  }, 20000);
});
