import { describe, it, expect, beforeEach, vi } from 'vitest';
import { uploadState } from './uploadStore.svelte';
import { ircState } from './ircStore.svelte';
import { startUploads, confirmDialog, cancelDialog, setDeps } from './uploadFlow.svelte';

function makeFile(name: string, type = 'image/png', size = 100): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('uploadFlow', () => {
  let sent: { networkId: string; target: string; text: string }[];
  let resolveUpload: (v: unknown) => void;

  beforeEach(() => {
    uploadState.active = [];
    uploadState.dialog = null;
    ircState.activeBuffer.networkId = 'n';
    ircState.activeBuffer.bufferName = '#c';
    sent = [];
    setDeps({
      uploader: () => ({
        promise: new Promise((res) => { resolveUpload = res; }),
        abort: vi.fn(),
      }),
      send: (networkId, target, text) => sent.push({ networkId, target, text }),
      getInputText: () => 'check this out',
      clearInput: vi.fn(),
      notifyError: vi.fn(),
    });
  });

  it('rejects non-image files without starting an upload', () => {
    startUploads([makeFile('a.mp4', 'video/mp4')], { networkId: 'n', buffer: '#c' });
    expect(uploadState.active.length).toBe(0);
    expect(uploadState.dialog).toBeNull();
  });

  it('opens the dialog prefilled with the input text and uploads in the background', () => {
    startUploads([makeFile('a.png')], { networkId: 'n', buffer: '#c' });
    expect(uploadState.active.length).toBe(1);
    expect(uploadState.dialog?.mode).toBe('single');
    expect(uploadState.dialog?.message).toBe('check this out');
  });

  it('sends "message url" after confirm once the upload finishes', async () => {
    startUploads([makeFile('a.png')], { networkId: 'n', buffer: '#c' });
    confirmDialog({ filename: 'a.png', message: 'look' });
    resolveUpload({ id: 'u1', url: 'https://i.postimg.cc/a.png', pageUrl: 'p', name: 'a.png', size: 100 });
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].text).toBe('look https://i.postimg.cc/a.png');
    expect(sent[0].target).toBe('#c');
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
