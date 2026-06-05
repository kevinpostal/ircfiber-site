import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { flushSync } from 'svelte';
import App from './App.svelte';
import { ircState } from './stores/ircStore.svelte';
import { createNetwork, createBuffer, createMessage } from './test/factories';

vi.mock('/src/stores/wsConnection', () => ({
  connectWebSocket: vi.fn(),
  disconnectWebSocket: vi.fn(),
  sendRaw: vi.fn(),
  sendMessage: vi.fn(),
  requestSync: vi.fn(),
  requestSwitchBuffer: vi.fn(),
}));

vi.mock('/src/stores/api', () => ({
  fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
  fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
  loadHistory: vi.fn(async () => []),
  reconnectNetwork: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  joinChannel: vi.fn(async () => undefined),
  addNetwork: vi.fn(async () => undefined),
  updateNetwork: vi.fn(async () => undefined),
  deleteNetwork: vi.fn(async () => undefined),
}));

import { connectWebSocket, disconnectWebSocket, sendRaw, sendMessage, requestSync, requestSwitchBuffer } from '/src/stores/wsConnection';
import { fetchMe, fetchHealth, loadHistory, reconnectNetwork, disconnectNetwork, joinChannel, addNetwork, updateNetwork, deleteNetwork } from '/src/stores/api';

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  ircState.messages = {};
  ircState.overlay = { type: null, data: null };
  ircState.contextMenu = { visible: false, x: 0, y: 0, actions: [] };
  vi.clearAllMocks();
});

describe('App', () => {
  it('renders the app layout', async () => {
    render(App);
    expect(document.querySelector('#wrap')).toBeInTheDocument();
  });

  it('renders sidebar with networks', async () => {
    const net = createNetwork({ name: 'Libera' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);
    flushSync();

    render(App);
    await expect.element(page.getByText('Libera')).toBeInTheDocument();
    await expect.element(page.getByText('general')).toBeInTheDocument();
  });

  it('renders chat area', async () => {
    const net = createNetwork();
    const buf = createBuffer({ name: '#chan' });
    net.buffers.push(buf);
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = net.networkId;
    ircState.activeBuffer.bufferName = '#chan';
    flushSync();

    render(App);
    await expect.element(page.getByRole('log', { name: 'Chat messages' })).toBeInTheDocument();
  });

  it('renders buffer header', async () => {
    const net = createNetwork({ networkId: 'net1' });
    net.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#general';
    flushSync();

    render(App);
    await expect.element(page.getByRole('heading', { name: '#general' })).toBeInTheDocument();
  });

  it('buffer switching updates downstream components', async () => {
    const net1 = createNetwork({ networkId: 'net1', name: 'TestNet' });
    net1.buffers.push(createBuffer({ name: '#chan1' }));
    net1.buffers.push(createBuffer({ name: '#chan2' }));
    ircState.networks.push(net1);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan1';
    flushSync();

    render(App);
    await expect.element(page.getByRole('heading', { name: '#chan1' })).toBeInTheDocument();

    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan2';
    flushSync();

    await expect.element(page.getByRole('heading', { name: '#chan2' })).toBeInTheDocument();
  });

  it('message isolation between networks', async () => {
    const net1 = createNetwork({ networkId: 'net1', name: 'Net1' });
    net1.buffers.push(createBuffer({ name: '#general' }));
    const net2 = createNetwork({ networkId: 'net2', name: 'Net2' });
    net2.buffers.push(createBuffer({ name: '#general' }));
    ircState.networks.push(net1, net2);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#general';
    ircState.messages['net1:#general'] = [createMessage({ text: 'hello from net1', t: Date.now() })];
    ircState.messages['net2:#general'] = [createMessage({ text: 'hello from net2', t: Date.now() })];
    flushSync();

    render(App);

    await expect.element(page.getByText('hello from net1')).toBeInTheDocument();
    const net2Msg = page.getByText('hello from net2');
    await expect(net2Msg).not.toBeInTheDocument();
  });
});
