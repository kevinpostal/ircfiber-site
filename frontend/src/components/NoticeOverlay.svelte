<script lang="ts">
  import { noticeState, dismissAll, addNotice } from '../stores/noticeOverlay.svelte';
  import { ircState, setActiveBuffer } from '../stores/ircStore.svelte';
  import { updateRoute } from '../lib/routing';
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import { autolinkHtml } from '../lib/autolinker';

  // E2E hook: Playwright can call window.__fiberAddNotice({ nick, networkId, networkName, text, t })
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__fiberAddNotice = addNotice;
    (window as unknown as Record<string, unknown>).__fiberDismissNotice = dismissAll;
  }

  function renderNotice(text: string): string {
    return autolinkHtml(parseIrcFormatting(text || ''));
  }

  function handleOverlayClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const chanLink = target.closest('a.channelLink') as HTMLAnchorElement | null;
    if (chanLink) {
      e.preventDefault();
      const chan = chanLink.getAttribute('data-channel') || chanLink.textContent || '';
      if (!chan) return;
      const noticeEl = target.closest('.overlay_type_notice') as HTMLElement | null;
      const idxStr = noticeEl?.getAttribute('data-idx');
      const idx = idxStr !== null ? parseInt(idxStr, 10) : -1;
      const entry = idx >= 0 ? noticeState.entries[idx] : null;
      const nid = entry?.networkId || ircState.activeBuffer.networkId || ircState.networks[0]?.networkId;
      if (nid && chan) {
        setActiveBuffer(nid, chan);
        updateRoute(nid, chan);
        dismissAll();
      }
      return;
    }
  }

  function handleNickClick(nick: string, networkId: string): void {
    const net = ircState.networks.find((n) => n.networkId === networkId);
    if (!net) return;
    const existing = net.buffers.find((b) => b.name.toLowerCase() === nick.toLowerCase());
    if (existing) {
      setActiveBuffer(networkId, existing.name);
      updateRoute(networkId, existing.name);
      dismissAll();
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      dismissAll();
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

{#if noticeState.entries.length > 0}
  <div class="overlaycontainer overlay_container_type_notice overlay_container_head" style="display: block;" role="dialog" aria-label="Notices">
    <button type="button" class="close" onclick={dismissAll} aria-label="Close notices"><span>Close</span></button>
    <div class="overlaycontents" onclick={handleOverlayClick} role="presentation">
      {#each noticeState.entries as entry, i (entry.id)}
        {@const prev = i > 0 ? noticeState.entries[i - 1] : null}
        {@const showHead = !prev || prev.nick.toLowerCase() !== entry.nick.toLowerCase() || prev.networkId !== entry.networkId}
        <div class="overlay_type_notice" data-idx={i}>
          {#if showHead}
            <div class="overlayHead">
              Notice:
              <span
                role="button"
                tabindex="0"
                aria-controls="memberContextMenu"
                aria-haspopup="true"
                class="buffer bufferLink user link"
                title={entry.nick}
                data-name={entry.nick}
                onclick={() => handleNickClick(entry.nick, entry.networkId)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNickClick(entry.nick, entry.networkId); } }}
              >{entry.nick}</span>
              <span class="notice-network"> ({entry.networkName})</span>
            </div>
          {/if}
          <div class="overlay">{@html renderNotice(entry.text)}</div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* Layout lives in _overlays.scss (.overlaycontainer.overlay_container_type_notice) */
  :global(.overlay_type_notice .overlay .bufferLink) {
    cursor: pointer;
  }
</style>
