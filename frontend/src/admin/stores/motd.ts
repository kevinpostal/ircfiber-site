/**
 * MOTD templates — admin CRUD over /api/admin/motd plus the ircd rotation
 * state. Every write returns the full list + rotation state, so the store
 * is replaced wholesale after each call.
 */
import { api } from '../lib/api-client';

export interface MotdTemplate {
  id: string;
  name: string;
  body: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface MotdRotation {
  /** Template the ircd file currently holds, or null before first rotation. */
  current: { id: string; name: string; at: number } | null;
  file: string;
  intervalMs: number;
  /** Failure of the rotation that ran as part of the last write ("" = ok). */
  error: string;
}

export interface MotdState {
  templates: MotdTemplate[];
  rotation: MotdRotation;
}

export interface MotdTemplateInput {
  name: string;
  body: string;
  enabled: boolean;
  sortOrder?: number;
}

export const fetchMotd = () => api.get<MotdState>('/api/admin/motd');
export const createMotd = (input: MotdTemplateInput) => api.post<MotdState>('/api/admin/motd', input);
export const updateMotd = (id: string, input: MotdTemplateInput) =>
  api.post<MotdState>(`/api/admin/motd/${encodeURIComponent(id)}`, input);
export const deleteMotd = (id: string) =>
  api.post<MotdState>(`/api/admin/motd/${encodeURIComponent(id)}/delete`, {});
export const rotateMotd = (id?: string) => api.post<MotdState>('/api/admin/motd/rotate', id ? { id } : {});

/** Longest line, in characters (code points, so box-drawing art counts as 1 per cell). */
export function maxColumns(body: string): number {
  let max = 0;
  for (const line of body.split('\n')) {
    const n = [...line].length;
    if (n > max) max = n;
  }
  return max;
}
