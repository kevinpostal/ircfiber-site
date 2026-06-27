import type { IRCMessage } from '../types';
import { detectCtcpAction } from '../lib/messageHandler';
import { parseChannelList } from '../lib/utils';

const API_BASE = '/api';

function normalizeMessage(raw: Record<string, unknown>): IRCMessage {
  const t = raw.t as number | undefined;
  const eid = raw.eid as number | undefined;
  const command = (raw.command as string) || (raw.c as string) || '';
  let text = (raw.text as string) || (raw.x as string) || undefined;
  let type = raw.type as string | undefined;
  // History-loaded PRIVMSGs still carry the raw \x01ACTION ...\x01 CTCP
  // markers from the engine. Unwrap them here so /me messages render as
  // actions instead of literal control characters.
  if (text) {
    const action = detectCtcpAction(command, text);
    if (action) {
      text = action.text;
      type = action.type;
    }
  }
  return {
    id: (raw.id as string) || (raw.i as string) || undefined,
    timestamp: (raw.timestamp as string) || (t ? new Date(t).toISOString() : undefined),
    t,
    eid: (eid != null && eid > 0) ? eid : undefined,
    nick: (raw.nick as string) || (raw.n as string) || undefined,
    text,
    command,
    params: (raw.params as string[]) || (raw.p as string[]) || [],
    prefix: (raw.prefix as string) || (raw.px as string) || undefined,
    msgid: (raw.msgid as string) || (raw.m as string) || (raw.i as string) || undefined,
    label: (raw.label as string) || (raw.l as string) || undefined,
    type,
  };
}

export interface MeResponse {
  username: string;
  email: string;
  pinnedChannels?: string[];
  archivedChannels?: string[];
  membersCollapsed?: Record<string, boolean>;
  collapsed?: Record<string, boolean>;
  inactiveCollapsed?: Record<string, boolean>;
  networkOrder?: string[];
  bufferPrefs?: Record<string, Record<string, boolean>>;
}

export async function fetchMe(): Promise<MeResponse> {
  const r = await fetch(`${API_BASE}/me`);
  if (!r.ok) throw new Error('Failed to fetch user');
  return r.json();
}

export async function pinChannel(networkId: string, channel: string): Promise<void> {
  const r = await fetch(`${API_BASE}/me/pins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ network: networkId, channel })
  });
  if (!r.ok) throw new Error('Pin failed');
}

export async function unpinChannel(networkId: string, channel: string): Promise<void> {
  const r = await fetch(`${API_BASE}/me/pins/${encodeURIComponent(networkId)}/${encodeURIComponent(channel)}`, {
    method: 'DELETE'
  });
  if (!r.ok) throw new Error('Unpin failed');
}

export async function archiveChannel(networkId: string, channel: string): Promise<void> {
  const r = await fetch(`${API_BASE}/me/archives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ network: networkId, channel })
  });
  if (!r.ok) throw new Error('Archive failed');
}

export async function unarchiveChannel(networkId: string, channel: string): Promise<void> {
  const r = await fetch(`${API_BASE}/me/archives/${encodeURIComponent(networkId)}/${encodeURIComponent(channel)}`, {
    method: 'DELETE'
  });
  if (!r.ok) throw new Error('Unarchive failed');
}

export async function updateCollapsed(networkId: string, collapsed: boolean): Promise<void> {
  const r = await fetch(`${API_BASE}/me/collapsed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ network: networkId, collapsed })
  });
  if (!r.ok) throw new Error('Update collapsed failed');
}

export async function updateInactiveCollapsed(networkId: string, collapsed: boolean): Promise<void> {
  const r = await fetch(`${API_BASE}/me/inactive-collapsed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ network: networkId, collapsed })
  });
  if (!r.ok) throw new Error('Update inactive collapsed failed');
}

