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

  it('renders category labels', async () => {
    const net = createNetwork({ networkId: 'net1' });
    const buf = createBuffer({
      name: '#chan',
      users: [
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
    await expect.element(page.getByRole('heading', { name: /Owners/ })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: /Admins/ })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: /^Ops @/ })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: /Half-Ops/ })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: /Voiced/ })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: /Members/ })).toBeInTheDocument();
  });

  it('renders member count per category', async () => {
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
    await expect.element(page.getByText('@ 2')).toBeInTheDocument();
    await expect.element(page.getByText('• 1')).toBeInTheDocument();
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
