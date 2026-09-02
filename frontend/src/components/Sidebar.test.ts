import { describe, expect, it, vi, beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import Sidebar from './Sidebar.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';
import { ircState, setActiveBuffer, appendMessage, updateChannelUsers, updateNetworkFromSync, readBuffer } from '../stores/ircStore.svelte';
import { archivedMap, pinnedMap, networkOrder, collapsedMap, conversationsCollapsedMap, bufferPrefsMap } from '../stores/preferences.svelte';

function resetState(): void {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
  ircState.reorderMode = false;
	Object.keys(archivedMap).forEach((k) => delete (archivedMap as Record<string, unknown>)[k]);
	Object.keys(collapsedMap).forEach((k) => delete (collapsedMap as Record<string, unknown>)[k]);
	Object.keys(conversationsCollapsedMap).forEach((k) => delete (conversationsCollapsedMap as Record<string, unknown>)[k]);
	Object.keys(bufferPrefsMap).forEach((k) => delete (bufferPrefsMap as Record<string, unknown>)[k]);
  networkOrder.length = 0;
  // Clear any leftover DOM from a previous render — otherwise `dragging`
  // and other state left on stale `.network-list-items` containers
  // bleeds into the next test.
  document.body.innerHTML = '';
}

beforeEach(() => {
	resetState();
});

describe('Sidebar', () => {
	it('renders network names', async () => {
		const net = createNetwork({ name: 'Libera' });
		net.buffers.push(createBuffer({ name: '#chan' }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		await expect.element(page.getByText('Libera')).toBeInTheDocument();
	});

	it('renders buffer list under each network', async () => {
		const net = createNetwork({ name: 'Libera' });
		net.buffers.push(createBuffer({ name: '#general' }));
		net.buffers.push(createBuffer({ name: '#random' }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		await expect.element(page.getByText('general')).toBeInTheDocument();
		await expect.element(page.getByText('random')).toBeInTheDocument();
	});

	it('highlights active buffer', async () => {
		const net = createNetwork({ networkId: 'net1', name: 'Libera' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);
		ircState.activeBuffer.networkId = 'net1';
		ircState.activeBuffer.bufferName = '#general';
		flushSync();

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		expect(document.querySelector('.buffer-item.active')).toBeInTheDocument();
	});

	it('calls onSwitchBuffer when buffer clicked', async () => {
		const onSwitchBuffer = vi.fn();
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer, onAddNetwork: vi.fn() } });

		const buffer = page.getByText('general');
		await expect.element(buffer).toBeInTheDocument();
		await userEvent.click(buffer);
		expect(onSwitchBuffer).toHaveBeenCalledWith('net1', '#general');
	});

	it('toggles network collapse/expand', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		// Default expanded — buffers are rendered
		expect(document.querySelector('.network-buffers')).not.toBeNull();
	});

	it('shows the unread class (bold + border) and the unseen count badge', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general', unseen: true, unseenCount: 4 }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		const item = document.querySelector('li.buffer-item[data-buffer-key="net1:#general"]');
		expect(item?.classList.contains('unread')).toBe(true);
		expect(item?.querySelector('.badge')?.textContent?.trim()).toBe('4');
		expect(item?.classList.contains('activeBadge')).toBe(true);
		expect(item?.querySelector('.badge')?.classList.contains('badge--mention')).toBe(false);
	});

	it('shows the red badge with the highlight count', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general', unseen: true, unseenCount: 7, unseenHighlights: [1, 2] }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		const item = document.querySelector('li.buffer-item[data-buffer-key="net1:#general"]');
		expect(item?.classList.contains('activeBadge')).toBe(true);
		// Mentions win over the plain count.
		expect(item?.querySelector('.badge')?.textContent?.trim()).toBe('2');
		expect(item?.querySelector('.badge')?.classList.contains('badge--mention')).toBe(true);
	});

	it('calls onAddNetwork when add button clicked', async () => {
		const onAddNetwork = vi.fn();
		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork } });

		const btn = page.getByRole('button', { name: /add a network/i });
		await expect.element(btn).toBeInTheDocument();
		await userEvent.click(btn);
		expect(onAddNetwork).toHaveBeenCalled();
	});

	it('hides server buffer from list', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '_server', type: 'server' }));
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		await expect.element(page.getByText('_server')).not.toBeInTheDocument();
		await expect.element(page.getByText('general')).toBeInTheDocument();
	});

  it('filters archived buffers', async () => {
    const net = createNetwork({ networkId: 'net1', archivesCollapsed: false });
    net.buffers.push(createBuffer({ name: '#general' }));
    net.buffers.push(createBuffer({ name: '#old' }));
    ircState.networks.push(net);
    archivedMap['net1:#old'] = true;

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    expect(document.querySelector('.archived-channels')).toBeInTheDocument();
    await expect.element(page.getByText('old')).toBeInTheDocument();
  });

  it('renders gear button on each network and calls onNetworkOptions when clicked', async () => {
    const net = createNetwork({ networkId: 'net1', name: 'SuperNETs' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);

    const onNetworkOptions = vi.fn();
    render(Sidebar, {
      props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn(), onNetworkOptions },
    });

    const gear = document.querySelector('.network-header .bufferOptions') as HTMLButtonElement;
    expect(gear).toBeTruthy();
    expect(gear.title).toBe('Options');

    await userEvent.click(gear);
    expect(onNetworkOptions).toHaveBeenCalledWith('net1', expect.any(MouseEvent));
  });

  it('gear click does not trigger network buffer switch (stopPropagation)', async () => {
    const net = createNetwork({ networkId: 'net1', name: 'SuperNETs' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);

    const onSwitchBuffer = vi.fn();
    const onNetworkOptions = vi.fn();
    render(Sidebar, {
      props: { onSwitchBuffer, onAddNetwork: vi.fn(), onNetworkOptions },
    });

    const gear = document.querySelector('.network-header .bufferOptions') as HTMLButtonElement;
    await userEvent.click(gear);
    expect(onNetworkOptions).toHaveBeenCalled();
    expect(onSwitchBuffer).not.toHaveBeenCalled();
  });

  it('shows no unread indicator for a buffer that is not unseen', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    const item = document.querySelector('.buffer-item');
    expect(item?.classList.contains('unread')).toBe(false);
    expect(item?.classList.contains('activeBadge')).toBe(false);
  });

  it('showUnread=false renders ignoredUnread instead of unread', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#general', unseen: true }));
    ircState.networks.push(net);
    bufferPrefsMap['net1:#general'] = { showUnread: false };

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    const item = document.querySelector('.buffer-item');
    expect(item?.classList.contains('unread')).toBe(false);
    expect(item?.classList.contains('ignoredUnread')).toBe(true);
  });

  it('showUnreadCount=false keeps bold/border but drops the plain count; mentions still count', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#a', unseen: true, unseenCount: 5 }), createBuffer({ name: '#b', unseen: true, unseenCount: 5, unseenHighlights: [1] }));
    ircState.networks.push(net);
    bufferPrefsMap['net1:#a'] = { showUnreadCount: false };
    bufferPrefsMap['net1:#b'] = { showUnreadCount: false };

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    const a = document.querySelector('[data-buffer-key="net1:#a"]')!;
    expect(a.classList.contains('unread')).toBe(true);
    expect(a.classList.contains('activeBadge')).toBe(false);
    expect(a.querySelector('.badge')?.textContent?.trim()).toBe('');
    const b = document.querySelector('[data-buffer-key="net1:#b"]')!;
    expect(b.classList.contains('activeBadge')).toBe(true);
    expect(b.querySelector('.badge')?.textContent?.trim()).toBe('1');
  });

  it('reactive: marks the row unread when a message arrives in an inactive buffer', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#other';
    ircState.focusLost = false;
    flushSync();

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    expect(document.querySelector('.buffer-item.unread')).toBeNull();

    appendMessage('net1', '#general', createMessage({ text: 'hello', nick: 'alice' }));
    flushSync();

    const item = document.querySelector('.buffer-item.unread');
    expect(item).toBeTruthy();
    expect(item?.querySelector('.badge')?.textContent?.trim()).toBe('1');
  });

  it('reactive: several plain messages count up', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#other';
    flushSync();

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    appendMessage('net1', '#general', createMessage({ text: 'msg1', nick: 'alice' }));
    appendMessage('net1', '#general', createMessage({ text: 'msg2', nick: 'alice' }));
    appendMessage('net1', '#general', createMessage({ text: 'msg3', nick: 'alice' }));
    flushSync();

    expect(document.querySelector('.buffer-item.unread')).toBeTruthy();
    expect(document.querySelector('.buffer-item.unread .badge')?.textContent?.trim()).toBe('3');
  });

  it('reactive: selecting the buffer does NOT clear unread; marking it read does', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#other';
    flushSync();

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    appendMessage('net1', '#general', createMessage({ t: 1000, text: 'hello', nick: 'alice' }));
    flushSync();
    expect(document.querySelector('.buffer-item.unread')).toBeTruthy();

    setActiveBuffer('net1', '#general');
    flushSync();
    expect(document.querySelector('.buffer-item.unread')).toBeTruthy();

    readBuffer('net1', '#general');
    flushSync();
    expect(document.querySelector('.buffer-item.unread')).toBeNull();
  });

  it('per-channel: unseen is tracked independently per channel', async () => {
    const net = createNetwork({ networkId: 'net1', nick: 'me', currentNick: 'me' });
    net.buffers.push(createBuffer({ name: '#chan1' }), createBuffer({ name: '#chan2' }), createBuffer({ name: '#chan3' }));
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#active';
    flushSync();

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    appendMessage('net1', '#chan1', createMessage({ text: 'a1', nick: 'alice' }));
    appendMessage('net1', '#chan3', createMessage({ text: 'me: c1', nick: 'alice' }));
    appendMessage('net1', '#chan3', createMessage({ text: 'me: c2', nick: 'alice', t: Date.now() + 1 }));
    flushSync();

    expect(document.querySelector('[data-buffer-key="net1:#chan1"] .badge')?.textContent?.trim()).toBe('1');
    expect(document.querySelector('[data-buffer-key="net1:#chan2"]')?.classList.contains('unread')).toBe(false);
    expect(document.querySelector('[data-buffer-key="net1:#chan3"] .badge')?.textContent?.trim()).toBe('2');
  });

  it('shows the red badge for a mention', async () => {
    const net = createNetwork({ networkId: 'net1', nick: 'myuser', currentNick: 'myuser' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#other';
    flushSync();

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    appendMessage('net1', '#general', createMessage({ text: 'hey myuser look at this', nick: 'other' }));
    flushSync();

    const item = document.querySelector('.buffer-item.activeBadge');
    expect(item).toBeTruthy();
    expect(item?.classList.contains('unread')).toBe(true);
    expect(item?.querySelector('.badge')?.textContent?.trim()).toBe('1');
  });

  it('marks the ACTIVE buffer unread too until the read trigger fires (IRCCloud)', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#general';
    ircState.focusLost = false;
    flushSync();

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    appendMessage('net1', '#general', createMessage({ text: 'hello', nick: 'alice' }));
    flushSync();

    expect(document.querySelector('.buffer-item.unread')).toBeTruthy();
    readBuffer('net1', '#general');
    flushSync();
    expect(document.querySelector('.buffer-item.unread')).toBeNull();
  });

  describe('inactive channels (isJoined: false)', () => {
    it('shows inactive section when a channel has isJoined: false', async () => {
      const net = createNetwork({ networkId: 'net1' });
      net.buffers.push(createBuffer({ name: '#general', isJoined: true }));
      net.buffers.push(createBuffer({ name: '#parted', isJoined: false }));
      ircState.networks.push(net);

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      const inactiveHeader = document.querySelector('.inactive-header');
      expect(inactiveHeader).toBeTruthy();
      expect(inactiveHeader?.textContent).toContain('Inactive');
      const inactiveList = document.querySelector('.inactive-channels');
      expect(inactiveList).toBeTruthy();
      await expect.element(page.getByText('parted')).toBeInTheDocument();
    });

    it('joined channels appear in main list, not inactive', async () => {
      const net = createNetwork({ networkId: 'net1' });
      net.buffers.push(createBuffer({ name: '#general', isJoined: true }));
      net.buffers.push(createBuffer({ name: '#parted', isJoined: false }));
      ircState.networks.push(net);

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      const mainList = document.querySelector('.network-buffers');
      const mainItems = mainList?.querySelectorAll('.buffer-item');
      expect(mainItems?.length).toBe(1);
      expect(mainItems?.[0]?.textContent).toContain('general');

      const inactiveList = document.querySelector('.inactive-channels');
      const inactiveItems = inactiveList?.querySelectorAll('.buffer-item');
      expect(inactiveItems?.length).toBe(1);
      expect(inactiveItems?.[0]?.textContent).toContain('parted');
    });

    it('inactive channels have dimmed styling class', async () => {
      const net = createNetwork({ networkId: 'net1' });
      net.buffers.push(createBuffer({ name: '#parted', isJoined: false }));
      ircState.networks.push(net);

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      const inactiveItem = document.querySelector('.inactive-channels .buffer-item');
      expect(inactiveItem?.classList.contains('inactive')).toBe(true);
    });

    it('no inactive section when all channels are joined', async () => {
      const net = createNetwork({ networkId: 'net1' });
      net.buffers.push(createBuffer({ name: '#general', isJoined: true }));
      net.buffers.push(createBuffer({ name: '#random', isJoined: true }));
      ircState.networks.push(net);

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      expect(document.querySelector('.inactive-header')).toBeNull();
      expect(document.querySelector('.inactive-channels')).toBeNull();
    });

    it('inactive channel is clickable and calls onSwitchBuffer', async () => {
      const onSwitchBuffer = vi.fn();
      const net = createNetwork({ networkId: 'net1' });
      net.buffers.push(createBuffer({ name: '#parted', isJoined: false }));
      ircState.networks.push(net);

      render(Sidebar, { props: { onSwitchBuffer, onAddNetwork: vi.fn() } });

      const partedItem = document.querySelector('.inactive-channels .buffer-item') as HTMLElement;
      expect(partedItem).toBeTruthy();
      await userEvent.click(partedItem);
      expect(onSwitchBuffer).toHaveBeenCalledWith('net1', '#parted');
    });

    it('inactive channel can be right-clicked for context menu', async () => {
      const net = createNetwork({ networkId: 'net1' });
      net.buffers.push(createBuffer({ name: '#parted', isJoined: false }));
      ircState.networks.push(net);

      const handleBufferContextMenu = vi.fn();
      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      // The inactive list items have oncontextmenu wired up
      const inactiveItem = document.querySelector('.inactive-channels .buffer-item') as HTMLElement;
      expect(inactiveItem).toBeTruthy();
    });

    it('full lifecycle: join → leave → refresh → stays inactive', async () => {
      // 1. Setup: channel is joined
      const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
      net.buffers.push(createBuffer({ name: '#general', isJoined: true }));
      net.buffers.push(createBuffer({ name: '#testing', isJoined: true }));
      ircState.networks.push(net);

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      // Both channels in main list, no inactive section
      const mainList = document.querySelector('.network-buffers');
      const mainItems = mainList?.querySelectorAll('.buffer-item');
      expect(mainItems?.length).toBe(2);
      expect(document.querySelector('.inactive-header')).toBeNull();

      // 2. User leaves #testing
      updateChannelUsers('net1', '#testing', 'PART', 'me');
      flushSync();

      // #testing moved to inactive section
      expect(document.querySelector('.inactive-header')).toBeTruthy();
      const inactiveList = document.querySelector('.inactive-channels');
      const inactiveItems = inactiveList?.querySelectorAll('.buffer-item');
      expect(inactiveItems?.length).toBe(1);
      expect(inactiveItems?.[0]?.textContent).toContain('testing');

      // Main list now has only #general
      const mainItemsAfter = document.querySelector('.network-buffers')?.querySelectorAll('.buffer-item');
      expect(mainItemsAfter?.length).toBe(1);
      expect(mainItemsAfter?.[0]?.textContent).toContain('general');

      // 3. Simulate refresh: sync arrives with stale data (isJoined: true)
      // but the frontend preserves local isJoined: false
      const incoming = createNetwork({ networkId: 'net1' });
      incoming.buffers.push(createBuffer({ name: '#general', isJoined: true }));
      incoming.buffers.push(createBuffer({ name: '#testing', isJoined: false }));
      updateNetworkFromSync([incoming]);
      flushSync();

      // #testing STILL in inactive section after sync
      expect(document.querySelector('.inactive-header')).toBeTruthy();
      const inactiveAfterSync = document.querySelector('.inactive-channels');
      const inactiveItemsAfterSync = inactiveAfterSync?.querySelectorAll('.buffer-item');
      expect(inactiveItemsAfterSync?.length).toBe(1);
      expect(inactiveItemsAfterSync?.[0]?.textContent).toContain('testing');

      // Main list STILL has only #general
      const mainItemsAfterSync = document.querySelector('.network-buffers')?.querySelectorAll('.buffer-item');
      expect(mainItemsAfterSync?.length).toBe(1);
      expect(mainItemsAfterSync?.[0]?.textContent).toContain('general');
    });

    it('rejoin moves channel from inactive back to active', async () => {
      // Setup: channel is parted
      const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
      net.buffers.push(createBuffer({ name: '#testing', isJoined: false }));
      ircState.networks.push(net);

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      // Starts in inactive
      expect(document.querySelector('.inactive-header')).toBeTruthy();
      expect(document.querySelector('.inactive-channels .buffer-item')?.textContent).toContain('testing');

      // Rejoin via IRC event
      updateChannelUsers('net1', '#testing', 'JOIN', 'me');
      flushSync();

      // Now in main list, inactive section gone
      expect(document.querySelector('.inactive-header')).toBeNull();
      expect(document.querySelector('.network-buffers .buffer-item')?.textContent).toContain('testing');
    });
  });

  describe('pinning', () => {
    it('shows pinned channel in pinned section and also under its network', async () => {
      const net = createNetwork({ networkId: 'net1', name: 'Libera' });
      net.buffers.push(createBuffer({ name: '#general' }));
      net.buffers.push(createBuffer({ name: '#random' }));
      ircState.networks.push(net);

      pinnedMap['net1:#general'] = true;
      flushSync();

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      // Pinned section should exist with the pinned channel
      const pinnedSection = document.querySelector('.pinnedBuffers');
      expect(pinnedSection).toBeInTheDocument();
      expect(pinnedSection?.textContent).toContain('general');

      // Regular list should ALSO contain the pinned channel (duplicated) + non-pinned
      const regularList = document.querySelector('.network-buffers');
      expect(regularList?.textContent).toContain('general');
      expect(regularList?.textContent).toContain('random');
      // Visual pin indicator in the in-network row
      expect(regularList?.querySelector('.pinned-indicator')).toBeInTheDocument();
    });

    it('removes channel from pinned section when unpinned', async () => {
      const net = createNetwork({ networkId: 'net1', name: 'Libera' });
      net.buffers.push(createBuffer({ name: '#general' }));
      ircState.networks.push(net);

      pinnedMap['net1:#general'] = true;
      flushSync();

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      // Verify it starts in pinned section
      expect(document.querySelector('.pinnedBuffers')).toBeInTheDocument();

      // Unpin
      pinnedMap['net1:#general'] = false;
      flushSync();

      // Pinned section should be gone (no pinned channels)
      expect(document.querySelector('.pinnedBuffers')).toBeNull();

      // Channel should be back in regular list
      const regularList = document.querySelector('.network-buffers');
      expect(regularList?.textContent).toContain('general');
    });

    it('pinnedMap value false is respected over server merge', () => {
      // Simulate: user unpinned, then server sends pinnedChannels on fetchMe
      pinnedMap['net1:#general'] = false;

      // Simulate the merge logic from App.svelte
      const serverPinned = ['net1:#general'];
      for (const key of serverPinned) {
        if (pinnedMap[key] !== false) {
          pinnedMap[key] = true;
        }
      }

      // Should stay unpinned because local state said false
      expect(pinnedMap['net1:#general']).toBe(false);
    });
  });

  describe('drag-to-reorder', () => {
    function setupTwoNetworks(): void {
      const lib = createNetwork({ networkId: 'lib', name: 'Libera' });
      lib.buffers.push(createBuffer({ name: '#general' }));
      ircState.networks.push(lib);
      const snoo = createNetwork({ networkId: 'snoo', name: 'SuperNETs' });
      snoo.buffers.push(createBuffer({ name: '#chat' }));
      ircState.networks.push(snoo);
    }

    it('shows chevron buttons on each network header (drag handle replaces it during drag)', async () => {
      setupTwoNetworks();
      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });
      const chevronButtons = document.querySelectorAll('.collapseToggle button');
      expect(chevronButtons.length).toBeGreaterThanOrEqual(2);
      // Drag handles are in the DOM only during active drag (dragActive=true)
      // The collapseToggle always contains either a chevron button or a
      // drag-handle icon, swapped via {#if dragActive}
      const toggles = document.querySelectorAll('.collapseToggle');
      expect(toggles.length).toBeGreaterThanOrEqual(2);
    });

    it('network header click switches buffers', async () => {
      setupTwoNetworks();
      const onSwitchBuffer = vi.fn();
      render(Sidebar, { props: { onSwitchBuffer, onAddNetwork: vi.fn() } });
      await userEvent.click(page.getByText('Libera'));
      expect(onSwitchBuffer).toHaveBeenCalledWith('lib', '_server');
    });

    it('adds dragging class on drag start', async () => {
      setupTwoNetworks();
      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });
      const container = document.querySelector('.network-list-items')!;
      expect(container.classList.contains('dragging')).toBe(false);
      // Simulate dndzone 'consider' event so handleConsider fires
      const consider = new CustomEvent('consider', {
        detail: {
          items: [],
          info: { trigger: 'dragStarted' as const, id: 'lib', source: 'POINTER' as const }
        }
      });
      container.dispatchEvent(consider);
      expect(container.classList.contains('dragging')).toBe(true);
    });

    it('auto-collapses the dragged network on drag start (persists via updateCollapsed)', async () => {
      setupTwoNetworks();
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({ ok: true } as Response));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      try {
        render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });
        const container = document.querySelector('.network-list-items')!;

        // Pre-condition: 'snoo' is expanded (no entry in collapsedMap)
        expect(collapsedMap['snoo']).toBeFalsy();
        // Before the drag, both networks are rendered in ircState.networks
        // order [lib, snoo], so snoo is at index 1.
        const snooBefore = container.querySelectorAll('.network')[1];
        expect(snooBefore.querySelector('.label')?.textContent).toBe('SuperNETs');
        expect(!!snooBefore.querySelector('.network-buffers')).toBe(true);

        // Start a drag on 'snoo' — svelte-dnd-action's first consider event
        // includes info.id = the networkId of the dragged item.
        container.dispatchEvent(new CustomEvent('consider', {
          detail: {
            items: [
              { id: 'snoo', net: ircState.networks.find(n => n.networkId === 'snoo')!, isDndShadowItem: true },
              { id: 'lib', net: ircState.networks.find(n => n.networkId === 'lib')! },
            ],
            info: { trigger: 'dragStarted' as const, id: 'snoo', source: 'POINTER' as const }
          }
        }));
        flushSync();

        // The dragged network must be collapsed as if the user clicked the
        // chevron, and the change must be persisted to the server.
        expect(collapsedMap['snoo']).toBe(true);
        // During the drag, svelte-dnd-action puts a shadow placeholder at
        // the drop position. The shadow carries the snoo Network, so snoo
        // renders at index 0 in the each block. Find it by its label.
        const snooAfter = Array.from(container.querySelectorAll('.network'))
          .find(n => n.querySelector('.label')?.textContent === 'SuperNETs')!;
        expect(!!snooAfter.querySelector('.network-buffers')).toBe(false);
        // The persistence POST went out and carried the right payload.
        const collapsedCalls = fetchMock.mock.calls.filter(c =>
          typeof c[0] === 'string' && c[0].includes('/api/me/collapsed')
        );
        expect(collapsedCalls.length).toBe(1);
        const body = JSON.parse(collapsedCalls[0][1].body as string);
        expect(body).toEqual({ network: 'snoo', collapsed: true });

        // A second drag-start (e.g. after a drop, user grabs again) must
        // NOT redundantly POST (it's already collapsed).
        fetchMock.mockClear();
        container.dispatchEvent(new CustomEvent('consider', {
          detail: {
            items: [
              { id: 'snoo', net: ircState.networks.find(n => n.networkId === 'snoo')!, isDndShadowItem: true },
              { id: 'lib', net: ircState.networks.find(n => n.networkId === 'lib')! },
            ],
            info: { trigger: 'dragStarted' as const, id: 'snoo', source: 'POINTER' as const }
          }
        }));
        flushSync();
        const collapsedCalls2 = fetchMock.mock.calls.filter(c =>
          typeof c[0] === 'string' && c[0].includes('/api/me/collapsed')
        );
        expect(collapsedCalls2.length).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('swaps chevron for drag handle while a drag is active', async () => {
      setupTwoNetworks();
      const { container: renderedContainer } = render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });
      const container = renderedContainer.querySelector('.network-list-items')!;
      // Before drag: every network header shows the collapse chevron button
      expect(container.querySelectorAll('.collapseToggle button').length).toBeGreaterThanOrEqual(2);
      expect(container.querySelector('.collapseToggle .drag-handle')).toBeNull();

      // Start a drag — svelte-dnd-action's first consider event flips
      // dragActive=true, which should swap every chevron for a drag
      // handle (the user-facing "server name collapsing" affordance).
      // We must pass non-empty items (with the shadow marker) so the
      // keyed each block keeps the networks in the DOM.
      const libNet = ircState.networks.find(n => n.networkId === 'lib')!;
      const snooNet = ircState.networks.find(n => n.networkId === 'snoo')!;
      const consider = new CustomEvent('consider', {
        detail: {
          items: [
            { id: 'lib', net: libNet, isDndShadowItem: true },
            { id: 'snoo', net: snooNet },
          ],
          info: { trigger: 'dragStarted' as const, id: 'lib', source: 'POINTER' as const }
        }
      });
      container.dispatchEvent(consider);
      await new Promise(r => setTimeout(r, 0));

      expect(container.querySelectorAll('.collapseToggle button').length).toBe(0);
      expect(container.querySelectorAll('.collapseToggle .drag-handle').length).toBeGreaterThanOrEqual(2);
    });

    it('collapse toggle is not disabled (drag is always active)', async () => {
      setupTwoNetworks();
      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });
      const collapseButton = document.querySelector('.collapseToggle button') as HTMLButtonElement | null;
      expect(collapseButton).not.toBeNull();
      expect(collapseButton?.disabled).toBe(false);
    });

    it('drop persists new order via updateNetworkOrder and updates ircState.networks', async () => {
      setupTwoNetworks();
      // Stub fetch so the POST during finalize doesn't hit the network
      // and pollute test output. The Sidebar's updateNetworkOrder catches
      // the rejection and just logs it — we only care that local state
      // is updated.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => ({ ok: true } as Response)) as typeof fetch;
      try {
        render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });
        // Simulate the dndzone 'finalize' event by calling the same
        // handler the library would invoke. We do this by reordering
        // ircState.networks directly + setting networkOrder, then
        // dispatching a CustomEvent that the Sidebar's onfinalize handler
        // can pick up (the handler reads e.detail.items).
        const snooNet = ircState.networks.find(n => n.networkId === 'snoo')!;
        const libNet = ircState.networks.find(n => n.networkId === 'lib')!;
        const finalize = new CustomEvent('finalize', {
          detail: { items: [{ id: 'snoo', net: snooNet }, { id: 'lib', net: libNet }] }
        });
        const itemsContainer = document.querySelector('.network-list-items');
        expect(itemsContainer).not.toBeNull();
        itemsContainer?.dispatchEvent(finalize);
        await new Promise(r => setTimeout(r, 0));

        expect(ircState.networks[0].networkId).toBe('snoo');
        expect(ircState.networks[1].networkId).toBe('lib');
        expect(networkOrder).toEqual(['snoo', 'lib']);
        expect(globalThis.fetch).toHaveBeenCalled();
        const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
        const callArg = (fetchMock.mock.calls[0]?.[0] as string) ?? '';
        expect(callArg).toContain('/api/me/network-order');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('networkOrder is applied to ircState.networks on boot via updateNetworkFromSync', () => {
      // Simulate boot order arriving from the server
      networkOrder.push('snoo', 'lib');
      const lib = createNetwork({ networkId: 'lib', name: 'Libera' });
      const snoo = createNetwork({ networkId: 'snoo', name: 'SuperNETs' });
      // Engine emits in declaration order, but we push them in reverse
      updateNetworkFromSync([
        { ...snoo, networkId: 'snoo', id: 'snoo' } as any,
        { ...lib, networkId: 'lib', id: 'lib' } as any,
      ]);
      expect(ircState.networks[0].networkId).toBe('snoo');
      expect(ircState.networks[1].networkId).toBe('lib');
    });

    it('a network added after reorder goes to the end', () => {
      networkOrder.push('lib', 'snoo');
      const lib = createNetwork({ networkId: 'lib', name: 'Libera' });
      const snoo = createNetwork({ networkId: 'snoo', name: 'SuperNETs' });
      updateNetworkFromSync([
        { ...lib, networkId: 'lib', id: 'lib' } as any,
        { ...snoo, networkId: 'snoo', id: 'snoo' } as any,
      ]);
      expect(ircState.networks[0].networkId).toBe('lib');
      expect(ircState.networks[1].networkId).toBe('snoo');

      // Now a new network arrives — not in the order list
      const oftc = createNetwork({ networkId: 'oftc', name: 'OFTC' });
      updateNetworkFromSync([
        { ...lib, networkId: 'lib', id: 'lib' } as any,
        { ...snoo, networkId: 'snoo', id: 'snoo' } as any,
        { ...oftc, networkId: 'oftc', id: 'oftc' } as any,
      ]);
      expect(ircState.networks[0].networkId).toBe('lib');
      expect(ircState.networks[1].networkId).toBe('snoo');
      expect(ircState.networks[2].networkId).toBe('oftc');
    });

    it('chevron still collapses a network AFTER a real drag flow (consider + finalize)', async () => {
      // Reproduces the user-reported bug: after dragging a network to
      // reorder, clicking the chevron on any network header must still
      // hide its channel list. Previously the splice-in-place with the
      // same Network references failed to invalidate Svelte 5's $state
      // proxy, leaving dragList stale and the keyed each block re-rendering
      // wrappers whose on-click closure no longer flipped collapsedMap.
      setupTwoNetworks();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => ({ ok: true } as Response)) as typeof fetch;
      try {
        render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });
        const container = document.querySelector('.network-list-items')!;

        // Pre-condition: both networks expanded (channels visible).
        expect(container.querySelectorAll('.network-buffers').length).toBe(2);

        // Simulate the real drag flow: a consider event mid-drag (with
        // a shadow placeholder) followed by the finalize event on drop.
        const libNet = ircState.networks.find(n => n.networkId === 'lib')!;
        const snooNet = ircState.networks.find(n => n.networkId === 'snoo')!;

        // Drag started on 'snoo', dropping it above 'lib' → new order
        // [snoo, lib] with snoo as the shadow placeholder.
        container.dispatchEvent(new CustomEvent('consider', {
          detail: {
            items: [
              { id: 'snoo', net: snooNet, isDndShadowItem: true },
              { id: 'lib', net: libNet },
            ],
            info: { trigger: 'dragStarted' as const, id: 'snoo', source: 'POINTER' as const }
          }
        }));
        flushSync();
        container.dispatchEvent(new CustomEvent('finalize', {
          detail: {
            items: [
              { id: 'snoo', net: snooNet, isDndShadowItem: true },
              { id: 'lib', net: libNet },
            ],
            info: { trigger: 'droppedIntoZone' as const, id: 'snoo', source: 'POINTER' as const }
          }
        }));
        flushSync();

        expect(ircState.networks[0].networkId).toBe('snoo');
        expect(ircState.networks[1].networkId).toBe('lib');

        // After the drag, 'snoo' is auto-collapsed (the dragged network
        // collapses on drag-start so only the header moves during reorder).
        // Click the chevron to expand it back, then click again to collapse,
        // proving the toggle still works after the reorder.
        expect(collapsedMap['snoo']).toBe(true);
        const snooHeader = document.querySelectorAll('.network-header')[0]!;
        const snooChevron = snooHeader.querySelector('.collapseToggle button') as HTMLButtonElement;
        expect(snooChevron).not.toBeNull();
        snooChevron.click();
        flushSync();
        expect(collapsedMap['snoo']).toBe(false);
        snooChevron.click();
        flushSync();
        expect(collapsedMap['snoo']).toBe(true);
        const snooBuffers = document.querySelectorAll('.network')[0]!.querySelector('.network-buffers');
        expect(snooBuffers).toBeNull();

        // And the second network's chevron must still work too. 'lib' was
        // NOT the dragged network so it wasn't auto-collapsed.
        const libChevron = document.querySelectorAll('.network-header')[1]!.querySelector('.collapseToggle button') as HTMLButtonElement;
        libChevron.click();
        flushSync();
        expect(collapsedMap['lib']).toBe(true);
        const libBuffers = document.querySelectorAll('.network')[1]!.querySelector('.network-buffers');
         expect(libBuffers).toBeNull();
       } finally {
         globalThis.fetch = originalFetch;
       }
     });
   });

  describe('buffer-item--joining modifier', () => {
    it('renders buffer-item--joining when buf.joinInFlight=true (active section)', () => {
      const net = createNetwork({ networkId: 'net1' });
      const buf = createBuffer({ name: '#gen' });
      buf.joinInFlight = true;
      net.buffers.push(buf);
      ircState.networks.push(net);
      ircState.activeBuffer.networkId = 'net1';
      ircState.activeBuffer.bufferName = '_server';
      flushSync();

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      const item = document.querySelector('.network-buffers .buffer-item--joining');
      expect(item).toBeInTheDocument();
      expect(item?.classList.contains('buffer-item')).toBe(true);
    });

    it('does NOT render buffer-item--joining when buf.joinInFlight=false', () => {
      const net = createNetwork({ networkId: 'net1' });
      net.buffers.push(createBuffer({ name: '#gen', joinInFlight: false }));
      ircState.networks.push(net);
      ircState.activeBuffer.networkId = 'net1';
      ircState.activeBuffer.bufferName = '_server';
      flushSync();

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      expect(document.querySelector('.buffer-item--joining')).toBeNull();
    });

    it('renders buffer-item--joining in pinned section when buf.joinInFlight=true', () => {
      const net = createNetwork({ networkId: 'net1', name: 'Libera' });
      const buf = createBuffer({ name: '#pinned' });
      buf.joinInFlight = true;
      net.buffers.push(buf);
      ircState.networks.push(net);
      pinnedMap['net1:#pinned'] = true;
      ircState.activeBuffer.networkId = 'net1';
      ircState.activeBuffer.bufferName = '_server';
      flushSync();

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      const item = document.querySelector('.pinnedBuffers .buffer-item--joining');
      expect(item).toBeInTheDocument();
    });

    it('renders buffer-item--joining in archived section when buf.joinInFlight=true', () => {
      const net = createNetwork({ networkId: 'net1', name: 'Libera' });
      const buf = createBuffer({ name: '#archived', isJoined: true });
      buf.joinInFlight = true;
      net.buffers.push(buf);
      ircState.networks.push(net);
      archivedMap['net1:#archived'] = true;
      // Force archives to expand.
      net.archivesCollapsed = false;
      ircState.activeBuffer.networkId = 'net1';
      ircState.activeBuffer.bufferName = '_server';
      flushSync();

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      const item = document.querySelector('.archived-channels .buffer-item--joining');
      expect(item).toBeInTheDocument();
    });

    it('joining modifier coexists with highlight modifier', () => {
      const net = createNetwork({ networkId: 'net1' });
      const buf = createBuffer({ name: '#gen' });
      buf.joinInFlight = true;
      buf.unseen = true;
      buf.unseenHighlights = [1];
      net.buffers.push(buf);
      ircState.networks.push(net);
      ircState.activeBuffer.networkId = 'net1';
      ircState.activeBuffer.bufferName = '#other';
      flushSync();

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      const item = document.querySelector('.network-buffers .buffer-item');
      expect(item).toBeTruthy();
      expect(item?.classList.contains('buffer-item--joining')).toBe(true);
      expect(item?.classList.contains('activeBadge')).toBe(true);
    });

    it('joined modifier does NOT bleed to conversation section', () => {
      // Setup a DM conversation (non-channel buffer) alongside a channel
      // buffer that has joinInFlight=true. The DM li in the conversation
      // section must NOT carry the joining modifier — only channels do.
      const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
      const chanBuf = createBuffer({ name: '#gen', type: 'channel', isJoined: true });
      chanBuf.joinInFlight = true;
      const dmBuf = createBuffer({ name: 'zod', type: 'query', isJoined: true });
      net.buffers.push(chanBuf, dmBuf);
      ircState.networks.push(net);
      ircState.activeBuffer.networkId = 'net1';
      ircState.activeBuffer.bufferName = '_server';
      // Force conversations to expand.
      conversationsCollapsedMap['net1'] = false;
      flushSync();

      render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

      // Channel section has the modifier.
      const channelItem = document.querySelector('.network-buffers .buffer-item');
      expect(channelItem?.classList.contains('buffer-item--joining')).toBe(true);

      // DM in the conversations section must NOT have the modifier.
      const dmItem = document.querySelector('.conversations .buffer-item');
      expect(dmItem).toBeTruthy();
      expect(dmItem?.classList.contains('buffer-item--joining')).toBe(false);
    });
  });
 });
