/**
 * Auth store — current admin user info.
 */
import { writable, derived } from 'svelte/store';
import { api, ApiError } from '../lib/api-client';

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  roles: string[];
  isAdmin: boolean;
}

export const adminUser = writable<AdminUser | null>(null);

export const isLoggedIn = derived(adminUser, ($u) => $u !== null);

/** Shared promise so overlapping calls (module auto-load + App.onMount)
 * share the same in-flight request instead of creating two session records. */
let loadPromise: Promise<AdminUser | null> | null = null;

export async function loadMe(): Promise<AdminUser | null> {
  if (loadPromise) return loadPromise;
  loadPromise = (async (): Promise<AdminUser | null> => {
    try {
      const me = await api.get<AdminUser>('/api/admin/me');
      adminUser.set(me);
      return me;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        adminUser.set(null);
        // Redirect to login — preserve current hash fragment so the user
        // is sent back to their intended page after re-authentication.
        const hash = window.location.hash;
        const redirectParam = hash && hash !== '#/' && hash !== '#/dashboard'
          ? '?redirect=' + encodeURIComponent(hash)
          : '';
        window.location.href = '/admin/login' + redirectParam;
        return null;
      }
      throw e;
    }
  })();
  return loadPromise;
}

export function logout() {
  window.location.href = '/admin/logout';
}
