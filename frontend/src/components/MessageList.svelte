<script lang="ts">
  import { ircState, isMessageUnseen, getLastSeenMessage, countMessagesBetween, countImportantMessagesBetween, clearUnseenHighlightsAfter, unseenHighlightCountAfter, updateBottomSeen } from '../stores/ircStore.svelte';
  import { getClearedAt, setLastSeen } from '../stores/preferences.svelte';
  import { preprocessMessages } from '../lib/messageBuilder';
  import MessageRow from './MessageRow.svelte';
  import DateChange from './DateChange.svelte';

  import SeenDivider from './SeenDivider.svelte';
  import LoadMore from './LoadMore.svelte';
  import ChatterBar from './ChatterBar.svelte';
  import { isSkippedCommand, getMsgDate, formatDate, formatDateTimeTitle, formatShortRelativeTime, stringHash, stripPrefix } from '../lib/utils';
  import type { IRCMessage, Member } from '../types';

  interface Props {
    onNickClick?: (nick: string, event: MouseEvent, member?: Member | null) => void;
    onLoadMore?: () => Promise<boolean>;
  }
  let { onNickClick, onLoadMore }: Props = $props();

  let container: HTMLDivElement;
  let shouldAutoScroll = $state(true);
  let aboveUnseenCount = $state(0);
  let belowUnseenCount = $state(0);
  let aboveUnseenTimestamp = $state<number | null>(null);
  let belowUnseenTimestamp = $state<number | null>(null);
  let aboveUnseenHighlights = $state(0);
  let belowUnseenHighlights = $state(0);

  // IRCCloud-style sticky avatar: shows the author of the topmost visible
  // message row as a floating avatar bar.
  let stickyNick = $state('');
  let stickyColor = $state('');
  let stickyMode = $state('');

  const bufferKey = $derived(`${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`);

  const processedMessages = $derived.by(() => {
    const key = bufferKey;
    const raw = ircState.messages[key] ?? [];
    const clearedAt = ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName
      ? getClearedAt(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName) : null;
    const cleared = clearedAt ? raw.filter(m => (m.t || 0) > clearedAt) : raw;
    const noEmpty = cleared.filter(m => {
      if (m.lines || m.sentences || m.events) return true;
      return typeof m.text === 'string' && m.text.trim() !== '';
    });
    return preprocessMessages(noEmpty);
  });

  function checkSameAuthor(msg: IRCMessage, prev: IRCMessage | null): boolean {
    if (!prev) return false;
    if (msg.command !== 'PRIVMSG' && msg.type !== 'action') return false;
    if (prev.command !== 'PRIVMSG' && prev.type !== 'action') return false;
    const nick = stripPrefix(msg.nick || '');
    const prevNick = stripPrefix(prev.nick || '');
    if (!nick || !prevNick || nick !== prevNick) return false;
    return true;
  }

  function shouldShowSeenDivider(msg: IRCMessage, index: number): boolean {
    if (!ircState.lastSeenMsgTime || !ircState.focusLost) return false;
    const prev = index > 0 ? processedMessages[index - 1] : null;
    if (!prev) return false;
    return (prev.t || 0) <= ircState.lastSeenMsgTime && (msg.t || 0) > ircState.lastSeenMsgTime;
  }

  let prevScrollHeight = 0;
  let prevScrollTop = 0;
  let lastBufferKey = '';
  let wasAutoScroll = true;

  // Pre-compute date separators with dedup to avoid duplicate DateChange headers
  const messagesWithDates = $derived.by(() => {
    const msgs = processedMessages;
    let lastDate = '';
    return msgs.map((msg, i) => {
      const msgDate = getMsgDate(msg);
      const prevMsg = i > 0 ? msgs[i - 1] : null;
      const prevDate = prevMsg ? getMsgDate(prevMsg) : null;
      const showDate = !!(msgDate && msgDate !== prevDate && msgDate !== lastDate);
      if (showDate) lastDate = msgDate;
      return { msg, showDate, msgDate, prevDate, prevMsg };
    });
  });

  $effect(() => {
    const key = bufferKey;
    if (key !== lastBufferKey) {
      lastBufferKey = key;
      prevScrollHeight = 0;
      prevScrollTop = 0;
      shouldAutoScroll = true;
      wasAutoScroll = true;
    }

    const msgs = processedMessages;
    if (!container) return;

    const justDisabledAutoScroll = wasAutoScroll && !shouldAutoScroll;
    wasAutoScroll = shouldAutoScroll;

    if (shouldAutoScroll) {
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight;
          prevScrollHeight = container.scrollHeight;
          prevScrollTop = container.scrollTop;
        }
      });
    } else if (!justDisabledAutoScroll && prevScrollHeight > 0) {
      // New messages arrived while user is scrolled up — maintain relative position
      const oldHeight = prevScrollHeight;
      const oldTop = prevScrollTop;
      requestAnimationFrame(() => {
        if (container) {
          const newHeight = container.scrollHeight;
          const delta = newHeight - oldHeight;
          if (delta > 0) container.scrollTop = oldTop + delta;
          prevScrollHeight = container.scrollHeight;
          prevScrollTop = container.scrollTop;
        }
      });
    } else {
      // User just scrolled up (or first time) — just record current position
      requestAnimationFrame(() => {
        if (container) {
          prevScrollHeight = container.scrollHeight;
          prevScrollTop = container.scrollTop;
        }
      });
    }
    void msgs.length;
  });

  function handleScroll(): void {
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    shouldAutoScroll = scrollHeight - scrollTop - clientHeight < 50;
    updateChatterCounts();
    updateReadTracking();
    updateStickyAvatar();
  }

  function updateChatterCounts(): void {
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const rows = container.querySelectorAll('.row.messageRow');
    const { networkId, bufferName } = ircState.activeBuffer;
    if (!networkId || !bufferName) return;

    let above = 0, below = 0;
    let aboveTs: number | null = null;
    let belowTs: number | null = null;
    let firstAboveMsg: IRCMessage | null = null;
    let firstBelowMsg: IRCMessage | null = null;

    for (const row of Array.from(rows)) {
      const rect = (row as HTMLElement).getBoundingClientRect();
      const time = (row as HTMLElement).dataset.time;
      const msgid = (row as HTMLElement).dataset.msgid;
      if (rect.bottom < containerRect.top) {
        above++;
        if (time && aboveTs === null) aboveTs = parseInt(time);
        if (!firstAboveMsg && msgid) {
          firstAboveMsg = findMessageByMsgid(networkId, bufferName, msgid);
        }
      } else if (rect.top > containerRect.bottom) {
        below++;
        if (time && belowTs === null) belowTs = parseInt(time);
        if (!firstBelowMsg && msgid) {
          firstBelowMsg = findMessageByMsgid(networkId, bufferName, msgid);
        }
      }
    }

    // IRCCloud-style: upper bar only shows if the first message above is actually unseen
    const lastSeenMsg = getLastSeenMessage(networkId, bufferName);
    if (firstAboveMsg && isMessageUnseen(firstAboveMsg, networkId, bufferName) && lastSeenMsg) {
      const totalBetween = countMessagesBetween(networkId, bufferName, lastSeenMsg, firstAboveMsg);
      if (totalBetween > 100) {
        aboveUnseenCount = totalBetween;
        aboveUnseenTimestamp = lastSeenMsg.t || null;
      } else {
        const important = countImportantMessagesBetween(networkId, bufferName, lastSeenMsg, firstAboveMsg);
        aboveUnseenCount = important > 0 ? important : totalBetween;
        aboveUnseenTimestamp = lastSeenMsg.t || null;
      }
      aboveUnseenHighlights = clearUnseenHighlightsAfter(networkId, bufferName, firstAboveMsg);
    } else {
      aboveUnseenCount = 0;
      aboveUnseenTimestamp = null;
      aboveUnseenHighlights = 0;
    }

    // Lower bar: track bottomSeen and count messages after it
    const bottomSeenMsg = firstBelowMsg || (below > 0 ? null : null);
    if (bottomSeenMsg) {
      updateBottomSeen(networkId, bufferName, bottomSeenMsg);
      const totalBelow = countMessagesBetween(networkId, bufferName, bottomSeenMsg);
      if (totalBelow > 100) {
        belowUnseenCount = totalBelow;
        belowUnseenTimestamp = bottomSeenMsg.t || null;
      } else {
        const important = countImportantMessagesBetween(networkId, bufferName, bottomSeenMsg);
        belowUnseenCount = important > 0 ? important : totalBelow;
        belowUnseenTimestamp = bottomSeenMsg.t || null;
      }
      belowUnseenHighlights = unseenHighlightCountAfter(networkId, bufferName, bottomSeenMsg);
    } else {
      belowUnseenCount = below;
      belowUnseenTimestamp = belowTs;
      belowUnseenHighlights = 0;
    }
  }

  function findMessageByMsgid(networkId: string, bufferName: string, msgid: string): IRCMessage | null {
    const key = `${networkId}:${bufferName}`;
    const list = ircState.messages[key] ?? [];
    return list.find(m => m.msgid === msgid) ?? null;
  }

  function updateReadTracking(): void {
    if (!container) return;
    const { networkId, bufferName } = ircState.activeBuffer;
    if (!networkId || !bufferName) return;
    const containerRect = container.getBoundingClientRect();
    const rows = container.querySelectorAll('.row.messageRow');
    let lastVisibleMsg: IRCMessage | null = null;
    for (const row of Array.from(rows)) {
      const rect = (row as HTMLElement).getBoundingClientRect();
      const msgid = (row as HTMLElement).dataset.msgid;
      if (rect.top >= containerRect.top && rect.bottom <= containerRect.bottom) {
        if (msgid) {
          const msg = findMessageByMsgid(networkId, bufferName, msgid);
          if (msg) lastVisibleMsg = msg;
        }
      }
    }
    if (lastVisibleMsg && lastVisibleMsg.t) {
      setLastSeen(networkId, bufferName, lastVisibleMsg.t);
    }
  }

  /** IRCCloud-style sticky avatar: shows the author of the topmost visible
   *  message row as a floating avatar bar pinned to the top. */
  function updateStickyAvatar(): void {
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const rows = container.querySelectorAll('.row.messageRow');
    for (const row of Array.from(rows)) {
      const rect = (row as HTMLElement).getBoundingClientRect();
      if (rect.bottom > containerRect.top) {
        const nick = (row as HTMLElement).dataset.name || '';
        if (nick) {
          stickyNick = nick;
          stickyColor = `c${stringHash(nick) % 27}`;
          const d = row as HTMLElement;
          stickyMode = '';
        }
        break;
      }
    }
    if (container.scrollTop < 10) stickyNick = '';
  }

  function scrollToTop(): void {
    container?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function scrollToBottom(): void {
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }
</script>

{#if aboveUnseenCount > 0}
  <ChatterBar position="above" count={aboveUnseenCount} timestamp={aboveUnseenTimestamp} mentions={aboveUnseenHighlights} onClick={scrollToTop} />
{/if}

<div class="messages-viewport">
  <div class="messages" id="messages" bind:this={container} onscroll={handleScroll}>
    <LoadMore {onLoadMore} />

    {#each messagesWithDates as item, i (item.msg.id || item.msg.msgid || item.msg.t || i)}
      {@const msg = item.msg}
      {@const msgDate = item.msgDate}
      {@const prevDate = item.prevDate}
      {@const prevMsg = item.prevMsg}

      {#if item.showDate}
        <DateChange date={msgDate} />
      {/if}

      {#if shouldShowSeenDivider(msg, i)}
        <SeenDivider />
      {/if}

      {#if !isSkippedCommand(msg.command)}
        <MessageRow
          {msg}
          isHighlight={msg.highlight ?? false}
          isSameAuthor={checkSameAuthor(msg, prevMsg)}
          {onNickClick}
        />
      {/if}
    {/each}
  </div>

  {#if stickyNick}
    <div class="stickyAvatar" role="presentation" aria-hidden="true">
      <span class="avatar letterAvatar {stickyColor}">
        <span>{stickyNick.charAt(0).toUpperCase()}</span>
      </span>
      <span class="sticky-name">{stickyNick}</span>
    </div>
  {/if}
</div>

{#if belowUnseenCount > 0}
  <ChatterBar position="below" count={belowUnseenCount} timestamp={belowUnseenTimestamp} mentions={belowUnseenHighlights} onClick={scrollToBottom} />
{/if}

<style>
  .messages-viewport {
    position: relative;
  }
  .messages {
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1;
  }
  .stickyAvatar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 28px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    background: var(--bg-secondary, #16181d);
    border-bottom: 1px solid var(--border-color, #2c2f35);
    z-index: 5;
    font-size: 13px;
  }
  .stickyAvatar .avatar {
    width: 20px;
    height: 20px;
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .sticky-name {
    color: var(--text-primary, #e0e0e0);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
