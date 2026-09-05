import type { IRCMessage } from '../types';
import { detectCtcpAction } from '../lib/messageHandler';
import { parseChannelList } from '../lib/utils';
// VITE_API_BASE is optional Vite env for swappable backend (Step 3); default /api behind Caddy.
const viteEnv = import.meta.env as { VITE_API_BASE?: string };
const API_BASE = viteEnv.VITE_API_BASE ?? '/api';

/**
 * Unpack a wire-format event (compact JSON keys `i, c, x, n, m, p, hm, px, l, ch, se, phase, ...`)
 * shape used everywhere in the frontend. Idempotent: calling it on a value
 * that's already in the IRCMessage shape returns an equivalent message.
 *
 * Exported so sync payloads (which carry the wire-format `messages[]` from
 * the server's Redis scrollback) can be normalized before reaching
 * ircState.messages — without this normalization, the frontend's
 * ServerLog sees `msg.text === undefined` for events stored under
 * `x` and the row body renders empty. See the WebSocket sync
 * path in ircStore.svelte.ts (updateNetworkFromSync) for the consumer.
 */
export function normalizeMessage(raw: Record<string, unknown>): IRCMessage {
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
  // Phase tag (set by IRCRawEvent.makeServerLog in the engine) lives in
  // the IRCv3 tags object alongside server-time / msgid. The compact
  // wire format inlines it as `phase` for low-overhead access on the hot
  // path; the long-form REST history keeps it under `tags.phase`. Pick
  // whichever is present so REST-loaded server-log progress entries are
  // classified as 'phase' (timeline chip) instead of 'notice' (raw IRC).
  // Mirrors the unpackEvent() path used by the WebSocket live event handler.
  const tags = raw.tags as Record<string, string> | undefined;
  const phase = (raw.phase as string | undefined)
    ?? tags?.phase
    ?? undefined;
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
    phase,
    selfEcho: !!(raw.se as string | undefined) || !!(raw.selfEcho as boolean | undefined),
  };
}

export interface MeResponse {
  id: string;
  username: string;
  email: string;
  pinnedChannels?: string[];
  archivedChannels?: string[];
  membersCollapsed?: Record<string, boolean>;
  collapsed?: Record<string, boolean>;
  inactiveCollapsed?: Record<string, boolean>;
  networkOrder?: string[];
  bufferPrefs?: Record<string, Record<string, boolean>>;
  showMemberPrefixes?: boolean;
  desktopNotifications?: boolean;
  notificationSound?: boolean;
  autoDismissNotifs?: boolean;
  muteAll?: boolean;
  prefVersion?: number;
}

export interface NotificationPrefs {
  desktopNotifications: boolean;
  notificationSound: boolean;
  autoDismissNotifs: boolean;
  muteAll: boolean;
}

export async function updateNotificationPrefs(patch: Partial<NotificationPrefs>): Promise<number> {
  const r = await fetch(`${API_BASE}/me/notification-prefs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(txt || 'Update notification prefs failed');
  }
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  return typeof j.prefVersion === 'number' ? j.prefVersion : 0;
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

/** Rewrites the order of the Pinned section. The server treats the payload
 *  as a reordering only: unknown ids are dropped and omitted pins keep their
 *  place, so a stale tab cannot unpin by omission. */
export async function updatePinnedOrder(order: string[]): Promise<void> {
  const r = await fetch(`${API_BASE}/me/pin-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order })
  });
  if (!r.ok) throw new Error('Pin reorder failed');
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

export async function clearBacklog(networkId: string, bufferName: string): Promise<void> {
  const r = await fetch(`${API_BASE}/networks/${encodeURIComponent(networkId)}/buffers/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buffer: bufferName })
  });
  if (!r.ok) throw new Error('Clear backlog failed');
}

export async function disconnectNetwork(networkId: string, reason: string = ''): Promise<void> {
  const r = await fetch(`${API_BASE}/networks/${encodeURIComponent(networkId)}/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason })
  });
  if (!r.ok) throw new Error('Disconnect failed');
}

/** GET/POST/DELETE /networks/:id/bouncer — "Connect with another client…". */
export interface BouncerInfo {
  enabled: boolean;
  host: string;
  port: number;
  tls: boolean;
  /** `bnc:<token>` or null when no password has been generated. */
  password: string | null;
  /** Lines per buffer replayed on attach for clients without CHATHISTORY (0 = none). */
  playbackLines: number;
  /** Server-side cap for `playbackLines`. */
  playbackMax: number;
}

