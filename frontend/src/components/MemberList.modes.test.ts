import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import MemberList from './MemberList.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { processIrcEvent } from '../lib/messageHandler';
import { createNetwork, createBuffer, createMember } from '../test/factories';

// Every prefix mode must move the member in the sidebar in the same
// synchronous flush as the WebSocket frame — no batcher, no timer, no
// poll. The path under test is the real realtime pipeline:
//
//   engine compact WS payload → processIrcEvent → updateChannelUsers
//   → $state mutation → MemberList DOM
//
// Assertions below are deliberately SYNCHRONOUS (querySelector right
// after flushSync, never an awaited retry): if rendering ever goes
// async, these fail instead of passing after a wait.

function seedBob(member = createMember({ nick: 'bob' })): void {
  const net = createNetwork({ networkId: 'net1', currentNick: 'me' });
  net.buffers.push(createBuffer({ name: '#chan', users: [member] }));
  ircState.networks.push(net);
  ircState.activeBuffer.networkId = 'net1';
  ircState.activeBuffer.bufferName = '#chan';
}

// Shape mirrors IRCRawEvent.toCompactJson: c/ch/p/n/nid/t.
function fireMode(params: string[]): void {
  processIrcEvent(
    { c: 'MODE', n: 'Zodiac', ch: '#chan', p: params, nid: 'net1', t: Date.now() },
    { value: 0 },
    { whoisAcc: null, whoisAccs: new Map(), banAcc: [], banTargetChannel: '' },
    { switchToBuffer: () => {} },
    () => {},
  );
  flushSync();
}

function sectionHas(cls: string, nick: string): boolean {
  const sec = document.querySelector(`.memberList li.category.${cls}`);
  if (!sec) return false;
  return [...sec.querySelectorAll('.member-item')].some((el) =>
    (el.textContent ?? '').includes(nick),
  );
}

function hasSection(cls: string): boolean {
  return document.querySelector(`.memberList li.category.${cls}`) !== null;
}

describe('MemberList realtime mode updates', () => {
  beforeEach(() => {
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    ircState.messages = {};
  });

  it('+v moves bob to Voiced', () => {
    seedBob();
    render(MemberList);
    expect(sectionHas('members', 'bob')).toBe(true);

    fireMode(['#chan', '+v', 'bob']);

    expect(sectionHas('voiced', 'bob')).toBe(true);
    expect(hasSection('members')).toBe(false);
  });

  it('+h moves bob to Staff', () => {
    seedBob();
    render(MemberList);

    fireMode(['#chan', '+h', 'bob']);

    expect(sectionHas('halfops', 'bob')).toBe(true);
    expect(hasSection('members')).toBe(false);
  });

  it('+o moves bob to Ops', () => {
    seedBob();
    render(MemberList);

    fireMode(['#chan', '+o', 'bob']);

    expect(sectionHas('ops', 'bob')).toBe(true);
    expect(hasSection('members')).toBe(false);
  });

  it('+a moves bob to Admins', () => {
    seedBob();
    render(MemberList);

    fireMode(['#chan', '+a', 'bob']);

    expect(sectionHas('admin', 'bob')).toBe(true);
    expect(hasSection('members')).toBe(false);
  });

  it('+q moves bob to Owner', () => {
    seedBob();
    render(MemberList);

    fireMode(['#chan', '+q', 'bob']);

    expect(sectionHas('owner', 'bob')).toBe(true);
    expect(hasSection('members')).toBe(false);
  });

  it('+ao on the same nick twice lands in Admins (production #ircfiber case)', () => {
    seedBob();
    render(MemberList);

    fireMode(['#chan', '+ao', 'bob', 'bob']);

    expect(sectionHas('admin', 'bob')).toBe(true);
    expect(hasSection('ops')).toBe(false);
    expect(hasSection('members')).toBe(false);
  });

  it('-v returns bob to Members', () => {
    seedBob(createMember({ nick: '+bob', prefix: '+', category: 'VOICED' }));
    render(MemberList);
    expect(sectionHas('voiced', 'bob')).toBe(true);

    fireMode(['#chan', '-v', 'bob']);

    expect(sectionHas('members', 'bob')).toBe(true);
    expect(hasSection('voiced')).toBe(false);
  });

  it('-h returns bob to Members', () => {
    seedBob(createMember({ nick: '%bob', prefix: '%', category: 'HALFOP' }));
    render(MemberList);

    fireMode(['#chan', '-h', 'bob']);

    expect(sectionHas('members', 'bob')).toBe(true);
    expect(hasSection('halfops')).toBe(false);
  });

  it('-o returns bob to Members', () => {
    seedBob(createMember({ nick: '@bob', prefix: '@', category: 'OP' }));
    render(MemberList);

    fireMode(['#chan', '-o', 'bob']);

    expect(sectionHas('members', 'bob')).toBe(true);
    expect(hasSection('ops')).toBe(false);
  });

  it('-a keeps the lower op: Admins → Ops (production SOP→AOP revert)', () => {
    seedBob(createMember({ nick: '&@bob', prefix: '&', category: 'ADMIN' }));
    render(MemberList);
    expect(sectionHas('admin', 'bob')).toBe(true);

    fireMode(['#chan', '-a', 'bob']);

    expect(sectionHas('ops', 'bob')).toBe(true);
    expect(hasSection('admin')).toBe(false);
  });

  it('-q keeps the lower op: Owner → Ops', () => {
    seedBob(createMember({ nick: '~@bob', prefix: '~', category: 'OWNER' }));
    render(MemberList);

    fireMode(['#chan', '-q', 'bob']);

    expect(sectionHas('ops', 'bob')).toBe(true);
    expect(hasSection('owner')).toBe(false);
  });
});
