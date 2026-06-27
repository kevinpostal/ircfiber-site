<script lang="ts">
  import type { IRCMessage, Network } from '../types';
  import { groupServerLog } from '../lib/serverLogGroups';
  import { getClearedAt } from '../stores/preferences.svelte';
  import { ircState } from '../stores/ircStore.svelte';
  import ServerLogCard from './ServerLogCard.svelte';

  interface Props {
    messages: IRCMessage[];
    network: Network | null;
  }

  let { messages, network }: Props = $props();

  // Apply the clearedAt filter so the "Clear backlog" action hides old
  // connection-attempt cards. Mirrors MessageList.svelte:124-126.
  // Without this, _server buffers skip the channel-buffer clearedAt filter
  // path entirely, so the cards stay visible after clear.
  const clearedAt = $derived.by((): number | null => {
    const { networkId, bufferName } = ircState.activeBuffer;
    if (!networkId || !bufferName) return null;
    return getClearedAt(networkId, bufferName);
  });
  const visibleMessages = $derived(
    clearedAt != null ? messages.filter((m) => (m.t || 0) > clearedAt) : messages
  );

  // Group the flat message stream into connection attempts.
  // `attempts` is recomputed reactively when `messages` changes.
  const attempts = $derived(groupServerLog(visibleMessages));

  // Map each message index in `messages` to the attempt it belongs to
  // (1-based, used for stable keys when Svelte diffs the each block).
  const attemptCount = $derived(attempts.length);
  const lastAttemptIndex = $derived(attemptCount - 1);

  // If the buffer is empty (no stored phase events survived page refresh)
  // but the network has an actual connection state, synthesize a card so
  // the UI always reflects reality. This is common because phase events
  // (queued, connecting, welcome) are transient -- they flow through the
  // WebSocket in real-time but aren't persisted in scrollback.
  const syntheticAttempt = $derived.by<ServerLogAttempt | null>(() => {
    if (attempts.length > 0) return null;
    if (!network) return null;
    if (network.connectionState === 'connected') {
      return {
        start: { command: 'NOTICE', text: 'Network is connected', t: Date.now(), id: 'syn-connected' } as any,
        end: null,
        phases: [],
        motd: [],
        welcome: [],
        cap: [],
        numeric: [],
        notices: [],
        status: 'success' as const,
      };
    }
    if (network.connectionState === 'connecting') {
      return {
        start: { command: 'NOTICE', text: 'Connecting...', t: Date.now(), id: 'syn-connecting' } as any,
        end: null,
        phases: [],
        motd: [],
        welcome: [],
        cap: [],
        numeric: [],
        notices: [],
        status: 'pending' as const,
      };
    }
    return null; // disconnected with no history -- show "No connection history yet."
  });

  // Date separators are emitted by MessageList, so we just render cards here.
</script>

<div class="serverLogTimeline" data-testid="server-log-timeline">
  {#if attempts.length === 0 && !syntheticAttempt}
    <div class="serverLogTimeline__empty">No connection history yet.</div>
  {:else}
    {#each attempts as attempt, i (i)}
      <ServerLogCard {attempt} {network} isLatest={i === lastAttemptIndex} />
    {/each}
    {#if syntheticAttempt}
      <ServerLogCard attempt={syntheticAttempt} {network} isLatest={true} />
    {/if}
  {/if}
</div>

<style>
  .serverLogTimeline {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 0;
  }
  .serverLogTimeline__empty {
    color: var(--muted, #8b949e);
    padding: 24px;
    text-align: center;
    font-size: 13px;
  }
</style>