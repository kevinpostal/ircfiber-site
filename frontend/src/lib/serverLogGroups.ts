import type { IRCMessage } from '../types';

/**
 * Classify a single message inside the `_server` buffer into one of:
 *   - 'phase'   — engine-emitted progress event (carries `msg.phase`)
 *   - 'motd'    — RPL_MOTDSTART / RPL_MOTD / RPL_ENDOFMOTD (numeric 375/372/376)
 *   - 'cap'     — RPL_ISUPPORT (numeric 005), the long CAP token dump
 *   - 'numeric' — any other numeric (e.g. 002/003/004 RPL_YOURHOST/SERVER/ISUPPORT)
 *   - 'notice'  — raw IRC server NOTICE (host name as nick, no phase)
 *   - 'lifecycle' — synthetic CONNECT / DISCONNECT / CONNECTED / DISCONNECTED
 *   - 'skip'    — PING/PONG/etc. — drop from the card view
 *
 * The classification is purely from the IRC command + nick + phase tag, so
 * it works for live WebSocket events, REST history loads, and replayed
 * scrollback uniformly.
 */
export type ServerLogKind =
  | 'phase'
  | 'motd'
  | 'welcome'
  | 'cap'
  | 'numeric'
  | 'notice'
  | 'lifecycle'
  | 'skip';

export function classifyServerLog(msg: IRCMessage): ServerLogKind {
  if (msg.phase) return 'phase';
  const cmd = msg.command;
  if (cmd === 'PING' || cmd === 'PONG' || cmd === 'ERROR') return 'skip';
  if (cmd === 'CONNECT' || cmd === 'DISCONNECT' || cmd === 'CONNECTED' || cmd === 'DISCONNECTED') {
    return 'lifecycle';
  }
  if (cmd === 'NOTICE') return 'notice';
  // Numeric IRC replies
  if (cmd === '005') return 'cap';
  if (cmd === '372' || cmd === '375' || cmd === '376') return 'motd';
  // RPL_WELCOME / YOURHOST / CREATED / MYINFO — server's connection banner.
  // Always visible like MOTD.
  if (cmd === '001' || cmd === '002' || cmd === '003' || cmd === '004') return 'welcome';
  if (/^\d{3}$/.test(cmd)) return 'numeric';
  return 'notice';
}

/**
 * Phases that mark the START of a new connection attempt. The first one we
 * see in the buffer (or after a previous attempt ended) opens a new card.
 * `tcp_open` deliberately is NOT here — it always follows `connecting` in
 * the same attempt, so treating it as a fresh boundary would split a single
 * connection into two cards.
 */
const START_PHASES = new Set(['queued', 'resolving', 'connecting']);

/**
 * Phases / commands that mark the END of an attempt. After this we close
 * the card and the next START_PHASES event opens the next one.
 */
function isEndOfAttempt(msg: IRCMessage): boolean {
  if (msg.phase === 'welcome' || msg.phase === 'error') return true;
  if (msg.command === 'DISCONNECT' || msg.command === 'DISCONNECTED') return true;
  return false;
}

/**
 * Sub-buckets inside one attempt that drive the card layout:
 *   - phases  : the timeline backbone (one row per phase event)
 *   - motd    : MOTD lines (always visible, grouped at the end)
 *   - welcome : RPL_WELCOME/YOURHOST/CREATED/MYINFO (001-004) — always
 *              visible like MOTD, these are the server's welcome banner
 *   - cap     : RPL_ISUPPORT / CAP LS dumps (collapsed <details>)
 *   - notices : raw IRC server notices (collapsed <details>)
 *   - numeric : other numerics (collapsed <details>)
 */
export interface ServerLogAttempt {
  /** First phase event in the attempt — drives card header (timestamp, host) */
  start: IRCMessage;
  /** Last phase event in the attempt if it has ended; null = in flight */
  end: IRCMessage | null;
  /** Phase events in order, used for the timeline backbone */
  phases: IRCMessage[];
  /** MOTD lines (RPL_MOTDSTART / RPL_MOTD / RPL_ENDOFMOTD) */
  motd: IRCMessage[];
  /** Connection banner numerics: 001 (RPL_WELCOME), 002, 003, 004 — always visible */
  welcome: IRCMessage[];
  /** RPL_ISUPPORT (005) — typically one massive line with all CAPs */
  cap: IRCMessage[];
  /** Raw IRC server NOTICEs (host name as nick, no phase) */
  notices: IRCMessage[];
  /** Other numeric replies (visible inline, muted) */
  numeric: IRCMessage[];
  /** Status the engine gave the attempt — derived from phases + end */
  status: 'pending' | 'success' | 'error' | 'disconnected';
}

