import type { IRCMessage, Network, WhoisData, BanEntry, BanListData, RetryStatus, FailInfo, ChannelListChunk } from '../types';
import { WHOIS_FAMILY } from './serverLogGroups';
import { ircState, handleConnect, updateChannelUsers, applyIsupportUpdate, applyRetryStatus, applyFail, applyChannelListChunk,
         updateChannelTopic, appendMessage, prependMessage, setTyping, clearTyping,
         setTempUnavailable, clearTempUnavailable, markNetworkSeen, shouldSuppressNotInChannel,
         checkHighlight, isMessageUnseen, applySetname, markRedacted,
         findBufferByName, isSelfMessage, renameQueryBuffer } from '../stores/ircStore.svelte';
import { isIgnored, globalPrefs, getBufferPrefs, getLastSeen } from '../stores/preferences.svelte';
import { normalizeChannelName, stripPrefix, isSkippedCommand } from './utils';
import { notify } from './notifications';
import { shouldNotifyForMessage, getNotificationTitle } from './notificationPolicy';
import { enqueueMessage } from './messageBatcher';
import { setMaxEid } from '../stores/wsConnection.svelte';
import { addNotice } from '../stores/noticeOverlay.svelte';
/** Message append strategy: immediate or batched (IRCCloud-style). */
export type AppendFn = (networkId: string, bufferName: string, msg: IRCMessage, isBackfill?: boolean) => void;

/**
 * Decide whether an event should bypass the 0 ms message batcher.
 *
 * The batcher (lib/messageBatcher.ts) coalesces incoming events into a
 * single Svelte state mutation per macrotask. That's exactly what you
 * want for chat bursts (paste, MOTD lines) but it adds a 1–4 ms delay
 * to a single-message stream.
 *
 * Server-log progress entries are low-volume but high-value: the user
 * is staring at the server buffer waiting to see "Connecting to …" and
 * "TLS handshake complete" appear. Squeezing them through the batcher
 * makes the connection feel laggy on the first attempt even when the
 * round-trip is otherwise fast.
 *
 * We classify anything that's NOT a chat message and IS in a server
 * buffer as immediate. The engine tags these events with a `phase`
 * tag in their raw JSON (see `IRCRawEvent.makeServerLog` in D), but
 * the unpacked `IRCMessage` doesn't expose tags yet — so we use the
 * shape (no nick, NOTICE command, server buffer) which exactly
 * describes every progress entry the engine emits.
 */
export function shouldBypassBatcher(msg: IRCMessage, bufferName: string): boolean {
  // The _server buffer is low-volume — only connection progress, MOTD, and
  // service notices. There's no chat-flood risk. Every message there should
  // render instantly, not wait for the batcher's setTimeout(0).
  if (bufferName === '_server') return true;

  return false;
}

const defaultAppend: AppendFn = (networkId, bufferName, msg, isBackfill) => {
  if (isBackfill) {
    prependMessage(networkId, bufferName, msg);
  } else {
    appendMessage(networkId, bufferName, msg);
  }
};

// ── Message handler registry ──
// Extracted from App.svelte so command handling is testable independently
// from the component tree. Pattern mirrors IRCCloud's messageHandlers map.

/**
 * Detect CTCP ACTION (\x01ACTION ...\x01) in a PRIVMSG payload and return
 * the action body + a synthesized `type='action'` marker. Returns null
 * when the message isn't a CTCP ACTION so callers can leave their fields
 * untouched.
 *
 * The D backend intentionally leaves the \x01 markers in place — this
 * one helper is the single source of truth for unwrapping them, used by
 * both the realtime WebSocket path (`unpackEvent`) and the REST history
 * loader (`normalizeMessage` in stores/api.ts). Keeping the logic in one
 * place avoids the "history-loaded actions render with literal \x01"
 * bug we hit before.
 */
export function detectCtcpAction(cmd: string, text: string): { text: string; type: 'action' } | null {
  if (cmd !== 'PRIVMSG') return null;
  if (!text || text.charCodeAt(0) !== 0x01) return null;
  if (!text.includes(' ')) return null;
  const end = text.indexOf('\x01', 1);
  if (end <= 1) return null;
  const inner = text.slice(1, end);
  const spaceIdx = inner.indexOf(' ');
  if (spaceIdx < 0) return null;
  const ctcpCmd = inner.slice(0, spaceIdx);
  if (ctcpCmd !== 'ACTION') return null;
  return { text: inner.slice(spaceIdx + 1), type: 'action' };
}

