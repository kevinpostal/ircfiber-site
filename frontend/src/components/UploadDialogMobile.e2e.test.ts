import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { flushSync } from 'svelte';
import UploadDialog from './UploadDialog.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { uploadState, trackUpload } from '../stores/uploadStore.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import { setViewport, restoreViewport, DESKTOP_VIEWPORT } from '../test/mobileViewport';
// Global styles are loaded by main.ts in the app, which tests bypass by
// rendering components directly; the dialog geometry lives in the theme.
import '../app.css';
import '../styles/main.scss';

/** iPhone with the on-screen keyboard up: iOS shrinks the viewport to
 *  roughly this. The user picked a photo from the composer, so the
 *  keyboard is usually still open when the confirm dialog appears. */
const PHONE_KEYBOARD_UP = { width: 390, height: 500 };

function openDialog(): void {
  const net = createNetwork({ networkId: 'n1' });
  net.buffers.push(createBuffer({ name: '#photos' }));
  ircState.networks.push(net);
  ircState.activeBuffer.networkId = 'n1';
  ircState.activeBuffer.bufferName = '#photos';
  const file = new File([new Uint8Array(70)], 'IMG_0001.jpg', { type: 'image/jpeg' });
  const u = trackUpload('IMG_0001.jpg', 70, file);
  uploadState.dialog = { mode: 'single', uploads: [u], message: '' };
}

describe('upload confirm dialog on a phone', () => {
  beforeEach(() => {
    ircState.networks.length = 0;
    uploadState.dialog = null;
    uploadState.active.length = 0;
  });

  afterAll(async () => {
    await restoreViewport();
  });

  it('keeps Upload and Cancel fully on screen with the keyboard up, at thumb size', async () => {
    await setViewport(PHONE_KEYBOARD_UP.width, PHONE_KEYBOARD_UP.height);
    openDialog();
    render(UploadDialog);
    flushSync();

    const dialog = page.getByRole('heading', { name: /Upload a file to #photos/ }).element().closest('#fileUploadContainer') as HTMLElement;
    expect(dialog).toBeTruthy();
    const dr = dialog.getBoundingClientRect();
    expect(dr.bottom, `dialog bottom ${dr.bottom} exceeds viewport ${window.innerHeight}`).toBeLessThanOrEqual(window.innerHeight);

    for (const name of ['Upload', 'Cancel']) {
      const btn = page.getByRole('button', { name, exact: true }).element() as HTMLElement;
      const r = btn.getBoundingClientRect();
      // Fully inside the viewport AND inside the dialog's visible box — a
      // button clipped by the dialog's own overflow is not tappable.
      expect(r.top, `${name} top ${r.top}`).toBeGreaterThanOrEqual(dr.top);
      expect(r.bottom, `${name} bottom ${r.bottom} vs dialog ${dr.bottom}`).toBeLessThanOrEqual(dr.bottom + 0.5);
      expect(r.bottom, `${name} bottom ${r.bottom} vs viewport ${window.innerHeight}`).toBeLessThanOrEqual(window.innerHeight);
      expect(r.height, `${name} height ${r.height}`).toBeGreaterThanOrEqual(44);
      // The element the browser would actually deliver the tap to.
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      expect(btn.contains(hit), `${name} is covered by ${hit?.tagName}.${(hit as HTMLElement)?.className}`).toBe(true);
    }

    // Drag-and-drop advice is meaningless on a touch screen.
    const hint = dialog.querySelector('.uploadConfirmExtra') as HTMLElement | null;
    if (hint) expect(getComputedStyle(hint).display).toBe('none');

    await setViewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
  }, 15000);
});
