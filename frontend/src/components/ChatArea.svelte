<script lang="ts">
  import MessageList from './MessageList.svelte';
  import InputArea from './InputArea.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { ircState, prependMessages } from '../stores/ircStore.svelte';
  import { loadHistoryWithMeta } from '../stores/api';
  import type { Member } from '../types';

  interface Props {
    onNickClick?: (nick: string, event: MouseEvent, member?: Member | null) => void;
  }
  let { onNickClick }: Props = $props();

  // IRCCloud-style: when the oldest message has a UUID msgid that can't
  // be looked up in MongoDB, we pin the cursor to the API response's
  // earliest_ts so each call jumps to STRICTLY older messages instead
  // of getting stuck at the same phantom's timestamp.
  let phantomCursorTs: number | null = null;

  async function handleLoadMore(): Promise<boolean> {
    if (!ircState.activeBuffer.networkId || !ircState.activeBuffer.bufferName) {
      console.log('[handleLoadMore] No active buffer');
      return false;
    }
    const key = `${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`;
    const existing = ircState.messages[key] ?? [];
    console.log('[handleLoadMore v2] Existing messages:', existing.length);

    if (existing.length === 0) {
      console.log('[handleLoadMore] No existing messages');
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

    console.log('[handleLoadMore v2] Phantom check:', { isPhantom, eid: !!first?.eid, text: first?.text != null, nick: first?.nick != null, isUuid: isUuidMsgid(first), cursorTs: oldestTs });

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
      console.log('[handleLoadMore] Loaded', older.length, 'older messages');
      console.log('[handleLoadMore] Backlog size (total):', result.backlog_size);
      console.log('[handleLoadMore] Next cursor (earliest_eid):', result.earliest_eid, '(earliest_msgid:', result.earliest_msgid, 'earliest_ts:', result.earliest_ts, ')');
      if (older.length > 0) {
        console.log('[handleLoadMore] First loaded message:', { eid: older[0].eid, msgid: older[0].msgid, ts: older[0].t, text: older[0].text?.substring(0, 50) });
        console.log('[handleLoadMore] Last loaded message:', { eid: older[older.length - 1].eid, msgid: older[older.length - 1].msgid, ts: older[older.length - 1].t, text: older[older.length - 1].text?.substring(0, 50) });
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
          console.log('[handleLoadMore] Duplicates — pinning cursor to earliest_ts:', phantomCursorTs);
          // Return true so LoadMore doesn't count this as a failed load
          // (the cursor IS advancing, just not via new messages yet).
          return true;
        }
        console.log('[handleLoadMore] All', older.length, 'messages were duplicates (already loaded)');
      } else {
        console.log('[handleLoadMore] No older messages returned from API');
      }
    } catch (e) {
      console.error('[handleLoadMore] Failed to load more history:', e);
    }
    return false;
  }
</script>

<div class="chat-body">
  <article class="messages-area" role="log" aria-label="Chat messages" aria-live="polite" aria-atomic="false">
    <MessageList {onNickClick} onLoadMore={handleLoadMore} />
  </article>
  <ConnectionStatus />
  <InputArea />
</div>
