/**
 * Redis monitor store — INFO summary, key browser, slowlog.
 * Summary polls every 5s; key listing is paginated on-demand.
 */
import { writable } from 'svelte/store';
import { api, ApiError } from '../lib/api-client';

export interface RedisSummary {
  version?: string;
  uptimeSeconds?: number;
  os?: string;
  connectedClients?: number;
  usedMemory?: number;
  usedMemoryHuman?: string;
  usedMemoryPeak?: number;
  usedMemoryPeakHuman?: string;
  totalConnections?: number;
  totalCommandsProcessed?: number;
  opsPerSec?: number;
  keyspaceHits?: number;
  keyspaceMisses?: number;
  hitRatio?: number;
  keyspace?: Record<string, string>;
  dbsize?: number;
  error?: string;
}

export interface KeyEntry {
  key: string;
  meta: {
    type: string;
    ttl: number;
    memory: number;
  };
}

export interface KeyScan {
  cursor: string;
  keys: string[];
  entries: KeyEntry[];
  match: string;
  count: number;
}

export interface SlowEntry {
  id: number;
  timestampMs: number;
  durationMicros: number;
  command: string[];
}

export interface SlowLog {
  count: number;
  entryCount: number;
  entries: SlowEntry[];
  error?: string;
}

export const redisSummary = writable<RedisSummary | null>(null);
export const redisLoading = writable(false);
export const redisError = writable<string | null>(null);

let lastSummaryFetchedAt = 0;

export async function fetchRedisSummary(force = false): Promise<void> {
  if (!force && Date.now() - lastSummaryFetchedAt < 2_500) return;
  redisLoading.set(true);
  redisError.set(null);
  try {
    const s = await api.get<RedisSummary>('/api/admin/redis/summary');
    redisSummary.set(s);
    lastSummaryFetchedAt = Date.now();
  } catch (e) {
    redisError.set(e instanceof ApiError ? e.message : (e as Error).message);
  } finally {
    redisLoading.set(false);
  }
}

export async function scanRedisKeys(opts: {
  cursor?: string;
  match?: string;
  count?: number;
} = {}): Promise<KeyScan | null> {
  try {
    return await api.get<KeyScan>('/api/admin/redis/keys', {
      cursor: opts.cursor ?? '0',
      match: opts.match ?? '*',
      count: opts.count ?? 100,
    });
  } catch (e) {
    redisError.set(e instanceof ApiError ? e.message : (e as Error).message);
    return null;
  }
}

export async function fetchRedisKey(key: string): Promise<{ key: string; meta: any; sample: string } | null> {
  try {
    return await api.get(`/api/admin/redis/keys/${encodeURIComponent(key)}`);
  } catch (e) {
    redisError.set(e instanceof ApiError ? e.message : (e as Error).message);
    return null;
  }
}

export async function fetchSlowlog(count = 50): Promise<SlowLog | null> {
  try {
    return await api.get<SlowLog>('/api/admin/redis/slowlog', { count });
  } catch (e) {
    redisError.set(e instanceof ApiError ? e.message : (e as Error).message);
    return null;
  }
}

export async function fetchPubsubChannels(pattern = '*'): Promise<{ channels: string[] } | null> {
  try {
    return await api.get('/api/admin/redis/pubsub', { pattern });
  } catch (e) {
    redisError.set(e instanceof ApiError ? e.message : (e as Error).message);
    return null;
  }
}

export async function fetchClients(): Promise<{ clients: any[]; raw: string } | null> {
  try {
    return await api.get('/api/admin/redis/clients');
  } catch (e) {
    redisError.set(e instanceof ApiError ? e.message : (e as Error).message);
    return null;
  }
}