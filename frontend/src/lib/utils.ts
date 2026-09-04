import type { IRCMessage, ModeCategory } from '../types';
import { MODE_PREFIX_MAP } from '../types';

export function escapeHtml(text: string): string {
  if (!text) return '';
  return text.replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]!)
  );
}

export function stringHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripHash(name: string): string {
  return name?.startsWith('#') ? name.substring(1) : name;
}

export function normalizeChannelName(name: string): string {
  if (!name || name === '_server') return name;
  // Channels are case-insensitive on IRC (`#Zod` === `#zod`) and we
  // lower-case them so the buffer key (`<net>:<chan>`) collides them
  // for storage + lookup. PM/query buffers are bare nicks — they must
  // NOT be `#`-prefixed here, otherwise the engine's synthetic
  // self-message (`event.channel = target`) lands under
  // `<net>:#faggy_6094` while MessageList looks up `<net>:faggy_6094`
  // (where the buffer was registered when switchToBuffer opened the
  // conversation), so the message disappears from view. Conditionally
  // prepend `#` only for the names that already look like channels.
  if (name[0] !== '#') return name;
  return name.toLowerCase();
}

/**
 * Normalize a channel for JOIN / auto-join: ensures leading `#` and lowercases.
 * Bare names like `testing` → `#testing` so the engine sends `JOIN #testing`
 * instead of `JOIN testing` (which IRC treats as a nick, i.e. a PRIVMSG target).
 * Existing prefixes `# & + !` are preserved and lowercased. `_server` unchanged.
 */
export function ensureChannelPrefix(name: string): string {
  if (!name || name === '_server') return name;
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (trimmed[0] === '#' || trimmed[0] === '&' || trimmed[0] === '+' || trimmed[0] === '!') return trimmed.toLowerCase();
  return '#' + trimmed.toLowerCase();
}

/**
 * Deduplicate and normalize a list of channel names.
 * IRC channel names are case-insensitive, so "#Zod" and "#ZOD" are duplicates.
 */
export function dedupChannelNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const norm = normalizeChannelName(n);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/**
 * Tokenize a free-form channel list. Splits on any whitespace
 * (newlines, spaces, tabs) and commas, trims each token, drops empties.
 * Mirrors what IRCCloud accepts: one channel per line, or space/comma
 * separated on a single line.
 *
 * Bare channel names are auto-prefixed with `#` so `testing` → `#testing`.
 *
 * Note: because whitespace is a separator, the legacy "channel password"
 * syntax ("#chan key") is no longer supported here. Users needing a keyed
 * join can issue /join #chan key after connecting.
 *
 * Examples:
 *   "#a\n#b"        -> ["#a", "#b"]
 *   "#a #b"         -> ["#a", "#b"]
 *   "#a,#b"         -> ["#a", "#b"]
 *   "  #a ,  #b  "  -> ["#a", "#b"]
 *   ""              -> []
 *   "#a, , #b"      -> ["#a", "#b"]
 *   "testing"       -> ["#testing"]
 */
export function parseChannelList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => ensureChannelPrefix(s));
}

export function formatTime12Hour(d: Date): string {
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  h = h || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s} ${ampm}`;
}

export function formatDateTimeTitle(d: Date): string {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${formatTime12Hour(d)}`;
}

