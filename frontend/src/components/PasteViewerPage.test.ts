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
  it('renders full-page viewer with twilight theme and ace editor', async () => {
    const { container } = render(PasteViewerPage, { props: { id: '8df764c9-3f89-4cd7-bd22-26b48a1dc6cc' } });
    await new Promise(r => setTimeout(r, 300));
    let tries = 0;
    while (!container.querySelector('#pasteViewerPage') && tries < 20) {
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }
    expect(container.querySelector('#pasteViewerPage')).toBeTruthy();
    // irccloud parity: theme-midnight / twilight, not dawn branding
    expect(container.querySelector('#pasteViewerPage')?.classList.contains('theme-midnight')).toBe(true);
    const page = container.querySelector('#pasteViewerPage') as HTMLElement;
    expect(page).toBeTruthy();
    if (page) expect(getComputedStyle(page).position).toBe('fixed');
    const editor = container.querySelector('.editor') as HTMLElement;
    expect(editor).toBeTruthy();
    expect(editor.classList.contains('ace-twilight')).toBe(true);
    expect(editor.classList.contains('ace_dark')).toBe(true);
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
    expect(editor?.style.height).toBe('44px');
  });

  it('paste viewer scrolls vertically for long content (500 lines)', async () => {
    const longBody = Array.from({ length: 500 }, (_, i) => `Line ${String(i + 1).padStart(3, '0')} Lorem ipsum dolor sit amet consectetur`).join('\n');
    const longPaste = { ...mockPaste, lines: 500, body: longBody, content: longBody };
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/api/pastebins/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(longPaste),
          text: () => Promise.resolve(longPaste.body),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') } as Response);
    }));
    const { container } = render(PasteViewerPage, { props: { id: 'long-500' } });
    await new Promise(r => setTimeout(r, 500));
    let tries = 0;
    while (!container.querySelector('#pasteViewerPage') && tries < 20) {
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }
    const outer = container.querySelector('#pasteViewerPage') as HTMLElement;
    expect(outer).toBeTruthy();
    // must be scrollable: overflow auto, not hidden
    const cs = getComputedStyle(outer);
    expect(cs.overflow).toBe('auto');
    expect(cs.overflowY).toBe('auto');
    // content taller than viewport -> scrollHeight > clientHeight
    expect(outer.scrollHeight).toBeGreaterThan(outer.clientHeight);
    expect(outer.scrollHeight).toBeGreaterThan(4000);
    // programmatic scroll works
    outer.scrollTop = 1000;
    expect(outer.scrollTop).toBe(1000);
    // wheel should also scroll (simulate)
    outer.scrollTop = 0;
    outer.dispatchEvent(new WheelEvent('wheel', { deltaY: 500, bubbles: true }));
    // jsdom/browser will not auto-scroll on wheel, but overflow:auto must be present
    // verify that after setting scrollTop again it sticks
    outer.scrollTop = 500;
    expect(outer.scrollTop).toBe(500);
  });
});
