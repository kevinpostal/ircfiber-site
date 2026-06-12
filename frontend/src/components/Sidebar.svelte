<script lang="ts">
  import { ircState } from '../stores/ircStore.svelte';
  import { archivedMap, pinnedMap, hiddenChannelsMap } from '../stores/preferences.svelte';
  import { stripHash } from '../lib/utils';
  import type { Buffer } from '../types';
  import AccountMenu from './AccountMenu.svelte';

  interface Props {
    onSwitchBuffer: (networkId: string, bufferName: string) => void;
    onAddNetwork: () => void;
    onNetworkOptions: (networkId: string, e: MouseEvent) => void;
    onJoinChannel: (networkId: string) => void;
  }
  let { onSwitchBuffer, onAddNetwork, onNetworkOptions, onJoinChannel }: Props = $props();

  function toggleNetwork(networkId: string): void {
    const net = ircState.networks.find(n => n.networkId === networkId);
    if (net) net.collapsed = !net.collapsed;
  }

  const pinned = $derived(
    ircState.networks.flatMap(net =>
      net.buffers
        .filter(b => b.name !== '_server' && pinnedMap[`${net.networkId}:${b.name}`] === true && !archivedMap[`${net.networkId}:${b.name}`] && !hiddenChannelsMap[`${net.networkId}:${b.name}`])
        .map(b => ({ networkId: net.networkId, buffer: b, network: net }))
    )
  );
</script>

