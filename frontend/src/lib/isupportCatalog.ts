// ─────────────────────────────────────────────────────────────────────
// ISUPPORT (RPL_ISUPPORT, numeric 005) catalog
// ─────────────────────────────────────────────────────────────────────
//
// A typed knowledge base of every well-known ISUPPORT token and IRCv3
// capability the engine / UI might see in a server's 005 reply or a
// CAP LS reply. Each entry includes a human-readable description, a
// canonical example, and links to the originating RFC and / or IRCv3
// extension doc so the ServerFeaturesPanel can show "what is this
// token, what does it mean, where does it come from" — the same
// information shape as https://ircv3.net/specs/extensions/away-notify.html
//
// Coverage:
//   · RFC 2811 §3.1–3.2 (channel model, modes)
//   · RFC 2812 §3.4 (server features)
//   · RFC 1459 §4.2 + the modern compat field set used by every IRCd
//   · IRCv3 extension specs (cap-notify, account-notify, …) — both the
//     ISUPPORT-implied tokens (e.g. MSGREFTYPES) and the standalone
//     CAP-LS adverbs.
//
// The catalog is intentionally a static, read-only array of records;
// the categorize / UI layer derives buckets from `category` so adding
// a new entry is a one-line change. `lookupIsupport` indexes by key.
// ─────────────────────────────────────────────────────────────────────

export type IsupportKind =
  | 'flag'        // bare KEY (no =value) — server advertises support
  | 'int'         // KEY=N where N is a positive integer
  | 'string'      // KEY=arbitrary
  | 'enum'        // KEY=one-of-several-values (see `values`)
  | 'mode-list'   // CHANMODES / PREFIX / USERMODES — comma-separated
  | 'prefix-list' // PREFIX=(modes)symbols — dual-paren form
  | 'language'    // LANGUAGE=tag1,tag2
  | 'pair'        // KEY=A,B  / KEY=:A,B  — chan/prefix pairs
  | 'mask'        // ELIST=MTU — letter set
  | 'time';       // seconds / minutes — CHATHISTORY, MONITOR caps, etc.

export type IsupportCategoryId =
  | 'server-identity'   // network / server / case mapping
  | 'channel-naming'    // CHANTYPES, channel / topic lengths
  | 'user-limits'       // NICKLEN, USERLEN, HOSTLEN, AWAYLEN
  | 'case-mapping'      // CASEMAPPING (kept separate so users see)
  | 'channel-modes'     // CHANMODES, PREFIX, MODES, MAXLIST
  | 'channel-bans'      // ban / exception / invex tokens (legacy + modern)
  | 'user-modes'        // user mode types
  | 'messages'           // message features (history, ref types, tags)
  | 'capabilities'      // bare flags: KNOCK, DEAF, MONITOR, BOT
  | 'extensions'        // IRCv3-era extensions the server supports
  | 'server-specific';  // catch-all for non-standard tokens

export interface IsupportCategory {
  id: IsupportCategoryId;
  name: string;        // single noun, kicker style
  title: string;       // h2-style
  blurb: string;       // 1-sentence description
  icon: string;        // single glyph or unicode mark for the card header
}

export interface IsupportEntry {
  key: string;
  category: IsupportCategoryId;
  kind: IsupportKind;
  /** Short human-readable name, e.g. "Away message length" */
  title: string;
  /** One-line description for the categorised list view */
  short: string;
  /** Paragraph-length explanation for the detail drawer — should be 1–3
   *  sentences and reference wire-format behaviour when relevant. */
  detail: string;
  /** Worked example showing a real wire-format value */
  example?: string;
  /** When the token is per RFC, the canonical RFC reference */
  rfc?: string;
  /** When the token is per an IRCv3 spec, the canonical IRCv3 URL */
  ircv3?: string;
  /** Spec version this first appeared in (e.g. "RFC 2812", "IRCv3 3.0") */
  since?: string;
  /** For `enum` kinds, the accepted values */
  values?: readonly string[];
  /** Optional rendered prefix for status badges in the UI */
  status?: 'core' | 'extended' | 'draft' | 'legacy' | 'ircv3';
}

// ── Category defs (the rendering buckets) ────────────────────────

