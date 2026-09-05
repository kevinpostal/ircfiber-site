import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import UploadsPanel from './UploadsPanel.svelte';
import { fetchUploadsOffset } from '../stores/api';

vi.mock('/src/stores/api', () => ({
  normalizeMessage: vi.fn((m) => m),
  fetchMe: vi.fn(async () => ({ username: 'test' })),
  pinChannel: vi.fn(async () => {}),
  unpinChannel: vi.fn(async () => {}),
  archiveChannel: vi.fn(async () => {}),
  unarchiveChannel: vi.fn(async () => {}),
  updateCollapsed: vi.fn(async () => {}),
  updateInactiveCollapsed: vi.fn(async () => {}),
  updateNetworkOrder: vi.fn(async () => {}),
  updateMembersCollapsed: vi.fn(async () => {}),
  updateBufferPrefs: vi.fn(async () => {}),
  fetchHealth: vi.fn(async () => ({ status: 'ok' })),
  loadHistoryWithMeta: vi.fn(async () => ({ messages: [], hasMore: false })),
  loadHistory: vi.fn(async () => []),
  reconnectNetwork: vi.fn(async () => {}),
  clearBacklog: vi.fn(async () => {}),
  disconnectNetwork: vi.fn(async () => {}),
  joinChannel: vi.fn(async () => {}),
  addNetwork: vi.fn(async () => {}),
  updateNetwork: vi.fn(async () => {}),
  deleteNetwork: vi.fn(async () => {}),
  fetchUploadsOffset: vi.fn(() => Promise.resolve({ entries: [{ id: '1', name: 'test.py', mimeType: 'text/x-python', size: 100, url: '/uploads/1.py', createdAt: Date.now() }], total: 1 })),
  fetchUploads: vi.fn(async () => []),
  deleteUpload: vi.fn(async () => {}),
  editUpload: vi.fn(async () => ({ status: 'ok' })),
  convertUploadToGif: vi.fn(async () => ({})),
  fetchPastebinsOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  createPastebin: vi.fn(async () => ({})),
  updatePastebin: vi.fn(async () => ({})),
  deletePastebin: vi.fn(async () => {}),
  pastebinRawUrl: vi.fn((id) => `/pastebin/\${id}/raw`),
  fetchMe: vi.fn(async () => ({ username: 'test' })),
}));
vi.mock('../stores/api', () => ({
  normalizeMessage: vi.fn((m) => m),
  fetchMe: vi.fn(async () => ({ username: 'test' })),
  pinChannel: vi.fn(async () => {}),
  unpinChannel: vi.fn(async () => {}),
  archiveChannel: vi.fn(async () => {}),
  unarchiveChannel: vi.fn(async () => {}),
  updateCollapsed: vi.fn(async () => {}),
  updateInactiveCollapsed: vi.fn(async () => {}),
  updateNetworkOrder: vi.fn(async () => {}),
  updateMembersCollapsed: vi.fn(async () => {}),
  updateBufferPrefs: vi.fn(async () => {}),
  fetchHealth: vi.fn(async () => ({ status: 'ok' })),
  loadHistoryWithMeta: vi.fn(async () => ({ messages: [], hasMore: false })),
  loadHistory: vi.fn(async () => []),
  reconnectNetwork: vi.fn(async () => {}),
  clearBacklog: vi.fn(async () => {}),
  disconnectNetwork: vi.fn(async () => {}),
  joinChannel: vi.fn(async () => {}),
  addNetwork: vi.fn(async () => {}),
  updateNetwork: vi.fn(async () => {}),
  deleteNetwork: vi.fn(async () => {}),
  fetchUploadsOffset: vi.fn(() => Promise.resolve({ entries: [{ id: '1', name: 'test.py', mimeType: 'text/x-python', size: 100, url: '/uploads/1.py', createdAt: Date.now() }], total: 1 })),
  fetchUploads: vi.fn(async () => []),
  deleteUpload: vi.fn(async () => {}),
  editUpload: vi.fn(async () => ({ status: 'ok' })),
  convertUploadToGif: vi.fn(async () => ({})),
  fetchPastebinsOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  createPastebin: vi.fn(async () => ({})),
  updatePastebin: vi.fn(async () => ({})),
  deletePastebin: vi.fn(async () => {}),
  pastebinRawUrl: vi.fn((id) => `/pastebin/\${id}/raw`),
}));

