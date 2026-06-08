<script lang="ts">
  import MessageList from './MessageList.svelte';
  import InputArea from './InputArea.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { ircState, prependMessages } from '../stores/ircStore.svelte';
  import { loadHistory } from '../stores/api';
  import type { Member } from '../types';

  interface Props {
    onNickClick?: (nick: string, event: MouseEvent, member?: Member | null) => void;
  }
  let { onNickClick }: Props = $props();

  async function handleLoadMore(): Promise<boolean> {
    if (!ircState.activeBuffer.networkId || !ircState.activeBuffer.bufferName) return false;
    const key = `${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`;
    const existing = ircState.messages[key] ?? [];
    if (existing.length === 0) return false;

    const oldestMsgid = existing[0]?.msgid;
    const oldestTs = existing[0]?.t;

    if (!oldestMsgid && !oldestTs) return false;

    try {
      let older: Awaited<ReturnType<typeof loadHistory>>;
      if (oldestMsgid) {
        older = await loadHistory(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName, {
          beforeMsgid: oldestMsgid,
          count: 100,
          fetchFromUpstream: true,
          fetchCommand: 'BEFORE',
          fetchRef: oldestMsgid,
        });
      } else {
        older = await loadHistory(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName, {
          before: oldestTs,
          count: 100,
        });
      }

      if (older.length > 0) {
        prependMessages(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName, older);
        return true;
      }
    } catch (e) {
      console.error('Failed to load more history:', e);
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
