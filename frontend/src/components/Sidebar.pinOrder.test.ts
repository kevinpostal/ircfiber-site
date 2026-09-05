// Pinned channels are drag-reorderable, and the order is the server's pin
// list (`prefs.pinnedChannels`) — so it persists and lands on every other
// tab/device through the existing `pinned` pref broadcast.
//
// Drag itself is driven the way Sidebar.test.ts drives the network zone:
// svelte-dnd-action's `consider`/`finalize` CustomEvents dispatched on the
// zone element, since a real HTML5 drag is not reproducible in the runner.
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

let fetchMock: ReturnType<typeof vi.fn>;
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
  fetchMock = vi.fn(async () => ({ ok: true, status: 204 } as Response));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = origFetch; resetState(); });

/** One network, three pinned channels in insertion order a, b, c. */
function seed(): void {
  const net = createNetwork({ networkId: 'net1', name: 'Libera' });
  net.buffers.push(createBuffer({ name: '#alpha' }), createBuffer({ name: '#bravo' }), createBuffer({ name: '#charlie' }));
  ircState.networks.push(net);
  for (const c of ['#alpha', '#bravo', '#charlie']) pinnedMap[`net1:${c}`] = true;
  pinnedOrder.push('net1:#alpha', 'net1:#bravo', 'net1:#charlie');
  flushSync();
}

const zone = () => document.querySelector('.pinnedBufferList') as HTMLElement;
const pinnedKeys = () =>
  [...zone().querySelectorAll('li.buffer-item')].map((li) => (li as HTMLElement).dataset.bufferKey);

const item = (key: string) => ({
  id: key,
  row: {
    networkId: 'net1',
    network: ircState.networks[0],
    buffer: ircState.networks[0].buffers.find((b) => `net1:${b.name}` === key)!,
  },
});

function drop(order: string[]): void {
  zone().dispatchEvent(new CustomEvent('consider', {
    detail: { items: order.map(item), info: { trigger: 'draggedEntered', id: order[0], source: 'POINTER' } },
  }));
  flushSync();
  zone().dispatchEvent(new CustomEvent('finalize', {
    detail: { items: order.map(item), info: { trigger: 'droppedIntoZone', id: order[0], source: 'POINTER' } },
  }));
  flushSync();
}

describe('pinned channel drag reorder', () => {
  it('renders the pinned rows in the stored order, not insertion order', async () => {
    seed();
    pinnedOrder.length = 0;
    pinnedOrder.push('net1:#charlie', 'net1:#alpha', 'net1:#bravo');
    render(Sidebar, { props: props() });
    flushSync();

    expect(pinnedKeys()).toEqual(['net1:#charlie', 'net1:#alpha', 'net1:#bravo']);
  });

  it('sorts a pin with no stored position after the ordered ones', async () => {
    seed();
    pinnedOrder.length = 0;
    pinnedOrder.push('net1:#charlie');
    render(Sidebar, { props: props() });
    flushSync();

    // #charlie is placed; #alpha/#bravo keep their natural relative order.
    expect(pinnedKeys()).toEqual(['net1:#charlie', 'net1:#alpha', 'net1:#bravo']);
  });

  it('persists a drop to the server and to the local order', async () => {
    seed();
    render(Sidebar, { props: props() });
    flushSync();
    expect(pinnedKeys()).toEqual(['net1:#alpha', 'net1:#bravo', 'net1:#charlie']);

    drop(['net1:#charlie', 'net1:#alpha', 'net1:#bravo']);

    expect(pinnedKeys()).toEqual(['net1:#charlie', 'net1:#alpha', 'net1:#bravo']);
    expect([...pinnedOrder]).toEqual(['net1:#charlie', 'net1:#alpha', 'net1:#bravo']);

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/me/pin-order'));
    expect(call, 'POST /api/me/pin-order was sent').toBeDefined();
    expect((call![1] as RequestInit).method).toBe('POST');
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      order: ['net1:#charlie', 'net1:#alpha', 'net1:#bravo'],
    });
  });

  it('keeps the dropped order rendered while the request is in flight', async () => {
    seed();
    // A server that never answers must not snap the list back.
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
    render(Sidebar, { props: props() });
    flushSync();

    drop(['net1:#bravo', 'net1:#charlie', 'net1:#alpha']);
    await new Promise((r) => setTimeout(r, 50));
    flushSync();

    expect(pinnedKeys()).toEqual(['net1:#bravo', 'net1:#charlie', 'net1:#alpha']);
  });

  it('re-sorts live when another device reorders (pinned pref broadcast)', async () => {
    seed();
    render(Sidebar, { props: props() });
    flushSync();

    // What App's handlePrefUpdate('pinned') does with the broadcast list.
    pinnedOrder.length = 0;
    pinnedOrder.push('net1:#bravo', 'net1:#charlie', 'net1:#alpha');
    flushSync();

    expect(pinnedKeys()).toEqual(['net1:#bravo', 'net1:#charlie', 'net1:#alpha']);
  });

  it('keeps taking remote reorders after a drag that never finalizes', async () => {
    // Regression: guarding the rebuild effect with an "is dragging" flag
    // latched it on when a drag was abandoned (pointer lost, element
    // unmounted mid-drag), and the Pinned list then ignored every later
    // pin and remote reorder for the rest of the session.
    seed();
    render(Sidebar, { props: props() });
    flushSync();

    // consider without a matching finalize = abandoned drag.
    zone().dispatchEvent(new CustomEvent('consider', {
      detail: {
        items: ['net1:#charlie', 'net1:#alpha', 'net1:#bravo'].map(item),
        info: { trigger: 'dragStarted', id: 'net1:#charlie', source: 'POINTER' },
      },
    }));
    flushSync();

    // Another device reorders; this one must follow.
    pinnedOrder.length = 0;
    pinnedOrder.push('net1:#bravo', 'net1:#alpha', 'net1:#charlie');
    flushSync();
    expect(pinnedKeys()).toEqual(['net1:#bravo', 'net1:#alpha', 'net1:#charlie']);

    // …and a newly pinned channel still shows up.
    ircState.networks[0].buffers.push(createBuffer({ name: '#delta' }));
    pinnedMap['net1:#delta'] = true;
    flushSync();
    expect(pinnedKeys()).toContain('net1:#delta');
  });

  it('leaves a click on a pinned row switching buffers', async () => {
    seed();
    const p = props();
    render(Sidebar, { props: p });
    flushSync();

    (zone().querySelector('li.buffer-item[data-buffer-key="net1:#bravo"]') as HTMLElement).click();
    expect(p.onSwitchBuffer).toHaveBeenCalledWith('net1', '#bravo');
  });

  it('drops an unpinned channel out of the list without disturbing the rest', async () => {
    seed();
    render(Sidebar, { props: props() });
    flushSync();

    delete pinnedMap['net1:#bravo'];
    flushSync();

    expect(pinnedKeys()).toEqual(['net1:#alpha', 'net1:#charlie']);
  });
});
