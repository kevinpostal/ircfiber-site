import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { userEvent } from 'vitest/browser';
import ServerLogTimeline from './ServerLogTimeline.svelte';
import { ircState } from '../stores/ircStore.svelte';
import {
  clearedAtMap,
  serverlogCollapsedMap,
  getServerlogCollapseEvents,
  setServerlogCollapseEvents,
} from '../stores/preferences.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
  for (const k of Object.keys(serverlogCollapsedMap)) delete serverlogCollapsedMap[k];
  // Reset the global connection-events pref so each test starts from
  // the default-true (collapsed) state. Mirrors the per-test reset of
  // serverlogCollapsedMap above.
  window.localStorage.removeItem('ircfiber:serverlogCollapseEvents');
  setServerlogCollapseEvents(true);
});

function setupServerBuffer(): void {
  const network = createNetwork({ networkId: 'net1', name: 'TestNet', connected: true, connectionState: 'connected', host: 'irc.test.com', port: 6697 });
  network.buffers.push(createBuffer({ name: '_server' }));
  ircState.networks.push(network);
  ircState.activeBuffer.networkId = 'net1';
  ircState.activeBuffer.bufferName = '_server';
}

describe('ServerLogTimeline', () => {
  it('renders empty state when no messages', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];
    render(ServerLogTimeline, { props: { messages: [], network } });
    expect(document.querySelector('.serverLogTimeline__empty')).toBeInTheDocument();
  });

  it('renders connection attempts as expandable headers', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: '*** Connecting to irc.test.com:6697...', t: 1000, eid: 1, phase: 'queued' }),
      createMessage({ command: 'NOTICE', text: 'TCP connection established', t: 1100, eid: 2, phase: 'tcp_open' }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    const header = document.querySelector('[data-testid="server-log-attempt"]');
    expect(header).toBeInTheDocument();
    expect(header!.textContent).toContain('Connecting to');
    expect(header!.textContent).toContain('6697');
    expect(header!.classList.contains('head')).toBe(true);
  });

  it('renders disconnect attempts with the disconnected variant class', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: 'queued', t: 1000, eid: 1, phase: 'queued' }),
      createMessage({ command: 'CONNECT', text: 'Connecting...', t: 1100, eid: 2 }),
      createMessage({ command: 'DISCONNECT', text: 'Disconnected', t: 1200, eid: 3 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    const header = document.querySelector('[data-testid="server-log-attempt"]');
    expect(header).toBeInTheDocument();
    expect(header!.textContent).toContain('Disconnected from');
    // Either head--error or head--disconnected is acceptable for a failed attempt.
    const isDiscoClass =
      header!.classList.contains('head--disconnected') ||
      header!.classList.contains('head--error');
    expect(isDiscoClass).toBe(true);
  });

  it('expands a pending attempt to show phase rows by default', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: 'DNS resolving...', t: 1000, eid: 1, phase: 'resolving' }),
      createMessage({ command: 'NOTICE', text: 'TCP established', t: 1100, eid: 2, phase: 'tcp_open' }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    const header = document.querySelector('[data-testid="server-log-attempt"]');
    expect(header).toBeInTheDocument();

    // Phase rows should be visible (pending attempts default to expanded).
    const phaseRows = document.querySelectorAll('[data-testid="phase-row"]');
    expect(phaseRows.length).toBe(2);
    expect(phaseRows[0].textContent).toContain('DNS resolving');
    expect(phaseRows[1].textContent).toContain('TCP established');
  });

  it('shows welcome banner rows when expanded', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    // The engine emits a "welcome" phase to mark the attempt as ended,
    // then the IRC server delivers RPL_WELCOME (001) as a numeric reply.
    const messages = [
      createMessage({ command: 'NOTICE', text: 'Connecting...', t: 1000, eid: 1, phase: 'connecting' }),
      createMessage({ command: 'NOTICE', text: 'Connection registered as nick', t: 1050, eid: 2, phase: 'welcome' }),
      createMessage({ command: '001', text: 'Welcome to the TestNet IRC Network nick', t: 1100, eid: 3 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    const infoRow = document.querySelector('.row--info');
    expect(infoRow).toBeInTheDocument();
    expect(infoRow!.textContent).toContain('Welcome');
  });

  it('parses welcome banner (001-004) into typed segments for color/weight', async () => {
    // Live data shape from irc.ircfiber.com after a clean connect — the
    // exact text the user reported. The parser must split each line into
    // segments so the renderer can apply the typed color/weight.
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: 'Connecting...', t: 1000, eid: 1, phase: 'connecting' }),
      createMessage({ command: 'NOTICE', text: 'Connection registered as Zod', t: 1050, eid: 2, phase: 'welcome' }),
      createMessage({ command: '001', text: 'Welcome to the ircfiber IRC Network Zod', t: 1100, eid: 3 }),
      createMessage({ command: '002', text: 'Your host is irc.ircfiber.com, running version ergo-v2.18.0', t: 1200, eid: 4 }),
      createMessage({ command: '003', text: 'This server was created Tue, 30 Jun 2026 00:33:12 UTC', t: 1300, eid: 5 }),
      createMessage({ command: '004', text: 'Zod irc.ircfiber.com ergo-v2.18.0 BERTZios CEIMRUabefhiklmnoqstuv Iabefhkloqv', t: 1400, eid: 6 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    // Every welcome row carries the typed segment classes. Spot-check the
    // critical tokens — network name (001), hostname (002), date (003),
    // and the 004 token breakdown (nick / server / version / umodes /
    // cmodes / cmodes-with-prefix).
    const row001 = document.querySelector('[data-cmd="001"]');
    expect(row001!.querySelector('.welcome-seg--network')!.textContent).toBe('ircfiber');
    expect(row001!.querySelector('.welcome-seg--nick')!.textContent).toBe('Zod');

    const row002 = document.querySelector('[data-cmd="002"]');
    expect(row002!.querySelector('.welcome-seg--host')!.textContent).toBe('irc.ircfiber.com');
    expect(row002!.querySelector('.welcome-seg--version')!.textContent).toBe('ergo-v2.18.0');

    const row003 = document.querySelector('[data-cmd="003"]');
    expect(row003!.querySelector('.welcome-seg--date')!.textContent).toBe('Tue, 30 Jun 2026 00:33:12 UTC');

    const row004 = document.querySelector('[data-cmd="004"]');
    const segs = Array.from(row004!.querySelectorAll('.welcome-seg')).map((el) => ({
      text: el.textContent,
      kind: Array.from(el.classList).find((c) => c.startsWith('welcome-seg--'))?.replace('welcome-seg--', ''),
    }));
    expect(segs).toEqual([
      { text: 'Zod', kind: 'nick' },
      { text: ' ', kind: 'plain' },
      { text: 'irc.ircfiber.com', kind: 'host' },
      { text: ' ', kind: 'plain' },
      { text: 'ergo-v2.18.0', kind: 'version' },
      { text: '  ', kind: 'plain' },
      { text: 'BERTZios', kind: 'mode-table' },
      { text: '  ', kind: 'plain' },
      { text: 'CEIMRUabefhiklmnoqstuv', kind: 'mode-table' },
      { text: '  ', kind: 'plain' },
      { text: 'Iabefhkloqv', kind: 'mode-prefix' },
    ]);
  });

  it('hides events when clearedAt is set', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: 'Welcome', t: 1000, eid: 1, phase: 'welcome' }),
    ];
    clearedAtMap['net1:_server'] = 2000;
    render(ServerLogTimeline, { props: { messages, network } });
    expect(document.querySelector('[data-testid="server-log-attempt"]')).toBeNull();
  });

  it('renders MOTD with IRCCloud .groupedLines structure (all lines, no collapse)', async () => {
    // IRCCloud parity: every MOTD line is a `.groupedLines__line` div
    // (the first one is an `<h2>`); spaces are pre-substituted with &nbsp;
    // so ASCII art column alignment survives the HTML whitespace collapse.
    // Long MOTDs scroll horizontally inside `.groupedLines` instead of
    // collapsing behind a <details> (also matches IRCCloud).
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: 'Connecting...', t: 1000, eid: 1, phase: 'connecting' }),
      createMessage({ command: 'NOTICE', text: 'Connection registered', t: 1050, eid: 2, phase: 'welcome' }),
      createMessage({ command: '375', text: ':- test.com Message of the Day -', t: 1100, eid: 3 }),
      createMessage({ command: '372', text: 'Welcome to the network', t: 1200, eid: 4 }),
      createMessage({ command: '372', text: 'Please be respectful', t: 1300, eid: 5 }),
      createMessage({ command: '372', text: 'Have fun!', t: 1400, eid: 6 }),
      createMessage({ command: '372', text: 'No bots allowed', t: 1500, eid: 7 }),
      createMessage({ command: '376', text: ':End of MOTD command', t: 1600, eid: 8 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    const grouped = document.querySelector('.groupedLines.motd-groupedLines');
    expect(grouped).toBeInTheDocument();

    const lines = grouped!.querySelectorAll('.groupedLines__line');
    // 6 MOTD lines (375 banner + 4x372 body + 376 end marker).
    expect(lines.length).toBe(6);

    // First line is the title — IRCCloud wraps it as <h2>.
    expect(lines[0].tagName).toBe('H2');
    // Subsequent lines are <div>.
    expect(lines[1].tagName).toBe('DIV');

    // ASCII art column alignment is preserved via `white-space: pre` on
    // the parent `.motd-groupedLines` (inherited by every line). Verify
    // the CSS is correctly applied by checking that the first line's
    // computed style preserves whitespace.
    const titleStyle = window.getComputedStyle(lines[0]);
    expect(titleStyle.whiteSpace).toBe('pre');
  });

  it('renders ISUPPORT as the categorised ServerFeaturesPanel', async () => {
    setupServerBuffer();
    // Populate `network.isupport` so the panel reads it from the
    // engine-synced state — the new primary path. Mirrors what the
    // engine sends via the WS sync payload / `ISUPPORT` event.
    const network = {
      ...ircState.networks[0],
      isupport: {
        CHANTYPES: '#',
        EXCEPTS: '',
        INVEX: '',
        CHANMODES: 'b,e,I,k,l,imnpst',
      },
    };

    const messages = [
      createMessage({ command: 'NOTICE', text: 'Connecting...', t: 1000, eid: 1, phase: 'connecting' }),
      createMessage({ command: 'NOTICE', text: 'Connection registered', t: 1050, eid: 2, phase: 'welcome' }),
      createMessage({ command: '005', text: 'CHANTYPES=# EXCEPTS INVEX CHANMODES=b,e,I,k,l,imnpst', t: 1100, eid: 3 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    // The new panel replaces the old `.isupport-details` collapsible.
    // Dense embed is now collapsed by default on connect — expand to verify.
    const panel = document.querySelector('[data-testid="server-features-panel"]');
    expect(panel).toBeInTheDocument();
    expect(panel!.textContent).toContain('Server features');
    // Expand the whole panel (collapsed by default) to expose categories.
    (panel!.querySelector('[data-testid="server-features-panel-toggle"]') as HTMLElement).click();
    await tick();

    // Dense-mode categories are also collapsed — headers are now visible.
    const catHeads = panel!.querySelectorAll('.server-features-panel__cat-head');
    expect(catHeads.length).toBeGreaterThan(0);
    const allText = panel!.textContent || '';
    expect(allText).toContain('4 features');
  });

  it('renders server NOTICEs as a collapsible block', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: 'Connecting...', t: 1000, eid: 1, phase: 'connecting' }),
      createMessage({ command: 'NOTICE', text: 'Connection registered', t: 1050, eid: 2, phase: 'welcome' }),
      createMessage({ command: 'NOTICE', nick: 'irc.test.com', text: '*** Looking up your hostname...', t: 1100, eid: 3 }),
      createMessage({ command: 'NOTICE', nick: 'irc.test.com', text: '*** Found your hostname', t: 1200, eid: 4 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    const notices = document.querySelector('.notices-details');
    expect(notices).toBeInTheDocument();
    expect(notices!.textContent).toContain('NOTICE');
    expect(notices!.textContent).toContain('2 messages');
  });

  it('highlights digit runs in LUSERS / RPL numerics (cyan numbers, dim prose)', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: 'Connecting...', t: 1000, eid: 1, phase: 'connecting' }),
      createMessage({ command: 'NOTICE', text: 'Connection registered', t: 1050, eid: 2, phase: 'welcome' }),
      createMessage({ command: '251', text: '0 users and 5 invisible on 1 server(s)', t: 1100, eid: 3 }),
      createMessage({ command: '252', text: 'IRC Operators online', t: 1200, eid: 4 }),
      createMessage({ command: '255', text: 'I have 5 clients and 0 servers', t: 1300, eid: 5 }),
      createMessage({ command: '265', text: 'Current local users 5, max 9', t: 1400, eid: 6 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    // Each numeric row carries the cmd kicker + every digit run highlighted.
    const row251 = document.querySelector('[data-cmd="251"]');
    expect(row251!.querySelector('.row-cmd')!.textContent).toBe('251');
    const numSegs251 = Array.from(row251!.querySelectorAll('.stat-seg--number')).map((el) => el.textContent);
    expect(numSegs251).toEqual(['0', '5', '1']);

    // 252 has no digit runs in the body — only prose.
    const row252 = document.querySelector('[data-cmd="252"]');
    expect(row252!.querySelectorAll('.stat-seg--number').length).toBe(0);

    // 255 has "5 clients" and "0 servers".
    const row255 = document.querySelector('[data-cmd="255"]');
    const numSegs255 = Array.from(row255!.querySelectorAll('.stat-seg--number')).map((el) => el.textContent);
    expect(numSegs255).toEqual(['5', '0']);

    // 265 — "Current local users 5, max 9" — two digits, both highlighted.
    const row265 = document.querySelector('[data-cmd="265"]');
    const numSegs265 = Array.from(row265!.querySelectorAll('.stat-seg--number')).map((el) => el.textContent);
    expect(numSegs265).toEqual(['5', '9']);
  });

  it('renders ISUPPORT (005) tokens in the categorized ServerFeaturesPanel', async () => {
    setupServerBuffer();
    // Populate `network.isupport` (the engine's sync payload) so the
    // panel reads it directly instead of having to re-parse the raw
    // 005 message stream. The message buffer below stays as-is so we
    // also exercise the timeline's connection-lifecycle events.
    const network = {
      ...ircState.networks[0],
      isupport: {
        AWAYLEN: '390',
        BOT: 'B',
        EXCEPTS: '',
        CHANMODES: 'Ibe,k,fl,CEMRUimnstu',
      },
    };

    const messages = [
      createMessage({ command: 'NOTICE', text: 'Connecting...', t: 1000, eid: 1, phase: 'connecting' }),
      createMessage({ command: 'NOTICE', text: 'Connection registered', t: 1050, eid: 2, phase: 'welcome' }),
      createMessage({ command: '001', text: 'Welcome', t: 1100, eid: 3 }),
      // Each entry below would land in attempt.cap (one per 005 token)
      // if we needed to fall back, but the synced isupport supersedes.
      createMessage({ command: '005', text: 'AWAYLEN=390', t: 1200, eid: 4 }),
      createMessage({ command: '005', text: 'BOT=B', t: 1300, eid: 5 }),
      createMessage({ command: '005', text: 'EXCEPTS', t: 1400, eid: 6 }),
      createMessage({ command: '005', text: 'CHANMODES=Ibe,k,fl,CEMRUimnstu', t: 1500, eid: 7 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

     // Dense ServerFeaturesPanel is collapsed by default on connect — expand to verify categories.
     const panel = document.querySelector('[data-testid="server-features-panel"]');
     expect(panel).toBeInTheDocument();
     expect(panel!.querySelector('[data-testid="server-features-panel-search"]')).not.toBeInTheDocument();
     (panel!.querySelector('[data-testid="server-features-panel-toggle"]') as HTMLElement).click();
     await tick();

     // The four 005 tokens surface as <category, count> pairs even when
    // each category is collapsed (which is the dense default — categories
    // show just their header summary, not the per-row list). Verify the
    // counts match the expected distribution: AWAYLEN + KICKLEN-style
    // lengths → user-limits (1); BOT → bare-capabilities (1); EXCEPTS
    // → channel-bans (1); CHANMODES → channel-modes (1).
    const cats = Array.from(
      panel!.querySelectorAll('[data-testid="server-features-panel-cat"]')
    ) as HTMLElement[];
    expect(cats.length).toBe(4);
    // Each category carries its token in the per-category title / blurb
    // text (click-to-expand reveals the row). We assert the panel
    // surfaces the info in any visible form — the `panel!.textContent`
    // includes both the categories' blurb text AND the "4 features · …
    // categories · 0 IRCv3 · 1 core" summary line.
    const allText = panel!.textContent || '';

    // Summary sanity: stats line should mention 4 features, 4 categories.
    expect(allText).toContain('4 features');
    expect(allText).toContain('categories');
  });

  it('renders server NOTICEs with *** label and CAP LS lines as categorized CapabilitiesPanel', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: 'Connecting...', t: 1000, eid: 1, phase: 'connecting' }),
      createMessage({ command: 'NOTICE', text: 'Connection registered', t: 1050, eid: 2, phase: 'welcome' }),
      createMessage({ command: '001', text: 'Welcome', t: 1100, eid: 3 }),
      createMessage({ command: 'NOTICE', nick: 'irc.test.com', text: '*** Looking up your hostname...', t: 1200, eid: 4 }),
      createMessage({ command: 'NOTICE', nick: 'irc.test.com', text: '*** Found your hostname', t: 1300, eid: 5 }),
      createMessage({ command: 'NOTICE', text: 'account-notify account-tag away-notify batch cap-notify', t: 1400, eid: 6 }),
      createMessage({ command: 'NOTICE', text: 'sasl=PLAIN,EXTERNAL', t: 1500, eid: 7 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    // Caps are now surfaced via the categorized CapabilitiesPanel — collapsed by default on connect.
    const capsPanel = document.querySelector('[data-testid="capabilities-panel"]');
    expect(capsPanel).toBeInTheDocument();
    expect(capsPanel!.textContent).toContain('Capabilities');
    expect(capsPanel!.textContent).toContain('6 caps');
    // Expand the whole panel to expose categories.
    (capsPanel!.querySelector('[data-testid="capabilities-panel-toggle"]') as HTMLElement).click();
    await tick();
    // Dense categories are collapsed, so per-cap rows are hidden until the
    // user expands a category. Verify the category headers are present
    // (drawer interaction is covered by CapabilitiesPanel unit tests).
    const capHeads = capsPanel!.querySelectorAll('.server-features-panel__cat-head');
    expect(capHeads.length).toBeGreaterThan(0);
    expect(capsPanel!.textContent).toContain('Auth');
    // Server NOTICEs remain in the notices-list (filtered to only *** lines)
    const noticeItems = Array.from(document.querySelectorAll('.notices-list .notices-item'));
    expect(noticeItems.length).toBe(2);
    const notice1 = noticeItems[0].querySelectorAll('.notice-seg');
    expect(notice1[0].textContent).toBe('***');
    expect(notice1[0].classList.contains('notice-seg--notice-label')).toBe(true);
    expect(notice1[1].textContent).toBe(' Looking up your hostname...');
    expect(notice1[1].classList.contains('notice-seg--plain')).toBe(true);

    const notice2 = noticeItems[1].querySelectorAll('.notice-seg');
    expect(notice2[0].textContent).toBe('***');
    expect(notice2[0].classList.contains('notice-seg--notice-label')).toBe(true);
    expect(notice2[1].textContent).toBe(' Found your hostname');
    expect(notice2[1].classList.contains('notice-seg--plain')).toBe(true);
  });

  it('classifies MOTD lines (separator / art / section / list / command / empty)', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: 'Connecting...', t: 1000, eid: 1, phase: 'connecting' }),
      createMessage({ command: 'NOTICE', text: 'Connection registered', t: 1050, eid: 2, phase: 'welcome' }),
      createMessage({ command: '375', text: ':- irc.test.com Message of the day -', t: 1100, eid: 3 }),
      // ASCII art — long line dominated by `/ \ | _ ( ) < >`
      createMessage({ command: '372', text: '   _____ _____ ____      ______ _           _      ', t: 1200, eid: 4 }),
      createMessage({ command: '372', text: '  |  _  _/  ___|  _ \\    |  ___\\ |         | |     ', t: 1300, eid: 5 }),
      // Empty line
      createMessage({ command: '372', text: '', t: 1400, eid: 6 }),
      // Section header — ends with `:`
      createMessage({ command: '372', text: '- Welcome to the network!', t: 1500, eid: 7 }),
      // Body line
      createMessage({ command: '372', text: '- irc.test.com', t: 1600, eid: 8 }),
      // Numbered list
      createMessage({ command: '372', text: '-   1. Be respectful.', t: 1700, eid: 9 }),
      // Slash command
      createMessage({ command: '372', text: '-   /msg NickServ HELP', t: 1800, eid: 10 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    // Banner with kicker + title + line count
    const banner = document.querySelector('.motd-banner');
    expect(banner).toBeInTheDocument();
    expect(banner!.textContent).toContain('MOTD');
    expect(banner!.textContent).toContain('Message of the Day');

    // Each classified line gets a `data-motd-kind` attribute
    const kinds = Array.from(
      document.querySelectorAll('.motd-groupedLines .groupedLines__line')
    ).map((el) => el.getAttribute('data-motd-kind'));

    expect(kinds[0]).toBe('separator'); // ":- irc.test.com Message of the day -"
    expect(kinds[1]).toBe('art');       // ASCII art line 1
    expect(kinds[2]).toBe('art');       // ASCII art line 2
    expect(kinds[3]).toBe('empty');     // empty
    expect(kinds[4]).toBe('section');   // "Welcome to the network!"
    expect(kinds[5]).toBe('body');      // "irc.test.com"
    expect(kinds[6]).toBe('list');      // "1. Be respectful."
    expect(kinds[7]).toBe('command');   // "/msg NickServ HELP"

    // Closing footer — "End of MOTD command" lives outside the body,
    // in the .motd-footer block, regardless of how many MOTDs were
    // delivered (it's a static fixture rather than a re-classified
    // MOTD line, which would otherwise be tagged `body`).
    const footer = document.querySelector('.motd-footer');
    expect(footer).toBeInTheDocument();
    expect(footer!.textContent).toContain('End of MOTD command');
  });

  // ── W4-T01: connection-events <details> wrap ──────────────────────
  // Per-attempt detail rows (phases + welcome + motd + numerics +
  // isupport + notices) live under a single <details
  // class="connection-events">. Open state is bound to the global
  // `serverlogCollapseEvents` pref via `bind:open` + local $state
  // mirror + $effect (CRITIQUE B4 pattern).

  it('wraps phases + welcome + numerics + isupport + notices in a single <details class="connection-events">', async () => {
    setupServerBuffer();
    const network = {
      ...ircState.networks[0],
      isupport: { CHANTYPES: '#', EXCEPTS: '', INVEX: '', CHANMODES: 'b,e,I,k,l,imnpst' },
    };

    // `phase: 'queued'` is a START_PHASE so the entire sequence below
    // folds into ONE attempt. The 'welcome' phase ends the attempt; the
    // trailing 005 / NOTICE / numeric messages are post-attempt chatter
    // (kind ∈ {cap, notice, numeric}) and reopen the same attempt so
    // they fold in too. If we used `phase: 'connecting'` instead, the
    // grouping would open a SECOND synthetic attempt for the 001 welcome
    // row — the test would still pass but it would be testing two cards
    // instead of one.
    //
    // We deliberately don't include `phase: 'resolving'` because
    // 'resolving' is ALSO a START_PHASE — serverLogGroups opens a new
    // attempt for it, which would give us 2 attempts instead of 1.
    const messages = [
      createMessage({ command: 'NOTICE', text: 'queued', t: 1000, eid: 1, phase: 'queued' }),
      createMessage({ command: 'NOTICE', text: 'connecting', t: 1050, eid: 2, phase: 'connecting' }),
      createMessage({ command: 'NOTICE', text: 'ready', t: 1100, eid: 3, phase: 'welcome' }),
      createMessage({ command: '005', text: 'CHANTYPES=# EXCEPTS INVEX CHANMODES=b,e,I,k,l,imnpst', t: 1200, eid: 4 }),
      createMessage({ command: 'NOTICE', nick: 'irc.test.com', text: '*** Looking up your hostname...', t: 1300, eid: 5 }),
      createMessage({ command: '251', text: '5 users on 1 server', t: 1400, eid: 6 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    // Open the pref so the body is visible — the assertions below need
    // access to the nested rows.
    setServerlogCollapseEvents(false);
    await tick();

    const details = document.querySelector('[data-testid="connection-events"]') as HTMLDetailsElement;
    expect(details).toBeInTheDocument();
    expect(details.tagName).toBe('DETAILS');
    expect(details.classList.contains('connection-events')).toBe(true);
    expect(details.hasAttribute('open')).toBe(true);

    // The ISUPPORT panel must live INSIDE the <details>. Pinned by W2-T04
    // acceptance + the planner's TG3 follow-up.
    const panel = details.querySelector('[data-testid="server-features-panel"]');
    expect(panel).toBeInTheDocument();

    // The phase / numerics / notices rows also live inside.
    expect(details.querySelector('[data-testid="phase-row"]')).toBeInTheDocument();
    expect(details.querySelector('[data-cmd="251"]')).toBeInTheDocument();
    expect(details.querySelector('.notices-details')).toBeInTheDocument();

    // The summary count = phases(3) + welcome(0) + motd(0) + numerics(1)
    //   + isupport(1) + notices(1) = 6.
    const summary = details.querySelector('[data-testid="connection-events-summary"]') as HTMLElement;
    expect(summary.textContent).toContain('Connection events');
    expect(summary.textContent).toContain('6');
  });

  it('renders connection events collapsed by default when pref=true (disconnected)', async () => {
    // When disconnected/pending the panel respects the collapsed pref.
    // Use a disconnected network so the new "auto-expand on connect"
    // behaviour doesn't force it open.
    const network = createNetwork({ networkId: 'net1', name: 'TestNet', connected: false, connectionState: 'connecting', host: 'irc.test.com', port: 6697 });
    network.buffers.push(createBuffer({ name: '_server' }));
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '_server';

    // Two START_PHASES + welcome → one attempt with phases=[queued, welcome].
    const messages = [
      createMessage({ command: 'NOTICE', text: 'queued', t: 1000, eid: 1, phase: 'queued' }),
      createMessage({ command: 'NOTICE', text: 'ready', t: 1100, eid: 2, phase: 'welcome' }),
    ];

    // Pref starts at the test default (true = collapsed).
    expect(getServerlogCollapseEvents()).toBe(true);

    render(ServerLogTimeline, { props: { messages, network } });

    const details = document.querySelector('[data-testid="connection-events"]') as HTMLDetailsElement;
    expect(details).toBeInTheDocument();
    // The <details> must NOT carry the `open` attribute when the pref
    // says collapsed. Browsers strip the attribute when open=false but the
    // boolean property is also false.
    expect(details.open).toBe(false);
    expect(details.hasAttribute('open')).toBe(false);

    // The summary is visible (one-liner) with the count badge.
    const summary = details.querySelector('[data-testid="connection-events-summary"]') as HTMLElement;
    expect(summary).toBeInTheDocument();
    // 2 phase rows → badge shows "2".
    expect(summary.textContent).toContain('Connection events');
    expect(summary.textContent).toContain('2');
  });

  it('auto-expands connection events when engine connects (connected=true)', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: 'queued', t: 1000, eid: 1, phase: 'queued' }),
      createMessage({ command: 'NOTICE', text: 'ready', t: 1100, eid: 2, phase: 'welcome' }),
    ];

    // Start with the default collapsed pref — auto-expand should override it
    // when network.connected is true so MOTD / welcome are visible.
    expect(getServerlogCollapseEvents()).toBe(true);

    render(ServerLogTimeline, { props: { messages, network } });
    await tick();

    const details = document.querySelector('[data-testid="connection-events"]') as HTMLDetailsElement;
    expect(details).toBeInTheDocument();
    expect(details.open).toBe(true);
    expect(details.hasAttribute('open')).toBe(true);
    // Pref was persisted to expanded as well (so a reload stays open)
    expect(getServerlogCollapseEvents()).toBe(false);
  });

  it('renders connection events expanded when pref=false', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    setServerlogCollapseEvents(false);
    expect(getServerlogCollapseEvents()).toBe(false);

    const messages = [
      createMessage({ command: 'NOTICE', text: 'queued', t: 1000, eid: 1, phase: 'queued' }),
      createMessage({ command: 'NOTICE', text: 'ready', t: 1100, eid: 2, phase: 'welcome' }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    const details = document.querySelector('[data-testid="connection-events"]') as HTMLDetailsElement;
    expect(details).toBeInTheDocument();
    expect(details.open).toBe(true);
    expect(details.hasAttribute('open')).toBe(true);

    // The phase rows are visible because the body is open.
    const phaseRow = details.querySelector('[data-testid="phase-row"]');
    expect(phaseRow).toBeInTheDocument();
  });

  it('toggling the <summary> persists the choice via setServerlogCollapseEvents', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: 'queued', t: 1000, eid: 1, phase: 'queued' }),
      createMessage({ command: 'NOTICE', text: 'ready', t: 1100, eid: 2, phase: 'welcome' }),
    ];

    // Start expanded (open=true) so we can prove a user click collapses
    // it AND writes the inverse pref back to the store.
    setServerlogCollapseEvents(false);
    render(ServerLogTimeline, { props: { messages, network } });

    const details = document.querySelector('[data-testid="connection-events"]') as HTMLDetailsElement;
    expect(details.open).toBe(true);

    const summary = details.querySelector('[data-testid="connection-events-summary"]') as HTMLElement;
    // `userEvent.click` from vitest/browser simulates a real user
    // interaction (including the browser's default toggle action on the
    // parent <details>); a plain HTMLElement.click() in the synthetic
    // test environment fires the click event but does NOT trigger the
    // native <details> toggle, leaving the ontoggle handler un-fired.
    await userEvent.click(summary);
    await tick();

    // Browser toggled open -> false; ontoggle handler flipped the pref
    // to true (collapsed).
    expect(details.open).toBe(false);
    expect(getServerlogCollapseEvents()).toBe(true);

    // And vice-versa.
    await userEvent.click(summary);
    await tick();
    expect(details.open).toBe(true);
    expect(getServerlogCollapseEvents()).toBe(false);
  });

  it('mirrors external pref flips back into the <details> open state', async () => {
    // Use disconnected so auto-expand on connect doesn't override the pref
    const network = createNetwork({ networkId: 'net1', name: 'TestNet', connected: false, connectionState: 'connecting', host: 'irc.test.com', port: 6697 });
    network.buffers.push(createBuffer({ name: '_server' }));
    ircState.networks.push(network);
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '_server';

    const messages = [
      createMessage({ command: 'NOTICE', text: 'queued', t: 1000, eid: 1, phase: 'queued' }),
      createMessage({ command: 'NOTICE', text: 'ready', t: 1100, eid: 2, phase: 'welcome' }),
    ];

    // Start collapsed (default).
    setServerlogCollapseEvents(true);
    render(ServerLogTimeline, { props: { messages, network } });
    const details = document.querySelector('[data-testid="connection-events"]') as HTMLDetailsElement;
    expect(details.open).toBe(false);

    // Simulate a programmatic flip (e.g. context-menu toggle, cross-tab
    // storage event). The $effect should mirror the pref into local
    // state so the <details> re-renders without a page reload.
    setServerlogCollapseEvents(false);
    await tick();
    expect(details.open).toBe(true);

    setServerlogCollapseEvents(true);
    await tick();
    expect(details.open).toBe(false);
  });

  it('info_response row has padding only (no cyan-stripe accent, no cyan bg)', async () => {
    // IRCCloud parity (CRITIQUE + W4-T01 Refactor B): IRCCloud renders
    // .type_info_response with `padding:10px` and NO cyan stripe + NO
    // cyan-soft fill. The fiber restyle drops both, keeping only the
    // hairline border-bottom and the welcome-segment token typography.
    setupServerBuffer();
    const network = ircState.networks[0];

    setServerlogCollapseEvents(false);
    // Use 002 (YOURHOST) instead of 001 (WELCOME) so the welcome row
    // folds into the SAME attempt as the phases — see groupServerLog:
    // `kind='welcome'` (001-004) is NOT in the post-attempt-chatter set,
    // so 001 would open a SECOND synthetic attempt. 002 is the same kind
    // but the test only cares about the .row--info CSS treatment, so the
    // second-attempt variant works too — but the single-attempt path is
    // cleaner and matches what real engines emit.
    const messages = [
      createMessage({ command: 'NOTICE', text: 'queued', t: 1000, eid: 1, phase: 'queued' }),
      createMessage({ command: 'NOTICE', text: 'ready', t: 1050, eid: 2, phase: 'welcome' }),
      createMessage({ command: '002', text: 'Your host is irc.test.com, running version test-1.0', t: 1100, eid: 3 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    const row002 = document.querySelector('[data-cmd="002"]') as HTMLElement;
    expect(row002).toBeInTheDocument();
    expect(row002.classList.contains('row--info')).toBe(true);

    const style = window.getComputedStyle(row002);
    // Padding must be the IRCCloud 10px value (browser normalises to
    // `10px` when all four sides are equal).
    expect(style.paddingTop).toBe('10px');
    expect(style.paddingBottom).toBe('10px');
    expect(style.paddingLeft).toBe('10px');
    expect(style.paddingRight).toBe('10px');

    // Background must be transparent — no cyan-soft fill.
    expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');

    // The cyan-stripe `.row-accent` exists in the DOM but is hidden via
    // `display: none` (see `.row--info .row-accent { display: none; }`).
    // Verify it's NOT visually contributing.
    const accent = row002.querySelector('.row-accent') as HTMLElement;
    expect(accent).toBeInTheDocument();
    expect(window.getComputedStyle(accent).display).toBe('none');
  });

  it('motd row has padding only (no cyan-stripe accent, no cyan bg)', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    setServerlogCollapseEvents(false);
    const messages = [
      createMessage({ command: 'NOTICE', text: 'queued', t: 1000, eid: 1, phase: 'queued' }),
      createMessage({ command: 'NOTICE', text: 'ready', t: 1050, eid: 2, phase: 'welcome' }),
      createMessage({ command: '375', text: ':- irc.test.com Message of the day -', t: 1100, eid: 3 }),
      createMessage({ command: '372', text: 'Welcome to the network', t: 1200, eid: 4 }),
      createMessage({ command: '376', text: ':End of MOTD command', t: 1300, eid: 5 }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    const motdRow = document.querySelector('.row--motd') as HTMLElement;
    expect(motdRow).toBeInTheDocument();

    const style = window.getComputedStyle(motdRow);
    expect(style.paddingTop).toBe('10px');
    // The motd body still has its bottom padding from the inner
    // .motd-body — only verify the cyan-stripe bg + accent are gone.
    expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');

    const accent = motdRow.querySelector('.row-accent') as HTMLElement;
    expect(accent).toBeInTheDocument();
    expect(window.getComputedStyle(accent).display).toBe('none');
  });

  it('phase rows use the mono typographic `.row-type-prefix` (Refactor C)', async () => {
    setupServerBuffer();
    const network = ircState.networks[0];

    const messages = [
      createMessage({ command: 'NOTICE', text: 'resolving', t: 1000, eid: 1, phase: 'resolving' }),
      createMessage({ command: 'NOTICE', text: 'tcp_open', t: 1100, eid: 2, phase: 'tcp_open' }),
    ];
    render(ServerLogTimeline, { props: { messages, network } });

    const phaseRows = document.querySelectorAll('[data-testid="phase-row"]');
    expect(phaseRows.length).toBe(2);

    const firstPrefix = phaseRows[0].querySelector('.row-type-prefix') as HTMLElement;
    expect(firstPrefix).toBeInTheDocument();
    // The phase token is rendered as the human-friendly label ('dns')
    expect(firstPrefix.textContent).toBe('dns');

    const style = window.getComputedStyle(firstPrefix);
    // Mono font family is enforced so prefix + body align in the column.
    expect(style.fontFamily.toLowerCase()).toContain('mono');
    // Cyan, not chip — color, not background.
    expect(style.color).not.toBe('');
    // Display must be inline so the prefix flows with the body text, not
    // on its own line.
    expect(style.display).toBe('inline');

    // The legacy `.row-tag` chip is no longer used in phase rows.
    expect(phaseRows[0].querySelector('.row-tag')).toBeNull();
  });
});