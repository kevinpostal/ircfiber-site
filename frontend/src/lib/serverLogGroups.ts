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
  | 'self'
  | 'skip';

export function classifyServerLog(msg: IRCMessage): ServerLogKind {
  if (msg.phase) return 'phase';
  const cmd = msg.command;
  if (cmd === 'PING' || cmd === 'PONG' || cmd === 'ERROR') return 'skip';
  // Engine state events that ride the `_server` stream but are consumed
  // by the store (isupport map, retry countdown, structured fail info) —
  // the log shows their effect via phase rows / the disconnect row.
  if (cmd === 'ISUPPORT' || cmd === 'CONNECTION_RETRY_STATUS' || cmd === 'CONNECTION_FAIL') return 'skip';
  // Our own QUIT echo duplicates the DISCONNECTED lifecycle row.
  if (cmd === 'QUIT') return 'skip';
  if (cmd === 'CONNECT' || cmd === 'DISCONNECT' || cmd === 'CONNECTED' || cmd === 'DISCONNECTED') {
    return 'lifecycle';
  }
  if (cmd === 'NOTICE') return 'notice';
  // Self events echoed into the server buffer (user mode, nick change).
  if (cmd === 'MODE' || cmd === 'NICK') return 'self';
  // Numeric IRC replies
  if (cmd === '005') return 'cap';
  if (cmd === '372' || cmd === '375' || cmd === '376') return 'motd';
  // RPL_WELCOME / YOURHOST / CREATED / MYINFO — server's connection banner.
  // Always visible like MOTD.
  if (cmd === '001' || cmd === '002' || cmd === '003' || cmd === '004') return 'welcome';
  // WHOIS / WHOX responses (311 = RPL_WHOISUSER, 354 = WHOX reply, 671 = RPL_WHOISSECURE)
  // flood the server log on large networks like SuperNets (2000+ users → 2000+ WHOIS queries).
  // The engine sends WHOIS for every user on every JOIN to discover realnames, but the
  // responses are consumed internally (stored in `realnames[]`) and don't need to be
  // surfaced in the server log timeline. Skip them to keep the log readable.
  //
  // The engine also drops 354 at publish time (`case "354": return;` in
  // source/ircfiber/irc/connection.d), so this skip is defense-in-depth for
  // replays from older binaries during a rolling upgrade. 311 still arrives
  // for the registration-time WHOIS burst, and 671 is filtered because the
  // "is using a Secure Connection" notice adds nothing.
  if (cmd === '311' || cmd === '354' || cmd === '671') return 'skip';
  // Ban list (367 = RPL_BANLIST, 368 = RPL_ENDOFBANLIST) — consumed by the
  // ban-list overlay; 368 is "End of Channel Ban List" noise.
  if (cmd === '367' || cmd === '368') return 'skip';
  // ISON replies (303): bouncer clients poll their notify list every
  // 30 s; one numeric row per poll would drown the timeline.
  if (cmd === '303') return 'skip';
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
const START_PHASES = new Set(['queued', 'resolving']);

/**
 * Phases that belong to one physical connect. When a `connecting` event
 * arrives and the current attempt already has one of these, a NEW attempt
 * has started (the engine restarted, or the previous connection dropped
 * without a DISCONNECTED event — e.g. SIGTERM) and the card must split;
 * otherwise `connecting` simply continues the `queued` card.
 */
const CONNECT_BODY_PHASES = new Set([
  'connecting', 'dns', 'attempt', 'attempt_fail', 'tcp_open', 'tls', 'tls_done',
  'registering', 'sasl_start', 'sasl_done', 'sasl_fail', 'welcome',
]);

function isStartPhase(msg: IRCMessage, current: ServerLogAttempt | null): boolean {
  if (!msg.phase) return false;
  if (START_PHASES.has(msg.phase)) return true;
  if (msg.phase !== 'connecting') return false;
  if (!current) return true;
  return current.phases.some((p) => !!p.phase && CONNECT_BODY_PHASES.has(p.phase));
}

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
  /** Status the engine gave the attempt — derived from phases + end.
   *  'superseded' = a newer attempt opened before this one closed (the
   *  user-facing card is hidden from the timeline; the prior attempt's
   *  events were absorbed into the new one). */
  status: 'pending' | 'success' | 'error' | 'disconnected' | 'superseded';
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
        continue;
      }
      current = newAttempt(msg);
      current.phases.push(msg);
      // Path B: lifecycle event outside an attempt with no previous
      // ended attempt to extend. Must explicitly set status here
      // because the `continue` below skips the lifecycle switch
      // (line 273-281) that would normally set status='disconnected'
      // for DISCONNECT/DISCONNECTED events. Without this, the card
      // shows "Connecting…" with a DISCONNECTED phase — the user sees
      // a false connecting state on every sync re-evaluation.
      if (msg.command === 'DISCONNECT' || msg.command === 'DISCONNECTED') {
        current.status = 'disconnected';
        current.end = msg;
      }
      continue;
    }

    // Phase event with a START phase opens a new attempt AND is
    // included in the timeline (the user wants to see "Connecting…"
    // appear in the card, not just in the header).
    if (kind === 'phase' && msg.phase && isStartPhase(msg, current)) {
      // Fix: duplicate START events for the same physical connect
      // produce two cards. The frontend's synthetic `queued` (BufferHeader)
      // and the engine's control-plane `queued` (consumer.d reconnectNetwork)
      // fire within milliseconds of each other with different text, so the
      // 60s dedup window doesn't collapse them. Both are START_PHASES, so
      // the old logic pushed the first attempt and opened a second one,
      // giving the user two "Connecting..." cards for one click.
      // If there's already an in-flight pending attempt, merge the new
      // START into it instead of splitting. A `connecting` that follows a
      // completed connect body is a real new attempt (isStartPhase) and
      // must NOT merge — otherwise the previous card swallows the new
      // connection's phases and the timeline stops being live.
      if (current && current.end === null && current.status === 'pending' && msg.phase !== 'connecting') {
        current.phases.push(msg);
        continue;
      }
      // Enterprise semaphore: if there is an existing pending attempt
      // (phases emitted but no disconnect yet), close it as 'disconnected'
      // BEFORE opening the new one.  This prevents multiple "Connecting…"
      // cards from accumulating in the timeline when the backend emits
      // queued phases without an intervening DISCONNECT event (e.g.
      // consumer reconnect path where queued is emitted synchronously
      // but the old connection's DISCONNECTED fires asynchronously).
      //
      // Jul 8 2026 fix: removed. The original 1st if was a buggy
      // "pending → disconnected" semaphore that fired for any
      // START_PHASES event, prematurely closing an in-progress
      // attempt when its own connecting event arrived a second later.
      // The user's "There should only be 1 connected card" concern
      // is now handled by the 'superseded' status in the welcome
      // branch (above).
      // Discard any synthetic (pre-phase) attempt — it has no phases
      // and would stay frozen on "Connecting…" forever after the real
      // connection events start flowing into the new card. Transfer
      // any pre-attachment chatter (MOTD, welcome, caps, notices,
      // numerics into the real attempt so nothing is lost).
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
      // IRCCloud-style: when a new connection attempt starts, mark any
      // prior non-pending attempt as 'superseded' so it's hidden from the
      // timeline. Without this, every reconnect leaves a visible
      // "Connected" or "Disconnected" card stacked above the new
      // "Connecting…" card. The old attempt may already have been changed
      // from 'success' to 'disconnected' by a DISCONNECTED lifecycle event
      // before this START_PHASES event arrives.
      // A split forced by a bare `connecting` (no queued/resolving marker)
      // keeps the previous card visible: that is the "connection dropped
      // without a DISCONNECTED event" case and hiding the old card would
      // erase the only evidence of the drop.
      if (START_PHASES.has(msg.phase)) {
        for (const a of attempts) {
          if (a.status !== 'pending' && a !== current) {
            a.status = 'superseded';
          }
        }
      }
      current.phases.push(msg);
      continue;
    }

    // Post-attempt chatter (MOTD, CAP, raw NOTICEs that arrive after
    // welcome) must be appended to the LAST attempt, not a new
    // synthetic one — the connection is still open at this point, the
    // MOTD is just the server's welcome packet finishing up. Without
    // this we'd open a fresh synthetic card for every MOTD line.
    //
    // Jul 8 2026 fix: this branch must NOT reopen the previous attempt
    // for 'phase' events (like a second 'welcome'). A second welcome
    // means a NEW attempt opened; if we reopen the old attempt, the
    // user sees one card with two welcomes instead of two separate
    // cards. 'welcome' is excluded so the second welcome is treated
    // as the end of the new attempt (its end timestamp).
    const prev: ServerLogAttempt | null = readAttempt(lastAttempt);
    const isPostAttemptChatter =
      current === null && prev !== null && prev.end !== null &&
      (kind === 'motd' || kind === 'cap' || kind === 'numeric' || kind === 'notice');

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
        // Jul 8 2026 fix: when a new attempt successfully connects (welcome
        // phase) while a prior success card is still in the timeline,
        // mark the prior card as 'superseded' so the UI hides it.
        // Without this, the engine restart + reconnectNetwork path
        // stacks multiple "Connected" cards within 1-2 seconds
        // (Disconnected → Connected → Connecting → Connected),
        // confusing the user. The superseded card stays in the
        // attempts array (for the MOTD/ISUPPORT history); the flat
        // ServerLog view still renders its rows in message order.
        for (const a of attempts) {
          if (a.status === 'success' && a !== current) {
            a.status = 'superseded';
          }
        }
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
    case 'dns':          return 'dns';
    case 'attempt':      return 'try';
    case 'attempt_fail': return 'fail';
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
/**
 * Offset of a row from the start of its attempt, rendered as a compact
 * `+14ms` / `+1.24s` / `+2m05s` label so the log reads like a real-time
 * trace ("how long did each step take?"). Empty when either timestamp is
 * missing (legacy scrollback without `t`).
 */