export async function fetchBouncer(networkId: string): Promise<BouncerInfo> {
  const r = await fetch(`${API_BASE}/networks/${encodeURIComponent(networkId)}/bouncer`);
  if (!r.ok) throw new Error('Could not load bouncer settings');
  return r.json();
}

export async function generateBouncerPassword(networkId: string): Promise<BouncerInfo> {
  const r = await fetch(`${API_BASE}/networks/${encodeURIComponent(networkId)}/bouncer`, { method: 'POST' });
  if (!r.ok) throw new Error('Could not generate bouncer password');
  return r.json();
}

/** POST /me/bnc-playback-lines — persists the bouncer playback size; returns the clamped value. */
export async function updateBncPlaybackLines(value: number): Promise<number> {
  const r = await fetch(`${API_BASE}/me/bnc-playback-lines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!r.ok) throw new Error('Could not save playback setting');
  return (await r.json() as { value: number }).value;
}

export async function revokeBouncerPassword(networkId: string): Promise<void> {
  const r = await fetch(`${API_BASE}/networks/${encodeURIComponent(networkId)}/bouncer`, { method: 'DELETE' });
  if (!r.ok) throw new Error('Could not revoke bouncer password');
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
  autoJoinDelaySeconds?: number; egressNodeId?: string;
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
  if (!r.ok) throw new Error(await serverError(r, 'Add network failed'));
  return r.json();
}

/**
 * One-click provisioning of the platform IRC Fiber network. Signup runs the
 * same helper server-side, but that call is best-effort (admin kill-switch,
 * Mongo/Redis hiccup) and pre-feature accounts never got one — the Welcome
 * page offers this as a first-class action. Idempotent server-side.
 */
export async function provisionDefaultFiber(): Promise<Record<string, unknown>> {
  const r = await fetch(`${API_BASE}/networks/default-fiber`, { method: 'POST' });
  if (!r.ok) throw new Error(await serverError(r, 'IRC Fiber is not available right now'));
  return r.json();
}

export async function updateNetwork(networkId: string, data: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${API_BASE}/networks/${encodeURIComponent(networkId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(await serverError(r, 'Update network failed'));
}

export async function deleteNetwork(networkId: string): Promise<void> {
  const r = await fetch(`${API_BASE}/networks/${encodeURIComponent(networkId)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('Delete network failed');
}

/** Reads the server's `{"error": "..."}` body so 400/409 copy (e.g. "All 3
 *  exits are in use.") reaches the form instead of a generic failure. */
async function serverError(r: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await r.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const msg = body.error;
      if (typeof msg === 'string' && msg.length > 0) return msg;
    }
  } catch {
    // Non-JSON body — fall through to the generic message.
  }
  return fallback;
}

/** One egress slot from `GET /api/egress`: a long-lived SOCKS sidecar the
 *  engine retargets to a Mullvad city on demand. `exitIp` is empty until the
 *  gateway's background probe has run once. */
export interface EgressSlot {
  serverId: string; label: string; host: string; port: number;
  locationId: string; hostname: string; country: string; countryCode: string; city: string;
  controllable: boolean; state: 'ready' | 'retargeting' | 'error'; activeConns: number;
  heldUntilMs: number; exitIp: string; healthy: boolean; checkedAtMs: number; error: string;
}

/** One pickable Mullvad city. `id` is `<countryCode>-<cityCode>`. */
export interface EgressLocation {
  id: string; country: string; countryCode: string; city: string; relays: number;
}

/** `GET /api/egress`. `freeSlots` counts exits that could be retargeted to a
 *  new location right now; 0 means only locations already running are
 *  pickable without disturbing someone else's connection. */
export interface EgressInfo {
  direct: string; controllable: boolean; slotCount: number; freeSlots: number;
  slots: EgressSlot[]; locations: EgressLocation[];
}

