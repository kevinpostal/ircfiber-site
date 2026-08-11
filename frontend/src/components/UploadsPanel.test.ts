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
    // reset to default text file entry after clear
    vi.mocked(fetchUploadsOffset).mockResolvedValue({ entries: [{ id: '1', name: 'test.py', mimeType: 'text/x-python', size: 100, url: '/uploads/1.py', createdAt: Date.now() }], total: 1 });
  });

  it('clicking edit on text file shows code editor', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('file content here test') } as Response));
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => {
      const txt = container.querySelector('.file .name')?.textContent ?? '';
      expect(txt).toContain('test.py');
    });
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('.codeEditor')).toBeTruthy());
    await vi.waitFor(() => {
      const ta = (container.querySelector('.codeEditor textarea') as HTMLTextAreaElement | null) ?? (container.querySelector('textarea') as HTMLTextAreaElement | null);
      expect(ta?.value ?? '').toContain('test');
    });
  });

  it('cancel edit discards changes', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('file content here test') } as Response));
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('test.py'));
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('.codeEditor')).toBeTruthy());
    // Change content
    const ta = container.querySelector('.codeEditor textarea') as HTMLTextAreaElement;
    ta.value = 'changed';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await (container.querySelector('button.cancel') as HTMLButtonElement)?.click();
    // Should close editor
    await vi.waitFor(() => expect(container.querySelector('.codeEditor')).toBeFalsy());
    // Reopen should show original content, not changed
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('.codeEditor')).toBeTruthy());
    await vi.waitFor(() => {
      const val = (container.querySelector('.codeEditor textarea') as HTMLTextAreaElement).value;
      expect(val).not.toContain('changed');
      expect(val).toContain('file content');
    });
  });

  it('save with empty filename shows error', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('file content here test') } as Response));
    const { container } = render(UploadsPanel, { props: { onClose: () => {} } });
    await vi.waitFor(() => expect(container.querySelector('.file .name')?.textContent).toContain('test.py'));
    await (container.querySelector('button.edit') as HTMLButtonElement)?.click();
    await vi.waitFor(() => expect(container.querySelector('.codeEditor')).toBeTruthy());
    const input = container.querySelector('input[name="name"]') as HTMLInputElement;
    // Use Svelte-friendly way: set value and dispatch input
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
