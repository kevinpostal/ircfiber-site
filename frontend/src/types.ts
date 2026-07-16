// ── Mode categories (IRCCloud has 7, we had 4) ──
export type ModeCategory = 'OPER' | 'OWNER' | 'ADMIN' | 'OP' | 'HALFOP' | 'VOICED' | 'MEMBER';

export const MODE_HIERARCHY: ModeCategory[] = ['OPER', 'OWNER', 'ADMIN', 'OP', 'HALFOP', 'VOICED', 'MEMBER'];

// Maps mode prefix chars to categories
export const MODE_PREFIX_MAP: Record<string, { prefix: string; cls: string; category: ModeCategory; mode: string; title: string }> = {
  '!': { prefix: '!', cls: 'mode_OPER',   category: 'OPER',   mode: 'Y', title: 'IRC Operator' },
  '~': { prefix: '~', cls: 'mode_OWNER',  category: 'OWNER',  mode: 'q', title: 'Channel owner' },
  '&': { prefix: '&', cls: 'mode_ADMIN',  category: 'ADMIN',  mode: 'a', title: 'Channel admin' },
  '@': { prefix: '@', cls: 'mode_OP',     category: 'OP',     mode: 'o', title: 'Channel operator' },
  '%': { prefix: '%', cls: 'mode_HALFOP', category: 'HALFOP', mode: 'h', title: 'Half ops' },
  '+': { prefix: '+', cls: 'mode_VOICED', category: 'VOICED', mode: 'v', title: 'Voiced' },
};

// ── Connection state machine ──
export type ConnectionState =
  | 'disconnected'
  | 'waiting_to_retry'   // countdown timer before reconnect
  | 'queued'             // waiting for other connections to finish
  | 'connecting'
  | 'connected'
  | 'connected_joining'; // connected, auto-joining channels

// ── W2-T02: structured retry + fail info from the D engine ──
//
// Mirror of `ircfiber.redis.protocol.RetryStatus` and
// `ircfiber.redis.protocol.FailInfoSnapshot`. Field naming mirrors the
// wire payload exactly so the frontend can read both the
// `CONNECTION_RETRY_STATUS` event (`data.rs`) and the WS sync
// `netObj["retryStatus"]` field through the same TS interface — see
// source/ircfiber/api/websocket.d:518 and protocol.d:299-308.
//
// The engine intentionally OMITS `retryStatus` on healthy / freshly
// reset snapshots (gated by `hasRetryStatus`, see protocol.d:518) so
// the frontend can use presence-vs-absence to drive apply/clear.
// `failInfo` is similarly omitted unless populated (websocket.d:528).
// Both are typed as `T | null` here so consumers can rely on truthiness
// (the field being absent and the field being null are equivalent on
// the wire).

/** Engine-emitted structured retry state, one snapshot per reconnect
 *  cycle. `attemptCount` is 1-based (the first retry attempt is "1st"
 *  per IRCCloud's ordinal label), and `nextRetryAtMs` is a wall-clock
 *  unix-ms timestamp used by ConnectionStatus's 1s countdown. */
export interface RetryStatus {
  attemptCount: number;
  nextRetryAtMs: number;
  delayMs: number;
}

/** Top-level disconnect reason shape, lifted from the engine's
 *  `FailInfo` struct (ircfiber.models.irc_event.d). `sslVerifyError`
 *  is a NESTED object (per plan B2) rather than a flat pair — the
 *  shape matches the wire format byte-for-byte so messageHandler.ts
 *  does no conversion. */
export interface FailInfo {
  /** "connecting_failed" | "killed" | "ssl_verify_error" |
   *  "socket_closed" | "connecting_restricted" | "connection_blocked" */
  type: string;
  /** Raw reason key (matches IRCCloud's RENDER_REASONS table). */
  reason: string;
  /** Populated when type === 'killed'; empty otherwise. */
  killedReason?: string;
  /** Nested {type, error} for SSL failures; absent otherwise. */
  sslVerifyError?: { type: string; error: string };
}

