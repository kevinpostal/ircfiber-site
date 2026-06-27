import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ServerLogCard from './ServerLogCard.svelte';
import { groupServerLog } from '../lib/serverLogGroups';
import { createNetwork } from '../test/factories';
import { serverlogCollapsedMap } from '../stores/preferences.svelte';
import type { IRCMessage } from '../types';

let counter = 0;
function m(overrides: Partial<IRCMessage> = {}): IRCMessage {
  return {
    id: `m-${++counter}`,
    command: 'NOTICE',
    nick: '',
    text: 'msg',
    t: 1000 + counter,
    ...overrides,
  };
}

function makeAttempt(events: IRCMessage[]) {
  return groupServerLog(events)[0];
}

const network = createNetwork({
  networkId: 'n1',
  name: 'test',
  host: 'irc.example.org',
  port: 6697,
});

/** Click the card header to expand the body — collapsed by default for
 *  non-pending attempts. */
async function expandCard() {
  const header = page.getByRole('button', { name: /Connected|Failed|Disconnected|Connecting/ });
  await header.click();
  await new Promise(r => setTimeout(r, 50));
}

describe('ServerLogCard', () => {
  it('renders the host:port in the header', async () => {
    const attempt = makeAttempt([
      m({ phase: 'connecting', text: 'Connecting...' }),
      m({ phase: 'welcome', text: 'Welcome' }),
    ]);
    render(ServerLogCard, { props: { attempt, network } });
    const header = page.getByRole('button', { name: /Connected.*irc\.example\.org:6697/ });
    await expect.element(header).toBeInTheDocument();
  });

  it('shows the Connecting status icon for an in-flight attempt', async () => {
    const attempt = makeAttempt([m({ phase: 'connecting', text: 'connecting' })]);
    render(ServerLogCard, { props: { attempt, network } });
    const status = page.getByText('Connecting…');
    await expect.element(status).toBeInTheDocument();
  });

  it('shows the Connected status once welcome is reached', async () => {
    const attempt = makeAttempt([
      m({ phase: 'connecting', text: 'connecting' }),
      m({ phase: 'welcome', text: 'welcome' }),
    ]);
    render(ServerLogCard, { props: { attempt, network } });
    const status = page.getByText('Connected');
    await expect.element(status).toBeInTheDocument();
  });

  it('shows the Failed status when phase=error fires', async () => {
    const attempt = makeAttempt([
      m({ phase: 'connecting', text: 'connecting' }),
      m({ phase: 'error', text: 'TLS handshake failed' }),
    ]);
    render(ServerLogCard, { props: { attempt, network } });
    const status = page.getByText('Failed');
    await expect.element(status).toBeInTheDocument();
  });

  it('renders phase chips for each phase event in the timeline', async () => {
    const attempt = makeAttempt([
      m({ phase: 'connecting', text: 'connecting' }),
      m({ phase: 'tls', text: 'tls' }),
      m({ phase: 'tls_done', text: 'tls done' }),
      m({ phase: 'welcome', text: 'welcome' }),
    ]);
    render(ServerLogCard, { props: { attempt, network } });
    await expandCard();
    const timeline = page.getByRole('list');
    await expect.element(timeline).toBeInTheDocument();
  });

  it('always renders MOTD lines without requiring the user to expand anything', async () => {
    const attempt = makeAttempt([
      m({ phase: 'welcome', text: 'welcome' }),
      m({ command: '375', text: ':- example.org Message of the Day -' }),
      m({ command: '372', text: ':- Welcome to the network' }),
      m({ command: '376', text: ':End of MOTD command' }),
    ]);
    render(ServerLogCard, { props: { attempt, network } });
    await expandCard();
    const motdLabel = page.getByText('MOTD', { exact: true });
    await expect.element(motdLabel).toBeInTheDocument();
  });

  it('collapses raw server NOTICEs (hostname-as-nick) behind a details toggle', async () => {
    const attempt = makeAttempt([
      m({ phase: 'connecting', text: 'connecting' }),
      m({ command: 'NOTICE', nick: 'irc.example.org', text: '*** Looking up your hostname' }),
      m({ phase: 'welcome', text: 'welcome' }),
    ]);
    render(ServerLogCard, { props: { attempt, network } });
    await expandCard();
    const toggle = page.getByRole('button', { name: /Raw IRC traffic/ });
    await expect.element(toggle).toBeInTheDocument();
  });

  it('collapses RPL_ISUPPORT dumps behind a separate toggle', async () => {
    const attempt = makeAttempt([
      m({ phase: 'caps', text: 'capability negotiation' }),
      m({ phase: 'welcome', text: 'welcome' }),
      m({ command: '005', text: 'CHANTYPES=# EXCEPTS INVEX CHANMODES' }),
    ]);
    render(ServerLogCard, { props: { attempt, network } });
    await expandCard();
    const toggle = page.getByRole('button', { name: /ISUPPORT/ });
    await expect.element(toggle).toBeInTheDocument();
  });

  // ── Flicker fix (issue 20260627) ──
  // Before the fix: the latest connected card ignored the user's
  // persisted collapse state and always opened by default. On page
  // refresh the card would pop open, then the user had to re-collapse
  // it — visible flash. The fix honors the persisted collapse first,
  // and only defaults to expanded when no persisted state exists.
  // See ServerLogCard.svelte:54-64.

  describe('isLatest persisted state (issue 20260627)', () => {
    beforeEach(() => {
      // Start each test from a clean persisted map so leakage from
      // earlier tests in the file can't poison the assertions.
      for (const k of Object.keys(serverlogCollapsedMap)) delete serverlogCollapsedMap[k];
    });
    afterEach(() => {
      for (const k of Object.keys(serverlogCollapsedMap)) delete serverlogCollapsedMap[k];
    });

    it('respects persisted collapsed state for isLatest card', async () => {
      // Simulate localStorage state on a real page refresh: the user
      // collapsed this card in a previous session.
      serverlogCollapsedMap['n1:5'] = true;

      // attempt.start.eid === 5 → collapsedKey === 'n1:5'.
      // isLatest=true + status=success → pre-fix this was ALWAYS expanded.
      const attempt = makeAttempt([
        m({ phase: 'connecting', text: 'connecting', eid: 5 }),
        m({ phase: 'welcome', text: 'welcome' }),
      ]);
      render(ServerLogCard, { props: { attempt, network, isLatest: true } });

      const header = page.getByRole('button', { name: /Connected.*irc\.example\.org:6697/ });
      await expect.element(header).toHaveAttribute('aria-expanded', 'false');
      // When collapsed the {#if expanded} block is omitted entirely —
      // the body div must NOT be in the DOM.
      expect(document.querySelector('.serverLogCard__body')).toBeNull();
    });

    it('defaults to expanded for isLatest card when no persisted state', async () => {
      // No seed: simulates a first-time visitor or a card the user has
      // never collapsed. The latest connected card should default to
      // expanded so the user sees the MOTD / welcome banner immediately.
      const attempt = makeAttempt([
        m({ phase: 'connecting', text: 'connecting', eid: 5 }),
        m({ phase: 'welcome', text: 'welcome' }),
      ]);
      render(ServerLogCard, { props: { attempt, network, isLatest: true } });

      const header = page.getByRole('button', { name: /Connected.*irc\.example\.org:6697/ });
      await expect.element(header).toHaveAttribute('aria-expanded', 'true');
      // When expanded the body div is rendered.
      expect(document.querySelector('.serverLogCard__body')).toBeInTheDocument();
    });
  });
});