import { describe, it, expect } from 'vitest';
import { shouldNotifyForMessage, isChatMessage, getNotificationTitle } from './notificationPolicy';
import type { IRCMessage, Buffer } from '../types';
import type { BufferPrefs } from '../stores/preferences.svelte';

function makeMsg(overrides: Partial<IRCMessage> = {}): IRCMessage {
  return {
    command: 'PRIVMSG',
    nick: 'alice',
    text: 'hello',
    ...overrides,
  };
}

function baseInput(overrides: Partial<Parameters<typeof shouldNotifyForMessage>[0]> = {}) {
  return {
    networkId: 'net1',
    bufferName: '#chan',
    bufferType: 'channel' as const,
    msg: makeMsg(),
    currentNick: 'bob',
    bufferPrefs: {} as BufferPrefs,
    desktopNotificationsEnabled: true,
    muteAll: false,
    isActiveBuffer: false,
    documentHidden: true,
    ...overrides,
  };
}

describe('isChatMessage', () => {
  it('returns true for PRIVMSG', () => {
    expect(isChatMessage(makeMsg({ command: 'PRIVMSG' }))).toBe(true);
  });

  it('returns false for NOTICE (IRCCloud parity: NickServ etc. must not notify)', () => {
    expect(isChatMessage(makeMsg({ command: 'NOTICE' }))).toBe(false);
  });

  it('returns true for actions', () => {
    expect(isChatMessage(makeMsg({ command: 'PRIVMSG', type: 'action' }))).toBe(true);
  });

  it('returns false for JOIN', () => {
    expect(isChatMessage(makeMsg({ command: 'JOIN' }))).toBe(false);
  });
});

describe('shouldNotifyForMessage', () => {
  it('notifies on highlights in channels', () => {
    expect(shouldNotifyForMessage(baseInput({ msg: makeMsg({ highlight: true }) }))).toBe(true);
  });

  it('notifies on all messages in a channel with notifyAll', () => {
    expect(shouldNotifyForMessage(baseInput({ bufferPrefs: { notifyAll: true } }))).toBe(true);
  });

  it('notifies on all query messages', () => {
    expect(shouldNotifyForMessage(baseInput({ bufferType: 'query', bufferName: 'alice' }))).toBe(true);
  });

  it('does NOT notify for NOTICE in query (NickServ spam)', () => {
    expect(shouldNotifyForMessage(baseInput({ bufferType: 'query', bufferName: 'NickServ', msg: makeMsg({ command: 'NOTICE', nick: 'NickServ', text: 'You are now identified' }) }))).toBe(false);
  });

  it('does not notify for non-highlight, non-notifyAll channel messages', () => {
    expect(shouldNotifyForMessage(baseInput())).toBe(false);
  });

  it('does not notify when desktop notifications are disabled', () => {
    expect(shouldNotifyForMessage(baseInput({
      desktopNotificationsEnabled: false,
      msg: makeMsg({ highlight: true }),
    }))).toBe(false);
  });

  it('does not notify when muteAll is enabled', () => {
    expect(shouldNotifyForMessage(baseInput({
      muteAll: true,
      msg: makeMsg({ highlight: true }),
    }))).toBe(false);
  });

  it('does not notify when buffer is muted', () => {
    expect(shouldNotifyForMessage(baseInput({
      bufferPrefs: { mute: true },
      msg: makeMsg({ highlight: true }),
    }))).toBe(false);
  });

  it('does not notify for messages from self', () => {
    expect(shouldNotifyForMessage(baseInput({
      currentNick: 'alice',
      bufferType: 'query',
      bufferName: 'bob',
    }))).toBe(false);
  });

  it('does not notify for non-chat messages', () => {
    expect(shouldNotifyForMessage(baseInput({
      msg: makeMsg({ command: 'JOIN' }),
      bufferType: 'query',
    }))).toBe(false);
  });

  it('does not notify for the active buffer when document is visible', () => {
    expect(shouldNotifyForMessage(baseInput({
      isActiveBuffer: true,
      documentHidden: false,
      msg: makeMsg({ highlight: true }),
    }))).toBe(false);
  });

  it('notifies for the active buffer when document is hidden', () => {
    expect(shouldNotifyForMessage(baseInput({
      isActiveBuffer: true,
      documentHidden: true,
      msg: makeMsg({ highlight: true }),
    }))).toBe(true);
  });

  it('notifies for a non-active buffer even when document is visible', () => {
    expect(shouldNotifyForMessage(baseInput({
      isActiveBuffer: false,
      documentHidden: false,
      msg: makeMsg({ highlight: true }),
    }))).toBe(true);
  });
});

describe('getNotificationTitle', () => {
  it('uses nick only for queries', () => {
    expect(getNotificationTitle(makeMsg({ nick: 'alice' }), 'query', 'alice')).toBe('alice');
  });

  it('uses nick and channel for channels', () => {
    expect(getNotificationTitle(makeMsg({ nick: 'alice' }), 'channel', '#chan')).toBe('alice in #chan');
  });
});