/**
 * Unpack a compact WebSocket message into a typed IRCMessage.
 */
export function unpackEvent(
  data: Record<string, unknown>,
  localMsgIdCounter: { value: number },
): IRCMessage {
  const cmd = (data.command || data.c || '') as string;
  let text = ((data.text as string) || (data.x as string) || '') as string;
  let type = data.type as string | undefined;

  const action = detectCtcpAction(cmd, text);
  if (action) {
    type = action.type;
    text = action.text;
  }

  // Phase tag (set by IRCRawEvent.makeServerLog in the engine) lives in
  // the IRCv3 tags object alongside server-time / msgid. The compact
  // WebSocket wire format inlines it as `data.phase` for low-overhead
  // access on the hot path; fall back to the tags object when only the
  // long form is available (e.g. replayed scrollback).
  const tags = data.tags as Record<string, string> | undefined;
  const phase = (data.phase as string | undefined)
    ?? tags?.phase
    ?? undefined;

  return {
    id: ((data.id as string) || (data.i as string) || `w${++localMsgIdCounter.value}`) as string,
    timestamp: ((data.timestamp as string) || (data.t ? new Date(data.t as number).toISOString() : null)) as string,
    nick: ((data.nick as string) || (data.n as string) || '') as string,
    text,
    command: cmd,
    params: ((data.params as string[]) || (data.p as string[]) || []) as string[],
    prefix: ((data.prefix as string) || (data.px as string) || '') as string,
    msgid: ((data.msgid as string) || (data.m as string) || (data.i as string) || '') as string,
    label: ((data.label as string) || (data.l as string) || (data.le as string) || '') as string,
    account: (((data.a as string) || tags?.account || '') as string) || undefined,
    editOf: (((data.eo as string) || tags?.edit_of || '') as string) || undefined,
    t: data.t as number,
    eid: (data.eid as number) || undefined,
    selfEcho: !!(data.se as string | undefined),
    type,
    phase,
  };
}

/**
 * Callbacks for side effects the handler can't perform on its own.
 */
export interface HandlerCallbacks {
  switchToBuffer: (networkId: string, bufName: string) => void;
}

/**
 * Mutable accumulator state for ban/whois tracking.
 */
export interface AccumState {
  whoisAcc: Partial<WhoisData> | null;
  whoisAccs: Map<string, Partial<WhoisData>>;
  banAcc: BanEntry[];
  banTargetChannel: string;
}

/**
 * Process a single IRC event. Handles network lookup, whois/ban accumulation,
 * channel state updates, topic, lastSpoke, and message append/notify.
 */
