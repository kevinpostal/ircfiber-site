import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import TextInline from './TextInline.svelte';
import * as api from '../stores/api';
import type { MeResponse, PasteEntry } from '../stores/api';

// Spy-mode mock: the whole real `stores/api` module stays intact (the shared
// client setup file imports ircStore, which needs every export) and only the
// two calls TextInline makes get stubbed. TextInline calls fetchMe()
// statically and fetchPastebinById via dynamic import — same module registry,
// so both see the spies.
vi.mock('../stores/api', { spy: true });

const ME: MeResponse = { id: 'user-1', username: 'me', email: 'me@example.com' };

const PASTE: PasteEntry = {
  id: 'test-id',
  // must equal fetchMe().id: that is what makes the paste "owned" and
  // renders the inline "edit" button.
  userId: 'user-1',
  name: 'hello.txt',
  syntax: 'text',
  body: 'single line',
  lines: 1,
  createdAt: Date.now(),
  buffer: '#test',
  networkId: 'net1',
};

beforeEach(() => {
  vi.mocked(api.fetchMe).mockResolvedValue(ME);
  vi.mocked(api.fetchPastebinById).mockResolvedValue(PASTE);
  vi.mocked(api.updatePastebin).mockResolvedValue(PASTE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TextInline pastebin inline', () => {
  it('renders 1-line pastebin without clipping', async () => {
    const { container } = render(TextInline, { props: { url: 'https://ircfiber.com/?/pastebin=test-id' } });
    await vi.waitFor(() => expect(container.querySelector('.editor')).not.toBeNull());
    const editor = container.querySelector('.editor') as HTMLElement;
    // Should have min-height 44px, not 16px
    expect(editor.style.height).not.toBe('16px');
    expect(parseInt(editor.style.height) || 0).toBeGreaterThanOrEqual(44);
  });

  it('shows detected language badge and updates on filename change', async () => {
    const { container } = render(TextInline, { props: { url: 'https://ircfiber.com/?/pastebin=test-id' } });
    // The inline "edit" affordance only appears once fetchMe()/the paste
    // record agree on ownership.
    await vi.waitFor(() => expect(container.querySelector('.editButton')).not.toBeNull());
    (container.querySelector('.editButton') as HTMLElement).click();
    await vi.waitFor(() => expect(container.querySelector('#inline-edit-name')).not.toBeNull());
    const input = container.querySelector('#inline-edit-name') as HTMLInputElement;
    const badge = container.querySelector('.detectedLang') as HTMLElement;
    expect(badge).not.toBeNull();
    const before = badge.textContent;
    // Change filename to .py and check badge updates
    input.value = 'test.py';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(badge.textContent).not.toBe(before));
    // Should now show Python
    expect(badge.textContent?.toLowerCase()).toContain('python');
  });
});
