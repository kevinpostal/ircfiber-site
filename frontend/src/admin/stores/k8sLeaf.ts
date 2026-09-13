/**
 * K8s leaf store — the k3s InspIRCd leaf (k8s.ircfiber.com) behind
 * /api/admin/ircd/leaf.
 *
 * The leaf's Deployment replica count is the single source of truth for
 * "on": the hub only declares the `<link>` and never dials it (its
 * `<autoconnect>` was removed — a 16s retry against an evicted pod storms
 * every peer network with REMOTELINK snotices). Start/Stop here are the
 * only dialer, together with the gateway's once-a-minute reconcile.
 */
import { writable } from 'svelte/store';
import { api, ApiError } from '../lib/api-client';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface LeafCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface LeafPreflight {
  ok: boolean;
  checks: LeafCheck[];
}

export interface LeafDeployment {
  exists: boolean;
  desired: number;
  ready: number;
  updated: number;
  image: string;
  /** "True" / "False" / "" — the Available condition's status, not a bool. */
  available: string;
  message: string;
}

export interface LeafPod {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
  startedAtMs: number;
  message: string;
}

export interface LeafNode {
  found: boolean;
  ready: boolean;
  diskPressure: boolean;
  memoryPressure: boolean;
  pidPressure: boolean;
  unschedulable: boolean;
  diskPressureTaint: boolean;
}

export interface LeafLink {
  present: boolean;
  ipaddr: string;
  port: string;
  autoconnect: boolean;
}

export type LeafState = 'on' | 'off' | 'starting' | 'degraded';

export interface LeafStatus {
  name: string;
  state: LeafState;
  linked: boolean;
  k8sConfigured: boolean;
  /** Non-empty when the k3s API answered with an error instead of state. */
  k8sError: string;
  deployment: LeafDeployment;
  pod: LeafPod;
  node: LeafNode;
  link: LeafLink;
  /** Present on the stop response only (the SQUIT notice). */
  notice?: string;
}

export interface LeafStartResult {
  linked: boolean;
  notice: string;
  elapsedMs: number;
  state: LeafState;
  /** Only sent when the CONNECT did not link — the failure reason is in it. */
  podLogTail?: string[];
}

export const leaf = writable<LeafStatus | null>(null);
export const leafLoading = writable(false);
export const leafError = writable<string | null>(null);

/** `quiet` keeps the last error visible while a poll runs in the background. */
export async function fetchLeaf(quiet = false): Promise<void> {
  if (!quiet) leafLoading.set(true);
  try {
    const s = await api.get<LeafStatus>('/api/admin/ircd/leaf');
    leaf.set(s);
    leafError.set(null);
  } catch (e) {
    leafError.set(e instanceof ApiError ? e.message : (e as Error).message);
  } finally {
    if (!quiet) leafLoading.set(false);
  }
}

/** Cluster + hub checks. Throws ApiError; never mutates anything. */
export async function runPreflight(): Promise<LeafPreflight> {
  return api.get<LeafPreflight>('/api/admin/ircd/leaf/preflight');
}

/**
 * Scale to 1, wait for a ready pod, CONNECT. Throws ApiError: 409 when a
 * preflight check failed and `force` is false, 504 when the pod never
 * became ready. The wait is up to 120s plus the CONNECT poll, so the
 * request timeout is raised well past the client default.
 */
export async function startLeaf(force: boolean): Promise<LeafStartResult> {
  return api.post<LeafStartResult>('/api/admin/ircd/leaf/start', { force }, undefined,
    { timeoutMs: 180_000 });
}

/** SQUIT (when linked), then scale to 0. Returns the settled status. */
export async function stopLeaf(reason: string): Promise<LeafStatus> {
  return api.post<LeafStatus>('/api/admin/ircd/leaf/stop', { reason }, undefined,
    { timeoutMs: 60_000 });
}
