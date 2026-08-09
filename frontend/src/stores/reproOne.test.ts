import { describe, it, expect, beforeEach } from 'vitest';
import { ircState, appendMessage, batchAppendMessages } from './ircStore.svelte';
import { createMessage, createNetwork } from '../test/factories';
import { buildProcessedBuffer } from '../lib/messageBuilder';
import { processIrcEvent } from '../lib/messageHandler';
import { enqueueMessage, setFlushFn } from '../lib/messageBatcher';
import { flushSync } from 'svelte';

function reset() {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  ircState.optimisticMessages.clear();
}

describe('duplicate when typing 1 in #zod', () => {
  beforeEach(reset);

  it('single 1 with label should not duplicate after synthetic + server echo (same label)', () => {
    const networkId = 'net1';
    const channel = '#zod';
    const key = `${networkId}:${channel}`;
    const label = 'label-1';
    const text = '1';

    const optimistic = createMessage({ label, nick: 'KneeGrow', text, command: 'PRIVMSG' });
    ircState.optimisticMessages.set(label, optimistic);
    ircState.messages[key] = [optimistic];
    ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

    // Synthetic from engine (echo-message not active, but labeled-response active)
    // Has same label, selfEcho, synthetic
    const synthetic = createMessage({ label, nick: 'KneeGrow', text, command: 'PRIVMSG' });
    (synthetic as any).selfEcho = true;
    // @ts-ignore
    synthetic.label = label;

    appendMessage(networkId, channel, synthetic);
    expect(ircState.messages[key]).toHaveLength(1);
    expect(ircState.messages[key][0].text).toBe(text);
    // optimistic should be gone after synthetic replaces it, but synthetic is now in list with same label
    // Now server echo arrives with same label
    const echo = createMessage({ label, nick: 'KneeGrow', text, command: 'PRIVMSG' });
    (echo as any).selfEcho = true;
    (echo as any).labeledEcho = true;
    echo.label = label;

    appendMessage(networkId, channel, echo);
    // Should still be 1, not 2
    expect(ircState.messages[key]).toHaveLength(1);
    expect(ircState.messages[key][0].text).toBe(text);
  });

  it('1 via batch with same label should not duplicate', () => {
    const networkId = 'net1';
    const channel = '#zod';
    const key = `${networkId}:${channel}`;
    const label = 'label-batch-1';
    const text = '1';

    const optimistic = createMessage({ label, nick: 'KneeGrow', text, command: 'PRIVMSG' });
    ircState.optimisticMessages.set(label, optimistic);
    ircState.messages[key] = [optimistic];
    ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

    const synthetic = createMessage({ label, nick: 'KneeGrow', text, command: 'PRIVMSG' });
    (synthetic as any).selfEcho = true;
    const echo = createMessage({ label, nick: 'KneeGrow', text, command: 'PRIVMSG' });
    (echo as any).selfEcho = true;
    (echo as any).labeledEcho = true;

    batchAppendMessages(networkId, channel, [synthetic, echo]);

    expect(ircState.messages[key]).toHaveLength(1);
  });

  it('1 with \r and no label should not duplicate (selfEcho trim)', () => {
    const networkId = 'net1';
    const channel = '#zod';
    const key = `${networkId}:${channel}`;
    const label = 'label-trim-1';
    const text = '1';

    const optimistic = createMessage({ label, nick: 'KneeGrow', text, command: 'PRIVMSG' });
    ircState.optimisticMessages.set(label, optimistic);
    ircState.messages[key] = [optimistic];
    ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

    const echo = createMessage({ nick: 'KneeGrow', text: text + '\r', command: 'PRIVMSG' });
    (echo as any).selfEcho = true;
    echo.label = '';

    appendMessage(networkId, channel, echo);

    expect(ircState.messages[key]).toHaveLength(1);
    expect(ircState.optimisticMessages.has(label)).toBe(false);
  });

  it('full live path: type 1 → optimistic + processIrcEvent echo (x=1\\r, se, le) → still 1 row', async () => {
    const networkId = 'net1';
    const channel = '#zod';
    const key = `${networkId}:${channel}`;
    const label = 'live-label-1';
    const text = '1';

    // Setup: network with buffer
    ircState.networks.push(createNetwork({ networkId, name: 'Supernets', currentNick: 'KneeGrow' }));
    const net = ircState.networks[0];
    net.buffers.push({ name: '#zod', type: 'channel', isJoined: true, unreadCount: 0, highlight: false, isPinned: false, isArchived: false, topic: '', topicSetBy: '', topicSetAt: 0, users: [], lastSeenMsgTime: null, firstUnseenMsgIndex: null, lastSeen: null, bottomSeen: null, clearedAt: null, modeFlags: {} });

    // InputArea optimistic
    const optimistic = createMessage({ label, nick: 'KneeGrow', text, command: 'PRIVMSG', t: Date.now() });
    ircState.optimisticMessages.set(label, optimistic);
    ircState.messages[key] = [optimistic];
    ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

    // Wire the batcher flush to batchAppendMessages (as App.svelte does)
    let flushed: { networkId: string; bufferName: string; msgs: unknown[] }[] = [];
    setFlushFn((nid, buf, msgs) => { flushed.push({ networkId: nid, bufferName: buf, msgs }); batchAppendMessages(nid, buf, msgs as any); });

    // Live echo as Supernets sends it: compact JSON with se + le, text '1\r', NO l
    const echoData: Record<string, unknown> = {
      nid: networkId, i: 'evt-1', t: Date.now() + 100, c: 'PRIVMSG', eid: 500,
      n: 'KneeGrow', x: '1\r', ch: '#zod', px: 'KneeGrow!~KneeGrow@host', p: ['#zod', '1\r'], m: 'msgid-1', se: 'true', le: 'true',
    };
    const counter = { value: 0 };
    processIrcEvent(echoData, counter, {} as any, { switchToBuffer: () => {} }, enqueueMessage);
    // Batcher flushes on the next macrotask (0ms debounce)
    await new Promise((r) => setTimeout(r, 20));
    flushSync();

    expect(flushed.length).toBe(1);
    expect(ircState.messages[key]).toHaveLength(1);
    expect(ircState.messages[key][0].text).toBe('1\r');
    expect(ircState.optimisticMessages.has(label)).toBe(false);
  });
});