export interface Network {
  networkId: string;
  name: string;
  host: string;
  port: number;
  tls: string;
  nick: string;
  realName: string;
  currentNick: string;
  /** SASL authentication mechanism: 'none' | 'plain' | 'external' | 'scramSha256' */
  sasl: string;
  /** SASL username (authentication identity) */
  saslUsername: string;
  /** SASL password (populated for PLAIN / SCRAM-SHA-256) */
  saslPassword: string;
  connected: boolean;
  connecting: boolean;
  connectionState: ConnectionState;
  status: string;
  disconnectReason: string;
  isAway: boolean;
  awayMessage: string;
  archivesCollapsed?: boolean;
  /** Channels the user has configured to auto-join. Mirrors the backend
   *  `autoJoinChannels` field; populated by WS sync and by the add flow. */
  autoJoinChannels?: string[];
  buffers: Buffer[];
  awayNicks: Set<string>;
  // Server capabilities (from CAP)
  capabilities: Set<string>;
  // ISUPPORT values
  isupport: Record<string, string>;
  // Channel prefix chars from ISUPPORT (default '#')
  chanTypes: string;
  // Last active buffer (server-persisted, restored on reconnect)
  lastActiveBuffer?: string;
  // W1-T08: connection idle detection — set when engine emits "idle" event.
  connectionIdleSince?: number | null;
  /**
   * Unix-ms timestamp of the most recent activity (WS message, buffer
   * update, etc.) for this network. Updated by `markNetworkSeen` from
   * every handler that touches network state. The UI uses this to flag
   * networks whose connection has gone idle — see `isNetworkStale`.
   * Defaults to Date.now() at construction so freshly-created networks
   * don't render as stale before the first event arrives.
   */
  lastSeenAt?: number;
  /**
   * True for networks provisioned by the platform (e.g. the default
   * IRC Fiber connection to irc.ircfiber.com). Such networks cannot be
   * deleted via the user API; the UI hides delete affordances and the
   * backend refuses DELETE /api/networks/:id with 403.
   */
  systemManaged?: boolean;
  /**
   * Tracks a /nick attempt in flight so the NICK echo handler can
   * identify the change as self even after the optimistic update has
   * moved currentNick to the new value. Cleared on echo success or
   * 432/433 rejection; auto-expires after PENDING_SELF_NICK_TTL_MS so
   * a lost echo doesn't strand the optimistic update.
   */
  pendingSelfNickChange?: { oldNick: string; newNick: string; setAt: number };
  /**
   * Set by every live nick-change event (you_nickchange, NICK, 433/432
   * revert, /nick optimistic). Used by the sync handler to distinguish
   * a stale snapshot (which carries the old nick) from the true event-
   * driven state. Protected from sync overwrite for NICK_SYNC_COOLDOWN_MS
   * after the most recent event.
   */
  currentNickUpdatedAt?: number;
  /**
   * Network-wide channel-user map keyed by channel name. Mirrors the
   * engine's `snapshot.users` (see websocket.d:performStateDump). The
   * frontend reads it only as a defense-in-depth fallback: when the
   * engine's `buffers[]` list drops a channel due to internal state
   * drift (channelState missed the JOIN self-echo but kept the 353
   * names), `updateNetworkFromSync` synthesises a joined buffer from
   * this map so the user sees the members list and the correct
   * joined status instead of a Rejoin button on an empty room.
   * Optional because older engine builds may omit the field.
   */
  channelUsersMap?: Record<string, string[]>;
  /**
   * W2-T02: engine-reported structured retry state. Populated from
   * `CONNECTION_RETRY_STATUS` events AND from the WS sync
   * `netObj["retryStatus"]` field. Cleared when the engine's
   * `backoff.reset()` emits a zero-valued retry payload (the engine
   * encodes "retry cleared" as `{attemptCount:0, nextRetryAtMs:0,
   * delayMs:0}`; the frontend normalises that to `null` at the
   * dispatch boundary — see messageHandler.ts and applyRetryStatus).
   * Drives ConnectionStatus's "Reconnecting in {N}s (Mth attempt)"
   * banner copy.
   */
  retryStatus?: RetryStatus | null;
  /**
   * W2-T02: structured disconnect reason from the
   * `CONNECTION_FAIL` event. Preferred over `disconnectReason`
   * (the legacy free-text string) by ConnectionStatus when both
   * are present — `disconnectReason` stays in the Network interface
   * for back-compat with networks that pre-date the structured
   * payload (per plan dual-emit constraint).
   */
  failInfo?: FailInfo | null;
}

