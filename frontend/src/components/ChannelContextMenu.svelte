<script lang="ts">
  import { ircState, getActiveNetwork, getActiveBufferObj, setActiveBuffer, archiveBuffer, unarchiveBuffer, initiateRejoin, pruneMessagesBefore, clearMessageCache } from '../stores/ircStore.svelte';
  import { sendRaw } from '../stores/wsConnection.svelte.ts';
  import { archivedMap, pinnedMap, getBufferPrefs, setBufferPref, setClearedAt, unreadMap, highlightMap, globalPrefs } from '../stores/preferences.svelte';
  import { pinChannel, unpinChannel, updateBufferPrefs, clearBacklog as apiClearBacklog } from '../stores/api';
  import { normalizeChannelName } from '../lib/utils';
  import type { Buffer, IgnoreListData } from '../types';
  import { onMount, onDestroy } from 'svelte';
  import { updateRoute } from '../lib/routing';

  interface Props {
    x: number;
    y: number;
    anchorRight?: boolean;
    anchorBottom?: boolean;
    buf: Buffer;
    networkId?: string;
    onClose: () => void;
    onToggleMembers: () => void;
    memberPanelOpen: boolean;
  }
  let { x, y, anchorRight = false, anchorBottom = false, buf, networkId: propNetworkId, onClose, onToggleMembers, memberPanelOpen }: Props = $props();

  const network = $derived(
    propNetworkId ? (ircState.networks.find((n) => n.networkId === propNetworkId) ?? getActiveNetwork()) : getActiveNetwork()
  );
  const isChannel = $derived(buf.name?.startsWith('#') ?? false);
  const isArchived = $derived(!!archivedMap[`${network?.networkId}:${buf.name}`]);
  const isActive = $derived(buf.isJoined !== false && (network?.connected ?? false));
  const isConnected = $derived(network?.connected ?? false);
  const networkId = $derived(propNetworkId ?? network?.networkId ?? '');
  const isPinned = $derived(pinnedMap[`${networkId}:${buf.name}`] === true);

  let menuEl: HTMLDivElement;

  $effect(() => {
    if (!menuEl) return;
    const doPosition = () => {
      const height = menuEl.offsetHeight;
      const width = menuEl.offsetWidth;
      if (height === 0 || width === 0) {
        requestAnimationFrame(doPosition);
        return;
      }
      const windowHeight = window.innerHeight;
      const windowWidth = window.innerWidth;
      const bottomPad = 25;
      const rightPad = 10;

      menuEl.classList.remove('contextMenu__top', 'contextMenu__bottom', 'contextMenu__left', 'contextMenu__right');

      // Clamp y to viewport and handle flipping with off-screen top
      let clampedY = y;
      if (clampedY < bottomPad) clampedY = bottomPad;
      if (clampedY + height + bottomPad > windowHeight) {
        if (y - height - bottomPad >= bottomPad) {
          menuEl.classList.add('contextMenu__bottom');
          menuEl.style.top = 'auto';
          menuEl.style.bottom = (windowHeight - y) + 'px';
          const flippedTop = y - height;
          if (flippedTop < bottomPad) {
            menuEl.style.bottom = 'auto';
            menuEl.style.top = bottomPad + 'px';
            menuEl.classList.remove('contextMenu__bottom');
            menuEl.classList.add('contextMenu__top');
          }
        } else {
          menuEl.classList.add('contextMenu__top');
          menuEl.style.top = Math.max(bottomPad, windowHeight - height - bottomPad) + 'px';
          menuEl.style.bottom = 'auto';
        }
      } else {
        menuEl.classList.add('contextMenu__top');
        menuEl.style.top = clampedY + 'px';
        menuEl.style.bottom = 'auto';
      }

      let clampedX = x;
      if (clampedX < rightPad) clampedX = rightPad;
      const rightOverflow = clampedX + width > windowWidth - rightPad;
      if (rightOverflow && clampedX >= width) {
        menuEl.classList.add('contextMenu__right');
        menuEl.style.left = 'auto';
        menuEl.style.right = (windowWidth - clampedX) + 'px';
      } else {
        const maxLeft = windowWidth - width - rightPad;
        const finalLeft = Math.max(rightPad, Math.min(clampedX, maxLeft));
        menuEl.classList.add('contextMenu__left');
        menuEl.style.left = finalLeft + 'px';
        menuEl.style.right = 'auto';
      }
    };
    doPosition();
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

  function close(): void { onClose(); }
  function hide(): void { onClose(); }
  function clearContext(): void { onClose(); }

  function rejoin(): void {
    if (!networkId || !buf.name) return;
    // W1-T01: delegate to the canonical rejoin helper. allowReconnect=false
    // — context-menu Rejoin must NOT kick reconnectNetwork() (would race the
    // connection-recovery paths); the existing engine reconnection handles
    // disconnected networks without user intervention.
    initiateRejoin(networkId, buf.name, { allowReconnect: false });
    onClose();
  }
  function setTopic(): void {
    if (!networkId || !buf.name) return;
    const net = ircState.networks.find(n => n.networkId === networkId);
    ircState.overlay = {
      type: 'set_topic',
      data: {
        networkId,
        networkName: net?.name || '',
        networkHost: net ? `${net.host}:${net.port}` : '',
        bufferName: buf.name,
        currentTopic: buf.topic || '',
      },
    };
    onClose();
  }
  function invite(): void {
    if (!networkId || !buf.name) return;
    const net = ircState.networks.find(n => n.networkId === networkId);
    ircState.overlay = {
      type: 'invite',
      data: {
        networkId,
        networkName: net?.name || '',
        networkHost: net?.host || '',
        networkPort: net?.port || 6697,
        networkTls: net?.tls || 'enabled',
        bufferName: buf.name,
      },
    };
    onClose();
  }
  function leave(): void {
    if (!networkId || !buf.name) return;
    sendRaw(networkId, 'PART ' + buf.name);
    buf.isJoined = false;
    onClose();
  }
  function archive(): void {
    if (!networkId || !buf.name) return;
    archiveBuffer(networkId, buf.name);
    onClose();
  }
  function unarchive(): void {
    if (!networkId || !buf.name) return;
    unarchiveBuffer(networkId, buf.name);
    onClose();
  }
  async function clearBacklog(): Promise<void> {
    if (networkId && buf.name) {
      setClearedAt(networkId, buf.name);
      try {
        await apiClearBacklog(networkId, buf.name);
        clearMessageCache(networkId, buf.name);
        pruneMessagesBefore(networkId, buf.name, Date.now());
      } catch (err) {
        console.error('[ChannelContextMenu] clearBacklog API failed (UI filter still applied):', err);
      }
    }
    onClose();
  }
  function deleteBuffer(): void {
    if (!networkId || !buf.name) return;
    const net = ircState.networks.find(n => n.networkId === networkId);
    ircState.overlay = {
      type: 'channel_delete_confirm',
      data: {
        networkId,
        networkName: net?.name || '',
        networkHost: net ? `${net.host}:${net.port}` : '',
        bufferName: buf.name,
      },
    };
    onClose();
  }
  function requestBanList(): void {
    if (!networkId || !buf.name) return;
    sendRaw(networkId, 'MODE ' + buf.name + ' +b');
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

  const prefs = $derived(getBufferPrefs(networkId, buf.name));
  const toggles = $state({
    showMembers: memberPanelOpen,
    showUnread: prefs.showUnread ?? true,
    markAsRead: prefs.markAsRead ?? true,
    notifyAll: prefs.notifyAll ?? false,
    mute: prefs.mute ?? false,
    showJoinPart: prefs.showJoinPart ?? true,
    showAway: prefs.showAway ?? true,
    collapsed: false,
    replyCollapse: prefs.replyCollapse ?? false,
    replyQuote: prefs.replyQuote ?? false,
    typing: prefs.typing ?? true,
    inlineFiles: prefs.inlineFiles ?? true,
    inlineImages: prefs.inlineImages ?? true,
    inlinePastes: prefs.inlinePastes ?? true,
    inlineSocial: prefs.inlineSocial ?? true,
    inlineReddit: prefs.inlineReddit ?? false,
    formatColor: prefs.formatColor ?? true,
  });
  // Real-time sync: when prefs change from server (pref_update broadcast)
  // or another tab (storage event), keep the menu UI in sync while it's open.
  // Without this, toggles would stay stuck at the mount-time snapshot.
  $effect(() => {
    toggles.showUnread = prefs.showUnread ?? true;
    toggles.markAsRead = prefs.markAsRead ?? true;
    toggles.notifyAll = prefs.notifyAll ?? false;
    toggles.mute = prefs.mute ?? false;
    toggles.showJoinPart = prefs.showJoinPart ?? true;
    toggles.showAway = prefs.showAway ?? true;
    toggles.replyCollapse = prefs.replyCollapse ?? false;
    toggles.replyQuote = prefs.replyQuote ?? false;
    toggles.typing = prefs.typing ?? true;
    toggles.inlineFiles = prefs.inlineFiles ?? true;
    toggles.inlineImages = prefs.inlineImages ?? true;
    toggles.inlinePastes = prefs.inlinePastes ?? true;
    toggles.inlineSocial = prefs.inlineSocial ?? true;
    toggles.inlineReddit = prefs.inlineReddit ?? false;
    toggles.formatColor = prefs.formatColor ?? true;
  });
  const notifMode = $derived(toggles.mute ? 'muted' : toggles.notifyAll ? 'all' : 'mentions');
  function setNotifMode(mode: 'mentions' | 'all' | 'muted'): void {
    if (globalPrefs.muteAll) return;
    const nextMute = mode === 'muted';
    const nextNotifyAll = mode === 'all';
    toggles.mute = nextMute;
    toggles.notifyAll = nextNotifyAll;
    setBufferPref(networkId, buf.name, 'mute', nextMute);
    setBufferPref(networkId, buf.name, 'notifyAll', nextNotifyAll);
    if (nextMute) {
      const mapKey = `${networkId}:${normalizeChannelName(buf.name)}`;
      delete unreadMap[mapKey];
      delete highlightMap[mapKey];
      buf.unreadCount = 0;
      buf.highlight = false;
      (buf as unknown as Record<string, unknown>).highlightCount = 0;
    }
    updateBufferPrefs(networkId, buf.name, { mute: nextMute, notifyAll: nextNotifyAll })
      .catch((err) => console.error('Failed to sync buffer prefs:', err));
  }
  function toggle(key: keyof typeof toggles | 'pinned'): void {
    if (key === 'pinned') {
      const pinnedKey = `${networkId}:${buf.name}`;
      if (!isPinned) {
        pinnedMap[pinnedKey] = true;
        buf.isPinned = true;
        pinChannel(networkId, buf.name).catch((err) => {
          console.error('Pin failed:', err);
          pinnedMap[pinnedKey] = false;
          buf.isPinned = false;
        });
      } else {
        pinnedMap[pinnedKey] = false;
        buf.isPinned = false;
        unpinChannel(networkId, buf.name).catch((err) => {
          console.error('Unpin failed:', err);
          pinnedMap[pinnedKey] = true;
          buf.isPinned = true;
        });
      }
    } else {
      (toggles as Record<string, boolean>)[key] = !toggles[key];
      if (key === 'showMembers' || key === 'collapsed') {
        if (key === 'showMembers') onToggleMembers();
      } else {
        // Persist all other toggles per-buffer so they survive a refresh
        setBufferPref(networkId, buf.name, key, toggles[key]);
        if ((key === 'mute' && toggles[key] === true) || (key === 'showUnread' && toggles[key] === false)) {
          const mapKey = `${networkId}:${normalizeChannelName(buf.name)}`;
          delete unreadMap[mapKey];
          delete highlightMap[mapKey];
          buf.unreadCount = 0;
          buf.highlight = false;
          (buf as unknown as Record<string, unknown>).highlightCount = 0;
        }
        // Sync to server for cross-device realtime propagation
        updateBufferPrefs(networkId, buf.name, { [key]: toggles[key] })
          .catch((err) => console.error('Failed to sync buffer prefs:', err));
      }
    }
  }

  const modeString = $derived((buf as { modeString?: string }).modeString ?? '');
  const modeList = $derived.by(() => {
    const m = (buf as { modeList?: { type: string; text: string }[] }).modeList;
    return Array.isArray(m) ? m : [];
  });
</script>

<div id="channelContextMenu" class="bufferContextMenu contextMenu contextMenu__top contextMenu__left"
     style:top="{y}px"
     style:left="{x}px"
     style:display="block"
     bind:this={menuEl}
     role="menu">
  <div class="contextMenu__wrap">
    <ul class="actions" style="">
      <li class="rejoin" class:inactive={isActive} aria-disabled={isActive} style:display={isActive ? 'none' : ''}>
        <button class="contextMenu__item rejoin" class:contextMenu__item--disabled={isActive} disabled={isActive} onclick={rejoin}>Rejoin</button>
      </li>
      <li class="show" class:inactive={!isArchived} aria-disabled={!isArchived} style:display={isArchived ? '' : 'none'}>
        <button class="contextMenu__item show" onclick={unarchive}>Unarchive</button>
      </li>
      <li class="topic" aria-disabled="false">
        <button class="contextMenu__item topic" onclick={setTopic}>Set topic…</button>
      </li>
      <li class="invite" aria-disabled="false">
        <button class="contextMenu__item invite" onclick={invite}>Invite…</button>
      </li>
      <li class="leave" class:inactive={!isActive} aria-disabled={!isActive} style:display={isActive ? '' : 'none'}>
        <button class="contextMenu__item leave" class:contextMenu__item--disabled={!isActive} disabled={!isActive} onclick={leave}>Leave</button>
      </li>
      <li class="hide" class:inactive={isArchived} aria-disabled={isArchived} style:display={isArchived ? 'none' : ''}>
        <button class="contextMenu__item hide" class:contextMenu__item--disabled={isArchived} disabled={isArchived} onclick={archive}>Archive</button>
      </li>
      <li class="modAction" aria-disabled="false">
        <button class="contextMenu__item bans" onclick={requestBanList}>Ban list…</button>
      </li>
      <li aria-disabled="false">
        <button class="contextMenu__item ignores" onclick={clickIgnores}>Ignore list…</button>
      </li>
      <li class="logExport" aria-disabled="false">
        <button class="contextMenu__item export" onclick={onClose}>Download logs…</button>
      </li>
      <li class="clear" aria-disabled="false">
        <button class="contextMenu__item clear" onclick={clearBacklog}>Clear backlog</button>
      </li>
      <li class="delete" aria-disabled="false">
        <button class="contextMenu__item delete" onclick={deleteBuffer}>Delete…</button>
      </li>
    </ul>
    <hr>
    <ul class="actions" style="">
      <li class="showMembers" class:enabled={toggles.showMembers}>
        <button class="contextMenu__item members" aria-pressed={toggles.showMembers} onclick={() => toggle('showMembers')}>
          {#if toggles.showMembers}<i class="fa fa-check"></i>{/if}Show members
        </button>
      </li>
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
      <li class="contextMenu__header" style="padding: 6px 12px 2px; font-size: 11px; color: #ccc; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap;">Notifications</li>
      {#if globalPrefs.muteAll}
        <li style="padding: 0 12px 4px; font-size: 11px; color: #fbbf24; white-space: nowrap;">Muted globally — disable Mute all in Settings → Alerts</li>
      {/if}
      <li class:enabled={notifMode === 'mentions'} aria-disabled={globalPrefs.muteAll}>
        <button class="contextMenu__item notifMentions" class:contextMenu__item--disabled={globalPrefs.muteAll} disabled={globalPrefs.muteAll} aria-pressed={notifMode === 'mentions'} onclick={() => setNotifMode('mentions')}>
          {#if notifMode === 'mentions'}<i class="fa fa-check"></i>{/if}Mentions only
        </button>
      </li>
      <li class:enabled={notifMode === 'all'} aria-disabled={globalPrefs.muteAll}>
        <button class="contextMenu__item notifAll" class:contextMenu__item--disabled={globalPrefs.muteAll} disabled={globalPrefs.muteAll} aria-pressed={notifMode === 'all'} onclick={() => setNotifMode('all')}>
          {#if notifMode === 'all'}<i class="fa fa-check"></i>{/if}All messages
        </button>
      </li>
      <li class:enabled={notifMode === 'muted'} aria-disabled={globalPrefs.muteAll}>
        <button class="contextMenu__item notifMuted" class:contextMenu__item--disabled={globalPrefs.muteAll} disabled={globalPrefs.muteAll} aria-pressed={notifMode === 'muted'} onclick={() => setNotifMode('muted')}>
          {#if notifMode === 'muted'}<i class="fa fa-check"></i>{/if}Muted
        </button>
      </li>
      <li class="showJoinPart" class:enabled={toggles.showJoinPart}>
        <button class="contextMenu__item joinpart" aria-pressed={toggles.showJoinPart} onclick={() => toggle('showJoinPart')}>
          {#if toggles.showJoinPart}<i class="fa fa-check"></i>{/if}Show nick changes, joins and parts
        </button>
      </li>
      <li class="showAway" class:enabled={toggles.showAway}>
        <button class="contextMenu__item away" aria-pressed={toggles.showAway} onclick={() => toggle('showAway')}>
          {#if toggles.showAway}<i class="fa fa-check"></i>{/if}Show away status
        </button>
      </li>
      <li class="typing" aria-disabled="false" class:enabled={toggles.typing}>
        <button class="contextMenu__item typing" aria-pressed={toggles.typing} onclick={() => toggle('typing')}>
          {#if toggles.typing}<i class="fa fa-check"></i>{/if}Share typing status
        </button>
      </li>
      <li class="inlineFiles" class:enabled={toggles.inlineFiles}>
        <button class="contextMenu__item files" aria-pressed={toggles.inlineFiles} onclick={() => toggle('inlineFiles')}>
          {#if toggles.inlineFiles}<i class="fa fa-check"></i>{/if}Embed uploaded files
        </button>
      </li>
      <li class="inlineImages" class:enabled={toggles.inlineImages}>
        <button class="contextMenu__item images" aria-pressed={toggles.inlineImages} onclick={() => toggle('inlineImages')}>
          {#if toggles.inlineImages}<i class="fa fa-check"></i>{/if}Embed external media
        </button>
      </li>
      <li class="inlinePastes" class:enabled={toggles.inlinePastes}>
        <button class="contextMenu__item pastes" aria-pressed={toggles.inlinePastes} onclick={() => toggle('inlinePastes')}>
          {#if toggles.inlinePastes}<i class="fa fa-check"></i>{/if}Embed text snippets
        </button>
      </li>
      <li class="inlineSocialMedia" class:enabled={toggles.inlineSocial}>
        <button class="contextMenu__item socialMedia" aria-pressed={toggles.inlineSocial} onclick={() => toggle('inlineSocial')}>
          {#if toggles.inlineSocial}<i class="fa fa-check"></i>{/if}Embed Twitter links
        </button>
      </li>
      <li class="inlineReddit" class:enabled={toggles.inlineReddit}>
        <button class="contextMenu__item reddit" aria-pressed={toggles.inlineReddit} onclick={() => toggle('inlineReddit')}>
          {#if toggles.inlineReddit}<i class="fa fa-check"></i>{/if}Embed Reddit links
        </button>
      </li>
      <li class="formatColor" class:enabled={toggles.formatColor}>
        <button class="contextMenu__item formatColor" aria-pressed={toggles.formatColor} onclick={() => toggle('formatColor')}>
          {#if toggles.formatColor}<i class="fa fa-check"></i>{/if}Format colours
        </button>
      </li>
      <li class="pinned" aria-disabled="false" class:enabled={isPinned}>
        <button class="contextMenu__item pinned" aria-pressed={isPinned} onclick={() => toggle('pinned')}>
          {#if isPinned}<i class="fa fa-check"></i>{/if}{isPinned ? 'Unpin' : 'Pin'}
        </button>
      </li>
    </ul>
    {#if modeString}
      <p class="info modeLine">Mode: +{modeString}</p>
    {/if}
    {#if modeList.length > 0}
      <ul class="modeList">
        {#each modeList as m}
          <li class={m.type}>{m.text}</li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
