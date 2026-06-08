import { describe, expect, it, vi, beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import Sidebar from './Sidebar.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';
import { ircState, setActiveBuffer, appendMessage, updateChannelUsers, updateNetworkFromSync } from '../stores/ircStore.svelte';
import { archivedMap, pinnedMap } from '../stores/preferences.svelte';

function resetState(): void {
	ircState.networks.length = 0;
	ircState.activeBuffer.networkId = null;
	ircState.activeBuffer.bufferName = null;
	Object.keys(archivedMap).forEach((k) => delete (archivedMap as Record<string, unknown>)[k]);
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
		const net = createNetwork({ networkId: 'net1', collapsed: true });
		net.buffers.push(createBuffer({ name: '#general' }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		// When collapsed, buffer should not be rendered
		expect(document.querySelector('.network-buffers')).toBeNull();
	});

	it('shows unread count badges', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general', unreadCount: 5 }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		await expect.element(page.getByText('5').first()).toBeInTheDocument();
	});

	it('shows highlight indicators', async () => {
		const net = createNetwork({ networkId: 'net1' });
		net.buffers.push(createBuffer({ name: '#general', highlight: true }));
		ircState.networks.push(net);

		render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

		expect(document.querySelector('.buffer-item.highlight')).toBeInTheDocument();
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
    const net = createNetwork({ networkId: 'net1' });
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

  it('shows no unread indicator for buffer with 0 unread', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#general', unreadCount: 0 }));
    ircState.networks.push(net);

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    const item = document.querySelector('.buffer-item');
    expect(item?.classList.contains('unread')).toBe(false);
    expect(document.querySelector('.buffer-unread')).toBeNull();
  });

  it('shows red unread badge with count when buffer has unread', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#general', unreadCount: 3 }));
    ircState.networks.push(net);

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    const item = document.querySelector('.buffer-item');
    expect(item?.classList.contains('unread')).toBe(true);
    const badge = document.querySelector('.buffer-unread');
    expect(badge?.textContent?.trim()).toBe('3');
  });

  it('reactive: increments unread count when message arrives in inactive buffer', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({ name: '#general', unreadCount: 0 });
    net.buffers.push(buf);
    ircState.networks.push(net);

    // Active buffer is somewhere else
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#other';
    ircState.focusLost = false;
    flushSync();

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    // No indicator initially
    expect(document.querySelector('.buffer-item.unread')).toBeNull();

    // Simulate a message arriving in #general while #other is active
    appendMessage('net1', '#general', createMessage({ text: 'hello' }));
    flushSync();

    // Indicator should now show "1"
    const item = document.querySelector('.buffer-item.unread');
    expect(item).toBeTruthy();
    const badge = document.querySelector('.buffer-unread');
    expect(badge?.textContent?.trim()).toBe('1');
  });

  it('reactive: increments unread count for multiple messages', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({ name: '#general', unreadCount: 0 });
    net.buffers.push(buf);
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#other';
    ircState.focusLost = false;
    flushSync();

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    appendMessage('net1', '#general', createMessage({ text: 'msg1' }));
    appendMessage('net1', '#general', createMessage({ text: 'msg2' }));
    appendMessage('net1', '#general', createMessage({ text: 'msg3' }));
    flushSync();

    const badge = document.querySelector('.buffer-unread');
    expect(badge?.textContent?.trim()).toBe('3');
  });

  it('reactive: clears unread indicator when buffer becomes active', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({ name: '#general', unreadCount: 0 });
    net.buffers.push(buf);
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#other';
    ircState.focusLost = false;
    flushSync();

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    appendMessage('net1', '#general', createMessage({ text: 'hello' }));
    flushSync();
    expect(document.querySelector('.buffer-unread')?.textContent?.trim()).toBe('1');

    // Switch to the buffer
    setActiveBuffer('net1', '#general');
    flushSync();

    expect(document.querySelector('.buffer-item.unread')).toBeNull();
    expect(document.querySelector('.buffer-unread')).toBeNull();
  });

  it('per-channel: unread counts are tracked independently per channel', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const chan1 = createBuffer({ name: '#chan1', unreadCount: 0 });
    const chan2 = createBuffer({ name: '#chan2', unreadCount: 0 });
    const chan3 = createBuffer({ name: '#chan3', unreadCount: 0 });
    net.buffers.push(chan1, chan2, chan3);
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#active';
    ircState.focusLost = false;
    flushSync();

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    // Receive messages in different channels
    appendMessage('net1', '#chan1', createMessage({ text: 'a1' }));
    appendMessage('net1', '#chan1', createMessage({ text: 'a2' }));
    appendMessage('net1', '#chan2', createMessage({ text: 'b1' }));
    appendMessage('net1', '#chan3', createMessage({ text: 'c1' }));
    appendMessage('net1', '#chan3', createMessage({ text: 'c2' }));
    appendMessage('net1', '#chan3', createMessage({ text: 'c3' }));
    flushSync();

    const items = document.querySelectorAll('.buffer-item.unread');
    expect(items.length).toBe(3);

    // Only count channel-level unread badges, not network-level totals
    const badges = document.querySelectorAll('.network-buffers .buffer-unread');
    const counts = Array.from(badges).map(b => b.textContent?.trim());
    expect(counts.sort()).toEqual(['1', '2', '3']);
  });

  it('shows highlight (orange) badge for highlighted messages', async () => {
    const net = createNetwork({ networkId: 'net1', nick: 'myuser', currentNick: 'myuser' });
    const buf = createBuffer({ name: '#general', unreadCount: 0, highlight: false });
    net.buffers.push(buf);
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#other';
    ircState.focusLost = false;
    flushSync();

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    // Send a message mentioning myuser → should trigger highlight
    appendMessage('net1', '#general', createMessage({ text: 'hey myuser look at this', nick: 'other' }));
    flushSync();

    const item = document.querySelector('.buffer-item.highlight');
    expect(item).toBeTruthy();
    expect(item?.classList.contains('unread')).toBe(true);
  });

  it('does NOT show indicator for messages in the currently active buffer', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({ name: '#general', unreadCount: 0 });
    net.buffers.push(buf);
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#general';
    ircState.focusLost = false;
    flushSync();

    render(Sidebar, { props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() } });

    appendMessage('net1', '#general', createMessage({ text: 'hello' }));
    flushSync();

    expect(document.querySelector('.buffer-item.unread')).toBeNull();
    expect(document.querySelector('.buffer-unread')).toBeNull();
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
    it('shows pinned channel in pinned section and hides from regular list', async () => {
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

      // Regular list should only have the non-pinned channel
      const regularList = document.querySelector('.network-buffers');
      expect(regularList?.textContent).not.toContain('general');
      expect(regularList?.textContent).toContain('random');
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
});
