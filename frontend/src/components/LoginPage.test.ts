import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import LoginPage from './LoginPage.svelte';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
  sendJson: vi.fn(),
  setMaxEid: vi.fn(),
}));

// The in-SPA overlay never reloads the page, so it must push the same URL the
// server-side `POST /register` redirect uses — otherwise a signup completed
// through the overlay lands on the last buffer instead of the welcome page.
describe('LoginPage', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    history.replaceState(null, '', '/');
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/me')) {
        return new Response(JSON.stringify({ username: 'alice' }), { status: 200 });
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    history.replaceState(null, '', '/');
  });

  it('lands a completed signup on the welcome add-network route', async () => {
    const onAuthenticated = vi.fn();
    render(LoginPage, { props: { onAuthenticated } });
    await userEvent.click(page.getByRole('button', { name: /Create one/ }));
    await userEvent.fill(page.getByLabelText('Username'), 'alice');
    await userEvent.fill(page.getByLabelText('Email'), 'alice@x.test');
    await userEvent.fill(page.getByLabelText('Password'), 'Passw0rd!test');
    await userEvent.click(page.getByRole('button', { name: 'Create account' }));
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    expect(window.location.search).toBe('?/add-network=welcome');
  });
  it('leaves the route alone on sign-in', async () => {
    const onAuthenticated = vi.fn();
    render(LoginPage, { props: { onAuthenticated } });
    await userEvent.fill(page.getByLabelText('Username'), 'alice');
    await userEvent.fill(page.getByLabelText('Password'), 'Passw0rd!test');
    await userEvent.click(page.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    expect(window.location.search).toBe('');
  });
  it('shows the check-your-email state when register answers 202 verification_sent', async () => {
    const onAuthenticated = vi.fn();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/register')) {
        return new Response(JSON.stringify({ status: 'verification_sent', email: 'alice@x.test' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    render(LoginPage, { props: { onAuthenticated } });
    await userEvent.click(page.getByRole('button', { name: /Create one/ }));
    await userEvent.fill(page.getByLabelText('Username'), 'alice');
    await userEvent.fill(page.getByLabelText('Email'), 'alice@x.test');
    await userEvent.fill(page.getByLabelText('Password'), 'Passw0rd!test');
    await userEvent.click(page.getByRole('button', { name: 'Create account' }));
    await vi.waitFor(() => expect(page.getByRole('heading', { name: 'Check your email' })).toBeTruthy());
    await vi.waitFor(() => expect(document.body.textContent).toContain('alice@x.test'));
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });
  it('shows a Forgot password link in signin mode that opens the reset form', async () => {
    const onAuthenticated = vi.fn();
    render(LoginPage, { props: { onAuthenticated } });
    await userEvent.click(page.getByRole('button', { name: /Forgot password/ }));
    await vi.waitFor(() => expect(page.getByRole('heading', { name: 'Reset your password' })).toBeTruthy());
    expect(page.getByRole('button', { name: 'Send reset link' })).toBeTruthy();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
  it('posts /forgot and shows the check-email state on 202 reset_sent', async () => {
    const onAuthenticated = vi.fn();
    let postedUrl = '';
    let postedBody = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/forgot')) {
        postedUrl = url;
        postedBody = String(init?.body ?? '');
        return new Response(JSON.stringify({ status: 'reset_sent' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    render(LoginPage, { props: { onAuthenticated } });
    await userEvent.click(page.getByRole('button', { name: /Forgot password/ }));
    await userEvent.fill(page.getByLabelText('Email'), 'alice@x.test');
    await userEvent.click(page.getByRole('button', { name: 'Send reset link' }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('If an account exists for'));
    expect(postedUrl).toContain('/forgot');
    expect(postedBody).toContain('alice%40x.test');
    expect(document.body.textContent).toContain('alice@x.test');
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });
  it('renders forgot errors inline without leaving the form', async () => {
    const onAuthenticated = vi.fn();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/forgot')) {
        return new Response(JSON.stringify({ error: 'We already sent a reset link to that address.' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    render(LoginPage, { props: { onAuthenticated } });
    await userEvent.click(page.getByRole('button', { name: /Forgot password/ }));
    await userEvent.fill(page.getByLabelText('Email'), 'alice@x.test');
    await userEvent.click(page.getByRole('button', { name: 'Send reset link' }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('We already sent a reset link'));
    // Still on the form — the user can correct and retry.
    expect(page.getByRole('button', { name: 'Send reset link' })).toBeTruthy();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
  it('renders one Continue-with anchor per configured provider with exact hrefs', async () => {
    const onAuthenticated = vi.fn();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/providers')) {
        return new Response(
          JSON.stringify({ providers: [{ name: 'github', label: 'GitHub' }, { name: 'google', label: 'Google' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    render(LoginPage, { props: { onAuthenticated } });
    await vi.waitFor(() => expect(document.querySelector('a[data-provider="github"]')).toBeTruthy());
    await vi.waitFor(() => expect(document.querySelector('a[data-provider="google"]')).toBeTruthy());
    const github = document.querySelector('a[data-provider="github"]');
    const google = document.querySelector('a[data-provider="google"]');
    expect(github?.getAttribute('href')).toBe('/auth/github');
    expect(google?.getAttribute('href')).toBe('/auth/google');
    // The chips are icon-only, so the accessible name carries the label.
    expect(github?.getAttribute('aria-label')).toBe('Continue with GitHub');
    expect(google?.getAttribute('aria-label')).toBe('Continue with Google');
    // Nothing falls outside github/google, so no picker toggle is rendered.
    expect(document.querySelector('button[aria-haspopup="menu"]')).toBeNull();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
  it('puts non-brand providers behind one picker popup', async () => {
    const onAuthenticated = vi.fn();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/providers')) {
        // Exactly what production serves: alphabetical by name.
        return new Response(
          JSON.stringify({
            providers: [
              { name: 'codeberg', label: 'Codeberg' },
              { name: 'github', label: 'GitHub' },
              { name: 'gitlab', label: 'GitLab' },
              { name: 'google', label: 'Google' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    render(LoginPage, { props: { onAuthenticated } });
    await vi.waitFor(() => expect(document.querySelector('button[aria-haspopup="menu"]')).toBeTruthy());
    // The row itself only ever holds the brand chips: github + google.
    expect(document.querySelectorAll('.noauth-oauth__row > a[data-provider]').length).toBe(2);
    const toggle = document.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const menu = document.querySelector('#noauth-oauth-more') as HTMLElement;
    await expect.element(menu).not.toBeVisible();

    await userEvent.click(toggle);
    await vi.waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
    await expect.element(menu).toBeVisible();
    const items = [...menu.querySelectorAll('a[role="menuitem"]')];
    expect(items.map((a) => a.getAttribute('data-provider'))).toEqual(['codeberg', 'gitlab']);
    expect(items.map((a) => a.getAttribute('href'))).toEqual(['/auth/codeberg', '/auth/gitlab']);

    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
    await expect.element(menu).not.toBeVisible();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
  it('shows no provider buttons when none are configured', async () => {
    const onAuthenticated = vi.fn();
    let providersHit = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/providers')) {
        providersHit = true;
        return new Response(JSON.stringify({ providers: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    render(LoginPage, { props: { onAuthenticated } });
    // Wait for the providers fetch to resolve before asserting absence —
    // otherwise the check could pass before the section had a chance to render.
    await vi.waitFor(() => expect(providersHit).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector('[data-provider]')).toBeNull();
  });
});
