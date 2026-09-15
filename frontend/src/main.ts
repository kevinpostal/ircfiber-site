import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import './styles/main.scss';
import './stores/slashCommandsInit';
import { installViewportTracker } from './lib/viewport';
import { recoverFromStaleChunk } from './lib/staleChunk';

// A lazily loaded chunk that 404s after a deploy is reported twice: Vite's
// preload helper fires `vite:preloadError`, and the rejection then reaches
// whichever {#await} asked for it (App.svelte renders ChunkLoadError).
// Reload here so the tab repairs itself without the user doing anything.
//
// NEVER call preventDefault on either event. Vite's helper rethrows only
// `if (!e.defaultPrevented)`, so cancelling it makes the import RESOLVE
// with undefined instead — the {:then} branch then destructures undefined
// and dies, which is the blank page this was meant to fix. Leaving both
// events uncancelled also keeps the failure in the console for support.
window.addEventListener('vite:preloadError', (event) => {
  // Vite sets `payload` on the event itself; keep `detail` as a fallback in
  // case that moves.
  const e = event as Event & { payload?: unknown; detail?: { payload?: unknown } };
  recoverFromStaleChunk(e.payload ?? e.detail?.payload
    ?? new Error('Failed to fetch dynamically imported module'));
});
window.addEventListener('unhandledrejection', (event) => {
  recoverFromStaleChunk(event.reason);
});

const el = document.getElementById('app');
let app: Record<string, unknown> | undefined;

if (!el) {
  console.error('[main.ts] Mount point #app not found — not a Svelte app page');
} else {
  performance.mark('spa-mount-start');
  console.log('[main.ts] Mounting Svelte app...');
  // IRCCloud-style: clear the pre-rendered spinner before mounting so it
  // doesn't persist as a stray text node alongside the app. Svelte 5's
  // mount() appends to the target — it never replaces existing children.
  el.innerHTML = '';
  app = mount(App, { target: el });
  performance.mark('spa-mounted');
  console.log('[main.ts] Svelte app mounted');
  installViewportTracker();
}

export default app;
