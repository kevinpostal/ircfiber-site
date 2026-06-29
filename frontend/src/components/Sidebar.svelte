<script lang="ts">
  import { ircState } from '../stores/ircStore.svelte';
  import { archivedMap, pinnedMap, hiddenChannelsMap, collapsedMap, inactiveCollapsedMap, conversationsCollapsedMap, networkOrder } from '../stores/preferences.svelte';
  import { stripHash, normalizeChannelName } from '../lib/utils';
  import { updateCollapsed, updateInactiveCollapsed, updateNetworkOrder } from '../stores/api';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';
  import type { Buffer, Network } from '../types';
  import AccountMenu from './AccountMenu.svelte';
  import StaleIndicator from './StaleIndicator.svelte';

  interface Props {
    onSwitchBuffer: (networkId: string, bufferName: string) => void;
    onAddNetwork: () => void;
    onNetworkOptions: (networkId: string, e: MouseEvent) => void;
    onJoinChannel: (networkId: string) => void;
  }
  let { onSwitchBuffer, onAddNetwork, onNetworkOptions, onJoinChannel }: Props = $props();

  function toggleNetwork(networkId: string): void {
    const newValue = !collapsedMap[networkId];
    collapsedMap[networkId] = newValue;
    updateCollapsed(networkId, newValue);
  }

  const pinned = $derived(
    ircState.networks.flatMap(net =>
      net.buffers
        .filter(b => b.name !== '_server' && pinnedMap[`${net.networkId}:${b.name}`] === true && !archivedMap[`${net.networkId}:${b.name}`] && !hiddenChannelsMap[`${net.networkId}:${b.name}`])
        .map(b => ({ networkId: net.networkId, buffer: b, network: net }))
    )
  );

  // Defensive: duplicate networkIds in the store would crash Svelte's keyed
  // each block. Filter to the first occurrence so the UI stays up.
  // The networkOrder sort is applied inside updateNetworkFromSync /
  // handlePrefUpdate so ircState.networks is already in the user's order
  // by the time we get here.
  const uniqueNetworks = $derived(
    ircState.networks.filter((net, i, arr) =>
      arr.findIndex(n => n.networkId === net.networkId) === i
    )
  );

  // Local mutable copy that svelte-dnd-action mutates during drag. We
  // apply the new order to ircState.networks + networkOrder + the server
  // only on `finalize` (drop), to avoid spamming the backend while the
  // user is mid-drag. `flipDurationMs` matches IRCCloud's 100ms revert.
  //
  // svelte-dnd-action requires every item to expose an `id` field, and
  // mutates the array in place. We wrap each Network in {id, net} so the
  // library is happy and unwrap on the way out to update ircState.
  interface DragItem { id: string; net: Network; }
  let dragList = $state<DragItem[]>([]);
  let dragActive = $state(false);
  $effect(() => {
    dragList = uniqueNetworks.map(net => ({ id: net.networkId, net }));
  });

  function handleConsider(e: CustomEvent<DndEvent<DragItem>>): void {
    dragList = e.detail.items;
    if (!dragActive) {
      dragActive = true;
      // Directly add dragging class to the container BEFORE Svelte
      // reactivity kicks in, so channel lists are hidden on the very
      // first drag frame (CSS rule hides .network-buffers).
      (e.currentTarget as HTMLElement).classList.add('dragging');
      // Auto-collapse the dragged network (as if the user clicked its
      // chevron). IRCCloud does this so the server header is the only
      // visual that moves during reorder — no channel list hitches along.
      // Find the dragged network by reading the library's dnd info.id
      // (the networkId of the item being dragged) off the event.
      const info = (e.detail as { info?: { id?: string } }).info;
      const draggedId = info?.id;
      if (draggedId && !collapsedMap[draggedId]) {
        collapsedMap[draggedId] = true;
        updateCollapsed(draggedId, true);
      }
    }
  }

  function handleFinalize(e: CustomEvent<DndEvent<DragItem>>): void {
    dragActive = false;
    (e.currentTarget as HTMLElement).classList.remove('dragging');
    const items = e.detail.items;
    const nets = items.map(i => i.net);
    // Reassign ircState.networks wholesale (not splice-in-place with the
    // same Network object references) so Svelte 5's $state proxy always
    // invalidates downstream $derived/$effect consumers. A splice that
    // replaces N items with the same N references can be treated as a
    // no-op by the proxy, leaving uniqueNetworks / dragList stale and
    // breaking the keyed each block — which is what made collapse clicks
    // stop responding after a reorder.
    ircState.networks = nets;
    dragList = uniqueNetworks.map(net => ({ id: net.networkId, net }));
    const order = nets.map(n => n.networkId);
    networkOrder.length = 0;
    networkOrder.push(...order);
    updateNetworkOrder(order).catch(err => console.error('Failed to persist network order:', err));
  }

  // Drag-to-reorder is always active via svelte-dnd-action below.
  // A quick click selects the network; a click+hold+drag reorders it.

  function uniqueBuffersByName<T extends { name: string }>(buffers: T[]): T[] {
    // Compare via normalizeChannelName so "#autism" and "autism" collapse
    // to the same buffer entry instead of appearing in both Active and
    // Inactive sections.
    return buffers.filter((b, i, arr) =>
      arr.findIndex(x => normalizeChannelName(x.name) === normalizeChannelName(b.name)) === i
    );
  }

  function uniquePinned(pinned: Array<{ networkId: string; buffer: Buffer; network: Network }>): Array<{ networkId: string; buffer: Buffer; network: Network }> {
    const seen = new Set<string>();
    return pinned.filter(p => {
      const key = p.networkId + ':' + p.buffer.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
</script>

<div class="network-list" id="networks">
  <div class="sidebar-brand">
    <span class="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke-linecap="round">
        <g class="fiber-strand" stroke="#67e8f9" stroke-width="2.2">
          <line x1="9.5" y1="3" x2="9.5" y2="21"/>
          <line x1="14.5" y1="3" x2="14.5" y2="21"/>
        </g>
      </svg>
    </span>
    <span class="brand-text">IRC<span class="brand-fiber">Fiber</span></span>

  </div>

  {#if pinned.length > 0}
    <ul class="bufferList pinnedBuffers">
      <h2><i class="fa fa-thumb-tack"></i>Pinned</h2>
      <ul class="pinnedBufferList">
        {#each uniquePinned(pinned) as p (p.networkId + ':' + p.buffer.name)}
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

  <div class="network-list-items"
       use:dndzone={{
          items: dragList,
          flipDurationMs: 150,
          type: 'network-order',
          transformDraggedElement: (el) => {
            // IRCCloud: the dragged server header has NO visual feedback —
            // no border, no shadow, no highlight tint, and no channel list.
            // Strip decoration + hide the channel list so the clone looks
            // exactly like a normal collapsed server header.
            if (!el) return;
            el.style.outline = 'none';
            el.style.boxShadow = 'none';
            el.style.background = '#333';
            const buffers = el.querySelector('.network-buffers');
            if (buffers) (buffers as HTMLElement).style.display = 'none';
            const inactive = el.querySelector('.inactive-channels');
            if (inactive) (inactive as HTMLElement).style.display = 'none';
            const archived = el.querySelector('.archived-channels');
            if (archived) (archived as HTMLElement).style.display = 'none';
            el.querySelectorAll('.sidebar-section-header').forEach(h => {
              (h as HTMLElement).style.display = 'none';
            });
          }
        }}
       onconsider={handleConsider}
       onfinalize={handleFinalize}>
    {#each dragList as item (item.id)}
      {@const net = item.net}
      {@const isActiveNet = ircState.activeBuffer.networkId === net.networkId && ircState.activeBuffer.bufferName === '_server'}
      {@const totalNetUnread = net.buffers.reduce((sum, b) => sum + (b.unreadCount || 0), 0)}
      {@const totalNetHighlights = net.buffers.reduce((sum, b) => sum + (b.highlightCount ?? 0), 0)}
      <div class="network connection" class:connected={net.connected} class:disconnected={!net.connected}>
        <div class="network-header buffer"
            class:active={isActiveNet}
            class:unread={totalNetUnread > 0}
            class:highlight={totalNetHighlights > 0}
            class:collapsed={collapsedMap[net.networkId]}
            role="button"
            tabindex="0"
            onclick={() => onSwitchBuffer(net.networkId, '_server')}
            ondblclick={() => { if (collapsedMap[net.networkId]) { collapsedMap[net.networkId] = false; updateCollapsed(net.networkId, false); } }}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSwitchBuffer(net.networkId, '_server'); } }}>
          <span class="buffer" role="tab">
            {#if net.connected}
              <i class="fa fa-lock network-shield" title="Secure connection" aria-hidden="true"></i>
            {:else}
              <i class="fa fa-globe network-shield" aria-hidden="true" style="opacity:0.5"></i>
            {/if}
            <span class="label">{net.name}</span>
            <StaleIndicator lastSeenAt={net.lastSeenAt} />
            {#if totalNetHighlights > 0}
              <span class="unread buffer-unread">{totalNetHighlights}</span>
            {/if}
            <button class="bufferOptions fa fa-cog" type="button"
                    title="Options" aria-label="Options"
                    aria-expanded="false" aria-haspopup="true"
                    onclick={(e) => { e.stopPropagation(); onNetworkOptions(net.networkId, e); }}></button>
          </span>
          <span class="collapseToggle">
            {#if dragActive}
              <span class="drag-handle" aria-hidden="true" title="Drag to reorder">
                <i class="fa fa-grip-lines"></i>
              </span>
            {:else}
              <button type="button" aria-expanded={!collapsedMap[net.networkId]}
                      onclick={(e) => { e.stopPropagation(); toggleNetwork(net.networkId); }}>
                <i class="fa fa-chevron-{collapsedMap[net.networkId] ? 'right' : 'down'}" aria-hidden="true"></i>
              </button>
            {/if}
          </span>
        </div>
        {#if !collapsedMap[net.networkId]}
          {@const activeFilter = (b: Buffer) => b.name !== '_server' && b.isJoined !== false && !pinnedMap[`${net.networkId}:${b.name}`] && !archivedMap[`${net.networkId}:${b.name}`] && !hiddenChannelsMap[`${net.networkId}:${b.name}`]}
          {@const currentChannels = uniqueBuffersByName(net.buffers.filter(b => activeFilter(b) && b.name.startsWith('#')))}
          {@const currentConversations = uniqueBuffersByName(net.buffers.filter(b => activeFilter(b) && b.type === 'query' && !b.name.startsWith('#')))}
          <ul class="buffers channels network-buffers">
            {#each currentChannels as buf (net.networkId + ':' + buf.name)}
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
                  <span class="label buffer-name">{'#' + stripHash(buf.name)}</span>
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
          {@const inactiveIsCollapsed = inactiveCollapsedMap[net.networkId] ?? false}
          {#if inactive.length > 0}
            <div class="sidebar-section-header inactive-header"
                 role="button" tabindex="0"
                 onclick={() => { const next = !inactiveIsCollapsed; inactiveCollapsedMap[net.networkId] = next; updateInactiveCollapsed(net.networkId, next); }}
                 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const next = !inactiveIsCollapsed; inactiveCollapsedMap[net.networkId] = next; updateInactiveCollapsed(net.networkId, next); } }}
                 aria-expanded={!inactiveIsCollapsed}>
              <span class="inactive-header-label">Inactive</span>
              <button type="button" class="inactive-header-toggle"
                      title={inactiveIsCollapsed ? 'Expand' : 'Collapse'}
                      aria-label={inactiveIsCollapsed ? 'Expand Inactive' : 'Collapse Inactive'}
                      onclick={(e) => { e.stopPropagation(); const next = !inactiveIsCollapsed; inactiveCollapsedMap[net.networkId] = next; updateInactiveCollapsed(net.networkId, next); }}>
                <i class="fa fa-chevron-{inactiveIsCollapsed ? 'right' : 'down'}" aria-hidden="true"></i>
              </button>
            </div>
            {#if !inactiveIsCollapsed}
              <ul class="buffers inactive-channels">
                {#each uniqueBuffersByName(inactive) as buf (net.networkId + ':' + buf.name)}
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
          {/if}
          {#if currentConversations.length > 0}
            {@const convCollapsed = conversationsCollapsedMap[net.networkId] ?? false}
            <div class="sidebar-section-header conversations-header"
                 role="button" tabindex="0"
                 onclick={() => { const next = !convCollapsed; conversationsCollapsedMap[net.networkId] = next; }}
                 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const next = !convCollapsed; conversationsCollapsedMap[net.networkId] = next; } }}
                 aria-expanded={!convCollapsed}>
              <span class="conversations-header-label">Conversations</span>
              <button type="button" class="conversations-header-toggle"
                      title={convCollapsed ? 'Expand' : 'Collapse'}
                      aria-label={convCollapsed ? 'Expand Conversations' : 'Collapse Conversations'}
                      onclick={(e) => { e.stopPropagation(); const next = !convCollapsed; conversationsCollapsedMap[net.networkId] = next; }}>
                <i class="fa fa-chevron-{convCollapsed ? 'right' : 'down'}" aria-hidden="true"></i>
              </button>
            </div>
            {#if !convCollapsed}
              <ul class="buffers conversations">
                {#each currentConversations as buf (net.networkId + ':' + buf.name)}
                  {@const isActive = net.networkId === ircState.activeBuffer.networkId && buf.name === ircState.activeBuffer.bufferName}
                  <li class="buffer conversation buffer-item"
                      class:active={isActive}
                      class:unread={buf.unreadCount > 0}
                      class:highlight={buf.highlight}
                      onclick={() => onSwitchBuffer(net.networkId, buf.name)}
                      role="presentation">
                    <span class="buffer" role="tab" tabindex="0">
                      <span class="label buffer-name">{buf.name}</span>
                      {#if buf.unreadCount > 0}
                        <span class="unread buffer-unread">{buf.unreadCount}</span>
                      {:else if (buf.highlightCount ?? 0) > 0}
                        <span class="unread buffer-unread">{buf.highlightCount}</span>
                      {/if}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
          {@const archived = Object.keys(archivedMap)
            .filter(key => key.startsWith(`${net.networkId}:`) && archivedMap[key] && !hiddenChannelsMap[key])
            .map(key => key.slice(net.networkId.length + 1))}
          {#if archived.length > 0}
            <div class="sidebar-section-header archive-header"
                 role="button" tabindex="0"
                 onclick={() => { net.archivesCollapsed = !(net.archivesCollapsed ?? true); }}
                 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); net.archivesCollapsed = !(net.archivesCollapsed ?? true); } }}
                 aria-expanded={!(net.archivesCollapsed ?? true)}>
              <span class="archive-header-label">Archives</span>
              <button type="button" class="archive-header-toggle"
                      title={net.archivesCollapsed ? 'Expand' : 'Collapse'}
                      aria-label={net.archivesCollapsed ? 'Expand Archives' : 'Collapse Archives'}
                      onclick={(e) => { e.stopPropagation(); net.archivesCollapsed = !(net.archivesCollapsed ?? true); }}>
                <i class="fa fa-chevron-{net.archivesCollapsed ? 'right' : 'down'}" aria-hidden="true"></i>
              </button>
            </div>
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
</div>
<div class="addNetworkButtonContainer">
  <button class="addNetworkButton" class:addNetworkButton--selected={ircState.networks.length === 0} id="add-network-btn" type="button" onclick={onAddNetwork}>
    <i class="fa fa-plus-circle"></i>
    Add a network
  </button>
</div>
<AccountMenu {onAddNetwork} />
