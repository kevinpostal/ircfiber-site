<script lang="ts">
  // IRCCloud-style flat server log for the `_server` buffer. Rows are
  // rendered in message order (no per-attempt cards); the connection
  // attempt grouping only feeds the phase rail and offsets. Visual spec:
  // site/docs/mockups/server-log-irccloud.html.
  import type { IRCMessage, Network } from '../types';
  import { buildServerLogRows, type ServerLogRow as Row } from '../lib/serverLogRows';
  import { getClearedAt } from '../stores/preferences.svelte';
  import DateChange from './DateChange.svelte';
  import ServerLogRow from './ServerLogRow.svelte';

  interface Props {
    messages: IRCMessage[];
    network: Network | null;
  }
  let { messages, network }: Props = $props();

  // Rebuilt only when the `_server` array itself is reassigned, the
  // cleared-at watermark moves, or the connected flag flips (the live
  // row depends on it). Other store mutations leave `messages` identity
  // untouched, so unrelated channel traffic never re-renders the log.
  const rows: Row[] = $derived.by(() => {
    const clearedAt = network?.networkId ? getClearedAt(network.networkId, '_server') : null;
    return buildServerLogRows(messages, network, clearedAt);
  });
</script>

<div class="serverLog" data-testid="server-log">
  {#if rows.length === 0}
    <div class="serverLog__empty">No connection history yet.</div>
  {:else}
    {#each rows as row (row.key)}
      {#if row.kind === 'date'}
        <DateChange date={row.date} />
      {:else}
        <ServerLogRow {row} />
      {/if}
    {/each}
  {/if}
</div>

<style>
  .serverLog {
    padding-bottom: 12px;
  }
  .serverLog__empty {
    padding: 24px 12px;
    color: var(--text-tertiary);
    font-size: 13px;
  }
</style>