/**
 * Group a flat list of `_server`-buffer messages into connection attempts.
 *
 * An attempt starts at the first message with `phase ∈ START_PHASES` or a
 * synthetic CONNECT, and ends at the next `phase=welcome|error` or
 * DISCONNECT/DISCONNECTED. Anything between attempts that doesn't fit a
 * card is dropped into a final synthetic "tail" attempt so it's still
 * visible (raw server chatter before the first attempt, for example).
 *
 * Messages classified as `skip` (PING/PONG) are filtered out entirely.
 * Pre-attempt messages that aren't lifecycle events land in the tail
 * attempt so users still see them.
 */
export function groupServerLog(messages: IRCMessage[]): ServerLogAttempt[] {
  // Drop duplicate phase events before grouping. The engine + holder
  // daemon can each publish their own `ph=queued|tcp_open|tls|registering`
  // sequence for the same physical connect — the engine fires phases
  // from its direct `happyEyeballsConnect()` path while the holder fires
  // the equivalent `via holder daemon` phases, and the WS handoff
  // publishes them again. Without this dedup each duplicate sequence
  // becomes a separate timeline card. We dedup phase-tagged messages
  // with identical `(t, phase)` AND identical text — cheap and
  // conservative — so chat-shaped messages (which lack a `phase`)
  // pass through untouched.
  const dedupedMessages = dedupPhaseEvents(messages);

  const attempts: ServerLogAttempt[] = [];
  let current: ServerLogAttempt | null = null;
  // The most-recently-pushed attempt, used to detect "post-welcome
  // chatter" (MOTD / RPL_ISUPPORT / raw NOTICEs that arrive after the
  // connection is up but before any new START phase fires). Without
  // this we'd open a fresh synthetic card for every MOTD line.
  let lastAttempt: ServerLogAttempt | null = null;
  // Track which attempts have already been added to `attempts` so that
  // reopening one for post-welcome chatter doesn't push it a second
  // time at end-of-loop.
  const pushed = new WeakSet<ServerLogAttempt>();

  function pushCurrent(): void {
    if (current && !pushed.has(current)) {
      attempts.push(current);
      pushed.add(current);
      lastAttempt = current;
      current = null;
    } else {
      // Either null or already pushed (reopened from lastAttempt).
      current = null;
    }
  }

  for (const msg of dedupedMessages) {
    const kind = classifyServerLog(msg);
    if (kind === 'skip') continue;

    // Lifecycle events outside an attempt: if the previous attempt just
    // ended (e.g. welcome → DISCONNECT, the user closed the session),
    // append the lifecycle to that attempt instead of opening a new
    // synthetic one. Otherwise, open a fresh attempt and include the
    // lifecycle event in its phases (so CONNECT appears in the timeline).
    if (kind === 'lifecycle' && !current) {
      // svelte-check aggressively narrows `lastAttempt` to `never` after
      // a prior assignment to `null` inside this loop. Use a function
      // call to read through and re-establish the declared type.
      const prev: ServerLogAttempt | null = readAttempt(lastAttempt);
      if (prev !== null && prev.end !== null) {
        // Extend the previous attempt in place. It's already in
        // `attempts`; don't push it again at end-of-loop.
        prev.phases.push(msg);
        if (msg.command === 'DISCONNECT' || msg.command === 'DISCONNECTED') {
          prev.status = 'disconnected';
        }
        prev.end = msg;
        // Clear lastAttempt so a future synthetic attempt doesn't
        // reopen this one again.
        lastAttempt = null;
        continue;
      }
      current = newAttempt(msg);
      current.phases.push(msg);
      continue;
    }

    // Phase event with a START phase opens a new attempt AND is
    // included in the timeline (the user wants to see "Connecting…"
    // appear in the card, not just in the header).
    if (kind === 'phase' && msg.phase && START_PHASES.has(msg.phase)) {
      // Discard any synthetic (pre-phase) attempt — it has no phases
      // and would stay frozen on "Connecting…" forever after the real
      // connection events start flowing into the new card. Transfer
      // any pre-attachment chatter (MOTD, welcome, caps, notices,
      // numerics into the real attempt so nothing is lost.
      let discarded: ServerLogAttempt | null = null;
      if (current && current.phases.length === 0 && current.end === null) {
        discarded = current;
      } else {
        pushCurrent();
      }
      current = newAttempt(msg);
      if (discarded) {
        current.welcome = discarded.welcome;
        current.motd = discarded.motd;
        current.cap = discarded.cap;
        current.numeric = discarded.numeric;
        current.notices = discarded.notices;
      }
      current.phases.push(msg);
      continue;
    }

// Post-attempt chatter (MOTD, CAP, raw NOTICEs that arrive after
    // welcome) must be appended to the LAST attempt, not a new
    // synthetic one — the connection is still open at this point, the
    // MOTD is just the server's welcome packet finishing up. Without
    // this we'd open a fresh synthetic card for every MOTD line.
    const prev: ServerLogAttempt | null = readAttempt(lastAttempt);
    const isPostAttemptChatter =
      current === null && prev !== null && prev.end !== null &&
      (kind === 'motd' || kind === 'welcome' || kind === 'cap' || kind === 'numeric' || kind === 'notice');

    if (isPostAttemptChatter) {
      // Reopen the previous attempt so the chatter folds into it.
      current = prev;
      lastAttempt = null;
    } else if (!current) {
      // First-attempt chatter before any phase event — open a synthetic
      // card so the message is still visible (e.g. raw server NOTICE
      // that arrived before the engine emitted `connecting`).
      current = newAttempt(msg);
    }

    // Distribute the message into its bucket inside the current attempt.
    switch (kind) {
      case 'phase':
        current!.phases.push(msg);
        if (msg.phase === 'error') current!.status = 'error';
        break;
      case 'motd':
        current!.motd.push(msg);
        break;
      case 'welcome':
        current!.welcome.push(msg);
        break;
      case 'cap':
        current!.cap.push(msg);
        break;
      case 'numeric':
        current!.numeric.push(msg);
        break;
      case 'notice':
        // Skip empty NOTICEs (PING/PONG are already filtered by
        // classifyServerLog; some servers send empty NOTICE with
        // no trailing text as keepalives).
        if (msg.text && (msg.text.trim() || msg.params?.join(' ').trim())) {
          current!.notices.push(msg);
        }
        break;
      case 'lifecycle':
        // Engine-emitted CONNECT/DISCONNECT mid-attempt — fold into phases
        // so the card header can use it as the start anchor if no START
        // phase was emitted yet (legacy scrollback without phase tags).
        current!.phases.push(msg);
        if (msg.command === 'DISCONNECT' || msg.command === 'DISCONNECTED') {
          current!.status = 'disconnected';
        }
        break;
    }

    if (isEndOfAttempt(msg)) {
      if (msg.phase === 'welcome' && current!.status === 'pending') {
        current!.status = 'success';
      }
      current!.end = msg;
      pushCurrent();
    }
  }

  pushCurrent();
  return attempts;
}

