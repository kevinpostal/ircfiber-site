<script lang="ts">
  import { recoverFromStaleChunk, isStaleChunkError } from '../lib/staleChunk';

  interface Props {
    /** The rejection from the lazy import this stands in for. */
    error?: unknown;
  }
  let { error = undefined }: Props = $props();

  // A chunk from the previous build reloads itself once; getting here with
  // `true` means the reload is already under way and this only shows for
  // the instant before the document is replaced.
  const reloading = recoverFromStaleChunk(error);
  const stale = isStaleChunkError(error);
  const detail = $derived(error instanceof Error ? error.message : String(error ?? ''));
</script>

<div class="settings-page" role="region" aria-label="This part of the app could not be loaded">
  <div class="settings-header">
    <h2>{reloading ? 'Updating…' : 'Could not load this page'}</h2>
  </div>
  <div class="settings-scroll">
    <div class="chunk-error">
      {#if reloading}
        <p>IRC Fiber was updated while this tab was open. Reloading to catch up…</p>
      {:else if stale}
        <p>
          IRC Fiber was updated while this tab was open, and reloading did not pick up
          the new version. Your connections and history are unaffected.
        </p>
        <button class="settings-btn" onclick={() => location.reload()}>Reload again</button>
      {:else}
        <p>Something went wrong loading this part of the app. Your connections and history are unaffected.</p>
        <button class="settings-btn" onclick={() => location.reload()}>Reload</button>
      {/if}
      {#if detail}
        <p class="chunk-error__detail">{detail}</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .chunk-error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    max-width: 52ch;
    padding: 16px 0;
    color: var(--text-secondary);
    font-size: 14px;
    line-height: 1.5;
  }
  .chunk-error__detail {
    margin: 0;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .chunk-error p {
    margin: 0;
  }
</style>
