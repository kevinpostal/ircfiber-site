<script lang="ts">
  import { noticeState, dismissAll } from '../stores/noticeOverlay.svelte';
  import { ircState, setActiveBuffer } from '../stores/ircStore.svelte';
  import { updateRoute } from '../lib/routing';
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import { autolinkHtml } from '../lib/autolinker';

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
      // Find network from the enclosing notice entry
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
    // Also handle outer bufferLink user/channel in head? Let default close? No
  }

  function handleNickClick(nick: string, networkId: string): void {
    // Open query / whois for the nick? For now switch to query buffer or just dismiss
    // If we have a query buffer for that nick, switch to it; otherwise trigger WHOIS via overlay? Keep simple: switch to query if exists
    const net = ircState.networks.find((n) => n.networkId === networkId);
    if (!net) return;
    // Try to find existing query buffer case-insensitive
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
        <div class="overlay_type_notice" data-idx={i}>
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
          <div class="overlay">{@html renderNotice(entry.text)}</div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  :global(.overlaycontainer.overlay_container_type_notice) {
    max-height: 80vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  :global(.overlaycontainer.overlay_container_type_notice .overlaycontents) {
    overflow-y: auto;
    max-height: calc(80vh - 32px);
  }
  :global(.overlay_type_notice + .overlay_type_notice) {
    border-top: 1px solid #2c2f35;
  }
  :global(.overlay_type_notice .overlayHead) {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  :global(.overlay_type_notice .overlayHead .notice-network) {
    color: #8b949e;
    font-weight: 400;
    font-size: 12px;
  }
  :global(.overlay_type_notice .overlay) {
    color: #d1d5db;
    font-size: 13px;
    line-height: 1.5;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  :global(.overlay_type_notice .overlay a.channelLink),
  :global(.overlay_type_notice .overlay a.urlLink) {
    color: #58a6ff;
    text-decoration: none;
  }
  :global(.overlay_type_notice .overlay a.channelLink:hover),
  :global(.overlay_type_notice .overlay a.urlLink:hover) {
    text-decoration: underline;
  }
  :global(.overlay_type_notice .overlay .bufferLink) {
    cursor: pointer;
  }
</style>
