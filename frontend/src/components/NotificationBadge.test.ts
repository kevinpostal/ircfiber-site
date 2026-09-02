import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import NotificationBadge from './NotificationBadge.svelte';
import { unseenMap, unseenHighlightsMap, lastSeenMap, bottomSeenMap, bufferPrefsMap } from '../stores/preferences.svelte';
import { ircState, appendMessage, readBuffer, getUnseenMessageStats } from '../stores/ircStore.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';

beforeEach(() => {
  for (const k of Object.keys(unseenMap)) delete (unseenMap as Record<string, unknown>)[k];
  for (const k of Object.keys(unseenHighlightsMap)) delete (unseenHighlightsMap as Record<string, unknown>)[k];
  for (const k of Object.keys(lastSeenMap)) delete (lastSeenMap as Record<string, unknown>)[k];
  for (const k of Object.keys(bottomSeenMap)) delete (bottomSeenMap as Record<string, unknown>)[k];
  for (const k of Object.keys(bufferPrefsMap)) delete (bufferPrefsMap as Record<string, unknown>)[k];
  ircState.networks.length = 0;
  ircState.messages = {};
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.focusLost = false;
  ircState.wsConnected = true;
  ircState.me = { username: 'me', email: 'me@test' };
  document.title = '';
});

function setup(): void {
  const net = createNetwork({ networkId: 'net1', name: 'IRC Fiber', nick: 'me', currentNick: 'me' });
  net.buffers.push(createBuffer({ name: '#testing' }), createBuffer({ name: '#dev' }), createBuffer({ name: 'alice', type: 'query' }));
  ircState.networks.push(net);
  ircState.activeBuffer.networkId = 'net1';
  ircState.activeBuffer.bufferName = '#testing';
}

describe('NotificationBadge — IRCCloud title', () => {
  it('base title is "IRC Fiber" with no buffer, "#chan | network" with one', async () => {
    render(NotificationBadge);
    await expect.poll(() => document.title).toBe('IRC Fiber');
    setup();
    flushSync();
    await expect.poll(() => document.title).toBe('#testing | IRC Fiber');
  });

  it('server log uses the connection name alone', async () => {
    setup();
    ircState.activeBuffer.bufferName = '_server';
    render(NotificationBadge);
    await expect.poll(() => document.title).toBe('IRC Fiber');
  });

  it('"* " prefix when another buffer is unseen, "+ " when the current one is', async () => {
    setup();
    render(NotificationBadge);
    appendMessage('net1', '#dev', createMessage({ text: 'hello', nick: 'bob' }));
    flushSync();
    await expect.poll(() => document.title).toBe('* #testing | IRC Fiber');

    readBuffer('net1', '#dev');
    appendMessage('net1', '#testing', createMessage({ text: 'hello again', nick: 'bob' }));
    flushSync();
    await expect.poll(() => document.title).toBe('+ #testing | IRC Fiber');
  });

  it('"(N) " prefix sums unseen highlights across buffers', async () => {
    setup();
    render(NotificationBadge);
    appendMessage('net1', '#dev', createMessage({ t: 1000, text: 'me: ping', nick: 'bob' }));
    appendMessage('net1', 'alice', createMessage({ t: 2000, text: 'psst', nick: 'alice' }));
    flushSync();
    expect(getUnseenMessageStats()).toBe(2);
    await expect.poll(() => document.title).toBe('(2) #testing | IRC Fiber');
  });

  it('returns to the base title once everything is read', async () => {
    setup();
    render(NotificationBadge);
    appendMessage('net1', '#dev', createMessage({ t: 1000, text: 'me: ping', nick: 'bob' }));
    flushSync();
    await expect.poll(() => document.title).toBe('(1) #testing | IRC Fiber');
    readBuffer('net1', '#dev');
    flushSync();
    await expect.poll(() => document.title).toBe('#testing | IRC Fiber');
  });

  it('"(Offline) " prefix while the stream is disconnected', async () => {
    setup();
    ircState.wsConnected = false;
    render(NotificationBadge);
    await expect.poll(() => document.title).toBe('(Offline) #testing | IRC Fiber');
  });
});

describe('NotificationBadge — favicon', () => {
  function iconHref(): string {
    return (document.querySelector('link[rel="icon"]') as HTMLLinkElement | null)?.href ?? '';
  }

  it('renders a data: icon and changes it only when a highlight is unseen', async () => {
    setup();
    render(NotificationBadge);
    await expect.poll(() => iconHref().startsWith('data:image/png')).toBe(true);
    const plain = iconHref();

    // Plain unseen message → no red dot (icon unchanged).
    appendMessage('net1', '#dev', createMessage({ t: 1000, text: 'hello', nick: 'bob' }));
    flushSync();
    expect(getUnseenMessageStats()).toBe(0);
    await expect.poll(() => iconHref()).toBe(plain);

    // Highlight → dot drawn (icon differs).
    appendMessage('net1', '#dev', createMessage({ t: 2000, text: 'me: ping', nick: 'bob' }));
    flushSync();
    await expect.poll(() => iconHref() !== plain).toBe(true);

    readBuffer('net1', '#dev');
    flushSync();
    await expect.poll(() => iconHref()).toBe(plain);
  });
});
