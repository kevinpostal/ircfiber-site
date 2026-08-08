/**
 * Fiber auto-connect toggle — admin control for the default IRC Fiber network.
 * Persists to Redis `irc:config:fiberEnabled` via /api/admin/config/fiber.
 */
import { writable } from 'svelte/store';
import { api, ApiError } from '../lib/api-client';

export interface FiberConfig {
  enabled: boolean;
  key: string;
  fiberNetworkCount: number;
  disabledCount: number;
}

export const fiberConfig = writable<FiberConfig | null>(null);
export const fiberConfigLoading = writable(false);
export const fiberConfigError = writable<string | null>(null);
export const fiberConfigSaving = writable(false);

export async function fetchFiberConfig(force = false): Promise<void> {
  fiberConfigLoading.set(true);
  fiberConfigError.set(null);
  try {
    const data = await api.get<FiberConfig>('/api/admin/config/fiber');
    fiberConfig.set(data);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    fiberConfigError.set(msg);
  } finally {
    fiberConfigLoading.set(false);
  }
}

export async function setFiberEnabled(enabled: boolean): Promise<{ changed: number; total: number }> {
  fiberConfigSaving.set(true);
  fiberConfigError.set(null);
  try {
    const data = await api.post<{ enabled: boolean; changed: number; total: number }>('/api/admin/config/fiber', { enabled });
    // Refresh to get updated counts
    await fetchFiberConfig(true);
    return { changed: data.changed ?? 0, total: data.total ?? 0 };
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    fiberConfigError.set(msg);
    throw e;
  } finally {
    fiberConfigSaving.set(false);
  }
}
