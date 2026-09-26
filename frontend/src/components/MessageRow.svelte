<!-- WASM evaluated 2026-08-13 — DOM-bound, not adopted; see frontend/wasm-message-history-report.md. Message history bottleneck is DOM/window, not per-row parse. -->
<script lang="ts">
  import { tick } from 'svelte';
  import type { IRCMessage, Member } from '../types';
  import { formatTime12Hour, formatDateTimeTitle, getUserModePrefix, stripPrefix, plainNick, getIrcCloudTypeClass, formatNumericText, escapeHtml, nickColorIndex, generateLabel, isTouchDevice } from '../lib/utils';
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import { autolinkHtml, wrapNicksWithHighlight, buildNickMentionPattern } from '../lib/autolinker';
  import { modeSentences } from '../lib/modeSentence';
  import { clientTagFeatures } from '../lib/clientTags';
  import { getActiveBufferObj, getActiveNetwork, findMessage, setReplyTarget, setReactTarget, toggleReaction, openMessageActions, QUICK_REACTIONS } from '../stores/ircStore.svelte';
  import { sendMessage } from '../stores/wsConnection.svelte.ts';
  import { globalPrefs, getBufferPrefs, highlightWords } from '../stores/preferences.svelte';
  import { memoRenderText, memoBlockArt } from '../lib/formatCache';
  import LongMessageContent from './LongMessageContent.svelte';
  import YoutubeEmbed from './YoutubeEmbed.svelte';
  import ImageInline from './ImageInline.svelte';
  import KlipyInline from './KlipyInline.svelte';
  import TextInline from './TextInline.svelte';
  import ServicesBadge from './ServicesBadge.svelte';
  import { extractImageUrlsFromText } from '../lib/imageInline';
  import { extractKlipySlugsFromText } from '../lib/klipyInline';
  import { extractTextUrlsFromText } from '../lib/textInline';
  import { extractYoutubeIdsFromText } from '../lib/youtube';
  import { isEmojiOnly } from '../lib/emoji';
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
  // IRCCloud renders these through `renderLine` — a bare `messageRow` that
  // inherits the log's own colour. KICK (`kicked_channel`) and AWAY belong
  // here too: both are user activity, not server output.
  const isJoinPart = $derived(['JOIN','PART','QUIT','NICK','CHGHOST','KICK','AWAY','JOINPART_GROUP','DISCO_GROUP'].includes(cmd));
  const isLifecycle = $derived(['CONNECT', 'DISCONNECT', 'DISCONNECTED'].includes(cmd));
  const isDisconnectDivider = $derived(cmd === 'DISCONNECT' || cmd === 'DISCONNECTED');
  const isSystem = $derived(['TOPIC','CONNECT','DISCONNECT','DISCONNECTED','ERROR','MODE','CAP','FAIL','JOINPART_GROUP','DISCO_GROUP','MOTD_GROUP','AWAY','KICK','INVITE'].includes(cmd) || /^\d{3}$/.test(cmd) || (cmd === 'NOTICE' && !msg.nick));
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
  // IRCCloud splits server output three ways (common-5650bddb.js):
  //   renderStatus      → ["status"]              channel_topic, channel_mode,
  //                                               user_channel_mode
  //   renderMonoStatus  → ["status","monospace"]  numerics, self_details,
  //                                               logged_in_as, user_mode,
  //                                               cap_*, error
  //   renderNotice      → ["notice"]              notice, invited,
  //                                               channel_invite
  const isStatusRow = $derived(isSystem && !isJoinPart && !isLifecycle);
  const isNoticeRow = $derived(isStatusRow && cmd === 'INVITE');
  const isPlainStatus = $derived(isStatusRow && ['TOPIC', 'MODE'].includes(cmd));
  const isMonoStatus = $derived(isStatusRow && !isNoticeRow && !isPlainStatus);

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

  // Mentions are typed as plain text, so the pattern and the highlight set
  // hold the formatting-free spelling of every roster nick and of our own;
  // the roster map itself stays keyed by the raw nick the server knows.
  const allNicksPattern = $derived.by(() => buildNickMentionPattern(
    [...[...memberByNick.keys()].map(plainNick), plainNick(myNick), ...highlightWords]));
  const highlightSet = $derived.by(() => {
    const s = new Set<string>();
    if (myNick) s.add(plainNick(myNick).toLowerCase());
    for (const w of highlightWords) if (w) s.add(w.toLowerCase());
    return s;
  });
  let expanded = $state(false);
  let tsHover = $state(false);
  const pendingState = $derived((msg as any).pendingState as string | undefined);
  function tsEnter(e: MouseEvent): void { (e.currentTarget as HTMLElement).closest('.row')?.classList.add('timestampHighlight'); }
  function tsLeave(e: MouseEvent): void { (e.currentTarget as HTMLElement).closest('.row')?.classList.remove('timestampHighlight'); }
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


  /// The author's channel status glyph. `msg.fromMode` is what the author
  /// held WHEN THEY SPOKE (IRCCloud `from_mode`, stamped by the engine and
  /// stored with the message); the roster is only a fallback for messages
  /// predating that field, because a roster lookup returns nothing once the
  /// author quits or is de-opped and returns nothing at all for history
  /// rendered before NAMES lands.
  function getModeForNick(n: string): string {
    if (msg.fromMode) return msg.fromMode;
    return findMemberForNick(n)?.prefix ?? '';
  }

  /// Services account for the badge: the account-tag stamped on the
  /// message wins (survives quit/rename), roster is the fallback for rows
  /// stored before Redis scrollback kept `a`.
  function getAccountForNick(n: string): string {
    if (msg.account && msg.account !== '*') return msg.account;
    return findMemberForNick(n)?.account ?? '';
  }

  /** Roster lookup by raw nick first, then by the formatting-free spelling
   *  (a mention chip carries what was typed, never the author's control
   *  bytes). */
  function findMemberForNick(n: string): Member | null {
    const cleaned = stripPrefix(n);
    const hit = memberByNick.get(cleaned);
    if (hit) return hit;
    const plain = plainNick(n).toLowerCase();
    for (const [k, member] of memberByNick) {
      if (plainNick(k).toLowerCase() === plain) return member;
    }
    // Fallback when MessageRow is rendered standalone (tests, etc.)
    const bufObj = getActiveBufferObj();
    if (!bufObj?.users) return null;
    for (const u of bufObj.users) {
      if (stripPrefix(u.nick) === cleaned || plainNick(u.nick).toLowerCase() === plain) return u;
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
    // public IRC signal short of `+B` user mode. The message prefix wins
    // when present; `member.host` is the cached copy filled in by
    // NAMES/WHO/JOIN.
    const hostFromPrefix = prefix && prefix.includes('@')
      ? prefix.slice(prefix.lastIndexOf('@') + 1)
      : '';
    const host = hostFromPrefix || member?.host || '';
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
    // Plain box-drawing / FIGlet box art (e.g. TDF 10-row "IRC FIBER"
    // banners): no color codes and no U+2580-259F blocks, so the rules
    // above miss it. Content-based: >=3 lines carrying box/shade glyphs
    // with wide average line length.
    const lines = text.split('\n');
    if (lines.length >= 3) {
      const boxRe = /[┌┐└┘─│═║╔╗╚╝▓░▒█▄▀]/;
      const boxLines = lines.filter((l) => boxRe.test(l));
      if (boxLines.length >= 3) {
        const stripped = boxLines.map((l) => l.replace(/[\x03\x04]/g, ''));
        const avg = stripped.reduce((n, l) => n + l.length, 0) / stripped.length;
        if (avg >= 20) return true;
      }
    }
    if (lines.length < 3) return false;
    // ASCII cat / owl art like d4rkm4g3's D00M TooL — many | / \ . - _ " ' ( ) [ ] and multiple lines with checkboxes
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

  /** The roster's own (raw) spelling of a nick. IRC nicks are
   *  case-insensitive and a typed mention carries no formatting, so
   *  "@zodiac" must open Zodiac's popup with Zodiac's member row — and the
   *  raw nick is what the popup's WHOIS/MODE sends to the server. */
  function canonicalNick(n: string): string {
    const cleaned = stripPrefix(n);
    if (memberByNick.has(cleaned)) return cleaned;
    const low = plainNick(n).toLowerCase();
    for (const k of memberByNick.keys()) if (plainNick(k).toLowerCase() === low) return k;
    return cleaned;
  }

  /** Delegated: a click on a nick inside the message body opens the same
   *  user popup the author column does. The body is {@html}, so there is
   *  nowhere to hang a per-span handler. Returns true when it handled the
   *  click, so a row with its own onclick can fall through. */
  function handleBodyNickClick(e: MouseEvent): boolean {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('.bufferLink[data-name]');
    if (!el || !onNickClick) return false;
    const target = canonicalNick(el.dataset.name || '');
    if (!target) return false;
    e.preventDefault();
    e.stopPropagation();
    onNickClick(target, e, findMemberForNick(target));
    return true;
  }

  // ── Replies and reactions (IRCv3 +reply, +draft/react) ──
  // A chat row with a msgid can be replied to and reacted to. The reply
  // target lives in the store (the input bar reads it); a reaction is a
  // TAGMSG on the raw path, exactly as typing is, applied optimistically
  // and re-applied idempotently by the server echo.
  const activeBufferName = $derived(getActiveBufferObj()?.name ?? '');
  const canInteract = $derived(!isSystem && !isJoinPart && !!nick && !!msg.msgid && !msg.redacted && !activeBufferName.startsWith('_'));
  // Client-only tags this server carries (CLIENTTAGDENY / message-tags).
  // Reply and React send tags; Copy and More do not, so only these two are
  // gated. Received reactions and reply quotes keep rendering.
  const tagFeatures = $derived(clientTagFeatures(activeNetwork));
  const canReply = $derived(canInteract && tagFeatures.reply);
  const canReact = $derived(canInteract && tagFeatures.react);
  const replyParent = $derived.by(() => {
    if (!msg.replyTo || !activeNetwork?.networkId || !activeBufferName) return undefined;
    return findMessage(activeNetwork.networkId, activeBufferName, msg.replyTo);
  });
  const reactionChips = $derived.by(() => {
    const r = msg.reactions;
    if (!r) return [] as Array<{ emoji: string; nicks: string[]; own: boolean }>;
    const me = myNick.toLowerCase();
    return Object.entries(r).map(([emoji, nicks]) => ({
      emoji,
      nicks,
      own: !!me && nicks.some(n => n.toLowerCase() === me),
    }));
  });

  function handleReply(): void {
    const networkId = activeNetwork?.networkId;
    if (!canReply || !networkId || !activeBufferName) return;
    // The input bar focuses its textarea when the target appears.
    setReplyTarget(networkId, activeBufferName, msg);
  }

  function handleReact(): void {
    const networkId = activeNetwork?.networkId;
    if (!canReact || !networkId || !activeBufferName || !msg.msgid) return;
    setReactTarget(networkId, activeBufferName, msg.msgid);
  }

  // ── Row actions: quick-reaction strip, More menu, right-click, long-press ──
  let rowEl = $state<HTMLElement | null>(null);
  let stripOpen = $state(false);
  const ownReactions = $derived(new Set(reactionChips.filter(c => c.own).map(c => c.emoji)));

  /** One-click reaction toggle (chip, quick strip). */
  function quickReact(emoji: string): void {
    const networkId = activeNetwork?.networkId;
    if (!canReact || !networkId || !activeBufferName) return;
    toggleReaction(networkId, activeBufferName, msg, emoji);
    stripOpen = false;
  }

  function openActions(x: number, y: number, sheet: boolean): void {
    const networkId = activeNetwork?.networkId;
    if (!canInteract || !networkId || !activeBufferName) return;
    stripOpen = false;
    openMessageActions({ networkId, bufferName: activeBufferName, msg, x, y, sheet, rowEl });
  }

  function openMenuFromButton(e: MouseEvent): void {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // positionMenu flips it right-anchored at the viewport edge.
    openActions(r.left, r.bottom + 4, false);
  }

  /** Right-click: our menu, unless the browser's would be more useful
   *  (a link, an existing widget) or the user is copying a selection. */
  function handleContextMenu(e: MouseEvent): void {
    const t = e.target as HTMLElement | null;
    if (t?.closest('a, .replyQuote, .reaction')) return;
    if ((window.getSelection()?.toString() ?? '').length > 0) return;
    e.preventDefault();
    cancelPress();
    openActions(e.clientX, e.clientY, isTouchDevice());
  }

  // Touch has no hover: a 500ms press (without a 10px drift, which is a
  // scroll) opens the same content as a bottom sheet. iOS synthesizes a
  // click on release even after a long press; preventDefault on that
  // touchend swallows it so it cannot land on the sheet's scrim and
  // close the sheet it just opened.
  const LONG_PRESS_MS = 500;
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressStart = { x: 0, y: 0 };
  let pressFired = false;
  function cancelPress(): void {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  }
  function handleTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest('a, button, .reaction, .replyQuote')) return;
    const { clientX, clientY } = e.touches[0];
    pressStart = { x: clientX, y: clientY };
    pressFired = false;
    cancelPress();
    pressTimer = setTimeout(() => { pressTimer = null; pressFired = true; openActions(clientX, clientY, true); }, LONG_PRESS_MS);
  }
  function handleTouchMove(e: TouchEvent): void {
    if (!pressTimer) return;
    const { clientX, clientY } = e.touches[0];
    if (Math.abs(clientX - pressStart.x) > 10 || Math.abs(clientY - pressStart.y) > 10) cancelPress();
  }
  function handleTouchEnd(e: TouchEvent): void {
    if (pressFired) { pressFired = false; if (e.cancelable) e.preventDefault(); }
    cancelPress();
  }

  /** Scroll the replied-to row into view and flash it. */
  function handleQuoteClick(e: MouseEvent): void {
    e.stopPropagation();
    if (!msg.replyTo) return;
    const selector = `[data-msgid="${CSS.escape(msg.replyTo)}"]`;
    const target = (e.currentTarget as HTMLElement).closest('.row')?.parentElement?.querySelector<HTMLElement>(selector)
      ?? document.querySelector<HTMLElement>(selector);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1500);
  }

  function handleRowKey(e: KeyboardEvent): void {
    if ((e.key === 'Enter' || e.key === ' ')
        && (e.target as HTMLElement | null)?.closest('.atMention')) {
      e.preventDefault();
      handleBodyNickClick(e as unknown as MouseEvent);
      return;
    }
    if (e.target !== e.currentTarget) return;
    if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      handleReply();
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
    if (isChat && allNicksPattern) {
      html = wrapNicksWithHighlight(html, allNicksPattern, highlightSet);
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
  // messages (JOIN/PART/QUIT/NICK/MODE/TOPIC/KICK/INVITE/AWAY/CHGHOST
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
  // IRCCloud renderChat pushes `only_emoji` for a chat line whose body is
  // nothing but emoji, and `.emoji-big .only_emoji .content .emojinative`
  // scales it to 32px/36px; `emoji-big` is their `!emoji-nobig` pref, ours
  // is globalPrefs.enlargeEmoji. Reading the pref inside the derived is the
  // same gating pattern as youtubeIds/imageUrls, so toggling
  // Settings → Messages → "Enlarge emoji-only messages" re-renders rows.
  // Excluded: system rows (NOTICE without a nick, numerics, TOPIC/MODE —
  // they render monospace `.status` bodies) and blockArt rows (16px Hack,
  // `white-space: pre` column alignment).
  const isEmojiOnlyRow = $derived(
    globalPrefs.enlargeEmoji
    && !isSystem
    && !isBlockArt
    && (cmd === 'PRIVMSG' || cmd === 'NOTICE' || isAction)
    && isEmojiOnly(msg.text || ''),
  );
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
  // Inline KLIPY GIFs (klipy.com/gifs/<slug>) — same gates as images; the
  // media itself is resolved by the gateway (see lib/klipyInline.ts).
  const klipySlugs = $derived.by(() => {
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
    return extractKlipySlugsFromText(text);
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
    // Event rows are prose: the nick reads plain, the message text keeps
    // its own formatting through renderText.
    const shownNick = plainNick(nick);
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
        + `<span class="buffer bufferLink user link" onclick="void(0)">${escapeHtml(shownNick)}</span>`
        + ' joined' + (usermask ? ` (${usermask})` : '');
    } else if (cmd === 'PART') {
      inner += '<span class="prefix">&#x2190;</span>'
        + `<span class="buffer bufferLink user link" onclick="void(0)">${escapeHtml(shownNick)}</span>`
        + ' left' + (msg.text ? ` (${escapeHtml(msg.text)})` : '');
    } else if (cmd === 'QUIT') {
      const usermask = getUsermask(msg.prefix || '');
      inner += '<span class="prefix">&#x21D1;</span>'
        + `<span class="buffer bufferLink user link" onclick="void(0)">${escapeHtml(shownNick)}</span>`
        + ' quit' + (usermask ? ` (${usermask})` : '') + (msg.text ? ` ${escapeHtml(msg.text)}` : '');
    } else if (cmd === 'NICK') {
      const newNick = plainNick(msg.params?.[msg.params.length - 1] || '');
      inner += `${escapeHtml(shownNick)} <span class="prefix">&rarr;</span> <span class="buffer bufferLink user link">${escapeHtml(newNick)}</span>`;
    } else if (cmd === 'TOPIC') {
      inner += '<span class="prefix">&#x2699;</span> ' + escapeHtml(shownNick) + ' changed the topic to: ' + renderText(msg.text || '');
    } else if (cmd === 'MODE') {
      inner += modeSentences(msg.params || [], shownNick, msg.text || '').join('<span class="bullet">\u2022</span>');
    } else if (cmd === 'KICK') {
      const kicked = plainNick(msg.params?.[1] || '');
      inner += '<span class="prefix">&#x2190;</span>'
        + `<span class="buffer bufferLink user link" onclick="void(0)">${escapeHtml(kicked)}</span>`
        + ` was kicked by ${escapeHtml(shownNick)}` + (msg.text ? ` (${renderText(msg.text)})` : '');
    } else if (cmd === 'INVITE') {
      inner += '<span class="prefix">&#x2192;</span> ' + escapeHtml(shownNick) + ' invited ' + escapeHtml(plainNick(msg.params?.[0] || '')) + ' to ' + escapeHtml(msg.params?.[1] || '');
    } else if (cmd === 'AWAY') {
      // Same shape as the expanded group row: flag prefix, linked nick.
      // (IRCCloud drops away/back from the log entirely — `user_away`,
      // `user_back`, `self_away` and `self_back` are all in its
      // `unrendered_messages` list — so this is our own line, styled like
      // every other user-activity row.)
      inner += '<span class="prefix">&#x2691;</span> '
        + `<span class="buffer bufferLink user link" onclick="void(0)">${escapeHtml(shownNick)}</span>`
        + (msg.text ? ` is away: <span class="awayReason">${escapeHtml(msg.text)}</span>` : ' is back');
    } else if (cmd === 'CHGHOST') {
      // IRCCloud `user_chghost`: "<nick> changed host: <old> → <new>".
      const oldMask = getUsermask(msg.prefix || '');
      const newMask = msg.params?.join('@') || msg.text || '';
      inner += `<span class="buffer bufferLink user link" onclick="void(0)">${escapeHtml(shownNick)}</span> changed host: `
        + (oldMask ? `${escapeHtml(oldMask)} <span class="prefix">&#x2192;</span> ` : '')
        + escapeHtml(newMask);
    } else {
      inner += renderText(msg.text || '');
    }
    return `<span translate="no" class="content">${inner}</span>`;
  }

  function toggleExpand(): void {
    const willExpand = !expanded;
    // If the user was pinned at the bottom before expanding, keep the
    // viewport pinned after the grouped rows render. Without this the
    // newly-expanded rows land below the fold and the user must manually
    // scroll to see them (bug: fa-square-plus grouping at bottom).
    const scroller = document.getElementById('messages') as HTMLDivElement | null;
    const wasAtBottom = !!(scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1);
    expanded = willExpand;
    if (willExpand && wasAtBottom && scroller) {
      tick().then(() => {
        scroller.scrollTop = scroller.scrollHeight;
        requestAnimationFrame(() => {
          scroller.scrollTop = scroller.scrollHeight;
        });
      });
    }
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

  function renderEvent(evt: IRCMessage): { timeStr: string; fullTitle: string; html: string; typeClass: string } {
    const eTs = evt.timestamp || (evt.t ? new Date(evt.t).toISOString() : null);
    const eTimeStr = eTs ? formatTime12Hour(new Date(eTs)) : '--:--:--';
    const eFullTitle = eTs ? formatDateTimeTitle(new Date(eTs)) : '';
    const eCmd = evt.command;
    const eNick = plainNick(evt.nick || '');
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
      // IRCCloud `nickchange`: "<oldnick> → <newnick>", same as the
      // standalone row renders it.
      const newNick = plainNick(evt.params?.[evt.params.length - 1] || '');
      html = `${escapeHtml(eNick)} <span class="prefix">&#x2192;</span> <span class="bufferLink user link">${escapeHtml(newNick)}</span>`;
    } else if (eCmd === 'CHGHOST') {
      const eNewMask = (evt.params || []).join('@') || evt.text || '';
      html = `<span class="bufferLink user link">${escapeHtml(eNick)}</span> changed host: `
        + (eUsermask ? `${escapeHtml(eUsermask)} <span class="prefix">&#x2192;</span> ` : '')
        + escapeHtml(eNewMask);
    } else if (eCmd === 'AWAY') {
      const reason = evt.text || '';
      if (reason) {
        html = `<span class="prefix">&#x2691;</span> <span class="bufferLink user link">${escapeHtml(eNick)}</span> is away: <span class="awayReason">${escapeHtml(reason)}</span>`;
      } else {
        html = `<span class="prefix">&#x2691;</span> <span class="bufferLink user link">${escapeHtml(eNick)}</span> is back`;
      }
    } else if (eCmd === 'MODE') {
      html = modeSentences(evt.params || [], eNick, evt.text || '').join('<span class="bullet">\u2022</span>');
    }

    return { timeStr: eTimeStr, fullTitle: eFullTitle, html, typeClass: eTypeClass };
  }
</script>

{#snippet iconReply()}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>{/snippet}
{#snippet iconReact()}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11v1a10 10 0 1 1-9-10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/><path d="M16 5h6"/><path d="M19 2v6"/></svg>{/snippet}
{#snippet iconMore()}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/><circle cx="5" cy="12" r="1.2"/></svg>{/snippet}
{#snippet iconPlus()}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/></svg>{/snippet}

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
    onclick={(e) => { if (!handleBodyNickClick(e)) toggleExpand(); }}
    onkeydown={onKeyDown}
  >
    <span class="g">&nbsp;</span>
    <span class="message">
      <span translate="no" class="content"><span class="collapseWidget" aria-label="User activity">
          <i class="fa-regular fa-square-minus collapseIcon"></i>
          <i class="fa-regular fa-square-plus expandIcon"></i>
          <i class="fa-solid fa-angle-right collapsedIcon"></i>
        </span><span class="sentence">
          {@html msg.sentences || ''}
        </span></span>
    </span>
    <span class="date" onmouseenter={tsEnter} onmouseleave={tsLeave}><span class="timestamp" title={fullTitle}>{timeStr}</span></span>
  </div>
  {#if expanded}
    {#each events.slice(1) as evt, i (evt.msgid || evt.id || evt.t + ':' + i || i)}
      {@const r = renderEvent(evt)}
      <div
        class="row messageRow joinPart part groupedJoinPartPart {r.typeClass}"
        data-time={evt.t}
        data-name={evt.nick || undefined}
        data-msgid={evt.msgid || undefined}
      >
        <span class="g">&nbsp;</span>
        <span class="message">
          <span translate="no" class="content">{@html r.html}</span>
        </span>
        <span class="date" onmouseenter={tsEnter} onmouseleave={tsLeave}><span class="timestamp" title={r.fullTitle}>{r.timeStr}</span></span>
      </div>
    {/each}
  {/if}
{:else if isDisconnectDivider}
  <!-- IRCCloud parity: minimal server-disconnect divider — <div class="row part type_socket_closed userParent"><hr> -->
  <div
    class="row part {typeClass} userParent"
    data-time={msg.t}
    data-name={nick || undefined}
    data-msgid={msg.msgid || undefined}
    data-eid={msg.eid || undefined}
  >
    <hr />
  </div>
{:else}
  {@const usermaskAttr = getUsermask(msg.prefix || '')}
  {@const hasCollapseWidget = ['JOIN','PART','QUIT','NICK','CHGHOST','AWAY'].includes(cmd)}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="row messageRow {isJoinPart ? 'joinPart' : ''} {isPlainStatus ? 'status' : ''} {isMonoStatus ? 'status monospace' : ''} {isNoticeRow ? 'notice' : ''} {isAction ? 'me action' : ''} {isServerLog ? 'serverLog phase-' + phase : ''} {typeClass} userParent {isHighlight ? 'highlight' : ''} {isSameAuthor ? 'sameAuthor' : 'firstAuthor'} {isOwn ? 'own' : ''} {isBot ? 'bot' : ''} {isBlockArt ? 'blockArt' : ''} {isEmojiOnlyRow ? 'onlyEmoji' : ''} {!isSystem && !isJoinPart && !isAction && nick ? 'hasAvatar' : ''} {isEntrance ? 'messageEntrance' : ''} {tsHover ? 'timestampHighlight' : ''} {pendingState ?? ''}"
    data-time={msg.t}
    data-name={nick || undefined}
    data-usermask={usermaskAttr || undefined}
    data-msgid={msg.msgid || undefined}
    data-phase={isServerLog ? phase : undefined}
    tabindex={canInteract ? -1 : undefined}
    bind:this={rowEl}
    onkeydown={canInteract ? handleRowKey : undefined}
    onclick={handleBodyNickClick}
    oncontextmenu={canInteract ? handleContextMenu : undefined}
    onmouseleave={canInteract ? () => { stripOpen = false; } : undefined}
    ontouchstart={canInteract ? handleTouchStart : undefined}
    ontouchmove={canInteract ? handleTouchMove : undefined}
    ontouchend={canInteract ? handleTouchEnd : undefined}
    ontouchcancel={canInteract ? cancelPress : undefined}
  >
    {#if !isSystem && !isJoinPart && !isAction && nick}
      {@const colorIndex = nickColorIndex(nick)}
      {@const colorCls = `c${colorIndex}`}
      {@const initial = plainNick(nick).charAt(0).toUpperCase()}
      <span class="avatar letterAvatar messageAvatar hasUserParent {colorCls}">
        <span role="presentation">{initial}</span>
      </span>
    {/if}
    <span class="g">&nbsp;</span>
    {#if cmd === 'CONNECT'}
      <hr class="reconnect-hr" />
    {/if}
    <span class="message">
      {#if isServerLog}
        <span class="serverLogChip" data-phase={phase} aria-label="Phase: {phaseLabel}">{phaseLabel}</span>
      {/if}
      {#if !isSystem && !isJoinPart && !isAction && nick}
        {@const colorIndex = nickColorIndex(nick)}
        {@const colorCls = `c${colorIndex}`}
        {@const initial = plainNick(nick).charAt(0).toUpperCase()}
        {@const modePrefix = getModeForNick(nick)}
        {@const modeInfo = modePrefix ? getUserModePrefix(modePrefix + 'x') : null}
        {@const usermask = getUsermask(msg.prefix || '')}
        {@const authorTitle = usermask ? `${plainNick(nick)} (${usermask})` : plainNick(nick)}
        {@const member = findMemberForNick(nick)}
        {@const sensibleRealname = getSensibleRealname(member?.realname || networkRealname)}
        {@const botFlag = isBotNick(nick, member, msg.prefix)}
        {@const account = getAccountForNick(nick)}
        <span translate="no" class="authorWrap">
          <span class="g" aria-hidden="true">&lt;</span>
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <span role="button" tabindex="0" class="buffer bufferLink author {colorCls} {modeInfo ? 'moded ' + modeInfo.cls : ''} user hasUserParent link"
                title={authorTitle} onclick={handleNickClick} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNickClick?.(nick, e as any); } }}>{#if modePrefix && modeInfo}<span title={modeInfo.title} class="mode_prefix mode_symbol {modeInfo.cls}">{modePrefix}</span><span title={modeInfo.title} class="mode_prefix mode_pill {modeInfo.cls}">&bull;</span>{/if}{@html parseIrcFormatting(nick)}</span>
          <ServicesBadge {account} />
          <span class="g" aria-hidden="true">&gt;</span>
          {#if sensibleRealname}
            <span class="author-realname">{sensibleRealname}</span>
          {/if}
          {#if botFlag}
            <span class="author-bot">BOT</span>
          {/if}
        </span>
      {/if}


      {#if msg.replyTo}
        <button type="button" class="replyQuote" onclick={handleQuoteClick} title="Jump to the replied-to message">
          <span class="replyArrow" aria-hidden="true">&#8617;</span>
          {#if replyParent}
            <span class="replyNick">{plainNick(replyParent.nick ?? '')}:</span>
            <span class="replyExcerpt">{(replyParent.text ?? '').slice(0, 120)}</span>
          {:else}
            <span class="replyExcerpt replyMissing">replying to an earlier message</span>
          {/if}
        </button>
      {/if}
      {#if isAction && nick}
        {@const colorIndex = nickColorIndex(nick)}
        {@const colorCls = `c${colorIndex}`}
        {@const initial = plainNick(nick).charAt(0).toUpperCase()}
        {@const member = findMemberForNick(nick)}
        {@const modePrefix = getModeForNick(nick)}
        {@const modeInfo = modePrefix ? getUserModePrefix(modePrefix + 'x') : null}
        {@const usermask = getUsermask(msg.prefix || '')}
        {@const authorTitle = usermask ? `${plainNick(nick)} (${usermask})` : plainNick(nick)}
        {@const botFlag = isBotNick(nick, member, msg.prefix)}
        {@const account = getAccountForNick(nick)}
        {@const actionText = msg.text || ''}
        <!--
          IRCCloud puts the avatar, me-dash, mode prefixes, author and BOT
          badge *inside* `.content` rather than in a sibling `.authorWrap`
          — keeps the inline run with the action body so a single
          `white-space: pre-wrap` line wraps correctly and matches the
          existing IRCCloud CSS selectors (e.g. `div.messageRow .content`).
        -->
        <span translate="no" class="content">
          <span class="avatar letterAvatar hasUserParent {colorCls}">
            <span role="presentation">{initial}</span>
          </span><span class="me_prefix">&mdash;</span>&nbsp;{#if modeInfo}<span title={modeInfo.title} class="mode_prefix mode_symbol {modeInfo.cls}">{modePrefix}</span><span title={modeInfo.title} class="mode_prefix mode_pill {modeInfo.cls}">&bull;</span>{/if}<!-- svelte-ignore a11y_click_events_have_key_events
          --><span role="button" tabindex="0" class="buffer bufferLink author {colorCls} {modeInfo ? 'moded ' + modeInfo.cls : ''} user hasUserParent link"
                title={authorTitle} onclick={handleNickClick}>{@html parseIrcFormatting(nick)}</span><ServicesBadge {account} />&nbsp;{#if botFlag}<span class="author-bot"><span title="">BOT</span>&nbsp;</span>&nbsp;{/if}<LongMessageContent text={actionText} render={renderText} isBlockArt={isBlockArt} />{#if youtubeIds.length > 0 || imageUrls.length > 0 || klipySlugs.length > 0 || textUrls.length > 0}<span class="inlineEmbeds">{#each youtubeIds as vid (vid)}<YoutubeEmbed id={vid} />{/each}{#each imageUrls as imgUrl (imgUrl)}<ImageInline url={imgUrl} />{/each}{#each klipySlugs as ks (ks)}<KlipyInline slug={ks} />{/each}{#each textUrls as turl (turl)}<TextInline url={turl} />{/each}</span>{/if}
        </span>
      {:else if chatContent}
        <span translate="no" class="content">{@html chatContent.prefix}<LongMessageContent text={chatContent.text} render={renderText} isBlockArt={isBlockArt} />{#if msg.edited && !isSystem}<span class="edited" title="edited"> (edited)</span>{/if}{#if youtubeIds.length > 0 || imageUrls.length > 0 || klipySlugs.length > 0 || textUrls.length > 0}<span class="inlineEmbeds">{#each youtubeIds as vid (vid)}<YoutubeEmbed id={vid} />{/each}{#each imageUrls as imgUrl (imgUrl)}<ImageInline url={imgUrl} />{/each}{#each klipySlugs as ks (ks)}<KlipyInline slug={ks} />{/each}{#each textUrls as turl (turl)}<TextInline url={turl} />{/each}</span>{/if}</span>
      {:else}
        {@html getContentHTML()}
        {#if youtubeIds.length > 0 || imageUrls.length > 0 || klipySlugs.length > 0 || textUrls.length > 0}
          <span class="inlineEmbeds inlineEmbeds--outside">{#each youtubeIds as vid (vid)}<YoutubeEmbed id={vid} />{/each}{#each imageUrls as imgUrl (imgUrl)}<ImageInline url={imgUrl} />{/each}{#each klipySlugs as ks (ks)}<KlipyInline slug={ks} />{/each}{#each textUrls as turl (turl)}<TextInline url={turl} />{/each}</span>
        {/if}
      {/if}
    </span>
    {#if reactionChips.length > 0}
      <div class="reactions" aria-label="Reactions">
        {#each reactionChips as chip (chip.emoji)}
          <button type="button" class="reaction" class:own={chip.own}
                  title={chip.nicks.map(plainNick).join(', ')}
                  aria-pressed={chip.own}
                  disabled={!canReact}
                  onclick={(e) => { e.stopPropagation(); quickReact(chip.emoji); }}>
            <span class="reactionEmoji">{chip.emoji}</span> <span class="reactionCount">{chip.nicks.length}</span>
          </button>
        {/each}
      </div>
    {/if}
    {#if canInteract}
      <span class="rowActions" class:stripOpen aria-label="Message actions">
        {#if canReact}
        <span class="reactStrip"><span class="reactStripInner">
          {#each QUICK_REACTIONS as emoji (emoji)}
            <button type="button" class="quickReaction" class:own={ownReactions.has(emoji)} aria-label="React {emoji}" aria-pressed={ownReactions.has(emoji)}
                    onclick={(e) => { e.stopPropagation(); quickReact(emoji); }}>{emoji}</button>
          {/each}
          <button type="button" class="quickReaction more" title="More reactions" aria-label="More reactions"
                  onclick={(e) => { e.stopPropagation(); stripOpen = false; handleReact(); }}>{@render iconPlus()}</button>
        </span></span>
        {/if}
        {#if canReply}
        <button type="button" class="rowAction reply" title="Reply (r)" aria-label="Reply"
                onclick={(e) => { e.stopPropagation(); handleReply(); }}>{@render iconReply()}</button>
        {/if}
        {#if canReact}
        <span class="reactWrap">
          <button type="button" class="rowAction react" title="React" aria-label="React" aria-expanded={stripOpen}
                  onclick={(e) => { e.stopPropagation(); stripOpen = !stripOpen; }}>{@render iconReact()}</button>
        </span>
        {/if}
        <button type="button" class="rowAction more" title="More" aria-label="More actions" aria-haspopup="menu"
                onclick={openMenuFromButton}>{@render iconMore()}</button>
      </span>
    {/if}
    <span class="date" onmouseenter={() => tsHover = true} onmouseleave={() => tsHover = false}><span class="timestamp" title={fullTitle} role={pendingState === 'failed' ? 'button' : undefined} tabindex={pendingState === 'failed' ? 0 : undefined} onclick={pendingState === 'failed' ? handleFailedRetry : undefined} onkeydown={pendingState === 'failed' ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleFailedRetry(); } } : undefined}>{timeStr}</span></span>
  </div>
{/if}
