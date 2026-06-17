import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';

// Backend URL for the dev server's API + WS proxy. Override via env vars
// to point at a non-local backend (e.g. the tailnet gateway):
//
//   npm run dev:local    # → http://127.0.0.1:8090 (local docker-compose)
//   npm run dev:tailnet  # → https://ircfiber-prod-1.tail544547.ts.net
//                        #   (tailnet gateway; real cert via Tailscale ACME)
//   VITE_BACKEND_URL=http://192.168.1.50:8090 npm run dev
//                        # → arbitrary HTTP backend
const BACKEND_URL =
  process.env.VITE_BACKEND_URL || 'http://127.0.0.1:8090';
// WS target defaults to the same host with the ws/wss scheme.
const BACKEND_WS_URL =
  process.env.VITE_BACKEND_WS_URL || BACKEND_URL.replace(/^http/, 'ws');
const BACKEND_IS_TLS = BACKEND_URL.startsWith('https://');

export default defineConfig({
  plugins: [svelte()],
  publicDir: '../public',
  build: {
    outDir: '../public/dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'style.css') return 'index.css';
          return assetInfo.name ?? 'asset';
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        // Verify the backend's TLS cert. The Tailscale cert on the
        // tailnet backend is real and trusted, so leave this true.
        secure: BACKEND_IS_TLS,
      },
      '/ws': {
        target: BACKEND_WS_URL,
        ws: true,
        changeOrigin: true,
        secure: BACKEND_IS_TLS,
      }
    }
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