function newAttempt(seed: IRCMessage): ServerLogAttempt {
  return {
    start: seed,
    end: null,
    phases: [],
    motd: [],
    welcome: [],
    cap: [],
    notices: [],
    numeric: [],
    status: 'pending',
  };
}

// Identity helper — defeats svelte-check's aggressive flow narrowing on
// `lastAttempt` after we assign `null` to it later in the loop. The
// explicit return type re-asserts the declared union so subsequent
// `prev.end` / `prev.phases` accesses type-check.
function readAttempt(a: ServerLogAttempt | null): ServerLogAttempt | null {
  return a;
}

/**
 * Short label for each engine phase, kept in sync with `phaseToLabel` in
 * MessageRow.svelte and `IRCRawEvent.makeServerLog` in the D engine.
 */
export function phaseToLabel(p: string): string {
  switch (p) {
    case 'queued':       return 'queued';
    case 'resolving':    return 'dns';
    case 'connecting':   return 'connect';
    case 'tcp_open':     return 'tcp';
    case 'tls':          return 'tls';
    case 'tls_done':     return 'tls ✓';
    case 'registering':  return 'register';
    case 'caps':         return 'caps';
    case 'sasl':         return 'sasl';
    case 'welcome':      return 'ready';
    case 'info':         return 'info';
    case 'warn':         return 'warn';
    case 'error':        return 'error';
    case 'disconnected': return 'disco';
    default:             return p;
  }
}

