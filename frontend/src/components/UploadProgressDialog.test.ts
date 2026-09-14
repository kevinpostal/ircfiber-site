import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import UploadProgressDialog from './UploadProgressDialog.svelte';
import { uploadState, trackUpload, setConverting, finishUpload, failUpload } from '../stores/uploadStore.svelte';

beforeEach(() => { uploadState.active = []; uploadState.dialog = null; uploadState.progressDialog = null; });

describe('UploadProgressDialog', () => {
  it('palette phase shows Making a GIF heading, Analyzing colors, and an indeterminate bar', async () => {
    const u = trackUpload('clip.mp4', 1234);
    setConverting(u.id, { phase: 'palette', percent: 0, etaMs: 0, frame: 0, fps: 0, durationMs: 0 });
    uploadState.progressDialog = { ids: [u.id], convertToGif: true };
    const { container } = render(UploadProgressDialog);
    await expect.element(page.getByRole('heading', { name: 'Making a GIF' })).toBeVisible();
    await expect.element(page.getByText('Analyzing colors…')).toBeVisible();
    expect(container.querySelector('.progressBar.indeterminate')).toBeTruthy();
    await expect.element(page.getByRole('button', { name: 'Hide' })).toBeVisible();
  });

  it('encode phase shows percent progress and ETA suffix', async () => {
    const u = trackUpload('clip.mp4', 1234);
    setConverting(u.id, { phase: 'encode', percent: 57, etaMs: 12000, frame: 100, fps: 25, durationMs: 30000 });
    uploadState.progressDialog = { ids: [u.id], convertToGif: true };
    const { container } = render(UploadProgressDialog);
    await expect.element(page.getByText('Encoding GIF… 57%')).toBeVisible();
    await expect.element(page.getByText('~12s left')).toBeVisible();
    const fill = container.querySelector('.progressFill') as HTMLElement | null;
    expect(fill?.style.width).toBe('57%');
  });

  it('errored row shows its message inline, notes the fallback, offers Close, and never auto-dismisses', async () => {
    const u = trackUpload('clip.mp4', 1234);
    failUpload(u.id, 'GIF conversion failed');
    uploadState.progressDialog = { ids: [u.id], convertToGif: true };
    render(UploadProgressDialog);
    await expect.element(page.getByText('GIF conversion failed')).toBeVisible();
    await expect.element(page.getByText('Posted the original file instead.')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Close' })).toBeVisible();
    // Integration check against the real platform clock: proving "no
    // auto-dismiss" means outliving the 1200 ms dismiss deadline, which
    // fake timers cannot observe without driving the browser renderer too.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 2100);
    await promise;
    await expect.element(page.getByText('GIF conversion failed')).toBeVisible();
    expect(uploadState.progressDialog).not.toBeNull();
    expect(uploadState.active.length).toBe(1);
  }, 10000);

  it('a clean all-done batch auto-dismisses and removes its rows', async () => {
    const a = trackUpload('a.png', 100);
    const b = trackUpload('b.png', 100);
    finishUpload(a.id, { id: 'u1', url: 'https://u/a.png', pageUrl: 'p', name: 'a.png', size: 100 });
    finishUpload(b.id, { id: 'u2', url: 'https://u/b.png', pageUrl: 'p', name: 'b.png', size: 100 });
    uploadState.progressDialog = { ids: [a.id, b.id], convertToGif: false };
    render(UploadProgressDialog);
    await expect.element(page.getByRole('heading', { name: 'Uploading files' })).toBeVisible();
    await vi.waitFor(() => {
      expect(uploadState.progressDialog).toBeNull();
    }, { timeout: 5000 });
    expect(uploadState.active.length).toBe(0);
  });
});