export interface Buffer {
  name: string;
  type: 'channel' | 'query' | 'server';
  isJoined: boolean;
  /**
   * True for buffers auto-created by setActiveBuffer() when the user
   * navigates to a channel that doesn't exist locally yet. These are
   * placeholders so the sidebar shows the channel and the user can see
   * error/reply messages. The sync from the engine is authoritative for
   * the actual join state — see updateNetworkFromSync which adopts the
   * incoming isJoined (and clears this flag) for phantoms. Without this
   * the channel would stay in the "Inactive" section even when the user
   * is actually joined, because the existing tests intentionally preserve
   * local isJoined:false across syncs (to avoid clobbering a recent
   * PART for self).
   */
  isPhantom?: boolean;
  /**
   * Set by JOIN/PART/KICK events for self to track an event-driven isJoined
   * change that hasn't been confirmed by the periodic engine sync snapshot
   * yet.  The sync is authoritative for buffer state, but lags behind live
   * events by up to ~10s.  When this flag is set, updateNetworkFromSync
   * will only adopt the sync's isJoined if it CONFIRMS the event direction
   * (same joined/unjoined state); contradicting values are discarded as
   * stale snapshots taken before the event propagated.  Once the sync
   * confirms, the flag is cleared.
   *
   * Values:
   *   true   — a JOIN for self fired since the last sync
   *   false  — a PART/KICK for self fired since the last sync
   *   undefined — no pending change; sync is trusted unconditionally
   */
  pendingIsJoined?: boolean;
  /**
   * Confirmation counter for pendingIsJoined. Starts at 2 when the event
   * fires, decremented on each sync that confirms the pending direction.
   * Only clears pendingIsJoined when the counter reaches 0, preventing a
   * single stale sync from clobbering the state.
   */
  pendingConfirmations?: number;
  /**
   * Set when the most recent JOIN attempt for this channel was rejected by
   * the IRC server (numeric 471/473/474/475/477 etc.). Cleared on the next
   * successful JOIN or when the user explicitly retries. The BufferHeader
   * surfaces this as an error chip with a Retry button.
   *
   * Codes mirror the IRC numerics from RFC 2811 / RFC 2812 / common IRCds:
   *   invite-only  — ERR_INVITEONLYCHAN (473)
   *   banned       — ERR_BANNEDFROMCHAN (474)
   *   key-required — ERR_BADCHANNELKEY (475)
   *   full         — ERR_CHANNELISFULL (471)
   *   unknown      — ERR_ILLEGALCHANNELNAME / other failure
   */
  joinError?: 'invite-only' | 'banned' | 'key-required' | 'full' | 'unknown' | null;
  /**
   * Set when the frontend has issued a JOIN for this buffer but the server
   * has not yet acknowledged it. The sync handler treats this as the
   * authoritative state until the JOIN event arrives, preventing stale
   * snapshots from clobbering the in-flight join with isJoined=false.
   */
  joinInFlight?: boolean;
  /**
   * Consecutive-sync-miss counter for the orphan reconciliation loop in
   * updateNetworkFromSync. The engine publishes its channelState snapshot
   * every ~10s; a single missed snapshot does NOT mean the user left the
   * channel — it usually just means the snapshot was taken one tick before
   * a recent JOIN propagated to the engine's internal state. The counter
   * is incremented each time the buffer is missing from an incoming sync,
   * reset to 0 when the buffer appears in a sync. isJoined is only flipped
   * to false once the counter reaches ORPHAN_FLIP_THRESHOLD (see
   * `ircStore.svelte.ts`) — at that point the engine has consistently
   * omitted the channel across multiple sync cycles and we trust the
   * orphan reconciliation.
   */
  syncMissedCount?: number;
  unreadCount: number;
  highlight: boolean;
  /** Number of unseen mentions; drives the red sidebar badge (IRCCloud-style). */
  highlightCount?: number;
  isPinned: boolean;
  isArchived: boolean;
  topic: string;
  topicSetBy: string;
  topicSetAt: number;
  users: Member[];
  lastSeenMsgTime: number | null;
  /** Per-buffer last-seen timestamp (IRCCloud-style lastSeen). */
  lastSeen: number | null;
  /** Per-buffer bottom-seen timestamp (IRCCloud-style bottomSeen). */
  bottomSeen: number | null;
  /** When this buffer's messages were last cleared (clear/cache invalidation). */
  clearedAt: number | null;
  /** IRC channel modes (mirrors IRCCloud ChannelView CSS classes). */
  modeFlags: {
    secret?: boolean;
    private?: boolean;
    moderated?: boolean;
    inviteOnly?: boolean;
    password?: boolean;
    topicControl?: boolean;
    noExternal?: boolean;
    limited?: boolean;
  };
  // For chatter bars
  firstUnseenMsgIndex: number | null;
}

export interface Member {
  nick: string;
  prefix: string;       // raw prefix char: ~, &, @, %, +, or ''
  category: ModeCategory;
  ident: string;        // user@host
  realname: string;
  isAway: boolean;
  awayMessage: string;
  lastSpoke: number;         // timestamp, 0 if ignored
  lastHighlighted: number;   // timestamp, 0 if ignored
  account: string;           // ACCOUNT tag value
  isBot: boolean;            // IRCCloud-style BOT badge (detected from account/host/mode)
}

