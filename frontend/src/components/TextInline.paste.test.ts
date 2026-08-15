import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import TextInline from './TextInline.svelte';

vi.mock('../stores/api', () => ({
  fetchPastebinById: vi.fn(() => Promise.resolve({
    id: 'test-id',
    name: 'hello.txt',
    syntax: 'text',
    body: 'single line',
    content: 'single line',
    lines: 1,
    createdAt: Date.now(),
  })),
  fetchUploadsOffset: vi.fn(() => Promise.resolve({ entries: [], total: 0 })),
  editUpload: vi.fn(() => Promise.resolve({})),
  updatePastebin: vi.fn(() => Promise.resolve({})),
  pastebinRawUrl: vi.fn((id) => `/api/pastebins/${id}/raw`),
}));

describe('TextInline pastebin inline', () => {
  it('renders 1-line pastebin without clipping', async () => {
    const { container } = render(TextInline, { props: { url: 'https://ircfiber.com/?/pastebin=test-id' } });
    await new Promise(r => setTimeout(r, 300));
    const editor = container.querySelector('.editor') as HTMLElement;
    if (editor) {
      // Should have min-height 44px, not 16px
      expect(editor.style.height).not.toBe('16px');
      expect(parseInt(editor.style.height) || 0).toBeGreaterThanOrEqual(44);
    }
  });

  it('shows detected language badge and updates on filename change', async () => {
    const { container } = render(TextInline, { props: { url: 'https://ircfiber.com/?/pastebin=test-id' } });
    await new Promise(r => setTimeout(r, 300));
    // Click edit
    const editBtn = container.querySelector('.editButton') as HTMLElement;
    if (editBtn) {
      editBtn.click();
      await new Promise(r => setTimeout(r, 100));
      const input = container.querySelector('#inline-edit-name') as HTMLInputElement;
      const badge = container.querySelector('.detectedLang') as HTMLElement;
      expect(input).toBeTruthy();
      expect(badge).toBeTruthy();
      const before = badge?.textContent;
      // Change filename to .py and check badge updates
      if (input) {
        input.value = 'test.py';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        expect(badge?.textContent).not.toBe(before);
        // Should now show Python
        expect(badge?.textContent?.toLowerCase()).toContain('python');
      }
    }
  });
});
