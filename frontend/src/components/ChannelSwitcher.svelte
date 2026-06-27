<script lang="ts">
  import { fuzzyMatch } from '../lib/fuzzyMatch';
  import { ircState, setActiveBuffer, fetchArchiveNames } from '../stores/ircStore.svelte';
  import { updateRoute } from '../lib/routing';

  interface Props {
    onClose: () => void;
    scope?: 'all' | 'active';
  }
  let { onClose, scope = 'all' }: Props = $props();

  let query = $state('');
  let selectedIndex = $state(0);
  let inputEl: HTMLInputElement | null = $state(null);
  let archivedBuffers: Record<string, string[]> = $state({});

  // Load archived buffer names on mount (W3-T01a bulk endpoint)
  $effect(() => {
    fetchArchiveNames().then((result: Record<string, string[]>) => {
      archivedBuffers = result;
    }).catch(() => {
      // Silently fail — archive badges are non-critical
    });
  });

  // Auto-focus input on mount
  $effect(() => {
    if (inputEl) {
      inputEl.focus();
    }
  });

  interface BufferEntry {
    name: string;
    networkId: string;
    networkName: string;
    type: 'channel' | 'query' | 'server';
  }

  const buffers: BufferEntry[] = $derived.by(() => {
    const list: BufferEntry[] = [];
    for (const net of ircState.networks) {
      for (const buf of net.buffers) {
        if (buf.name === '_server') continue;
        if (scope === 'active' && buf.isJoined === false) continue;
        list.push({
          name: buf.name,
          networkId: net.networkId,
          networkName: net.name,
          type: buf.type,
        });
      }
    }
    return list;
  });

  const filteredBuffers: (BufferEntry & { score: number })[] = $derived.by(() => {
    if (!query) return buffers.map(b => ({ ...b, score: 0 }));
    const scored = buffers
      .map(b => ({ ...b, score: fuzzyMatch(query, b.name) }))
      .filter(b => b.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored;
  });

  // Reset selection when query changes
  $effect(() => {
    query; // track
    selectedIndex = 0;
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filteredBuffers.length > 0) {
        selectedIndex = Math.min(selectedIndex + 1, filteredBuffers.length - 1);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const buf = filteredBuffers[selectedIndex];
      if (buf) {
        setActiveBuffer(buf.networkId, buf.name);
        updateRoute(buf.networkId, buf.name);
        onClose();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  function isArchived(networkId: string, bufferName: string): boolean {
    return archivedBuffers[networkId]?.includes(bufferName) ?? false;
  }

  function select(buffer: BufferEntry & { score: number }): void {
    setActiveBuffer(buffer.networkId, buffer.name);
    updateRoute(buffer.networkId, buffer.name);
    onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="channel-switcher-overlay" role="presentation" onclick={onClose}>
  <div class="channel-switcher-dialog" role="dialog" aria-modal="true" aria-label="Quick switch channel"
       onclick={(e: MouseEvent) => e.stopPropagation()}>
    <input
      class="switcher-input"
      type="text"
      bind:this={inputEl}
      bind:value={query}
      placeholder="Quick switch..."
      aria-label="Quick switch"
    />
    <div class="switcher-results" role="listbox" aria-label="Buffers">
      {#each filteredBuffers as buffer, i (buffer.networkId + ':' + buffer.name)}
        <div
          class="switcher-result"
          class:selected={i === selectedIndex}
          role="option"
          aria-selected={i === selectedIndex}
          onclick={() => select(buffer)}
          onmouseenter={() => { selectedIndex = i; }}
        >
          <span class="buffer-name">{buffer.name}</span>
          <span class="server-badge">{buffer.networkName}</span>
          {#if isArchived(buffer.networkId, buffer.name)}
            <span class="archived-badge">archived</span>
          {/if}
        </div>
      {/each}
      {#if filteredBuffers.length === 0}
        <div class="switcher-empty">No matching buffers</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .channel-switcher-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
  }

  .channel-switcher-dialog {
    width: 100%;
    max-width: 480px;
    background: #2b2b2b;
    border: 1px solid #444;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .switcher-input {
    display: block;
    width: 100%;
    padding: 12px 16px;
    font-size: 14px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #222;
    color: #e6e6e6;
    border: none;
    border-bottom: 1px solid #444;
    outline: none;
    box-sizing: border-box;
  }

  .switcher-input::placeholder {
    color: #888;
  }

  .switcher-results {
    max-height: 360px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .switcher-result {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    cursor: pointer;
    font-size: 13px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #e6e6e6;
    user-select: none;
  }

  .switcher-result.selected {
    background: #3a6fd8;
    color: #fff;
  }

  .switcher-result .buffer-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .switcher-result .server-badge {
    flex-shrink: 0;
    padding: 1px 6px;
    background: #444;
    border-radius: 3px;
    font-size: 11px;
    color: #aaa;
  }

  .switcher-result.selected .server-badge {
    background: #2a5abf;
    color: #c0d0ff;
  }

  .switcher-result .archived-badge {
    flex-shrink: 0;
    padding: 1px 6px;
    background: transparent;
    border: 1px solid #666;
    border-radius: 3px;
    font-size: 10px;
    color: #888;
  }

  .switcher-result.selected .archived-badge {
    border-color: #8ab0ff;
    color: #c0d0ff;
  }

  .switcher-empty {
    padding: 16px;
    text-align: center;
    font-size: 13px;
    color: #888;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
</style>
