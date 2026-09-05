/**
 * Mullvad SOCKS sidecars — admin state.
 * Mirrors /api/admin/mullvad/status + control endpoints.
 */
import { writable, get } from 'svelte/store';
import { api, ApiError } from '../lib/api-client';

export interface MullvadIpInfo {
  ip: string;
  city: string;
  region: string;
  country: string;
  loc: string;
  org: string;
  postal: string;
  timezone: string;
  hostname: string;
}
export interface MullvadProxy {
  id: string;
  label: string;
  host: string;
  port: number;
  socksUrl: string;
  ip: string;
  container: string;
  containerState: 'running' | 'exited' | 'missing' | 'unknown' | string;
  containerStatus: string;
  tailscaleExitNode: string | null;
  ipinfo: MullvadIpInfo | null;
  healthy: boolean;
  error: string | null;
  lastTestedAt: string;
  /** am.i.mullvad.net's verdict for this sidecar: true only when the probe
   *  genuinely left through a Mullvad relay. False means the traffic is
   *  going out on the host's own uplink — the tailnet Mullvad grant or a
   *  licence seat is missing for this device. */
  mullvadExit?: boolean;
  /** Relay that answered, e.g. `de-ber-wg-003`. */
  mullvadHostname?: string;
  /** `organization` from the probe, e.g. `Mullvad VPN AB`. */
  organization?: string;
  /** Engine-published slot state (absent on engines older than the slot
   *  registry): where this exit currently is and whether it can be moved. */
  locationId?: string;
  city?: string;
  country?: string;
  state?: 'ready' | 'retargeting' | 'error' | string;
  /** Live IRC connections egressing through this slot. */
  activeConns?: number;
  heldUntilMs?: number;
  /** Engine can retarget this slot to another Mullvad city. */
  controllable?: boolean;
}
export interface MullvadUsage {
  pinned: number;
  active: number;
}
export interface MullvadAssociation {
  networkId: string;
  networkName: string;
  host: string;
  username: string;
  egressNodeId: string;
  activeEgressLabel: string;
}
export interface MullvadLiveConn {
  serverId: string;
  networkId: string;
  networkName: string;
  host: string;
  nick: string;
  activeEgressLabel: string;
  activeEgressHost: string;
  activeEgressIp: string;
  connectedSince: number;
}
export interface MullvadServerEgress {
  serverId: string;
  egressNodeId: string;
  networkCount: number;
  healthy: boolean;
}
export interface MullvadLocation {
  /** `<countryCode>-<cityCode>` — the value a slot swap targets. */
  id: string;
  country: string;
  countryCode: string;
  city: string;
  relays: number;
}
export interface MullvadStatus {
  pool: MullvadProxy[] | null;
  count: number;
  poolRaw: string;
  poolCount: number;
  desiredCount: number;
  usage: Record<string, MullvadUsage> | null;
  associations: MullvadAssociation[] | null;
  associationsTruncated?: boolean;
  liveConnections: Record<string, MullvadLiveConn[]> | null;
  liveConnectionsTotal: number;
  servers: MullvadServerEgress[] | null;
  serverEgress: MullvadServerEgress[] | null;
  /** Mullvad cities a retargetable slot can be swapped to. Empty when no
   *  slot is controllable (nothing to swap). */
  locations?: MullvadLocation[] | null;
  warning?: string | null;
}
export interface MullvadTestResult {
  label: string;
  healthy: boolean;
  ip: string;
  egressIp: string;
  checkedAt: string;
  error: string;
}
/** Outcome of driving a real IRC registration through one slot's SOCKS
 *  proxy — the only check that proves an exit is usable for IRC rather than
 *  merely reachable (a Z-lined exit is "healthy" and still useless). */
export interface MullvadIrcTestResult {
  label: string;
  host: string;
  port: number;
  nick: string;
  socksOk: boolean;
  /** The ircd spoke to us — so the exit reaches it even if it then refused. */
  reachedIrcd: boolean;
  registered: boolean;
  serverName: string;
  welcome: string;
  ms: number;
  error: string;
}

export const mullvadStatus = writable<MullvadStatus | null>(null);
export const mullvadLoading = writable(false);
export const mullvadError = writable<string | null>(null);
export const mullvadTesting = writable<Set<string>>(new Set());
export const mullvadRestarting = writable<Set<string>>(new Set());

export const mullvadSwapping = writable<Set<string>>(new Set());

/** Ask the engine that owns `label` to move that slot to `locationId`.
 *  A slot carrying live connections is refused with 409 + `needsForce`;
 *  call again with `force` once the operator has confirmed, and the engine
 *  bounces those connections so they come back on the new exit. */
