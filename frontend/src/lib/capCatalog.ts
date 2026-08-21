// ─────────────────────────────────────────────────────────────────────
// CAP (IRCv3 capability negotiation) catalog
// ─────────────────────────────────────────────────────────────────────
// Mirrors `isupportCatalog.ts` but for IRCv3 CAP LS / CAP REQ tokens
// (account-notify, extended-join, sasl, batch, …). Each entry carries
// a human-readable description, canonical example, and links to the
// originating IRCv3 spec so the CapabilitiesPanel can show
// "what is this cap, what does it do, where is it specified" — the
// same information shape as https://ircv3.net/specs/extensions/*
// and the landing https://ircv3.net/irc/ .
//
// Coverage:
//   · IRCv3.1 core caps (account-notify … multi-prefix)
//   · IRCv3.2 caps (account-tag, batch, cap-notify, chghost, …)
//   · Draft extensions (draft/* — chathistory, persistence, …)
//   · Vendor caps (znc.in/*, ergo.chat/*, soju.im/*)
//   · SASL values (PLAIN, EXTERNAL, SCRAM-SHA-1, …) surfaced via `sasl=`
//
// The catalog is intentionally a static, read-only array; the
// categorize layer derives buckets from `category` so adding a new
// cap is a one-line change. `lookupCap` indexes by canonical key.
// ─────────────────────────────────────────────────────────────────────

export type CapKind =
  | 'flag'      // bare cap name (no =value)
  | 'value'     // cap with =value payload (e.g. sasl=PLAIN, draft/languages=…)
  | 'vendor';   // vendor-namespaced cap (znc.in/*, ergo.chat/*, …)

export type CapCategoryId =
  | 'authentication'
  | 'account'
  | 'away'
  | 'batch'
  | 'channel'
  | 'messaging'
  | 'monitoring'
  | 'draft'
  | 'vendor'
  | 'server-specific';

export interface CapCategory {
  id: CapCategoryId;
  name: string;
  title: string;
  blurb: string;
  icon: string;
}

export interface CapEntry {
  key: string;                    // canonical lower-case name, e.g. "account-notify"
  category: CapCategoryId;
  kind: CapKind;
  title: string;
  short: string;                  // one-line blurb for the list view
  detail: string;                 // 1-3 sentences for the drawer
  example?: string;
  rfc?: string;
  ircv3?: string;
  since?: string;
  status?: 'core' | 'extended' | 'draft' | 'vendor' | 'ircv3';
}

export const CAP_CATEGORIES: readonly CapCategory[] = [
  {
    id: 'authentication',
    name: 'Auth',
    title: 'Authentication & identity',
    blurb: 'SASL, account tracking, and user identity changes.',
    icon: '◈',
  },
  {
    id: 'account',
    name: 'Account',
    title: 'Account & user tracking',
    blurb: 'Who is logged in, extended JOIN metadata, and realname / CHGHOST updates.',
    icon: '◎',
  },
  {
    id: 'away',
    name: 'Away',
    title: 'Away & presence',
    blurb: 'Away state broadcasts and pre-away negotiation.',
    icon: '◯',
  },
  {
    id: 'batch',
    name: 'Batch',
    title: 'Batch & multiplexing',
    blurb: 'Server-side batching for history, netsplits, and atomic message groups.',
    icon: '▦',
  },
  {
    id: 'channel',
    name: 'Channel',
    title: 'Channel management',
    blurb: 'Channel renames, invite notifications, prefix display, and membership rules.',
    icon: '#',
  },
  {
    id: 'messaging',
    name: 'Messaging',
    title: 'Message delivery & tags',
    blurb: 'Echo, server-time, message tags, and reply labelling.',
    icon: '⌬',
  },
  {
    id: 'monitoring',
    name: 'Monitor',
    title: 'Monitoring & capability events',
    blurb: 'cap-notify, extended-monitor, and self-message delivery.',
    icon: '◇',
  },
  {
    id: 'draft',
    name: 'Draft',
    title: 'Draft extensions',
    blurb: 'In-progress IRCv3 drafts advertised with the draft/ prefix.',
    icon: '⊕',
  },
  {
    id: 'vendor',
    name: 'Vendor',
    title: 'Vendor & bouncer extensions',
    blurb: 'Bouncer / IRCd-specific caps such as znc.in/* and ergo.chat/*.',
    icon: '⟁',
  },
  {
    id: 'server-specific',
    name: 'Custom',
    title: 'Server-specific capabilities',
    blurb: 'Caps not in the public catalog — specific to this IRCd or bouncer.',
    icon: '⬡',
  },
];