{#if ircState.networks.length === 0}
<div class="addNetworkButtonContainer">
  <button class="addNetworkButton addNetworkButton--selected" id="add-network-btn" type="button" onclick={onAddNetwork}>
    <i class="fa fa-plus-circle"></i>
    Add a network
  </button>
</div>
{/if}

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
              onclick={() => onSwitchBuffer(p.networkId, p.buffer.name)}>
            <span class="buffer" role="tab" tabindex="0">
              <span class="label buffer-name">{(p.buffer.type === 'query' ? '' : '#') + stripHash(p.buffer.name)}</span>
              {#if p.buffer.unreadCount > 0}
                <span class="unread buffer-unread">{p.buffer.unreadCount}</span>
              {:else if (p.buffer.highlightCount ?? 0) > 0}
                <span class="unread buffer-unread">{p.buffer.highlightCount}</span>
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
    {@const totalNetHighlights = net.buffers.reduce((sum, b) => sum + (b.highlightCount || 0), 0)}
    <div class="network connection" class:connected={net.connected} class:disconnected={!net.connected}>
      <div class="network-header buffer"
          class:active={isActiveNet}
          class:unread={totalNetUnread > 0}
          role="button"
          tabindex="0"
          onclick={() => onSwitchBuffer(net.networkId, '_server')}
          ondblclick={() => { if (net.collapsed) net.collapsed = false; }}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSwitchBuffer(net.networkId, '_server'); } }}>
        <span class="buffer" role="tab">
          {#if net.connected}
            <i class="fa fa-shield network-shield" title="Secure connection" aria-hidden="true"></i>
          {:else}
            <i class="fa fa-globe network-shield" aria-hidden="true" style="opacity:0.5"></i>
          {/if}
          <span class="label">{net.name}</span>
          {#if totalNetHighlights > 0}
            <span class="unread buffer-unread">{totalNetHighlights}</span>
          {/if}
        </span>
        <span class="collapseToggle">
          <button type="button" aria-expanded={!net.collapsed}
                  onclick={(e) => { e.stopPropagation(); net.collapsed = !net.collapsed; }}>
            <i class="fa fa-{net.collapsed ? 'plus-square-o' : 'minus-square-o'}" aria-hidden="true"></i>
          </button>
        </span>
        <button class="bufferOptions fa fa-cog" type="button"
                title="Options" aria-label="Options"
                aria-expanded="false" aria-haspopup="true"
                onclick={(e) => { e.stopPropagation(); onNetworkOptions(net.networkId, e); }}></button>
      </div>
      {#if !net.collapsed}
        <ul class="buffers channels network-buffers">
          {#each net.buffers.filter(b => b.name !== '_server' && b.isJoined !== false && !pinnedMap[`${net.networkId}:${b.name}`] && !archivedMap[`${net.networkId}:${b.name}`] && !hiddenChannelsMap[`${net.networkId}:${b.name}`]) as buf (net.networkId + ':' + buf.name)}
            {@const isActive = net.networkId === ircState.activeBuffer.networkId && buf.name === ircState.activeBuffer.bufferName}
            <li class="buffer channel buffer-item"
                class:active={isActive}
                class:unread={buf.unreadCount > 0}
                class:highlight={buf.highlight}
                class:secret={buf.modeFlags?.secret}
                class:private={buf.modeFlags?.private}
                class:moderated={buf.modeFlags?.moderated}
                class:inviteOnly={buf.modeFlags?.inviteOnly}
                class:password={buf.modeFlags?.password}
                onclick={() => onSwitchBuffer(net.networkId, buf.name)}
                role="presentation">
              <span class="buffer" role="tab" tabindex="0">
                <span class="label buffer-name">{(buf.type === 'query' ? '' : '#') + stripHash(buf.name)}</span>
                {#if buf.unreadCount > 0}
                  <span class="unread buffer-unread">{buf.unreadCount}</span>
                {:else if (buf.highlightCount ?? 0) > 0}
                  <span class="unread buffer-unread">{buf.highlightCount}</span>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
        {@const inactive = net.buffers.filter(b => b.name !== '_server' && b.isJoined === false && !pinnedMap[`${net.networkId}:${b.name}`] && !archivedMap[`${net.networkId}:${b.name}`] && !hiddenChannelsMap[`${net.networkId}:${b.name}`])}
        {#if inactive.length > 0}
          <div class="sidebar-section-header inactive-header">Inactive</div>
          <ul class="buffers inactive-channels">
            {#each inactive as buf (net.networkId + ':' + buf.name)}
              {@const isActive = net.networkId === ircState.activeBuffer.networkId && buf.name === ircState.activeBuffer.bufferName}
              <li class="buffer channel buffer-item inactive"
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
        {@const archived = Object.keys(archivedMap)
          .filter(key => key.startsWith(`${net.networkId}:`) && archivedMap[key] && !hiddenChannelsMap[key])
          .map(key => key.slice(net.networkId.length + 1))}
        {#if archived.length > 0}
          <p class="archiveToggle">
            <button type="button"
                    aria-expanded={!(net.archivesCollapsed ?? true)}
                    onclick={() => { net.archivesCollapsed = !(net.archivesCollapsed ?? true); }}>
              Archives
            </button>
          </p>
          {#if !(net.archivesCollapsed ?? true)}
            <ul class="buffers archived-channels">
              {#each archived as bufName (net.networkId + ':' + bufName)}
                {@const isActive = net.networkId === ircState.activeBuffer.networkId && bufName === ircState.activeBuffer.bufferName}
                <li class="buffer channel buffer-item"
                    class:active={isActive}
                    onclick={() => onSwitchBuffer(net.networkId, bufName)}
                    role="presentation">
                  <span class="buffer" role="tab" tabindex="0">
                    <span class="label buffer-name">{(bufName.startsWith('#') || bufName.startsWith('&') ? '#' : '') + stripHash(bufName)}</span>
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      {/if}
    </div>
  {/each}
</div>
{#if ircState.networks.length > 0}
<div class="addNetworkButtonContainer">
  <button class="addNetworkButton" id="add-network-btn" type="button" onclick={onAddNetwork}>
    <i class="fa fa-plus-circle"></i>
    Add a network
  </button>
</div>
{/if}
<AccountMenu {onAddNetwork} />
