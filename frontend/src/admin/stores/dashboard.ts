/**
 * Dashboard store — fetches /api/admin/dashboard every 5s while
 * pollingEnabled is on. Pages subscribe for live updates.
 */
import { writable } from 'svelte/store';
import { api, ApiError } from '../lib/api-client';

export interface Engine {
  serverId: string;
  bindAddress: string;
  port: number;
  priority: number;
  maxConnections: number;
  fallbackOnly: boolean;
  assignedNetworkCount: number;
  healthy: boolean;
  lastHeartbeat: number;
  ageSeconds: number;
  /** Unix ms of the engine's hot-swap detach stamp (0 = none). */
  hotswapAt?: number;
  /** True while the engine is detached for a hot swap (sessions held). */
  hotswapActive?: boolean;
  /** Holder build short hash; absent = pre-holder engine, no data. */
  holderVersion?: string;
  holderPid?: number;
  holderOpen?: number;
  holderAttached?: number;
  holderDetached?: number;
}

export interface HostSummary {
  host: string;
  totalConns: number;
  serverIds: string[];
  status: 'safe' | 'warn' | 'full';
  capacity: number;
}

export interface RecentUser {
  id: string;
  username: string;
  email: string;
  roles: string[];
}

export interface DashboardData {
  userCount: number;
  activeSessions: number;
  totalNetworks: number;
  uploadCount: number;
  openSupportIssues: number;
  engineCount: number;
  healthyCount: number;
  maxConnsPerHost: number;
  engines: Engine[];
  hosts: HostSummary[];
  recentUsers: RecentUser[];
}

export const dashboard = writable<DashboardData | null>(null);
export const dashboardLoading = writable(false);
export const dashboardError = writable<string | null>(null);

let lastFetchedAt = 0;

export async function fetchDashboard(force = false): Promise<void> {
  if (!force && Date.now() - lastFetchedAt < 1_000) return;
  dashboardLoading.set(true);
  dashboardError.set(null);
  try {
    const data = await api.get<DashboardData>('/api/admin/dashboard');
    dashboard.set(data);
    lastFetchedAt = Date.now();
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    dashboardError.set(msg);
  } finally {
    dashboardLoading.set(false);
  }
}