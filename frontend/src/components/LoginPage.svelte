<script lang="ts">
  /**
   * LoginPage — IRCCloud-style in-app authentication overlay.
   *
   * Renders as a centered modal on top of a dimmed backdrop, with the
   * full Svelte SPA shell visible behind it. Mirrors IRCCloud's
   * `#noAuth` / `.noAuthOverlay.noAuthSignin` pattern — the SPA always
   * boots, and the overlay sits on top until the session is established.
   *
   * Two modes share the same component: `signin` (default) and `register`.
   * The form POSTs to /login or /register respectively. On success the
   * SPA reloads; on failure the response is parsed and an inline error
   * banner is shown (no full page reload).
   *
   * Props:
   *   onAuthenticated — invoked after a successful login or register so
   *                     the parent can flip its `isAuthenticated` flag
   *                     and dismiss the overlay.
   */
  interface Props {
    onAuthenticated: () => void;
  }
  let { onAuthenticated }: Props = $props();

  type Mode = 'signin' | 'register';

  let mode: Mode = $state('signin');
  let username = $state('');
  let email = $state('');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  // Toggle modes and reset transient state so a failed submit on one
  // form doesn't carry an error into the other.
  function setMode(next: Mode): void {
    if (mode === next) return;
    mode = next;
    error = '';
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    error = '';
    busy = true;

    const endpoint = mode === 'signin' ? '/login' : '/register';
    const body = new URLSearchParams();
    body.set('username', mode === 'signin' ? username : username);
    body.set('password', password);
    if (mode === 'register') body.set('email', email);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'same-origin',
        redirect: 'manual',
      });

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

      // 4xx — the server re-rendered the diet page with an inline
      // error banner. Pull the authError text out of the rendered HTML
      // so we can show the same message inline.
      const html = await res.text();
      const m = html.match(/<div[^>]*class="[^"]*auth-error[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (m && m[1]) {
        error = stripHtml(m[1]).trim();
      } else {
        error = mode === 'signin'
          ? 'Incorrect username or password. Please try again.'
          : 'We could not create your account. Please check the details and retry.';
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

<div class="noauth" role="dialog" aria-modal="true" aria-label={mode === 'signin' ? 'Sign in to IRC Fiber' : 'Create your IRC Fiber account'}>
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
      {:else}
        <h1 class="noauth-heading">Create your account</h1>
        <p class="noauth-sub">Always connected from any device.</p>
      {/if}

      {#if error}
        <div class="noauth-error" role="alert">
          <span class="noauth-error__glyph" aria-hidden="true">!</span>
          <span>{error}</span>
        </div>
      {/if}

      <form class="noauth-form" onsubmit={submit} autocomplete="on" novalidate>
        <div class="noauth-field">
          <label for="noauth-username">Username</label>
          <input
            id="noauth-username"
            type="text"
            name="username"
            placeholder="you"
            bind:value={username}
            required
            autofocus
            autocomplete="username"
            spellcheck="false"
            disabled={busy}
          />
        </div>

        {#if mode === 'register'}
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

        <button class="noauth-button" type="submit" disabled={busy}>
          {#if busy}
            <span class="noauth-spinner" aria-hidden="true"></span>
            <span>{mode === 'signin' ? 'Signing in…' : 'Creating account…'}</span>
          {:else}
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          {/if}
        </button>
      </form>

      <div class="noauth-meta">
        {#if mode === 'signin'}
          <span>Don't have an account?</span>
          <button type="button" class="noauth-link" onclick={() => setMode('register')}>
            Create one →
          </button>
        {:else}
          <span>Already have an account?</span>
          <button type="button" class="noauth-link" onclick={() => setMode('signin')}>
            Sign in →
          </button>
        {/if}
      </div>

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
