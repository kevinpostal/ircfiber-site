<script lang="ts">
  import type { IRCMessage, Network } from '../types';
  import { groupServerLog, type ServerLogAttempt } from '../lib/serverLogGroups';
  import { getClearedAt, serverlogHiddenMap } from '../stores/preferences.svelte';
  import { getServerLogCollapsedKey } from '../lib/serverLogGroups';
  import { ircState } from '../stores/ircStore.svelte';
  import ServerLogCard from './ServerLogCard.svelte';

  interface Props {
    messages: IRCMessage[];
    network: Network | null;
  }

  let { messages, network }: Props = $props();

  // Apply the clearedAt filter so the "Clear backlog" action hides old
  // connection-attempt cards. We filter at the ATTEMPT level (not message
  // level) so the latest (current) card keeps its full phase/welcome/MOTD
  // content even though its messages happened before clearedAt.
  const clearedAt = $derived.by((): number | null => {
    const { networkId, bufferName } = ircState.activeBuffer;
    if (!networkId || !bufferName) return null;
    return getClearedAt(networkId, bufferName);
  });

  // Group the flat message stream into connection attempts (ALL messages,
  // unfiltered — clearedAt filtering happens at the attempt level below).
  const grouped = $derived(groupServerLog(messages));
  // Filter: hide old attempts, keep the latest one always.
  const attempts = $derived.by(() => {
    if (!network?.networkId) return grouped;
    let result = grouped;
    // If clearedAt is set, filter out attempts whose start time <= clearedAt,
    // BUT always keep the latest attempt so the current connection card
    // retains its full phase/welcome/MOTD content (not just heartbeats).
    if (clearedAt != null && result.length > 0) {
      const lastIdx = result.length - 1;
      result = result.filter((a, i) => i === lastIdx || (a.start.t || 0) > clearedAt);
    }
    // Filter out any attempts the user has dismissed via the X button.
    result = result.filter((a) => {
      const key = getServerLogCollapsedKey(a, network.networkId);
      return !serverlogHiddenMap[key];
    });
    return result;
  });

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