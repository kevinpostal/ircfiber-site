import type { IRCMessage, Network } from '../types';
import {
  classifyServerLog,
  dedupPhaseEvents,
  groupServerLog,
  numericBody,
  isupportTokens,
  formatDuration,
  type ServerLogAttempt,
} from './serverLogGroups';
import { getMsgDate, escapeHtml } from './utils';
import { parseIrcFormatting } from './ircFormatting';

/**
 * Flat, chronological render model for the `_server` buffer — one entry
 * per visual row of the IRCCloud-style server log (see
 * `site/docs/mockups/server-log-irccloud.html`). Rows are emitted in
 * message order; `groupServerLog` is consulted only for attempt
 * boundaries (phase-rail ends, per-attempt offsets, welcome/disconnect
 * durations) and never reorders anything.
 */
export type ServerLogRow =
  | { kind: 'date'; key: string; date: string }
  | {
      kind: 'phase';
      key: string;
      msg: IRCMessage;
      /** Rail glyph state: done (default), ok (welcome), bad (fail/error), live (in flight). */
      state: 'done' | 'ok' | 'bad' | 'live';
      first: boolean;
      last: boolean;
      /** Attempt start `t` — the `+offset` origin. */
      startT: number | undefined;
      text: string;
      tag: string | null;
    }
  | { kind: 'part'; key: string }
  | { kind: 'status'; key: string; msg: IRCMessage; html: string; muted: boolean }
  | { kind: 'isup'; key: string; msg: IRCMessage; tokens: string[] }
  | { kind: 'motd'; key: string; msg: IRCMessage; header: string; host: string | null; lines: string[] }
  | {
      kind: 'notice';
      key: string;
      author: string;
      server: boolean;
      bot: boolean;
      lines: Array<{ key: string; msg: IRCMessage; html: string }>;
    };

const CAP_LABELS: Record<string, string> = {
  LS: 'Server supports',
  LIST: 'Enabled',
  REQ: 'Requesting',
  ACK: 'Acknowledged',
  NAK: 'Rejected',
  NEW: 'Server added',
  DEL: 'Server removed',
};

const CAP_TOKEN = /^[a-z0-9][a-z0-9_./-]*[a-z0-9](=\S*)?$/i;

/**
 * CAP negotiation lines land in `_server` either as a raw `CAP` command
 * (`CAP * LS :away-notify …`) or as a bare space-separated capability
 * list forwarded as a notice. Returns the rendered body (`Server
 * supports: a | b | c`) or null when the message is not a CAP line.
 */
export function capNoticeBody(msg: IRCMessage): string | null {
  if (msg.command === 'CAP') {
    const params = msg.params ?? [];
    const sub = (params.find((p) => /^(LS|LIST|REQ|ACK|NAK|NEW|DEL)$/i.test(p)) ?? '').toUpperCase();
    const body = (msg.text || params[params.length - 1] || '').replace(/^:/, '').trim();
    const label = CAP_LABELS[sub] ?? (sub || 'CAP');
    return `${label}: ${body.split(/\s+/).filter(Boolean).join(' | ')}`;
  }
  const text = (msg.text ?? '').trim();
  if (!text || /^\*+\s/.test(text)) return null;
  const tokens = text.split(/\s+/);
  if (tokens.length < 2 || !tokens.every((t) => CAP_TOKEN.test(t))) return null;
  // At least one token must look like a real IRCv3 cap (hyphenated or
  // vendor/prefixed) — plain word lists are prose, not a cap dump.
  if (!tokens.some((t) => /[-/]/.test(t.split('=')[0]))) return null;
  return `Server supports: ${tokens.join(' | ')}`;
}

