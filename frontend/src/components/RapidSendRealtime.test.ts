import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';
import InputArea from './InputArea.svelte';
import MessageList from './MessageList.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';
import { ircState, batchAppendMessages } from '../stores/ircStore.svelte';
import { buildProcessedBuffer } from '../lib/messageBuilder';
import { clearedAtMap } from '../stores/preferences.svelte';
import type { IRCMessage } from '../types';

vi.mock('/src/stores/api', () => ({
  reconnectNetwork: vi.fn(async () => undefined),
  clearBacklog: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
  fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
  loadHistory: vi.fn(async () => []),
  joinChannel: vi.fn(async () => undefined),
  addNetwork: vi.fn(async () => undefined),
  updateNetwork: vi.fn(async () => undefined),
  deleteNetwork: vi.fn(async () => undefined),
  archiveChannel: vi.fn(async () => undefined),
  unarchiveChannel: vi.fn(async () => undefined),
  updateServerlogCollapsed: vi.fn(async () => undefined),
  normalizeMessage: vi.fn((m: unknown) => m),
  editUpload: vi.fn(async () => undefined),
  createIrcArtSave: vi.fn(async () => undefined),
  updateIrcArtSave: vi.fn(async () => undefined),
  fetchIrcArtSave: vi.fn(async () => undefined),
  fetchIrcArtSavesOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  deleteIrcArtSave: vi.fn(async () => undefined),
  fetchUploads: vi.fn(async () => []),
  fetchUploadsOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  deleteUpload: vi.fn(async () => undefined),
  fetchUploadById: vi.fn(async () => undefined),
  createPastebin: vi.fn(async () => undefined),
  fetchPastebinsOffset: vi.fn(async () => ({ entries: [], total: 0 })),
  deletePastebin: vi.fn(async () => undefined),
  pastebinRawUrl: vi.fn(() => ''),
  fetchArchiveNames: vi.fn(async () => ({})),
}));

function resetState(): void {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  ircState.backlogDivider = {};
  ircState.lastSeenMsgTime = null;
  ircState.focusLost = false;
  ircState.optimisticMessages.clear();
  Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
}

describe('Rapid same-text sends appear realtime', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  it('spamming "a" + Enter 10x fast creates 10 optimistic rows instantly (no dedup)', async () => {
    const net = createNetwork({ networkId: 'net1', currentNick: 'tester' });
    net.buffers.push(createBuffer({ name: '#testing' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#testing';
    flushSync();

    render(InputArea, { props: {} });
    render(MessageList, { props: {} });

    const textarea = page.getByRole('textbox', { name: /message input/i });
    await expect.element(textarea).toBeInTheDocument();

    for (let i = 0; i < 10; i++) {
      await userEvent.type(textarea, 'a');
      await userEvent.keyboard('{Enter}');
    }

    const key = 'net1:#testing';
    const list = ircState.messages[key] ?? [];
    const processed = ircState.processedMessages[key] ?? [];

    expect(list).toHaveLength(10);
    expect(processed).toHaveLength(10);
    expect(ircState.optimisticMessages.size).toBe(10);
    for (const m of list) {
      expect(m.text).toBe('a');
      expect(m.nick).toBe('tester');
      expect(m.label).toBeTruthy();
    }

    await expect.element(page.getByText('a').first()).toBeInTheDocument();
  });

  it('spamming "a" with echo replacement still keeps 10 rows (batchAppend dedup by label)', async () => {
    const networkId = 'net1';
    const channel = '#testing';
    const key = `${networkId}:${channel}`;
    ircState.networks.length = 0;
    ircState.networks.push(createNetwork({ networkId, currentNick: 'tester' }));
    ircState.messages = {};
    ircState.processedMessages = {};
    ircState.optimisticMessages.clear();

    const labels: string[] = [];
    for (let i = 0; i < 10; i++) {
      const label = `label-${i}-${Date.now()}-${Math.random()}`;
      labels.push(label);
      const optimistic = createMessage({ label, nick: 'tester', text: 'a', command: 'PRIVMSG', t: Date.now() + i });
      ircState.optimisticMessages.set(label, optimistic);
      const list = ircState.messages[key] ?? [];
      list.push(optimistic);
      ircState.messages[key] = list;
    }
    ircState.processedMessages[key] = buildProcessedBuffer(ircState.messages[key]);
    expect(ircState.messages[key]).toHaveLength(10);

    const echoes: IRCMessage[] = labels.map((label, i) =>
      createMessage({ label, nick: 'tester', text: 'a', command: 'PRIVMSG', t: Date.now() + i + 100, eid: 1000 + i, msgid: `mid-${i}` }),
    );
    batchAppendMessages(networkId, channel, echoes);
    expect(ircState.messages[key]).toHaveLength(10);
    expect(ircState.optimisticMessages.size).toBe(0);
    for (const m of ircState.messages[key]) {
      expect(m.text).toBe('a');
      expect(m.eid).toBeDefined();
    }
  });
});
