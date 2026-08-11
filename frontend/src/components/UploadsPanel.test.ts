import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import UploadsPanel from './UploadsPanel.svelte';

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
});
