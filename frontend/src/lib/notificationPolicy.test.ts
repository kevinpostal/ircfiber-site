import { describe, it, expect, beforeEach } from 'vitest';
import {
  isNotableMessage,
  shouldNotifyForMessage,
  getNotificationTitle,
  getNotificationBody,
  getNotificationIcon,
  type NotifyPolicyInput,
} from './notificationPolicy';
import { createNetwork, createBuffer, createMessage } from '../test/factories';
import { bufferPrefsMap, setBufferPref, highlightWords, globalPrefs } from '../stores/preferences.svelte';
import type { IRCMessage } from '../types';

const NET_ID = 'net1';
const MSG_T = 1_700_000_000_000;

function net() {
  return createNetwork({ networkId: NET_ID, name: 'TestNet', nick: 'tester', currentNick: 'tester' });
}
function chan() {
  return createBuffer({ name: '#chan', type: 'channel' });
}
function query(name = 'alice') {
  return createBuffer({ name, type: 'query' });
}
function msg(overrides: Partial<IRCMessage> = {}): IRCMessage {
  return createMessage({ nick: 'alice', text: 'hello', t: MSG_T, ...overrides });
}

/** Defaults: notifiable context (booted, enabled, inactive buffer). */
function input(overrides: Partial<NotifyPolicyInput> = {}): NotifyPolicyInput {
  return {
    msg: msg(),
    net: net(),
    buf: chan(),
    ignored: false,
    bootComplete: true,
    desktopNotificationsEnabled: true,
    muteAll: false,
    isActiveBuffer: false,
    sessionFocused: true,
    bottomSeen: null,
    ...overrides,
  };
}

