<script lang="ts">
  import { onMount } from 'svelte';
  import { navigateAddNetwork } from '../lib/routing';
  /**
   *
   * Renders as a centered modal on top of a dimmed backdrop, with the
   * full Svelte SPA shell visible behind it. Mirrors IRCCloud's
   * `#noAuth` / `.noAuthOverlay.noAuthSignin` pattern — the SPA always
   * boots, and the overlay sits on top until the session is established.
   *
   * Three modes share the same component: `signin` (default), `register`,
   * and `forgot`. The form POSTs to /login, /register, or /forgot
   * respectively. On success the SPA reloads; on failure the response is
   * parsed and an inline error banner is shown (no full page reload). A
   * register that answers 202 `verification_sent` (email verification
   * required) switches the card to a "check your email" state instead of
   * signing in; a forgot that answers 202 `reset_sent` switches to a
   * reset check-email state. The emailed /reset?token= link itself is a
   * top-level diet flow (like /verify?token=) — no SPA reset-form route.
   * Props:
   *   onAuthenticated — invoked after a successful login or register so
   *                     the parent can flip its `isAuthenticated` flag
   *                     and dismiss the overlay.
   */
  interface Props {
    onAuthenticated: () => void;
  }
  let { onAuthenticated }: Props = $props();

  type Mode = 'signin' | 'register' | 'forgot';

  let mode: Mode = $state('signin');
  let username = $state('');
  let email = $state('');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);
  let usernameEl: HTMLInputElement | undefined = $state(undefined);
  // Set after POST /register answers 202 `verification_sent`: the card
  // switches to the "check your email" state instead of probing /api/me.
  let sentTo = $state('');
  // Set after POST /forgot answers 202 `reset_sent`: the card switches
  // to the reset check-email state (same success copy whether or not the
  // address belongs to an account — the endpoint is not an oracle).
  let resetDone = $state(false);
  // Social OAuth providers (GET /api/auth/providers). Empty on any failure
  // or when no provider is configured — the section stays hidden and the
  // card is password-only, exactly as today.
  interface OAuthProviderEntry { name: string; label: string; }
  let oauthProviders: OAuthProviderEntry[] = $state([]);

  async function loadOAuthProviders(): Promise<void> {
    try {
      const res = await fetch('/api/auth/providers', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.providers)) {
        oauthProviders = data.providers.filter(
          (p: unknown): p is OAuthProviderEntry =>
            typeof (p as OAuthProviderEntry)?.name === 'string' &&
            typeof (p as OAuthProviderEntry)?.label === 'string',
        );
      }
    } catch {
      // Unconfigured providers mean password-only — not an error state.
    }
  }

  onMount(() => {
    usernameEl?.focus();
    void loadOAuthProviders();
  });
  // Toggle modes and reset transient state so a failed submit on one
  // form doesn't carry an error into the other.
  function setMode(next: Mode): void {
    if (mode === next) return;
    mode = next;
    error = '';
    sentTo = '';
    resetDone = false;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    error = '';
    busy = true;

    const endpoint = mode === 'signin' ? '/login' : mode === 'register' ? '/register' : '/forgot';
    const body = new URLSearchParams();
    if (mode === 'forgot') {
      body.set('email', email);
    } else {
      body.set('username', username);
      body.set('password', password);
      if (mode === 'register') body.set('email', email);
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: body.toString(),
        credentials: 'same-origin',
        redirect: 'manual',
      });

      const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
      if (res.status === 202 && isJson) {
        const data = await res.json();
        if (data.status === 'verification_sent') { sentTo = data.email ?? email; return; }
        if (data.status === 'reset_sent') { resetDone = true; return; }
      }

      // Forgot mode never starts a session: any 2xx means the request
      // was accepted (202 reset_sent above; a diet-HTML 200 fallback
      // below). Skip the /api/me probe, which would only clear a live
      // session's state.
      if (mode === 'forgot') {
        if (res.ok) { resetDone = true; return; }
        // Else fall through to the 4xx handling below.
      }

      // 2xx and opaque-redirect (0) are both success — the server sets
      // the session cookie via Set-Cookie and either responds 200 (when
      // validation fails on the server side, re-rendering the page) or
      // 302-redirects to `/`.
      if (res.ok || res.type === 'opaqueredirect' || res.status === 0) {
        // Re-fetch /api/me to confirm the session is live, then notify
        // the parent. This avoids relying on the SPA having to fully
        // reload and re-mount on auth change.
        const probe = await fetch('/api/me', { credentials: 'same-origin' });
        if (probe.ok) {
          // Mirror registerPost's redirect: a fresh signup lands on the
          // welcome add-network page. The SPA never reloads here, so push
          // the URL ourselves before the parent reads the route.
          if (mode === 'register') navigateAddNetwork(true);
          onAuthenticated();
          return;
        }
        // If /api/me still 401s, the session didn't take — surface a
        // generic error and let the user retry.
        error = mode === 'signin'
          ? 'Sign-in did not complete. Please try again.'
          : 'Account created but sign-in failed. Please try signing in.';
        return;
      }

      // 4xx — JSON when the request asked for it (Accept:
      // application/json), otherwise the server re-rendered the diet page
      // with an inline error banner. Pull the error text out of the
      // rendered HTML so we can show the same message inline.
      const fallbackError = mode === 'forgot'
        ? 'We could not send a reset link. Please check the address and retry.'
        : mode === 'signin'
          ? 'Incorrect username or password. Please try again.'
          : 'We could not create your account. Please check the details and retry.';
      if (isJson) {
        try {
          error = (await res.json()).error ?? fallbackError;
        } catch {
          error = fallbackError;
        }
        return;
      }

      // 4xx — the server re-rendered the diet page with an inline
      // error banner. Pull the error text out of the rendered HTML
      // so we can show the same message inline.
      const html = await res.text();
      const m = html.match(/<div[^>]*class="[^"]*auth-error[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (m && m[1]) {
        error = stripHtml(m[1]).trim();
      } else {
        error = fallbackError;
      }
    } catch (e) {
      error = 'Network error — please check your connection and try again.';
    } finally {
      busy = false;
    }
  }

  function stripHtml(s: string): string {
    return s.replace(/<[^>]+>/g, '');
  }
