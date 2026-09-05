// Regression: the red unread badge must disappear when the user clicks a
// channel and reads it. It used to stick forever whenever a `focusSeen`
// marker outlived its focus session (persisted to localStorage, or written
// by a background tab): `readBuffer` marks read at
// `focusSeen ?? bottomSeen ?? lastMessage`, so a stale focusSeen capped the
// read marker below the newest message and `unseen` stayed true.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { flushSync, tick } from 'svelte';
import Sidebar from './Sidebar.svelte';
import MessageList from './MessageList.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';
import { ircState, setActiveBuffer, setUnseen } from '../stores/ircStore.svelte';
import {
  archivedMap, pinnedMap, networkOrder, collapsedMap, conversationsCollapsedMap, bufferPrefsMap,
  clearedAtMap, lastSeenMap, focusSeenMap, bottomSeenMap,
  setLastSeen, setFocusSeen,
} from '../stores/preferences.svelte';

const origHasFocus = document.hasFocus.bind(document);

function resetState(): void {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  ircState.backlogDivider = {};
  ircState.lastSeenMsgTime = null;
  ircState.focusLost = false;
  ircState.forceScrollToBottomNonce = 0;
  ircState.reorderMode = false;
  for (const m of [archivedMap, pinnedMap, collapsedMap, conversationsCollapsedMap, bufferPrefsMap,
                   clearedAtMap, lastSeenMap, focusSeenMap, bottomSeenMap]) {
    Object.keys(m).forEach((k) => delete (m as Record<string, unknown>)[k]);
  }
  networkOrder.length = 0;
  document.body.innerHTML = '';
  document.hasFocus = () => true;
}

// Rendered components are torn down before the maps are wiped: the
// framework's own cleanup runs after this hook, and a still-mounted
// MessageList re-arms the read marker on unmount.
const mounted: { unmount?: () => void }[] = [];
function mount<T extends { unmount?: () => void }>(result: T): T {
  mounted.push(result);
  return result;
}

beforeEach(resetState);
// Browser tests share module state and other suites don't reset the seen
// maps — leave nothing behind (a stale lastSeen would mute their unread).
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount?.();
  flushSync();
  resetState();
  document.hasFocus = origHasFocus;
});

const liveBuf = () => ircState.networks[0].buffers[1];

/** Two channels; #general holds 60 unread messages from bob. */
function seed(): number[] {
  const net = createNetwork({ networkId: 'net1', name: 'Libera' });
  net.buffers.push(createBuffer({ name: '#random' }), createBuffer({ name: '#general' }));
  ircState.networks.push(net);
  const t0 = Date.now() - 60_000;
  const msgs = Array.from({ length: 60 }, (_, i) =>
    createMessage({ text: `msg ${i}`, nick: 'bob', t: t0 + i * 1000 })
  );
  ircState.messages['net1:#general'] = msgs;
  ircState.messages['net1:#random'] = [createMessage({ text: 'elsewhere', nick: 'bob', t: t0 })];
  setLastSeen('net1', '#general', msgs[0].t!);
  setActiveBuffer('net1', '#random');
  setUnseen('net1', '#general', 59);
  flushSync();
  return msgs.map((m) => m.t!);
}

function badgeText(): string {
  const row = document.querySelector('li.buffer-item[data-buffer-key="net1:#general"]');
  if (!row) throw new Error('no #general row');
  return row.classList.contains('activeBadge') ? (row.querySelector('.badge')?.textContent ?? '') : '';
}

/** Click the sidebar row, then let MessageList settle at the bottom. */
async function clickAndRead(): Promise<void> {
  await page.getByText('general').click();
  flushSync();
  await expect.element(page.getByText('msg 59')).toBeInTheDocument();
  const container = document.getElementById('messages') as HTMLElement;
  container.style.height = '300px';
  await tick();
  await new Promise((r) => setTimeout(r, 300));
  flushSync();
}

describe('unread badge clears on select', () => {
  it('clears when the channel is selected and read', async () => {
    seed();
    mount(render(Sidebar, { props: { onSwitchBuffer: setActiveBuffer, onAddNetwork: vi.fn() } }));
    mount(render(MessageList, { props: {} }));
    expect(badgeText()).toBe('59');

    await clickAndRead();

    expect(liveBuf().unseen).toBe(false);
    expect(badgeText()).toBe('');
  });

  it('clears even when a stale focusSeen marker survived a blur', async () => {
    const ts = seed();
    // Window lost focus at msg 9 (then reloaded / another tab blurred):
    // before the fix this focusSeen pinned the read marker for good.
    setFocusSeen('net1', '#general', ts[9]);
    flushSync();
    mount(render(Sidebar, { props: { onSwitchBuffer: setActiveBuffer, onAddNetwork: vi.fn() } }));
    mount(render(MessageList, { props: {} }));
    expect(badgeText()).toBe('59');

    await clickAndRead();

    expect(lastSeenMap['net1:#general']).toBe(ts[59]);
    expect(liveBuf().unseen).toBe(false);
    expect(badgeText()).toBe('');
  });
});