export async function updateNetworkOrder(order: string[]): Promise<void> {
  const r = await fetch(`${API_BASE}/me/network-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order })
  });
  if (!r.ok) throw new Error('Update network order failed');
}

export async function updateServerlogCollapsed(
  networkId: string,
  eid?: number,
  msgid?: string,
  collapsed?: boolean,
): Promise<void> {
  const body: Record<string, unknown> = { network: networkId, collapsed: !!collapsed };
  if (eid != null) body.eid = String(eid);
  else if (msgid) body.msgid = msgid;
  const r = await fetch(`${API_BASE}/me/serverlog-collapsed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Update serverlog collapsed failed');
}

export async function updateMembersCollapsed(networkId: string, channel: string, collapsed: boolean): Promise<void> {
  const r = await fetch(`${API_BASE}/me/members-collapsed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ network: networkId, channel, collapsed })
  });
  if (!r.ok) throw new Error('Update members collapsed failed');
}

export async function updateBufferPrefs(
  networkId: string,
  bufferName: string,
  prefs: Record<string, boolean | undefined>
): Promise<void> {
  const r = await fetch(`${API_BASE}/me/buffer-prefs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ network: networkId, channel: bufferName, prefs })
  });
  if (!r.ok) throw new Error('Update buffer prefs failed');
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
  /** IRCCloud-style cursor: single msgid for paginating older history.
   *  Alias for beforeMsgid; the backend accepts both. */
  beforeid?: string;
  count?: number;
  clearedAt?: number;
  fetchFromUpstream?: boolean;
  fetchCommand?: 'LATEST' | 'BEFORE' | 'AFTER' | 'AROUND' | 'BETWEEN';
  fetchRef?: string;
}

/** Response envelope from the messages endpoint. The backend wraps the
 *  message list with pagination metadata so the frontend can decide
 *  when to stop loading. */
export interface LoadHistoryResponse {
  messages: IRCMessage[];
  /** Total messages in permanent storage for this buffer. */
  backlog_size: number;
  /** Msgid of the oldest message in this response (use for next
   *  scroll-back cursor). Empty if no msgid available. */
  earliest_msgid: string;
  /** Timestamp of the oldest message in this response (fallback cursor
   *  when earliest_msgid is empty — messages without msgids use this). */
  earliest_ts: number;
  /** EID of the oldest message in this response (primary cursor —
   *  IRCCloud-style beforeid pagination). */
  earliest_eid: number;
  /** How many of the returned messages came from the Redis hot cache. */
  cache_size: number;
}

/** Fetch history with full pagination metadata. Returns the envelope
 *  including `backlog_size` (total count) and `earliest_msgid` (cursor
 *  for next scroll-back request). */
