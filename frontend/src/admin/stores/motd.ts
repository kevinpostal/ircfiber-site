/**
 * MOTD templates — admin CRUD over /api/admin/motd plus the ircd rotation
 * state. Every write returns the full list + rotation state, so the store
 * is replaced wholesale after each call.
 */
import { api } from '../lib/api-client';
import { visibleWidth } from '../lib/mirc';

export interface MotdTemplate {
  id: string;
  name: string;
  body: string;
  enabled: boolean;
  sortOrder: number;
  /** Builder recipe JSON ("" for hand-written templates). */
  recipe: string;
  /** Variant group ("" = standalone). */
  group: string;
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
  recipe?: string;
  group?: string;
}

export interface MotdBatchInput {
  group: string;
  recipe: string;
  items: { name: string; body: string; enabled: boolean }[];
}

export const fetchMotd = () => api.get<MotdState>('/api/admin/motd');
export const createMotd = (input: MotdTemplateInput) => api.post<MotdState>('/api/admin/motd', input);
export const updateMotd = (id: string, input: MotdTemplateInput) =>
  api.post<MotdState>(`/api/admin/motd/${encodeURIComponent(id)}`, input);
export const deleteMotd = (id: string) =>
  api.post<MotdState>(`/api/admin/motd/${encodeURIComponent(id)}/delete`, {});
/** Replaces every template in `group` with `items` (one rotation, one REHASH). */
export const batchMotd = (input: MotdBatchInput) => api.post<MotdState>('/api/admin/motd/batch', input);
export const rotateMotd = (id?: string) => api.post<MotdState>('/api/admin/motd/rotate', id ? { id } : {});

/** Longest visible line in cells (colour codes stripped; code points, so
 *  box-drawing art counts as 1 per cell). */
export function maxColumns(body: string): number {
  let max = 0;
  for (const line of body.split('\n')) {
    const n = visibleWidth(line);
    if (n > max) max = n;
  }
  return max;
}
