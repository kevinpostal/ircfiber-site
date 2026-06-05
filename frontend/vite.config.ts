import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';

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
      '/api': 'http://127.0.0.1:8090',
      '/ws': {
        target: 'ws://127.0.0.1:8090',
        ws: true
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
