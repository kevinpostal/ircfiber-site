<script lang="ts">
  import type { IRCMessage, Member } from '../types';
  import { formatTime12Hour, formatDateTimeTitle, getUserModePrefix, stripPrefix, getIrcCloudTypeClass, formatNumericText, escapeHtml, nickColorIndex, generateLabel } from '../lib/utils';
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import { autolinkHtml, mentionNicksWithPattern } from '../lib/autolinker';
  import { getActiveBufferObj, getActiveNetwork } from '../stores/ircStore.svelte';
  import { sendMessage } from '../stores/wsConnection.svelte.ts';
  import { globalPrefs, getBufferPrefs } from '../stores/preferences.svelte';
  import { memoRenderText, memoBlockArt } from '../lib/formatCache';
  import LongMessageContent from './LongMessageContent.svelte';
  import YoutubeEmbed from './YoutubeEmbed.svelte';
  import ImageInline from './ImageInline.svelte';
  import TextInline from './TextInline.svelte';
  import { extractImageUrlsFromText } from '../lib/imageInline';
  import { extractTextUrlsFromText } from '../lib/textInline';
  import { extractYoutubeIdsFromText } from '../lib/youtube';
  interface Props {
    msg: IRCMessage;
    isHighlight?: boolean;
    isSameAuthor?: boolean;
    isEntrance?: boolean;
    onNickClick?: (nick: string, event: MouseEvent, member?: Member | null) => void;
    memberByNick?: Map<string, Member>;
  }

  let { msg, isHighlight = false, isSameAuthor = false, isEntrance = false, onNickClick, memberByNick = new Map() }: Props = $props();

  const cmd = $derived(msg.command);
  const isJoinPart = $derived(['JOIN','PART','QUIT','NICK','CHGHOST','JOINPART_GROUP','DISCO_GROUP'].includes(cmd));
  const isLifecycle = $derived(['CONNECT', 'DISCONNECT'].includes(cmd));
  const isSystem = $derived(['TOPIC','CONNECT','DISCONNECT','ERROR','MODE','CAP','JOINPART_GROUP','DISCO_GROUP','MOTD_GROUP','AWAY','ACCOUNT','KICK','INVITE'].includes(cmd) || /^\d{3}$/.test(cmd) || (cmd === 'NOTICE' && !msg.nick));
  const isAction = $derived(msg.type === 'action');
  // Server-log progress entries from the engine carry a `phase` tag. We
  // expose both a boolean (for styling) and the raw phase (for the
  // visual chip + screen-reader label).
  const phase = $derived(msg.phase ?? '');
  const isServerLog = $derived(!!phase && cmd === 'NOTICE' && !msg.nick);
  const phaseLabel = $derived(isServerLog ? phaseToLabel(phase) : '');
  const isJoinPartGroup = $derived(cmd === 'JOINPART_GROUP');
  const isGrouped = $derived(isJoinPartGroup);
  const typeClass = $derived(getIrcCloudTypeClass(cmd, msg.params, msg.type));

  const ts = $derived(msg.timestamp || (msg.t ? new Date(msg.t).toISOString() : null));
  const timeStr = $derived(ts ? formatTime12Hour(new Date(ts)) : '--:--:--');
  const fullTitle = $derived(ts ? formatDateTimeTitle(new Date(ts)) : '');
  const nick = $derived(msg.nick ?? '');

  const activeNetwork = $derived(getActiveNetwork());
  const myNick = $derived(activeNetwork?.currentNick || '');
  // Fallback realname from the engine's network-wide cache (shipped on
  // every WS sync). Covers senders who are NOT in the active buffer's
  // member list — PM counterparts, users who have left the channel, and
  // history rows whose author is no longer present in the roster.
  // IRC nicks are case-insensitive, and the engine may store "AShapiro"
  // vs "ashapiro" — try exact then lowercased, then scan.
  const networkRealname = $derived.by(() => {
    if (!activeNetwork?.realnames || !nick) return '';
    const bare = stripPrefix(nick);
    const map = activeNetwork.realnames as Record<string, string>;
    if (map[bare] !== undefined) return map[bare];
    const low = bare.toLowerCase();
    if (map[low] !== undefined) return map[low];
    for (const k of Object.keys(map)) {
      if (k.toLowerCase() === low) return map[k];
    }
    return '';
  });
  const isOwn = $derived(!!nick && !!myNick && stripPrefix(nick).toLowerCase() === myNick.toLowerCase());
  const isBot = $derived(isBotNick(nick, findMemberForNick(nick), msg.prefix));
  const isBlockArt = $derived(memoBlockArt(containsBlockArt, msg.text || ''));

  const nickPattern = $derived.by(() => {
    if (!memberByNick || memberByNick.size === 0) return null;
    const sorted = [...memberByNick.keys()]
      .map(n => n.toLowerCase())
      .sort((a, b) => b.length - a.length);
    const escaped = sorted.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(
      `(?<=^|[^a-zA-Z0-9_\\\\[\\]\\\\{}])(${escaped.join('|')})(?=$|[^a-zA-Z0-9_\\\\[\\]\\\\{}])`,
      'gi'
    );
  });
  let expanded = $state(false);
  const pendingState = $derived((msg as any).pendingState as string | undefined);
  function handleFailedRetry(): void {
    if ((msg as any).pendingState !== 'failed' || !msg.label) return;
    const networkId = getActiveNetwork()?.networkId;
    const buf = getActiveBufferObj();
    if (!networkId || !buf?.name) return;
    const text2 = msg.text || '';
    if (!text2) return;
    const newLabel = generateLabel();
    sendMessage(networkId, buf.name, text2, newLabel);
  }


  function getModeForNick(n: string): string {
    const cleaned = stripPrefix(n);
    const member = memberByNick.get(cleaned);
    if (member) return member.prefix;
    // Fallback when MessageRow is rendered standalone (tests, etc.)
    const bufObj = getActiveBufferObj();
    if (!bufObj?.users) return '';
    for (const u of bufObj.users) {
      if (stripPrefix(u.nick) === cleaned) return u.prefix;
    }
    return '';
  }

  function findMemberForNick(n: string): Member | null {
    const cleaned = stripPrefix(n);
    const hit = memberByNick.get(cleaned);
    if (hit) return hit;
    // Fallback when MessageRow is rendered standalone (tests, etc.)
    const bufObj = getActiveBufferObj();
    if (!bufObj?.users) return null;
    for (const u of bufObj.users) {
      if (stripPrefix(u.nick) === cleaned) return u;
    }
    return null;
  }

  // IRCCloud BufferFormatter/LineMessageRenderer: getSensibleRealname
  // returns the realname, but filters out the literal strings "realname"
  // and "unknown" (case-insensitive) which some servers send as a default.
  function getSensibleRealname(raw: string | null | undefined): string {
    const r = (raw ?? '').trim();
    if (!r) return '';
    const lower = r.toLowerCase();
    if (lower === 'realname' || lower === 'unknown') return '';
    return r;
  }

  function isBotNick(n: string, member: Member | null, prefix?: string | null): boolean {
    if (member?.isBot) return true;
    const lower = n.toLowerCase();
    // Common bot heuristics: known services bots, accounts named BOT, or
    // identities with a "bot" segment in the ident or host portion of
    // the userhost mask.
    if (lower === 'bots' || lower.endsWith('serv') || lower.endsWith('bot')) {
      return true;
    }
    if (member?.account?.toUpperCase() === 'BOT') return true;
    if (member?.ident && /(^|\.)bot(\.|$)/i.test(member.ident)) return true;
    // Host suffix `.bot` (e.g. scroll@super.nets.bot) is the strongest
    // public IRC signal short of `+B` user mode. We look in both the
    // message prefix (`nick!user@host`) and any cached `member.ident`
    // since either may carry the userhost depending on how the member
    // entry was populated (NAMES vs WHO vs PRIVMSG).
    const hostFromPrefix = prefix && prefix.includes('@')
      ? prefix.slice(prefix.lastIndexOf('@') + 1)
      : '';
    const hostFromIdent = member?.ident && member.ident.includes('@')
      ? member.ident.slice(member.ident.lastIndexOf('@') + 1)
      : '';
    const host = hostFromPrefix || hostFromIdent;
    if (host && /(^|\.)bot(\.|$)/i.test(host)) return true;
    return false;
  }

  // Detect ANSI / block-character art (e.g. messages full of █, ▀, ▄, etc.).
  // These are often posted by regular users, not bots, and need the same
  // tight line-height/padding treatment as bot rows so the image grid lines
  // up without dark slivers between consecutive lines.
  function containsBlockArt(text: string): boolean {
    if (!text) return false;
    if (/[\u2580-\u259F]/.test(text)) return true;
    // mIRC/hex colored ASCII art (e.g. SuperNets . + ## mosaics).
    // These are single-line PRIVMSGs with many \x03/\x04 color segments
    // and no block characters, so the Unicode check misses them.
    // Heuristic: >=6 color codes + moderate length + art-like glyphs
    // (dots/hashes/blocks with spaces) => treat as blockArt to get
    // white-space:pre + no break-all wrapping. Normal rainbow chat
    // rarely has >=6 codes on one line, so false-positive rate is low
    // and the fallback styling (pre, overflow-x:auto) is harmless.
    const colorCodes = (text.match(/\x03|\x04/g) || []).length;
    if (colorCodes >= 6 && text.length >= 30) {
      // Art typically mixes '.' and '#' / '█' with spaced gaps
      if (/[.#\u2580-\u259F]/.test(text) && /\s{2,}/.test(text)) return true;
      // Or many hashes/dots regardless of double-space
      const artGlyphs = (text.match(/[#.]/g) || []).length;
      if (artGlyphs >= 8) return true;
    }
    // ASCII cat / owl art like d4rkm4g3's D00M TooL — many | / \ . - _ " ' ( ) [ ] and multiple lines with checkboxes
    const lines = text.split('\n');
    if (lines.length < 3) return false;
    const hasBoxes = (text.match(/\[ \]/g) || []).length >= 2;
    const symbols = (text.match(/[|\/\\\-_\.\"]/g) || []).length;
    // At least 12 symbol chars and 2 checkboxes, or the tool name
    if (text.includes("d4rkm4g3") || text.includes("D00M TooL")) return true;
    return hasBoxes && symbols >= 12;
  }

  function getUsermask(prefix: string): string {
    if (!prefix || !prefix.includes('!')) return '';
    return prefix.split('!')[1] ?? '';
  }

  function handleNickClick(e: MouseEvent): void {
    if (nick && onNickClick) {
      const member = findMemberForNick(nick);
      onNickClick(nick, e, member);
    }
  }

  function renderText(text: string): string {
    return memoRenderText(formatTextUncached, text);
  }

  // The actual work — autolink + IRC formatting + nick mentions. Pulled
  // out of renderText so we can hand it to memoRenderText as a thunk and
  // skip all this work on cache hits.
  function formatTextUncached(text: string): string {
    let html = autolinkHtml(parseIrcFormatting(text));
    const isChat = cmd === 'PRIVMSG' || (cmd === 'NOTICE' && !!nick);
    if (isChat && nickPattern) {
      html = mentionNicksWithPattern(html, nickPattern);
    }
    return html;
  }

  function getDisplayText(): string {
    if (/^\d{3}$/.test(cmd)) {
      return formatNumericText(cmd, msg.params || [], msg.text || '', nick);
    }
    return msg.text || '';
  }

  // Long-message truncation: chat content (PRIVMSG, NOTICE, CONNECT, 001,
  // numeric replies, action) renders through LongMessageContent so a single
  // message body never creates thousands of line boxes. The non-chat system
  // messages (JOIN/PART/QUIT/NICK/MODE/TOPIC/KICK/INVITE/AWAY/ACCOUNT/CHGHOST
  // and the grouped variants) keep their existing rendering because their
  // text is always a short human-readable phrase.
  const chatContent = $derived.by(() => {
    if (cmd === 'CONNECT' || cmd === '001') {
      return { prefix: '<span class="prefix">&#x2192;</span> ', text: getDisplayText() };
    }
    if (cmd === 'PRIVMSG' || cmd === 'NOTICE' || msg.type === 'action') {
      return { prefix: '', text: getDisplayText() };
    }
    if (/^\d{3}$/.test(cmd)) {
      return { prefix: '', text: getDisplayText() };
    }
    return null;
  });
  const isChat = $derived(cmd === 'PRIVMSG' || cmd === 'NOTICE' || msg.type === 'action' || /^\d{3}$/.test(cmd));
  // Inline YouTube previews — IRCCloud parity. Gated by inlineVideos (global)
  // and inlineImages (per-buffer, via ChannelContextMenu). IRCCloud's
  // buildYoutubeFrame uses buffer.inlineImagesAllowed() as the gate, so we
  // check both: if per-buffer images are disabled, don't embed; if global
  // videos are disabled, don't embed.
  const youtubeIds = $derived.by(() => {
    if (!globalPrefs.inlineVideos) return [];
    const net = getActiveNetwork();
    const buf = getActiveBufferObj();
    if (buf && net?.networkId) {
      const bp = getBufferPrefs(net.networkId, buf.name);
      if (bp.inlineImages === false) return [];
    }
    if (!isChat) return [];
    const text = chatContent?.text ?? msg.text ?? '';
    if (!text) return [];
    return extractYoutubeIdsFromText(text);
  });
  // Inline image previews — IRCCloud parity. Gated by global inlineImages
  // (Settings → Inline media) and per-buffer inlineImages (channel context
  // menu "Embed external media"). Mirrors IRCCloud's
  // Buffer.inlineImagesAllowed() → checkPref('inlineimages') with
  // buffer-level override. Extension check is IMAGE_EXT_RE (jpe?g|gif|png|webp)
  // on pathname/search/hash. See frontend/src/lib/imageInline.ts.
  const imageUrls = $derived.by(() => {
    if (!globalPrefs.inlineImages) return [];
    const net = getActiveNetwork();
    const buf = getActiveBufferObj();
    if (buf && net?.networkId) {
      const bp = getBufferPrefs(net.networkId, buf.name);
      if (bp.inlineImages === false) return [];
    }
    if (!isChat) return [];
    const text = chatContent?.text ?? msg.text ?? '';
    if (!text) return [];
    return extractImageUrlsFromText(text);
  });
  // Inline text/code previews — hosted text files (like images) with svelte-highlight.
  const textUrls = $derived.by(() => {
    const text = chatContent?.text ?? msg.text ?? '';
    const extracted = extractTextUrlsFromText(text);
    if (!isChat) return [];
    if (!text) return [];
    const imgs = new Set(imageUrls);
    return extracted.filter(u => !imgs.has(u));
  });
  //
  // TOPIC / KICK / action) render through LongMessageContent in the
  // template instead, so the body is capped at MAX_PREVIEW_LINES with a
  // "Show more" button. For those commands this function returns an empty
  // content span; the template branch renders the Svelte component.
  function getContentHTML(): string {
    const hasCollapseWidget = ['JOIN','PART','QUIT','NICK','CHGHOST','AWAY'].includes(cmd);
    let inner = '';
    if (hasCollapseWidget) {
      inner += '<span class="collapseWidget" aria-label="User activity">'
        + '<i class="fa-regular fa-square-minus collapseIcon"></i>'
        + '<i class="fa-regular fa-square-plus expandIcon"></i>'
        + '<i class="fa-solid fa-angle-right collapsedIcon"></i>'
        + '</span>';
    }
    if (cmd === 'MOTD_GROUP' && (msg as any).lines?.length > 0) {
      const lines = (msg as any).lines as string[];
      inner += '<div class="groupedLines">';
      lines.forEach((line, i) => {
        const content = parseIrcFormatting(line);
        inner += i === 0
          ? `<h2 class="groupedLines__line">${content}</h2>`
          : `<div class="groupedLines__line">${content}</div>`;
      });
      inner += '</div>';
    } else if (cmd === 'JOINPART_GROUP') {
      inner += (msg as any).sentences || '';
    } else if (cmd === 'DISCO_GROUP') {
      inner += (msg as any).sentences || '';
    } else if (cmd === 'DISCONNECT') {
      inner += '<span class="prefix">&#x21D1;</span> You disconnected'
        + ((msg.text && msg.text !== 'You disconnected') ? `: ${msg.text}` : '');
    } else if (chatContent) {
      // Content rendered by <LongMessageContent> in the template.
      return '';
    } else if (cmd === 'JOIN') {
      const usermask = getUsermask(msg.prefix || '');
      inner += '<span class="prefix">&#x2192;</span>'
        + `<span class="buffer bufferLink user link" onclick="void(0)">${escapeHtml(nick)}</span>`
        + ' joined' + (usermask ? ` (${usermask})` : '');
    } else if (cmd === 'PART') {
      inner += '<span class="prefix">&#x2190;</span>'
        + `<span class="buffer bufferLink user link" onclick="void(0)">${escapeHtml(nick)}</span>`
        + ' left' + (msg.text ? ` (${escapeHtml(msg.text)})` : '');
    } else if (cmd === 'QUIT') {
      const usermask = getUsermask(msg.prefix || '');
      inner += '<span class="prefix">&#x21D1;</span>'
        + `<span class="buffer bufferLink user link" onclick="void(0)">${escapeHtml(nick)}</span>`
        + ' quit' + (usermask ? ` (${usermask})` : '') + (msg.text ? ` ${escapeHtml(msg.text)}` : '');
    } else if (cmd === 'NICK') {
      const newNick = msg.params?.[msg.params.length - 1] || '';
      inner += `${escapeHtml(nick)} <span class="prefix">&rarr;</span> <span class="buffer bufferLink user link">${escapeHtml(newNick)}</span>`;
    } else if (cmd === 'TOPIC') {
      inner += '<span class="prefix">&#x2699;</span> ' + escapeHtml(nick) + ' changed the topic to: ' + renderText(msg.text || '');
    } else if (cmd === 'MODE') {
      const banInfos = expandBanModes(msg.params || []);
      if (banInfos.length === 1) {
        const modeInfo = banInfos[0];
        inner += `<span class="buffer bufferLink user link" onclick="void(0)">${escapeHtml(nick)}</span> `
          + `${escapeHtml(modeInfo.action)} <b>${escapeHtml(modeInfo.target)}</b> `
          + `(<span class="mono rawMode">${escapeHtml(modeInfo.diff)}${escapeHtml(modeInfo.mode)}</span>)`;
      } else if (banInfos.length > 1) {
        const parts = banInfos.map(b => `${escapeHtml(b.action)} <b>${escapeHtml(b.target)}</b> (<span class="mono rawMode">${escapeHtml(b.diff)}${escapeHtml(b.mode)}</span>)`);
        inner += `<span class="buffer bufferLink user link" onclick="void(0)">${escapeHtml(nick)}</span> ${parts.join(', ')}`;
      } else if (msg.params && !msg.params[0]?.startsWith('#') && !msg.params[0]?.startsWith('&')) {
        inner += '<span class="prefix">&#x2699;</span> user mode: ' + escapeHtml(msg.params.slice(1).join(' ') || msg.text || '');
      } else {
        inner += '<span class="prefix">&#x2699;</span> ' + escapeHtml(nick) + ' sets mode: ' + escapeHtml(msg.params?.slice(1).join(' ') || msg.text || '');
      }
    } else if (cmd === 'KICK') {
      const kicked = msg.params?.[1] || '';
      inner += '<span class="prefix">&#x2190;</span>'
        + `<span class="buffer bufferLink user link" onclick="void(0)">${escapeHtml(kicked)}</span>`
        + ` was kicked by ${escapeHtml(nick)}` + (msg.text ? ` (${renderText(msg.text)})` : '');
    } else if (cmd === 'INVITE') {
      inner += '<span class="prefix">&#x2192;</span> ' + escapeHtml(nick) + ' invited ' + escapeHtml(msg.params?.[0] || '') + ' to ' + escapeHtml(msg.params?.[1] || '');
    } else if (cmd === 'AWAY') {
      inner += '<span class="prefix">&#x2026;</span> ' + escapeHtml(nick) + ' is ' + (msg.text ? 'away: ' + msg.text : 'back');
    } else if (cmd === 'ACCOUNT') {
      inner += escapeHtml(nick) + ' ' + (msg.text === '*' ? 'logged out' : msg.text ? `logged in as ${msg.text}` : 'logged in');
    } else if (cmd === 'CHGHOST') {
      inner += escapeHtml(nick) + ' changed host to ' + escapeHtml(msg.params?.join('@') || msg.text || '');
    } else {
      inner += renderText(msg.text || '');
    }
    return `<span class="content">${inner}</span>`;
  }

  interface BanModeInfo {
    action: string;
    target: string;
    diff: string;
    mode: string;
  }

  function expandBanModes(params: string[]): BanModeInfo[] {
    if (!params || params.length < 2) return [];
    const modeStr = params[1] || '';
    const targets = params.slice(2);
    let adding = true;
    let targetIdx = 0;
    const out: BanModeInfo[] = [];
    for (const ch of modeStr) {
      if (ch === '+') { adding = true; continue; }
      if (ch === '-') { adding = false; continue; }
      if (ch !== 'b') continue;
      if (targetIdx < targets.length) {
        const diff = adding ? '+' : '-';
        const action = adding ? 'banned' : 'un-banned';
        out.push({ action, target: targets[targetIdx++], diff, mode: 'b' });
      }
    }
    return out;
  }

  function parseBanMode(params: string[]): BanModeInfo | null {
    const expanded = expandBanModes(params);
    return expanded.length === 1 ? expanded[0] : null;
  }
  function toggleExpand(): void {
    expanded = !expanded;
  }

  // Map the engine's phase taxonomy to human-readable labels for the
  // visual chip rendered next to each server-log entry. Keep the keys
  // in sync with `IRCRawEvent.makeServerLog` in the D engine.
  function phaseToLabel(p: string): string {
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
      default:             return p;
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  }

  function formatModeText(evt: IRCMessage): string {
    const params = evt.params || [];
    const modeStr = params[1] || evt.text || '';
    if (params.length > 2) {
      return `${modeStr} ${params.slice(2).join(' ')}`;
    }
    return modeStr;
  }

  function renderEvent(evt: IRCMessage): { timeStr: string; fullTitle: string; html: string; typeClass: string } {
    const eTs = evt.timestamp || (evt.t ? new Date(evt.t).toISOString() : null);
    const eTimeStr = eTs ? formatTime12Hour(new Date(eTs)) : '--:--:--';
    const eFullTitle = eTs ? formatDateTimeTitle(new Date(eTs)) : '';
    const eCmd = evt.command;
    const eNick = evt.nick || '';
    const eUsermask = getUsermask(evt.prefix || '');
    const eTypeClass = getIrcCloudTypeClass(eCmd, evt.params, evt.type);

    let html = '';
    if (eCmd === 'JOIN') {
      html = `<span class="prefix">&#x2192;</span> <span class="bufferLink user link">${escapeHtml(eNick)}</span> joined${eUsermask ? ` (${escapeHtml(eUsermask)})` : ''}`;
    } else if (eCmd === 'PART') {
      html = `<span class="prefix">&#x2190;</span> <span class="bufferLink user link">${escapeHtml(eNick)}</span> left${evt.text ? ` (${escapeHtml(evt.text)})` : ''}`;
    } else if (eCmd === 'QUIT') {
      html = `<span class="prefix">&#x21D0;</span> <span class="bufferLink user link">${escapeHtml(eNick)}</span> quit${eUsermask ? ` (${escapeHtml(eUsermask)})` : ''}${evt.text ? ` ${escapeHtml(evt.text)}` : ''}`;
    } else if (eCmd === 'NICK') {
      const newNick = evt.params?.[evt.params.length - 1] || '';
      html = `<span class="prefix">&#x2194;</span> <span class="bufferLink user link">${escapeHtml(eNick)}</span> is now known as <span class="bufferLink user link">${escapeHtml(newNick)}</span>`;
    } else if (eCmd === 'CHGHOST') {
      html = `<span class="prefix">&#x2194;</span> <span class="bufferLink user link">${escapeHtml(eNick)}</span> changed host to ${escapeHtml((evt.params || []).join('@') || evt.text || '')}`;
    } else if (eCmd === 'AWAY') {
      const reason = evt.text || '';
      if (reason) {
        html = `<span class="prefix">&#x2691;</span> <span class="bufferLink user link">${escapeHtml(eNick)}</span> is away: <span class="awayReason">${escapeHtml(reason)}</span>`;
      } else {
        html = `<span class="prefix">&#x2691;</span> <span class="bufferLink user link">${escapeHtml(eNick)}</span> is back`;
      }
    } else if (eCmd === 'MODE') {
      const bans = expandBanModes(evt.params || []);
      if (bans.length === 1) {
        const b = bans[0];
        html = `<span class="buffer bufferLink user link">${escapeHtml(eNick)}</span> ${b.action} <b>${escapeHtml(b.target)}</b> (<span class="mono rawMode">${escapeHtml(b.diff)}${escapeHtml(b.mode)}</span>)`;
      } else if (bans.length > 1) {
        const parts = bans.map(b => `${b.action} <b>${escapeHtml(b.target)}</b> (<span class="mono rawMode">${escapeHtml(b.diff)}${escapeHtml(b.mode)}</span>)`);
        html = `<span class="buffer bufferLink user link">${escapeHtml(eNick)}</span> ${parts.join(', ')}`;
      } else {
        html = `<span class="prefix">&#x2699;</span> Channel mode is <b>${escapeHtml(formatModeText(evt))}</b>`;
      }
    }

    return { timeStr: eTimeStr, fullTitle: eFullTitle, html, typeClass: eTypeClass };
  }
</script>

{#if isGrouped && msg.events && msg.events.length > 0}
  {@const events = (msg.events as { msg: IRCMessage }[]).map(e => e.msg)}
  {@const head = events[0]}
  <div
    role="button"
    aria-expanded={expanded}
    tabindex="0"
    class="row messageRow joinPart groupedJoinPart {expanded ? '' : 'collapsedHead'} {expanded ? 'expanded' : ''}"
    data-time={head.t || msg.t}
    data-name={head.nick || undefined}
    data-msgid={head.msgid || undefined}
    onclick={toggleExpand}
    onkeydown={onKeyDown}
  >
    <span class="g">&nbsp;</span>
    <span class="message">
      <span class="content"><span class="collapseWidget" aria-label="User activity">
          <i class="fa-regular fa-square-minus collapseIcon"></i>
          <i class="fa-regular fa-square-plus expandIcon"></i>
          <i class="fa-solid fa-angle-right collapsedIcon"></i>
        </span><span class="sentence">
          {@html msg.sentences || ''}
        </span></span>
    </span>
    <span class="date"><span class="timestamp" title={fullTitle}>{timeStr}</span></span>
  </div>
  {#if expanded}
    {#each events.slice(1) as evt, i (evt.msgid || evt.id || evt.t + ':' + i || i)}
      {@const r = renderEvent(evt)}
      <div
        class="row messageRow status part groupedJoinPartPart {r.typeClass}"
        data-time={evt.t}
        data-name={evt.nick || undefined}
        data-msgid={evt.msgid || undefined}
      >
        <span class="g">&nbsp;</span>
        <span class="message">
          <span class="content">{@html r.html}</span>
        </span>
        <span class="date"><span class="timestamp" title={r.fullTitle}>{r.timeStr}</span></span>
      </div>
    {/each}
  {/if}
{:else}
  {@const usermaskAttr = getUsermask(msg.prefix || '')}
  {@const hasCollapseWidget = ['JOIN','PART','QUIT','NICK','CHGHOST','AWAY'].includes(cmd)}
  <div
    class="row messageRow {isJoinPart ? 'joinPart' : ''} {isSystem && !isJoinPart && !isLifecycle ? 'status monospace' : ''} {isAction ? 'me action' : ''} {isServerLog ? 'serverLog phase-' + phase : ''} {typeClass} userParent {isHighlight ? 'highlight' : ''} {isSameAuthor ? 'sameAuthor' : 'firstAuthor'} {isOwn ? 'own' : ''} {isBot ? 'bot' : ''} {isBlockArt ? 'blockArt' : ''} {!isSystem && !isJoinPart && !isAction && nick ? 'hasAvatar' : ''} {isEntrance ? 'messageEntrance' : ''} {pendingState ?? ''}"
    data-time={msg.t}
    data-name={nick || undefined}
    data-usermask={usermaskAttr || undefined}
    data-msgid={msg.msgid || undefined}
    data-phase={isServerLog ? phase : undefined}
  >
    {#if !isSystem && !isJoinPart && !isAction && nick}
      {@const colorIndex = nickColorIndex(nick)}
      {@const colorCls = `c${colorIndex}`}
      {@const initial = nick.charAt(0).toUpperCase()}
      <span class="avatar letterAvatar messageAvatar hasUserParent {colorCls}">
        <span role="presentation">{initial}</span>
      </span>
    {/if}
    <span class="g">&nbsp;</span>
    {#if cmd === 'DISCONNECT' || cmd === 'CONNECT'}
      <hr class="reconnect-hr" />
    {/if}
    <span class="message">
      {#if isServerLog}
        <span class="serverLogChip" data-phase={phase} aria-label="Phase: {phaseLabel}">{phaseLabel}</span>
      {/if}
      {#if !isSystem && !isJoinPart && !isAction && nick}
        {@const colorIndex = nickColorIndex(nick)}
        {@const colorCls = `c${colorIndex}`}
        {@const initial = nick.charAt(0).toUpperCase()}
        {@const modePrefix = getModeForNick(nick)}
        {@const usermask = getUsermask(msg.prefix || '')}
        {@const authorTitle = usermask ? `${nick} (${usermask})` : nick}
        {@const member = findMemberForNick(nick)}
        {@const sensibleRealname = getSensibleRealname(member?.realname || networkRealname)}
        {@const botFlag = isBotNick(nick, member, msg.prefix)}
        <span class="authorWrap">
          <span class="g" aria-hidden="true">&lt;</span>
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <span role="button" tabindex="0" class="buffer bufferLink author {colorCls} user hasUserParent link"
                title={authorTitle} onclick={handleNickClick} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNickClick?.(nick, e as any); } }}>{#if modePrefix}{@const modeInfo = getUserModePrefix(modePrefix + 'x')}<span class="mode_prefix mode_symbol {modeInfo.cls}">{modePrefix}</span>{/if}{nick}</span>
          <span class="g" aria-hidden="true">&gt;</span>
          {#if sensibleRealname}
            <span class="author-realname">{sensibleRealname}</span>
          {/if}
          {#if botFlag}
            <span class="author-bot">BOT</span>
          {/if}
        </span>
      {/if}

      {#if isAction && nick}
        {@const colorIndex = nickColorIndex(nick)}
        {@const colorCls = `c${colorIndex}`}
        {@const initial = nick.charAt(0).toUpperCase()}
        {@const member = findMemberForNick(nick)}
        {@const modePrefix = getModeForNick(nick)}
        {@const modeInfo = modePrefix ? getUserModePrefix(modePrefix + 'x') : null}
        {@const usermask = getUsermask(msg.prefix || '')}
        {@const authorTitle = usermask ? `${nick} (${usermask})` : nick}
        {@const botFlag = isBotNick(nick, member, msg.prefix)}
        {@const actionText = msg.text || ''}
        <!--
          IRCCloud puts the avatar, me-dash, mode prefixes, author and BOT
          badge *inside* `.content` rather than in a sibling `.authorWrap`
          — keeps the inline run with the action body so a single
          `white-space: pre-wrap` line wraps correctly and matches the
          existing IRCCloud CSS selectors (e.g. `div.messageRow .content`).
        -->
        <span class="content">
          <span class="avatar letterAvatar hasUserParent {colorCls}">
            <span role="presentation">{initial}</span>
          </span><span class="me_prefix">&mdash;</span>&nbsp;{#if modeInfo}<span title={modeInfo.title} class="mode_prefix mode_symbol {modeInfo.cls}">{modePrefix}</span><span title={modeInfo.title} class="mode_prefix mode_pill {modeInfo.cls}">&bull;</span>{/if}<!-- svelte-ignore a11y_click_events_have_key_events
          --><span role="button" tabindex="0" class="buffer bufferLink author {colorCls} {modeInfo ? 'moded ' + modeInfo.cls : ''} user hasUserParent link"
                title={authorTitle} onclick={handleNickClick}>{nick}</span>&nbsp;{#if botFlag}<span class="author-bot"><span title="">BOT</span>&nbsp;</span>&nbsp;{/if}<LongMessageContent text={actionText} render={renderText} isBlockArt={isBlockArt} />{#if youtubeIds.length > 0 || imageUrls.length > 0 || textUrls.length > 0}<span class="inlineEmbeds">{#each youtubeIds as vid (vid)}<YoutubeEmbed id={vid} />{/each}{#each imageUrls as imgUrl (imgUrl)}<ImageInline url={imgUrl} />{/each}{#each textUrls as turl (turl)}<TextInline url={turl} />{/each}</span>{/if}
        </span>
      {:else if chatContent}
        <span class="content">{@html chatContent.prefix}<LongMessageContent text={chatContent.text} render={renderText} isBlockArt={isBlockArt} />{#if youtubeIds.length > 0 || imageUrls.length > 0 || textUrls.length > 0}<span class="inlineEmbeds">{#each youtubeIds as vid (vid)}<YoutubeEmbed id={vid} />{/each}{#each imageUrls as imgUrl (imgUrl)}<ImageInline url={imgUrl} />{/each}{#each textUrls as turl (turl)}<TextInline url={turl} />{/each}</span>{/if}</span>
      {:else}
        {@html getContentHTML()}
        {#if youtubeIds.length > 0 || imageUrls.length > 0 || textUrls.length > 0}
          <span class="inlineEmbeds inlineEmbeds--outside">{#each youtubeIds as vid (vid)}<YoutubeEmbed id={vid} />{/each}{#each imageUrls as imgUrl (imgUrl)}<ImageInline url={imgUrl} />{/each}{#each textUrls as turl (turl)}<TextInline url={turl} />{/each}</span>
        {/if}
      {/if}
    </span>
    <span class="date"><span class="timestamp" title={fullTitle} role={pendingState === 'failed' ? 'button' : undefined} tabindex={pendingState === 'failed' ? 0 : undefined} onclick={pendingState === 'failed' ? handleFailedRetry : undefined} onkeydown={pendingState === 'failed' ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleFailedRetry(); } } : undefined}>{timeStr}</span></span>
  </div>
{/if}
