/**
 * Replication store — fetches /api/admin/replication every 5s.
 * Shows Mongo rs0 lag and Redis global-keys / shake health.
 */
import { writable } from 'svelte/store';
import { api, ApiError } from '../lib/api-client';

export interface MongoMember {
  name: string;
  health: number;
  state: number;
  stateStr: string;
  uptime?: number;
  optimeDate?: unknown;
  optime?: unknown;
  lastHeartbeat?: unknown;
  syncSourceHost?: string;
  infoMessage?: string;
}

export interface MongoReplication {
  connected: boolean;
  dbName: string;
  isReplicaSet?: boolean;
  singleNode?: boolean;
  replicaSet?: string;
  primary?: string;
  myState?: number;
  members?: MongoMember[];
  memberCount?: number;
  healthyCount?: number;
  secondaryCount?: number;
  hasPrimary?: boolean;
  replicaSetError?: string;
  authError?: boolean;
  serverStatus?: Record<string, unknown>;
  dbStats?: Record<string, unknown>;
  error?: string;
}

export interface RedisStatus {
  connected: boolean;
  replication?: Record<string, unknown>;
  server?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  dbsize?: number;
  globalKeys?: { assignments: number; servers: number; globalEid: string; protocolVersion: string };
  shake?: { expected: boolean; status: string; reason: string; allowlist: string[] };
  keyspace?: Record<string, string>;
  error?: string;
}

export interface ReplicationData {
  timestamp: number;
  mongo: MongoReplication;
  redis: RedisStatus;
  overall: { mongoOk: boolean; redisOk: boolean; inSync: boolean; status: string };
}

export const replication = writable<ReplicationData | null>(null);
export const replicationLoading = writable(false);
export const replicationError = writable<string | null>(null);

let lastFetchedAt = 0;

export async function fetchReplication(force = false): Promise<void> {
  if (!force && Date.now() - lastFetchedAt < 2_000) return;
  replicationLoading.set(true);
  replicationError.set(null);
  try {
    const data = await api.get<ReplicationData>('/api/admin/replication');
    replication.set(data);
    lastFetchedAt = Date.now();
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    replicationError.set(msg);
  } finally {
    replicationLoading.set(false);
  }
}
