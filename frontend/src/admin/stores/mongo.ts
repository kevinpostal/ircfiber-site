/**
 * Mongo monitor store — connection status, db stats, collections list.
 * Pages fetch on demand; we cache for 30s to avoid hammering the server.
 */
import { writable } from 'svelte/store';
import { api, ApiError } from '../lib/api-client';

export interface MongoStatus {
  connected: boolean;
  dbName: string;
  dbStats?: {
    collections?: number;
    objects?: number;
    dataSize?: number;
    storageSize?: number;
    indexes?: number;
    indexSize?: number;
    avgObjSize?: number;
  };
  serverStatus?: {
    host?: string;
    version?: string;
    process?: string;
    pid?: number | string;
    uptime?: number;
    connections?: { current?: number; available?: number; totalCreated?: number; active?: number };
    mem?: { resident?: number; virtual?: number; mapped?: number };
    opcounters?: Record<string, number>;
  };
  error?: string;
}

export interface MongoCollection {
  name: string;
  count: number;
  size: number;
  avgObjSize?: number;
  storageSize?: number;
  totalIndexSize?: number;
  indexes?: number;
}

export const mongoStatus = writable<MongoStatus | null>(null);
export const mongoCollections = writable<MongoCollection[]>([]);
export const mongoLoading = writable(false);
export const mongoError = writable<string | null>(null);

let lastStatusFetchedAt = 0;
let lastCollectionsFetchedAt = 0;

export async function fetchMongoStatus(force = false): Promise<void> {
  if (!force && Date.now() - lastStatusFetchedAt < 5_000) return;
  mongoLoading.set(true);
  mongoError.set(null);
  try {
    const s = await api.get<MongoStatus>('/api/admin/mongo/status');
    mongoStatus.set(s);
    lastStatusFetchedAt = Date.now();
  } catch (e) {
    mongoError.set(e instanceof ApiError ? e.message : (e as Error).message);
  } finally {
    mongoLoading.set(false);
  }
}

export async function fetchMongoCollections(force = false): Promise<void> {
  if (!force && Date.now() - lastCollectionsFetchedAt < 5_000) return;
  try {
    const res = await api.get<{ collections: MongoCollection[] }>('/api/admin/mongo/collections');
    mongoCollections.set(res.collections ?? []);
    lastCollectionsFetchedAt = Date.now();
  } catch (e) {
    mongoError.set(e instanceof ApiError ? e.message : (e as Error).message);
  }
}

export interface MongoCollectionDetail {
  name: string;
  connected: boolean;
  stats: any;
  indexes: any[];
  error?: string;
}

export async function fetchMongoCollectionDetail(name: string): Promise<MongoCollectionDetail | null> {
  try {
    return await api.get<MongoCollectionDetail>(`/api/admin/mongo/collections/${encodeURIComponent(name)}`);
  } catch (e) {
    mongoError.set(e instanceof ApiError ? e.message : (e as Error).message);
    return null;
  }
}

export async function runMongoQuery(req: {
  collection: string;
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  sort?: Record<string, number>;
  limit?: number;
  maxTimeMs?: number;
}): Promise<{ collection: string; count: number; results: any[]; limit: number; maxTimeMs: number } | null> {
  try {
    return await api.post('/api/admin/mongo/query', req);
  } catch (e) {
    mongoError.set(e instanceof ApiError ? e.message : (e as Error).message);
    return null;
  }
}