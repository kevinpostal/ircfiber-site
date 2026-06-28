<script lang="ts">
  import { ircState, getActiveNetwork, markUserDisconnected } from '../stores/ircStore.svelte';
  import { sendRaw } from '../stores/wsConnection.svelte.ts';
  import { reconnectNetwork, disconnectNetwork, updateCollapsed } from '../stores/api';
  import { getBufferPrefs, setBufferPref, collapsedMap, setClearedAt } from '../stores/preferences.svelte';
  import type { Buffer, IgnoreListData } from '../types';
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    x: number;
    y: number;
    anchorRight?: boolean;
    anchorBottom?: boolean;
    buf: Buffer;
    onClose: () => void;
    onJoinChannel: (e?: MouseEvent) => void;
    onEditNetwork: () => void;
  }
  let { x, y, anchorRight = false, anchorBottom = false, buf, onClose, onJoinChannel, onEditNetwork }: Props = $props();

  const network = $derived(getActiveNetwork());
  const networkId = $derived(network?.networkId ?? '');
  const isConnected = $derived(network?.connected ?? false);
  const isCollapsed = $derived(network ? (collapsedMap[network.networkId] ?? false) : false);
  const isInactive = $derived(!isConnected);
  const canDelete = $derived(true);

  let menuEl: HTMLDivElement;

  $effect(() => {
    if (!menuEl) return;
    const height = menuEl.offsetHeight;
    const width = menuEl.offsetWidth;
    const windowHeight = window.innerHeight;
    const windowWidth = window.innerWidth;
    const bottomPad = 25;

    menuEl.classList.remove('contextMenu__top', 'contextMenu__bottom', 'contextMenu__left', 'contextMenu__right');

    // Vertical: open below the anchor by default; flip above if it would
    // extend past the bottom of the viewport.
    if (y + height + bottomPad < windowHeight) {
      menuEl.classList.add('contextMenu__top');
      menuEl.style.top = y + 'px';
      menuEl.style.bottom = 'auto';
    } else {
      menuEl.classList.add('contextMenu__bottom');
      menuEl.style.top = 'auto';
      menuEl.style.bottom = (windowHeight - y) + 'px';
    }

    // Horizontal: extend to the right from the anchor point (left edge at x)
    // by default. If that would overflow the right viewport edge AND the
    // anchor is far enough from the left edge, flip to extending left
    // (right edge at x) instead.
    const rightOverflow = x + width > windowWidth;
    if (rightOverflow && x >= width) {
      menuEl.classList.add('contextMenu__right');
      menuEl.style.left = 'auto';
      menuEl.style.right = (windowWidth - x) + 'px';
    } else {
      menuEl.classList.add('contextMenu__left');
      menuEl.style.left = x + 'px';
      menuEl.style.right = 'auto';
    }
  });

  function clickOutside(e: MouseEvent): void {
    if (menuEl && !menuEl.contains(e.target as Node)) onClose();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
  }
  onMount(() => {
    setTimeout(() => document.addEventListener('click', clickOutside), 0);
    document.addEventListener('keydown', onKey);
  });
  onDestroy(() => {
    document.removeEventListener('click', clickOutside);
    document.removeEventListener('keydown', onKey);
  });

  async function clickReconnect(): Promise<void> {
    if (!networkId || !isInactive) return;
    onClose();
    await reconnectNetwork(networkId);
  }
  async function clickDisconnect(): Promise<void> {
    if (!networkId || isInactive) return;
    onClose();
    markUserDisconnected(networkId);
    await disconnectNetwork(networkId);
  }
  function clickJoin(): void {
    onClose();
    onJoinChannel();
  }
  function clickEdit(): void {
    onClose();
    onEditNetwork();
  }
  function clickIdentify(): void {
    if (!networkId) return;
    sendRaw(networkId, 'PRIVMSG NickServ :IDENTIFY');
    onClose();
  }
  function clickToggleCollapse(): void {
    if (network) {
      const newValue = !collapsedMap[network.networkId];
      collapsedMap[network.networkId] = newValue;
      updateCollapsed(network.networkId, newValue);
    }
    onClose();
  }
  function clickIgnores(): void {
    if (!network) return;
    const data: IgnoreListData = {
      networkId: network.networkId,
      networkName: network.name,
    };
    ircState.overlay = { type: 'ignore_list', data };
    onClose();
  }
  function clickExport(): void {
    onClose();
  }
  function clearBacklog(): void {
    if (networkId) setClearedAt(networkId, '_server');
    onClose();
  }
  function clickDeleteConversations(): void {
    onClose();
  }
  function clickDelete(): void {
    if (!networkId) return;
    const net = ircState.networks.find(n => n.networkId === networkId);
    ircState.overlay = {
      type: 'channel_delete_confirm',
      data: {
        networkId,
        networkName: net?.name || '',
        networkHost: net ? `${net.host}:${net.port}` : '',
        bufferName: '_server',
      },
    };
    onClose();
  }

  const prefs = $derived(getBufferPrefs(networkId, '_server'));
  const toggles = $state({
    showUnread: prefs.showUnread ?? true,
    markAsRead: prefs.markAsRead ?? true,
    mute: prefs.mute ?? false,
    collapseDisconnects: prefs.collapseDisconnects ?? true,
    formatColor: prefs.formatColor ?? true,
  });
  function toggle(key: keyof typeof toggles): void {
    (toggles as Record<string, boolean>)[key] = !(toggles as Record<string, boolean>)[key];
    // Persist per-buffer so the setting survives a page refresh
    setBufferPref(networkId, '_server', key, toggles[key]);
  }