export function processIrcEvent(
  data: Record<string, unknown>,
  localMsgIdCounter: { value: number },
  accum: AccumState,
  cb: HandlerCallbacks,
  append: AppendFn = defaultAppend,
): {
  /** Set if a whois just completed (set overlay to 'whois'). */
  whoisData?: WhoisData;
  /** Set if whois failed (ERR_NOSUCHNICK). */
  whoisFailedNick?: string;
  /** Set if a ban list just completed. */
  banListData?: BanListData;
} {
  const msg = unpackEvent(data, localMsgIdCounter);
  const cmd = msg.command;

  // IRCCloud-style: track maxEid for stream resume
  setMaxEid(msg.eid ?? 0);
  const rawChannel = ((data.channel || data.ch || '_server') as string);
  const channel = normalizeChannelName(rawChannel);

  // Look up by network UUID (nid) — NOT display name — so events from one
  // network never leak channels into another network's sidebar. The compact
  // JSON always includes both fields; use nid when present, fall back to
  // display name for events still in flight from an older engine.
  const networkId = ((data.nid || data.network) as string) || '';
  const net = data.nid
    ? ircState.networks.find(n => n.networkId === networkId)
    : ircState.networks.find(n => n.name === (data.network || ''));
  if (!net) return {};
  // Every realtime WS event that names a known network is fresh
  // activity — refresh the stale marker up-front so callers that early-
  // return (ignore list, TAGMSG, temp_unavailable, etc.) still mark the
  // network as seen.
  markNetworkSeen(networkId);

  // Query/DM case convergence (`/msg nickserv` vs a reply from
  // `NickServ`): a locally-typed buffer predates the first server reply.
  // Incoming (non-self) traffic carries the server-authoritative nick
  // case, so adopt it for the buffer OBJECT's display name. Message and
  // prefs keys are already folded, so nothing migrates. Self echoes
  // never rename — they carry our typed target, not the server's case.
  if (rawChannel !== '_server' && !rawChannel.startsWith('#')
      && (cmd === 'PRIVMSG' || cmd === 'NOTICE') && !isSelfMessage(msg, net)) {
    const existing = findBufferByName(net, rawChannel);
    if (existing && existing.name !== rawChannel) {
      existing.name = rawChannel;
      const act = ircState.activeBuffer;
      if (act.networkId === networkId && act.bufferName
          && normalizeChannelName(act.bufferName) === channel) {
        act.bufferName = rawChannel;
      }
    }
  }

  // IRCCloud rename model: a DM counterparty's NICK renames the query
  // buffer in place (history + state preserved) instead of opening a
  // second conversation. Idempotent across the base event and the
  // per-channel duplicates: after the first rename nothing matches the
  // old nick anymore. Self changes are ignored (you_nickchange owns
  // self; counterparties are unchanged).
  if (cmd === 'NICK' && msg.nick) {
    const nickParams = msg.params ?? [];
    const newNick = (nickParams.length > 0 ? nickParams[nickParams.length - 1] : msg.text ?? '').trim();
    if (newNick) renameQueryBuffer(networkId, msg.nick, newNick);
  }

  // Ignore check
  if (msg.nick && isIgnored(msg.nick)) return {};

  const result: { whoisData?: WhoisData; whoisFailedNick?: string; banListData?: BanListData } = {};

  // Helper to extract target nick from WHOIS numerics.
  // Explicit WHOIS for "MAGIC" from "Zodiac_" comes as "311 Zodiac_ MAGIC ~magic ..." (params[0]=requester, params[1]=target).
  // Automatic WHOIS for "Zod" comes as "311 Zod incog ..." (params[0]=target). Use current nick to disambiguate.
  function whoisTarget(params: string[], currentNick: string): string {
    if (!params || params.length === 0) return '';
    if (params.length >= 2 && params[0].toLowerCase() === currentNick.toLowerCase()) return params[1] || params[0];
    return params[0] || '';
  }
  // ── Whois accumulation (per-nick, avoids interleaving) ──
  // Gated on the SAME list the server log hides (`WHOIS_FAMILY`), minus
  // the terminators handled below. That coupling is the point: a numeric
  // the log refuses to render must be captured here or its text exists
  // nowhere. Anything without a typed field lands in `special`.
  if (cmd !== '318' && cmd !== '369' && WHOIS_FAMILY.has(cmd)) {
    const rawTarget = whoisTarget(msg.params || [], net.currentNick || '');
    const targetNick = rawTarget || msg.params?.[0] || '';
    const key = targetNick.toLowerCase();
    let acc = accum.whoisAccs.get(key);
    if (!acc || (acc.nick || '').toLowerCase() !== targetNick.toLowerCase()) {
      acc = { nick: targetNick };
      accum.whoisAccs.set(key, acc);
    }
    // keep legacy single pointer in sync for accumulateWhois
    accum.whoisAcc = acc;
    // For accumulateWhois we need params where target is first, so it can use params[0] as nick.
    // If the original had requester prefix, strip it so 311's params[0] is target.
    let whoisParams = msg.params || [];
    if (whoisParams.length >= 2 && whoisParams[0].toLowerCase() === (net.currentNick || '').toLowerCase() && whoisParams[1].toLowerCase() === targetNick.toLowerCase()) {
      whoisParams = [whoisParams[1], ...whoisParams.slice(2)];
    }
    accumulateWhois(accum, cmd, whoisParams, msg.text || '');
    // ensure map entry reflects any new fields added by accumulateWhois
    accum.whoisAccs.set(key, acc);
  } else if (cmd === '318') {
    // 318: [<you> ]<target> :End of /WHOIS list.  Target is params[1] when
    // present, otherwise params[0].  Check target first so an explicit
    // WHOIS for "MAGIC" (318 Zodiac_ MAGIC) doesn't match the pending
    // "zodiac_" entry from a previous self-WHOIS.
    const candTarget = (msg.params?.[1] || msg.params?.[0] || '').toLowerCase();
    const candYou = (msg.params?.[0] || '').toLowerCase();
    let key: string | null = null;
    let acc: Partial<WhoisData> | undefined;
    if (candTarget && accum.whoisAccs.has(candTarget)) { key = candTarget; acc = accum.whoisAccs.get(candTarget); }
    else if (candYou && accum.whoisAccs.has(candYou) && candYou !== candTarget) { key = candYou; acc = accum.whoisAccs.get(candYou); }
    else if (accum.whoisAcc) { acc = accum.whoisAcc; key = (acc.nick || '').toLowerCase(); }
    if (acc) {
      result.whoisData = { ...acc } as WhoisData;
      if (key) accum.whoisAccs.delete(key);
      // keep legacy pointer clear if it pointed to this nick
      if (accum.whoisAcc && (accum.whoisAcc.nick || '').toLowerCase() === key) accum.whoisAcc = null;
    }
  } else if (cmd === '401') {
    // 401: <you> <target> :No such nick — target is params[1] if present
    const failedNick = (msg.params?.[1] || msg.params?.[0] || '');
    const fk = failedNick.toLowerCase();
    let acc = accum.whoisAccs.get(fk);
    if (acc) {
      result.whoisFailedNick = acc.nick || failedNick;
      accum.whoisAccs.delete(fk);
      if (accum.whoisAcc && (accum.whoisAcc.nick || '').toLowerCase() === fk) accum.whoisAcc = null;
    } else if (accum.whoisAcc && (accum.whoisAcc.nick || '').toLowerCase() === fk) {
      result.whoisFailedNick = accum.whoisAcc.nick;
      accum.whoisAcc = null;
    }
  }

  // ── W1-T08: temp_unavailable — Server busy, show countdown ──
  if (cmd === 'temp_unavailable') {
    const countdownMs = parseInt((data.cd as string) || '30000', 10);
    const serverTs = parseInt((data.st as string) || '0', 10) || Date.now();
    setTempUnavailable(networkId, channel, serverTs + countdownMs);
    return {};
  }

  // ── W1-T08: idle — Connection idle detection ──
  if (cmd === 'idle') {
    const sinceMs = parseInt((data.s as string) || '0', 10);
    net.connectionIdleSince = sinceMs;
    return {};
  }

  // ── ISUPPORT — Engine pushed the parsed feature map. Apply it
  //    to `net.isupport` so the categorised "Server features" panel
  //    can render from structured data instead of re-parsing the raw
  //    005 message stream. The map is JSON-encoded into `msg.text`
  //    by `IRCRawEvent.makeIsupport` in source/ircfiber/models/irc_event.d.
  if (cmd === 'ISUPPORT') {
    try {
      const raw = JSON.parse(msg.text || '{}');
      if (raw && typeof raw === 'object') {
        applyIsupportUpdate(networkId, raw as Record<string, string>);
      }
    } catch {
      // Malformed payload — leave `net.isupport` untouched; ServerLog
      // still renders the buffered 005 lines as ISUPPORT rows.
    }
    return {};
  }

  // ── W2-T02: CONNECTION_RETRY_STATUS — engine surfaced the
  //    structured retry state for the current backoff cycle.
  //    Source: source/ircfiber/models/irc_event.d
  //    `IRCRawEvent.makeConnectionRetryStatus` -> `data.rs`.
  //    The engine emits this both at every reconnect-loop deadline
  //    AND at every `backoff.reset()` site with all-zero arguments.
  //    The all-zero form means "retry cleared" — applyRetryStatus
  //    accepts that and clears BOTH retryStatus AND failInfo on the
  //    network store. (Test suite pins this invariant as TG5.)
  if (cmd === 'CONNECTION_RETRY_STATUS') {
    const rs = data.rs as RetryStatus | undefined;
    if (rs && typeof rs === 'object' && typeof rs.attemptCount === 'number') {
      const isZero = rs.attemptCount === 0
        && rs.nextRetryAtMs === 0
        && rs.delayMs === 0;
      if (isZero) {
        applyRetryStatus(networkId, null);
      } else {
        applyRetryStatus(networkId, rs);
      }
    } else {
      // Malformed payload — clear defensively. Mirrors the ISUPPORT
      // branch's "leave store untouched on parse failure" policy, but
      // inverts because a missing retryStatus means "no retry scheduled"
      // which is the safe default.
      applyRetryStatus(networkId, null);
    }
    return {};
  }

  // ── W2-T02: CONNECTION_FAIL — engine surfaced the structured
  //    disconnect reason alongside the legacy DISCONNECTED event.
  //    Source: source/ircfiber/models/irc_event.d
  //    `IRCRawEvent.makeConnectionFail` -> `data.fi`. The payload's
  //    `sslVerifyError` is a NESTED object (not a flat pair) per plan
  //    B2 — the TS `FailInfo.sslVerifyError?: { type, error }`
  //    matches byte-for-byte, no conversion needed.
  if (cmd === 'CONNECTION_FAIL') {
    const fi = data.fi as FailInfo | undefined;
    if (fi && typeof fi === 'object' && typeof fi.reason === 'string') {
      applyFail(networkId, fi);
    }
    // Discard malformed payloads — keep the previous failInfo so the
    // banner doesn't briefly flash "Disconnected" if the wire ever
    // sends a truncated frame mid-disconnect.
    return {};
  }

  // ── /LIST reply chunk — the engine folds 321/322/323 into
  //    `CHANNEL_LIST` events (`data.cl`, ≤200 rows each) that are
  //    published but never persisted. Consumed by the channellist
  //    overlay via the store; never rendered as a message.
  if (cmd === 'CHANNEL_LIST') {
    const cl = data.cl as ChannelListChunk | undefined;
    if (cl && typeof cl === 'object' && Array.isArray(cl.rows)) {
      applyChannelListChunk(networkId, cl);
    }
    return {};
  }

  // ── IRCCloud-style you_nickchange — Self nick changed ──
  // The engine emits this dedicated message type when OUR nick changes
  // (detected via sessionNick match in connection.d's NICK handler).
  // It carries [oldNick, newNick] params. We update currentNick and ALL
  // channel member lists immediately so the sidebar reflects the change
  // in realtime, without waiting for per-channel NICK fan-out events.
  // This mimics IRCCloud's event-driven member list architecture where
  // `you_nickchange` is the authoritative signal and the member list
  // reacts through `change:nick` events on individual Member models.
  if (cmd === 'you_nickchange' && msg.params && msg.params.length >= 2) {
    const oldNick = msg.params[0];
    const newNick = msg.params[msg.params.length - 1];
    net.currentNick = newNick;
    net.pendingSelfNickChange = undefined;
    // Update ALL channel member lists immediately — this is the single
    // authoritative event for self-nick changes. Per-channel NICK fan-out
    // events that follow will be redundant (no matching old nick left to
    // rename) but harmless. This mirrors IRCCloud's design where the
    // connection-level `you_nickchange` message triggers the member list
    // update across every channel the user is in, providing realtime UX.
    for (const buf of net.buffers) {
      if (buf.users) {
        for (const u of buf.users) {
          if (stripPrefix(u.nick) === oldNick) {
            u.nick = u.prefix + newNick;
          }
        }
      }
    }
    return {};
  }

  // ── Ban list accumulation ──
  if (cmd === '367' && msg.params) {
    accum.banAcc.push({
      mask: msg.params[2] || '',
      setBy: msg.params[3] || '',
      setAt: parseInt(msg.params[4] || '0', 10),
    });
    accum.banTargetChannel = msg.params[1] || '';
  } else if (cmd === '368') {
    // 368 RPL_ENDOFBANLIST carries the channel itself (`<me> <channel>
    // :End of channel ban list`). Read it from there, not from the last 367:
    // a channel with no bans sends 368 with no 367 at all, and keying off
    // the accumulator left the channel empty so the overlay never opened.
    result.banListData = {
      networkId,
      channel: msg.params?.[1] || accum.banTargetChannel,
      bans: [...accum.banAcc],
    };
    accum.banAcc = [];
    accum.banTargetChannel = '';
  }

  // ── Connection state ──
  handleConnect(cmd, networkId, msg.text);

  // ── Channel users ──
  updateChannelUsers(networkId, channel, cmd, msg.nick || '', msg.params, msg.prefix || '');

  // ── Topic ──
  if (cmd === '332' && msg.text) {
    updateChannelTopic(networkId, channel, msg.text);
  } else if (cmd === 'TOPIC' && msg.text) {
    updateChannelTopic(networkId, channel, msg.text);
  }

  // ── lastSpoke tracking ──
  if (cmd === 'PRIVMSG' && msg.nick) {
    const bufObj = findBufferByName(net, channel);
    if (bufObj?.users) {
      const u = bufObj.users.find(x => stripPrefix(x.nick) === msg.nick);
      if (u) {
        u.lastSpoke = msg.t ?? Date.now();
        // Backfill the services account from the IRCv3 account-tag so
        // the member list shows identity without a WHOIS round trip.
        if (msg.account && msg.account !== '*' && !u.account) u.account = msg.account;
        // Backfill ident + isBot from the message prefix the first time
        // we see a member speak, so members originally added via NAMES
        // (which doesn't carry the userhost) still get a BOT badge and
        // the realname popover once a single message has arrived.
        if (msg.prefix && msg.prefix.includes('!')) {
          const ident = msg.prefix.slice(msg.prefix.indexOf('!') + 1);
          if (!u.ident) u.ident = ident;
          if (!u.isBot) {
            const host = ident.includes('@')
              ? ident.slice(ident.lastIndexOf('@') + 1)
              : '';
            if (host && /(^|\.)bot(\.|$)/i.test(host)) u.isBot = true;
          }
        }
      }
    }
  }

  // Detect CHATHISTORY backfill: messages tagged with batch=chathistory
  // arrive out-of-order and must be prepended so they appear at the top.
  const isBackfill = (data.tags as Record<string, string> | undefined)?.batch === 'chathistory'
    || (data.batch as string | undefined) === 'chathistory';

  // ── Typing indicators (IRCCloud-style TAGMSG) ──
  // The engine ships the IRCv3 `+typing` tag as `data.typing` on the
  // compact WS wire (see IRCRawEvent.toCompactJson); long-form/replayed
  // payloads carry it inside `data.tags['+typing']`. `active` (or any
  // value we can't classify) refreshes the 6.5s heartbeat; `done`
  // clears the indicator immediately so "X is typing" vanishes the
  // moment the other client stops — not 6.5s later.
  if (cmd === 'TAGMSG' && msg.nick && channel !== '_server') {
    const typingTag = (data.typing as string | undefined)
      ?? (data.tags as Record<string, string> | undefined)?.['+typing'];
    if (typingTag === 'done') {
      clearTyping(networkId, channel, msg.nick);
    } else {
      setTyping(networkId, channel, msg.nick);
    }
    return {};
  }

  // ── Clear typing when the user actually sends a message ──
  if (cmd === 'PRIVMSG' && msg.nick) {
    clearTyping(networkId, channel, msg.nick);
  }
  // Clear temp_unavailable state when a new chat message arrives
  // (IRCCloud: server busy state clears on any server response).
  if (!isSkippedCommand(cmd) && cmd !== 'temp_unavailable' && cmd !== 'idle') {
    clearTempUnavailable(networkId, channel);
  }

  // ── IRCCloud-style notice overlay ──────────────────────────────────
  // Private NOTICEs from services/users (NickServ, etc.) pop as a
  // stacked overlay in the top-right. Matches the HTML the user pasted:
  //   <div class="overlaycontainer overlay_container_type_notice">
  //     <button class="close"><span>Close</span></button>
  //     <div class="overlaycontents">
  //       <div class="overlay_type_notice">
  //         <div class="overlayHead">Notice: <span>NickServ</span> (SuperNETs)</div>
  //         <div class="overlay">Your nickname is not registered...</div>
  //       </div>
  //     </div>
  //   </div>
  // We trigger for private NOTICEs (target is not a channel), from a
  // non-server nick, with non-empty text, not self-echo, not CTCP, and
  // not a "***" server lookup notice (those live in ServerLog).
  if (cmd === 'NOTICE' && msg.nick && msg.text && !isBackfill) {
    const target = (msg.params && msg.params[0]) || '';
    const isChannelTarget = target.length > 0 && ['#', '&', '+', '!'].includes(target[0]);
    const isServerNick = msg.nick.includes('.');
    const curNick = net.currentNick || net.nick || '';
    const isSelf = !!curNick && msg.nick.toLowerCase() === curNick.toLowerCase();
    const isSelfEcho = msg.selfEcho || !!(data.se as string | undefined);
    const isCtcp = msg.text.charCodeAt(0) === 0x01;
    const trimmed = msg.text.trim();
    // Only suppress "***" noise from server hostnames (irc.example.org) — not from services.
    // NickServ/ChanServ HELP often starts with "***" and must still show in the overlay.
    const isStarNoise = isServerNick && (trimmed.startsWith('***') || trimmed.startsWith('* *'));
    const targetMismatch = !!target && target !== '*' && !!curNick && target.toLowerCase() !== curNick.toLowerCase() && target.toLowerCase() !== (net.nick || '').toLowerCase();
    if (!isChannelTarget && !isServerNick && !isSelf && !isSelfEcho && !isCtcp && !isStarNoise && !targetMismatch) {
      addNotice({
        nick: msg.nick,
        networkId,
        networkName: net.name || networkId,
        text: msg.text,
        t: (msg.t as number) ?? Date.now(),
        params: msg.params,
      });
    }
  }
  // ── 404 spam guard ────────────────────────────────────────────────
  // "No external channel messages (#superbowl)" floods when the user is
  // not in the channel and keeps hitting Enter. updateChannelUsers has
  // already flipped isJoined=false so the header shows Rejoin/Archive,
  // but we still need to suppress duplicate chat rows — show once per
  // 30s instead of one per keystroke (user request: show message once).
  if (cmd === '404') {
    const t = (msg.text || '').toLowerCase();
    const isSpam = t.includes('no external') || t.includes('not on channel') || t.includes('cannot send to channel');
    if (isSpam && shouldSuppressNotInChannel(networkId, channel)) {
      return result;
    }
  }
  // ── SETNAME — live realname change ──
  // The engine fans the event out per shared channel and keeps its own
  // cache; refresh the member rows + network cache here too. The event
  // itself still appends below so the change is visible in the timeline.
  if (cmd === 'SETNAME' && msg.nick) {
    const newRealname = msg.text || (msg.params?.[msg.params.length - 1] ?? '');
    if (newRealname) applySetname(networkId, msg.nick, newRealname);
  }
  // ── REDACT — tombstone by msgid ──
  // `REDACT <target> <msgid> [<reason>]`. When the original row is in
  // the buffer, replace it with a tombstone and swallow the REDACT;
  // otherwise let it append so the deletion stays visible.
  if (cmd === 'REDACT' && msg.params && msg.params.length >= 2) {
    const targetMsgid = msg.params[1] || '';
    const reason = msg.text || (msg.params[2] ?? '');
    if (targetMsgid) {
      const redactBuf = normalizeChannelName(msg.params[0] || channel);
      if (markRedacted(networkId, redactBuf, targetMsgid, reason)) return {};
    }
  }
  // ── Message append + notification ──
  if (!isSkippedCommand(cmd)) {
    if (isBackfill) {
      // CHATHISTORY replay: batch via the backfill queue so it's prepended
      // prependMessages() call, matching sync/REST history paths which
      // never count as unread. Previously this went through the live
      // batcher (enqueueMessage → batchAppendMessages) which always
      // treated every PRIVMSG as new and bumped the sidebar badge.
      enqueueMessage(networkId, channel, msg, true);
    } else {
      // Server-log progress entries (NOTICE-shaped, no nick, in _server)
      // bypass the message batcher so each phase appears the instant the
      // engine emits it. Chat messages still flow through the batcher so
      // paste bursts and MOTD dumps coalesce into one reactive update.
      // `append` is the batched path (enqueueMessage); `defaultAppend` is
      // the immediate path (appendMessage / prependMessage directly).
      const appendFn: AppendFn = shouldBypassBatcher(msg, channel)
        ? defaultAppend
        : append;

      appendFn(networkId, channel, msg, false);
    }

    const activeName = ircState.activeBuffer.bufferName;
    const isActiveBuffer = ircState.activeBuffer.networkId === networkId
      && !!activeName && normalizeChannelName(activeName) === channel;
    const documentHidden = typeof document !== 'undefined' && document.hidden;
    const buf = findBufferByName(net, channel);
    // Ensure highlight is computed before notify check (batch sets it async, but notify is sync)
    if (!msg.highlight && (msg.command === 'PRIVMSG' || msg.command === 'NOTICE' || msg.type === 'action') && msg.nick) {
      if (checkHighlight(msg, net)) msg.highlight = true;
    }
    // Gate desktop notifications on unseen + recency to avoid history-replay spam
    // on gateway restart. Without this, a WS reconnect with `since=0` (maxEid
    // reset on refresh) replays 200 history PRIVMSGs as live events (no
    // batch=chathistory tag) and each highlight would re-fire a desktop
    // notification — the exact "notifications again after reboot" bug.
    // isMessageUnseen (t > lastSeen) suppresses already-seen history; the
    // age guard suppresses old backlog for never-visited buffers where
    // lastSeen is null (otherwise every historic highlight would notify).
    const lastSeenTs = getLastSeen(networkId, channel);
    const msgTs = msg.t ?? 0;
    const isUnseen = isMessageUnseen(msg, networkId, channel);
    const isRecent = msgTs !== 0 && Date.now() - msgTs < 60_000;
    const shouldGateNotify = !isBackfill && isUnseen && (lastSeenTs !== null || isRecent);

    if (shouldGateNotify && shouldNotifyForMessage({
      networkId,
      bufferName: channel,
      bufferType: buf?.type,
      msg,
      currentNick: net.currentNick || net.nick,
      bufferPrefs: getBufferPrefs(networkId, channel),
      desktopNotificationsEnabled: globalPrefs.desktopNotifications,
      muteAll: globalPrefs.muteAll,
      isActiveBuffer,
      documentHidden,
    })) {
      notify({
        tag: `${networkId}:${channel}:${msg.msgid || msg.t}`,
        title: getNotificationTitle(msg, buf?.type, channel),
        body: msg.text || '',
        silent: !globalPrefs.notificationSound,
        autoDismiss: globalPrefs.autoDismissNotifs,
        onClick: () => cb.switchToBuffer(networkId, channel),
      });
    }
  }

  return result;
}