describe('UploadsPanel edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchUploadsOffset).mockResolvedValue({ entries: [{ id: '1', name: 'test.py', mimeType: 'text/x-python', size: 100, url: '/uploads/1.py', createdAt: Date.now() }], total: 1 } as any);
  });

  it('text files show text preview (not broken image)', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('file content preview') } as Response));
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('test.py'));
    await vi.waitFor(() => expect(container.querySelector('pre.textFilePreview') || container.querySelector('.loadingPreview') || container.querySelector('.fileIcon')).toBeTruthy());
    expect(container.querySelector('img.filePreview')).toBeFalsy();
    await vi.waitFor(() => expect(container.querySelector('pre.textFilePreview')?.textContent).toContain('file content'));
  });

  it('clicking edit on text file shows full-page code editor', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('file content here test') } as Response));
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('test.py'));
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('.editFullPage')).toBeTruthy());
    await vi.waitFor(() => expect(container.querySelector('.codeEditor')).toBeTruthy());
    expect(container.querySelector('#filesList')).toBeFalsy();
  });

  it('cancel edit discards changes', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('file content here test') } as Response));
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('test.py'));
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('.editFullPage')).toBeTruthy());
    const ta = container.querySelector('.editFullPage .codeEditor textarea') as HTMLTextAreaElement;
    ta.value = 'changed';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await (container.querySelector('.editFullPage button.cancel') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('.editFullPage')).toBeFalsy());
    await vi.waitFor(() => expect(container.querySelector('#filesList')).toBeTruthy());
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('.editFullPage')).toBeTruthy());
    await vi.waitFor(() => {
      const val = (container.querySelector('.editFullPage .codeEditor textarea') as HTMLTextAreaElement).value;
      expect(val).not.toContain('changed');
      expect(val).toContain('file content');
    });
  });

  it('save with empty filename shows error', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('file content here test') } as Response));
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('test.py'));
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('.editFullPage')).toBeTruthy());
    const input = container.querySelector('#editNameInputFull') as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(input.value).toBe(''));
    await (container.querySelector('.editFullPage button[type="submit"]') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Filename required'));
  });

  it('non-text files show only rename, not editor', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('') } as Response));
    const { fetchUploadsOffset: f } = await import('../stores/api');
    vi.mocked(f).mockResolvedValueOnce({ entries: [{ id: '2', name: 'photo.png', mimeType: 'image/png', size: 100, url: '/uploads/2.png', createdAt: Date.now() }], total: 1 } as any);
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('photo.png'));
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('.editFullPage')).toBeTruthy());
    expect(container.querySelector('.editFullPage .codeEditor')).toBeFalsy();
    expect(container.querySelector('#editNameInputFull')).toBeTruthy();
  });

  it('video files show a gif convert action; text files do not', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('') } as Response));
    vi.mocked(fetchUploadsOffset).mockResolvedValueOnce({ entries: [{ id: '3', name: 'clip.mp4', mimeType: 'video/mp4', size: 5000, url: '/uploads/3.mp4', createdAt: Date.now(), buffer: '', networkId: '' }], total: 1 });
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('clip.mp4'));
    expect(container.querySelector('button.togif')).toBeTruthy();
    expect(container.querySelector('video.filePreview')).toBeTruthy();
    expect(container.querySelector('img.filePreview')).toBeFalsy();
  });

  it('text files render no gif action', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('file content') } as Response));
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('test.py'));
    expect(container.querySelector('button.togif')).toBeFalsy();
  });
});
