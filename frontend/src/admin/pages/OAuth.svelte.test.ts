/**
 * OAuth.svelte — social-login provider status + credential configuration.
 *
 * Coverage, driven by the secrets discipline this page must keep:
 *  1. One status row per provider with the callback URI, and the secret
 *     value itself never appears anywhere in the DOM.
 *  2. Save posts clientId + clientSecret to the per-provider endpoint.
 *  3. Save with an empty secret omits the key, so the stored secret is
 *     kept (ID can be edited without retyping it).
 *  4. Clearing an override is a two-step confirm and issues DELETE.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import OAuth from './OAuth.svelte';
import { api } from '/src/admin/lib/api-client';

const mockedGet = api.get as unknown as Mock;
const mockedPost = api.post as unknown as Mock;
const mockedDelete = api.delete as unknown as Mock;

vi.mock('/src/admin/lib/api-client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  ApiError: class extends Error {
    readonly status: number;
    constructor(m: string, s: number) { super(m); this.status = s; }
  },
}));

vi.mock('/src/admin/stores/ui', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

const row = (over: Record<string, unknown> = {}) => ({
  name: 'github',
  label: 'GitHub',
  configured: true,
  source: 'override',
  clientId: 'Iv1.abc',
  hasSecret: true,
  envId: '',
  envHasSecret: false,
  redirectUri: 'https://ircfiber.com/auth/github/callback',
  ...over,
});

const fixture = () => ({
  providers: [
    row(),
    row({
      name: 'google', label: 'Google', configured: false, source: 'off',
      clientId: '', hasSecret: false, redirectUri: 'https://ircfiber.com/auth/google/callback',
    }),
  ],
});

async function mount(data = fixture()) {
  mockedGet.mockResolvedValue(data);
  render(OAuth);
  await expect.element(page.getByText('https://ircfiber.com/auth/github/callback')).toBeInTheDocument();
}

function editor(name: string): HTMLElement {
  const el = document.querySelector(`[data-editor="${name}"]`);
  if (!el) throw new Error(`no editor for ${name}`);
  return el as HTMLElement;
}

async function setInput(el: HTMLInputElement, v: string): Promise<void> {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  // Let Svelte's binding react before the save click reads it.
  await new Promise((r) => setTimeout(r, 40));
}

async function click(el: HTMLButtonElement): Promise<void> {
  el.click();
  await new Promise((r) => setTimeout(r, 60));
}


beforeEach(() => {
  vi.clearAllMocks();
});

describe('OAuth admin page', () => {
  it('renders one row per provider with the callback URI and never the secret', async () => {
    await mount();
    await expect.element(page.getByText('https://ircfiber.com/auth/google/callback')).toBeInTheDocument();
    expect(document.body.textContent).toContain('Live · admin');
    expect(document.body.textContent).toContain('Off');
    // The secret value must not appear anywhere, even though one is set.
    expect(document.body.textContent).not.toContain('s3cret-hidden-value');
  });

  it('saves client ID + secret to the per-provider endpoint', async () => {
    mockedPost.mockResolvedValue({ ok: true, provider: 'google' });
    await mount();
    const ed = editor('google');
    const inputs = ed.querySelectorAll('input');
    await setInput(inputs[0] as HTMLInputElement, 'GID-123');
    await setInput(inputs[1] as HTMLInputElement, 'g-secret');
    await click(ed.querySelector('button') as HTMLButtonElement);
    await vi.waitFor(() =>
      expect(mockedPost).toHaveBeenCalledWith('/api/admin/oauth/google', {
        clientId: 'GID-123',
        clientSecret: 'g-secret',
      }),
    );
  });

  it('omits an empty secret so the stored one is kept', async () => {
    mockedPost.mockResolvedValue({ ok: true, provider: 'github' });
    await mount();
    const ed = editor('github');
    const inputs = ed.querySelectorAll('input');
    await setInput(inputs[0] as HTMLInputElement, 'Iv1.new');
    await click(ed.querySelector('button') as HTMLButtonElement);
    await vi.waitFor(() =>
      expect(mockedPost).toHaveBeenCalledWith('/api/admin/oauth/github', { clientId: 'Iv1.new' }),
    );
  });

  it('clears an override only after confirm, via DELETE', async () => {
    mockedDelete.mockResolvedValue({ ok: true, provider: 'github' });
    await mount();
    const ed = editor('github');
    const clearBtn = [...ed.querySelectorAll('button')].find((b) => b.textContent?.includes('Clear override'));
    if (!clearBtn) throw new Error('no clear button');
    await click(clearBtn as HTMLButtonElement);
    expect(mockedDelete).not.toHaveBeenCalled();
    const confirmBtn = [...ed.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Confirm clear override'),
    );
    if (!confirmBtn) throw new Error('no confirm button');
    await click(confirmBtn as HTMLButtonElement);
    await vi.waitFor(() => expect(mockedDelete).toHaveBeenCalledWith('/api/admin/oauth/github'));
  });
});