// ── Whois helpers ──

function accumulateWhois(accum: AccumState, cmd: string, params: string[], text: string): void {
  if (!accum.whoisAcc) return;
  switch (cmd) {
    case '311':
      accum.whoisAcc.nick = params[0];
      accum.whoisAcc.user = params[1];
      accum.whoisAcc.host = params[2];
      accum.whoisAcc.realname = text;
      break;
    case '312':
      accum.whoisAcc.server = params[1];
      accum.whoisAcc.serverInfo = text;
      break;
    case '301':
      // RPL_AWAY: nick :away message
      accum.whoisAcc.away = text;
      break;
    case '313':
      // RPL_WHOISOPERATOR: nick :is an IRC operator
      (accum.whoisAcc as any).operator = true;
      break;
    case '317':
      accum.whoisAcc.idle = parseInt(params[1] || '0', 10);
      accum.whoisAcc.signon = parseInt(params[2] || '0', 10);
      break;
    case '319':
      accum.whoisAcc.channels = text.split(' ').filter(Boolean);
      break;
    case '330':
      accum.whoisAcc.account = params[1];
      break;
    case '671':
      // RPL_WHOISSECURE: nick :is using a secure connection
      accum.whoisAcc.secure = true;
      break;
    // Everything else in the WHOIS family — RPL_WHOISSPECIAL (320),
    // WHOISREGNICK (307), WHOISHOST (378), WHOISMODES (379), WHOISBOT
    // (335), WHOISCERTFP (276), and whatever a network invents next. The
    // server log renders no WHOIS numerics, so a `default` (not a fixed
    // case list) is what guarantees the text still reaches the overlay.
    default: {
      const line = (text || '').trim();
      if (!line) break;
      const special = accum.whoisAcc.special ?? [];
      if (!special.includes(line)) special.push(line);
      accum.whoisAcc.special = special;
      break;
    }
  }
}
