import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openChannelLink, handleChannelLinkClick } from '../lib/channelLinks';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork, createBuffer } from '../test/factories';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
  setMaxEid: vi.fn(),
}));

// Lives in components/ (not lib/) because the client vitest project
// excludes src/lib — these tests need a real DOM for click delegation.
// IRCCloud's channel-link contract (common-5650bddb.js route handler):
// an existing buffer is selected, an unknown channel is joined and then
// selected. The anchors come from autolinker (`a.channelLink`).
describe('channel links', () => {
  beforeEach(() => {
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    const net = createNetwork({ networkId: 'n1', currentNick: 'me' });
    net.buffers.push(createBuffer({ name: '#home', isJoined: true }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'n1';
    ircState.activeBuffer.bufferName = '#home';
  });

  it('switches to an existing joined channel', () => {
    ircState.networks[0].buffers.push(createBuffer({ name: '#dev', isJoined: true }));
    openChannelLink('n1', '#dev');
    expect(ircState.activeBuffer.bufferName).toBe('#dev');
  });

  it('matches channel case-insensitively like the buffer store does', () => {
    ircState.networks[0].buffers.push(createBuffer({ name: '#Dev', isJoined: true }));
    openChannelLink('n1', '#dev');
    // activeBuffer holds the folded key (store convention: buffer OBJECTS
    // keep display case, every key folds through normalizeChannelName) —
    // the point is that no second buffer was created and no JOIN was sent.
    expect(ircState.activeBuffer.bufferName?.toLowerCase()).toBe('#dev');
    expect(ircState.networks[0].buffers.filter((b) => b.name.toLowerCase() === '#dev').length).toBe(1);
  });

  it('joins an unknown channel and switches to it', () => {
    openChannelLink('n1', '#brand-new');
    const buf = ircState.networks[0].buffers.find((b) => b.name === '#brand-new');
    expect(buf).toBeTruthy();
    expect(buf?.joinInFlight).toBe(true);
    expect(ircState.activeBuffer.bufferName).toBe('#brand-new');
  });

  it('handles a delegated click on an autolinker anchor', () => {
    ircState.networks[0].buffers.push(createBuffer({ name: '#target', isJoined: true }));
    const container = document.createElement('div');
    container.innerHTML = '<span>see <a href="javascript:void(0)" class="channelLink" data-channel="#target">#target</a></span>';
    document.body.appendChild(container);
    const a = container.querySelector('a')!;
    let handled = false;
    container.addEventListener('click', (e) => { handled = handleChannelLinkClick(e as MouseEvent); });
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    container.remove();
    expect(handled).toBe(true);
    expect(ircState.activeBuffer.bufferName).toBe('#target');
  });

  it('ignores clicks that are not on a channel link', () => {
    const container = document.createElement('div');
    container.innerHTML = '<span>plain text</span>';
    document.body.appendChild(container);
    let handled = true;
    container.addEventListener('click', (e) => { handled = handleChannelLinkClick(e as MouseEvent); });
    container.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container.remove();
    expect(handled).toBe(false);
    expect(ircState.activeBuffer.bufferName).toBe('#home');
  });
});
