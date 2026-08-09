import { describe, it, expect, beforeEach } from 'vitest';
import { ircState, appendMessage, batchAppendMessages } from './ircStore.svelte';
import { createMessage } from '../test/factories';
import { buildProcessedBuffer } from '../lib/messageBuilder';

function reset() {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.processedMessages = {};
  ircState.optimisticMessages.clear();
}

describe('duplicate on #zod send - synthetic + unlabeled echo', () => {
  beforeEach(reset);

  it('appendMessage: synthetic (labeled) + server echo (unlabeled selfEcho) stays 1', () => {
    const networkId = 'net1';
    const channel = '#zod';
    const key = `${networkId}:${channel}`;
    const label = 'label-abc-123';
    const text = 'hello zod';

    const optimistic = createMessage({ label, nick: 'me', text, command: 'PRIVMSG', t: Date.now() });
    ircState.optimisticMessages.set(label, optimistic);
    ircState.messages[key] = [optimistic];
    ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

    // Synthetic from engine (has label, selfEcho) replaces optimistic
    const synthetic = createMessage({ label, nick: 'me', text, command: 'PRIVMSG', t: Date.now() + 10 });
    (synthetic as any).selfEcho = true;
    synthetic.label = label;
    appendMessage(networkId, channel, synthetic);
    expect(ircState.messages[key]).toHaveLength(1);
    expect(ircState.messages[key][0].label).toBe(label);

    // Server echo arrives WITHOUT label (labeled-response absent), selfEcho true
    // This is the #zod duplicate: optimistic map already consumed, so old code would append as 2nd row
    const echo = createMessage({ nick: 'me', text, command: 'PRIVMSG', t: Date.now() + 100 });
    (echo as any).selfEcho = true;
    echo.label = '';
    appendMessage(networkId, channel, echo);

    expect(ircState.messages[key]).toHaveLength(1);
    expect(ircState.processedMessages[key]).toHaveLength(1);
    // Echo should have inherited the label
    expect(ircState.messages[key][0].label).toBe(label);
  });

  it('batchAppendMessages: synthetic + unlabeled echo in separate flushes stays 1', () => {
    const networkId = 'net1';
    const channel = '#zod';
    const key = `${networkId}:${channel}`;
    const label = 'label-batch-1';
    const text = 'test batch dedup';

    const optimistic = createMessage({ label, nick: 'me', text, command: 'PRIVMSG', t: Date.now() });
    ircState.optimisticMessages.set(label, optimistic);
    ircState.messages[key] = [optimistic];
    ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

    const synthetic = createMessage({ label, nick: 'me', text, command: 'PRIVMSG', t: Date.now() + 10 });
    (synthetic as any).selfEcho = true;
    synthetic.label = label;
    batchAppendMessages(networkId, channel, [synthetic]);
    expect(ircState.messages[key]).toHaveLength(1);

    const echo = createMessage({ nick: 'me', text, command: 'PRIVMSG', t: Date.now() + 100 });
    (echo as any).selfEcho = true;
    echo.label = '';
    batchAppendMessages(networkId, channel, [echo]);

    expect(ircState.messages[key]).toHaveLength(1);
    expect(ircState.processedMessages[key]).toHaveLength(1);
  });

  it('batchAppendMessages: synthetic + unlabeled echo in SAME batch stays 1', () => {
    const networkId = 'net1';
    const channel = '#zod';
    const key = `${networkId}:${channel}`;
    const label = 'label-same-batch';
    const text = 'same batch';

    const optimistic = createMessage({ label, nick: 'me', text, command: 'PRIVMSG', t: Date.now() });
    ircState.optimisticMessages.set(label, optimistic);
    ircState.messages[key] = [optimistic];
    ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

    const synthetic = createMessage({ label, nick: 'me', text, command: 'PRIVMSG', t: Date.now() + 10 });
    (synthetic as any).selfEcho = true;
    synthetic.label = label;

    const echo = createMessage({ nick: 'me', text, command: 'PRIVMSG', t: Date.now() + 100 });
    (echo as any).selfEcho = true;
    echo.label = '';

    batchAppendMessages(networkId, channel, [synthetic, echo]);

    expect(ircState.messages[key]).toHaveLength(1);
    expect(ircState.processedMessages[key]).toHaveLength(1);
  });

  it('does not swallow legitimate second send of same text outside 30s window', () => {
    const networkId = 'net1';
    const channel = '#zod';
    const key = `${networkId}:${channel}`;
    const text = 'repeat';

    // First message already confirmed (has eid, old timestamp)
    const first = createMessage({ label: 'old-label', nick: 'me', text, command: 'PRIVMSG', t: Date.now() - 60_000, eid: 1 });
    ircState.messages[key] = [first];
    ircState.processedMessages[key] = buildProcessedBuffer([first]);

    // Second send with same text but new optimistic
    const label2 = 'new-label';
    const optimistic2 = createMessage({ label: label2, nick: 'me', text, command: 'PRIVMSG', t: Date.now() });
    ircState.optimisticMessages.set(label2, optimistic2);
    ircState.messages[key].push(optimistic2);
    ircState.processedMessages[key] = buildProcessedBuffer(ircState.messages[key]);

    expect(ircState.messages[key]).toHaveLength(2);

    // Echo for second
    const echo2 = createMessage({ nick: 'me', text, command: 'PRIVMSG', t: Date.now() + 10 });
    (echo2 as any).selfEcho = true;
    echo2.label = '';
    // With our guard, the old first message is not considered pending-like and is >30s, so skipped.
    // The new optimistic at tail will be matched.
    appendMessage(networkId, channel, echo2);

    // Should still be 2 (first + replaced second)
    expect(ircState.messages[key]).toHaveLength(2);
  });
});
