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
  let phantomCursorTs: number | null = null;

  async function handleLoadMore(): Promise<boolean> {
    if (!ircState.activeBuffer.networkId || !ircState.activeBuffer.bufferName) {
      return false;
    }
    const key = `${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`;
    const existing = ircState.messages[key] ?? [];

    if (existing.length === 0) {
      return false;
    }

    // IRCCloud-style: eid is the primary cursor. Take the oldest
    // message by index (oldest-first) and use its eid. If the oldest
    // lacks an eid (legacy), fall back to msgid or timestamp.
    const first = existing[0];
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
    if (isPhantom) {
      oldestMsgid = undefined;
      if (phantomCursorTs !== null && phantomCursorTs > 0) {
        oldestTs = phantomCursorTs;
      }
    } else {
      phantomCursorTs = null;
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
      // Smart check: only show Load more if older batch contains real chat
      // (PRIVMSG/NOTICE). A channel like #emptytest153869 with 1 JOIN + 2 chats
      // and 8 older JOINs in DB would otherwise keep Load more visible
      // forever, even though there's no older chat to load. For just-joined
      // channels with no history, this hides Load more without flashing Fetching.
      const hasChat = older.some(m => (m.command === 'PRIVMSG' || m.command === 'NOTICE') && typeof m.text === 'string' && m.text.trim() !== '');
      if (older.length > 0 && !hasChat) {
        // No meaningful chat in older — treat as fully loaded, hide Load more
        // Don't prepend bare JOINs; they'd just add noise to the timeline
        if (isPhantom && result.earliest_ts > 0) {
          phantomCursorTs = result.earliest_ts;
        }
        return false;
      }
      if (older.length > 0) {
        const beforeLen = (ircState.messages[key] ?? []).length;
        prependMessages(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName, older);
        const afterLen = (ircState.messages[key] ?? []).length;
        if (afterLen > beforeLen) {
          // Success — new messages were added. Advance the pinning
          // cursor to the oldest message in the API response so the
          // next call jumps strictly past already-loaded messages.
          if (isPhantom && result.earliest_ts > 0) {
            phantomCursorTs = result.earliest_ts;
          }
          return true;
        }
        // All 150 were duplicates — cursor is stuck. Jump the pinning
        // cursor to the API response's earliest_ts so the next call
        // requests messages STRICTLY older than anything we've seen.
        if (isPhantom && result.earliest_ts > 0) {
          phantomCursorTs = result.earliest_ts;
          // Return true so LoadMore doesn't count this as a failed load
          // (the cursor IS advancing, just not via new messages yet).
          return true;
        }
      } else {
      }
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
