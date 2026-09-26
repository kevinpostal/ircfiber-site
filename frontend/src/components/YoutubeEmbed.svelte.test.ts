import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { flushSync } from 'svelte';
import YoutubeEmbed from './YoutubeEmbed.svelte';
import { mediaDock, closeDock, dockVideo, reportDockPosition } from '../stores/mediaDock.svelte';
import { ircState } from '../stores/ircStore.svelte';
// .directEmbedWrap's position: relative (the controls' containing block) lives here.
import '../styles/components/_embeds.scss';

const ID = 'sHuu-kKD0Lc';

/** Simulate an infoDelivery message from the embed's window. */
function fakeInfo(iframe: HTMLIFrameElement, info: Record<string, number>): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ event: 'infoDelivery', info }),
      origin: 'https://www.youtube.com',
      source: iframe.contentWindow,
    }),
  );
}

function renderEmbed() {
  const r = render(YoutubeEmbed, { props: { id: ID } });
  const iframe = document.querySelector('iframe');
  if (!iframe) throw new Error('iframe did not render');
  return { ...r, iframe };
}

describe('YoutubeEmbed mini-player handoff', () => {
  beforeEach(() => {
    closeDock();
  });

  it('docks a playing video on unmount, at the floored reported position', () => {
    const { iframe, unmount } = renderEmbed();
    fakeInfo(iframe, { currentTime: 42.7, playerState: 1 });
    unmount();
    expect(mediaDock.video).toEqual({ videoId: ID, startSeconds: 42, positionSeconds: 42, origin: null });
  });

  it('does not dock a paused video', () => {
    const { iframe, unmount } = renderEmbed();
    fakeInfo(iframe, { currentTime: 42.7, playerState: 2 });
    unmount();
    expect(mediaDock.video).toBeNull();
  });

  it('shows placeholder while docked and "Bring back here" resumes inline', async () => {
    dockVideo({ videoId: ID, startSeconds: 10, origin: null });
    reportDockPosition(33.4);
    render(YoutubeEmbed, { props: { id: ID } });
    expect(document.querySelector('iframe')).toBeNull();
    const btn = page.getByRole('button', { name: 'Bring back here' });
    await expect.element(btn).toBeInTheDocument();
    await btn.click();
    flushSync();
    expect(mediaDock.video).toBeNull();
    const src = document.querySelector('iframe')?.src ?? '';
    expect(src).toContain('start=33');
    expect(src).toContain('autoplay=1');
  });

  it('Pop out docks at floored currentTime even when paused', async () => {
    const { iframe, unmount } = renderEmbed();
    fakeInfo(iframe, { currentTime: 12.6, playerState: 2 });
    await page.getByRole('button', { name: 'Pop out video' }).click();
    flushSync();
    expect(mediaDock.video).toEqual({ videoId: ID, startSeconds: 12, positionSeconds: 12, origin: null });
    await expect.element(page.getByRole('button', { name: 'Bring back here' })).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
    // Unmounting a row that is already docked must not dock it again. A
    // re-dock would reset positionSeconds back to startSeconds, so bump it
    // first and check it survives.
    reportDockPosition(20);
    unmount();
    expect(mediaDock.video).toEqual({ videoId: ID, startSeconds: 12, positionSeconds: 20, origin: null });
  });

  it('Pop out with no info yet docks at 0', async () => {
    renderEmbed();
    await page.getByRole('button', { name: 'Pop out video' }).click();
    flushSync();
    expect(mediaDock.video).toEqual({ videoId: ID, startSeconds: 0, positionSeconds: 0, origin: null });
  });

  it('Pop out records the buffer it came from', async () => {
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    renderEmbed();
    await page.getByRole('button', { name: 'Pop out video' }).click();
    flushSync();
    expect(mediaDock.video?.origin).toEqual({ networkId: 'net1', bufferName: '#chan' });
  });

  it('Minimize docks the video straight into the taskbar (minimized) at its position', async () => {
    const { iframe } = renderEmbed();
    fakeInfo(iframe, { currentTime: 7.9, playerState: 1 });
    await page.getByRole('button', { name: 'Minimize video' }).click();
    flushSync();
    expect(mediaDock.video).toEqual({ videoId: ID, startSeconds: 7, positionSeconds: 7, origin: null });
    expect(mediaDock.minimized).toBe(true);
    await expect.element(page.getByRole('button', { name: 'Bring back here' })).toBeInTheDocument();
  });

  it('window controls sit together at the top-right in minimize · pop out · close order', () => {
    const { iframe } = renderEmbed();
    const group = document.querySelector<HTMLElement>('.embedControls');
    if (!group) throw new Error('controls did not render');
    expect([...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'Minimize video',
      'Pop out video',
      'Close video',
    ]);
    const g = group.getBoundingClientRect();
    const f = iframe.getBoundingClientRect();
    expect(f.right - g.right).toBeGreaterThanOrEqual(0);
    expect(f.right - g.right).toBeLessThanOrEqual(12);
    expect(g.top - f.top).toBeGreaterThanOrEqual(0);
    expect(g.top - f.top).toBeLessThanOrEqual(12);
  });

  it('Close hides the embed without touching the dock', async () => {
    renderEmbed();
    await page.getByRole('button', { name: 'Close video' }).click();
    flushSync();
    expect(document.querySelector('.directEmbedWrap')).toBeNull();
    expect(mediaDock.video).toBeNull();
  });
});
