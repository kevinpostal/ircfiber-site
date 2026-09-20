import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import MemberList from './MemberList.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork, createBuffer, createMember } from '../test/factories';
import { nickColorIndex } from '../lib/utils';
import { setShowMemberPrefixes } from '../stores/preferences.svelte';

describe('MemberList', () => {
  beforeEach(() => {
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    // Fresh-account default; the one test that needs glyphs opts in.
    setShowMemberPrefixes(false);
  });

  it('renders members grouped by mode category', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({
      name: '#chan',
      users: [
        createMember({ nick: '@op1', prefix: '@', category: 'OP' }),
        createMember({ nick: 'member1', prefix: '', category: 'MEMBER' }),
      ],
    });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(MemberList);
    await expect.element(page.getByText('op1')).toBeInTheDocument();
    await expect.element(page.getByText('member1')).toBeInTheDocument();
  });

  it('renders a formatted nick as markup with no control bytes', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({
      name: '#chan',
      users: [createMember({ nick: '\x02Bold\x02', prefix: '', category: 'MEMBER' })],
    });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(MemberList);
    const el = document.querySelector('.member-nick');
    expect(el?.querySelector('.bold')?.textContent).toBe('Bold');
    expect(el?.textContent).toBe('Bold');
    // The click hands the raw nick on, so a WHOIS from the popup reaches the server's spelling.
    expect(document.querySelector<HTMLElement>('.member-item button')?.title).toBe('Bold');
  });

  it('badges bot members with a BOT pill', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({
      name: '#chan',
      users: [
        createMember({ nick: 'GURU', isBot: true }),
        createMember({ nick: 'member1' }),
      ],
    });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(MemberList);
    await expect.element(page.getByTitle('Bot')).toBeInTheDocument();
  });

  it('renders IRCCloud category labels', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({
      name: '#chan',
      users: [
        createMember({ nick: '*oper1', prefix: '*', category: 'OPER' }),
        createMember({ nick: '~owner1', prefix: '~', category: 'OWNER' }),
        createMember({ nick: '&admin1', prefix: '&', category: 'ADMIN' }),
        createMember({ nick: '@op1', prefix: '@', category: 'OP' }),
        createMember({ nick: '%halfop1', prefix: '%', category: 'HALFOP' }),
        createMember({ nick: '+voiced1', prefix: '+', category: 'VOICED' }),
        createMember({ nick: 'member1', prefix: '', category: 'MEMBER' }),
      ],
    });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(MemberList);
    await expect.element(page.getByRole('heading', { name: /^Oper/ })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: /^Owner/ })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: /^Admins/ })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: /^Ops/ })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: /^Half ops/ })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: /^Voiced/ })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: /^Members/ })).toBeInTheDocument();
  });

  // The bug this guards: OPER/OWNER/ADMIN all rendered with the `ops`
  // class, so a services bot holding `&` (FiberServ, channel mode +a) sat
  // inside the red "Ops" band and the Admins section never appeared.
  it('gives every category its own section class', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({
      name: '#chan',
      users: [
        createMember({ nick: '*Zodiac', prefix: '*', category: 'OPER' }),
        createMember({ nick: '&FiberServ', prefix: '&', category: 'ADMIN' }),
        createMember({ nick: '@op1', prefix: '@', category: 'OP' }),
      ],
    });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(MemberList);
    await expect.element(page.getByText('FiberServ')).toBeInTheDocument();
    const section = (cls: string) =>
      document.querySelector(`.memberList li.category.${cls}`);
    expect(section('oper')).not.toBeNull();
    expect(section('admin')).not.toBeNull();
    expect(section('ops')).not.toBeNull();
    expect(section('admin')!.querySelector('.member-item')!.textContent)
      .toContain('FiberServ');
    expect(section('ops')!.textContent).not.toContain('FiberServ');
  });

  it('renders the mode symbol and count in each category header', async () => {
    // Prefix glyphs are off for a fresh account, so the test drives the
    // pref rather than relying on the default.
    setShowMemberPrefixes(true);
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({
      name: '#chan',
      users: [
        createMember({ nick: '@op1', prefix: '@', category: 'OP' }),
        createMember({ nick: '@op2', prefix: '@', category: 'OP' }),
        createMember({ nick: 'member1', prefix: '', category: 'MEMBER' }),
      ],
    });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(MemberList);
    const header = (cls: string) =>
      document.querySelector(`.memberList li.category.${cls} h2`)!;
    expect(header('ops').querySelector('.mode_symbol')!.textContent).toBe('@');
    expect(header('ops').querySelector('.memberCount')!.textContent).toBe('2');
    // Members has no mode char, so its bullet is the always-visible
    // `memberDot` stand-in; ranked bands keep the dots-mode-only pill.
    expect(header('members').querySelector('.mode_symbol')).toBeNull();
    expect(header('members').querySelector('.mode_pill')!.textContent).toBe('\u2022');
    expect(header('members').querySelector('.mode_pill')!.classList.contains('memberDot')).toBe(true);
    expect(header('ops').querySelector('.mode_pill')!.classList.contains('memberDot')).toBe(false);
    expect(header('members').querySelector('.memberCount')!.textContent).toBe('1');
  });

  it('hides every mode glyph by default (fresh account)', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({
      name: '#chan',
      users: [createMember({ nick: '@op1', prefix: '@', category: 'OP' })],
    });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(MemberList);
    expect(document.querySelector('.memberList .mode_symbol')).toBeNull();
    expect(document.querySelector('.memberList .mode_pill')).toBeNull();
    expect(document.querySelector('.member-mode-prefix')).toBeNull();
    // The count still renders — it is not part of the prefix pref.
    expect(document.querySelector('.memberList .memberCount')!.textContent).toBe('1');
  });

  it('exposes the usermask the way IRCCloud does', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({
      name: '#chan',
      users: [
        createMember({ nick: '&sq', prefix: '&', category: 'ADMIN', ident: '~sq', host: 'qefugmwi.hidden' }),
        createMember({ nick: 'bare', prefix: '', category: 'MEMBER' }),
      ],
    });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(MemberList);
    const row = document.querySelector('.member-item[data-category="ADMIN"]') as HTMLElement;
    expect(row.dataset.usermask).toBe('~sq@qefugmwi.hidden');
    // `data-ident_prefix` keeps IRCCloud's underscore, so it is not a
    // camelCased `dataset` key.
    expect(row.getAttribute('data-ident_prefix')).toBe('~');
    expect(row.dataset.user).toBe('sq');
    expect(row.dataset.userhost).toBe('qefugmwi.hidden');
    expect(row.querySelector('button')!.title).toBe('sq (~sq@qefugmwi.hidden)');
    // A member we have no mask for falls back to the bare nick.
    const bare = document.querySelector('.member-item[data-category="MEMBER"]') as HTMLElement;
    expect(bare.dataset.usermask).toBe('');
    expect(bare.querySelector('button')!.title).toBe('bare');
  });

  it('paints each row with its IRCCloud nick colour', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({
      name: '#chan',
      users: [createMember({ nick: '@roarie', prefix: '@', category: 'OP' })],
    });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(MemberList);
    const row = document.querySelector('.member-item') as HTMLElement;
    // Same hash the avatars and message authors use, on the stripped nick.
    expect(row.classList.contains(`c${nickColorIndex('roarie')}`)).toBe(true);
  });

  it('calls onNickClick when member nick clicked', async () => {
    const onNickClick = vi.fn();
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({
      name: '#chan',
      users: [createMember({ nick: 'alice', prefix: '', category: 'MEMBER' })],
    });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(MemberList, { props: { onNickClick } });
    const nickButton = page.getByText('alice');
    await userEvent.click(nickButton);
    expect(onNickClick).toHaveBeenCalledTimes(1);
    expect(onNickClick).toHaveBeenCalledTimes(1);
    expect(onNickClick.mock.calls[0][0]).toBe('alice');
  });

  it('renders empty state when no members', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({ name: '#chan', users: [] });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    render(MemberList);
    await expect.element(page.getByText('Members')).not.toBeInTheDocument();
  });
});
