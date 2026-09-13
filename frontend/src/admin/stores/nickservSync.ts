/**
 * NickServ → site auto-sync — kill-switch plus the last run's outcome.
 * Persists to Redis `irc:config:nickservSync` via /api/admin/config/nickserv-sync;
 * the status is what the gateway's last inventory-processing cycle recorded.
 */
import { writable } from 'svelte/store';
import { api, ApiError } from '../lib/api-client';

export interface NickservSyncStatus {
  lastRunAt: number;
  host: string;
  result: 'ok' | 'error';
  error: string;
  accounts: number;
  created: number;
  skipped: number;
  failed: number;
  capped: boolean;
  inventoryMtime: number;
}

export interface NickservSyncConfig {
  enabled: boolean;
  key: string;
  intervalSecs: number;
  maxPerRun: number;
  status: NickservSyncStatus | null;
}

export const nickservSync = writable<NickservSyncConfig | null>(null);
export const nickservSyncLoading = writable(false);
export const nickservSyncError = writable<string | null>(null);
export const nickservSyncSaving = writable(false);

export async function fetchNickservSyncConfig(): Promise<void> {
  nickservSyncLoading.set(true);
  nickservSyncError.set(null);
  try {
    const data = await api.get<NickservSyncConfig>('/api/admin/config/nickserv-sync');
    nickservSync.set(data);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    nickservSyncError.set(msg);
  } finally {
    nickservSyncLoading.set(false);
  }
}

export async function setNickservSyncEnabled(enabled: boolean): Promise<void> {
  nickservSyncSaving.set(true);
  nickservSyncError.set(null);
  try {
    await api.post('/api/admin/config/nickserv-sync', { enabled });
    await fetchNickservSyncConfig();
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    nickservSyncError.set(msg);
    throw e;
  } finally {
    nickservSyncSaving.set(false);
  }
}
