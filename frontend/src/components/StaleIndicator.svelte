<script lang="ts">
  import { isNetworkStale } from '../stores/ircStore.svelte';

  interface Props {
    lastSeenAt: number | null | undefined;
    thresholdMs?: number;
  }

  let { lastSeenAt, thresholdMs }: Props = $props();
</script>

{#if isNetworkStale({ lastSeenAt }, thresholdMs)}
  <span class="stale-pill" title="No activity in a while — the connection may be idle">stale</span>
{/if}

<style>
  .stale-pill {
    color: var(--text-muted, #888);
    font-size: 0.7em;
    margin-left: 0.4em;
    opacity: 0.8;
    font-weight: normal;
    letter-spacing: 0.02em;
  }
</style>