export interface IRCMessage {
  id?: string;
  timestamp?: string;
  t?: number;
  nick?: string;
  text?: string;
  command: string;
  params?: string[];
  prefix?: string;
  msgid?: string;
  /** Global sequential event ID (IRCCloud-style). Always present on
   *  new events; may be absent on legacy stored messages. Serves as the
   *  primary key for deduplication and pagination cursors. */
  eid?: number;
  label?: string;
  selfEcho?: boolean;
  type?: string;       // 'action' for /me messages
  highlight?: boolean;
  // For grouped messages
  lines?: string[];    // MOTD group lines
  sentences?: string;  // JOINPART_GROUP / DISCO_GROUP pre-rendered HTML
  events?: JoinPartEvent[] | IRCMessage[];
  expanded?: boolean;
  /** Server-log progress phase tag, set by the engine for connection
   *  lifecycle entries that should be rendered as part of the timeline
   *  in the `_server` buffer. See IRCRawEvent.makeServerLog in D for
   *  the canonical taxonomy. */
  phase?: string;
}

export interface MOTDGroupMessage extends IRCMessage {
  command: 'MOTD_GROUP';
  lines: string[];
}

export interface JoinPartGroupMessage extends IRCMessage {
  command: 'JOINPART_GROUP';
  events: JoinPartEvent[];
  expanded: boolean;
  sentences: string;    // Pre-rendered HTML
}

export interface DiscoGroupMessage extends IRCMessage {
  command: 'DISCO_GROUP';
  events: IRCMessage[];
  expanded: boolean;
  sentences: string;    // Pre-rendered HTML
}

export interface ActiveBuffer {
  networkId: string | null;
  bufferName: string | null;
}

export interface UserSession {
  username: string;
  email: string;
}

export type JoinPartCommand = 'JOIN' | 'PART' | 'QUIT' | 'NICK' | 'CHGHOST';

export type SystemCommand = JoinPartCommand | 'TOPIC' | 'CONNECT' | 'DISCONNECT' | 'ERROR' | 'MODE' | 'CAP' | 'MOTD_GROUP' | 'AWAY' | 'ACCOUNT' | 'NOTICE' | 'KICK' | 'INVITE' | string;

export interface JoinPartEvent {
  msg: IRCMessage;
  type: 'msg';
}

export interface DiscoGroup {
  head: IRCMessage;
  items: IRCMessage[];
}

export interface DiscoGroupEvent {
  type: 'discoGroup';
  group: DiscoGroup;
}

export type GroupedEvent = JoinPartEvent | DiscoGroupEvent;

// ── Tab completion types ──
export interface TabCompletionCandidate {
  value: string;
  type: 'nick' | 'channel' | 'emoji' | 'command';
  display?: string;
  isAway?: boolean;
  lastSpoke?: number;
}

// ── Overlay types ──
export type OverlayType = 'whois' | 'banlist' | 'channellist' | 'invite' | 'channel_delete_confirm' | 'set_topic' | 'ignore_list';

export interface WhoisData {
  nick: string;
  user: string;
  host: string;
  realname: string;
  server: string;
  serverInfo: string;
  channels: string[];
  idle: number;
  signon: number;
  account: string;
  secure: boolean;
  away: string;
}

export interface BanEntry {
  mask: string;
  setBy: string;
  setAt: number;
}

export interface BanListData {
  networkId: string;
  channel: string;
  bans: BanEntry[];
}

export interface ChannelDeleteConfirmData {
  networkId: string;
  networkName: string;
  networkHost: string;
  bufferName: string;
}

export interface SetTopicData {
  networkId: string;
  networkName: string;
  networkHost: string;
  bufferName: string;
  currentTopic: string;
}

export interface InviteData {
  networkId: string;
  networkName: string;
  networkHost: string;
  networkPort: number;
  networkTls: string;  // 'enabled' | 'disabled' | 'required'
  bufferName: string;
}

export interface IgnoreListData {
  networkId: string;
  networkName: string;
}

export interface OverlayState {
  type: OverlayType | null;
  data: WhoisData | BanListData | string[] | ChannelDeleteConfirmData | SetTopicData | InviteData | IgnoreListData | null;
}

// ── Notification types ──
export interface NotificationOptions {
  tag: string;
  title: string;
  body: string;
  icon?: string;
  silent?: boolean;
  autoDismiss?: boolean;
  onClick?: () => void;
}

// ── Autolinker types ──
export interface LinkPart {
  text: string;
  isLink: boolean;
  url?: string;
  isChannel?: boolean;
  isEmail?: boolean;
  embedType?: EmbedType;
}

export type EmbedType = 'youtube' | 'imgur' | 'twitter' | 'image' | 'gist' | 'wikipedia' | 'reddit' | 'spotify' | 'none';

// ── Context menu types ──
export interface ContextMenuAction {
  label: string;
  handler: () => void;
  className?: string;
  separator?: boolean;
}

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  actions: ContextMenuAction[];
}
