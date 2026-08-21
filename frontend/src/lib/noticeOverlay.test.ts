import { describe, it, expect, beforeEach } from 'vitest';
import { noticeState, addNotice, dismissAll, _clearDismissedForTest } from '../stores/noticeOverlay.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { processIrcEvent, type AccumState } from './messageHandler';

describe('noticeOverlay', () => {
  beforeEach(() => {
    dismissAll();
    _clearDismissedForTest();
    ircState.networks = [
      {
        networkId: 'net1',
        name: 'SuperNETs',
        nick: 'Zod32',
        currentNick: 'Zod32',
        buffers: [{ name: '_server', type: 'console', isJoined: true } as any],
      } as any,
    ];
    ircState.messages = {};
    ircState.processedMessages = {};
  });

  function mkAccum(): AccumState {
    return { whoisAcc: null, whoisAccs: new Map(), banAcc: [], banTargetChannel: '' };
  }

  function sendNotice(nick: string, text: string, target = 'Zod32') {
    const data: Record<string, unknown> = {
      command: 'NOTICE',
      nick,
      text,
      params: [target, text],
      prefix: `${nick}!user@host`,
      channel: '_server',
      nid: 'net1',
      network: 'SuperNETs',
      t: Date.now(),
    };
    return processIrcEvent(data, { value: 0 }, mkAccum(), { switchToBuffer: () => {} }, () => {});
  }

  it('adds private NOTICE from NickServ to overlay', () => {
    sendNotice('NickServ', 'Your nickname is not registered. To register it, use: /msg NickServ REGISTER password');
    expect(noticeState.entries.length).toBe(1);
    expect(noticeState.entries[0].nick).toBe('NickServ');
    expect(noticeState.entries[0].networkName).toBe('SuperNETs');
  });

  it('stacks multiple notices', () => {
    sendNotice('NickServ', 'Your nickname is not registered.');
    sendNotice('EliManning', '[#superbowl] JOIN #5000 NOW');
    sendNotice('NickServ', "Nick Zod32 isn't registered.");
    expect(noticeState.entries.length).toBe(3);
    expect(noticeState.entries[1].nick).toBe('EliManning');
  });

  it('ignores server *** notices', () => {
    sendNotice('irc.supernets.org', '*** Looking up your hostname...');
    expect(noticeState.entries.length).toBe(0);
  });

  it('ignores channel NOTICE', () => {
    const data: Record<string, unknown> = {
      command: 'NOTICE',
      nick: 'EliManning',
      text: 'channel notice',
      params: ['#superbowl', 'channel notice'],
      prefix: 'EliManning!u@h',
      channel: '#superbowl',
      nid: 'net1',
      network: 'SuperNETs',
      t: Date.now(),
    };
    processIrcEvent(data, { value: 0 }, mkAccum(), { switchToBuffer: () => {} }, () => {});
    expect(noticeState.entries.length).toBe(0);
  });

  it('ignores self NOTICE', () => {
    sendNotice('Zod32', 'hello');
    expect(noticeState.entries.length).toBe(0);
  });

  it('dismissAll clears', () => {
    sendNotice('NickServ', 'hi');
    expect(noticeState.entries.length).toBe(1);
    dismissAll();
    expect(noticeState.entries.length).toBe(0);
  });
  it('dedups rapid duplicate', () => {
    const t = Date.now();
    addNotice({ nick: 'NickServ', networkId: 'net1', networkName: 'SuperNETs', text: 'dup', t });
    addNotice({ nick: 'NickServ', networkId: 'net1', networkName: 'SuperNETs', text: 'dup', t: t + 100 });
    expect(noticeState.entries.length).toBe(1);
  });

  it('does not re-add after dismiss (persisted across refresh)', () => {
    const t = Date.now();
    addNotice({ nick: 'EliManning', networkId: 'net1', networkName: 'SuperNETs', text: '[#superbowl] JOIN #5000 NOW', t });
    expect(noticeState.entries.length).toBe(1);
    dismissAll();
    expect(noticeState.entries.length).toBe(0);
    // Same notice with new t should be suppressed via dismissedSet
    addNotice({ nick: 'EliManning', networkId: 'net1', networkName: 'SuperNETs', text: '[#superbowl] JOIN #5000 NOW', t: t + 10000 });
    expect(noticeState.entries.length).toBe(0);
    // Different text should still show
    addNotice({ nick: 'EliManning', networkId: 'net1', networkName: 'SuperNETs', text: '[#other] JOIN #5000 NOW', t: t + 10000 });
    expect(noticeState.entries.length).toBe(1);
  });

  it('ignores backfill NOTICE (CHATHISTORY replay on refresh)', () => {
    const data: Record<string, unknown> = {
      command: 'NOTICE',
      nick: 'EliManning',
      text: '[#superbowl] JOIN #5000 NOW',
      params: ['Zod32', '[#superbowl] JOIN #5000 NOW'],
      prefix: 'EliManning!u@h',
      channel: '_server',
      nid: 'net1',
      network: 'SuperNETs',
      t: Date.now(),
      batch: 'chathistory',
      tags: { batch: 'chathistory' },
    };
    processIrcEvent(data, { value: 0 }, mkAccum(), { switchToBuffer: () => {} }, () => {});
    expect(noticeState.entries.length).toBe(0);
    // Same notice as live (no batch) should show
    const live = { ...data, batch: undefined, tags: {} as any };
    processIrcEvent(live, { value: 0 }, mkAccum(), { switchToBuffer: () => {} }, () => {});
    expect(noticeState.entries.length).toBe(1);
  });
});
