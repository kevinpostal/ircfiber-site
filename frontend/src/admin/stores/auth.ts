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

let loaded = false;

export async function loadMe(): Promise<AdminUser | null> {
  try {
    const me = await api.get<AdminUser>('/api/admin/me');
    adminUser.set(me);
    return me;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      adminUser.set(null);
      // Redirect to login
      window.location.href = '/admin/login';
      return null;
    }
    throw e;
  }
}

export function logout() {
  window.location.href = '/admin/logout';
}

// Auto-load on first import (idempotent)
if (typeof window !== 'undefined' && !loaded) {
  loaded = true;
  loadMe().catch(() => { /* swallow; pages that need it will call loadMe themselves */ });
}