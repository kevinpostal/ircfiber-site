<script lang="ts">
  import { ircState } from '../stores/ircStore.svelte';
  import { getClearedAt } from '../stores/preferences.svelte';
  import { preprocessMessages } from '../lib/messageBuilder';
  import MessageRow from './MessageRow.svelte';
  import DateChange from './DateChange.svelte';
  import SeenDivider from './SeenDivider.svelte';
  import LoadMore from './LoadMore.svelte';
  import ChatterBar from './ChatterBar.svelte';
  import { isSkippedCommand, getMsgDate } from '../lib/utils';
  import type { IRCMessage } from '../types';

  interface Props {
    onNickClick?: (nick: string, event: MouseEvent) => void;
    onLoadMore?: () => Promise<boolean>;
  }
  let { onNickClick, onLoadMore }: Props = $props();

  let container: HTMLDivElement;
  let shouldAutoScroll = $state(true);
  let aboveUnseenCount = $state(0);
  let belowUnseenCount = $state(0);

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
    const nick = msg.nick || '';
    const prevNick = prev.nick || '';
    if (!nick || !prevNick || nick !== prevNick) return false;
    const msgTime = msg.t || 0;
    const prevTime = prev.t || 0;
    return msgTime > 0 && prevTime > 0 && (msgTime - prevTime) <= 300000;
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
  }

  function updateChatterCounts(): void {
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const rows = container.querySelectorAll('.row.messageRow');
    let above = 0, below = 0;
    for (const row of Array.from(rows)) {
      const rect = (row as HTMLElement).getBoundingClientRect();
      if (rect.bottom < containerRect.top) above++;
      else if (rect.top > containerRect.bottom) below++;
    }
    aboveUnseenCount = above;
    belowUnseenCount = below;
  }

  function scrollToTop(): void {
    container?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function scrollToBottom(): void {
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }
</script>

{#if aboveUnseenCount > 0}
  <ChatterBar position="above" count={aboveUnseenCount} onClick={scrollToTop} />
{/if}

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

{#if belowUnseenCount > 0}
  <ChatterBar position="below" count={belowUnseenCount} onClick={scrollToBottom} />
{/if}
