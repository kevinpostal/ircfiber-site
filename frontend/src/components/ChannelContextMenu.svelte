<script lang="ts">
  import { ircState, getActiveNetwork, getActiveBufferObj, setActiveBuffer, archiveBuffer, unarchiveBuffer } from '../stores/ircStore.svelte';
  import { sendRaw } from '../stores/wsConnection.svelte.ts';
  import { archivedMap, pinnedMap, getBufferPrefs, setBufferPref } from '../stores/preferences.svelte';
  import { pinChannel, unpinChannel, updateBufferPrefs } from '../stores/api';
  import type { Buffer, IgnoreListData } from '../types';
  import { onMount, onDestroy } from 'svelte';
  import { updateRoute } from '../lib/routing';

  interface Props {
    x: number;
    y: number;
    anchorRight?: boolean;
    anchorBottom?: boolean;
    buf: Buffer;
    onClose: () => void;
    onToggleMembers: () => void;
    memberPanelOpen: boolean;
  }
  let { x, y, anchorRight = false, anchorBottom = false, buf, onClose, onToggleMembers, memberPanelOpen }: Props = $props();

  const network = $derived(getActiveNetwork());
  const isChannel = $derived(buf.name?.startsWith('#') ?? false);
  const isArchived = $derived(!!archivedMap[`${network?.networkId}:${buf.name}`]);
  const isActive = $derived(buf.isJoined !== false && (network?.connected ?? false));
  const isConnected = $derived(network?.connected ?? false);
  const networkId = $derived(network?.networkId ?? '');
  const isPinned = $derived(pinnedMap[`${networkId}:${buf.name}`] === true);

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

  function close(): void { onClose(); }
  function hide(): void { onClose(); }
  function clearContext(): void { onClose(); }

  function rejoin(): void {
    if (!networkId || !buf.name) return;
    sendRaw(networkId, 'JOIN ' + buf.name);
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
  function clearBacklog(): void {
    import('../stores/preferences.svelte').then(m => {
      if (networkId && buf.name) m.setClearedAt(networkId, buf.name);
      onClose();
    });
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
      if (key === 'showMembers') {
        onToggleMembers();
      } else {
        // Persist all other toggles per-buffer so they survive a refresh
        setBufferPref(networkId, buf.name, key, toggles[key]);
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
  <div class="contextMenu__wrap" style:max-height="none">
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
      <li class="notifyAll" aria-disabled="false" class:enabled={toggles.notifyAll}>
        <button class="contextMenu__item notifyAll" aria-pressed={toggles.notifyAll} onclick={() => toggle('notifyAll')}>
          {#if toggles.notifyAll}<i class="fa fa-check"></i>{/if}Notify on all messages
        </button>
      </li>
      <li class="muteNotifications" class:enabled={toggles.mute}>
        <button class="contextMenu__item muteNotifications" aria-pressed={toggles.mute} onclick={() => toggle('mute')}>
          {#if toggles.mute}<i class="fa fa-check"></i>{/if}Mute notifications
        </button>
      </li>
      <li class="showJoinPart" class:enabled={toggles.showJoinPart}>
        <button class="contextMenu__item joinpart" aria-pressed={toggles.showJoinPart} onclick={() => toggle('showJoinPart')}>
          {#if toggles.showJoinPart}<i class="fa fa-check"></i>{/if}Show nick changes, joins and parts
        </button>
      </li>
      <li class="collapseJoinPart" aria-disabled="false" class:enabled={toggles.collapsed}>
        <button class="contextMenu__item joinpartcollapse" aria-pressed={toggles.collapsed} onclick={() => toggle('collapsed')}>
          {#if toggles.collapsed}<i class="fa fa-check"></i>{/if}Collapsed
        </button>
      </li>
      <li class="replyCollapse" aria-disabled="false" class:enabled={toggles.replyCollapse}>
        <button class="contextMenu__item replyCollapse" aria-pressed={toggles.replyCollapse} onclick={() => toggle('replyCollapse')}>
          {#if toggles.replyCollapse}<i class="fa fa-check"></i>{/if}Collapse reply threads
        </button>
      </li>
      <li class="replyQuote" aria-disabled="false" class:enabled={toggles.replyQuote}>
        <button class="contextMenu__item replyQuote" aria-pressed={toggles.replyQuote} onclick={() => toggle('replyQuote')}>
          {#if toggles.replyQuote}<i class="fa fa-check"></i>{/if}Show reply quotes
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
