import type { IRCMessage } from '../types';

const API_BASE = '/api';

function normalizeMessage(raw: Record<string, unknown>): IRCMessage {
  const t = raw.t as number | undefined;
  return {
    id: (raw.id as string) || (raw.i as string) || undefined,
    timestamp: (raw.timestamp as string) || (t ? new Date(t).toISOString() : undefined),
    t,
    nick: (raw.nick as string) || (raw.n as string) || undefined,
    text: (raw.text as string) || (raw.x as string) || undefined,
    command: (raw.command as string) || (raw.c as string) || '',
    params: (raw.params as string[]) || (raw.p as string[]) || [],
    prefix: (raw.prefix as string) || (raw.px as string) || undefined,
    msgid: (raw.msgid as string) || (raw.m as string) || undefined,
    label: (raw.label as string) || (raw.l as string) || undefined,
    type: raw.type as string | undefined,
  };
}

export async function fetchMe(): Promise<{ username: string; email: string }> {
  const r = await fetch(`${API_BASE}/me`);
  if (!r.ok) throw new Error('Failed to fetch user');
  return r.json();
}

export async function fetchHealth(): Promise<{
  status: string;
  services?: Record<string, { ok: boolean }>;
}> {
  const r = await fetch(`${API_BASE}/health`);
  if (!r.ok) throw new Error('Health check failed');
  return r.json();
}

/**
 * Options for `loadHistory`.
 *
 * For chathistory-capable networks the cursor fields are msgid-based
 * (`beforeMsgid` / `afterMsgid`) and the gateway can be asked to push a
 * fetch to the engine with `fetchFromUpstream: true` + an optional
 * `fetchCommand` (LATEST / BEFORE / AFTER) and `fetchRef` (msgid for
 * the upstream cursor). When the engine has the chathistory cap
 * negotiated, the gateway enqueues a CHATHISTORY command before
 * reading the local buffer, so the response can include messages that
 * just landed in the upstream.
 *
 * For networks without chathistory, the timestamp cursors (`before` /
 * `after`) are used and `fetchFromUpstream` is ignored.
 */
export interface LoadHistoryOptions {
  before?: number;
  after?: number;
  beforeMsgid?: string;
  afterMsgid?: string;
  count?: number;
  clearedAt?: number;
  fetchFromUpstream?: boolean;
  fetchCommand?: 'LATEST' | 'BEFORE' | 'AFTER' | 'AROUND' | 'BETWEEN';
  fetchRef?: string;
}

export async function loadHistory(
  networkId: string,
  bufferName: string,
  options?: LoadHistoryOptions
): Promise<IRCMessage[]> {
  const params = new URLSearchParams();
  params.set('count', String(options?.count ?? 100));
  if (options?.before) params.set('before', String(options.before));
  if (options?.after) params.set('after', String(options.after));
  if (options?.beforeMsgid) params.set('before_msgid', options.beforeMsgid);
  if (options?.afterMsgid) params.set('after_msgid', options.afterMsgid);
  if (options?.fetchFromUpstream) {
    params.set('fetch', '1');
    if (options.fetchCommand) params.set('fetch_command', options.fetchCommand);
    if (options.fetchRef) params.set('fetch_ref', options.fetchRef);
  }
  params.set('_cb', String(Date.now()));

  const url = `${API_BASE}/channels/${encodeURIComponent(networkId)}/${encodeURIComponent(bufferName)}/messages?${params}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Failed to load history');
  const raw = await r.json() as Record<string, unknown>[];
  return raw.map(normalizeMessage);
}

export async function reconnectNetwork(networkId: string): Promise<void> {
  const r = await fetch(`${API_BASE}/networks/${encodeURIComponent(networkId)}/reconnect`, { method: 'POST' });
  if (!r.ok) throw new Error('Reconnect failed');
}

export async function disconnectNetwork(networkId: string, reason: string = ''): Promise<void> {
  const r = await fetch(`${API_BASE}/networks/${encodeURIComponent(networkId)}/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason })
  });
  if (!r.ok) throw new Error('Disconnect failed');
}

export async function joinChannel(networkId: string, channel: string, key?: string): Promise<void> {
  const r = await fetch(`${API_BASE}/networks/${encodeURIComponent(networkId)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, key: key ?? '' })
  });
  if (!r.ok) throw new Error('Join failed');
}

export async function addNetwork(data: {
  name: string; host: string; port: number; tls: string; verifyTls: boolean;
  nick: string; realName: string; autoJoinChannels: string; nspass?: string;
  commands?: string;
}): Promise<void> {
  const payload = {
    ...data,
    autoJoinChannels: data.autoJoinChannels
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
  const r = await fetch(`${API_BASE}/networks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error('Add network failed');
}

export async function updateNetwork(networkId: string, data: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${API_BASE}/networks/${encodeURIComponent(networkId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error('Update network failed');
}

export async function deleteNetwork(networkId: string): Promise<void> {
  const r = await fetch(`${API_BASE}/networks/${encodeURIComponent(networkId)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('Delete network failed');
}
