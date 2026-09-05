import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { userEvent } from 'vitest/browser';
import ServerLog from './ServerLog.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';
import type { Network } from '../types';

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
});

function setupServerBuffer(connected = true): Network {
  const network = createNetwork({
    networkId: 'net1',
    name: 'TestNet',
    connected,
    connectionState: connected ? 'connected' : 'connecting',
    host: 'irc.test.com',
    port: 6697,
  });
  network.buffers.push(createBuffer({ name: '_server' }));
  ircState.networks.push(network);
  ircState.activeBuffer.networkId = 'net1';
  ircState.activeBuffer.bufferName = '_server';
  return ircState.networks[0];
}

// Noon local time on a fixed day so date-boundary tests are timezone-safe.
const DAY = new Date(2026, 8, 1, 12, 0, 0).getTime();

function phase(p: string, text: string, t: number, eid: number) {
  return createMessage({ command: 'NOTICE', nick: undefined, text, t, eid, phase: p });
}

function connectSequence(base: number, eid = 1) {
  return [
    phase('queued', 'Queued for connection', base, eid),
    phase('connecting', 'Connecting to 10.0.0.1:6697', base + 22, eid + 1),
    phase('tcp_open', 'TCP connected', base + 308, eid + 2),
    phase('tls', 'TLS handshake', base + 312, eid + 3),
    phase('welcome', 'Registered', base + 1240, eid + 4),
  ];
}