export function formatDate(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dayNum = d.getDate();
  let suffix = 'th';
  if (dayNum % 10 === 1 && dayNum !== 11) suffix = 'st';
  else if (dayNum % 10 === 2 && dayNum !== 12) suffix = 'nd';
  else if (dayNum % 10 === 3 && dayNum !== 13) suffix = 'rd';
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${dayNum}${suffix}, ${d.getFullYear()}`;
}

export function formatRelativeTime(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  const diff = Date.now() - d.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days >= 365) {
    const years = Math.floor(days / 365);
    return years === 1 ? 'about a year ago' : `${years} years ago`;
  }
  if (days >= 30) {
    const months = Math.floor(days / 30);
    return months === 1 ? 'about a month ago' : `${months} months ago`;
  }
  if (days >= 7) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? 'about a week ago' : `${weeks} weeks ago`;
  }
  if (days >= 2) return `${days} days ago`;
  if (days === 1) return 'yesterday';
  if (hours >= 2) return `${hours} hours ago`;
  if (hours === 1 || minutes >= 45) return 'about an hour ago';
  if (minutes >= 2) return `${minutes} minutes ago`;
  if (minutes === 1) return 'about a minute ago';
  return 'just now';
}

export function getMsgDate(msg: IRCMessage): string {
  const ts = msg.timestamp || (msg.t ? new Date(msg.t).toISOString() : null);
  return ts ? ts.split('T')[0] : '';
}

/** Short relative time span used in chatter bars (e.g. "a day", "an hour", "less than a minute").
 *  Omits "ago" so it reads naturally as "a day of unread messages". */
export function formatShortRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days >= 365) {
    const years = Math.floor(days / 365);
    return years === 1 ? 'about a year' : `${years} years`;
  }
  if (days >= 30) {
    const months = Math.floor(days / 30);
    return months === 1 ? 'about a month' : `${months} months`;
  }
  if (days >= 7) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? 'about a week' : `${weeks} weeks`;
  }
  if (days >= 2) return `${days} days`;
  if (days === 1) return 'a day';
  if (hours >= 2) return `${hours} hours`;
  if (hours === 1 || minutes >= 45) return 'about an hour';
  if (minutes >= 2) return `${minutes} minutes`;
  if (minutes === 1) return 'about a minute';
  return 'less than a minute';
}

export function isJoinPartLike(cmd: string): boolean {
  return ['JOIN', 'PART', 'QUIT', 'NICK', 'CHGHOST', 'MODE', 'AWAY'].includes(cmd);
}

export function isSkippedCommand(cmd: string): boolean {
  // IRC server metadata noise the engine forwards for the
  // server-log timeline but the chat UI never displays:
  //   - WHOIS replies (311–319, 330): consumed by the engine's realname
  //     cache, surfaced via the WS sync payload (net.realnames).
  //   - NAMES list (353, 366): consumed by the engine's channelUsers
  //     cache, surfaced via net.buffers[].users on every sync.
  //   - WHOX (354): engine-side case "354" returns early so this only
  //     fires for older engines still in flight during a rolling upgrade.
  //     Without this the timeline can briefly show 2000+ WHOX rows per
  //     JOIN on SuperNets-scale channels.
  //   - WHO (315, 352), TOPIC (332, 333), MOTD (376, 422).
  //   - Ban list (367, 368): consumed by the ban-list overlay; 368 is
  //     "End of Channel Ban List" and is redundant with the overlay UI.
  //   - PONG, TAGMSG (IRCv3 typing/react), ERR_NOSUCHNICK.
  // IRCCloud parity: QUIT is NOT skipped — it renders as
  // type_quit / joinPart grouping (see MessageRow svelte type_quit
  // and messageBuilder buildJoinPartGroup quit sentence). Mirrors
  // IRCCloud's backlog where :nick!u@h QUIT :reason appears in
  // channel buffers alongside JOIN / PART.
  // The engine also drops the same set at publish time (see the
  // `noPublishDuringRegistration` guard in source/ircfiber/irc/connection.d)
  // so this filter is defense-in-depth for older binaries / replays.
  //   - MODE #chan / ISON probe replies (324, 329, 303) that every
  //     bouncer client fires on attach; they carry no chat text.
  //   - LIST (321, 322, 323): the engine folds these into CHANNEL_LIST
  //     chunks for the overlay; an older engine mid-rolling-upgrade may
  //     still forward them raw and they must not flood the timeline.
  return ['315', '352', '332', '333', '353', '354', '366', '367', '368', '376', '422', 'PONG', 'TAGMSG', '311', '312', '313', '317', '318', '319', '330', '301', '671', '401', '324', '329', '303', '321', '322', '323', 'you_nickchange'].includes(cmd);
}

export function isDisconnectLike(cmd: string, text?: string): boolean {
  return cmd === 'DISCONNECT' || cmd === 'ERROR' || (!!text && text.toLowerCase().includes('failed to connect'));
}

export function isChatMessage(msg: IRCMessage): boolean {
  return msg.command === 'PRIVMSG' || msg.type === 'action';
}

// Per-message height cap for very long message bodies (pastebin snippets, large
// chat dumps, etc.). Matches IRCCloud's "Show more" affordance so a single
// message body never creates thousands of line boxes in the DOM.
export const MAX_PREVIEW_LINES = 20;
export const MAX_PREVIEW_CHARS = 2000;

export function countLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}

export function firstLines(text: string, n: number): string {
  if (n <= 0 || !text) return '';
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = text.indexOf('\n', idx + 1);
    if (idx === -1) return text;
  }
  return text.slice(0, idx);
}

export function previewText(text: string, expanded: boolean): string {
  if (expanded || !text) return text;
  const byLines = firstLines(text, MAX_PREVIEW_LINES);
  if (byLines.length <= MAX_PREVIEW_CHARS) return byLines;
  return byLines.slice(0, MAX_PREVIEW_CHARS);
}

/**
 * Strip safe-channel prefix characters from a channel name for display.
 *
 * Some IRC networks (e.g. freenode) use a `%` prefix on channel names
 * internally (e.g. `%#secret`) while users see the bare `#secret`. The
 * ISUPPORT `PREFIX` token lists the symbols used as mode prefixes — any
 * character from that list at the start of a channel name is stripped.
 *
 * Null-safe: returns the input unchanged when isupport is missing or
 * lacks a PREFIX value.
 *
 * Example:
 *   getDisplayName('%#secret', { PREFIX: '(qaohv)~&@%+' }) -> '#secret'
 *   getDisplayName('#chat',    { PREFIX: '(qaohv)~&@%+' }) -> '#chat'
 *   getDisplayName('#chat',    undefined)                  -> '#chat'
 */
export function getDisplayName(channelName: string, isupport?: Record<string, string> | null): string {
  if (!channelName) return channelName;
  const prefixToken = isupport?.PREFIX;
  if (!prefixToken) return channelName;
  const m = prefixToken.match(/^\([^)]+\)(.+)$/);
  if (!m) return channelName;
  const prefixes = m[1];
  const firstChar = channelName[0];
  if (prefixes.includes(firstChar)) {
    return channelName.slice(1);
  }
  return channelName;
}

