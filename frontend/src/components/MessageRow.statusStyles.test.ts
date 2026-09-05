// Status/activity row styling parity with IRCCloud.
//
// Source (common-5650bddb.js, common-002a6024.css, and the live theme-midnight
// DOM at irccloud.com):
//   * joined_channel / parted_channel / quit / nickchange / user_chghost /
//     kicked_channel go through `renderLine` → a bare `messageRow`. They carry
//     no colour class and inherit `div.log`'s colour (#737373 in midnight) at
//     the log's own font size. AWAY has no IRCCloud row at all (`user_away`,
//     `user_back`, `self_away`, `self_back` are in `unrendered_messages`), so
//     we render it in the same user-activity style.
//   * channel_topic / channel_mode / user_channel_mode → `renderStatus` →
//     ["status"]: tinted background, chat-tier text, proportional font.
//   * numerics / self_details / logged_in_as / user_mode / cap_* / error →
//     `renderMonoStatus` → ["status","monospace"], `.content` at #bfbfbf.
//   * notice / invited / channel_invite → `renderNotice` → ["notice"].
//   * `div.log span.prefix { font-size:13px }` + a sans-serif family in
//     monospace logs, on every arrow regardless of row type.
import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MessageRow from './MessageRow.svelte';
import { createMessage } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';
// The tokens under test live in :root / the theme files.
import '../styles/main.scss';

function resetState(): void {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  document.body.innerHTML = '';
}

beforeEach(resetState);

const row = () => document.querySelector('.row.messageRow') as HTMLElement;
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const LOG_FG = rgb('#737373');
const MONO_FG = rgb('#bfbfbf');
const STATUS_BG = rgb('#1a1a1a');
const PREFIX_FG = rgb('#b3b3b3');