export const ISUPPORT_CATEGORIES: readonly IsupportCategory[] = [
  {
    id: 'server-identity',
    name: 'Identity',
    title: 'Server & Network identity',
    blurb: 'What the server names itself, the network it belongs to, and how it handles letter case.',
    icon: '◈',
  },
  {
    id: 'channel-naming',
    name: 'Channels',
    title: 'Channel naming & sizes',
    blurb: 'Channel name prefixes, maximum channel name and topic length, and how many channels you can join.',
    icon: '#',
  },
  {
    id: 'user-limits',
    name: 'Limits',
    title: 'User-mode input limits',
    blurb: 'Maximum length for nicks, usernames, hostnames, away messages and other user-mode fields.',
    icon: '◯',
  },
  {
    id: 'case-mapping',
    name: 'Case',
    title: 'Case folding rules',
    blurb: 'How the server compares characters case-insensitively when comparing channels and nicks.',
    icon: 'Aa',
  },
  {
    id: 'channel-modes',
    name: 'Modes',
    title: 'Channel modes',
    blurb: 'Channel mode-to-symbol mapping, type categorisation (list / param / toggle / prefix), and rate limits.',
    icon: '@+',
  },
  {
    id: 'channel-bans',
    name: 'Bans',
    title: 'Channel bans & exceptions',
    blurb: 'Ban, ban-exception, and invite-exception tokens. Modern IRCds use EXCEPTSEXTBAN; legacy use EXCEPTS / INVEX.',
    icon: '⊘',
  },
  {
    id: 'user-modes',
    name: 'User modes',
    title: 'User (client) modes',
    blurb: 'Toggles a user can set on themselves — invisible, wallops, server notices, restricted, IRC operator, etc.',
    icon: 'i',
  },
  {
    id: 'messages',
    name: 'Messages',
    title: 'Message features',
    blurb: 'Server-side history (CHATHISTORY), per-message ID types, server time stamps, and other message features.',
    icon: '⌬',
  },
  {
    id: 'capabilities',
    name: 'Features',
    title: 'BARE capabilities',
    blurb: 'Features the server advertises without an =value (just the key name).',
    icon: '◇',
  },
  {
    id: 'extensions',
    name: 'IRCv3',
    title: 'IRCv3 extensions',
    blurb: 'Extensions from IRCv3 (account-notify, away-notify, server-time, SASL, message-tags, …).',
    icon: '⊕',
  },
  {
    id: 'server-specific',
    name: 'Custom',
    title: 'Server-specific extensions',
    blurb: 'Tokens specific to this IRCd software — extensions not covered by the common RFC set.',
    icon: '⟁',
  },
];

// ── The catalog ──────────────────────────────────────────────────