/**
 * Render one status numeric the way IRCCloud does.
 *
 * A numeric's meaning is often split between a leading parameter and the
 * trailing text — `252 me 5000 :operator(s) online` reads as "5000
 * operator(s) online". Rendering the trailing alone (what we used to do)
 * produced headless fragments: "operator(s) online", "tents formed",
 * "is now your displayed host".
 *
 * The per-numeric shapes below are taken from IRCCloud's own renderers in
 * `build/common-5650bddb.js`, which bold the value and keep the server's
 * wording verbatim:
 *
 *   server_luserop/unknown/channels  `render(value) + " " + renderLinkify(msg)`
 *   server_luserclient/me/n_local/n_global  `renderLinkify(msg)` — value NOT shown
 *   hidden_host_set  `"<b>" + hidden_host + "</b> " + (msg || "is your hostname")`
 *   your_unique_id   `"Your unique ID is <b>" + unique_id + "</b>"`
 *   unknown_command  `"<b>" + command + "</b>: " + msg`
 *   need_more_params `"Missing parameters for command: " + command`
 *
 * Returns escaped HTML.
 */
export function numericStatusHtml(msg: IRCMessage): string {
  const params = msg.params ?? [];
  const text = (msg.text ?? '').trim();
  // Leading parameters, i.e. everything after our own nick and before the
  // trailing. Servers repeat the trailing as the last parameter.
  const lead = params.slice(1).filter((p) => p.trim() !== text);
  const value = lead[0] ?? '';
  const b = (s: string): string => `<b>${escapeHtml(s)}</b>`;
  switch (msg.command) {
    // RPL_LUSEROP / LUSERUNKNOWN / LUSERCHANNELS — the count is the point.
    case '252':
    case '253':
    case '254':
      return value ? `${b(value)} ${escapeHtml(text)}` : escapeHtml(text);
    // RPL_HOSTHIDDEN — the host is the point.
    case '396':
      return value ? `${b(value)} ${escapeHtml(text || 'is your hostname')}` : escapeHtml(text);
    // RPL_YOURID
    case '042':
      return value ? `Your unique ID is ${b(value)}` : escapeHtml(text);
    // ERR_UNKNOWNCOMMAND — which command was refused.
    case '421':
      return value ? `${b(value)}: ${escapeHtml(text)}` : escapeHtml(text);
    // ERR_NEEDMOREPARAMS
    case '461':
      return value ? `Missing parameters for command: ${b(value)}` : escapeHtml(text);
    default:
      return escapeHtml(numericBody(msg));
  }
}

/** Server-originated notice: no nick, a `*` placeholder, a hostname, or a `***` body. */
function isServerNotice(msg: IRCMessage): boolean {
  const nick = msg.nick ?? '';
  if (!nick || nick === '*' || nick.includes('.')) return true;
  return /^\*+\s/.test((msg.text ?? '').trim());
}

function isBotAuthor(nick: string, prefix?: string): boolean {
  const lower = nick.toLowerCase();
  if (lower === 'bots' || lower.endsWith('serv') || lower.endsWith('bot')) return true;
  const host = prefix && prefix.includes('@') ? prefix.slice(prefix.lastIndexOf('@') + 1) : '';
  return !!host && /(^|\.)bot(\.|$)/i.test(host);
}

const HOSTNAME = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/i;

/** Connection states in which the newest attempt is genuinely in flight. */
const ACTIVE_STATES = new Set<Network['connectionState']>([
  'queued', 'connecting', 'connected', 'connected_joining', 'connected_ready', 'ip_retry',
]);

/**
 * Build the rows for one `_server` buffer.
 *
 * @param messages  raw buffer contents (any order the store keeps them in)
 * @param network   owning network — `connected === false` enables the live row
 * @param clearedAt `getClearedAt(networkId, '_server')`; rows at or before it are dropped
 */
