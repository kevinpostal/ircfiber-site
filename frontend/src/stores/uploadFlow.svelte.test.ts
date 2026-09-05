import { describe, it, expect, beforeEach, vi } from 'vitest';
import { uploadState } from './uploadStore.svelte';
import { ircState } from './ircStore.svelte';
import { startUploads, confirmDialog, cancelDialog, setDeps } from './uploadFlow.svelte';
import type { UploadResponse } from '../lib/upload';

function makeFile(name: string, type = 'image/png', size = 100): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('uploadFlow', () => {
  let sent: { networkId: string; target: string; text: string }[];
  let resolveUpload: (v: UploadResponse) => void;

  beforeEach(() => {
    uploadState.active = [];
    uploadState.dialog = null;
    ircState.activeBuffer.networkId = 'n';
    ircState.activeBuffer.bufferName = '#c';
    sent = [];
    setDeps({
      uploader: () => ({
        promise: new Promise<UploadResponse>((res) => { resolveUpload = res; }),
        abort: () => {},
      }),
      send: (networkId, target, text) => sent.push({ networkId, target, text }),
      getInputText: () => 'check this out',
      clearInput: vi.fn(),
      notifyError: vi.fn(),
    });
  });

  // Uploads are universal since "fix(upload): universal 50MB" — any MIME is
  // accepted (isUploadableFile always true); only the 50 MB cap rejects.
  it('uploads a non-image file like any other binary', () => {
    startUploads([makeFile('a.mp4', 'video/mp4')], { networkId: 'n', buffer: '#c' });
    expect(uploadState.active.length).toBe(1);
    expect(uploadState.active[0].filename).toBe('a.mp4');
    expect(uploadState.dialog?.mode).toBe('single');
  });

  it('rejects a file over the 50 MB cap without starting an upload', () => {
    const notifyError = vi.fn();
    setDeps({ notifyError });
    const big = makeFile('big.bin', 'application/octet-stream', 8);
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    startUploads([big], { networkId: 'n', buffer: '#c' });
    expect(notifyError).toHaveBeenCalledWith('big.bin: File too large (max 50 MB)');
    expect(uploadState.active.length).toBe(0);
    expect(uploadState.dialog).toBeNull();
  });

  it('opens the dialog prefilled with the input text and uploads in the background', () => {
    startUploads([makeFile('a.png')], { networkId: 'n', buffer: '#c' });
    expect(uploadState.active.length).toBe(1);
    expect(uploadState.dialog?.mode).toBe('single');
    expect(uploadState.dialog?.message).toBe('check this out');
  });

  // IRCCloud parity (commit 4f8a655): confirming the dialog posts
  // "<message> <url>" straight to the originating buffer and clears the
  // composer — it no longer just prefills the input.
  it('auto-sends "message url" to the originating buffer after confirm', async () => {
    const setInputText = vi.fn();
    setDeps({ setInputText });

    startUploads([makeFile('a.png')], { networkId: 'n', buffer: '#c' });
    confirmDialog({ filename: 'a.png', message: 'look' });
    resolveUpload({ id: 'u1', url: 'https://i.postimg.cc/a.png', pageUrl: 'p', name: 'a.png', size: 100 });
    await vi.waitFor(() => {
      expect(sent).toEqual([{ networkId: 'n', target: '#c', text: 'look https://i.postimg.cc/a.png' }]);
    });
    expect(setInputText).toHaveBeenCalledWith('');
  });

  it('inserts "message url" into the input when there is no buffer context', async () => {
    const setInputText = vi.fn();
    setDeps({ setInputText });

    startUploads([makeFile('a.png')], { networkId: '', buffer: '' });
    confirmDialog({ filename: 'a.png', message: 'look' });
    resolveUpload({ id: 'u1', url: 'https://i.postimg.cc/a.png', pageUrl: 'p', name: 'a.png', size: 100 });
    await vi.waitFor(() => {
      expect(setInputText).toHaveBeenCalledWith('look https://i.postimg.cc/a.png');
    });
    expect(sent.length).toBe(0);
  });

  it('cancel aborts and clears state', () => {
    startUploads([makeFile('a.png')], { networkId: 'n', buffer: '#c' });
    cancelDialog();
    expect(uploadState.dialog).toBeNull();
    expect(uploadState.active.every(u => u.status === 'cancelled' || u.status === 'uploading')).toBe(true);
  });

  it('immediate mode (shift-drop) skips the dialog', async () => {
    startUploads([makeFile('a.png')], { networkId: 'n', buffer: '#c', immediate: true });
    expect(uploadState.dialog).toBeNull();
    resolveUpload({ id: 'u1', url: 'https://u', pageUrl: 'p', name: 'a.png', size: 100 });
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].text).toBe('https://u');
  });
});