export function getUserModePrefix(nick: string): { prefix: string; cls: string; category: ModeCategory; mode: string; title: string } {
  const first = nick.charAt(0);
  if (first in MODE_PREFIX_MAP) return MODE_PREFIX_MAP[first];
  return { prefix: '', cls: '', category: 'MEMBER', mode: '', title: '' };
}

export function stripPrefix(nick: string): string {
  let n = nick.replace(/^[!~&@%+]+/, '');
  const bang = n.indexOf('!');
  if (bang > 0) n = n.slice(0, bang);
  return n;
}

/**
 * Canonical nick for color/identity comparison — byte-for-byte parity
 * with IRCCloud's `normaliseIdentifier`. Lowercases, strips an
 * away-suffix (`alice|away` → `alice`), strips the host part of a
 * `user@host` mask, and strips ornamental leading/trailing characters
 * commonly added by IRC clients (`_`, `` ` ``, `[`, `]`, etc.). Empty
 * input falls back to a single space, matching IRCCloud's behaviour so
 * tests stay deterministic across the empty case.
 *
 * Source: extracted live from IRCCloud's `common-*.js`
 * (`normaliseIdentifier:function(e){return e=f.strip(c.stringify(e))||" ",
 *  e.toLowerCase().replace(/[@|].*$/,"").replace(/^[\\\\[\\]^_\`{|}]+/,"")
 *  .replace(/[\`_]+$/,"")||e}`).
 */