</script>

<div class="noauth" role="dialog" aria-modal="true" aria-label={mode === 'signin' ? 'Sign in to IRC Fiber' : mode === 'register' ? 'Create your IRC Fiber account' : 'Reset your IRC Fiber password'}>
  <div class="noauth-shade" aria-hidden="true"></div>

  <div class="noauth-overlay">
    <div class="noauth-card">
      <a class="noauth-brand" href="/" aria-label="IRC Fiber home" tabindex="-1">
        <span class="noauth-brand__mark" aria-hidden="true">&gt;_</span>
        <span class="noauth-brand__wordmark">IRC<em>Fiber</em></span>
      </a>

      {#if mode === 'signin'}
        <h1 class="noauth-heading">Sign in to IRC Fiber</h1>
        <p class="noauth-sub">Welcome back — pick up where you left off.</p>
      {:else if mode === 'register'}
        <h1 class="noauth-heading">Create your account</h1>
        <p class="noauth-sub">Always connected from any device.</p>
      {:else}
        <h1 class="noauth-heading">Reset your password</h1>
        <p class="noauth-sub">Enter the email address on your account.</p>
      {/if}

      {#if error}
        <div class="noauth-error" role="alert">
          <span class="noauth-error__glyph" aria-hidden="true">!</span>
          <span>{error}</span>
        </div>
      {/if}
      {#if sentTo}
        <h1 class="noauth-heading">Check your email</h1>
        <p class="noauth-sub">We sent a confirmation link to <strong>{sentTo}</strong>. It expires in 24 hours.</p>
        <p class="noauth-sub">Didn't get it? Check spam, or <button type="button" class="noauth-link" onclick={() => { sentTo = ''; }}>sign up again</button> for a new link.</p>
        <div class="noauth-meta"><span>Already confirmed?</span><button type="button" class="noauth-link" onclick={() => { sentTo = ''; setMode('signin'); }}>Sign in →</button></div>
      {:else if resetDone}
        <h1 class="noauth-heading">Check your email</h1>
        <p class="noauth-sub">If an account exists for <strong>{email}</strong>, we sent it a reset link. It expires in 1 hour.</p>
        <div class="noauth-meta"><button type="button" class="noauth-link" onclick={() => setMode('signin')}>Back to sign in →</button></div>
      {:else}
      {#if oauthProviders.length > 0}
        <div class="noauth-oauth">
          {#each oauthProviders as p}
            <a class="noauth-button noauth-oauth__button" href="/auth/{p.name}" rel="external" data-provider={p.name}>
              Continue with {p.label}
            </a>
          {/each}
          <div class="noauth-oauth__divider" aria-hidden="true"><span>or</span></div>
        </div>
      {/if}
      <form class="noauth-form" onsubmit={submit} autocomplete="on" novalidate>
        {#if mode !== 'forgot'}
        <div class="noauth-field">
          <label for="noauth-username">Username</label>
          <input
            bind:this={usernameEl}
            id="noauth-username"
            type="text"
            name="username"
            placeholder="you"
            bind:value={username}
            required
            autocomplete="username"
            spellcheck="false"
            disabled={busy}
          />
        </div>
        {/if}

        {#if mode !== 'signin'}
          <div class="noauth-field">
            <label for="noauth-email">Email</label>
            <input
              id="noauth-email"
              type="email"
              name="email"
              placeholder="you@example.com"
              bind:value={email}
              required
              autocomplete="email"
              spellcheck="false"
              disabled={busy}
            />
          </div>
        {/if}

        {#if mode !== 'forgot'}
        <div class="noauth-field">
          <label for="noauth-password">Password</label>
          <input
            id="noauth-password"
            type="password"
            name="password"
            placeholder={mode === 'register' ? 'at least 8 characters' : '••••••••'}
            bind:value={password}
            required
            minlength={mode === 'register' ? 8 : 1}
            autocomplete={mode === 'signin' ? 'current-password' : 'new-password'}
            disabled={busy}
          />
        </div>
        {/if}

        {#if mode === 'signin'}
          <button type="button" class="noauth-link" onclick={() => setMode('forgot')} data-testid="forgot-link">Forgot password?</button>
        {/if}

        <button class="noauth-button" type="submit" disabled={busy}>
          {#if busy}
            <span class="noauth-spinner" aria-hidden="true"></span>
            <span>{mode === 'signin' ? 'Signing in…' : mode === 'register' ? 'Creating account…' : 'Sending…'}</span>
          {:else}
            {mode === 'signin' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Send reset link'}
          {/if}
        </button>
      </form>

      <div class="noauth-meta">
        {#if mode === 'signin'}
          <span>Don't have an account?</span>
          <button type="button" class="noauth-link" onclick={() => setMode('register')}>
            Create one →
          </button>
        {:else if mode === 'register'}
          <span>Already have an account?</span>
          <button type="button" class="noauth-link" onclick={() => setMode('signin')}>
            Sign in →
          </button>
        {:else}
          <span>Remembered it?</span>
          <button type="button" class="noauth-link" onclick={() => setMode('signin')}>
            Back to sign in →
          </button>
        {/if}
      </div>
      {/if}

      <p class="noauth-foot">// fibre.always.connected</p>
    </div>
  </div>
</div>

<style>
  /* IRCCloud's #noAuth pattern, applied to IRC Fiber's dark brand
     palette. The shade covers the full viewport with a heavy tint
     and a soft cyan ambient glow at the top; the card sits centered
     with a sharp cyan ring and a soft drop shadow. */

  .noauth {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  .noauth-shade {
    position: absolute;
    inset: 0;
    /* IRCCloud uses ~40% black over the chat shell so the sidebar /
       buffer list stays visible behind the modal — you're signing
       into the app you can see, not into a separate page. We keep a
       touch more darkness to lean on the cyan ambient glow at the
       top, but stay light enough that the chat shell reads through. */
    background:
      radial-gradient(ellipse 60% 40% at 50% 0%, rgba(103, 232, 249, 0.10) 0%, transparent 60%),
      radial-gradient(ellipse 40% 30% at 80% 80%, rgba(251, 191, 36, 0.04) 0%, transparent 70%),
      rgba(5, 8, 12, 0.62);
    backdrop-filter: blur(2px) saturate(120%);
    -webkit-backdrop-filter: blur(2px) saturate(120%);
    animation: noauth-fade 0.18s ease-out;
  }

  .noauth-overlay {
    position: relative;
    width: 100%;
    max-width: 420px;
    animation: noauth-rise 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .noauth-card {
    background: #0e131a;
    border: 1px solid #1a212b;
    border-radius: 14px;
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.04) inset,
      0 24px 64px -16px rgba(0, 0, 0, 0.7),
      0 0 0 1px rgba(103, 232, 249, 0.06),
      0 0 64px -16px rgba(103, 232, 249, 0.25);
    padding: 32px 32px 26px;
  }

  .noauth-brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin-bottom: 24px;
    text-decoration: none;
    color: #ecf2f8;
    font-family: 'Space Grotesk', -apple-system, sans-serif;
    font-weight: 600;
    font-size: 22px;
    letter-spacing: -0.01em;
  }
  .noauth-brand em { font-style: normal; color: #67e8f9; }
  .noauth-brand__mark {
    width: 32px; height: 32px;
    border-radius: 8px;
    background: linear-gradient(135deg, #a5f3fc 0%, #67e8f9 60%, #0e7490 100%);
    box-shadow:
      0 0 16px rgba(103, 232, 249, 0.45),
      inset 0 -2px 4px rgba(0,0,0,0.20);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #06121a;
    font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, monospace;
    font-weight: 700;
    font-size: 14px;
    line-height: 1;
  }

  .noauth-heading {
    text-align: center;
    font-family: 'Space Grotesk', -apple-system, sans-serif;
    font-size: 22px;
    font-weight: 600;
    color: #ecf2f8;
    letter-spacing: -0.01em;
    margin: 0 0 6px;
  }
  .noauth-sub {
    text-align: center;
    font-size: 14px;
    color: #8b96a4;
    margin: 0 0 22px;
    line-height: 1.5;
  }

  .noauth-error {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    margin-bottom: 16px;
    background: rgba(248, 113, 113, 0.10);
    border: 1px solid rgba(248, 113, 113, 0.30);
    border-radius: 8px;
    color: #f87171;
    font-size: 13px;
    line-height: 1.45;
  }
  .noauth-error__glyph {
    flex: 0 0 18px;
    width: 18px; height: 18px;
    border-radius: 50%;
    background: #f87171;
    color: #06121a;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 11px;
    line-height: 1;
  }

  .noauth-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .noauth-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .noauth-field label {
    font-size: 12px;
    font-weight: 600;
    color: #8b96a4;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .noauth-field input {
    width: 100%;
    padding: 11px 12px;
    background: #0a0e14;
    border: 1px solid #232c38;
    border-radius: 8px;
    color: #ecf2f8;
    font-size: 14px;
    font-family: inherit;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
    box-sizing: border-box;
  }
  .noauth-field input::placeholder { color: #4d5867; }
  .noauth-field input:focus {
    outline: none;
    border-color: #67e8f9;
    box-shadow: 0 0 0 3px rgba(103, 232, 249, 0.18);
  }
  .noauth-field input:disabled { opacity: 0.55; cursor: not-allowed; }

  .noauth-button {
    width: 100%;
    padding: 11px 16px;
    margin-top: 6px;
    background: #67e8f9;
    color: #06121a;
    border: 1px solid #67e8f9;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 700;
    font-family: inherit;
    letter-spacing: 0.01em;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      box-shadow 0.15s ease,
      transform 0.05s ease;
  }
  .noauth-button:hover:not(:disabled) {
    background: #a5f3fc;
    border-color: #a5f3fc;
    box-shadow: 0 0 24px rgba(103, 232, 249, 0.45);
  }
  .noauth-button:active:not(:disabled) { transform: scale(0.99); }
  .noauth-button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(103, 232, 249, 0.30);
  }
  .noauth-button:disabled {
    opacity: 0.7;
    cursor: progress;
    box-shadow: none;
  }

  /* Social OAuth buttons: secondary variant of .noauth-button (same
     radius/weight, surface background, border) stacked above the form. */
  .noauth-oauth {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 4px;
  }
  .noauth-oauth__button {
    background: #0e1b26;
    border-color: #2a3b4d;
    color: #e6edf3;
    font-weight: 600;
    text-decoration: none;
    margin-top: 0;
  }
  .noauth-oauth__button:hover {
    background: #162635;
    border-color: #67e8f9;
    box-shadow: 0 0 16px rgba(103, 232, 249, 0.25);
  }
  .noauth-oauth__divider {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #4d5867;
    font-size: 12px;
    margin: 6px 0 2px;
  }
  .noauth-oauth__divider::before,
  .noauth-oauth__divider::after {
    content: '';
    flex: 1;
    border-top: 1px solid #22303f;
  }

  .noauth-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(6, 18, 26, 0.30);
    border-top-color: #06121a;
    border-radius: 50%;
    animation: noauth-spin 0.7s linear infinite;
  }

  .noauth-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 18px;
    padding-top: 18px;
    border-top: 1px solid #1a212b;
    font-size: 13px;
    color: #8b96a4;
  }
  .noauth-link {
    background: none;
    border: 0;
    padding: 0;
    color: #67e8f9;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: color 0.15s ease;
  }
  .noauth-link:hover { color: #a5f3fc; text-decoration: underline; }
  .noauth-link:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(103, 232, 249, 0.25);
    border-radius: 3px;
  }

  .noauth-foot {
    text-align: center;
    margin: 20px 0 0;
    font-size: 11px;
    color: #4d5867;
    font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, monospace;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  @keyframes noauth-fade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes noauth-rise {
    from { opacity: 0; transform: translateY(8px) scale(0.985); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes noauth-spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 480px) {
    .noauth-card { padding: 26px 22px 22px; border-radius: 12px; }
    .noauth-heading { font-size: 20px; }
    .noauth-brand { font-size: 20px; }
  }

  /* Respect users who prefer reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .noauth-shade,
    .noauth-overlay,
    .noauth-spinner {
      animation: none !important;
    }
  }
</style>