export const CAP_CATALOG: readonly CapEntry[] = [
  // ── authentication ────────────────────────────────────────────
  {
    key: 'sasl',
    category: 'authentication',
    kind: 'value',
    title: 'SASL authentication',
    short: 'Publish supported SASL mechanisms; client selects one via AUTHENTICATE.',
    detail: 'The sasl cap advertises the server SASL mechanisms as a comma-separated list (e.g. PLAIN, EXTERNAL, SCRAM-SHA-256). The client negotiates a mechanism with AUTHENTICATE and CAP REQ :sasl. Without this cap no SASL handshake is possible.',
    example: 'sasl=PLAIN,EXTERNAL',
    ircv3: 'https://ircv3.net/specs/extensions/sasl-3.1',
    since: 'IRCv3 3.1',
    status: 'ircv3',
  },
  {
    key: 'cap-notify',
    category: 'monitoring',
    kind: 'flag',
    title: 'cap-notify',
    short: 'Server sends CAP NEW / DEL when its capability set changes.',
    detail: 'Lets clients react to capability set changes mid-session without polling CAP LS. The server emits CAP * NEW / DEL <cap list> when caps are added or removed.',
    ircv3: 'https://ircv3.net/specs/extensions/cap-notify-3.2',
    since: 'IRCv3 3.2',
    status: 'ircv3',
  },
  // ── account ───────────────────────────────────────────────────
  {
    key: 'account-notify',
    category: 'account',
    kind: 'flag',
    title: 'account-notify',
    short: 'Server broadcasts ACCOUNT messages when a user logs in or out.',
    detail: 'Clients receive :nick!user@host ACCOUNT accountname (or "*" on logout). Lets the member list and buffer state track who is identified to services without repeated WHOIS.',
    ircv3: 'https://ircv3.net/specs/extensions/account-notify-3.1',
    since: 'IRCv3 3.1',
    status: 'ircv3',
  },
  {
    key: 'account-tag',
    category: 'account',
    kind: 'flag',
    title: 'account-tag',
    short: 'Every PRIVMSG carries an @account tag with the sender service account.',
    detail: 'Similar to account-notify but per-message: each PRIVMSG / NOTICE includes account=<name> or "*" when unauthenticated. Clients can correlate messages to accounts without storing extra state.',
    ircv3: 'https://ircv3.net/specs/extensions/account-tag-3.2',
    since: 'IRCv3 3.2',
    status: 'ircv3',
  },
  {
    key: 'extended-join',
    category: 'account',
    kind: 'flag',
    title: 'extended-join',
    short: 'JOIN includes the account name and real name as trailing params.',
    detail: 'Standard JOIN becomes :nick!user@host JOIN #chan account :realname so a client learns who is identified on join without an extra WHO query.',
    ircv3: 'https://ircv3.net/specs/extensions/extended-join-3.1',
    since: 'IRCv3 3.1',
    status: 'ircv3',
  },
  {
    key: 'chghost',
    category: 'account',
    kind: 'flag',
    title: 'chghost',
    short: 'Server sends CHGHOST when a user changes ident or hostname.',
    detail: 'Broadcast :old!user@oldhost CHGHOST newuser newhost updates a client membership or who state without re-WHOing.',
    ircv3: 'https://ircv3.net/specs/extensions/chghost-3.2',
    since: 'IRCv3 3.2',
    status: 'ircv3',
  },
  {
    key: 'setname',
    category: 'account',
    kind: 'flag',
    title: 'setname',
    short: 'Clients may change their real name mid-session via SETNAME.',
    detail: 'Without setname the real name is fixed at registration. SETNAME <newname> broadcasts SETNAME to shared channels so presence stays correct.',
    ircv3: 'https://ircv3.net/specs/extensions/setname',
    since: 'IRCv3',
    status: 'ircv3',
  },
  {
    key: 'userhost-in-names',
    category: 'account',
    kind: 'flag',
    title: 'userhost-in-names',
    short: 'RPL_NAMREPLY includes full user@host for every nick.',
    detail: 'Normally NAMES lists bare nicks. With this cap each entry becomes nick!user@host, giving the roster full masks without extra WHO calls.',
    ircv3: 'https://ircv3.net/specs/extensions/userhost-in-names-3.2',
    since: 'IRCv3 3.2',
    status: 'ircv3',
  },
  // ── away ──────────────────────────────────────────────────────
  {
    key: 'away-notify',
    category: 'away',
    kind: 'flag',
    title: 'away-notify',
    short: 'Server broadcasts AWAY messages when a user sets or clears away.',
    detail: 'Clients receive :nick!user@host AWAY [:reason] and can render away badges without polling WHO.',
    ircv3: 'https://ircv3.net/specs/extensions/away-notify-3.1',
    since: 'IRCv3 3.1',
    status: 'ircv3',
  },
  // ── batch ─────────────────────────────────────────────────────
  {
    key: 'batch',
    category: 'batch',
    kind: 'flag',
    title: 'batch',
    short: 'Server groups related messages inside BATCH +reference / -reference wrappers.',
    detail: 'Used for CHATHISTORY, netsplit batches, and other multi-message transactions. Clients should treat messages inside a batch with the same batch id as atomic.',
    ircv3: 'https://ircv3.net/specs/extensions/batch-3.2',
    since: 'IRCv3 3.2',
    status: 'ircv3',
  },
  // ── channel ───────────────────────────────────────────────────
  {
    key: 'multi-prefix',
    category: 'channel',
    kind: 'flag',
    title: 'multi-prefix',
    short: 'NAMES and WHO replies include every prefix a nick holds, not just the highest.',
    detail: 'Without this cap only the highest channel status (e.g. @) is shown. With multi-prefix a nick with op and voice appears as "@+nick".',
    ircv3: 'https://ircv3.net/specs/extensions/multi-prefix-3.1',
    since: 'IRCv3 3.1',
    status: 'ircv3',
  },
  {
    key: 'invite-notify',
    category: 'channel',
    kind: 'flag',
    title: 'invite-notify',
    short: 'Invites are broadcast to the target channel as INVITE messages.',
    detail: 'Lets channel members see who invited whom without relying on a channel NOTICE side-channel.',
    ircv3: 'https://ircv3.net/specs/extensions/invite-notify-3.2',
    since: 'IRCv3 3.2',
    status: 'ircv3',
  },
  {
    key: 'extended-monitor',
    category: 'monitoring',
    kind: 'flag',
    title: 'extended-monitor',
    short: 'MONITOR tracks more events than the base MONITOR spec.',
    detail: 'Adds extended online / away tracking to MONITOR. Backwards compatible with plain monitor clients.',
    ircv3: 'https://ircv3.net/specs/extensions/extended-monitor',
    since: 'IRCv3',
    status: 'ircv3',
  },
  // ── messaging ─────────────────────────────────────────────────
  {
    key: 'echo-message',
    category: 'messaging',
    kind: 'flag',
    title: 'echo-message',
    short: 'Your own PRIVMSG / NOTICE / TAGMSG is echoed back with server-time.',
    detail: 'Without this cap your own messages only survive locally. With it the server echoes :you!... PRIVMSG target :text including message-tags the server adds (server-time, msgid).',
    ircv3: 'https://ircv3.net/specs/extensions/echo-message-3.2',
    since: 'IRCv3 3.2',
    status: 'ircv3',
  },
  {
    key: 'server-time',
    category: 'messaging',
    kind: 'flag',
    title: 'server-time',
    short: 'Every message carries a @time tag with the server receive time.',
    detail: 'Iso-8601 timestamp (e.g. @time=2026-08-21T19:00:00.000Z). Clients use this for correct ordering across bouncers and disconnects.',
    ircv3: 'https://ircv3.net/specs/extensions/server-time-3.2',
    since: 'IRCv3 3.2',
    status: 'ircv3',
  },
  {
    key: 'message-tags',
    category: 'messaging',
    kind: 'flag',
    title: 'message-tags',
    short: 'Server negotiates the message-tags cap so clients may send client-side tags.',
    detail: 'Gate for IRCv3 message-tags. Without it only server-issued tags are forwarded. With it clients can send @+tag=value on commands.',
    ircv3: 'https://ircv3.net/specs/extensions/message-tags-3.3',
    since: 'IRCv3 3.3',
    status: 'ircv3',
  },
  {
    key: 'labeled-response',
    category: 'messaging',
    kind: 'flag',
    title: 'labeled-response',
    short: 'Requests carry a label; the corresponding reply / error is tagged with that label.',
    detail: 'Client sends @label=xxx PRIVMSG ...; server replies with the same label on the matching numeric or FAIL. Replaces loose numeric pairing.',
    ircv3: 'https://ircv3.net/specs/extensions/labeled-response',
    since: 'IRCv3',
    status: 'ircv3',
  },
  {
    key: 'standard-replies',
    category: 'messaging',
    kind: 'flag',
    title: 'standard-replies',
    short: 'Server uses FAIL / WARN / NOTE standardized error replies.',
    detail: 'Replaces assorted numeric error replies with structured FAIL <cmd> <code> :human message lines that clients can parse reliably.',
    ircv3: 'https://ircv3.net/specs/extensions/standard-replies',
    since: 'IRCv3',
    status: 'ircv3',
  },
  // ── draft extensions ──────────────────────────────────────────
  {
    key: 'draft/account-registration',
    category: 'draft',
    kind: 'value',
    title: 'draft/account-registration',
    short: 'Inline account registration during connect (before-connect vs after-connect).',
    detail: 'When draft/account-registration=before-connect the server accepts REGISTER before NICK/USER so the account is ready on welcome. Values: before-connect or after-connect.',
    example: 'draft/account-registration=before-connect',
    ircv3: 'https://ircv3.net/specs/extensions/account-registration',
    since: 'draft',
    status: 'draft',
  },
  {
    key: 'draft/channel-rename',
    category: 'draft',
    kind: 'flag',
    title: 'draft/channel-rename',
    short: 'Channels may be renamed server-side; clients receive RENAME broadcasts.',
    detail: 'Used on Ergo and similar IRCds to support renames like #foo → #bar while keeping membership intact.',
    ircv3: 'https://ircv3.net/specs/extensions/channel-rename',
    since: 'draft',
    status: 'draft',
  },
  {
    key: 'draft/chathistory',
    category: 'draft',
    kind: 'flag',
    title: 'draft/chathistory',
    short: 'CHATHISTORY lets clients fetch backlog before / after a point in time.',
    detail: 'Replaces per-IRCd history quirks. Clients fetch with CHATHISTORY TARGET timestamp ... and receive messages inside a batch.',
    ircv3: 'https://ircv3.net/specs/extensions/chathistory',
    since: 'draft',
    status: 'draft',
  },
  {
    key: 'draft/event-playback',
    category: 'draft',
    kind: 'flag',
    title: 'draft/event-playback',
    short: 'Server replays structured events (JOIN / PART / MODE) as playback rather than live notices.',
    detail: 'Part of the persistence / event-playback family. History replays use BATCH event-playback so clients can distinguish live from historical traffic.',
    ircv3: 'https://ircv3.net/specs/extensions/event-playback',
    since: 'draft',
    status: 'draft',
  },
  {
    key: 'draft/extended-isupport',
    category: 'draft',
    kind: 'flag',
    title: 'draft/extended-isupport',
    short: 'ISUPPORT may carry IRCv3-specific tokens beyond RFC 2812.',
    detail: 'Signals that 005 may contain IRCv3-era tokens (e.g. CASEMAPPING=ascii, UTF8MAPPING, IMPLICIT, ...). Clients that understand them can avoid fallback lookups.',
    ircv3: 'https://ircv3.net/specs/extensions/extended-isupport',
    since: 'draft',
    status: 'draft',
  },
  {
    key: 'draft/languages',
    category: 'draft',
    kind: 'value',
    title: 'draft/languages',
    short: 'Server advertises which human languages it can localise replies into.',
    detail: 'Advertising form draft/languages=N,list where N is language count and list is comma-separated BCP 47 tags (en, de, fr-FR, ...). Negotiation is via LANGUAGE / LANG.',
    example: 'draft/languages=17,en,~bs,~de,~el,~en-AU,~es,~fi,~fr-FR,~it,~nl,~no,~pl,~pt-BR,~ro,~sq-AL,~tr-TR,~zh-CN',
    ircv3: 'https://ircv3.net/specs/extensions/languages',
    since: 'draft',
    status: 'draft',
  },
  {
    key: 'draft/no-implicit-names',
    category: 'draft',
    kind: 'flag',
    title: 'draft/no-implicit-names',
    short: 'JOIN no longer implicitly sends NAMES; clients must issue NAMES or CHATHISTORY explicitly.',
    detail: 'Avoids the large NAMES burst on every JOIN for clients that already have a coherent roster via other means (e.g. sync).',
    ircv3: 'https://ircv3.net/specs/extensions/no-implicit-names',
    since: 'draft',
    status: 'draft',
  },
  {
    key: 'draft/persistence',
    category: 'draft',
    kind: 'flag',
    title: 'draft/persistence',
    short: 'Server supports persistent sessions and deferred message replay.',
    detail: 'Clients that disconnect briefly can reattach and receive missed messages. Backed by draft/event-playback and history batches.',
    ircv3: 'https://ircv3.net/specs/extensions/persistence',
    since: 'draft',
    status: 'draft',
  },
  {
    key: 'draft/pre-away',
    category: 'draft',
    kind: 'flag',
    title: 'draft/pre-away',
    short: 'Away state can be negotiated before registration completes.',
    detail: 'Clients may send AWAY before welcome so presence is correct from the first JOIN visible to peers.',
    ircv3: 'https://ircv3.net/specs/extensions/pre-away',
    since: 'draft',
    status: 'draft',
  },
  {
    key: 'draft/read-marker',
    category: 'draft',
    kind: 'flag',
    title: 'draft/read-marker',
    short: 'Server implements READ markers (MARKREAD / msgid-based read tracking).',
    detail: 'Clients send MARKREAD #chan msgid:<id> and the server broadcasts read markers per channel/account. Used for unread tracking that survives bouncer disconnects.',
    ircv3: 'https://ircv3.net/specs/extensions/read-marker',
    since: 'draft',
    status: 'draft',
  },
  // ── vendor / bouncer ──────────────────────────────────────────
  {
    key: 'znc.in/playback',
    category: 'vendor',
    kind: 'flag',
    title: 'znc.in/playback',
    short: 'ZNC bouncer — play back buffered messages on attach.',
    detail: 'ZNC-specific cap: on reattach the bouncer replays buffered traffic as batch playback so clients see history without CHATHISTORY.',
    ircv3: 'https://wiki.znc.in/Capabilities',
    since: 'ZNC',
    status: 'vendor',
  },
  {
    key: 'znc.in/self-message',
    category: 'vendor',
    kind: 'flag',
    title: 'znc.in/self-message',
    short: 'ZNC bouncer — echo your own messages sent from other ZNC clients.',
    detail: 'When you send a PRIVMSG from one ZNC connection, other attached connections receive it as a self-message so all clients render the sent message.',
    ircv3: 'https://wiki.znc.in/Capabilities',
    since: 'ZNC',
    status: 'vendor',
  },
  {
    key: 'ergo.chat/nope',
    category: 'vendor',
    kind: 'flag',
    title: 'ergo.chat/nope',
    short: 'Ergo sentinel cap — used as an always-available ACK/NAK check.',
    detail: 'Ergo advertises ergo.chat/nope as a no-op cap that is always present. Clients use it to probe the CAP negotiation path in tests.',
    since: 'Ergo',
    status: 'vendor',
  },
  {
    key: 'soju.im/bouncer-networks',
    category: 'vendor',
    kind: 'flag',
    title: 'soju.im/bouncer-networks',
    short: 'soju bouncer — BOUNCER command for managing bound upstream networks.',
    detail: 'Lets a bouncer expose per-network RPL_ISUPPORT / roster state to thin clients that speak the soju extension.',
    ircv3: 'https://soju.im/doc/soju.1.html',
    since: 'soju',
    status: 'vendor',
  },
];

// ── Lookup helpers ───────────────────────────────────────────────

export function normaliseCapKey(key: string): string {
  return key.toLowerCase();
}

export function lookupCap(key: string): CapEntry | undefined {
  const k = key.toLowerCase();
  return CAP_CATALOG.find((e) => e.key === key || e.key.toLowerCase() === k);
}

export function referenceUrlFor(entry: CapEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.ircv3 ?? entry.rfc;
}
