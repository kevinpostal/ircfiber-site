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
import { getMsgDate, escapeHtml, getIrcCloudTypeClass } from './utils';
import { parseIrcFormatting } from './ircFormatting';
import { discoSentence } from './messageBuilder';

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
  | { kind: 'status'; key: string; msg: IRCMessage; html: string; cls: string }
  | { kind: 'isup'; key: string; msg: IRCMessage; tokens: string[] }
  | { kind: 'motd'; key: string; msg: IRCMessage; header: string; host: string | null; lines: string[] }
  | {
      kind: 'notice';
      key: string;
      msg: IRCMessage;
      author: string;
      server: boolean;
      bot: boolean;
      /** First row of a consecutive same-author run (IRCCloud firstAuthor). */
      first: boolean;
      html: string;
    }
  | {
      kind: 'disco';
      key: string;
      /** First grouped row's message — head timestamp / data-time. */
      msg: IRCMessage;
      /** Dedup'd ` (xN)` failure summary (escaped HTML). */
      sentences: string;
      /** The swallowed rows, rendered inside the collapse group. */
      rows: ServerLogRow[];
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
    return `${label.padStart(16)}: ${body.split(/\s+/).filter(Boolean).join(' | ')}`;
  }
  const text = (msg.text ?? '').trim();
  if (!text || /^\*+\s/.test(text)) return null;
  const tokens = text.split(/\s+/);
  if (tokens.length < 2 || !tokens.every((t) => CAP_TOKEN.test(t))) return null;
  // At least one token must look like a real IRCv3 cap (hyphenated or
  // vendor/prefixed) — plain word lists are prose, not a cap dump.
  if (!tokens.some((t) => /[-/]/.test(t.split('=')[0]))) return null;
  return `${'Server supports'.padStart(16)}: ${tokens.join(' | ')}`;
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

  // Attempt tag for every emitted row — feeds the disconnect-grouping
  // post-pass below. Kept outside ServerLogRow so the render model stays
  // free of grouping bookkeeping. Lifecycle rows (DISCONNECTED) inherit
  // the current attempt when groupServerLog didn't bucket them.
  const rowAttempt = new Map<ServerLogRow, ServerLogAttempt | null>();
  let curAttempt: ServerLogAttempt | null = null;

  const push = (m: IRCMessage, row: ServerLogRow): void => {
    const d = getMsgDate(m);
    if (d && d !== lastDate) {
      rows.push({ kind: 'date', key: `d${d}`, date: d });
      lastDate = d;
    }
    rowAttempt.set(row, curAttempt);
    rows.push(row);
  };

  visible.forEach((msg, i) => {
    const kind = classifyServerLog(msg);
    if (kind === 'skip') return;
    const attempt = attemptOf.get(msg) ?? null;
    curAttempt = attempt ?? curAttempt;

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
          const row: ServerLogRow = { kind: 'status', key, msg, html, cls: 'type_socket_closed' };
          rowAttempt.set(row, curAttempt);
          rows.push(row);
          return;
        }
        // CONNECT / CONNECTED: the `welcome` phase row already says it.
        if (attempt?.phases.some((p) => p.phase === 'welcome')) return;
        push(msg, { kind: 'status', key: keyOf(msg, i), msg, html: escapeHtml(msg.text || 'Connected'), cls: getIrcCloudTypeClass(msg.command, msg.params) });
        return;
      }
      case 'welcome': {
        push(msg, {
          kind: 'status',
          key: keyOf(msg, i),
          msg,
          html: escapeHtml(numericBody(msg)),
          cls: getIrcCloudTypeClass(msg.command, msg.params),
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
          // Real CAP commands carry the subcommand after the `*` target;
          // bare cap dumps forwarded as notices are always LS-shaped.
          const sub = (msg.params ?? []).find((p) => /^(LS|LIST|REQ|ACK|NAK|NEW|DEL)$/i.test(p))?.toUpperCase();
          const cls = msg.command === 'CAP' && sub ? getIrcCloudTypeClass('CAP', [sub]) : 'type_cap_ls';
          push(msg, { kind: 'status', key: keyOf(msg, i), msg, html: `<b>CAP</b>${escapeHtml(cap)}`, cls });
          return;
        }
        const text = msg.text ?? '';
        if (!text.trim()) return;
        const server = isServerNotice(msg);
        const nick = msg.nick ?? '';
        const author = server ? (nick && nick !== '*' ? nick : network?.host || 'server') : nick;
        const prev = rows[rows.length - 1];
        const sameDay = prev && getMsgDate(msg) === lastDate;
        const first = !(prev && prev.kind === 'notice' && prev.author === author && prev.server === server && sameDay);
        push(msg, {
          kind: 'notice',
          key: keyOf(msg, i),
          msg,
          author,
          server,
          bot: !server && isBotAuthor(nick, msg.prefix),
          first,
          html: parseIrcFormatting(text),
        });
        return;
      }
      case 'self': {
        const text = (msg.text ?? '').trim();
        if (!text) return;
        const html = msg.command === 'MODE'
          ? `Your user mode changed: <b>${escapeHtml(text)}</b>`
          : `You are now known as <b>${escapeHtml(text)}</b>`;
        // Self MODE in the server buffer is always a user-mode change.
        const cls = msg.command === 'MODE' ? 'type_user_mode' : getIrcCloudTypeClass(msg.command, msg.params);
        push(msg, { kind: 'status', key: keyOf(msg, i), msg, html, cls });
        return;
      }
      case 'numeric': {
        if (msg.command === '004') {
          // RPL_MYINFO — IRCCloud's labelled split (`Host:` / `IRCd:` /
          // `User modes:` / `Channel modes:`) instead of the raw
          // parameter dump. params[0] is our own nick (the recipient).
          const p = (msg.params ?? []).slice(1);
          const key = keyOf(msg, i);
          const fields = [
            { label: 'Host', value: p[0], suffix: 'h' },
            { label: 'IRCd', value: p[1], suffix: 'i' },
            { label: 'User modes', value: p[2], suffix: 'u' },
            { label: 'Channel modes', value: p[3], suffix: 'c' },
          ];
          let emitted = 0;
          for (const f of fields) {
            const value = (f.value ?? '').trim();
            if (!value) continue;
            const row: ServerLogRow = {
              kind: 'status',
              key: `${key}-${f.suffix}`,
              msg,
              html: `${f.label}: ${escapeHtml(value)}`,
              // Only the first row carries the type class — follow-up
              // rows are bare `messageRow status monospace` in IRCCloud.
              cls: emitted === 0 ? 'type_myinfo' : '',
            };
            if (emitted === 0) {
              push(msg, row); // date boundary still emitted
            } else {
              rowAttempt.set(row, curAttempt);
              rows.push(row);
            }
            emitted++;
          }
          return;
        }
        const body = numericBody(msg);
        if (lastDisconnectText && body.trim() === lastDisconnectText) return;
        push(msg, { kind: 'status', key: keyOf(msg, i), msg, html: numericStatusHtml(msg), cls: getIrcCloudTypeClass(msg.command, msg.params) });
        return;
      }
    }
  });

  // ── Disconnect grouping (IRCCloud's collapsible "Disconnections") ──
  // Maximal runs of rows belonging to consecutive *failed* attempts
  // (ended, never reached welcome, not the live attempt) spanning ≥ 2
  // distinct attempts collapse into one `disco` head row. Date rows
  // break runs (IRCCloud's same-date guard); a single failed attempt
  // never groups.
  const failedAttempts = new Set<ServerLogAttempt>();
  for (const a of attempts) {
    if (a.end !== null && a !== liveAttempt && !a.phases.some((p) => p.phase === 'welcome')) {
      failedAttempts.add(a);
    }
  }
  if (failedAttempts.size < 2) return rows;

  const out: ServerLogRow[] = [];
  let run: ServerLogRow[] = [];
  const flush = (): void => {
    if (!run.length) return;
    const runAttempts = [...new Set(run.map((r) => rowAttempt.get(r) as ServerLogAttempt))];
    // IRCCloud drops `.part` rows inside the group body; the renderer
    // emits its own trailing groupedDiscoPart hr.
    const inner = run.filter((r) => r.kind !== 'part');
    const head = inner.find((r): r is Extract<ServerLogRow, { msg: IRCMessage }> => 'msg' in r);
    if (runAttempts.length < 2 || !head) {
      out.push(...run);
    } else {
      // One failure sentence per grouped attempt: its DISCONNECTED text
      // if present, else its attempt_fail/error phase text.
      const texts = runAttempts.map((a) => {
        for (const r of run) {
          if (rowAttempt.get(r) !== a || r.kind !== 'status') continue;
          const c = r.msg.command;
          if (c === 'DISCONNECT' || c === 'DISCONNECTED') {
            const t = (r.msg.text ?? '').trim();
            if (t) return t;
          }
        }
        const ph = a.phases.find((p) => p.phase === 'attempt_fail' || p.phase === 'error');
        return (ph?.text ?? '').trim() || 'Connection failed';
      });
      out.push({
        kind: 'disco',
        key: `disco-${run[0].key}`,
        msg: head.msg,
        sentences: discoSentence(texts),
        rows: inner,
      });
    }
    run = [];
  };
  for (const r of rows) {
    const a = rowAttempt.get(r);
    if (a && failedAttempts.has(a)) run.push(r);
    else { flush(); out.push(r); }
  }
  flush();
  return out;
}