export function normaliseIdentifier(nick: string | null | undefined): string {
  const raw = nick == null ? '' : String(nick);
  const base = raw || ' ';
  const cleaned = base
    .toLowerCase()
    .replace(/[@|].*$/, '')
    // eslint-disable-next-line no-useless-escape
    .replace(/^[\\[\]^_`{|}]+/, '')
    .replace(/[`_]+$/, '');
  return cleaned || base;
}

/**
 * Avatar / author color index in the IRCCloud 27-slot palette. SDBM
 * hash over the normalised nick, taken modulo 27 (the value of
 * `window.IRCConfig.nickColors` on IRCCloud). Matches IRCCloud's
 * `getNickColorIndex()` exactly so two users see the same nick painted
 * in the same colour across both clients.
 */
export function nickColorIndex(nick: string): number {
  const id = normaliseIdentifier(nick);
  let n = 0;
  for (let i = 0; i < id.length; i++) {
    n = id.charCodeAt(i) + (n << 6) + (n << 16) - n;
  }
  return Math.abs(n % 27);
}

export function getAvatarColor(nick: string): string {
  return NICK_COLORS[stringHash(nick) % NICK_COLORS.length];
}

// IRCCloud dark-theme nick palette: $nickColors with $darkNickColors overrides applied.
// Source: app/styles/app/styles/_nick-colors.scss
export const NICK_COLORS: readonly string[] = [
  '#deb887', // 0  burlywood       (dark override for firebrick)
  '#ffd700', // 1  gold            (dark override for chocolate)
  '#ff9166', // 2  darken(lightsalmon, 4%)
  '#fa8072', // 3  salmon
  '#ff8c00', // 4  darkorange
  '#00ff00', // 5  lime            (dark override for forestgreen)
  '#ffff00', // 6  yellow          (dark override for olive)
  '#bdb76b', // 7  darkkhaki       (dark override)
  '#9acd32', // 8  yellowgreen     (dark override)
  '#32cd32', // 9  limegreen       (dark override)
  '#8fbc8f', // 10 darkseagreen    (dark override)
  '#3cb371', // 11 mediumseagreen  (dark override)
  '#66cdaa', // 12 mediumaquamarine(dark override)
  '#20b2aa', // 13 lightseagreen   (dark override)
  '#40e0d0', // 14 turquoise       (dark override for cadetblue)
  '#00ffff', // 15 cyan            (dark override for darkcyan)
  '#00bfff', // 16 deepskyblue
  '#87ceeb', // 17 skyblue         (dark override for steelblue)
  '#339cff', // 18 hsl(209,100%,60%)
  '#6495ed', // 19 cornflowerblue  (dark override for royalblue)
  '#b2a9e5', // 20 hsl(249,54%,78%)
  '#ff69b4', // 21 hotpink         (dark override for mediumslateblue)
  '#da70d6', // 22 orchid          (dark override for darkviolet)
  '#ee82ee', // 23 violet          (dark override for darkmagenta)
  '#d68fff', // 24 hsl(278,100%,78%)
  '#ff00ff', // 25 magenta
  '#ffb6c1', // 26 lightpink       (dark override for deeppink)
];

