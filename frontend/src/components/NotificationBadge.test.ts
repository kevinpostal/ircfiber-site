import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import NotificationBadge from './NotificationBadge.svelte';
import { unreadMap, highlightMap, lastSeenMap, bottomSeenMap } from '../stores/preferences.svelte';
import { ircState, setActiveBuffer, appendMessage, getTotalUnread, getHasHighlight } from '../stores/ircStore.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';

beforeEach(() => {
  Object.keys(unreadMap).forEach((k) => delete (unreadMap as Record<string, unknown>)[k]);
  Object.keys(highlightMap).forEach((k) => delete (highlightMap as Record<string, unknown>)[k]);
  for (const k of Object.keys(lastSeenMap)) delete (lastSeenMap as Record<string, unknown>)[k];
  for (const k of Object.keys(bottomSeenMap)) delete (bottomSeenMap as Record<string, unknown>)[k];
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.focusLost = false;
});
describe('NotificationBadge', () => {
  it('updates document.title with unread count', async () => {
    unreadMap['net1:#chan'] = 3;
    render(NotificationBadge);
    await expect.poll(() => document.title).toBe('(3) IRC Fiber');
  });

  it('shows highlight in title', async () => {
    unreadMap['net1:#chan'] = 5;
    highlightMap['net1:#chan'] = true;
    render(NotificationBadge);
    await expect.poll(() => document.title).toBe('(5) IRC Fiber');
  });

  it('resets title when unread returns to zero', async () => {
    unreadMap['net1:#chan'] = 2;
    render(NotificationBadge);
    await expect.poll(() => document.title).toBe('(2) IRC Fiber');
    delete unreadMap['net1:#chan'];
    await expect.poll(() => document.title).toBe('IRC Fiber');
  });

  it('reflects total unread count from per-channel message arrivals', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan1', unreadCount: 0 }));
    net.buffers.push(createBuffer({ name: '#chan2', unreadCount: 0 }));
    net.buffers.push(createBuffer({ name: '#chan3', unreadCount: 0 }));
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#active';
    ircState.focusLost = false;

    render(NotificationBadge);

    appendMessage('net1', '#chan1', createMessage({ text: 'a' }));
    appendMessage('net1', '#chan1', createMessage({ text: 'b' }));
    appendMessage('net1', '#chan2', createMessage({ text: 'c' }));
    flushSync();

    expect(getTotalUnread()).toBe(3);
    await expect.poll(() => document.title).toBe('(3) IRC Fiber');
  });

  it('clears total unread when switching to a buffer with unread', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#chan1', unreadCount: 0 }));
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#other';
    ircState.focusLost = false;

    render(NotificationBadge);

    appendMessage('net1', '#chan1', createMessage({ text: 'hello' }));
    flushSync();
    expect(getTotalUnread()).toBe(1);
    await expect.poll(() => document.title).toBe('(1) IRC Fiber');

    setActiveBuffer('net1', '#chan1');
    flushSync();
    expect(getTotalUnread()).toBe(0);
    await expect.poll(() => document.title).toBe('IRC Fiber');
  });

  it('getHasHighlight is true when any buffer has a highlight', async () => {
    const net = createNetwork({ networkId: 'net1', nick: 'myuser', currentNick: 'myuser' });
    net.buffers.push(createBuffer({ name: '#chan1', unreadCount: 0 }));
    ircState.networks.push(net);

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#other';
    ircState.focusLost = false;

    render(NotificationBadge);

    expect(getHasHighlight()).toBe(false);

    // Message mentioning myuser → highlight
    appendMessage('net1', '#chan1', createMessage({ text: 'hey myuser look', nick: 'alice' }));
    flushSync();

    expect(getHasHighlight()).toBe(true);
  });
});
