import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import tailwindcss from '@tailwindcss/vite';
import { createLogger } from 'vite';

// Backend URL for the dev server's API + WS proxy. Override via env vars
// to point at a non-local backend (e.g. the tailnet gateway or Python gateway):
//
//   npm run dev:local    # → http://127.0.0.1:8090 (local D gateway)
//   npm run dev:tailnet  # → https://vps-efb4b52d.tail544547.ts.net
//                        #   (tailnet gateway; real cert via Tailscale ACME)
//   VITE_BACKEND_URL=http://192.168.1.50:8090 npm run dev
//                        # → arbitrary HTTP backend
//   VITE_API_BACKEND=http://127.0.0.1:8001 npm run dev  # Python gateway (Step 3)
// Suppress noisy vite http/ws proxy errors for /api/events?since= XHR fallback
// (vibe.d Keep-Alive race + HMR WS close). The browser's fetch/XHR
// fallback retries via maxEidTracker, so ECONNRESET/socket hang up is
// expected and not a real error. Filter here instead of in proxy
// configure because vite adds its error listener *after* configure.
const _origConsoleError = console.error.bind(console);
// @ts-ignore - patch to suppress expected proxy hang ups
(console as any).error = (...args: any[]) => {
  const first = String(args[0] ?? '');
  if (first.includes('http proxy error') && (first.includes('socket hang up') || first.includes('ECONNRESET') || first.includes('ECONNREFUSED') || first.includes('read ECONNRESET'))) return;
  if (first.includes('ws proxy error') || first.includes('ws proxy socket error')) {
    if (first.includes('ECONNRESET') || first.includes('socket hang up') || first.includes('EPIPE') || first.includes('hang up')) return;
  }
  _origConsoleError(...args);
};

const _viteLogger = createLogger();
const _origViteError = _viteLogger.error.bind(_viteLogger);
_viteLogger.error = (msg: string, opts?: any) => {
  const m = String(msg ?? '');
  if (m.includes('http proxy error') && (m.includes('socket hang up') || m.includes('ECONNRESET') || m.includes('ECONNREFUSED') || m.includes('read ECONNRESET'))) return;
  if (m.includes('ws proxy error') || m.includes('ws proxy socket error')) {
    if (m.includes('ECONNRESET') || m.includes('socket hang up') || m.includes('EPIPE') || m.includes('hang up')) return;
  }
  _origViteError(msg, opts);
};

const BACKEND_URL =
  process.env.VITE_API_BACKEND || process.env.VITE_BACKEND_URL || 'http://127.0.0.1:8090';
// WS target defaults to the same host with the ws/wss scheme, unless overridden.
// VITE_WS_BASE / VITE_BACKEND_WS_URL both accepted (Step 3 swappable API).
const BACKEND_WS_URL =
  process.env.VITE_WS_BASE || process.env.VITE_BACKEND_WS_URL || BACKEND_URL.replace(/^http/, 'ws');

// SigNoz URL for the dev server's SigNoz proxy. Override via env var when
// pointing at a non-local SigNoz instance (e.g. the tailnet gateway). The
// default (127.0.0.1:3301) is the host port mapped from docker-compose's
// `signoz` service so the dev SPA can query ClickHouse-backed logs without
// going through the IRC Fiber gateway. The catch-all `/api` rule below
// targets BACKEND_URL (the IRC Fiber gateway) — the more-specific `/api/v1/`
// through `/api/v5/` and `/signoz/` rules MUST come BEFORE it so Vite's
// first-match-wins picks the SigNoz target for SigNoz paths.
const SIGNOZ_URL =
  process.env.VITE_SIGNOZ_URL || 'http://127.0.0.1:3301';