export async function swapSlotExit(label: string, locationId: string, force = false): Promise<void> {
  const cur = get(mullvadSwapping);
  cur.add(label);
  mullvadSwapping.set(new Set(cur));
  try {
    await api.post(`/api/admin/mullvad/${encodeURIComponent(label)}/exit`, { locationId, force });
    // Optimistic: show the slot as switching until the next poll confirms.
    const st = get(mullvadStatus);
    if (st?.pool) {
      st.pool = st.pool.map((p) => (p.label === label ? { ...p, state: 'retargeting' } : p));
      mullvadStatus.set({ ...st });
    }
    await fetchMullvadStatus(true);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    mullvadError.set(msg);
    throw e;
  } finally {
    const s = get(mullvadSwapping);
    s.delete(label);
    mullvadSwapping.set(new Set(s));
  }
}
export async function fetchMullvadStatus(force = false): Promise<void> {
  void force;
  mullvadLoading.set(true);
  mullvadError.set(null);
  try {
    const data = await api.get<MullvadStatus>('/api/admin/mullvad/status');
    mullvadStatus.set(data);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    mullvadError.set(msg);
  } finally {
    mullvadLoading.set(false);
  }
}

export async function testProxy(label: string): Promise<MullvadTestResult> {
  const cur = get(mullvadTesting);
  cur.add(label);
  mullvadTesting.set(new Set(cur));
  try {
    const res = await api.post<MullvadTestResult>(`/api/admin/mullvad/${encodeURIComponent(label)}/test`);
    const st = get(mullvadStatus);
    if (st) {
      st.pool = st.pool.map((p) => (p.label === label ? { ...p, healthy: res.healthy, error: res.error, ip: res.ip || p.ip, lastTestedAt: res.checkedAt } : p));
      mullvadStatus.set({ ...st });
    }
    return res;
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    mullvadError.set(msg);
    throw e;
  } finally {
    const s = get(mullvadTesting);
    s.delete(label);
    mullvadTesting.set(new Set(s));
  }
}

/** Slots with an IRC probe in flight, and the last result per slot. */
export const mullvadIrcTesting = writable<Set<string>>(new Set());
export const mullvadIrcResults = writable<Record<string, MullvadIrcTestResult>>({});

/** Drives a real IRC registration through `label`'s SOCKS proxy. Defaults to
 *  the first-party ircd; pass a host to check a network that is prone to
 *  Z-lining exits (SuperNETs, Libera). */
export async function testIrcThroughProxy(
  label: string,
  host?: string,
  port?: number,
): Promise<MullvadIrcTestResult> {
  const cur = get(mullvadIrcTesting);
  cur.add(label);
  mullvadIrcTesting.set(new Set(cur));
  try {
    const body: Record<string, unknown> = {};
    if (host) body.host = host;
    if (port) body.port = port;
    const res = await api.post<MullvadIrcTestResult>(
      `/api/admin/mullvad/${encodeURIComponent(label)}/irc-test`, body);
    mullvadIrcResults.update((m) => ({ ...m, [label]: res }));
    return res;
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    mullvadError.set(msg);
    throw e;
  } finally {
    const s = get(mullvadIrcTesting);
    s.delete(label);
    mullvadIrcTesting.set(new Set(s));
  }
}

export async function testAll(): Promise<void> {
  const st = get(mullvadStatus);
  const labels = st?.pool.map((p) => p.label) ?? [];
  labels.forEach((l) => {
    const s = get(mullvadTesting);
    s.add(l);
    mullvadTesting.set(new Set(s));
  });
  try {
    const res = await api.post<{ results: MullvadTestResult[] }>('/api/admin/mullvad/test-all');
    const map = new Map<string, MullvadTestResult>();
    for (const r of res.results ?? []) map.set(r.label, r);
    const cur = get(mullvadStatus);
    if (cur) {
      cur.pool = cur.pool.map((p) => {
        const r = map.get(p.label);
        if (!r) return p;
        return { ...p, healthy: r.healthy, error: r.error, ip: r.ip || p.ip, lastTestedAt: r.checkedAt };
      });
      mullvadStatus.set({ ...cur });
    }
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    mullvadError.set(msg);
    throw e;
  } finally {
    mullvadTesting.set(new Set());
  }
}

export async function restartProxy(label: string): Promise<void> {
  const cur = get(mullvadRestarting);
  cur.add(label);
  mullvadRestarting.set(new Set(cur));
  try {
    await api.post(`/api/admin/mullvad/${encodeURIComponent(label)}/restart`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 1200);
    await promise;
    await fetchMullvadStatus(true);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    mullvadError.set(msg);
    throw e;
  } finally {
    const s = get(mullvadRestarting);
    s.delete(label);
    mullvadRestarting.set(new Set(s));
  }
}

export async function setServerEgress(serverId: string, label: string): Promise<void> {
  try {
    await api.post(`/api/admin/mullvad/server/${encodeURIComponent(serverId)}/egress`, { egressNodeId: label });
    await fetchMullvadStatus(true);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    mullvadError.set(msg);
    throw e;
  }
}

export async function clearServerEgress(serverId: string): Promise<void> {
  try {
    await api.delete(`/api/admin/mullvad/server/${encodeURIComponent(serverId)}/egress`);
    await fetchMullvadStatus(true);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    mullvadError.set(msg);
    throw e;
  }
}
