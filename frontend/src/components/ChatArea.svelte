<script lang="ts">
  import MessageList from './MessageList.svelte';
  import InputArea from './InputArea.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { ircState, prependMessages } from '../stores/ircStore.svelte';
  import { loadHistoryWithMeta } from '../stores/api';
  import type { IRCMessage, Member } from '../types';

  interface Props {
    onNickClick?: (nick: string, event: MouseEvent, member?: Member | null) => void;
  }
  let { onNickClick }: Props = $props();

  // Buffer switch crossfade: briefly flash the messages area to 40% opacity
  // when switching channels so the transition feels smooth rather than a
  // jarring instant replace.
  let switching = $state(false);
  let lastBufferKey = $state('');
  const bufferKey = $derived(`${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`);
  $effect(() => {
    if (lastBufferKey && bufferKey !== lastBufferKey) {
      switching = true;
      setTimeout(() => { switching = false; }, 50);
    }
    lastBufferKey = bufferKey;
    // Reset entrance tracking on buffer switch — stale keys from the
    // previous buffer would flash the animation on the new buffer.
    switching = false;
  });

  // IRCCloud-style: when the oldest message has a UUID msgid that can't
  // be looked up in MongoDB, we pin the cursor to the API response's
  // earliest_ts so each call jumps to STRICTLY older messages instead
  // of getting stuck at the same phantom's timestamp.
  // Per-buffer map — global caused stalls when switching channels (bug 8, ChatInfinite.cursorStrictlyAdvances).
  const phantomCursors = new Map<string, number>();

  async function handleLoadMore(): Promise<boolean> {
    if (!ircState.activeBuffer.networkId || !ircState.activeBuffer.bufferName) {
      return false;
    }
    const key = `${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`;
    const existing = ircState.messages[key] ?? [];

    if (existing.length === 0) {
      return false;
    }

    // IRCCloud-style: eid is the primary cursor, but the cursor message
    // must be the OLDEST BY TIMESTAMP, not the array head. The store is
    // sorted by eid, and eids are not guaranteed monotonic with time: an
    // engine eid-counter reset leaves low-eid messages with recent
    // timestamps at the head (SuperNets #superbowl had eid 1961 @15min ago
    // sorted before eid 1991 @1.6h ago). Cursing on the head then makes
    // the backend return messages that are already visible; they all dedup,
    // nothing prepends, the DOM never changes, and the top sentinel never
    // re-fires — history loading silently stops with older chat still
    // available. The min-t message is the true pagination boundary.
    let first = existing[0];
    for (const m of existing) {
      if ((m.t ?? 0) < (first?.t ?? 0)) first = m;
    }
    let oldestEid = first?.eid;
    let oldestMsgid = oldestEid ? undefined : first?.msgid;
    let oldestTs = first?.t;

    function isUuidMsgid(m: IRCMessage | undefined): boolean {
      return !!m?.msgid?.match?.(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }

    // Detect optimistic outgoing messages (have a label but no eid).
    // These are user-created messages that haven't been acknowledged by
    // the server yet. When ALL messages in the buffer are optimistic,
    // there's no real backlog to load — skip the API call.
    const allOptimistic = existing.every(m => !m.eid && m.label);

    // UUID msgids (from legacy 'i' field) don't exist as msgid in
    // MongoDB — the backend cursor lookup fails and falls back to
    // the same timestamp forever. We detect them and advance the
    // cursor by pinning to the API response's earliest_ts so each
    // call jumps strictly past messages already in the array.
    const isPhantom = !first?.eid && (!first?.text && !first?.nick || isUuidMsgid(first));
    const pinned = phantomCursors.get(key) ?? null;
    if (isPhantom) {
      oldestMsgid = undefined;
      if (pinned !== null && pinned > 0) {
        oldestTs = pinned;
      }
    } else {
      phantomCursors.delete(key);
    }

    // No cursor and all messages are optimistic (not yet confirmed by the
    // server) — there's no real backlog to load.  Skip the API call.
    if (allOptimistic && !oldestEid) {
      return false;
    }

    // When the first message has no eid and no real msgid (no cursor at all),
    // there's nothing to page against — the backend would return 0 and the
    // LoadMore component would retry 5 times for nothing.
    if (!oldestEid && !oldestMsgid && !oldestTs) return false;

    if (!oldestEid && !oldestMsgid && !oldestTs) return false;

    try {
      const result = await loadHistoryWithMeta(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName, {
        beforeid: oldestEid ? String(oldestEid) : (oldestMsgid || undefined),
        beforeMsgid: oldestMsgid || undefined,
        before: oldestTs,
        count: 150,
        ...(oldestMsgid ? { fetchFromUpstream: true, fetchCommand: 'BEFORE' as const, fetchRef: oldestMsgid } : {}),
      });
      const older = result.messages;
      // IRCCloud has no retry loop: a fetch that adds nothing means the
      // backlog is exhausted and the loadMore row goes away. The phantom
      // cursor still advances so a later manual "Load more backlog…" click
      // pages past a UUID-msgid head instead of re-fetching the same slice.
      if (isPhantom && result.earliest_ts > 0) phantomCursors.set(key, result.earliest_ts);
      if (older.length === 0) return false;
      const beforeLen = (ircState.messages[key] ?? []).length;
      prependMessages(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName, older);
      const afterLen = (ircState.messages[key] ?? []).length;
      return afterLen > beforeLen;
    } catch (e) {
      console.error('[handleLoadMore] Failed to load more history:', e);
    }
    return false;
  }
</script>

<div class="chat-body">
  <article class="messages-area" class:switching role="log" aria-label="Chat messages" aria-live="polite" aria-atomic="false">
    <MessageList {onNickClick} onLoadMore={handleLoadMore} />
  </article>
  <ConnectionStatus />
  <InputArea />
</div>