export function generateLabel(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/** Natural comparison for nick sorting (case-insensitive, number-aware) */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function getIrcCloudTypeClass(cmd: string, params?: string[], type?: string): string {
  // Actions take precedence over PRIVMSG so /me messages get the
  // type_buffer_me_msg class IRCCloud emits.
  if (type === 'action') return 'type_buffer_me_msg';

  switch (cmd) {
    case 'PRIVMSG': return 'type_buffer_msg';
    case 'NOTICE': return 'type_notice';
    case '001': return 'type_server_welcome';
    case '002': return 'type_server_yourhost';
    case '003': return 'type_server_created';
    case '004': return 'type_myinfo';
    case '005': return 'type_server_supports';
    case '251': return 'type_server_luserclient';
    case '252': return 'type_server_luserop';
    case '253': return 'type_server_luserunknown';
    case '254': return 'type_server_luserchannels';
    case '255': return 'type_server_luserme';
    case '265': return 'type_server_n_local';
    case '266': return 'type_server_n_global';
    case '396': return 'type_hidden_host_set';
    case '372': return 'type_motd_response';
    case '375': return 'type_motd_start';
    case '376': return 'type_motd_end';
    case '422': return 'type_motd_missing';
    case 'MOTD_GROUP': return 'type_motd_response';
    case '221': return 'type_user_mode';
    case 'JOIN': return 'type_joined_channel';
    case 'PART': return 'type_parted_channel';
    case 'QUIT': return 'type_quit';
    case 'NICK': return 'type_nickchange';
    case 'CHGHOST': return 'type_chghost';
    case 'AWAY': return 'type_away';
    case 'TOPIC': return 'type_topic_change';
    case 'KICK': return 'type_kick';
    case 'INVITE': return 'type_invite';
    case 'DISCONNECT': return 'type_socket_closed';
    case 'DISCONNECTED': return 'type_socket_closed';
    case 'ERROR': return 'type_error';
    case 'CONNECT': return 'type_connecting_finished';
    case 'MODE':
      return params && params[0]?.[0] !== '#' ? 'type_user_mode' : 'type_channel_mode';
    case 'CAP':
      if (params?.[0] === 'LS' || params?.[0] === 'LIST') return 'type_cap_ls';
      if (params?.[0] === 'REQ') return 'type_cap_req';
      if (params?.[0] === 'ACK') return 'type_cap_ack';
      if (params?.[0] === 'NEW') return 'type_cap_new';
      if (params?.[0] === 'DEL') return 'type_cap_del';
      if (params?.[0] === 'NAK') return 'type_cap_nak';
      return 'type_cap';
    default: return '';
  }
}

/** Format numeric reply text for display */
export function formatNumericText(cmd: string, params: string[], text: string, nick?: string): string {
  switch (cmd) {
    case '001': return text || `Welcome to the network, ${nick}`;
    case '002': return text || 'Your host is...';
    case '003': return text || 'This server was created...';
    case '004': return params ? params.join(' ') : text;
    case '005': return params ? params.slice(0, -1).join(' ') : text;
    case '251': case '252': case '253': case '254': case '255':
    case '265': case '266':
      return text;
    case '311':
      return params ? `${params[0]} is ${params[1]}@${params[2]} * ${text}` : text;
    case '312':
      return params ? `${params[0]} using ${params[1]} (${text})` : text;
    case '313': return params ? `${params[0]} ${text}` : text;
    case '317':
      return params ? `${params[0]} has been idle ${params[1]} seconds` : text;
    case '318': return params ? `${params[0]} :End of /WHOIS` : text;
    case '319': return params ? `${params[0]} : ${text}` : text;
    case '330': return params ? `${params[0]} is logged in as ${params[1]}` : text;
    case '332': return text;
    case '333': {
      if (!params || params.length < 3) return text;
      const setter = params[2];
      const ts = params[3] ? parseInt(params[3], 10) : NaN;
      if (!Number.isFinite(ts)) return `Topic set by ${setter}`;
      return `Topic set by ${setter} at ${new Date(ts * 1000).toLocaleString()}`;
    }
    case '352': return params ? `${params[4]} ${params[1]}@${params[2]} (${text})` : text;
    case '353': return text;
    case '366': return '';
    case '372': return text;
    case '375': return text || '--- Message of the Day ---';
    case '376': return '';
    case '396': return params ? `${params[1]} ${text}` : text;
    case '433': return text || 'Nickname already in use';
    default: return text;
  }
}