describe('notificationPolicy', () => {
  beforeEach(() => {
    for (const k of Object.keys(bufferPrefsMap)) delete bufferPrefsMap[k];
    highlightWords.length = 0;
    globalPrefs.inlineImages = true;
  });

  describe('isNotableMessage — IRCCloud Message.isNotable()', () => {
    it('is notable for a highlight in a channel', () => {
      expect(isNotableMessage(msg({ text: 'tester: ping' }), net(), chan(), false)).toBe(true);
    });

    it('is not notable for a plain channel message', () => {
      expect(isNotableMessage(msg(), net(), chan(), false)).toBe(false);
    });

    it('is notable for a NOTICE that highlights the current nick', () => {
      // IRCCloud parity: isHighlightable() covers isHighlight() first, so a
      // NOTICE naming you notifies even though notifyAll excludes notices.
      const m = msg({ command: 'NOTICE', nick: 'op', text: 'tester: server going down' });
      expect(isNotableMessage(m, net(), chan(), false)).toBe(true);
    });

    it('is not notable for a service NOTICE in a query', () => {
      const m = msg({ command: 'NOTICE', nick: 'NickServ', text: 'You are now identified' });
      expect(isNotableMessage(m, net(), query('NickServ'), false)).toBe(false);
    });

    it('is notable for a plain PRIVMSG in a query', () => {
      expect(isNotableMessage(msg(), net(), query(), false)).toBe(true);
    });

    it('is notable for an INVITE', () => {
      const m = msg({ command: 'INVITE', text: '', params: ['tester', '#chan'] });
      expect(isNotableMessage(m, net(), chan(), false)).toBe(true);
    });

    it('is notable for WALLOPS', () => {
      expect(isNotableMessage(msg({ command: 'WALLOPS', text: 'rebooting' }), net(), chan(), false)).toBe(true);
    });

    it('is notable for a plain channel message when notifyAll is set', () => {
      setBufferPref(NET_ID, '#chan', 'notifyAll', true);
      expect(isNotableMessage(msg(), net(), chan(), false)).toBe(true);
    });

    it('is not notable for a non-highlighting NOTICE even with notifyAll', () => {
      setBufferPref(NET_ID, '#chan', 'notifyAll', true);
      const m = msg({ command: 'NOTICE', nick: 'op', text: 'channel topic changed' });
      expect(isNotableMessage(m, net(), chan(), false)).toBe(false);
    });

    it('honours notifyAll on the server buffer (Fiber exposes the radio there)', () => {
      setBufferPref(NET_ID, '_server', 'notifyAll', true);
      const buf = createBuffer({ name: '_server', type: 'server' });
      expect(isNotableMessage(msg(), net(), buf, false)).toBe(true);
    });

    it('is not notable when the buffer is muted', () => {
      setBufferPref(NET_ID, '#chan', 'mute', true);
      expect(isNotableMessage(msg({ text: 'tester: ping' }), net(), chan(), false)).toBe(false);
    });

    it('is not notable when the message is ignored', () => {
      expect(isNotableMessage(msg({ text: 'tester: ping' }), net(), chan(), true)).toBe(false);
    });

    it('is not notable for a message from self', () => {
      expect(isNotableMessage(msg({ nick: 'tester', text: 'tester: ping' }), net(), query(), false)).toBe(false);
    });

    it('is not notable for a JOIN', () => {
      expect(isNotableMessage(msg({ command: 'JOIN', text: '' }), net(), query(), false)).toBe(false);
    });
  });

  describe('shouldNotifyForMessage — IRCCloud shouldNotify()', () => {
    it('notifies a highlight in an inactive channel', () => {
      expect(shouldNotifyForMessage(input({ msg: msg({ text: 'tester: ping' }) }))).toBe(true);
    });

    it('does not notify before boot completes', () => {
      expect(shouldNotifyForMessage(input({ msg: msg({ text: 'tester: ping' }), bootComplete: false }))).toBe(false);
    });

    it('does not notify when desktop notifications are disabled', () => {
      expect(shouldNotifyForMessage(input({
        msg: msg({ text: 'tester: ping' }),
        desktopNotificationsEnabled: false,
      }))).toBe(false);
    });

    it('does not notify when muteAll is set', () => {
      expect(shouldNotifyForMessage(input({ msg: msg({ text: 'tester: ping' }), muteAll: true }))).toBe(false);
    });

    it('is silent for the active buffer while pinned to the bottom and focused', () => {
      expect(shouldNotifyForMessage(input({
        msg: msg({ text: 'tester: ping' }),
        isActiveBuffer: true,
        sessionFocused: true,
        bottomSeen: null,
      }))).toBe(false);
    });

    it('notifies in the active focused buffer while scrolled up (bottomSeen locked below the message)', () => {
      expect(shouldNotifyForMessage(input({
        msg: msg({ text: 'tester: ping' }),
        isActiveBuffer: true,
        sessionFocused: true,
        bottomSeen: MSG_T - 1,
      }))).toBe(true);
    });

    it('stays silent in the active focused buffer when bottomSeen is at or past the message', () => {
      expect(shouldNotifyForMessage(input({
        msg: msg({ text: 'tester: ping' }),
        isActiveBuffer: true,
        sessionFocused: true,
        bottomSeen: MSG_T,
      }))).toBe(false);
    });

    it('notifies for the active buffer when the window is blurred', () => {
      expect(shouldNotifyForMessage(input({
        msg: msg({ text: 'tester: ping' }),
        isActiveBuffer: true,
        sessionFocused: false,
      }))).toBe(true);
    });

    it('notifies for an inactive buffer while the window is focused', () => {
      expect(shouldNotifyForMessage(input({
        msg: msg({ text: 'tester: ping' }),
        isActiveBuffer: false,
        sessionFocused: true,
      }))).toBe(true);
    });
  });

  describe('getNotificationTitle', () => {
    it('uses "<nick> — <channel>" in channels', () => {
      expect(getNotificationTitle(msg(), chan(), 'TestNet')).toBe('alice \u2014 #chan');
    });

    it('uses "<nick> — <network>" in queries', () => {
      expect(getNotificationTitle(msg(), query(), 'TestNet')).toBe('alice \u2014 TestNet');
    });

    it('formats channel invites', () => {
      const m = msg({ command: 'INVITE', params: ['tester', '#chan'], text: '' });
      expect(getNotificationTitle(m, chan(), 'TestNet')).toBe('Channel invite from: alice (TestNet)');
    });

    it('formats wallops', () => {
      expect(getNotificationTitle(msg({ command: 'WALLOPS' }), chan(), 'TestNet')).toBe('alice (TestNet)');
    });
  });

  describe('getNotificationBody', () => {
    it('strips IRC formatting codes', () => {
      expect(getNotificationBody(msg({ text: '\x0304,08hi \x02there\x02' }))).toBe('hi there');
    });

    it('replaces emoji colon codes', () => {
      expect(getNotificationBody(msg({ text: ':smile:' }))).toBe('\u{1F604}');
    });

    it('names the invited channel for INVITE', () => {
      const m = msg({ command: 'INVITE', params: ['tester', '#chan'], text: '' });
      expect(getNotificationBody(m)).toBe('Invite to join #chan');
    });
  });

  describe('getNotificationIcon', () => {
    it('uses the message\'s single inline image', () => {
      const icon = getNotificationIcon(net(), chan(), msg({ text: 'look https://example.com/cat.png' }));
      expect(icon).toBeTruthy();
      expect(icon).toContain('cat.png');
    });

    it('returns undefined without an image', () => {
      expect(getNotificationIcon(net(), chan(), msg())).toBeUndefined();
    });

    it('respects the global inline-images pref', () => {
      globalPrefs.inlineImages = false;
      expect(getNotificationIcon(net(), chan(), msg({ text: 'https://example.com/cat.png' }))).toBeUndefined();
    });

    it('respects the per-buffer inline-images override', () => {
      setBufferPref(NET_ID, '#chan', 'inlineImages', false);
      expect(getNotificationIcon(net(), chan(), msg({ text: 'https://example.com/cat.png' }))).toBeUndefined();
    });
  });
});