</script>

<div id="serverLogContextMenu" class="bufferContextMenu contextMenu contextMenu__top contextMenu__left"
     style:top="{y}px"
     style:left="{x}px"
     style:display="block"
     bind:this={menuEl}
     role="menu">
  <div class="contextMenu__wrap" style:max-height="none">
    <ul class="actions" style="">
      <li class="reconnect" class:inactive={!isInactive} aria-disabled={!isInactive} style:display={isInactive ? '' : 'none'}>
        <button class="contextMenu__item reconnect" class:contextMenu__item--disabled={!isInactive} disabled={!isInactive} onclick={clickReconnect}>Reconnect</button>
      </li>
      <li class="join">
        <button class="contextMenu__item join" onclick={clickJoin}>Join a channel…</button>
      </li>
      <li class="edit">
        <button class="contextMenu__item edit" onclick={clickEdit}>Edit…</button>
      </li>
      <li class="nickserv" class:inactive={!isConnected} aria-disabled={!isConnected} style:display={isConnected ? '' : 'none'}>
        <button class="contextMenu__item nickserv" class:contextMenu__item--disabled={!isConnected} disabled={!isConnected} onclick={clickIdentify}>Identify Nickname…</button>
      </li>
      <li class="disconnect" class:inactive={isInactive} aria-disabled={isInactive} style:display={isInactive ? 'none' : ''}>
        <button class="contextMenu__item disconnect" class:contextMenu__item--disabled={isInactive} disabled={isInactive} onclick={clickDisconnect}>Disconnect</button>
      </li>
      <li>
        <button class="contextMenu__item ignores" onclick={clickIgnores}>Ignore list…</button>
      </li>
      <li class="logExport">
        <button class="contextMenu__item export" onclick={clickExport}>Download logs…</button>
      </li>
      <li class="clear">
        <button class="contextMenu__item clear" onclick={clearBacklog}>Clear backlog</button>
      </li>
      <li class="collapse" class:inactive={isCollapsed} aria-disabled={isCollapsed} style:display={isCollapsed ? 'none' : ''}>
        <button class="contextMenu__item collapse" class:contextMenu__item--disabled={isCollapsed} disabled={isCollapsed} onclick={clickToggleCollapse}>Collapse</button>
      </li>
      <li class="expand" class:inactive={!isCollapsed} aria-disabled={!isCollapsed} style:display={isCollapsed ? '' : 'none'}>
        <button class="contextMenu__item expand" class:contextMenu__item--disabled={!isCollapsed} disabled={!isCollapsed} onclick={clickToggleCollapse}>Expand</button>
      </li>
      <li class="deleteConversations">
        <button class="contextMenu__item deleteConversations" onclick={clickDeleteConversations}>Delete active private messages…</button>
      </li>
      <li class="delete" class:inactive={!canDelete} aria-disabled={!canDelete} style:display={canDelete ? '' : 'none'}>
        <button class="contextMenu__item delete" class:contextMenu__item--disabled={!canDelete} disabled={!canDelete} onclick={clickDelete}>Delete…</button>
      </li>
    </ul>
    <hr>
    <ul class="actions" style="">
      <li class="trackUnread" class:enabled={toggles.showUnread}>
        <button class="contextMenu__item unread" aria-pressed={toggles.showUnread} onclick={() => toggle('showUnread')}>
          {#if toggles.showUnread}<i class="fa fa-check"></i>{/if}Show unread message indicator
        </button>
      </li>
      <li class="markAsReadOnSelect" class:enabled={toggles.markAsRead}>
        <button class="contextMenu__item readOnSelect" aria-pressed={toggles.markAsRead} onclick={() => toggle('markAsRead')}>
          {#if toggles.markAsRead}<i class="fa fa-check"></i>{/if}Mark as read automatically
        </button>
      </li>
      <li class="muteNotifications" class:enabled={toggles.mute}>
        <button class="contextMenu__item muteNotifications" aria-pressed={toggles.mute} onclick={() => toggle('mute')}>
          {#if toggles.mute}<i class="fa fa-check"></i>{/if}Mute notifications
        </button>
      </li>
      <li class="collapseDisconnects" class:enabled={toggles.collapseDisconnects}>
        <button class="contextMenu__item discocollapse" aria-pressed={toggles.collapseDisconnects} onclick={() => toggle('collapseDisconnects')}>
          {#if toggles.collapseDisconnects}<i class="fa fa-check"></i>{/if}Group repeated disconnects
        </button>
      </li>
      <li class="formatColor" class:enabled={toggles.formatColor}>
        <button class="contextMenu__item formatColor" aria-pressed={toggles.formatColor} onclick={() => toggle('formatColor')}>
          {#if toggles.formatColor}<i class="fa fa-check"></i>{/if}Format colours
        </button>
      </li>
    </ul>
  </div>
</div>
