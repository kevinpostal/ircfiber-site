import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PasteViewerPage from './PasteViewerPage.svelte';

const mockPaste = {
  id: '8df764c9-3f89-4cd7-bd22-26b48a1dc6cc',
  name: 'test.txt',
  syntax: 'text',
  lines: 1,
  body: 'hello world',
  content: 'hello world',
  createdAt: Date.now(),
  buffer: '#test',
  networkId: 'net1',
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (typeof url === 'string' && url.includes('/api/pastebins/')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockPaste),
        text: () => Promise.resolve(mockPaste.body),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') } as Response);
  }));
});

describe('PasteViewerPage', () => {
  it('renders full-page viewer with branding and public access', async () => {
    const { container } = render(PasteViewerPage, { props: { id: '8df764c9-3f89-4cd7-bd22-26b48a1dc6cc' } });
    await new Promise(r => setTimeout(r, 300));
    let tries = 0;
    while (!container.querySelector('#pasteViewerPage') && tries < 20) {
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }
    expect(container.querySelector('#pasteViewerPage')).toBeTruthy();
    expect(container.querySelector('.branding')).toBeTruthy();
    expect(container.querySelector('.branding .brand')?.textContent).toContain('IRC Fiber');
    const page = container.querySelector('#pasteViewerPage') as HTMLElement;
    expect(page).toBeTruthy();
    if (page) expect(getComputedStyle(page).position).toBe('fixed');
    const editor = container.querySelector('.editor') as HTMLElement;
    expect(editor).toBeTruthy();
    expect(getComputedStyle(editor).display).toBe('flex');
  });

  it('shows 1-line snippet without clipping', async () => {
    const { container } = render(PasteViewerPage, { props: { id: '8df764c9-3f89-4cd7-bd22-26b48a1dc6cc' } });
    await new Promise(r => setTimeout(r, 300));
    let tries = 0;
    while (!container.querySelector('.editor') && tries < 20) {
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }
    const editor = container.querySelector('.editor') as HTMLElement;
    expect(editor).toBeTruthy();
    expect(editor?.style.height).not.toBe('16px');
  });
});
