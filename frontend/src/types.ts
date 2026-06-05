// ── Mode categories (IRCCloud has 7, we had 4) ──
export type ModeCategory = 'OPER' | 'OWNER' | 'ADMIN' | 'OP' | 'HALFOP' | 'VOICED' | 'MEMBER';

export const MODE_HIERARCHY: ModeCategory[] = ['OPER', 'OWNER', 'ADMIN', 'OP', 'HALFOP', 'VOICED', 'MEMBER'];

// Maps mode prefix chars to categories
export const MODE_PREFIX_MAP: Record<string, { prefix: string; cls: string; category: ModeCategory; mode: string }> = {
  '!': { prefix: '!', cls: 'mode_OPER', category: 'OPER', mode: 'Y' },
  '~': { prefix: '~', cls: 'mode_OWNER', category: 'OWNER', mode: 'q' },
  '&': { prefix: '&', cls: 'mode_ADMIN', category: 'ADMIN', mode: 'a' },
  '@': { prefix: '@', cls: 'mode_OP', category: 'OP', mode: 'o' },
  '%': { prefix: '%', cls: 'mode_HALFOP', category: 'HALFOP', mode: 'h' },
  '+': { prefix: '+', cls: 'mode_VOICED', category: 'VOICED', mode: 'v' },
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
  verifyTls: boolean;
  nick: string;
  realName: string;
  currentNick: string;
  connected: boolean;
  connecting: boolean;
  connectionState: ConnectionState;
  status: string;
  disconnectReason: string;
  isAway: boolean;
  awayMessage: string;
  collapsed: boolean;
  buffers: Buffer[];
  awayNicks: Set<string>;
  // Server capabilities (from CAP)
  capabilities: Set<string>;
  // ISUPPORT values
  isupport: Record<string, string>;
  // Channel prefix chars from ISUPPORT (default '#')
  chanTypes: string;
}

export interface Buffer {
  name: string;
  type: 'channel' | 'query' | 'server';
  isJoined: boolean;
  unreadCount: number;
  highlight: boolean;
  isPinned: boolean;
  isArchived: boolean;
  topic: string;
  topicSetBy: string;
  topicSetAt: number;
  users: Member[];
  lastSeenMsgTime: number | null;
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
  label?: string;
  type?: string;       // 'action' for /me messages
  highlight?: boolean;
  // For grouped messages
  lines?: string[];    // MOTD group lines
  sentences?: string;  // JOINPART_GROUP / DISCO_GROUP pre-rendered HTML
  events?: JoinPartEvent[] | IRCMessage[];
  expanded?: boolean;
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
export type OverlayType = 'whois' | 'banlist' | 'channellist' | 'invite' | 'channel_delete_confirm';

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

export interface ChannelDeleteConfirmData {
  networkId: string;
  networkName: string;
  networkHost: string;
  bufferName: string;
}

export interface OverlayState {
  type: OverlayType | null;
  data: WhoisData | BanEntry[] | string[] | ChannelDeleteConfirmData | null;
}

// ── Notification types ──
export interface NotificationOptions {
  tag: string;
  title: string;
  body: string;
  icon?: string;
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
