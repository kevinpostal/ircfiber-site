import { describe, it, expect, beforeEach } from 'vitest';
import { ircState, appendMessage } from './ircStore.svelte';
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

describe('duplicate on send with trailing \\r', () => {
  beforeEach(reset);

  it('should NOT duplicate when echo has trailing \\r and no label (selfEcho)', () => {
    const networkId = 'net1';
    const channel = '#zod';
    const key = `${networkId}:${channel}`;
    const label = 'test-label-123';
    const text = 'https://www.youtube.com/watch?v=thu8DWsirJo';
    const textWithCR = text + '\r';

    const optimistic = createMessage({ label, nick: 'Zodiac', text, command: 'PRIVMSG', t: Date.now() });
    ircState.optimisticMessages.set(label, optimistic);
    ircState.messages[key] = [optimistic];
    ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

    expect(ircState.messages[key]).toHaveLength(1);

    const echo = createMessage({
      nick: 'Zodiac',
      text: textWithCR,
      command: 'PRIVMSG',
      t: Date.now() + 100,
    });
    (echo as any).selfEcho = true;
    echo.label = '';

    appendMessage(networkId, channel, echo);

    expect(ircState.messages[key]).toHaveLength(1);
    expect(ircState.messages[key][0].text).toBe(textWithCR);
    expect(ircState.optimisticMessages.has(label)).toBe(false);
  });

  it('should dedup even when echo text has \\r and label present (should replace via label)', () => {
    const networkId = 'net1';
    const channel = '#zod';
    const key = `${networkId}:${channel}`;
    const label = 'label-abc';
    const text = 'hello world';

    const optimistic = createMessage({ label, nick: 'me', text, command: 'PRIVMSG' });
    ircState.optimisticMessages.set(label, optimistic);
    ircState.messages[key] = [optimistic];
    ircState.processedMessages[key] = buildProcessedBuffer([optimistic]);

    const echoWithLabelAndCR = createMessage({ label, nick: 'me', text: text + '\r', command: 'PRIVMSG' });
    (echoWithLabelAndCR as any).selfEcho = true;

    appendMessage(networkId, channel, echoWithLabelAndCR);

    expect(ircState.messages[key]).toHaveLength(1);
  });
});
