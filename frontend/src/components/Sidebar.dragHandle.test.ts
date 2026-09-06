// Reordering servers must require a grab on the SERVER HEADER, never on a
// channel row inside it.
//
// IRCCloud's connection sortable passes `handle: "h2.buffer"`
// (common-5650bddb.js @717158 — `revert:100, cursorAt:{top:17}, distance:5,
// axis:"y", cursor:"move", opacity:.7, handle:"h2.buffer"`), and its live DOM
// marks only the `h2.buffer` headers `ui-sortable-handle` while all 36 plain
// `li.buffer` channel rows carry none. Our dnd item is the whole
// `.network.connection` block, channel list included, so with the zone always
// armed a press on a channel name dragged the entire server — reported as
// "too easy to move the channels in the sidebar".
//
// What is asserted: svelte-dnd-action attaches the `mousedown` listener to
// each item and paints it `cursor: grab` only while the zone is armed
// (`styleDraggable(el, dragDisabled)` in helpers/styler.js), and removes both
// when `dragDisabled` is true. So the inline cursor IS the gate — no listener,
// no drag — and it is checkable without simulating a whole drag.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import Sidebar from './Sidebar.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
import {
  archivedMap, pinnedMap, pinnedOrder, hiddenChannelsMap, networkOrder,
  collapsedMap, conversationsCollapsedMap, bufferPrefsMap,
} from '../stores/preferences.svelte';

const props = () => ({
  onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn(),
  onNetworkOptions: vi.fn(), onJoinChannel: vi.fn(),
});

const origFetch = globalThis.fetch;

function resetState(): void {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  for (const m of [archivedMap, pinnedMap, hiddenChannelsMap, collapsedMap,
                   conversationsCollapsedMap, bufferPrefsMap]) {
    Object.keys(m).forEach((k) => delete (m as Record<string, unknown>)[k]);
  }
  networkOrder.length = 0;
  pinnedOrder.length = 0;
  document.body.innerHTML = '';
}

beforeEach(() => {
  resetState();
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 204 } as Response)) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  resetState();
});

/** Two servers, two channels each, both expanded. */
function seed(): void {
  for (const [id, name] of [['net1', 'Alpha'], ['net2', 'Bravo']] as const) {
    const net = createNetwork({ networkId: id, name });
    net.buffers.push(createBuffer({ name: '#one' }), createBuffer({ name: '#two' }));
    ircState.networks.push(net);
  }
  flushSync();
}

const items = () =>
  Array.from(document.querySelectorAll<HTMLElement>('.network-list-items > .network.connection'));
/** The library's own "this item is draggable" marker. */
const armed = () => items().filter((el) => el.style.cursor === 'grab').length;
const header = (netId: string) =>
  document.querySelector(`.network.connection[data-network-id="${netId}"] .network-header`)!;
const channelRow = (netId: string) =>
  document.querySelector(`.network.connection[data-network-id="${netId}"] .network-buffers li`)!;

function hover(el: Element, type: 'mouseenter' | 'mouseleave'): void {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent(type, {
    bubbles: false, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  }));
  flushSync();
}

describe('server reorder is gated on the header handle', () => {
  it('is disarmed until the pointer is on a header — a channel press cannot drag the server', () => {
    seed();
    render(Sidebar, { props: props() });
    flushSync();

    expect(items().length).toBe(2);
    expect(armed(), 'nothing is draggable while the pointer is elsewhere').toBe(0);

    // Hovering the channel row (which is inside the item) must not arm it.
    hover(channelRow('net2'), 'mouseenter');
    expect(armed(), 'a channel row is not the handle').toBe(0);
  });

  it('arms on the server header and disarms again when the pointer leaves', () => {
    seed();
    render(Sidebar, { props: props() });
    flushSync();

    hover(header('net2'), 'mouseenter');
    expect(armed(), 'the header is the handle').toBe(2);

    hover(header('net2'), 'mouseleave');
    expect(armed(), 'leaving the handle puts the zone away again').toBe(0);
  });

  it('keeps pinned channels draggable from anywhere on the row', () => {
    // IRCCloud's pinned sortable passes no handle at all (@718269), so the
    // whole pinned row is the grip — only the connection list is gated.
    seed();
    pinnedMap['net1:#one'] = true;
    pinnedMap['net1:#two'] = true;
    pinnedOrder.push('net1:#one', 'net1:#two');
    render(Sidebar, { props: props() });
    flushSync();

    const pins = Array.from(
      document.querySelectorAll<HTMLElement>('.pinnedBufferList > li'),
    );
    expect(pins.length).toBe(2);
    expect(pins.every((el) => el.style.cursor === 'grab'),
      'pinned rows stay draggable without hovering a handle').toBe(true);
  });
});