describe('ServerLog', () => {
  it('renders the empty state when there are no messages', async () => {
    const network = setupServerBuffer();
    render(ServerLog, { props: { messages: [], network } });
    expect(document.querySelector('.serverLog__empty')?.textContent).toBe('No connection history yet.');
  });

  it('renders phase rows in order with rail ends, offsets and the Connected tag', async () => {
    const network = setupServerBuffer();
    render(ServerLog, { props: { messages: connectSequence(DAY), network } });

    const rows = Array.from(document.querySelectorAll('.row.phase'));
    expect(rows.map((r) => r.getAttribute('data-phase'))).toEqual(['queued', 'connecting', 'tcp_open', 'tls', 'welcome']);
    expect(rows[0].classList.contains('first')).toBe(true);
    expect(rows[0].classList.contains('last')).toBe(false);
    expect(rows[4].classList.contains('last')).toBe(true);
    expect(rows[4].classList.contains('ok')).toBe(true);
    expect(rows[4].querySelector('.content')?.textContent).toContain('Connected');
    expect(rows[4].querySelector('.tag')?.textContent).toBe('1.2s');

    const offsets = rows.map((r) => r.querySelector('.offs')?.textContent?.trim());
    expect(offsets).toEqual(['+0ms', '+22ms', '+308ms', '+312ms', '+1.24s']);
    // No attempt is in flight: nothing is live.
    expect(document.querySelector('.row.phase.live')).toBeNull();
    // Every row carries the shared timestamp markup.
    expect(rows[0].querySelector('.date > .timestamp')?.getAttribute('title')).toContain('2026');
  });

  it('marks only the in-flight last phase as live while the network is disconnected', async () => {
    const network = setupServerBuffer(false);
    const msgs = connectSequence(DAY).slice(0, 4); // queued … tls, no welcome
    render(ServerLog, { props: { messages: msgs, network } });

    const live = document.querySelectorAll('.row.phase.live');
    expect(live.length).toBe(1);
    expect(live[0].getAttribute('data-phase')).toBe('tls');
    expect(live[0].classList.contains('last')).toBe(true);
    expect(live[0].querySelector('.offs')?.classList.contains('hot')).toBe(true);
    expect(live[0].querySelector('[data-testid="live-elapsed"]')).not.toBeNull();
    expect(document.querySelector('.row.phase[data-phase="tcp_open"]')?.classList.contains('live')).toBe(false);
  });

  it('is not live once the network reports connected, even without a welcome phase', async () => {
    const network = setupServerBuffer(true);
    render(ServerLog, { props: { messages: connectSequence(DAY).slice(0, 4), network } });
    expect(document.querySelector('.row.phase.live')).toBeNull();
  });

  it('renders MOTD as one groupedLines block with a fold toggle', async () => {
    const network = setupServerBuffer();
    const msgs = [
      ...connectSequence(DAY),
      createMessage({ command: '375', nick: 'irc.test.com', text: '- irc.test.com Message of the Day -', t: DAY + 1300, eid: 20 }),
      createMessage({ command: '372', nick: 'irc.test.com', text: '- Welcome to TestNet', t: DAY + 1301, eid: 21 }),
      createMessage({ command: '372', nick: 'irc.test.com', text: '- \x0312blue art\x0f line', t: DAY + 1302, eid: 22 }),
      createMessage({ command: '376', nick: 'irc.test.com', text: 'End of /MOTD command.', t: DAY + 1303, eid: 23 }),
    ];
    render(ServerLog, { props: { messages: msgs, network } });

    const blocks = document.querySelectorAll('.row.grouped .groupedLines');
    expect(blocks.length).toBe(1);
    const block = blocks[0];
    expect(block.querySelector('h2 .host')?.textContent).toBe('irc.test.com');
    const lines = block.querySelectorAll('.l');
    expect(lines.length).toBe(2);
    expect(lines[0].textContent).toBe('- Welcome to TestNet');
    // mIRC colour codes render as formatting spans, not raw control chars.
    expect(lines[1].querySelector('.irccolor')).not.toBeNull();
    expect(lines[1].textContent).not.toContain('\x03');

    const tog = block.querySelector('.tog') as HTMLButtonElement;
    expect(tog.textContent?.trim()).toBe('hide');
    await userEvent.click(tog);
    await tick();
    expect(block.classList.contains('collapsed')).toBe(true);
    expect(tog.textContent?.trim()).toBe('show 2 lines');
    await userEvent.click(tog);
    await tick();
    expect(block.classList.contains('collapsed')).toBe(false);
  });

  it('merges every 005 line of an attempt into one isup row with a …more toggle', async () => {
    const network = setupServerBuffer();
    const msgs = [
      ...connectSequence(DAY),
      createMessage({ command: '005', nick: 'irc.test.com', text: '', params: ['nick', 'CHANTYPES=#', 'NICKLEN=30', ':are supported by this server'], t: DAY + 1244, eid: 30 }),
      createMessage({ command: '005', nick: 'irc.test.com', text: '', params: ['nick', 'SAFELIST', 'NETWORK=TestNet', ':are supported by this server'], t: DAY + 1245, eid: 31 }),
    ];
    render(ServerLog, { props: { messages: msgs, network } });

    const isup = document.querySelectorAll('.row.isup');
    expect(isup.length).toBe(1);
    const keys = Array.from(isup[0].querySelectorAll('.content b')).map((b) => b.textContent);
    expect(keys).toEqual(['CHANTYPES', 'NICKLEN', 'SAFELIST', 'NETWORK']);
    expect(isup[0].querySelector('.content')?.textContent).toContain('NETWORK=TestNet');

    const more = isup[0].querySelector('.more') as HTMLButtonElement;
    expect(more.textContent).toBe('…more');
    await userEvent.click(more);
    await tick();
    expect(isup[0].classList.contains('open')).toBe(true);
    expect(more.textContent).toBe('less');
  });

  it('renders DISCONNECT as a part divider followed by a Disconnected status row', async () => {
    const network = setupServerBuffer(false);
    const msgs = [
      ...connectSequence(DAY),
      createMessage({ command: 'DISCONNECTED', nick: undefined, text: 'Connection reset by peer', t: DAY + 3_600_000, eid: 40 }),
    ];
    render(ServerLog, { props: { messages: msgs, network } });

    const part = document.querySelector('.row.part');
    expect(part).not.toBeNull();
    expect(part!.querySelector('hr')).not.toBeNull();
    const status = part!.nextElementSibling as HTMLElement;
    expect(status.classList.contains('status')).toBe(true);
    expect(status.querySelector('.disco')?.textContent).toBe('Disconnected: Connection reset by peer');
    expect(status.querySelector('.kv')?.textContent).toContain('59m59s');
  });

  it('renders welcome numerics, other numerics and CAP notices as status rows', async () => {
    const network = setupServerBuffer();
    const msgs = [
      ...connectSequence(DAY),
      createMessage({ command: '001', nick: 'irc.test.com', text: 'Welcome to TestNet zodiac', t: DAY + 1242, eid: 50 }),
      createMessage({ command: '002', nick: 'irc.test.com', text: 'Your host is irc.test.com', t: DAY + 1243, eid: 51 }),
      createMessage({ command: '251', nick: 'irc.test.com', text: 'There are 61 users', t: DAY + 1250, eid: 52 }),
      createMessage({ command: 'CAP', nick: undefined, text: 'away-notify sasl=PLAIN', params: ['*', 'LS', 'away-notify sasl=PLAIN'], t: DAY + 640, eid: 53 }),
      createMessage({ command: 'NOTICE', nick: undefined, text: 'multi-prefix account-notify', t: DAY + 641, eid: 54 }),
    ];
    render(ServerLog, { props: { messages: msgs, network } });

    const welcome = document.querySelector('.row.status[data-cmd="001"]') as HTMLElement;
    expect(welcome.classList.contains('muted')).toBe(false);
    expect(welcome.textContent).toContain('Welcome to TestNet zodiac');
    expect(document.querySelector('.row.status[data-cmd="002"]')?.classList.contains('muted')).toBe(true);
    expect(document.querySelector('.row.status[data-cmd="251"]')?.classList.contains('muted')).toBe(true);

    const caps = Array.from(document.querySelectorAll('.row.status.muted'))
      .filter((r) => r.querySelector('.content > b')?.textContent === 'CAP');
    expect(caps.length).toBe(2);
    expect(caps[0].textContent).toContain('Server supports: away-notify | sasl=PLAIN');
    expect(caps[1].textContent).toContain('Server supports: multi-prefix | account-notify');
  });

  it('groups consecutive notices by author with a server or letter avatar', async () => {
    const network = setupServerBuffer();
    const msgs = [
      ...connectSequence(DAY),
      createMessage({ command: 'NOTICE', nick: 'irc.test.com', text: '*** Looking up your hostname...', t: DAY + 100, eid: 60 }),
      createMessage({ command: 'NOTICE', nick: 'irc.test.com', text: '*** Found your hostname', t: DAY + 101, eid: 61 }),
      createMessage({ command: 'NOTICE', nick: 'NickServ', text: 'This nickname is registered.', t: DAY + 1300, eid: 62 }),
      createMessage({ command: 'NOTICE', nick: 'NickServ', text: 'Please identify.', t: DAY + 1301, eid: 63 }),
    ];
    render(ServerLog, { props: { messages: msgs, network } });

    const notices = document.querySelectorAll('.row.notice');
    expect(notices.length).toBe(2);
    expect(notices[0].querySelector('.av')?.classList.contains('srv')).toBe(true);
    expect(notices[0].querySelector('.name')?.textContent).toBe('irc.test.com');
    expect(notices[0].querySelectorAll('.line').length).toBe(2);
    expect(notices[0].querySelector('.bot')).toBeNull();
    expect(notices[1].querySelector('.av')?.textContent).toBe('N');
    expect(notices[1].querySelector('.name')?.textContent).toBe('NickServ');
    expect(notices[1].querySelector('.bot')?.textContent).toBe('BOT');
    expect(notices[1].querySelectorAll('.line .date > .timestamp').length).toBe(2);
  });

  it('hides rows at or before the clearedAt watermark', async () => {
    const network = setupServerBuffer();
    const msgs = [
      ...connectSequence(DAY, 1),
      createMessage({ command: 'DISCONNECTED', nick: undefined, text: 'bye', t: DAY + 5000, eid: 70 }),
      ...connectSequence(DAY + 10_000, 80),
    ];
    clearedAtMap['net1:_server'] = DAY + 5000;
    render(ServerLog, { props: { messages: msgs, network } });

    expect(document.querySelector('.row.part')).toBeNull();
    const rows = document.querySelectorAll('.row.phase');
    expect(rows.length).toBe(5);
    rows.forEach((r) => expect(Number(r.getAttribute('data-time'))).toBeGreaterThan(DAY + 5000));
  });

  it('inserts a date header when the log crosses a day boundary', async () => {
    const network = setupServerBuffer();
    const msgs = [
      ...connectSequence(DAY - 3 * 86_400_000, 1),
      createMessage({ command: 'DISCONNECTED', nick: undefined, text: 'Closing Link', t: DAY - 3 * 86_400_000 + 63_000, eid: 70 }),
      ...connectSequence(DAY, 80),
    ];
    render(ServerLog, { props: { messages: msgs, network } });

    const headers = document.querySelectorAll('.row.dateChange');
    expect(headers.length).toBe(2);
    // The second header sits right before the second attempt's first row.
    const second = headers[1];
    expect(second.nextElementSibling?.getAttribute('data-phase')).toBe('queued');
    expect(Number(second.nextElementSibling?.getAttribute('data-time'))).toBe(DAY);
  });

  it('never renders engine state events or the self QUIT echo', async () => {
    const network = setupServerBuffer();
    const msgs = [
      ...connectSequence(DAY),
      createMessage({ command: 'ISUPPORT', nick: undefined, text: '{"PREFIX":"(ov)@+"}', t: DAY + 1300, eid: 10 }),
      createMessage({ command: 'CONNECTION_RETRY_STATUS', nick: undefined, text: '', t: DAY + 1400, eid: 11 }),
      createMessage({ command: 'CONNECTION_FAIL', nick: undefined, text: 'banned', t: DAY + 1500, eid: 12 }),
      createMessage({ command: 'QUIT', nick: 'me', text: 'K-Lined', t: DAY + 1600, eid: 13 }),
    ];
    render(ServerLog, { props: { messages: msgs, network } });
    const text = document.querySelector('.serverLog')!.textContent ?? '';
    expect(text).not.toContain('PREFIX');
    expect(text).not.toContain('K-Lined');
    expect(text).not.toContain('banned');
    expect(document.querySelector('.row.notice')).toBeNull();
  });

  it('renders self MODE / NICK as muted status rows, not author notices', async () => {
    const network = setupServerBuffer();
    const msgs = [
      ...connectSequence(DAY),
      createMessage({ command: 'MODE', nick: 'me', text: '+Ziw', t: DAY + 1300, eid: 10 }),
      createMessage({ command: 'NICK', nick: 'me', text: 'me2', t: DAY + 1400, eid: 11 }),
    ];
    render(ServerLog, { props: { messages: msgs, network } });
    const status = Array.from(document.querySelectorAll('.row.status.muted')).map((r) => r.textContent?.trim());
    expect(status.some((t) => t?.startsWith('Your user mode changed: +Ziw'))).toBe(true);
    expect(status.some((t) => t?.startsWith('You are now known as me2'))).toBe(true);
    expect(document.querySelector('.row.notice')).toBeNull();
  });

  it('drops the ERR numeric that merely echoes the disconnect reason', async () => {
    const network = setupServerBuffer();
    const reason = 'You are banned from this server- SASL required';
    const msgs = [
      ...connectSequence(DAY),
      createMessage({ command: 'DISCONNECTED', nick: undefined, text: reason, t: DAY + 3000, eid: 10 }),
      createMessage({ command: '465', nick: 'irc.test.com', text: reason, params: ['me', reason], t: DAY + 3005, eid: 11 }),
      createMessage({ command: '250', nick: 'irc.test.com', text: 'Highest count: 3', params: ['me', 'Highest count: 3'], t: DAY + 3010, eid: 12 }),
    ];
    render(ServerLog, { props: { messages: msgs, network } });
    const cmds = Array.from(document.querySelectorAll('.row.status')).map((r) => r.getAttribute('data-cmd'));
    expect(cmds).not.toContain('465');
    expect(cmds).toContain('250');
    expect(cmds.filter((c) => c === 'DISCONNECTED').length).toBe(1);
  });

  it('does not tick the last phase while the network is waiting to retry', async () => {
    const network = setupServerBuffer(false);
    network.connectionState = 'waiting_to_retry';
    const msgs = [
      ...connectSequence(DAY),
      createMessage({ command: 'DISCONNECTED', nick: undefined, text: 'reset', t: DAY + 3000, eid: 10 }),
      phase('queued', 'Server ban window active — retry in 1800s.', DAY + 3002, 11),
    ];
    render(ServerLog, { props: { messages: msgs, network } });
    await tick();
    const last = document.querySelector('.row.phase[data-phase="queued"]:last-of-type')!;
    expect(last.classList.contains('live')).toBe(false);
    expect(last.classList.contains('done')).toBe(true);

    network.connectionState = 'connecting';
    await tick();
    expect(document.querySelector('.row.phase.live')).not.toBeNull();
  });
  // Wire capture from irc.supernets.org, prod `_server` buffer 2026-09-05.
  // UnrealIRCd addresses us first and repeats the trailing as the last
  // parameter, so a trailing-only render loses the count / host / nick and
  // produced rows like "operator(s) online" and "End of /WHOIS list.".
  const SUPERNETS = [
    { command: '004', params: ['Zodifag', 'openwater.supernets.org', 'DangerousIRCd-6.6.6', 'UnrealIRCd-6.1.10', 'diopqrstxzBDGHIRSTZ'], text: '' },
    { command: '252', params: ['Zodifag', '5000', 'operator(s) online'], text: 'operator(s) online' },
    { command: '253', params: ['Zodifag', '2', 'unknown connection(s)'], text: 'unknown connection(s)' },
    { command: '254', params: ['Zodifag', '1000000', 'channels formed'], text: 'channels formed' },
    { command: '265', params: ['Zodifag', '1000000', '1000000', 'Current local users 1000000, max 1000000'], text: 'Current local users 1000000, max 1000000' },
    { command: '396', params: ['Zodifag', '5C17EEA5:5AA1AD86:1905531:IP', 'is now your displayed host'], text: 'is now your displayed host' },
    { command: '421', params: ['Zodifag', 'JOIN', 'You must be connected for at least 5 seconds'], text: 'You must be connected for at least 5 seconds' },
    { command: '311', params: ['Zodifag', 'maknho', '~maknho', 'B39D8C93.IP', '*', 'maknho'], text: 'maknho' },
    { command: '330', params: ['Zodifag', 'maknho', 'maknho', 'is logged in as'], text: 'is logged in as' },
    { command: '318', params: ['Zodifag', 'maknho', 'End of /WHOIS list.'], text: 'End of /WHOIS list.' },
  ];

  function supernetsMessages() {
    return SUPERNETS.map((s, i) =>
      createMessage({ ...s, nick: 'openwater.supernets.org', t: DAY + i, eid: 200 + i }),
    );
  }

  it('keeps the count, host and command that live in leading parameters', async () => {
    const network = setupServerBuffer();
    render(ServerLog, { props: { messages: supernetsMessages(), network } });

    const rows = Array.from(document.querySelectorAll('.row.status'));
    const byCmd = (cmd: string) => rows.find((r) => r.getAttribute('data-cmd') === cmd)?.textContent ?? '';

    expect(byCmd('252')).toContain('5000 operator(s) online');
    expect(byCmd('253')).toContain('2 unknown connection(s)');
    expect(byCmd('254')).toContain('1000000 channels formed');
    expect(byCmd('396')).toContain('5C17EEA5:5AA1AD86:1905531:IP is now your displayed host');
    expect(byCmd('421')).toContain('JOIN: You must be connected for at least 5 seconds');
    // 265 carries its numbers inside the trailing; IRCCloud does not
    // prefix that one, so the sentence must not gain a stray "1000000".
    expect(byCmd('265')).toContain('Current local users 1000000, max 1000000');
    expect(byCmd('265')).not.toMatch(/1000000\s+1000000\s+Current/);
  });

  it('never renders WHOIS answers or the raw RPL_MYINFO dump', async () => {
    const network = setupServerBuffer();
    render(ServerLog, { props: { messages: supernetsMessages(), network } });

    const cmds = Array.from(document.querySelectorAll('.row')).map((r) => r.getAttribute('data-cmd'));
    for (const whois of ['311', '318', '330']) expect(cmds).not.toContain(whois);
    expect(cmds).not.toContain('004');
    const body = document.querySelector('.serverLog')!.textContent ?? '';
    expect(body).not.toContain('End of /WHOIS list.');
    expect(body).not.toContain('is logged in as');
    // The raw parameter dump is what an operator saw instead of a sentence.
    expect(body).not.toContain('DangerousIRCd-6.6.6 UnrealIRCd-6.1.10');
  });
});
