import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { flushSync } from 'svelte';
import YoutubeEmbed from './YoutubeEmbed.svelte';
import { mediaDock, dockVideo, reportDockPosition } from '../stores/mediaDock.svelte';

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
    mediaDock.video = null;
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
});
