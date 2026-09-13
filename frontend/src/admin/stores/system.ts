/**
 * System monitor store — host CPU/memory/disk/network plus the Docker
 * containers on the host the gateway runs on.
 *
 * One snapshot endpoint feeds the whole page (`GET /api/admin/system`); the
 * backend collects on a 5 s background thread, so polling faster than that
 * just re-reads the same sample. Container actions and log tails are
 * on-demand and let `ApiError` propagate so the page can toast it.
 *
 * `SystemSnapshot` mirrors `snapshotToJson` in
 * `site/backend/source/ircfiber/web/admin/system.d` field for field.
 */
import { writable } from 'svelte/store';
import { api, ApiError } from '../lib/api-client';

export interface SystemHost {
  hostname: string;
  kernel: string;
  os: string;
  ncpu: number;
  uptimeSeconds: number;
  dockerVersion: string;
  containersRunning: number;
  containersTotal: number;
  images: number;
}

export interface SystemCpu {
  percent: number;
  userPercent: number;
  systemPercent: number;
  iowaitPercent: number;
  stealPercent: number;
  load1: number;
  load5: number;
  load15: number;
  load1PerCpu: number;
  procsRunnable: number;
  procsTotal: number;
}

export interface SystemMemory {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  percent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  swapPercent: number;
}

export interface SystemFilesystem {
  device: string;
  mountPoint: string;
  fsType: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  percent: number;
}

export interface SystemInterface {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  rxErrors: number;
  txErrors: number;
  rxDropped: number;
  txDropped: number;
}

export interface SystemDisk {
  name: string;
  readBytesPerSec: number;
  writeBytesPerSec: number;
  readsPerSec: number;
  writesPerSec: number;
}

export interface SystemContainer {
  /** Short 12-hex id, display only — actions address containers by name. */
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  health: string;
  createdAtMs: number;
  ports: string[];
  /** null when no cgroup stats resolved for this container. */
  cpuPercent: number | null;
  memBytes: number | null;
  /** -1 = no container limit; percent is then against host MemTotal. */
  memLimitBytes: number;
  memPercent: number | null;
  pids: number | null;
  /** This gateway container: state actions are refused server-side too. */
  self: boolean;
  controllable: boolean;
  /**
   * `stop` is refused by the backend (ingress, datastores, ircd, watchdog):
   * nothing restarts a container stopped through the Docker API, and the
   * Start button that would fix it may run through the container being
   * stopped. `restart` and `start` stay available.
   */
  stopProtected: boolean;
  controlReason: string;
}

export interface SystemHistoryPoint {
  atMs: number;
  cpuPercent: number;
  memPercent: number;
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

export interface SystemSnapshot {
  available: boolean;
  reason: string;
  collectedAtMs: number;
  statsSource: string;
  dockerError: string;
  networkSource: string;
  host: SystemHost;
  cpu: SystemCpu;
  memory: SystemMemory;
  filesystems: SystemFilesystem[];
  network: SystemInterface[];
  disks: SystemDisk[];
  containers: SystemContainer[];
  history: SystemHistoryPoint[];
}

export type ContainerActionName = 'start' | 'stop' | 'restart';

export const system = writable<SystemSnapshot | null>(null);
export const systemLoading = writable(false);
export const systemError = writable<string | null>(null);

let lastFetchedAt = 0;

export async function fetchSystem(force = false): Promise<void> {
  if (!force && Date.now() - lastFetchedAt < 2_000) return;
  systemLoading.set(true);
  systemError.set(null);
  try {
    const s = await api.get<SystemSnapshot>('/api/admin/system');
    system.set(s);
    lastFetchedAt = Date.now();
  } catch (e) {
    systemError.set(e instanceof ApiError ? e.message : (e as Error).message);
  } finally {
    systemLoading.set(false);
  }
}

/** Throws ApiError (409 self, 403 not allowlisted, 404, 503 socket down). */
export async function containerAction(name: string, action: ContainerActionName): Promise<void> {
  await api.post(`/api/admin/system/containers/${encodeURIComponent(name)}/${action}`);
}

/** Demuxed log tail. Throws ApiError when the socket is unreachable. */
export async function containerLogs(name: string, tail = 200): Promise<string> {
  const r = await api.get<{ name: string; tail: number; text: string }>(
    `/api/admin/system/containers/${encodeURIComponent(name)}/logs`,
    { tail },
  );
  return r.text ?? '';
}