/**
 * Duration of an attempt in milliseconds — derived from the timestamps
 * of the first and last events in the attempt. Returns null when the
 * attempt is still in flight or only has one timestamp.
 */
export function attemptDuration(a: ServerLogAttempt): number | null {
  const last = a.end ?? a.phases[a.phases.length - 1] ?? a.motd[a.motd.length - 1];
  if (!last) return null;
  const startT = a.start.t;
  const lastT = last.t ?? startT;
  if (!startT || !lastT) return null;
  return lastT - startT;
}

/**
 * Compact human-readable duration string ("1.2s", "342ms").
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

/**
 * Extract the body of a numeric reply, peeling off the standard
 * `:server 005 nick :CAPS HERE` prefix. The trailing `:body` is the
 * last param and starts with a colon in the wire format; the engine
 * sometimes strips it, sometimes doesn't, so we handle both.
 * Falls back to `msg.text`.
 */
export function numericBody(msg: IRCMessage): string {
  if (msg.text) return msg.text;
  const params = msg.params ?? [];
  if (params.length >= 3 && params[params.length - 1].startsWith(':')) {
    return params[params.length - 1].slice(1);
  }
  if (params.length === 2 && params[params.length - 1].startsWith(':')) {
    return params[params.length - 1].slice(1);
  }
  return params.join(' ');
}

/**
 * Format an RPL_ISUPPORT (numeric 005) message for display.
 * The actual capability tokens are in `msg.params[1..n-2]` — everything
 * between the user's nick and the trailing `:are supported by this server`
 * boilerplate. Returns a compact line of tokens, one per line.
 */
export function formatIsupport(msg: IRCMessage): string {
  const params = msg.params ?? [];
  if (params.length <= 2) return msg.text || params.join(' ');
  // params[0] is the user's nick, params[last] is the trailing boilerplate
  // (":are supported by this server" or similar). Extract everything in
  // between — those are the actual capability definitions.
  const tokens = params.slice(1, params.length - 1);
  return tokens.join('\n');
}

/**
 * Drop duplicate phase + lifecycle events from a `_server` message stream.
 *
 * The engine and holder daemon independently publish phase-shaped events
 * for the same physical connect (the engine emits `ph=queued|tcp_open|tls`
 * with "TCP connection established to ..." text; the holder emits the
 * same phases with "TCP connection via holder ..." text). The handoff
 * code path can also republish the connection on engine restart, and
 * a control-message burst (e.g. double-clicked reconnect) spawns two
 * fresh clients that both call `HolderTransport()`'s constructor,
 * each emitting a full phase sequence.
 *
 * Each duplicate gets a unique `eid` from the engine, so the existing
 * `eid`-based dedup in `prependMessages` / `setMessages` does nothing
 * here. Without this pass, the timeline produces one card per duplicate
 * sequence — visually "two connected cards" for a single connect.
 *
 * We match any phase-tagged message OR a CONNECT / DISCONNECT / DISCONNECTED
 * lifecycle event on `(t, command, text-prefix)`. Chat messages
 * (PRIVMSG / no phase / non-lifecycle commands) pass through untouched
 * because natural chat can legitimately contain the same text twice.
 * Only the FIRST occurrence of a tuple is kept; later duplicates are dropped.
 */
function dedupPhaseEvents(messages: IRCMessage[]): IRCMessage[] {
  const seen = new Set<string>();
  const out: IRCMessage[] = [];
  for (const msg of messages) {
    const cmd = msg.command ?? '';
    const isLifecycle = cmd === 'CONNECT' || cmd === 'CONNECTED'
      || cmd === 'DISCONNECT' || cmd === 'DISCONNECTED';
    if (!msg.phase && !isLifecycle) {
      out.push(msg);
      continue;
    }
    // First 80 chars of text is enough to distinguish "TCP connection
    // via holder to..." from "TCP connection established to..." while
    // staying well under any reasonable text length. Phase (or
    // command) + timestamp combined make collisions astronomically
    // unlikely outside an actual race.
    const textKey = (msg.text ?? '').slice(0, 80);
    const dedupKey = `${msg.t ?? 0}|${cmd}|${msg.phase ?? ''}|${textKey}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push(msg);
  }
  return out;
}