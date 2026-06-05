<script lang="ts">
  import { ircState } from '../stores/ircStore.svelte';
  import { archivedMap, pinnedMap } from '../stores/preferences.svelte';
  import { stripHash } from '../lib/utils';
  import type { Buffer } from '../types';
  import AccountMenu from './AccountMenu.svelte';

  interface Props {
    onSwitchBuffer: (networkId: string, bufferName: string) => void;
    onAddNetwork: () => void;
  }
  let { onSwitchBuffer, onAddNetwork }: Props = $props();

  function toggleNetwork(networkId: string): void {
    const net = ircState.networks.find(n => n.networkId === networkId);
    if (net) net.collapsed = !net.collapsed;
  }

  function handleBufferContextMenu(e: MouseEvent, networkId: string, buf: Buffer): void {
    e.preventDefault();
    const key = `${networkId}:${buf.name}`;
    const isPinned = pinnedMap[key] === true;
    const actions: { label: string; handler: () => void }[] = [];
    if (isPinned) {
      actions.push({ label: 'Unpin', handler: () => { delete pinnedMap[key]; buf.isPinned = false; ircState.contextMenu.visible = false; } });
    } else {
      actions.push({ label: 'Pin to top', handler: () => { pinnedMap[key] = true; buf.isPinned = true; ircState.contextMenu.visible = false; } });
    }
    if (buf.name !== '_server') {
      actions.push({ label: 'Archive', handler: () => { archivedMap[key] = true; ircState.contextMenu.visible = false; } });
    }
    ircState.contextMenu.visible = true;
    ircState.contextMenu.x = e.clientX;
    ircState.contextMenu.y = e.clientY;
    ircState.contextMenu.actions = actions;
  }

  const pinned = $derived(
    ircState.networks.flatMap(net =>
      net.buffers
        .filter(b => b.name !== '_server' && pinnedMap[`${net.networkId}:${b.name}`] === true && b.isJoined !== false && !archivedMap[`${net.networkId}:${b.name}`])
        .map(b => ({ networkId: net.networkId, buffer: b, network: net }))
    )
  );
</script>

<div class="network-list" id="networks">
  {#if pinned.length > 0}
    <ul class="bufferList pinnedBuffers">
      <h2><i class="fa fa-thumb-tack"></i>Pinned</h2>
      <ul class="pinnedBufferList">
        {#each pinned as p (p.networkId + ':' + p.buffer.name)}
          {@const isActive = p.networkId === ircState.activeBuffer.networkId && p.buffer.name === ircState.activeBuffer.bufferName}
          <li role="presentation"
              class="buffer channel buffer-item"
              class:active={isActive}
              class:unread={p.buffer.unreadCount > 0}
              class:highlight={p.buffer.highlight}
              onclick={() => onSwitchBuffer(p.networkId, p.buffer.name)}
              oncontextmenu={(e) => handleBufferContextMenu(e, p.networkId, p.buffer)}>
            <span class="buffer" role="tab" tabindex="0">
              <span class="label buffer-name">{(p.buffer.type === 'query' ? '' : '#') + stripHash(p.buffer.name)}</span>
              {#if p.buffer.unreadCount > 0}
                <span class="unread buffer-unread">{p.buffer.unreadCount}</span>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    </ul>
  {/if}

  {#each ircState.networks as net (net.networkId)}
    {@const isActiveNet = ircState.activeBuffer.networkId === net.networkId && ircState.activeBuffer.bufferName === '_server'}
    {@const totalNetUnread = net.buffers.reduce((sum, b) => sum + (b.unreadCount || 0), 0)}
    <div class="network connection" class:connected={net.connected} class:disconnected={!net.connected}>
      <div class="network-header buffer"
          class:active={isActiveNet}
          role="button"
          tabindex="0"
          onclick={() => onSwitchBuffer(net.networkId, '_server')}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSwitchBuffer(net.networkId, '_server'); } }}>
        <span class="buffer" role="tab">
          {#if net.connected}
            <svg class="network-shield" viewBox="0 0 14 16" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M7 1.5L12 3.5v4.5c0 2.5-2 5-5 6.5-3-1.5-5-4-5-6.5V3.5l5-2z"/>
              <path d="M7 1.5v12.5" stroke="rgba(0,0,0,0.22)" stroke-width="0.9" fill="none"/>
            </svg>
          {/if}
          <span class="label">{net.name}</span>
          {#if net.collapsed && totalNetUnread > 0}
            <span class="unread buffer-unread">{totalNetUnread}</span>
          {/if}
        </span>
      </div>
      {#if !net.collapsed}
        <ul class="buffers channels network-buffers">
          {#each net.buffers.filter(b => b.name !== '_server' && b.isJoined !== false && !pinnedMap[`${net.networkId}:${b.name}`] && !archivedMap[`${net.networkId}:${b.name}`]) as buf (buf.name)}
            {@const isActive = net.networkId === ircState.activeBuffer.networkId && buf.name === ircState.activeBuffer.bufferName}
            <li class="buffer channel buffer-item"
                class:active={isActive}
                class:unread={buf.unreadCount > 0}
                class:highlight={buf.highlight}
                onclick={() => onSwitchBuffer(net.networkId, buf.name)}
                oncontextmenu={(e) => handleBufferContextMenu(e, net.networkId, buf)}
                role="presentation">
              <span class="buffer" role="tab" tabindex="0">
                <span class="label buffer-name">{(buf.type === 'query' ? '' : '#') + stripHash(buf.name)}</span>
                {#if buf.unreadCount > 0}
                  <span class="unread buffer-unread">{buf.unreadCount}</span>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
        {@const archived = net.buffers.filter(b => b.name !== '_server' && archivedMap[`${net.networkId}:${b.name}`])}
        {#if archived.length > 0}
          <div class="sidebar-section-header archived-header">Archived</div>
          <ul class="buffers archived-channels">
            {#each archived as buf (buf.name)}
              {@const isActive = net.networkId === ircState.activeBuffer.networkId && buf.name === ircState.activeBuffer.bufferName}
              <li class="buffer channel buffer-item"
                  class:active={isActive}
                  onclick={() => onSwitchBuffer(net.networkId, buf.name)}
                  role="presentation">
                <span class="buffer" role="tab" tabindex="0">
                  <span class="label buffer-name">{(buf.type === 'query' ? '' : '#') + stripHash(buf.name)}</span>
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  {/each}
</div>
<div class="addNetworkButtonContainer">
  <button class="addNetworkButton" id="add-network-btn" type="button" onclick={onAddNetwork}>
    <i class="fa fa-plus-circle"></i>
    Add a network
  </button>
</div>
<AccountMenu {onAddNetwork} />