export async function fetchEgress(): Promise<EgressInfo> {
  const r = await fetch(`${API_BASE}/egress`);
  if (!r.ok) throw new Error('Fetch egress failed');
  return r.json();
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

export async function fetchUploadById(id: string): Promise<UploadEntry> {
  const r = await fetch(`${API_BASE}/uploads/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error('Failed to fetch upload');
  return await r.json();
}

export async function editUpload(id: string, data: { content: string; filename: string }): Promise<{ status: string }> {
  const r = await fetch(`${API_BASE}/uploads/${encodeURIComponent(id)}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error('Failed to edit');
  return r.json();
}
export interface PasteEntry {
  id: string; name: string; syntax: string; lines: number;
  body: string; createdAt: number; buffer: string; networkId: string; userId: string;
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

export async function updatePastebin(id: string, data: { name: string; syntax: string; body?: string }): Promise<PasteEntry> {
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

export async function fetchPastebinById(id: string): Promise<PasteEntry> {
  const r = await fetch(`${API_BASE}/pastebins/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(r.status === 404 ? 'Not found' : 'Failed to fetch paste');
  return await r.json();
}
export function pastebinUrl(id: string): string { return `/?/pastebin=${encodeURIComponent(id)}`; }

export function pastebinRawUrl(id: string): string {
  return `${API_BASE}/pastebins/${encodeURIComponent(id)}/raw`;
}
export interface ArchiveNamesResponse {
  archives: Record<string, string[]>;
}

/** W3-T01a: Fetch all archived buffer names grouped by networkId.
 *  Server-side cached with 5-min TTL; caller should also cache client-side. */
export async function fetchArchiveNames(): Promise<ArchiveNamesResponse> {
  const r = await fetch(`${API_BASE}/buffers/archive-names`);
  if (!r.ok) throw new Error('Failed to fetch archive names');
  return r.json();
}
export interface IrcArtSaveEntry {
  id: string; name: string;
  originalFilename: string; originalMime: string; originalSize: number;
  originalUrl: string; thumbnailUrl: string;
  art: string; params: Record<string, unknown>;
  createdAt: number; updatedAt: number;
  buffer: string; networkId: string;
}

export async function fetchIrcArtSavesOffset(offset = 0, limit = 25): Promise<{ entries: IrcArtSaveEntry[]; total: number }> {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  const r = await fetch(`${API_BASE}/img2irc-saves?${params}`);
  if (!r.ok) throw new Error('Failed to fetch IRC art saves');
  const body = await r.json();
  return { entries: body.ircArtSaves as IrcArtSaveEntry[], total: body.total ?? 0 };
}

export async function createIrcArtSave(data: { name: string; art: string; params: Record<string, unknown>; originalFile?: File; thumbnailBlob?: Blob; networkId?: string; buffer?: string; originalFilename?: string; originalMime?: string }): Promise<IrcArtSaveEntry> {
  const fd = new FormData();
  fd.append('name', data.name);
  fd.append('art', data.art);
  fd.append('params', JSON.stringify(data.params ?? {}));
  if (data.networkId) fd.append('networkId', data.networkId);
  if (data.buffer) fd.append('buffer', data.buffer);
  if (data.originalFile) fd.append('original', data.originalFile, data.originalFile.name || data.originalFilename || 'image.png');
  else {
    if (data.originalFilename) fd.append('originalFilename', data.originalFilename);
    if (data.originalMime) fd.append('originalMime', data.originalMime);
  }
  if (data.thumbnailBlob) fd.append('thumbnail', data.thumbnailBlob, 'thumb.png');
  const r = await fetch(`${API_BASE}/img2irc-saves`, { method: 'POST', body: fd, credentials: 'include' });
  if (!r.ok) throw new Error('Failed to create IRC art save');
  return r.json();
}

export async function fetchIrcArtSave(id: string): Promise<IrcArtSaveEntry> {
  const r = await fetch(`${API_BASE}/img2irc-saves/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error('Failed to fetch IRC art save');
  return r.json();
}

export async function updateIrcArtSave(id: string, data: { name?: string; art?: string; params?: Record<string, unknown>; originalFile?: File; thumbnailBlob?: Blob }): Promise<IrcArtSaveEntry> {
  const hasFile = !!(data.originalFile || data.thumbnailBlob);
  if (hasFile) {
    const fd = new FormData();
    if (data.name != null) fd.append('name', data.name);
    if (data.art != null) fd.append('art', data.art);
    if (data.params != null) fd.append('params', JSON.stringify(data.params));
    if (data.originalFile) fd.append('original', data.originalFile, data.originalFile.name);
    if (data.thumbnailBlob) fd.append('thumbnail', data.thumbnailBlob, 'thumb.png');
    const r = await fetch(`${API_BASE}/img2irc-saves/${encodeURIComponent(id)}`, { method: 'PUT', body: fd, credentials: 'include' });
    if (!r.ok) throw new Error('Failed to update IRC art save');
    return r.json();
  }
  const body: Record<string, unknown> = {};
  if (data.name != null) body.name = data.name;
  if (data.art != null) body.art = data.art;
  if (data.params != null) body.params = data.params;
  const r = await fetch(`${API_BASE}/img2irc-saves/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'include' });
  if (!r.ok) throw new Error('Failed to update IRC art save');
  return r.json();
}

export async function deleteIrcArtSave(id: string): Promise<void> {
  const r = await fetch(`${API_BASE}/img2irc-saves/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('Delete failed');
}
