import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import LoginPage from './LoginPage.svelte';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
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
});
