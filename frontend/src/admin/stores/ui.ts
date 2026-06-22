/**
 * UI state — theme, sidebar, toasts.
 */
import { writable, type Writable } from 'svelte/store';
import { setMode } from 'mode-watcher';

// Tiny persisted-store factory backed by localStorage. SSR-safe (no-op on server).
function persisted<T>(key: string, initial: T): Writable<T> {
  const store = writable<T>(initial);
  if (typeof window === 'undefined') return store;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) store.set(JSON.parse(raw));
  } catch { /* ignore */ }
  store.subscribe((v) => {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
  });
  return store;
}

// Theme — light or dark, dark by default. mode-watcher handles persistence.
export const theme = writable<'light' | 'dark'>('dark');

if (typeof window !== 'undefined') {
  try {
    const saved = localStorage.getItem('ircfiber-admin:theme');
    const initial: 'light' | 'dark' = saved === 'light' ? 'light' : 'dark';
    theme.set(initial);
    if (initial === 'light') {
      document.documentElement.classList.remove('dark');
      setMode('light');
    } else {
      document.documentElement.classList.add('dark');
      setMode('dark');
    }
  } catch { /* ignore */ }
}

export function toggleTheme() {
  theme.update((t) => {
    const next: 'light' | 'dark' = t === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('ircfiber-admin:theme', JSON.stringify(next)); } catch { /* ignore */ }
    if (next === 'light') {
      document.documentElement.classList.remove('dark');
      setMode('light');
    } else {
      document.documentElement.classList.add('dark');
      setMode('dark');
    }
    return next;
  });
}

// Sidebar collapsed (mobile / desktop preference)
export const sidebarCollapsed = persisted('ircfiber-admin:sidebar', false);

// Auto-poll enabled (pause toggle in topbar)
export const pollingEnabled = persisted('ircfiber-admin:polling', true);

// Toasts
export type ToastKind = 'success' | 'error' | 'info' | 'warn';
export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  ttlMs: number;
}

export const toasts = writable<Toast[]>([]);

let toastCounter = 0;
export function toast(message: string, kind: ToastKind = 'info', ttlMs = 4_000) {
  const id = `t-${++toastCounter}`;
  toasts.update((arr) => [...arr, { id, kind, message, ttlMs }]);
  setTimeout(() => {
    toasts.update((arr) => arr.filter((t) => t.id !== id));
  }, ttlMs);
}

export const toastSuccess = (msg: string, ttl?: number) => toast(msg, 'success', ttl);
export const toastError = (msg: string, ttl?: number) => toast(msg, 'error', ttl ?? 6_000);
export const toastInfo = (msg: string, ttl?: number) => toast(msg, 'info', ttl);
export const toastWarn = (msg: string, ttl?: number) => toast(msg, 'warn', ttl);