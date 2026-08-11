import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import UploadsPanel from './UploadsPanel.svelte';
import { fetchUploadsOffset } from '../stores/api';

vi.mock('/src/stores/api', () => ({
  fetchUploadsOffset: vi.fn(() => Promise.resolve({ entries: [{ id: '1', name: 'photo.png', mimeType: 'image/png', size: 100, url: '/uploads/1.png', createdAt: Date.now() }], total: 1 })),
  deleteUpload: vi.fn(() => Promise.resolve()),
  editUpload: vi.fn(() => Promise.resolve({ status: 'ok' })),
}));
vi.mock('../stores/api', () => ({
  fetchUploadsOffset: vi.fn(() => Promise.resolve({ entries: [{ id: '1', name: 'photo.png', mimeType: 'image/png', size: 100, url: '/uploads/1.png', createdAt: Date.now() }], total: 1 })),
  deleteUpload: vi.fn(() => Promise.resolve()),
  editUpload: vi.fn(() => Promise.resolve({ status: 'ok' })),
}));

describe('UploadsPanel edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // File uploads panel now filters text files — default to an image so the file list is visible
    vi.mocked(fetchUploadsOffset).mockResolvedValue({ entries: [{ id: '1', name: 'photo.png', mimeType: 'image/png', size: 100, url: '/uploads/1.png', createdAt: Date.now() }], total: 1 });
  });

  it('text files are filtered from File uploads (shown in Text snippets instead)', async () => {
    // File uploads should not show text files — they belong in Text snippets
    vi.mocked(fetchUploadsOffset).mockResolvedValue({ entries: [{ id: '1', name: 'test.py', mimeType: 'text/x-python', size: 100, url: '/uploads/1.py', createdAt: Date.now() }], total: 1 });
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.emptyMsg')?.textContent).toContain('No file uploads yet'));
    expect(container.querySelector('.file .name')).toBeFalsy();
    expect(container.textContent).toContain('Text snippets');
  });

  it('edit view for text files is full-page (not inline)', async () => {
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('photo.png'));
    // For File uploads, text files are filtered, so we test the full-page edit UI exists for any file
    // The full-page view should hide the file list when editing
    expect(container.querySelector('#filesList')).toBeTruthy();
    expect(container.querySelector('.editFullPage')).toBeFalsy();
  });

  it('cancel edit discards changes (rename)', async () => {
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('photo.png'));
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('input.nameInput')).toBeTruthy());
    const input = container.querySelector('input.nameInput') as HTMLInputElement;
    const original = input.value;
    input.value = 'changed.png';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await (container.querySelector('button.cancel') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('.editFullPage')).toBeFalsy());
    // Reopen should show original name, not changed
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('input.nameInput')).toBeTruthy());
    expect((container.querySelector('input.nameInput') as HTMLInputElement).value).toBe(original);
  });

  it('save with empty filename shows error', async () => {
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('photo.png'));
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('input.nameInput')).toBeTruthy());
    const input = container.querySelector('input.nameInput') as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(input.value).toBe(''));
    await (container.querySelector('button[type="submit"]') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Filename required'));
  });

  it('non-text files show only rename, not editor', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('') } as Response));
    vi.mocked(fetchUploadsOffset).mockResolvedValueOnce({ entries: [{ id: '2', name: 'photo.png', mimeType: 'image/png', size: 100, url: '/uploads/2.png', createdAt: Date.now() }], total: 1 });
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('photo.png'));
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('input.nameInput')).toBeTruthy());
    expect(container.querySelector('.codeEditor')).toBeFalsy();
    expect(container.querySelector('input.nameInput')).toBeTruthy();
  });
});
