import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Img2IrcDialog from './Img2IrcDialog.svelte';

async function makeTestFile(): Promise<File> {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 32, 32);
  grad.addColorStop(0, '#ff0000');
  grad.addColorStop(0.5, '#00ff00');
  grad.addColorStop(1, '#0000ff');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = '#ffff00';
  ctx.fillRect(8, 8, 16, 16);
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob null'))), 'image/png');
  const blob = await promise;
  return new File([blob], 'test.png', { type: 'image/png' });
}

describe('Img2IrcDialog preview', () => {
  it('loads preview and not stuck on Converting…', async () => {
    const file = await makeTestFile();
    render(Img2IrcDialog, { file, filename: 'test.png', onClose: () => {}, onBack: () => {} });
    await expect.element(page.getByTestId('loading')).toBeInTheDocument();
    await expect.element(page.getByTestId('art')).toBeInTheDocument({ timeout: 5000 });
    await expect.element(page.getByTestId('loading')).not.toBeInTheDocument();
    await expect.element(page.getByTestId('budget')).toBeInTheDocument();
  }, 10000);

  it('switches colorMatching quickly via cache', async () => {
    const file = await makeTestFile();
    render(Img2IrcDialog, { file, filename: 'test.png', onClose: () => {}, onBack: () => {} });
    await expect.element(page.getByTestId('art')).toBeInTheDocument({ timeout: 5000 });
    const firstEl = page.getByTestId('art').element() as HTMLElement;
    const firstArt = firstEl.innerHTML;
    await page.getByRole('radio', { name: 'RGB' }).click();
    await expect.poll(async () => {
      const el = page.getByTestId('art').element() as HTMLElement;
      return el.innerHTML !== firstArt;
    }, { timeout: 5000 }).toBe(true);
    await page.getByRole('radio', { name: 'OKLab' }).click();
    await expect.poll(async () => {
      const el = page.getByTestId('art').element() as HTMLElement;
      return el.innerHTML === firstArt;
    }, { timeout: 5000 }).toBe(true);
  }, 10000);

  it('preview is centered and scrollable when tall', async () => {
    async function makeTallFile(): Promise<File> {
      const c = document.createElement('canvas');
      c.width = 60; c.height = 320;
      const ctx = c.getContext('2d')!;
      const grad = ctx.createLinearGradient(0,0,60,320);
      grad.addColorStop(0,'#ff0000'); grad.addColorStop(1,'#0000ff');
      ctx.fillStyle = grad; ctx.fillRect(0,0,60,320);
      const { promise, resolve, reject } = Promise.withResolvers<Blob>();
      c.toBlob(b=> b?resolve(b):reject(new Error('toBlob null')),'image/png');
      const blob = await promise;
      return new File([blob],'tall.png',{type:'image/png'});
    }
    const file = await makeTallFile();
    render(Img2IrcDialog, { file, filename: 'tall.png', onClose: () => {} });
    await expect.element(page.getByTestId('art')).toBeInTheDocument({ timeout: 8000 });
    const wrap = document.querySelector('.previewWrap') as HTMLElement;
    expect(wrap).not.toBeNull();
    // wait for layout
    await new Promise(r=>setTimeout(r, 200));
    // scrollable
    expect(wrap.scrollHeight).toBeGreaterThan(wrap.clientHeight);
    const before = wrap.scrollTop;
    wrap.scrollTop = 80;
    expect(wrap.scrollTop).toBe(80);
    wrap.scrollTop = before;
    // centered: artWrap should be centered when content fits width (flex safe center)
    const artWrap = document.querySelector('.artWrap') as HTMLElement;
    const art = document.querySelector('.art') as HTMLElement;
    expect(artWrap).not.toBeNull(); expect(art).not.toBeNull();
    // art should be horizontally centered inside wrap when wrap wider than art
    const wrapRect = wrap.getBoundingClientRect();
    const artRect = art.getBoundingClientRect();
    // art left should be noticeably inset from wrap left (centered, not flush)
    expect(artRect.left).toBeGreaterThan(wrapRect.left + 5);
    expect(artRect.left).toBeLessThan(wrapRect.left + 120);
  }, 15000);
});
