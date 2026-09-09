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
    expect(github?.textContent).toContain('Continue with GitHub');
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
