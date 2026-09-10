import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import MemberList from './MemberList.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork, createBuffer, createMember } from '../test/factories';

describe('MemberList', () => {
  beforeEach(() => {
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
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
    await expect.element(page.getByRole('heading', { name: /^Staff/ })).toBeInTheDocument();
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
    // Members carries a count only, exactly as IRCCloud renders it.
    expect(header('members').querySelector('.mode_symbol')).toBeNull();
    expect(header('members').querySelector('.memberCount')!.textContent).toBe('1');
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
