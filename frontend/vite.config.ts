import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import tailwindcss from '@tailwindcss/vite';

// Backend URL for the dev server's API + WS proxy. Override via env vars
// to point at a non-local backend (e.g. the tailnet gateway):
//
//   npm run dev:local    # → http://127.0.0.1:8090 (local docker-compose)
//   npm run dev:tailnet  # → https://ircfiber-ovh.tail544547.ts.net
//                        #   (tailnet gateway; real cert via Tailscale ACME)
//   VITE_BACKEND_URL=http://192.168.1.50:8090 npm run dev
//                        # → arbitrary HTTP backend
const BACKEND_URL =
  process.env.VITE_BACKEND_URL || 'http://127.0.0.1:8090';
// WS target defaults to the same host with the ws/wss scheme.
const BACKEND_WS_URL =
  process.env.VITE_BACKEND_WS_URL || BACKEND_URL.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [tailwindcss(), svelte({
    onwarn(warning, handler) {
      // Suppress a11y warnings that we've reviewed as acceptable:
      // - aria-disabled on <li> is fine for our context menus
      // - '#' href on pagination links is a common pattern
      // - role="button" on <span> nick links is intentional
      // - tabindex on h1 for focus management is deliberate
      // - state_referenced_locally for $state() initial-value captures
      if (warning.code === 'a11y_role_supports_aria_props_implicit' ||
          warning.code === 'a11y_invalid_attribute' ||
          warning.code === 'a11y_interactive_supports_focus' ||
          warning.code === 'a11y_no_noninteractive_tabindex' ||
          warning.code === 'a11y_click_events_have_key_events' ||
          warning.code === 'a11y_no_static_element_interactions' ||
          warning.code === 'a11y_no_noninteractive_element_interactions' ||
          warning.code === 'a11y_no_redundant_roles' ||
          warning.code === 'a11y_consider_explicit_label' ||
          warning.code === 'state_referenced_locally') {
        return;
      }
      handler(warning);
    }
  })],
  publicDir: '../public',
  build: {
    outDir: '../public/dist',
    emptyOutDir: true,
    manifest: true,
    // Vite 5+ puts assets under `assets/` (e.g. public/dist/assets/index-*.js)
    // and the HTML references them as `/assets/index-*.js`. The irc-fiber
    // gateway's serveDist route strips the `/public/dist/` prefix and
    // serves from `public/dist/`, so a request for `/assets/index-*.js`
    // won't match `/public/dist/*` and 404s. The gateway code handles
    // this by also serving the `assets/` subdirectory under the same
    // route prefix (see ircfiber/web/package.d), so we just keep Vite's
    // default output structure.
    rollupOptions: {
      input: {
        // Chat SPA — unchanged
        main: 'index.html',
        // Admin SPA — enterprise admin dashboard
        admin: 'admin.html',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        // Dev proxy: skip TLS verification. Tailscale certs are trusted
        // by the OS but Node.js's built-in CA bundle may not include the
        // intermediate. In production the gateway handles TLS directly.
        secure: false,
      },
      '/ws': {
        target: BACKEND_WS_URL,
        ws: true,
        changeOrigin: true,
        secure: false,
      },
      '/login': {
        target: BACKEND_URL,
        changeOrigin: true,
        secure: false,
      },
      '/register': {
        target: BACKEND_URL,
        changeOrigin: true,
        secure: false,
      }
    }
  },
  onwarn(warning, options) {
    // Suppress the publicDir/outDir overlap warning — this is intentional
    // because the Go gateway strips the /public/dist/ prefix.
    if (warning.code === 'UNUSED_OUT_DIR') return;
    options(warning);
  },
  test: {
    projects: [
      {
        // LIB PROJECT — pure utilities, no DOM, runs in node
        extends: true,
        test: {
          name: 'lib',
          environment: 'node',
          include: ['src/lib/**/*.{test,spec}.{ts,js}'],
          exclude: ['src/lib/**/*.svelte.{test,spec}.{ts,js}'],
        },
      },
      {
        // CLIENT PROJECT — components, stores, integration; runs in chromium
        extends: true,
        test: {
          name: 'client',
          // Default 5s timeout is too long for browser tests; cap at 2s
          testTimeout: 2000,
          // Browser tests share module-level state; run sequentially to avoid
          // cross-test interference (e.g. $state maps, debounced timers).
          fileParallelism: false,
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: 'chromium', headless: true }],
          },
          include: [
            'src/**/*.{test,spec}.{ts,js}',
            'src/**/*.svelte.test.{ts,js}',
            'src/**/*.svelte.{test,spec}.{ts,js}',
          ],
          exclude: ['src/lib/**/*.{test,spec}.{ts,js}'],
          setupFiles: ['vitest-browser-svelte'],
        },
      },
    ],
  },
});