describe('user-activity rows (renderLine parity)', () => {
  const activity: [string, ReturnType<typeof createMessage>][] = [
    ['JOIN', createMessage({ command: 'JOIN', nick: 'space', prefix: 'space!time@E1CE7DAA:DE0BBF67:A03B754D:IP' })],
    ['PART', createMessage({ command: 'PART', nick: 'space', text: 'bye' })],
    ['QUIT', createMessage({ command: 'QUIT', nick: 'space', text: 'Ping timeout' })],
    ['NICK', createMessage({ command: 'NICK', nick: 'space', params: ['spacey'] })],
    ['CHGHOST', createMessage({ command: 'CHGHOST', nick: 'space', prefix: 'space!time@old.host', params: ['time', 'new.host'] })],
    ['KICK', createMessage({ command: 'KICK', nick: 'op', params: ['#chan', 'space'], text: 'out' })],
    ['AWAY', createMessage({ command: 'AWAY', nick: 'nevenen', text: '' })],
  ];

  for (const [cmd, msg] of activity) {
    it(`${cmd} renders at the log colour, not as a monospace status row`, () => {
      render(MessageRow, { props: { msg } });
      const r = row();
      expect(r.classList.contains('joinPart'), `${cmd} is a joinPart row`).toBe(true);
      expect(r.classList.contains('monospace'), `${cmd} is not monospace`).toBe(false);
      expect(r.classList.contains('status'), `${cmd} is not a status row`).toBe(false);
      expect(getComputedStyle(r).color).toBe(LOG_FG);
      // No tinted background: only IRCCloud's status/notice rows get one.
      expect(getComputedStyle(r).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    });
  }

  it('sizes activity rows like the rest of the log', () => {
    render(MessageRow, { props: { msg: createMessage({ command: 'JOIN', nick: 'space' }) } });
    const joinSize = getComputedStyle(row()).fontSize;
    resetState();
    render(MessageRow, { props: { msg: createMessage({ nick: 'alice', text: 'hi' }) } });
    expect(joinSize).toBe(getComputedStyle(row()).fontSize);
  });

  it('keeps the hostmask on a join, as IRCCloud does for every non-Twitch/Slack network', () => {
    render(MessageRow, { props: { msg: createMessage({ command: 'JOIN', nick: 'space', prefix: 'space!time@E1CE7DAA:DE0BBF67:A03B754D:IP' }) } });
    expect(row().textContent).toContain('joined (time@E1CE7DAA:DE0BBF67:A03B754D:IP)');
  });

  it('renders away and back with the same markup the collapsed group uses', () => {
    render(MessageRow, { props: { msg: createMessage({ command: 'AWAY', nick: 'nevenen', text: '' }) } });
    const r = row();
    expect(r.textContent).toContain('nevenen is back');
    // Linked nick and a flag prefix, matching the expanded group rows.
    expect(r.querySelector('.bufferLink.user')?.textContent).toBe('nevenen');
    expect(r.querySelector('.prefix')?.textContent).toBe('\u2691');
  });

  it('renders a nick change as "old → new" like IRCCloud nickchange', () => {
    render(MessageRow, { props: { msg: createMessage({ command: 'NICK', nick: 'space', params: ['spacey'] }) } });
    const r = row();
    expect(r.textContent?.replace(/\s+/g, ' ')).toContain('space \u2192 spacey');
    expect(r.querySelector('.bufferLink.user')?.textContent).toBe('spacey');
  });

  it('renders a chghost as "nick changed host: old → new"', () => {
    render(MessageRow, { props: { msg: createMessage({ command: 'CHGHOST', nick: 'space', prefix: 'space!time@old.host', params: ['time', 'new.host'] }) } });
    expect(row().textContent?.replace(/\s+/g, ' ')).toContain('space changed host: time@old.host \u2192 time@new.host');
  });

  it('inherits the row colour on activity nick links instead of brightening them', () => {
    render(MessageRow, { props: { msg: createMessage({ command: 'JOIN', nick: 'space' }) } });
    const r = row();
    const link = r.querySelector('.bufferLink.user') as HTMLElement;
    expect(getComputedStyle(link).color).toBe(getComputedStyle(r).color);
  });
});

describe('server-output rows', () => {
  it('renders numerics as a tinted monospace status row', () => {
    render(MessageRow, { props: { msg: createMessage({ command: '001', nick: '', text: 'Welcome to the network' }) } });
    const r = row();
    expect(r.classList.contains('status')).toBe(true);
    expect(r.classList.contains('monospace')).toBe(true);
    expect(getComputedStyle(r).backgroundColor).toBe(STATUS_BG);
    const content = r.querySelector('.content') as HTMLElement;
    expect(getComputedStyle(content).color).toBe(MONO_FG);
  });

  it('renders an account login as a monospace status row', () => {
    render(MessageRow, { props: { msg: createMessage({ command: 'ACCOUNT', nick: 'space', text: 'spaceacct' }) } });
    const r = row();
    expect(r.classList.contains('monospace')).toBe(true);
    expect(r.textContent).toContain('space logged in as spaceacct');
  });

  it('renders topic and mode changes as status rows without the monospace tier', () => {
    for (const msg of [
      createMessage({ command: 'TOPIC', nick: 'op', text: 'new topic' }),
      createMessage({ command: 'MODE', nick: 'op', params: ['#chan', '+m'] }),
    ]) {
      resetState();
      render(MessageRow, { props: { msg } });
      const r = row();
      expect(r.classList.contains('status'), `${msg.command} is a status row`).toBe(true);
      expect(r.classList.contains('monospace'), `${msg.command} is not monospace`).toBe(false);
      expect(getComputedStyle(r).backgroundColor).toBe(STATUS_BG);
    }
  });

  it('renders an invite as a notice row', () => {
    render(MessageRow, { props: { msg: createMessage({ command: 'INVITE', nick: 'op', params: ['space', '#chan'] }) } });
    const r = row();
    expect(r.classList.contains('notice')).toBe(true);
    expect(r.classList.contains('monospace')).toBe(false);
  });
});

describe('prefix arrows', () => {
  it('are one colour and size across every row type that carries one', () => {
    const seen = new Set<string>();
    for (const msg of [
      createMessage({ command: 'JOIN', nick: 'space' }),
      createMessage({ command: 'QUIT', nick: 'space' }),
      createMessage({ command: 'AWAY', nick: 'space', text: '' }),
      createMessage({ command: 'KICK', nick: 'op', params: ['#chan', 'space'] }),
    ]) {
      resetState();
      render(MessageRow, { props: { msg } });
      const prefix = row().querySelector('.prefix') as HTMLElement;
      expect(prefix, `${msg.command} has a prefix`).not.toBeNull();
      const cs = getComputedStyle(prefix);
      expect(cs.color).toBe(PREFIX_FG);
      expect(cs.fontSize).toBe('13px');
      // IRCCloud renders the arrows proportional even in a monospace log.
      expect(cs.fontFamily).not.toMatch(/Hack|monospace/);
      seen.add(cs.color + cs.fontSize);
    }
    expect(seen.size).toBe(1);
  });
});
