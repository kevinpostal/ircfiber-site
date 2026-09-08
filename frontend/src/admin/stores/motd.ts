/**
 * MOTD templates — admin CRUD over /api/admin/motd plus the ircd pool
 * state. Every write returns the full list + pool state, so the store is
 * replaced wholesale after each call.
 */
import { api } from '../lib/api-client';
import { stripIrcFormatting } from '../../lib/ircFormatting';

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
  /** Template served to everyone until unpinned ("" = random per connect). */
  pinnedId: string;
  /** ircd-side pool file every enabled template is written into. */
  poolFile: string;
  /** ircd-side per-user profiles file (geo + FiberEye rollup). */
  profilesFile: string;
  /** Blocks in the last successful pool write (1 while pinned). */
  blocks: number;
  /** Records in the last successful profiles write. */
  profiles: number;
  /** Failure of the pool write that ran as part of the last write ("" = ok). */
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
/** Replaces every template in `group` with `items` (one pool write). */
export const batchMotd = (input: MotdBatchInput) => api.post<MotdState>('/api/admin/motd/batch', input);
export const pinMotd = (id: string) => api.post<MotdState>(`/api/admin/motd/${encodeURIComponent(id)}/pin`, {});
export const unpinMotd = () => api.post<MotdState>('/api/admin/motd/unpin', {});
/** Rewrites the ircd pool from current state (pinned → one block, else all enabled). */
export const rotateMotd = () => api.post<MotdState>('/api/admin/motd/rotate', {});

/** Longest visible line in cells (colour codes stripped; code points, so
 *  box-drawing art counts as 1 per cell). */
export function maxColumns(body: string): number {
  let max = 0;
  for (const line of body.split('\n')) {
    const n = [...stripIrcFormatting(line)].length;
    if (n > max) max = n;
  }
  return max;
}