export const ISUPPORT_CATALOG: readonly IsupportEntry[] = [
  // ── server identity ─────────────────────────────────────────────
  {
    key: 'NETWORK',
    category: 'server-identity',
    kind: 'string',
    title: 'Network name',
    short: 'Human-readable name of the network this server belongs to.',
    detail: 'Advertised by servers that are part of a multi-server network so clients can display "SuperNets" rather than the individual server hostname. Many clients group buffers by this value.',
    example: 'NETWORK=SuperNets',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2812#section-4.4.1',
    status: 'extended',
  },

  // ── channel naming ─────────────────────────────────────────────
  {
    key: 'CHANTYPES',
    category: 'channel-naming',
    kind: 'pair',
    title: 'Valid channel name prefixes',
    short: 'The characters that may start a channel name (typically "#", sometimes "&" or "+").',
    detail: 'Each character in this list is a valid channel-name prefix. RFC 1459 mandates "#"; most IRCds also support "&" (local channels) and some servers support "+" (modeless), "!" (special), or other prefixes. Clients must use this list when deciding whether to join "<rest>" as a channel.',
    example: 'CHANTYPES=#&',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2811#section-4.1',
    status: 'core',
  },
  {
    key: 'CHANNELLEN',
    category: 'channel-naming',
    kind: 'int',
    title: 'Maximum channel name length',
    short: 'Maximum number of characters allowed in a channel name (after the prefix).',
    detail: 'The total length of a channel name (prefix plus the body) is capped server-side. Clients should split long channel names or fail gracefully when JOINing longer ones. 32 is the value seen on most modern networks.',
    example: 'CHANNELLEN=32',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2811#section-4.1',
    status: 'core',
  },
  {
    key: 'TOPICLEN',
    category: 'channel-naming',
    kind: 'int',
    title: 'Maximum topic length',
    short: 'Maximum number of characters allowed in a channel TOPIC.',
    detail: 'Total character count of a channel topic. Clients should truncate on write to avoid a 442 ERR_TOPICTOOLONG response, and must accept incoming topics longer than this value if delivered out-of-band (SJOIN / history).',
    example: 'TOPICLEN=390',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2811#section-4.2.4',
    status: 'extended',
  },
  {
    key: 'KICKLEN',
    category: 'channel-naming',
    kind: 'int',
    title: 'Maximum kick-comment length',
    short: 'Maximum number of characters allowed in a KICK reason.',
    detail: 'The kick-comment is the text passed as the third argument to KICK (e.g. "/kick #chan spam"). Server enforces this limit; clients should truncate when issuing KICK and accept incoming kick messages verbatim.',
    example: 'KICKLEN=307',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2812#section-4.2.1',
    status: 'extended',
  },
  {
    key: 'CHANLIMIT',
    category: 'channel-naming',
    kind: 'pair',
    title: 'Maximum channels per user',
    short: 'Per-prefix maximum number of channels a single user can be on, e.g. "#:10" = ten # channels.',
    detail: 'The value is one or more "<prefix>:<max>" pairs separated by commas. Pairs not listed default to no limit. Joining more channels than this limit produces ERR_TOOMANYCHANNELS (405).',
    example: 'CHANLIMIT=#:10,&:5',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2811#section-4.1',
    status: 'core',
  },
  {
    key: 'MAXCHANNELS',
    category: 'channel-naming',
    kind: 'int',
    title: 'Deprecated global channel cap',
    short: 'Old single-number form of CHANLIMIT. Modern servers advertise CHANLIMIT=<prefix>:<n> instead.',
    detail: 'Legacy token from RFC 2812. New servers use CHANLIMIT; clients should prefer CHANLIMIT when it is present and fall back to MAXCHANNELS only for older IRCds. If both are present, CHANLIMIT is authoritative.',
    example: 'MAXCHANNELS=10',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2812#section-4.4.1',
    status: 'legacy',
  },
  {
    key: 'STATUSMSG',
    category: 'channel-naming',
    kind: 'pair',
    title: 'Status-message prefixes',
    short: 'Prefixes that may be used to message "@ops" / "@#chan" to only specific channel roles.',
    detail: 'When you send "PRIVMSG @#channel :hello", only users with the "@" prefix (ops) receive the message. STATUSMSG enumerates the prefixes — typically "@" (op) and "+" (voice) — that work for status messages. The set of allowed prefixes is taken from PREFIX.',
    example: 'STATUSMSG=@+',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2811#section-4.1',
    status: 'extended',
  },

  // ── user limits ────────────────────────────────────────────────
  {
    key: 'NICKLEN',
    category: 'user-limits',
    kind: 'int',
    title: 'Maximum nickname length',
    short: 'Maximum number of characters in a user nickname.',
    detail: 'Server-enforced length of a nick (i.e. up to NICKLEN characters). Clients must split long nicks — usually by appending "_" or "_1" — when the server replies 432/433. Modern servers also advertise MAXNICKLEN; the two are functionally equivalent.',
    example: 'NICKLEN=30',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc1459#section-4.1',
    status: 'extended',
  },
  {
    key: 'MAXNICKLEN',
    category: 'user-limits',
    kind: 'int',
    title: 'Maximum nickname length (modern)',
    short: 'Modern equivalent of NICKLEN; surfaced by UnrealIRCd, InspIRCd, and recent ircd-irc2 derivatives.',
    detail: 'Functionally identical to NICKLEN. Servers that advertise both pick the lower of the two. Most IRC Fiber clients treat them interchangeably.',
    example: 'MAXNICKLEN=30',
    status: 'extended',
  },
  {
    key: 'MINNICKLEN',
    category: 'user-limits',
    kind: 'int',
    title: 'Minimum nickname length',
    short: 'Shortest allowed nick length. 0 = no lower bound beyond "must be at least one character".',
    detail: 'Server-enforced minimum nick length. Most modern IRCds set this to 1 or 0. Connecting with a sub-length nick yields 432 ERR_ERRONEUSNICKNAME.',
    example: 'MINNICKLEN=0',
    status: 'extended',
  },
  {
    key: 'USERLEN',
    category: 'user-limits',
    kind: 'int',
    title: 'Maximum username length',
    short: 'Maximum length of the "user" parameter passed to USER ("ident").',
    detail: 'Constrains the second argument of the USER registration command (the "user / ident"). Must be at least 1 character. Combined with HOSTLEN this defines the maximum length of a fully-qualified nick!user@host mask.',
    example: 'USERLEN=10',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2812#section-3.1',
    status: 'extended',
  },
  {
    key: 'HOSTLEN',
    category: 'user-limits',
    kind: 'int',
    title: 'Maximum hostname length',
    short: 'Maximum length of the host portion of a user mask.',
    detail: 'The host portion (right of "@") of nick!user@host. Used by clients to truncate hostname displays in member lists when a CHGHOST event would otherwise produce unwieldy output.',
    example: 'HOSTLEN=64',
    status: 'extended',
  },
  {
    key: 'AWAYLEN',
    category: 'user-limits',
    kind: 'int',
    title: 'Maximum away-message length',
    short: 'Maximum number of characters allowed in an AWAY message.',
    detail: 'Server-side cap on the textual away reason set by "/away working on it". Clients must truncate before sending, otherwise the server replies with a numeric error. If 0 / not advertised, no server-side cap is enforced.',
    example: 'AWAYLEN=307',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2812#section-4.1',
    status: 'extended',
  },

  // ── case mapping ───────────────────────────────────────────────
  {
    key: 'CASEMAPPING',
    category: 'case-mapping',
    kind: 'enum',
    title: 'Channel & nick case mapping',
    short: 'How the server compares characters when checking nick and channel equality.',
    detail: 'Determines which characters are folded to the same lowercase form. "ascii" is the strictest (RFC 1459 / 2812 with no special mappings); "rfc1459" also folds "^", "~" and similar; "rfc1459-strict" / "strict-rfc1459" folds 4 of them. Clients must apply the same mapping to channel joining to avoid duplicates.',
    example: 'CASEMAPPING=ascii',
    values: ['ascii', 'rfc1459', 'rfc1459-strict', 'strict-rfc1459'],
    rfc: 'https://datatracker.ietf.org/doc/html/rfc1459#section-4.2',
    status: 'core',
  },

  // ── channel modes ──────────────────────────────────────────────
  {
    key: 'PREFIX',
    category: 'channel-modes',
    kind: 'prefix-list',
    title: 'Channel user-mode prefix symbols',
    short: 'Maps channel user-modes to the prefix-symbol shown in member lists (e.g. (ov)@+ means ov=op (@), v=voice (+)).',
    detail: 'The canonical-channel-modes form is "(modes)symbols" where the part inside parens is user-modes (one char each) and the part after is the matching visual prefix used in NAMES and member lists. The default on most IRCds is "(ov)@+" which means "o" → "@" (op) and "v" → "+" (voice). Channels can grant or remove these with MODE #chan +/-<mode> <nick>.',
    example: 'PREFIX=(qaohv)~&@%+',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2811#section-4.1',
    status: 'core',
  },
  {
    key: 'CHANMODES',
    category: 'channel-modes',
    kind: 'mode-list',
    title: 'Channel mode categories',
    short: 'Channel modes grouped into four categories (list A, param-B, toggle C, list-with-param D).',
    detail: 'Four comma-separated lists describing each channel mode\'s category. (A) Modes that add or remove a list (bans / exceptions / invite-overrides): +b adds, -b removes. (B) Modes that always require a parameter and stay set until removed (+k key, +l N, +j N). (C) Simple toggles with no parameter (+i / +m / +n / +t / +s / +p). (D) Modes that add or remove an address with parameter (+o op -o). The MODE reply syntax depends on which category each mode is in.',
    example: 'CHANMODES=b,e,I,k,l,imnpst',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2811#section-4.2',
    status: 'core',
  },
  {
    key: 'MODES',
    category: 'channel-modes',
    kind: 'int',
    title: 'Maximum modes per MODE command',
    short: 'Maximum number of mode changes allowed in a single MODE command. 0 = unlimited.',
    detail: 'Server-side batch limit for a single MODE call. Clients sending MODE with more than MODES changes get a 472 ERR_UNKNOWNMODE or a partial response. If 0 or not advertised, there is no server-enforced batch cap.',
    example: 'MODES=12',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2812#section-4.2.3',
    status: 'core',
  },
  {
    key: 'MAXLIST',
    category: 'channel-modes',
    kind: 'pair',
    title: 'Per-mode list size limits',
    short: 'Maximum entries allowed in each list-mode (bans, excepts, invex), e.g. "b:250,e:250,I:250".',
    detail: 'Each pair "<mode>:<max>" caps the number of entries in that list. List modes not listed have no cap. ERR_BANLISTFULL (478) is returned when adding to a full list. Modern IRCds advertise MAXLIST for bans (b), ban-exceptions (e), and invite-overrides (I).',
    example: 'MAXLIST=b:250,e:250,I:250',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2811#section-4.2',
    status: 'core',
  },
  {
    key: 'MODES_MAX',
    category: 'channel-modes',
    kind: 'int',
    title: 'Maximum user-mode changes per command',
    short: 'Modern alias for MODES, used by UnrealIRCd for user modes.',
    detail: 'UnrealIRCd splits the rate cap between channel and user modes. MODES_MAX caps the user-mode batch; MODES caps the channel-mode batch. Most clients use the smaller of the two.',
    example: 'MODES_MAX=12',
    status: 'extended',
  },

  // ── channel bans ───────────────────────────────────────────────
  {
    key: 'EXCEPTS',
    category: 'channel-bans',
    kind: 'flag',
    title: 'Ban exceptions (legacy flag)',
    short: 'Server supports the +e channel mode (ban exceptions).',
    detail: 'Legacy flag from RFC 2811 / older Unreal. A list-mode (category A) where entries lift a ban for a specific mask (e.g. ban +b covers everyone except +e entries). Modern servers add EXCEPTSEXTBAN if +e is extended-ban with a name.',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2811#section-4.2.5',
    status: 'legacy',
  },
  {
    key: 'INVEX',
    category: 'channel-bans',
    kind: 'flag',
    title: 'Invite overrides (legacy flag)',
    short: 'Server supports the +I channel mode (invite overrides).',
    detail: 'Legacy flag: a list-mode whose entries whitelist a mask that can join without an explicit /invite, even when the channel is +i (invite-only).',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2811#section-4.2.6',
    status: 'legacy',
  },
  {
    key: 'EXCEPTSETXBAN',
    category: 'channel-bans',
    kind: 'string',
    title: 'Ban-exception extended-ban type',
    short: 'The name of the extended-ban type used for ban exceptions (modern replacement for +e).',
    detail: 'Modern IRCds model ban exceptions and invite overrides as "extended bans" via the standard extban mechanism (account:foo, ~a, etc). EXCEPTSETXBAN publishes the type name (typically "account") so clients know which extbans to render as exceptions.',
    example: 'EXCEPTSEXTBAN=~,acfjmnpqrt',
    rfc: 'https://ircv3.net/specs/extensions/extban',
    ircv3: 'https://github.com/ircv3/ircv3-specifications/blob/main/extban.md',
    status: 'ircv3',
  },
  {
    key: 'BANWIDTH',
    category: 'channel-bans',
    kind: 'int',
    title: 'Maximum ban-mask width',
    short: 'Maximum character count for ban-mask entries on this server.',
    detail: 'Width of the mask accepted in MODE +b / -b arguments. Server rejects masks longer than BANWIDTH with ERR_BANMASKTOOLONG (442 on some IRCds).',
    example: 'BANWIDTH=120',
    status: 'extended',
  },

  // ── user modes ─────────────────────────────────────────────────
  {
    key: 'USERMODES',
    category: 'user-modes',
    kind: 'mode-list',
    title: 'User mode categories',
    short: 'Same 4-category grouping (A/B/C/D) but for user (client) modes instead of channel modes.',
    detail: 'Rare in the wild — most IRCds hard-code user-mode parsing. When present, the format mirrors CHANMODES: A=list modes, B=param always required, C=toggle, D=list with param.',
    example: 'USERMODES=,,,iws',
    status: 'extended',
  },

  // ── messages ───────────────────────────────────────────────────
  {
    key: 'CHATHISTORY',
    category: 'messages',
    kind: 'int',
    title: 'CHATHISTORY support',
    short: 'Server implements draft/chathistory for retrieving message history before / after a target.',
    detail: 'When this value is present the server supports IRCv3 CHATHISTORY (replacing the older CHANSERV / BNC message-log interfaces). The numeric value is the maximum number of messages the server will return per command burst; 50 is the typical published value. Format: CHATHISTORY=<max_msgs_per_burst>',
    example: 'CHATHISTORY=50',
    ircv3: 'https://ircv3.net/specs/extensions/chathistory',
    status: 'ircv3',
  },
  {
    key: 'MSGREFTYPES',
    category: 'messages',
    kind: 'pair',
    title: 'Message reference types',
    short: 'Which @msgid / @timestamp reference types the server emits on PRIVMSG / NOTICE.',
    detail: 'Comma-separated list of IRCv3 message-tags the server attaches to messages. "msgid" produces a per-message UUID; "timestamp" produces the server-side send time as a tag. Clients can use these to drive deduplication, history fetching, replay protection, and ordering.',
    example: 'MSGREFTYPES=msgid,timestamp',
    ircv3: 'https://ircv3.net/specs/extensions/message-ids',
    status: 'ircv3',
  },
  {
    key: 'CLIENTTAGDENY',
    category: 'messages',
    kind: 'pair',
    title: 'Client-tag deny list',
    short: 'Which client-only message tags the server strips from incoming messages.',
    detail: 'Per IRCv3 message-tags spec, certain message tags are server-managed (e.g. @time); client-only tags must be explicitly listed by the client or the server strips them. The default list is "*" (strip all). Servers publish CLIENTTAGDENY so clients know which tags to opt into via CAP REQ.',
    example: 'CLIENTTAGDENY=*,-draft/channel-context,-draft/reply',
    ircv3: 'https://ircv3.net/specs/extensions/message-tags',
    status: 'ircv3',
  },

  // ── capabilities (bare flags) ──────────────────────────────────
  {
    key: 'KNOCK',
    category: 'capabilities',
    kind: 'flag',
    title: 'KNOCK command',
    short: 'Server supports KNOCK — politely requesting entry to an invite-only channel.',
    detail: 'When a channel is +i (invite-only) a non-member can send KNOCK #chan :reason to ask members to /invite them. The server broadcasts a server NOTICE to channel members. Some networks disable KNOCK because it’s considered noisy.',
    rfc: 'https://github.com/ircv3/ircv3-specifications/blob/main/extensions/knock.md',
    status: 'extended',
  },
  {
    key: 'DEAF',
    category: 'capabilities',
    kind: 'flag',
    title: 'DEAF user mode',
    short: 'Server supports the user-mode "d" (deaf). Disabled users ignore channel messages except direct ones.',
    detail: 'When a user sets user-mode +d (DEAF), the server stops delivering channel messages to them. PRIVMSG to them directly still works. Useful for IRC operators during catastrophic events to silence non-essential traffic.',
    status: 'extended',
  },
  {
    key: 'MONITOR',
    category: 'capabilities',
    kind: 'int',
    title: 'MONITOR command',
    short: 'Server implements the IRCv3 extended-monitor command with N-entry watch list.',
    detail: 'MONITOR + nick + nick adds nicks to a watch list; server emits RPL_MONOFFLINE / RPL_MONONLINE numerics as connections state changes. Replaces RFC 2812\'s deprecated WATCH.',
    example: 'MONITOR=128',
    ircv3: 'https://ircv3.net/specs/extensions/extended-monitor',
    status: 'ircv3',
  },
  {
    key: 'WATCH',
    category: 'capabilities',
    kind: 'int',
    title: 'WATCH command (deprecated)',
    short: 'Legacy RFC 2812 / RFC 1459 user-notify command.',
    detail: 'Tracks nicks and emits 600/601 numerics for online / offline transitions. Modern IRCds have replaced WATCH with MONITOR — IRC Fiber clients should prefer MONITOR when both are present.',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc1459#section-4.5.2',
    status: 'legacy',
  },
  {
    key: 'BOT',
    category: 'capabilities',
    kind: 'flag',
    title: 'BOT user mode',
    short: 'Server supports the user-mode "B" (bot).',
    detail: 'When +B is set, the user is identified as a bot and many IRCds suppress certain interesting notifications. Some networks additionally exempt bots from flood limits. The mode letter is typically "B".',
    example: 'BOT=B',
    status: 'extended',
  },
  {
    key: 'CALLERID',
    category: 'capabilities',
    kind: 'flag',
    title: 'Caller ID',
    short: 'Server implements user-mode +g (caller-id). Approved contacts can bypass.',
    detail: '+g hides the user from regular PRIVMSGs; only users that are in the ACCEPT list (or on a shared channel) can message them. ACCEPT and SILENCE are also affected.',
    example: 'CALLERID=g',
    status: 'extended',
  },
  {
    key: 'REGNICK',
    category: 'capabilities',
    kind: 'flag',
    title: 'Registered-nick prefix',
    short: 'Nicks identified to services are flagged with a special prefix.',
    detail: 'When REGNICK is advertised, nicks registered with services (NickServ) gain a visible prefix character (typically "~") in member lists. The exact prefix varies — the flag is informational; the actual prefix is published via the IRC command RPL_ISUPPORT\'s "REGNICK" but at runtime the prefix shows up in NAMES responses.',
    status: 'extended',
  },
  {
    key: 'SILENCE',
    category: 'capabilities',
    kind: 'flag',
    title: 'SILENCE command',
    short: 'Server supports the per-user SILENCE list.',
    detail: 'SILENCE +*!*@host adds a per-user block; the server drops PRIVMSGs from matching masks. Deprecated in favour of user-mode +g (CALLERID) + ACCEPT, but still supported on most IRCds.',
    example: 'SILENCE',
    rfc: 'https://datatracker.ietf.org/doc/html/rfc2812#section-4.6.4',
    status: 'legacy',
  },
  {
    key: 'WALLCHOPS',
    category: 'capabilities',
    kind: 'flag',
    title: 'WALLCHOPS command',
    short: 'Server supports sending PRIVMSGs only to channel ops.',
    detail: 'WALLCHOPS #chan :text sends a status message to channel ops only; survives across +m / moderated / silenced normal users.',
    status: 'extended',
  },
  {
    key: 'ACCEPT',
    category: 'capabilities',
    kind: 'flag',
    title: 'ACCEPT command',
    short: 'Server supports per-user /ACCEPT — the modern replacement for SILENCE.',
    detail: '/ACCEPT nick … or /ACCEPT *!*@host maintains an allowlist; users on the list bypass user-mode +g (CALLERID). ACCEPT 2 generates a numeric reply on success / failure.',
    example: 'ACCEPT',
    ircv3: 'https://ircv3.net/specs/extensions/accept',
    status: 'ircv3',
  },
  {
    key: 'ACCEPT2',
    category: 'capabilities',
    kind: 'flag',
    title: 'ACCEPT 2 (numeric reply)',
    short: 'Server replies to ACCEPT with numeric codes (older P10-style ACCEPT).',
    detail: 'Some networks accept ACCEPT but use a non-numeric reply. ACCEPT2 indicates the server replies with RPL_ACCEPTLIST numerics instead.',
    status: 'extended',
  },
  {
    key: 'WHOX',
    category: 'capabilities',
    kind: 'flag',
    title: 'WHO extension (%<flag> fields)',
    short: 'Server supports WHO %<field-tags> — fetch extra WHO reply fields with custom percent-codes.',
    detail: 'WHO #chan %cuhsnf,1 returns channel, username, hostname, server, nick, flags — useful for gathering batched account / away / real-name data without separate WHOIS requests.',
    example: 'WHOX',
    status: 'extended',
  },
  {
    key: 'CPRIVMSG',
    category: 'capabilities',
    kind: 'flag',
    title: 'Channel-context PRIVMSG',
    short: 'Server supports @#channel-message-prefixed PRIVMSGs.',
    detail: 'CPRIVMSG @#chan nick :hello delivers the message to a user in the context of #chan (recipient sees "hello" scoped to that channel rather than as a /query). CNOTICE is the NOTICE counterpart.',
    example: 'CPRIVMSG CNOTICE',
    status: 'extended',
  },
  {
    key: 'SAFELIST',
    category: 'capabilities',
    kind: 'flag',
    title: 'Safe LIST batching',
    short: 'Server responds to LIST with SAFE BATCH-style numerics to avoid burst disconnects.',
    detail: 'When SAFELIST is advertised, LIST responses are batched under a BATCH tag so the server does not disconnect the client for exceeding the flood rate. Modern IRCv3 clients always assume SAFELIST behaviour.',
    ircv3: 'https://ircv3.net/specs/extensions/batch',
    status: 'ircv3',
  },
  {
    key: 'ELIST',
    category: 'capabilities',
    kind: 'mask',
    title: 'LIST extensions',
    short: 'Server supports extra arguments to LIST. One or more of: M (mask-based), N (no wildcards), U (only channels with you), T (~topic mask).',
    detail: 'LIST #foo 10 … typically returns all matching channels. ELIST=MT means the server accepts a mask (M) and a topic mask (T); ELIST=MNUT is the most permissive set.',
    example: 'ELIST=MNUT',
    status: 'extended',
  },
  {
    key: 'UTF8ONLY',
    category: 'capabilities',
    kind: 'flag',
    title: 'UTF-8-only mode',
    short: 'Server enforces that nick / channel / topic / away are UTF-8 only.',
    detail: 'When advertised, clients must send UTF-8 for all of those fields. Server rejects non-UTF-8 input with a numeric error. UTF8MAPPING is the related ISO / UTF mapping identifier.',
    status: 'extended',
  },
  {
    key: 'UTF8MAPPING',
    category: 'capabilities',
    kind: 'string',
    title: 'UTF-8 character mapping',
    short: 'How UTF-8 is converted to the server\'s internal "folded" character set.',
    detail: 'Each character in the value is a 6-bit mapping value (0–255). Values "rfc8266", "strict-rfc8266", or "precis" identify the modern mapping the server uses. Most clients can ignore this and pass through UTF-8 unchanged.',
    example: 'UTF8MAPPING=rfc8266',
    status: 'extended',
  },
  {
    key: 'LANGUAGE',
    category: 'capabilities',
    kind: 'language',
    title: 'Server languages',
    short: 'Comma-separated list of language tags the server can localise its responses into.',
    detail: 'Server responds in the negotiated language for numerics / message bodies when LANG / LANGUAGE is supported. Negotiation is via a CAP-LS handler.',
    example: 'LANGUAGE=en,de,fr',
    status: 'extended',
  },
  {
    key: 'FNC',
    category: 'capabilities',
    kind: 'flag',
    title: 'Force Nick Change',
    short: 'Server enforces nick change for users whose nick becomes INVALID mid-session.',
    detail: 'When the server detects a nick is no longer valid (services-ban, change of policy, etc.) FNC triggers an automatic NICK change rather than simply KILLING the user. Gives the user a grace tick to update scripts / clients.',
    example: 'FNC',
    status: 'extended',
  },
  {
    key: 'ETSDELIM',
    category: 'capabilities',
    kind: 'string',
    title: 'Extended Tag delimiter',
    short: 'Server uses an alternative delimiter character for tag keys instead of the default dash (-).',
    detail: 'Tags use "-" by default; some servers prefer "_" or ".". This token publishes the delimiter so client implementations can parse tags correctly. IRCv3-flavoured tags are always dash-delimited; this token was used before the IRCv3 spec converged on "-".',
    example: 'ETSDELIM=;',
    status: 'legacy',
  },
  {
    key: 'IRCD',
    category: 'server-identity',
    kind: 'string',
    title: 'IRCd product',
    short: 'Server software identifier (advertised on some networks; not standardised).',
    detail: 'Non-standard. Some IRCds publish IRCD=<product>:<version> as a courtesy for diagnostic purposes. Values like "charybdis-4.0.0" or "ergo-2.18.0" let clients log the server software on connect.',
    example: 'IRCD=charybdis-4.0.0',
    status: 'extended',
  },
];

// ── Lookup helpers ───────────────────────────────────────────────

/** Lowercase, hyphen-normalised key for lookups (so PREFIX and prefix
 *  resolve the same entry). */
export function normaliseIsupportKey(key: string): string {
  return key.toUpperCase();
}

export function lookupIsupport(key: string): IsupportEntry | undefined {
  const upper = normaliseIsupportKey(key);
  return ISUPPORT_CATALOG.find((e) => e.key === upper);
}

/** When a token is in the catalog we can show the canonical spec link
 *  for it; otherwise no link is returned. The URL is taken from the
 *  RFC field first, then IRCv3 — preferring the RFC for tokens that
 *  have both because the RFC is the more stable identifier. */
export function referenceUrlFor(entry: IsupportEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.rfc ?? entry.ircv3;
}