export function buildServerLogRows(
  messages: IRCMessage[],
  network: Network | null,
  clearedAt: number | null,
): ServerLogRow[] {
  const visible = dedupPhaseEvents(
    messages.filter((m) => {
      if (m.command === 'PING' || m.command === 'PONG') return false;
      if (clearedAt && (m.t || 0) <= clearedAt) return false;
      return true;
    }),
  );
  const attempts = groupServerLog(visible);
  const attemptOf = new Map<IRCMessage, ServerLogAttempt>();
  for (const a of attempts) {
    for (const bucket of [a.phases, a.motd, a.welcome, a.cap, a.notices, a.numeric]) {
      for (const m of bucket) attemptOf.set(m, a);
    }
  }
  const newest = attempts.length ? attempts[attempts.length - 1] : null;
  // Only an attempt that is actively being worked on ticks; a network
  // sitting in backoff or fully disconnected shows its last phase static.
  const active = network?.connected === false && ACTIVE_STATES.has(network.connectionState);
  const liveAttempt = newest && newest.end === null && active ? newest : null;

  const rows: ServerLogRow[] = [];
  const usedKeys = new Map<string, number>();
  const keyOf = (m: IRCMessage, i: number): string => {
    const base = m.eid != null ? `e${m.eid}` : m.msgid ? `m${m.msgid}` : m.id ? `i${m.id}` : `n${i}`;
    const seen = usedKeys.get(base) ?? 0;
    usedKeys.set(base, seen + 1);
    return seen === 0 ? base : `${base}#${seen}`;
  };

  let lastDate = '';
  // `t` of the most recent welcome phase — the uptime origin for the next
  // disconnect row. Tracked here (not via the attempt) because raw 001
  // numerics that trail the welcome phase open a synthetic attempt.
  let lastWelcomeT = 0;
  // Reason text of the newest disconnect row: the ERR numeric that
  // caused it (465/ERROR echoes) can land a few ms after DISCONNECTED and
  // would otherwise repeat the same sentence as a muted row.
  let lastDisconnectText = '';
  const isupRows = new Map<ServerLogAttempt, Extract<ServerLogRow, { kind: 'isup' }>>();
  const motdRows = new Map<ServerLogAttempt, Extract<ServerLogRow, { kind: 'motd' }>>();

  const push = (m: IRCMessage, row: ServerLogRow): void => {
    const d = getMsgDate(m);
    if (d && d !== lastDate) {
      rows.push({ kind: 'date', key: `d${d}`, date: d });
      lastDate = d;
    }
    rows.push(row);
  };

  visible.forEach((msg, i) => {
    const kind = classifyServerLog(msg);
    if (kind === 'skip') return;
    const attempt = attemptOf.get(msg) ?? null;

    switch (kind) {
      case 'phase': {
        const phase = msg.phase ?? '';
        const phases = attempt ? attempt.phases.filter((p) => !!p.phase) : [msg];
        const last = phases[phases.length - 1] === msg;
        let state: 'done' | 'ok' | 'bad' | 'live' = 'done';
        let text = msg.text ?? '';
        let tag: string | null = null;
        if (phase === 'welcome') {
          state = 'ok';
          text = 'Connected';
          if (attempt?.start.t && msg.t) tag = formatDuration(Math.max(0, msg.t - attempt.start.t));
          lastWelcomeT = msg.t ?? 0;
          lastDisconnectText = '';
        } else if (phase === 'attempt_fail' || phase === 'error') {
          state = 'bad';
        } else if (last && attempt && attempt === liveAttempt) {
          state = 'live';
        }
        push(msg, {
          kind: 'phase',
          key: keyOf(msg, i),
          msg,
          state,
          first: phases[0] === msg,
          last,
          startT: attempt?.start.t,
          text,
          tag,
        });
        return;
      }
      case 'lifecycle': {
        const cmd = msg.command;
        if (cmd === 'DISCONNECT' || cmd === 'DISCONNECTED') {
          const key = keyOf(msg, i);
          push(msg, { kind: 'part', key: `${key}-part` });
          let html = `<span class="disco">Disconnected${msg.text ? ': ' + escapeHtml(msg.text) : ''}</span>`;
          if (lastWelcomeT && msg.t && msg.t > lastWelcomeT) {
            html += ` <span class="kv">after <b>${formatDuration(msg.t - lastWelcomeT)}</b></span>`;
          }
          lastWelcomeT = 0;
          lastDisconnectText = (msg.text ?? '').trim();
          rows.push({ kind: 'status', key, msg, html, muted: false });
          return;
        }
        // CONNECT / CONNECTED: the `welcome` phase row already says it.
        if (attempt?.phases.some((p) => p.phase === 'welcome')) return;
        push(msg, { kind: 'status', key: keyOf(msg, i), msg, html: escapeHtml(msg.text || 'Connected'), muted: false });
        return;
      }
      case 'welcome': {
        push(msg, {
          kind: 'status',
          key: keyOf(msg, i),
          msg,
          html: escapeHtml(numericBody(msg)),
          muted: msg.command !== '001',
        });
        return;
      }
      case 'cap': {
        const tokens = isupportTokens(msg);
        const existing = attempt ? isupRows.get(attempt) : undefined;
        if (existing) {
          for (const t of tokens) if (!existing.tokens.includes(t)) existing.tokens.push(t);
          return;
        }
        const row: Extract<ServerLogRow, { kind: 'isup' }> = { kind: 'isup', key: keyOf(msg, i), msg, tokens: [...tokens] };
        if (attempt) isupRows.set(attempt, row);
        push(msg, row);
        return;
      }
      case 'motd': {
        const existing = attempt ? motdRows.get(attempt) : undefined;
        const body = numericBody(msg);
        if (msg.command === '376') {
          // End-of-MOTD is a terminator, not content; a stray 376 with
          // no block just closes nothing.
          return;
        }
        if (existing) {
          if (msg.command === '372') existing.lines.push(parseIrcFormatting(body));
          return;
        }
        const isStart = msg.command === '375';
        const row: Extract<ServerLogRow, { kind: 'motd' }> = {
          kind: 'motd',
          key: keyOf(msg, i),
          msg,
          header: isStart ? body : 'Message of the Day',
          host: isStart ? (body.match(HOSTNAME)?.[0] ?? null) : network?.host ?? null,
          lines: isStart ? [] : [parseIrcFormatting(body)],
        };
        if (attempt) motdRows.set(attempt, row);
        push(msg, row);
        return;
      }
      case 'notice': {
        const cap = capNoticeBody(msg);
        if (cap !== null) {
          push(msg, { kind: 'status', key: keyOf(msg, i), msg, html: `<b>CAP</b> ${escapeHtml(cap)}`, muted: true });
          return;
        }
        const text = msg.text ?? '';
        if (!text.trim()) return;
        const server = isServerNotice(msg);
        const nick = msg.nick ?? '';
        const author = server ? (nick && nick !== '*' ? nick : network?.host || 'server') : nick;
        const prev = rows[rows.length - 1];
        const key = keyOf(msg, i);
        const line = { key, msg, html: parseIrcFormatting(text) };
        const sameDay = prev && getMsgDate(msg) === lastDate;
        if (prev && prev.kind === 'notice' && prev.author === author && prev.server === server && sameDay) {
          prev.lines.push(line);
          return;
        }
        push(msg, {
          kind: 'notice',
          key,
          author,
          server,
          bot: !server && isBotAuthor(nick, msg.prefix),
          lines: [line],
        });
        return;
      }
      case 'self': {
        const text = (msg.text ?? '').trim();
        if (!text) return;
        const html = msg.command === 'MODE'
          ? `Your user mode changed: ${escapeHtml(text)}`
          : `You are now known as <b>${escapeHtml(text)}</b>`;
        push(msg, { kind: 'status', key: keyOf(msg, i), msg, html, muted: true });
        return;
      }
      case 'numeric': {
        const body = numericBody(msg);
        if (lastDisconnectText && body.trim() === lastDisconnectText) return;
        push(msg, { kind: 'status', key: keyOf(msg, i), msg, html: numericStatusHtml(msg), muted: true });
        return;
      }
    }
  });

  return rows;
}