export async function loadHistoryWithMeta(
  networkId: string,
  bufferName: string,
  options?: LoadHistoryOptions
): Promise<LoadHistoryResponse> {
  const params = new URLSearchParams();
  params.set('count', String(options?.count ?? 100));
  if (options?.before) params.set('before', String(options.before));
  if (options?.after) params.set('after', String(options.after));
  if (options?.beforeMsgid) params.set('before_msgid', options.beforeMsgid);
  if (options?.afterMsgid) params.set('after_msgid', options.afterMsgid);
  if (options?.beforeid) params.set('beforeid', options.beforeid);
  if (options?.fetchFromUpstream) {
    params.set('fetch', '1');
    if (options.fetchCommand) params.set('fetch_command', options.fetchCommand);
    if (options.fetchRef) params.set('fetch_ref', options.fetchRef);
  }
  params.set('_cb', String(Date.now()));

  const url = `${API_BASE}/channels/${encodeURIComponent(networkId)}/${encodeURIComponent(bufferName)}/messages?${params}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Failed to load history');
  const raw = await r.json() as Record<string, unknown>;

  // New envelope: {messages: [...], backlog_size, earliest_msgid, cache_size}
  // Legacy: bare array of messages
  if (Array.isArray(raw)) {
    return {
      messages: raw.map(normalizeMessage),
      backlog_size: raw.length,
      earliest_msgid: '',
      earliest_ts: 0,
      earliest_eid: 0,
      cache_size: raw.length
    };
  }

  const msgList = (raw.messages ?? []) as Record<string, unknown>[];
  return {
    messages: msgList.map(normalizeMessage),
    backlog_size: Number(raw.backlog_size ?? msgList.length),
    earliest_msgid: String(raw.earliest_msgid ?? ''),
    earliest_ts: Number(raw.earliest_ts ?? 0),
    earliest_eid: Number(raw.earliest_eid ?? 0),
    cache_size: Number(raw.cache_size ?? msgList.length)
  };
}

export async function loadHistory(
  networkId: string,
  bufferName: string,
  options?: LoadHistoryOptions
): Promise<IRCMessage[]> {
  const result = await loadHistoryWithMeta(networkId, bufferName, options);
  return result.messages;
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
  name: string; host: string; port: number; tls: string;
  nick: string; realName: string; autoJoinChannels: string; nspass?: string;
  commands?: string; sasl?: string; saslUsername?: string; saslPassword?: string;
}): Promise<Record<string, unknown>> {
  const payload = {
    ...data,
    autoJoinChannels: parseChannelList(data.autoJoinChannels),
  };
  const r = await fetch(`${API_BASE}/networks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error('Add network failed');
  return r.json();
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

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const r = await fetch(`${API_BASE}/me/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword, newPassword })
  });
  if (!r.ok) throw new Error('Change password failed');
}

export async function deleteAccount(): Promise<void> {
  const r = await fetch(`${API_BASE}/me`, { method: 'DELETE' });
  if (!r.ok) throw new Error('Delete account failed');
}

export async function uploadAvatar(file: File): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append('avatar', file);
  const r = await fetch(`${API_BASE}/me/avatar`, {
    method: 'POST',
    body: formData
  });
  if (!r.ok) throw new Error('Upload avatar failed');
  return r.json();
}

export async function removeAvatar(): Promise<void> {
  const r = await fetch(`${API_BASE}/me/avatar`, { method: 'DELETE' });
  if (!r.ok) throw new Error('Remove avatar failed');
}

export interface UploadEntry {
  id: string; url: string; name: string; mimeType: string;
  size: number; createdAt: number; buffer: string; networkId: string;
}

export async function fetchUploads(before?: number, limit = 25): Promise<UploadEntry[]> {
  const params = new URLSearchParams();
  if (before) params.set('before', String(before));
  params.set('limit', String(limit));
  const r = await fetch(`${API_BASE}/uploads?${params}`);
  if (!r.ok) throw new Error('Failed to fetch uploads');
  return (await r.json()).uploads;
}

export async function fetchUploadsOffset(offset = 0, limit = 25): Promise<{ entries: UploadEntry[]; total: number }> {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  const r = await fetch(`${API_BASE}/uploads?${params}`);
  if (!r.ok) throw new Error('Failed to fetch uploads');
  const body = await r.json();
  return { entries: body.uploads, total: body.total ?? 0 };
}

export async function deleteUpload(id: string): Promise<void> {
  const r = await fetch(`${API_BASE}/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('Delete failed');
}

export interface PasteEntry {
  id: string; name: string; syntax: string; lines: number;
  body: string; createdAt: number; buffer: string; networkId: string;
}

export async function fetchPastebinsOffset(offset = 0, limit = 25): Promise<{ entries: PasteEntry[]; total: number }> {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  const r = await fetch(`${API_BASE}/pastebins?${params}`);
  if (!r.ok) throw new Error('Failed to fetch pastebins');
  const body = await r.json();
  return { entries: body.pastebins, total: body.total ?? 0 };
}

export async function createPastebin(data: { name?: string; body: string; syntax?: string; networkId?: string; buffer?: string }): Promise<PasteEntry> {
  const r = await fetch(`${API_BASE}/pastebins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error('Failed to create pastebin');
  return r.json();
}

export async function updatePastebin(id: string, data: { name: string; syntax: string }): Promise<PasteEntry> {
  const r = await fetch(`${API_BASE}/pastebins/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error('Failed to update pastebin');
  return r.json();
}

export async function deletePastebin(id: string): Promise<void> {
  const r = await fetch(`${API_BASE}/pastebins/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('Delete failed');
}

export function pastebinRawUrl(id: string): string {
  return `${API_BASE}/pastebins/${encodeURIComponent(id)}/raw`;
}
