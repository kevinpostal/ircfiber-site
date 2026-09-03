import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import './styles/main.scss';
import './stores/slashCommandsInit';

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
}

export default app;
