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
  console.log('[main.ts] Mounting Svelte app...');
  app = mount(App, { target: el });
  console.log('[main.ts] Svelte app mounted');
}

export default app;
