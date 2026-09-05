// The red unread badge must clear the moment a channel is opened. It used to
// wait for MessageList to mount, fetch history and reach its scroll trigger
// (`onScrollChange` → `readBuffer`), which is hundreds of ms — long enough
// that clicking through channels left stale counters behind, and indefinitely
// long for a buffer whose history had not been fetched yet (`readBuffer`
// no-ops with no messages loaded).
//
// Opening now marks the buffer read synchronously, while the in-log markers
// ("New messages" divider, "unread above" bar) stay anchored where the visit
// started via the `openSeen` pin.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { flushSync } from 'svelte';
import Sidebar from './Sidebar.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';
import {
  ircState, setActiveBuffer, setUnseen, getVisitSeen, clearVisitSeen,
} from '../stores/ircStore.svelte';
import {
  archivedMap, pinnedMap, networkOrder, collapsedMap, conversationsCollapsedMap, bufferPrefsMap,
  clearedAtMap, lastSeenMap, focusSeenMap, bottomSeenMap, setLastSeen, unseenMap,
} from '../stores/preferences.svelte';

const origHasFocus = document.hasFocus.bind(document);

// Browser tests share module state and can run concurrently with other
// suites, so everything here is namespaced under `netRO` and only that
// suite's own keys are wiped — a global wipe (or a leaked recent lastSeen)
// would mute or fake another suite's unread.
function resetState(): void {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  for (const rec of [ircState.messages, ircState.processedMessages, ircState.openSeen]) {
    Object.keys(rec).forEach((k) => { if (k.startsWith('netRO:')) delete (rec as Record<string, unknown>)[k]; });
  }
  ircState.focusLost = false;
  for (const m of [archivedMap, pinnedMap, collapsedMap, conversationsCollapsedMap, bufferPrefsMap,
                   clearedAtMap, lastSeenMap, focusSeenMap, bottomSeenMap, unseenMap]) {
    Object.keys(m).forEach((k) => { if (k.startsWith('netRO:')) delete (m as Record<string, unknown>)[k]; });
  }
  networkOrder.length = 0;
  document.body.innerHTML = '';
  document.hasFocus = () => true;
}

beforeEach(resetState);
afterEach(() => { resetState(); document.hasFocus = origHasFocus; });

/** #random selected; #general and #ops both carry unread. #general has its
 *  history loaded, #ops does not — the fast-click case. */
function seed(): number[] {
  const net = createNetwork({ networkId: 'netRO', name: 'Libera' });
  net.buffers.push(createBuffer({ name: '#random' }), createBuffer({ name: '#general' }), createBuffer({ name: '#ops' }));
  ircState.networks.push(net);
  const t0 = Date.now() - 60_000;
  const msgs = Array.from({ length: 10 }, (_, i) =>
    createMessage({ text: `msg ${i}`, nick: 'bob', t: t0 + i * 1000 }));
  ircState.messages['netRO:#general'] = msgs;
  ircState.messages['netRO:#random'] = [createMessage({ text: 'elsewhere', nick: 'bob', t: t0 })];
  setLastSeen('netRO', '#general', msgs[0].t!);
  setActiveBuffer('netRO', '#random');
  setUnseen('netRO', '#general', 9);
  setUnseen('netRO', '#ops', 4);
  flushSync();
  return msgs.map((m) => m.t!);
}

function badge(name: string): string {
  const row = document.querySelector(`li.buffer-item[data-buffer-key="netRO:${name}"]`);
  if (!row) throw new Error(`no ${name} row`);
  return row.classList.contains('activeBadge') ? (row.querySelector('.badge')?.textContent ?? '') : '';
}

const buf = (name: string) => ircState.networks[0].buffers.find((b) => b.name === name)!;

describe('unread clears when the buffer is opened', () => {
  it('clears the badge synchronously on select, with no MessageList mounted', () => {
    const ts = seed();
    render(Sidebar, { props: { onSwitchBuffer: setActiveBuffer, onAddNetwork: vi.fn(), onNetworkOptions: vi.fn(), onJoinChannel: vi.fn() } });
    expect(badge('#general')).toBe('9');

    setActiveBuffer('netRO', '#general');
    flushSync();

    // No history render, no scroll trigger, no timers — just the click.
    expect(buf('#general').unseen).toBe(false);
    expect(buf('#general').unseenCount).toBe(0);
    expect(badge('#general')).toBe('');
    // Marked at the newest loaded message, exactly where the scroll trigger
    // would have settled.
    expect(lastSeenMap['netRO:#general']).toBe(ts[9]);
  });

  it('clears a buffer whose history has not been fetched yet', () => {
    seed();
    render(Sidebar, { props: { onSwitchBuffer: setActiveBuffer, onAddNetwork: vi.fn(), onNetworkOptions: vi.fn(), onJoinChannel: vi.fn() } });
    expect(badge('#ops')).toBe('4');
    expect(ircState.messages['netRO:#ops']).toBeUndefined();

    const before = Date.now();
    setActiveBuffer('netRO', '#ops');
    flushSync();

    expect(badge('#ops')).toBe('');
    expect(buf('#ops').unseen).toBe(false);
    // With nothing loaded, "now" is the marker: everything already in the
    // buffer is older, anything later is genuinely new.
    expect(lastSeenMap['netRO:#ops']).toBeGreaterThanOrEqual(before);
  });

  it('rapid switching clears every badge it passes through', () => {
    seed();
    render(Sidebar, { props: { onSwitchBuffer: setActiveBuffer, onAddNetwork: vi.fn(), onNetworkOptions: vi.fn(), onJoinChannel: vi.fn() } });

    setActiveBuffer('netRO', '#general');
    setActiveBuffer('netRO', '#ops');
    setActiveBuffer('netRO', '#random');
    flushSync();

    expect(badge('#general')).toBe('');
    expect(badge('#ops')).toBe('');
  });

  it('keeps the visit pin so the log still shows where the user left off', () => {
    const ts = seed();
    setActiveBuffer('netRO', '#general');
    flushSync();

    // Badge is clear, but the log's markers still point at msg 0 — the read
    // marker when the visit started.
    expect(lastSeenMap['netRO:#general']).toBe(ts[9]);
    expect(getVisitSeen('netRO', '#general')).toBe(ts[0]);

    // Leaving the buffer retires the pin; a later return recomputes from the
    // real marker, so the divider does not resurrect.
    setActiveBuffer('netRO', '#random');
    flushSync();
    expect(getVisitSeen('netRO', '#general')).toBe(ts[9]);
  });

  it('dismissing the unread bar drops the pin', () => {
    const ts = seed();
    setActiveBuffer('netRO', '#general');
    flushSync();
    expect(getVisitSeen('netRO', '#general')).toBe(ts[0]);

    clearVisitSeen('netRO', '#general');
    expect(getVisitSeen('netRO', '#general')).toBe(ts[9]);
  });

  it('does not eat unread while the session is unfocused', () => {
    seed();
    render(Sidebar, { props: { onSwitchBuffer: setActiveBuffer, onAddNetwork: vi.fn(), onNetworkOptions: vi.fn(), onJoinChannel: vi.fn() } });
    // A background restore or programmatic select must not clear a badge the
    // user never looked at.
    ircState.focusLost = true;

    setActiveBuffer('netRO', '#general');
    flushSync();

    expect(buf('#general').unseen).toBe(true);
    expect(badge('#general')).toBe('9');
  });
});