export function relativeOffset(startT: number | undefined, t: number | undefined): string {
  if (!startT || !t) return '';
  return `+${formatOffset(Math.max(0, t - startT))}`;
}

/** `14ms` / `1.24s` / `2m05s` — the phase-rail offset unit. */
export function formatOffset(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return formatDuration(ms);
}

/** `250ms` / `1.2s` / `1m15s` / `3h 12m` — compact human duration. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m${s.toString().padStart(2, '0')}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
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
 * ISUPPORT (005) tokens of one message. The wire form is
 * `:server 005 nick TOK TOK … :are supported by this server`; the engine
 * sometimes ships only the flattened text. Both shapes yield the bare
 * `KEY=value` / `KEY` tokens.
 */
export function isupportTokens(msg: IRCMessage): string[] {
  const params = msg.params ?? [];
  if (params.length > 2) return params.slice(1, -1).filter(Boolean);
  return numericBody(msg)
    .replace(/\s*:?are (?:supported|available) (?:by|on) this server.*$/i, '')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Drop duplicate phase + lifecycle events from a `_server` message stream.
 *
 * The engine and holder daemon independently publish phase-shaped events
 * for the same physical connect. The engine emits `ph=queued|tcp_open|tls`
 * with "TCP connection established to ..." text; the holder emits the
 * same phases with "TCP connection via holder ..." text. The handoff
 * code path can also republish on engine restart, and a control-message
 * burst spawns two clients that both emit a full phase sequence.
 *
 * Each duplicate gets a unique `eid`, so `eid`-based dedup does nothing.
 * Without this pass the timeline produces one card per duplicate sequence.
 *
 * We dedup by phase + a canonical text pattern (normalising "via holder"
 * and "established" differences) within a 60-second window. Chat messages
 * without a phase tag pass through untouched.
 *
 * Lifecycle commands (DISCONNECT/DISCONNECTED/CONNECT/CONNECTED) are deduped
 * by command type only — the engine, holder daemon, and handleServerError()
 * can each emit a DISCONNECTED with different text for the same disconnect,
 * and those all represent the same logical event.
 */
export function dedupPhaseEvents(messages: IRCMessage[]): IRCMessage[] {
  const DUP_WINDOW_MS = 60_000;
  const lastSeen = new Map<string, number>();
  const lifecycleLastSeen = new Map<string, number>();
  const out: IRCMessage[] = [];
  for (const msg of messages) {
    const cmd = msg.command ?? '';
    const isLifecycle = cmd === 'CONNECT' || cmd === 'CONNECTED'
      || cmd === 'DISCONNECT' || cmd === 'DISCONNECTED';
    if (!msg.phase && !isLifecycle) {
      out.push(msg);
      continue;
    }
    // Lifecycle events: dedup by command type only (ignore text differences).
    // Three different code paths can emit DISCONNECTED for the same drop
    // (handleServerError, handleDisconnection, holder onDisconnected) with
    // different text strings. They all mean the same thing — one disconnect.
    if (isLifecycle) {
      const now = msg.t ?? 0;
      const last = lifecycleLastSeen.get(cmd);
      if (last !== undefined && (now - last) < DUP_WINDOW_MS) continue;
      lifecycleLastSeen.set(cmd, now);
      out.push(msg);
      continue;
    }
    // Normalise text so "via holder" and "established" resolve to the same key
    const rawText = (msg.text ?? '');
    const canonText = rawText
      .replace(/via holder daemon/i, '')
      .replace(/established/i, '')
      .replace(/to \S+:\d+/i, '')  // strip host:port so TLS connects to
      .replace(/for \S+/i, '')      // different hosts don't collide
      .trim();
    const key = `${msg.phase ?? ''}|${canonText.slice(0, 60)}`;
    const last = lastSeen.get(key);
    const now = msg.t ?? 0;
    if (last !== undefined && (now - last) < DUP_WINDOW_MS) continue;
    lastSeen.set(key, now);
    out.push(msg);
  }
  return out;
}