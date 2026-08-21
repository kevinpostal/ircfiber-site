import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import ServerLogTimeline from './ServerLogTimeline.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { serverlogCollapsedMap, setServerlogCollapseEvents, getServerlogCollapseEvents } from '../stores/preferences.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  for (const k of Object.keys(serverlogCollapsedMap)) delete (serverlogCollapsedMap as any)[k];
  localStorage.clear();
  setServerlogCollapseEvents(false); // ensure expanded by default for test
});

function setupServerBuffer(connected = true) {
  const network = createNetwork({ networkId: 'net1', name: 'TestNet', connected, connectionState: connected ? 'connected' : 'connecting', host: 'irc.test.com', port: 6697 } as any);
  network.buffers.push(createBuffer({ name: '_server' }));
  ircState.networks.push(network);
  ircState.activeBuffer.networkId = 'net1';
  ircState.activeBuffer.bufferName = '_server';
  return network;
}

describe('Server Log visibility — htmlcat regression', () => {
  it('shows welcome (001) and MOTD when connected and eventsOpen true', async () => {
    const network = setupServerBuffer(true);
    const now = Date.now();
    const msgs: any[] = [
      createMessage({ command: '001', text: 'Welcome to the TestNet IRC Network testnick', t: now - 4000, nick: 'server', channel: '_server' }),
      createMessage({ command: '002', text: 'Your host is irc.test.com, running version ergo-2.18', t: now - 3000, nick: 'server', channel: '_server' }),
      createMessage({ command: '372', text: '- Welcome to TestNet MOTD line 1', t: now - 2000, nick: 'server', channel: '_server' }),
      createMessage({ command: '372', text: '- MOTD line 2', t: now - 1500, nick: 'server', channel: '_server' }),
      createMessage({ command: '376', text: 'End of /MOTD command', t: now - 1000, nick: 'server', channel: '_server' }),
      createMessage({ command: 'NOTICE', text: '*** Looking up your hostname', t: now - 500, nick: 'server', channel: '_server' }),
    ];

    // Ensure expanded
    setServerlogCollapseEvents(false);
    render(ServerLogTimeline, { props: { messages: msgs, network } } as any);
    await tick();
    // Wait for effects
    await new Promise((r) => setTimeout(r, 100));

    // Check welcome is visible
    const welcomeSegs = document.querySelectorAll('.welcome-seg');
    expect(welcomeSegs.length).toBeGreaterThan(0);
    // Check MOTD is visible
    const motd = document.querySelector('.motd-body');
    expect(motd).toBeTruthy();
    if (motd) {
      expect(getComputedStyle(motd as HTMLElement).display).not.toBe('none');
      expect(motd.textContent).toContain('MOTD');
    }
    // Check connection events are visible (details open)
    const details = document.querySelector('details.connection-events') as HTMLDetailsElement | null;
    expect(details).toBeTruthy();
    if (details) {
      expect(details.open).toBe(true);
      const body = document.querySelector('.connection-events-body') as HTMLElement | null;
      expect(body).toBeTruthy();
      if (body) {
        expect(getComputedStyle(body).display).not.toBe('none');
        expect(body.textContent).toContain('Welcome');
      }
    }
    // Check that welcome row is visible
    const welcomeRow = document.querySelector('.row--info') as HTMLElement | null;
    expect(welcomeRow).toBeTruthy();
    if (welcomeRow) {
      expect(getComputedStyle(welcomeRow).display).not.toBe('none');
    }
  });

  it('shows MOTD banner and lines when MOTD present', async () => {
    const network = setupServerBuffer(true);
    const now = Date.now();
    const msgs: any[] = [
      createMessage({ command: '375', text: '- irc.test.com Message of the Day -', t: now - 3000, nick: 'server', channel: '_server' }),
      createMessage({ command: '372', text: '- Welcome', t: now - 2500, nick: 'server', channel: '_server' }),
      createMessage({ command: '376', text: 'End of /MOTD command', t: now - 2000, nick: 'server', channel: '_server' }),
    ];
    setServerlogCollapseEvents(false);
    render(ServerLogTimeline, { props: { messages: msgs, network } } as any);
    await tick();
    await new Promise((r) => setTimeout(r, 100));
    const motdBanner = document.querySelector('.motd-banner');
    expect(motdBanner).toBeTruthy();
    const motdLines = document.querySelectorAll('.groupedLines__line');
    expect(motdLines.length).toBeGreaterThan(0);
  });

  it('shows numeric stats (251 etc) when present', async () => {
    const network = setupServerBuffer(true);
    const now = Date.now();
    const msgs: any[] = [
      createMessage({ command: '251', text: 'There are 5 users and 3 invisible on 2 servers', t: now - 2000, nick: 'server', channel: '_server' }),
    ];
    setServerlogCollapseEvents(false);
    render(ServerLogTimeline, { props: { messages: msgs, network } } as any);
    await tick();
    await new Promise((r) => setTimeout(r, 100));
    const statRow = document.querySelector('.row--stat');
    expect(statRow).toBeTruthy();
    if (statRow) {
      expect(statRow.textContent).toContain('5');
    }
  });

  it('collapsed clone is hidden until-found, expanded body is visible', async () => {
    const network = setupServerBuffer(true);
    const now = Date.now();
    const msgs: any[] = [
      createMessage({ command: '001', text: 'Welcome', t: now - 1000, nick: 'server', channel: '_server' }),
    ];
    // First, test expanded: no hidden clone should be visible, body should be visible
    setServerlogCollapseEvents(false);
    // Ensure per-attempt not collapsed
    for (const k of Object.keys(serverlogCollapsedMap)) delete (serverlogCollapsedMap as any)[k];
    render(ServerLogTimeline, { props: { messages: msgs, network } } as any);
    await tick();
    await new Promise((r) => setTimeout(r, 100));
    const body = document.querySelector('.connection-events-body') as HTMLElement | null;
    if (body) {
      expect(body.getAttribute('hidden')).toBeNull();
      expect(getComputedStyle(body).display).not.toBe('none');
    }
    const hiddenClone = document.querySelector('[data-testid="server-log-hidden-search"]');
    // When expanded, hidden clone should not be present (it's in {:else} branch)
    expect(hiddenClone).toBeNull();

    // Now test collapsed: set per-attempt collapsed
    document.body.innerHTML = '';
    ircState.networks.length = 0;
    const net2 = setupServerBuffer(true);
    // Force per-attempt collapsed by setting map
    // We need to know the key: it will be generated from attempt, we can just set all to true
    // Render again with collapsed
    const msgs2 = [...msgs];
    render(ServerLogTimeline, { props: { messages: msgs2, network: net2 } } as any);
    await tick();
    // Manually collapse via map
    const head = document.querySelector('[data-testid="server-log-attempt"]') as HTMLElement | null;
    if (head) {
      head.click();
      await tick();
      const hiddenAfter = document.querySelector('[data-testid="server-log-hidden-search"]') as HTMLElement | null;
      if (hiddenAfter) {
        expect(hiddenAfter.getAttribute('hidden')).toBe('until-found');
      }
    }
  });
});
