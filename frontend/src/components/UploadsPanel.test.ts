import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import UploadsPanel from './UploadsPanel.svelte';
import { fetchUploadsOffset } from '../stores/api';

vi.mock('/src/stores/api', () => ({
  fetchUploadsOffset: vi.fn(() => Promise.resolve({ entries: [{ id: '1', name: 'test.py', mimeType: 'text/x-python', size: 100, url: '/uploads/1.py', createdAt: Date.now() }], total: 1 })),
  deleteUpload: vi.fn(() => Promise.resolve()),
  editUpload: vi.fn(() => Promise.resolve({ status: 'ok' })),
}));
vi.mock('../stores/api', () => ({
  fetchUploadsOffset: vi.fn(() => Promise.resolve({ entries: [{ id: '1', name: 'test.py', mimeType: 'text/x-python', size: 100, url: '/uploads/1.py', createdAt: Date.now() }], total: 1 })),
  deleteUpload: vi.fn(() => Promise.resolve()),
  editUpload: vi.fn(() => Promise.resolve({ status: 'ok' })),
}));

describe('UploadsPanel edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchUploadsOffset).mockResolvedValue({ entries: [{ id: '1', name: 'test.py', mimeType: 'text/x-python', size: 100, url: '/uploads/1.py', createdAt: Date.now() }], total: 1 });
  });

  it('text files show text preview (not broken image)', async () => {
    // File uploads should show text files with a text preview, not a broken image
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('file content preview') } as Response));
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('test.py'));
    // Should have text preview, not image (may be loading or loaded)
    await vi.waitFor(() => expect(container.querySelector('pre.textFilePreview') || container.querySelector('.loadingPreview') || container.querySelector('.fileIcon')).toBeTruthy());
    expect(container.querySelector('img.filePreview')).toBeFalsy();
    // Eventually should show the text preview
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
    // Reopen should show original content, not changed
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
    vi.mocked(fetchUploadsOffset).mockResolvedValueOnce({ entries: [{ id: '2', name: 'photo.png', mimeType: 'image/png', size: 100, url: '/uploads/2.png', createdAt: Date.now() }], total: 1 });
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('photo.png'));
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('.editFullPage')).toBeTruthy());
    // Non-text files should not show CodeEditor, just the rename input
    expect(container.querySelector('.editFullPage .codeEditor')).toBeFalsy();
    expect(container.querySelector('#editNameInputFull')).toBeTruthy();
  });
});
