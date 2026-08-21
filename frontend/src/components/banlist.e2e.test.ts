import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { page, userEvent } from 'vitest/browser';
import ChannelContextMenu from './ChannelContextMenu.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork, createBuffer } from '../test/factories';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
  setMaxEid: vi.fn(),
  maxEidTracker: { value: 0 },
  wsState: { value: 'disconnected' },
  startXHRFallback: vi.fn(),
  stopXHRFallback: vi.fn(),
  onStreamState: vi.fn(() => () => {}),
  sendRequest: vi.fn(async () => ({})),
  connectWebSocket: vi.fn(),
  disconnectWebSocket: vi.fn(),
  isConnected: vi.fn(() => false),
  sendMessage: vi.fn(),
  sendEditMessage: vi.fn(),
  sendJson: vi.fn(),
  requestSync: vi.fn(),
  requestSwitchBuffer: vi.fn(),
}));

import { sendRaw } from '/src/stores/wsConnection.svelte.ts';
const sendRawMock = sendRaw as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  sendRawMock.mockClear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Ban List — ChannelContextMenu', () => {
  it('clicking Ban list sends MODE +b to correct network', async () => {
    // Setup two networks, active is net1, but menu is for net2
    const net1 = createNetwork({ networkId: 'net1', name: 'Net1', connected: true });
    net1.buffers.push(createBuffer({ name: '#active', type: 'channel', isJoined: true }));
    const net2 = createNetwork({ networkId: 'net2', name: 'Net2', connected: true });
    const banChannel = createBuffer({ name: '#banchannel', type: 'channel', isJoined: true });
    net2.buffers.push(banChannel);
    ircState.networks.push(net1, net2);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#active';

    // Render menu for net2's channel, but active is net1
    // Current ChannelContextMenu derives network from getActiveNetwork() (net1), so it will be wrong
    // After fix, it should use the menu's networkId
    const onClose = vi.fn();
    const onToggleMembers = vi.fn();

    // We need to pass buf that is from net2, but component will derive network as net1
    // To test the bug, we need to check what sendRaw is called with
    render(ChannelContextMenu, {
      props: {
        x: 100,
        y: 100,
        buf: banChannel,
        networkId: 'net2',
        onClose,
        onToggleMembers,
        memberPanelOpen: true,
      },
    } as any);

    await tick();

    const banBtn = document.querySelector('button.bans') as HTMLButtonElement | null;
    expect(banBtn).toBeTruthy();
    if (!banBtn) return;

    await userEvent.click(banBtn);
    await tick();

    // Should have called sendRaw with net2's id and #banchannel
    // Before fix, it would call with net1 (active) or empty
    expect(sendRawMock).toHaveBeenCalled();
    const calledWith = sendRawMock.mock.calls[0];
    // calledWith[0] is networkId, [1] is raw command
    expect(calledWith[0]).toBe('net2');
    expect(calledWith[1]).toBe('MODE #banchannel +b');
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking Ban list when no network does nothing (guard)', async () => {
    // No networks, active is null
    const banChannel = createBuffer({ name: '#lonely', type: 'channel', isJoined: true });
    render(ChannelContextMenu, {
      props: {
        x: 100,
        y: 100,
        buf: banChannel,
        onClose: vi.fn(),
        onToggleMembers: vi.fn(),
        memberPanelOpen: true,
      },
    } as any);
    await tick();
    const banBtn = document.querySelector('button.bans') as HTMLButtonElement | null;
    expect(banBtn).toBeTruthy();
    await userEvent.click(banBtn as HTMLElement);
    await tick();
    // Should not have called sendRaw because networkId is empty
    expect(sendRawMock).not.toHaveBeenCalled();
  });
});

describe('Ban List — Overlay', () => {
  it('clicking Ban list shows overlay with bans after 367/368', async () => {
    const Overlay = (await import('./Overlay.svelte')).default;
    const { processIrcEvent } = await import('../lib/messageHandler');
    const net = createNetwork({ networkId: 'net1', name: 'TestNet', connected: true });
    net.buffers.push(createBuffer({ name: '#test', type: 'channel', isJoined: true }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#test';

    // Simulate server sending 367/368 via processIrcEvent (full flow)
    const localMsgIdCounter = { value: 0 };
    const accum: any = { banAcc: [], banTargetChannel: '', whoisAcc: null, whoisAccs: new Map() };
    const cb = { switchToBuffer: () => {} };
    // 367 RPL_BANLIST
    let result = processIrcEvent(
      { nid: 'net1', command: '367', params: ['me', '#test', '*!*@bad.host', 'op!user@host', '1234567890'], t: Date.now() } as any,
      localMsgIdCounter,
      accum,
      cb
    );
    expect(result.banListData).toBeUndefined();
    // 368 RPL_ENDOFBANLIST
    result = processIrcEvent(
      { nid: 'net1', command: '368', params: ['me', '#test', 'End of Channel Ban List'], t: Date.now() } as any,
      localMsgIdCounter,
      accum,
      cb
    );
    expect(result.banListData).toBeDefined();
    if (result.banListData) {
      ircState.overlay.type = 'banlist';
      ircState.overlay.data = result.banListData as any;
    }

    render(Overlay, {} as any);
    await tick();
    // Wait for dialog to be shown via showModal()
    await new Promise((r) => setTimeout(r, 50));
    const dialog = document.querySelector('dialog') as HTMLDialogElement | null;
    expect(dialog).toBeTruthy();
    if (dialog) {
      expect(dialog.open).toBe(true);
      const cs = getComputedStyle(dialog);
      expect(cs.display).not.toBe('none');
      // Check centering: dialog should be fixed and centered via transform
      expect(cs.position).toBe('fixed');
      // transform is computed as matrix(1,0,0,1, -x, -y) for translate(-50%,-50%)
      expect(cs.transform).not.toBe('none');
      // Check bounding rect is roughly centered (lenient, viewport may be small)
      const rect = dialog.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      expect(Math.abs(centerX - viewportWidth / 2)).toBeLessThan(100);
      expect(Math.abs(centerY - viewportHeight / 2)).toBeLessThan(200);
      // Also check dialog is not at 0,0 and is visible
      expect(rect.width).toBeGreaterThan(100);
      expect(rect.height).toBeGreaterThan(50);
      // Check table is visible
      const table = document.querySelector('table.banlist-table') as HTMLElement | null;
      expect(table).toBeTruthy();
      if (table) {
        expect(getComputedStyle(table).display).not.toBe('none');
      }
      expect(document.body.textContent).toContain('*!*@bad.host');
    }
  });
});
