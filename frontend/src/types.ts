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