// iCloud Mobile Documents causes bird sync to hang vite build
// (public/dist and frontend/node_modules on iCloud). Use /tmp for
// vite cache when cwd is inside Mobile Documents.
const isICloud = process.cwd().includes('Mobile Documents');
export default defineConfig({
  customLogger: _viteLogger,
  cacheDir: isICloud ? '/tmp/vite-ircfiber' : undefined,
  assetsInclude: ['**/*.wasm'],
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
  worker: { format: 'es' },
  publicDir: '../public',
  build: {
    outDir: '../public/dist',
    emptyOutDir: false,
    copyPublicDir: false,
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
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // --- SigNoz rules (MUST come before catch-all /api) ---
      // /signoz/ is the live-tail WS path; ws:true on that rule keeps the
      // dev server forwarding WebSocket upgrades for w3-t1.
      '/api/v1/':  { target: SIGNOZ_URL, changeOrigin: true, secure: false },
      '/api/v2/':  { target: SIGNOZ_URL, changeOrigin: true, secure: false },
      '/api/v3/':  { target: SIGNOZ_URL, changeOrigin: true, secure: false },
      '/api/v4/':  { target: SIGNOZ_URL, changeOrigin: true, secure: false },
      '/api/v5/':  { target: SIGNOZ_URL, changeOrigin: true, secure: false },
      '/signoz/':  { target: SIGNOZ_URL, changeOrigin: true, secure: false, ws: true },

      // --- Existing rules (unchanged) ---
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        // Dev proxy: skip TLS verification. Tailscale certs are trusted
        // by the OS but Node.js's built-in CA bundle may not include the
        // intermediate. In production the gateway handles TLS directly.
        secure: false,
        // Fix socket hang up on /api/events?since= XHR fallback polling:
        // vibe.d gateway sends `Keep-Alive: timeout=10` and closes idle
        // sockets. Vite's http-proxy reuses sockets (keep-alive) and hits
        // ECONNRESET when it tries to reuse a closed one. Force
        // `Connection: close` so each poll gets a fresh socket, matching
        // production (Caddy → gateway, no keep-alive reuse). Also bump
        // timeouts to avoid vite's default 2m cut on slow Redis lrange.
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          // Remove vite's default error logger (which prints
          // `[vite] http proxy error: ... socket hang up`) and
          // install our own that silently handles the expected
          // keep-alive race. The browser's XHR fallback retries
          // via maxEidTracker, so a 502 is safe.
          proxy.removeAllListeners('error');
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Connection', 'close');
          });
          proxy.on('error', (err, _req, res) => {
            const msg = String((err as any)?.message ?? '');
            const code = (err as NodeJS.ErrnoException)?.code ?? '';
            const isHangUp = msg.includes('socket hang up') || msg.includes('ECONNRESET') || code === 'ECONNRESET' || code === 'ECONNREFUSED' || msg.includes('hang up');
            if (isHangUp) {
              if (res && !res.headersSent) {
                try { (res as import('http').ServerResponse).writeHead(200, { 'Content-Type': 'application/json' }); } catch {}
                try { res.end('[]'); } catch {}
              }
              return;
            }
            // For unexpected errors, still log once
            console.error('[vite] http proxy error (api):', err);
            if (res && !res.headersSent) {
              try { (res as import('http').ServerResponse).writeHead(502); } catch {}
              try { res.end(); } catch {}
            }
          });
        },
      },
      '/ws': {
        target: BACKEND_WS_URL,
        ws: true,
        changeOrigin: true,
        secure: false,
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.removeAllListeners('error');
          proxy.on('error', (err, _req, socket) => {
            const msg = String((err as any)?.message ?? '');
            const code = (err as NodeJS.ErrnoException)?.code ?? '';
            const isHangUp = msg.includes('socket hang up') || msg.includes('ECONNRESET') || code === 'ECONNRESET' || msg.includes('hang up');
            if (isHangUp) {
              try { (socket as any)?.end?.(); } catch {}
              return;
            }
            console.error('[vite] ws proxy error:', err);
          });
        },
      },
      '/admin/login': {
        target: BACKEND_URL,
        changeOrigin: true,
        secure: false,
      },
      '/admin/logout': {
        target: BACKEND_URL,
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
      },
      '/uploads': {
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
