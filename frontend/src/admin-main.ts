import { mount } from 'svelte';
import App from './admin/App.svelte';
import './styles/admin.css';
import { setMode } from 'mode-watcher';

const el = document.getElementById('admin-app');
if (!el) {
  console.error('[admin-main.ts] Mount point #admin-app not found');
} else {
  el.innerHTML = '';
  mount(App, { target: el });
}

// Apply the persisted theme as soon as the script loads so the first paint
// is correct. mode-watcher exposes the `setMode` function for this; the
// <ModeWatcher> Svelte component is for UI only and isn't needed here.
try {
  const saved = localStorage.getItem('mode-watcher-mode');
  setMode(saved === 'light' ? 'light' : 'dark');
} catch { /* ignore — default to dark */ }

export default {};