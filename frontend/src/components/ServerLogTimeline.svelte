<script lang="ts">
  import type { IRCMessage, Network } from '../types';
  import {
    groupServerLog,
    type ServerLogAttempt,
    phaseToLabel,
    attemptDuration,
    formatDuration,
    numericBody,
    getServerLogCollapsedKey,
    type ServerLogKind,
    classifyServerLog,
  } from '../lib/serverLogGroups';
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import {
    serverlogCollapsedMap,
    serverlogHiddenMap,
    getServerlogCollapseEvents,
    setServerlogCollapseEvents,
  } from '../stores/preferences.svelte';
  import { getClearedAt } from '../stores/preferences.svelte';
  import { updateServerlogCollapsed } from '../stores/api';
  import { ircState } from '../stores/ircStore.svelte';
  import ServerFeaturesPanel from './ServerFeaturesPanel.svelte';
  import { isupportFromMessages } from '../lib/isupportCategorize';

  interface Props {
    messages: IRCMessage[];
    network: Network | null;
  }

  let { messages, network }: Props = $props();

  // ── Connection-events pref (W2-T03 / W4-T01) ─────────────────────
  // Wraps the per-attempt detail rows (phases + welcome + motd +
  // numerics + isupport + notices) in a single <details> element. The
  // <details> is the canonical Svelte 5 pattern for an independently-
  // collapsible block — clicking the <summary> toggles `open` natively.
  //
  // Binding pattern (see CRITIQUE B4): we use Svelte 5's native
  // `bind:open` directive on a LOCAL `$state` mirror, NOT a raw
  // `open={!pref}` attribute. `bind:open` is the native directive that
  // proxies the browser's two-way toggle into a local `$state` variable;
  // combined with the `$effect` below, this gives a clean two-way flow:
  //   browser click ↔ local `eventsOpen` $state
  //                 ↔ setServerlogCollapseEvents → store $state
  //                 ↔ localStorage (immediate)
  //                 ↔ storage event → other tabs
  //
  // The mirror is necessary because `getServerlogCollapseEvents()` reads
  // a module-level $state (the pref), which the BROWSER doesn't know
  // about when it toggles <details> natively. Without the mirror, an
  // external write (setServerlogCollapseEvents from another tab, a
  // context-menu toggle) wouldn't re-render the <details>.
  let eventsOpen = $state<boolean>(!getServerlogCollapseEvents());

  // Mirror external pref changes back into local state. Reads
  // getServerlogCollapseEvents() inside $effect so Svelte 5 subscribes
  // to the underlying $state proxy and re-runs when the pref flips from
  // another source (cross-tab storage event, future context-menu item,
  // etc.).
  $effect(() => {
    eventsOpen = !getServerlogCollapseEvents();
  });

  // ── Filter cleared messages ──────────────────────────────────────
  const visibleMessages = $derived.by(() => {
    const clearedAt = (ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName)
      ? getClearedAt(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName)
      : null;
    return messages.filter(m => {
      if (m.command === 'PING' || m.command === 'PONG') return false;
      if (clearedAt && (m.t || 0) <= clearedAt) return false;
      return true;
    });
  });

  // ── Group into connection attempts ───────────────────────────────
  const attempts = $derived(groupServerLog(visibleMessages));

  // Live ticker for pending duration — ticks 1s while a pending attempt exists
  // Disabled to prevent 1Hz full re-render that disrupts reading. Duration
  // for pending attempts now shows static "connecting…" without live count.
  let liveNow = $state<number>(Date.now());
  // was: $effect(() => { const hasPending = attempts.some(...); if (!hasPending) return; setInterval(...) })

  // ── Helpers ──────────────────────────────────────────────────────
  function formatTime(ts: number | undefined): string {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour12: false });
  }

  function renderLine(text: string): string {
    return parseIrcFormatting(text);
  }

  function getHostLabel(a: ServerLogAttempt, net: Network | null): string {
    if (net?.host) {
      return `${net.host}:${net.port || 6697}`;
    }
    const connecting = a.phases.find((m) => m.phase === 'connecting' || m.phase === 'tcp_open');
    const text = connecting?.text ?? '';
    const match = text.match(/(\S+:\d+)/);
    return match ? match[1] : '';
  }

  function getHeaderLabel(a: ServerLogAttempt): string {
    switch (a.status) {
      case 'success':       return 'Connected to';
      case 'error':         return 'Connection failed';
      case 'disconnected':  return 'Disconnected from';
      case 'pending':       return 'Connecting to';
      default:              return 'Connection';
    }
  }

  function getStatusGlyph(a: ServerLogAttempt): string {
    switch (a.status) {
      case 'success':       return '✓';
      case 'error':         return '×';
      case 'disconnected':  return '×';
      case 'pending':       return '…';
      default:              return '·';
    }
  }

  function getStatusKind(a: ServerLogAttempt): 'success' | 'error' | 'disconnected' | 'pending' {
    return a.status === 'superseded' ? 'disconnected' : (a.status as 'success' | 'error' | 'disconnected' | 'pending');
  }

  // ── Per-row type tint mapping (IRCCloud parity) ──────────────────
  function rowClassForCommand(cmd: string | undefined, kind: ServerLogKind | null): string {
    if (cmd === '001' || cmd === '002' || cmd === '003' || cmd === '004') return 'type_info_response';
    if (cmd === '372' || cmd === '375' || cmd === '376') return 'type_motd_response';
    if (cmd === '005') return 'type_status monospace';
    if (cmd === 'NOTICE' || kind === 'notice') return 'type_notice';
    return 'type_status';
  }

  // ── Welcome banner (RPL_WELCOME / YOURHOST / CREATED / MYINFO) parser ──
  // The raw `numericBody` for these is a flat string with no markup, so
  // we parse it into structured segments so each token gets its own color
  // and weight — the network name and nick (cyan-bold), the hostname and
  // version (fiber-cloud / amber mono), and the mode tables (mono dim).
  //   001 : "Welcome to the <network> IRC Network <nick>"
  //   002 : "Your host is <server>, running version <version>"
  //   003 : "This server was created <human-readable date>"
  //   004 : "<nick> <server> <version> <user-modes> <chan-modes> <chan-modes-with-prefix>"
  type WelcomeSeg = { text: string; kind: 'plain' | 'network' | 'nick' | 'host' | 'version' | 'date' | 'mode-table' | 'mode-prefix' };
  function formatCreatedDate(ts?: number): string {
    if (!ts) return 'recently';
    try { return new Date(ts).toUTCString(); } catch { return 'recently'; }
  }
  function parseWelcomeLine(cmd: string, body: string, ts?: number): WelcomeSeg[] {
    if (body.includes('__DATE__') || body.includes('__TIME__')) {
      const fallback = formatCreatedDate(ts);
      const sub = body.replace('__DATE__', fallback.split(' ').slice(0,4).join(' ')).replace(' at __TIME__', '').replace('__TIME__', '').trim();
      if (sub.includes('__')) {
        return [{ text: 'This server was created ', kind: 'plain' }, { text: fallback, kind: 'date' }];
      }
      body = sub;
    }
    if (cmd === '001') {
      const m = body.match(/^Welcome to the (.+?) IRC Network (.+)$/);
      return m
        ? [
            { text: 'Welcome to the ', kind: 'plain' },
            { text: m[1], kind: 'network' },
            { text: ' IRC Network ', kind: 'plain' },
            { text: m[2], kind: 'nick' },
          ]
        : [{ text: body, kind: 'plain' }];
    }
    if (cmd === '002') {
      const m = body.match(/^Your host is (.+?), running version (.+)$/);
      return m
        ? [
            { text: 'Your host is ', kind: 'plain' },
            { text: m[1], kind: 'host' },
            { text: ', running version ', kind: 'plain' },
            { text: m[2], kind: 'version' },
          ]
        : [{ text: body, kind: 'plain' }];
    }
    if (cmd === '003') {
      const m = body.match(/^This server was created (.+)$/);
      return m
        ? [
            { text: 'This server was created ', kind: 'plain' },
            { text: m[1], kind: 'date' },
          ]
        : [{ text: body, kind: 'plain' }];
    }
    if (cmd === '004') {
      // nick, server, version, umodes, cmodes, [cmodes-with-prefix]
      // The last segment is optional on some ircds but standard on ergo / Unreal / charybdis.
      const tokens = body.split(/\s+/).filter(Boolean);
      if (tokens.length < 5) return [{ text: body, kind: 'plain' }];
      const [nick, server, version, umodes, cmodes, cmodesPrefixed] = tokens;
      const segs: WelcomeSeg[] = [
        { text: nick, kind: 'nick' },
        { text: ' ', kind: 'plain' },
        { text: server, kind: 'host' },
        { text: ' ', kind: 'plain' },
        { text: version, kind: 'version' },
      ];
      if (umodes) {
        segs.push({ text: '  ', kind: 'plain' });
        segs.push({ text: umodes, kind: 'mode-table' });
      }
      if (cmodes) {
        segs.push({ text: '  ', kind: 'plain' });
        segs.push({ text: cmodes, kind: 'mode-table' });
      }
      if (cmodesPrefixed) {
        segs.push({ text: '  ', kind: 'plain' });
        segs.push({ text: cmodesPrefixed, kind: 'mode-prefix' });
      }
      return segs;
    }
    return [{ text: body, kind: 'plain' }];
  }

  // ── LUSERS / generic numeric parser ─────────────────────────────────
  // RPL_LUSERCLIENT (251), RPL_LUSEROP (252), RPL_LUSERUNKNOWN (253),
  // RPL_LUSERCHANNELS (254), RPL_LUSERME (255), RPL_LOCALUSERS (265),
  // RPL_GLOBALUSERS (266), RPL_UMODEIS (221), RPL_WHOISREGNICK (307)…
  // The body is a flat string with digit runs we want to highlight.
  // Split on every \d+ run and emit alternating plain / number segments.
  type StatSeg = { text: string; kind: 'plain' | 'number' };
  function parseNumericStat(body: string): StatSeg[] {
    if (!body) return [];
    const segs: StatSeg[] = [];
    const re = /(\d+)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      if (m.index > last) segs.push({ text: body.slice(last, m.index), kind: 'plain' });
      segs.push({ text: m[0], kind: 'number' });
      last = m.index + m[0].length;
    }
    if (last < body.length) segs.push({ text: body.slice(last), kind: 'plain' });
    return segs;
  }

  // ── Server NOTICE / CAP LS line parser ────────────────────────────
  // Two shapes arrive in attempt.notices:
  //   · Server NOTICEs from the IRCd start with "*** " — render the
  //     triple-asterisk as a cyan-bold label, the rest as plain prose.
  //   · CAP LS responses are space-separated capability names
  //     ("account-notify account-tag away-notify batch …") — render
  //     each name as a cyan tag, with a thin separator between tokens.
  //     Names with "=" (e.g. "sasl=PLAIN,EXTERNAL") get key / value
  //     splitting so the value reads as the actionable payload.
  type NoticeSeg = { text: string; kind: 'plain' | 'notice-label' | 'cap-tag' | 'cap-key' | 'cap-value' };
  function parseNoticeOrCapLine(text: string): NoticeSeg[] {
    if (!text) return [];
    // Server NOTICE marker: "*** ..." or "***".
    if (/^\*+\s?/.test(text)) {
      const match = text.match(/^(\*+)(.*)$/s);
      if (match) {
        const segs: NoticeSeg[] = [{ text: match[1], kind: 'notice-label' }];
        const rest = match[2];
        if (rest) segs.push({ text: rest, kind: 'plain' });
        return segs;
      }
    }
    // CAP LS: split on whitespace; each token is a capability name.
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [{ text, kind: 'plain' }];
    const segs: NoticeSeg[] = [];
    tokens.forEach((tok, i) => {
      if (i > 0) segs.push({ text: ' ', kind: 'plain' });
      const eq = tok.indexOf('=');
      if (eq === -1) {
        segs.push({ text: tok, kind: 'cap-tag' });
      } else {
        segs.push({ text: tok.slice(0, eq), kind: 'cap-key' });
        segs.push({ text: '=', kind: 'plain' });
        segs.push({ text: tok.slice(eq + 1), kind: 'cap-value' });
      }
    });
    return segs;
  }
  // IRC MOTDs follow a few well-defined conventions that the raw text
  // stream makes obvious once you look at it:
  //   · ":- irc.example.org Message of the day -" — opening / closing
  //     separator (RPL_MOTDSTART, IRC § 4.3 / RFC 1459 § 4.4.1)
  //   · "End of MOTD command" — RPL_ENDOFMOTD (376) closing line
  //   · Lines that are pure ASCII art — high density of `/ \ | _ ( ) < >`
  //     with no real prose; rendered slightly dim so the eye skips them
  //   · Section headers ("Welcome to ...", "Rules:", "For support, ...")
  //     are the kind of lines that introduce a paragraph; render them in
  //     cyan so they read as headings, not body
  //   · Numbered list items ("  1. Be respectful...") get a left indent
  //     marker so the column aligns visually
  //   · Empty lines collapse to half-line-height so the panel breathes
  type MotdLineKind = 'separator' | 'closing' | 'art' | 'section' | 'list' | 'command' | 'body' | 'empty';

  // ISUPPORT token parsing has moved to `lib/isupportCategorize.ts`
  // (`splitIsupportText`, `isupportFromMessages`, `categorizeIsupport`)
  // and is now consumed by the `<ServerFeaturesPanel>` component above.
  // The timeline no longer parses or renders ISUPPORT tokens directly.

  function classifyMotdLine(rawText: string): MotdLineKind {
    // Strip HTML entities, then the leading `- ` (or `-  `) that the IRC
    // server prefixes every prose MOTD line with — it's not part of the
    // semantic content, just the standard wire format. The art lines
    // (no leading `-`) are unaffected, and the separator lines start
    // with `:` so the dash strip doesn't touch them either.
    const text = rawText.replace(/&nbsp;/g, ' ').replace(/^-\s*/, '').trim();
    if (!text) return 'empty';
    if (/^End of MOTD/i.test(text)) return 'closing';
    // Separator: :- ... - (IRC convention) — opening colon + closing dash.
    // Both `:- foo -` and `: foo :` should classify as separator; the
    // important cues are the leading `:` and the trailing `-` or `:`.
    if (/^:[\s-].+[\s-]+$/.test(text)) return 'separator';
    // ASCII art: dominated by punctuation, no real prose. Long lines with
    // many `/ \ | _ ( ) < >` characters and no spaces between words.
    if (text.length > 16 && /[\\|/()<>_]{4,}/.test(text) && !/\b[a-z]+\s+[a-z]+\b/i.test(text)) {
      return 'art';
    }
    // Numbered list item: leading whitespace + digits + period
    if (/^\d+\.\s/.test(text)) return 'list';
    // Command: indented /-prefixed slash command
    if (/^\/\w+/.test(text)) return 'command';
    // Section header: ends with `:` or `!`, or starts with a keyword that
    // typically introduces a paragraph (Welcome, Rules, For, Register, To).
    // Note: we intentionally do NOT match bare domain names like
    // "irc.ircfiber.com" here — those are body text, not headings.
    if (/[:!]$/.test(text) || /^(Welcome|To\s+\w+|Register|For\s+\w+|Rules?)\b/i.test(text)) {
      return 'section';
    }
    return 'body';
  }

  // ── Persistent collapse state ────────────────────────────────────
  function getCollapsedKey(a: ServerLogAttempt): string {
    if (!network?.networkId) return '';
    return getServerLogCollapsedKey(a, network.networkId);
  }

  function isCollapsed(a: ServerLogAttempt, index: number, total: number): boolean {
    if (!network?.networkId) return false;
    const key = getCollapsedKey(a);
    if (serverlogHiddenMap[key] === true) return true;
    if (a.status === 'pending') return serverlogCollapsedMap[key] === true;
    // Stable default: ended attempts are collapsed unless user expanded.
    // Don't use index===total-1 — it flips previous most-recent from expanded to collapsed the instant a new attempt arrives, flashing the timeline.
    if (key in serverlogCollapsedMap) return serverlogCollapsedMap[key] === true;
    return true;
  }

  // One-time init: keep newest ended attempt expanded on first sight without making isCollapsed reactive to total
  $effect(() => {
    if (!network?.networkId || attempts.length === 0) return;
    const last = attempts[attempts.length - 1];
    if (!last || last.status === 'pending') return;
    const key = getCollapsedKey(last);
    if (!key || key in serverlogCollapsedMap) return;
    serverlogCollapsedMap[key] = false;
  });

  function toggleAttempt(a: ServerLogAttempt, e: MouseEvent): void {
    e.preventDefault();
    const key = getCollapsedKey(a);
    if (!key || !network?.networkId) return;
    const idx = attempts.indexOf(a);
    const newVal = !isCollapsed(a, idx, attempts.length);
    serverlogCollapsedMap[key] = newVal;
    try {
      const data = JSON.parse(localStorage.getItem('ircfiber:serverlogCollapsed') || '{}');
      if (newVal) data[key] = true;
      else delete data[key];
      localStorage.setItem('ircfiber:serverlogCollapsed', JSON.stringify(data));
    } catch {}
    const eid = a.start?.eid ? Number(a.start.eid) : undefined;
    const msgid = (!a.start?.eid && a.start?.msgid) ? a.start.msgid : undefined;
    updateServerlogCollapsed(network.networkId, eid || undefined, msgid || undefined, newVal);
  }

  // ── Collapse auto-close on disconnect / error ────────────────────
  $effect(() => {
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      if ((a.status === 'disconnected' || a.status === 'error') && !isCollapsed(a, i, attempts.length)) {
        const key = getCollapsedKey(a);
        if (key && network?.networkId && serverlogCollapsedMap[key] !== true) {
          serverlogCollapsedMap[key] = true;
          try {
            const data = JSON.parse(localStorage.getItem('ircfiber:serverlogCollapsed') || '{}');
            data[key] = true;
            localStorage.setItem('ircfiber:serverlogCollapsed', JSON.stringify(data));
          } catch {}
          const eid = a.start?.eid ? Number(a.start.eid) : undefined;
          const msgid = (!a.start?.eid && a.start?.msgid) ? a.start.msgid : undefined;
          updateServerlogCollapsed(network.networkId, eid || undefined, msgid || undefined, true);
        }
      }
    }
  });
</script>

<div class="serverLogTimeline" data-testid="server-log-timeline">
  {#if attempts.length === 0}
    <div class="serverLogTimeline__empty">No connection history yet.</div>
  {:else}
    {#each attempts as attempt, i (getCollapsedKey(attempt) || attempt.start.id || String(i))}
      {@const collapsed = isCollapsed(attempt, i, attempts.length)}
      {@const headerLabel = getHeaderLabel(attempt)}
      {@const hostLabel = getHostLabel(attempt, network)}
      {@const durationMs = attempt.status === 'pending' && attempt.start.t ? liveNow - attempt.start.t : attemptDuration(attempt)}
      {@const durationLabel = durationMs != null && durationMs >= 0 ? formatDuration(durationMs) : ''}
      {@const kind = getStatusKind(attempt)}
      {@const glyph = getStatusGlyph(attempt)}

      <!-- ── Connection / disconnect header (IRCCloud parity + fiber brand) ──
           Layout matches the homepage's `.status-pill` / `.kicker` aesthetic:
             · A leading vertical fiber-strand bar (2px wide, status color,
               with a soft glow that pulses for pending connections — the
               same `box-shadow + keyframes` trick the homepage uses on the
               "all systems operational" LED in the topbar)
             · The caret and glyph use cyan / status colors so the status
               state reads at a glance
             · The label uses Space Grotesk (--font-display) to tie back to
               the homepage's brand font; host + time stay in mono -->
      <div
        class="head"
        class:head--success={kind === 'success'}
        class:head--error={kind === 'error'}
        class:head--disconnected={kind === 'disconnected'}
        class:head--pending={kind === 'pending'}
        class:expanded={!collapsed}
        role="button"
        tabindex="0"
        onclick={(e) => toggleAttempt(attempt, e)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const fake = { preventDefault() {} } as unknown as MouseEvent; toggleAttempt(attempt, fake); } }}
        aria-expanded={!collapsed}
        data-testid="server-log-attempt"
      >
        <span class="head-strand" aria-hidden="true"></span>
        <span class="caret" aria-hidden="true">{collapsed ? '▶' : '▼'}</span>
        <span class="glyph" aria-hidden="true">{glyph}</span>
        <span class="label">{headerLabel}</span>
        {#if hostLabel}
          <span class="host">{hostLabel}</span>
        {/if}
        <span class="time">
          {formatTime(attempt.start.t)}
          {#if durationLabel && attempt.status !== 'pending'}
            · {durationLabel}
          {/if}
        </span>
      </div>

      <!-- ── Expanded body: plain IRC chat rows ───────────────────── -->
      {#if !collapsed}
        <!-- W4-T01: wrap all per-attempt detail rows in a single
             <details class="connection-events"> whose open state is bound
             to the global `serverlogCollapseEvents` pref via a local
             `$state` mirror + `$effect` (see script). Independent of the
             per-attempt serverlogCollapsedMap pref that drives the
             <div class="head"> toggle above — a user can fold the
             per-attempt header AND the inner detail block separately. -->
        {@const syncedIsupport = network?.isupport ?? null}
        {@const bufferedIsupport = isupportFromMessages(attempt.cap)}
        {@const isupportMap = (syncedIsupport && Object.keys(syncedIsupport).length > 0)
          ? syncedIsupport
          : bufferedIsupport}
        {@const connectionEventsCount =
          attempt.phases.length +
          attempt.welcome.length +
          attempt.motd.length +
          attempt.numeric.length +
          (Object.keys(isupportMap).length > 0 ? 1 : 0) +
          (attempt.notices.length > 0 ? 1 : 0)}
        <details
          class="connection-events"
          open={eventsOpen}
          ontoggle={(e) => {
            const isOpen = (e.currentTarget as HTMLDetailsElement).open;
            if (isOpen === eventsOpen) return;
            setServerlogCollapseEvents(!isOpen);
          }}
          data-testid="connection-events"
        >
          <summary
            class="connection-events-summary"
            data-testid="connection-events-summary"
          >
            Connection events ({connectionEventsCount})
          </summary>

          <div class="connection-events-body">
            <!-- Phase events as one-line rows -->
            {#each attempt.phases as msg, pi (pi)}
              <div class="row" class:row--last={pi === attempt.phases.length - 1} data-testid="phase-row">
                <span class="row-prefix">→</span>
                <span class="row-content">
                  <span class="row-type-prefix">{msg.phase ? phaseToLabel(msg.phase) : (msg.command ?? '').toLowerCase()}</span>
                  {#if msg.text}<span class="row-text">{msg.text}</span>{/if}
                </span>
              </div>
            {/each}

            <!-- Welcome banner (001-004) — cyan-accent hairline border + structured
                 color so the network name, your nick, hostname, version, and
                 mode tables each get their own weight and color. parseWelcomeLine
                 splits the flat RPL body into typed segments; the template
                 renders each with .welcome-seg--{kind}. -->
            {#each attempt.welcome as msg, wi (wi)}
              {@const segments = parseWelcomeLine(msg.command ?? '', numericBody(msg), msg.t)}
              <div class="row row--info" data-cmd={msg.command}>
                <span class="row-accent row-accent--cyan" aria-hidden="true"></span>
                <span class="row-content">
                  {#each segments as seg, si (si)}
                    <span class="welcome-seg welcome-seg--{seg.kind}">{seg.text}</span>
                  {/each}
                </span>
              </div>
            {/each}

            <!-- MOTD — fiber restyle.
                 Each line is classified via `classifyMotdLine` so we can give
                 separators, ASCII art, section headers, list items, commands,
                 and the closing "End of MOTD command" line their own visual
                 treatment. Spaces are replaced with &nbsp; on every line so
                 ASCII art column alignment survives HTML whitespace collapse
                 (IRCCloud does the same). -->
            {#if attempt.motd.length > 0}
              {@const motdLines = attempt.motd.map((m) => numericBody(m))}
              {@const classified = motdLines.map((t) => classifyMotdLine(t))}
              <div class="row row--motd" aria-label="Message of the Day">
                <span class="row-accent row-accent--cyan" aria-hidden="true"></span>
                <div class="motd-body">
                  <div class="motd-banner">
                    <span class="motd-kicker">MOTD</span>
                    <span class="motd-title">Message of the Day</span>
                    <span class="motd-meta">{attempt.motd.length} lines</span>
                  </div>
                  <div class="groupedLines motd-groupedLines">
                    {#each attempt.motd as msg, i (i)}
                      {@const kind = classified[i]}
                      {@const isFirst = i === 0}
                      {@const Tag = isFirst ? 'h2' : 'div'}
                      <svelte:element
                        this={Tag}
                        class="groupedLines__line groupedLines__line--{kind}"
                        data-motd-kind={kind}
                      >
                        {@html renderLine(motdLines[i])}
                      </svelte:element>
                    {/each}
                  </div>
                  <div class="motd-footer">
                    <span class="motd-footer-rule" aria-hidden="true"></span>
                    <span class="motd-footer-text">End of MOTD command</span>
                    <span class="motd-footer-rule" aria-hidden="true"></span>
                  </div>
                </div>
              </div>
            {/if}

            <!-- Remaining numerics (not 001-004, not MOTD, not ISUPPORT) — each
                 line shows its RPL number as a small kicker, and the body
                 has every digit run highlighted in cyan-bold via
                 parseNumericStat so "5 invisible", "max 9", "1 server(s)"
                 all read as data points instead of buried in prose. -->
            {#each attempt.numeric as msg, ni (ni)}
              {@const statSegs = parseNumericStat(numericBody(msg))}
              <div class="row row--stat" data-cmd={msg.command}>
                {#if msg.command}
                  <span class="row-cmd">{msg.command}</span>
                {/if}
                <span class="row-content">
                  {#each statSegs as seg, si (si)}
                    <span class="stat-seg stat-seg--{seg.kind}">{seg.text}</span>
                  {/each}
                </span>
              </div>
            {/each}

             <!-- ISUPPORT (005) — categorized, clickable.
                  Prefers the engine-synced `network.isupport` Record (populated
                 by the dedicated `ISUPPORT` WS event AND by the initial sync
                 payload, so it's available even on cold sync). Falls back to
                 re-parsing the raw 005 lines from `attempt.cap` for historical
                 attempts or when the engine hasn't pushed the parsed map yet. -->
            {#if Object.keys(isupportMap).length > 0}
              <div class="row row--isupport" data-testid="row-isupport">
                <div class="isupport-frame">
                  <ServerFeaturesPanel
                    isupport={isupportMap}
                    dense={true}
                    titleFallback="This server"
                  />
                </div>
              </div>
            {/if}

            <!-- Raw server NOTICEs as collapsible block. parseNoticeOrCapLine
                 splits the two shapes that arrive here:
                   · "*** Looking up your hostname…" — the *** is a cyan-bold
                     label, the rest is plain prose.
                   · CAP LS responses like "account-notify account-tag …" —
                     each capability name is a cyan tag, spaces between them
                     are thin separators, key=value pairs get key/value split. -->
            {#if attempt.notices.length > 0}
              <div class="row row--notices">
                <details class="notices-details">
                  <summary class="row-content">
                    <span class="row-tag">NOTICE</span>
                    <span class="notices-summary">{attempt.notices.length} message{attempt.notices.length === 1 ? '' : 's'}</span>
                  </summary>
                  <ul class="notices-list">
                    {#each attempt.notices as msg, ni (ni)}
                      {#if msg.text}
                        {@const segs = parseNoticeOrCapLine(msg.text)}
                        <li class="notices-item">
                          {#each segs as seg, si (si)}
                            <span class="notice-seg notice-seg--{seg.kind}">{seg.text}</span>
                          {/each}
                        </li>
                      {/if}
                    {/each}
                  </ul>
                </details>
              </div>
            {/if}
          </div>
        </details>
      {/if}
    {/each}
  {/if}
</div>

<style>
  /* ──────────────────────────────────────────────────────────────────
   * Server log — fiber brand restyle
   * ──────────────────────────────────────────────────────────────────
   * Visual language lifted from the homepage marketing site (ircfiber.com):
   *   · Hairline 1px borders in --fiber-line instead of heavy dusk-blue
   *     tinted backgrounds — the homepage favors restraint over fill
   *   · Cyan accent (--fiber-blue) for active / pending state, instead
   *     of the IRCCloud dusk blue that read as "IRC client" not "Fiber"
   *   · Space Grotesk (--font-display) for the channel / network label
   *     so the server log reads as part of the same product surface as
   *     the landing page
   *   · A leading 2px "fiber-strand" bar on each card with a soft glow
   *     that pulses for pending connections — mirrors the homepage's
   *     `.status-pill .led` element at the top of the marketing page
   *   · Welcome / MOTD rows get a 2px cyan left-edge accent strip
   *     instead of the heavy IRCCloud #1d4063 / #1a3b5b fills
   * ────────────────────────────────────────────────────────────────── */

  .serverLogTimeline {
    padding: 0;
    contain: content;
  }

  /* ── Header (one-line) ──────────────────────────────────────────── */
  .head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px 6px 18px; /* extra left padding for the strand bar */
    min-height: 26px;
    line-height: 22px;
    font-size: 12px;
    cursor: pointer;
    user-select: none;
    border-bottom: 1px solid var(--fiber-line, #1a212b);
    color: var(--fiber-cloud, #c8d2dd);
    background: transparent;
    transition: background-color 120ms ease;
  }
  .head:hover { background: rgba(255, 255, 255, 0.02); }
  .head.expanded {
    background: linear-gradient(
      90deg,
      var(--fiber-blue-soft, rgba(103, 232, 249, 0.04)) 0%,
      transparent 60%
    );
    border-bottom-color: var(--fiber-line-2, #232c38);
  }
  .head:focus-visible {
    outline: 2px solid var(--fiber-blue, #67e8f9);
    outline-offset: -2px;
  }

  /* Leading vertical "fiber strand" — the brand accent bar on the left
     edge of every card. Color follows status; pending connections pulse
     with a soft cyan glow like the LED on the homepage topbar. */
  .head .head-strand {
    position: absolute;
    left: 0;
    top: 4px;
    bottom: 4px;
    width: 2px;
    border-radius: 1px;
    background: var(--strand-color, var(--fiber-line, #1a212b));
    box-shadow: 0 0 6px var(--strand-glow, transparent);
    transition: background-color 150ms ease, box-shadow 150ms ease;
  }
  .head--success .head-strand {
    --strand-color: var(--fiber-signal, #34d399);
    --strand-glow: rgba(52, 211, 153, 0.45);
  }
  .head--error .head-strand {
    --strand-color: var(--fiber-amber, #fbbf24);
    --strand-glow: rgba(251, 191, 36, 0.45);
  }
  .head--disconnected .head-strand {
    --strand-color: var(--fiber-mist, #4d5867);
    --strand-glow: transparent;
  }
  .head--pending .head-strand {
    --strand-color: var(--fiber-blue, #67e8f9);
    --strand-glow: var(--fiber-blue-glow, rgba(103, 232, 249, 0.35));
    animation: head-strand-pulse 2.4s ease-in-out infinite;
  }
  @keyframes head-strand-pulse {
    0%, 100% {
      box-shadow: 0 0 6px var(--fiber-blue-glow, rgba(103, 232, 249, 0.35));
      opacity: 1;
    }
    50% {
      box-shadow: 0 0 14px var(--fiber-blue-glow, rgba(103, 232, 249, 0.35));
      opacity: 0.7;
    }
  }

  .head .caret {
    flex-shrink: 0;
    width: 12px;
    font-size: 10px;
    color: var(--fiber-mist, #4d5867);
    text-align: center;
    transition: color 120ms ease;
  }
  .head:hover .caret { color: var(--fiber-fog, #8b96a4); }
  .head.expanded .caret { color: var(--fiber-blue, #67e8f9); }

  .head .glyph {
    flex-shrink: 0;
    width: 14px;
    text-align: center;
    font-weight: 600;
    font-family: var(--font-mono-fiber, monospace);
  }
  .head--success .glyph      { color: var(--fiber-signal, #34d399); }
  .head--error .glyph        { color: var(--fiber-amber,  #fbbf24); }
  .head--disconnected .glyph { color: var(--fiber-mist,   #4d5867); }
  .head--pending .glyph      { color: var(--fiber-blue,   #67e8f9); }

  .head .label {
    flex-shrink: 0;
    font-weight: 500;
    font-family: var(--font-display, var(--font-sans, sans-serif));
    letter-spacing: -0.005em;
  }
  .head--success .label      { color: var(--fiber-snow, #ecf2f8); }
  .head--error .label        { color: var(--fiber-amber, #fbbf24); }
  .head--disconnected .label { color: var(--fiber-mist,  #4d5867); }
  .head--pending .label      { color: var(--fiber-cloud, #c8d2dd); }

  .head .host {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fiber-fog, #8b96a4);
    font-family: var(--font-mono-fiber, monospace);
    font-size: 11.5px;
  }
  .head:hover .host { color: var(--fiber-cloud, #c8d2dd); }
  .head.expanded .host { color: var(--fiber-blue-hi, #a5f3fc); }

  .head .time {
    flex-shrink: 0;
    margin-left: auto;
    color: var(--fiber-mist, #4d5867);
    font-size: 11px;
    font-family: var(--font-mono-fiber, monospace);
    font-variant-numeric: tabular-nums;
  }
  .head.expanded .time { color: var(--fiber-fog, #8b96a4); }

  /* ── Rows: plain IRC chat style ─────────────────────────────────── */
  .row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 1px 12px 1px 26px;
    min-height: 18px;
    line-height: 18px;
    font-size: 12px;
    font-family: var(--font-mono-fiber, monospace);
    font-variant-ligatures: none;
    background: transparent;
    color: var(--fiber-cloud, #c8d2dd);
    border-bottom: 1px solid var(--fiber-line, #1a212b);
  }
  .row--last { border-bottom-color: var(--fiber-line-2, #232c38); }

  .row-prefix {
    flex-shrink: 0;
    width: 14px;
    color: var(--fiber-mist, #4d5867);
    text-align: right;
    padding-right: 4px;
  }
  .row-content {
    flex: 1;
    min-width: 0;
    color: inherit;
    word-break: break-word;
    white-space: pre-wrap;
  }

  .row-tag {
    display: inline-block;
    margin-right: 6px;
    color: var(--fiber-blue, #67e8f9);
    font-weight: 500;
    text-transform: lowercase;
    letter-spacing: 0.02em;
  }
  .row-text {
    color: var(--fiber-cloud, #c8d2dd);
  }

  /* ── Typographic status prefix (W4-T01 Refactor C) ──────────────
   *  Replaces the cyan-chip `.row-tag` for status / notice rows. IRCCloud
   *  uses an inline mono prefix (no chip, no background) so the eye reads
   *  the type token as typography, not as a badge. Inherits the row's
   *  monospace family so prefix + body align in the column.
   */
  .row-type-prefix {
    display: inline;
    margin-right: 8px;
    color: var(--fiber-blue, #67e8f9);
    font-weight: 600;
    font-family: var(--font-mono-fiber, monospace);
    font-variant-numeric: tabular-nums;
  }
  .row-type-prefix--notice { letter-spacing: 0.08em; }

  /* ── Cyan left-edge accent strip (welcome banner + MOTD) ────────── */
  .row-accent {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    border-radius: 1px;
    background: var(--fiber-blue, #67e8f9);
    box-shadow: 0 0 6px var(--fiber-blue-glow, rgba(103, 232, 249, 0.35));
  }
  .row-accent--cyan { background: var(--fiber-blue, #67e8f9); }

  /* ── Welcome banner (001-004) ───────────────────────────────────── */
  /* W4-T01 Refactor B: IRCCloud parity. IRCCloud renders .type_info_response
   * with `padding:10px` and NO cyan stripe, NO cyan-soft background.
   * Fiber used to give these a 4px/12px padding + soft cyan fill + left
   * stripe, which read as "loud card" instead of "quiet info line".
   * Drop the cyan stripe + bg, keep the welcome-segment token coloring
   * (those are typographic — they stay).
   */
  .row--info {
    position: relative;
    background: transparent;
    color: var(--fiber-cloud, #c8d2dd);
    padding: 10px;
    border-bottom-color: var(--fiber-line, #1a212b);
  }
  .row--info .row-accent { display: none; }
  .row--info .row-content { color: var(--fiber-cloud, #c8d2dd); }

  /* Welcome-banner segments. The plain text (prose around the
     tokens) stays in fiber-cloud at the default weight; the typed
     tokens get a colour + font that signals "this is a name / host /
     version / mode table". Each segment inherits `font-family: var
     (--font-mono-fiber)` from `.row` so monospace aligns across the
     whole banner — only the colour and weight differ. */
  .welcome-seg { white-space: pre; }
  .welcome-seg--plain {
    color: var(--fiber-cloud, #c8d2dd);
  }
  /* Network name ("ircfiber") + your nick ("Zod") — cyan + bold so the
     "this is you, this is your network" tokens pop. */
  .welcome-seg--network,
  .welcome-seg--nick {
    color: var(--fiber-blue, #67e8f9);
    font-weight: 600;
  }
  /* Hostname + version — snow + amber, mono. The amber version catches
     the eye without being aggressive. */
  .welcome-seg--host {
    color: var(--fiber-snow, #ecf2f8);
    font-weight: 500;
  }
  .welcome-seg--version {
    color: var(--fiber-amber, #fbbf24);
    font-weight: 500;
  }
  /* Created-on date — mono cloud so the full date reads as a single
     token but in the same brightness as the surrounding prose. */
  .welcome-seg--date {
    color: var(--fiber-cloud, #c8d2dd);
  }
  /* Mode tables (umodes / cmodes) — dim fog so they read as metadata
     rather than primary content. */
  .welcome-seg--mode-table {
    color: var(--fiber-fog, #8b96a4);
    letter-spacing: 0.04em;
  }
  /* Modes-with-prefix set — cyan-tinted so the "this is what you can
     set as a channel op" set reads as the most actionable piece. */
  .welcome-seg--mode-prefix {
    color: var(--fiber-blue, #67e8f9);
    font-weight: 500;
    letter-spacing: 0.04em;
  }

  /* ── Numeric stats rows (LUSERS, UMODEIS, etc.) ────────────────── */
  .row--stat {
    padding: 2px 12px 2px 12px;
    align-items: baseline;
  }
  /* Small RPL number kicker on the left, same visual language as the
     homepage's `.kicker` — uppercase, letter-spaced, monospace. */
  .row--stat .row-cmd {
    flex-shrink: 0;
    width: 30px;
    margin-right: 12px;
    color: var(--fiber-mist, #4d5867);
    font-family: var(--font-mono-fiber, monospace);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    text-align: right;
  }
  .stat-seg { white-space: pre; }
  .stat-seg--plain { color: var(--fiber-cloud, #c8d2dd); }
  .stat-seg--number {
    color: var(--fiber-blue, #67e8f9);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* ── ISUPPORT list (005) ────────────────────────────────────────── */
  /* ── ISUPPORT (005) row wrapper ────────────────────────────────────
   *
   *  The 005 tokens are now rendered by `<ServerFeaturesPanel>`, which
   *  owns its own internal styles for categorisation, badges, and
   *  the detail drawer. The row here is just a thin frame that
   *  prevents the panel from inheriting the timeline `.row` flex
   *  layout (which would break its grid).
   */
   .isupport-frame {
     display: block;
     padding: 2px 0;
   }

  /* ── Notices list (server NOTICEs + CAP LS) ────────────────────── */
  .notice-seg { white-space: pre; }
  .notice-seg--plain {
    color: var(--fiber-cloud, #c8d2dd);
  }
  /* "***" leading marker on a server notice — cyan-bold label. */
  .notice-seg--notice-label {
    color: var(--fiber-blue, #67e8f9);
    font-weight: 700;
    letter-spacing: 0.08em;
    margin-right: 8px;
  }
  /* Bare CAP name (no =) — cyan tag. */
  .notice-seg--cap-tag {
    color: var(--fiber-blue, #67e8f9);
    font-family: var(--font-mono-fiber, monospace);
    font-size: 11.5px;
    padding: 1px 5px;
    margin-right: 4px;
    background: rgba(103, 232, 249, 0.08);
    border: 1px solid rgba(103, 232, 249, 0.16);
    border-radius: 3px;
    white-space: nowrap;
  }
  /* CAP key=value split — key cyan-bold, value amber. */
  .notice-seg--cap-key {
    color: var(--fiber-blue, #67e8f9);
    font-weight: 500;
  }
  .notice-seg--cap-value {
    color: var(--fiber-amber, #fbbf24);
    font-family: var(--font-mono-fiber, monospace);
  }

  /* ── MOTD block ─────────────────────────────────────────────────── */
  /* W4-T01 Refactor B: IRCCloud parity. Same treatment as .row--info —
   * drop the cyan stripe + soft bg, keep the inner `.motd-body` / banner /
   * footer typography that gives MOTD its visual identity. */
  .row--motd {
    position: relative;
    background: transparent;
    padding: 10px;
    display: block;
    border-bottom: 1px solid var(--fiber-line, #1a212b);
  }
  .row--motd .row-accent { display: none; }
  .motd-body {
    display: block;
    padding: 4px 14px 10px 0;
  }

  /* Banner row: kicker "MOTD" + title + line count. Mirrors the
     homepage's `.kicker` style (uppercase monospace, leading rule). */
  .motd-banner {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 4px 0 10px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--fiber-line, #1a212b);
  }
  .motd-banner::before {
    /* Leading fiber-brand fiber-strand rule, mirrors the homepage's
       `.kicker::before` element that fires before every section label. */
    content: "";
     width: 24px;
     height: 1px;
     background: var(--fiber-blue, #67e8f9);
     box-shadow: 0 0 10px var(--fiber-blue-glow, rgba(103, 232, 249, 0.35));
    flex-shrink: 0;
    align-self: center;
  }
  .motd-kicker {
    color: var(--fiber-blue, #67e8f9);
    font-weight: 600;
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    font-family: var(--font-mono-fiber, monospace);
  }
  .motd-title {
    color: var(--fiber-snow, #ecf2f8);
    font-weight: 500;
    font-size: 12.5px;
    letter-spacing: -0.01em;
    font-family: var(--font-sans, sans-serif);
  }
  .motd-meta {
    margin-left: auto;
    color: var(--fiber-mist, #4d5867);
    font-size: 10px;
    font-family: var(--font-mono-fiber, monospace);
    letter-spacing: 0.04em;
  }

  /* The body — fiber-paper on a deeper ink bg, hairline border, with
     a subtle inner shadow so the ASCII art block sits as a recessed
     surface inside the larger card. */
  .motd-groupedLines {
    padding: 8px 10px;
    border-radius: 4px;
    background-color: var(--fiber-paper, #0e131a);
    border: 1px solid var(--fiber-line, #1a212b);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
    font-family: var(--font-mono-fiber, monospace);
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--fiber-cloud, #c8d2dd);
    /* Long MOTDs scroll horizontally instead of wrapping mid-art. */
    overflow-x: auto;
    white-space: pre;
  }
  /* Custom scrollbar that matches the fiber palette — visible but
     understated so it doesn't fight with the ASCII art. */
  .motd-groupedLines::-webkit-scrollbar { height: 6px; }
  .motd-groupedLines::-webkit-scrollbar-track {
    background: transparent;
  }
  .motd-groupedLines::-webkit-scrollbar-thumb {
    background: var(--fiber-line-2, #232c38);
    border-radius: 3px;
  }
  .motd-groupedLines::-webkit-scrollbar-thumb:hover {
    background: var(--fiber-mist, #4d5867);
  }

  /* Per-line classification styling — the bulk of the visual hierarchy.
     Each kind reads differently:
       · separator   :  IRC ":- ... -" banner line → dim, italic, no leading dash
       · closing     :  "End of MOTD command"        → bold cyan, sits in footer
       · art         :  ASCII art rows               → dim, no leading dash indent
       · section     :  "Welcome to ...", "Rules:"   → bold cyan heading
       · list        :  "1. Be respectful ..."       → indented numbered column
       · command     :  "/msg NickServ HELP"         → cyan slash, dim context
       · body        :  normal weight, fiber-cloud text
       · empty       :  collapsed half-line so the panel breathes */
  .motd-groupedLines .groupedLines__line {
    min-height: 0;
    color: var(--fiber-cloud, #c8d2dd);
  }

  /* h2 wrapper for the first line (separator, banner) — bigger, dim */
  .motd-groupedLines h2.groupedLines__line {
    margin: 0;
    font-weight: 500;
    font-size: 12.5px;
    color: var(--fiber-mist, #4d5867);
  }

  /* Separator lines (:- ... -) — dim italic, reads as decoration */
  .motd-groupedLines .groupedLines__line--separator {
    color: var(--fiber-mist, #4d5867);
    font-style: italic;
    padding: 2px 0;
  }

  /* ASCII art — dim, slightly faded so the eye reads it as decoration
     and not as content. */
  .motd-groupedLines .groupedLines__line--art {
    color: var(--fiber-fog, #8b96a4);
    font-weight: 500;
    line-height: 1.35;
    opacity: 0.85;
  }
  .motd-groupedLines .groupedLines__line--art :global(.irccolor),
  .motd-groupedLines .groupedLines__line--art :global(.irccolor-bg) {
    color: inherit;
  }

  /* Section headers — bold cyan, sans-serif so they read as headings. */
  .motd-groupedLines .groupedLines__line--section {
    color: var(--fiber-blue, #67e8f9);
    font-weight: 600;
    font-family: var(--font-sans, sans-serif);
    font-size: 12.5px;
    letter-spacing: -0.005em;
    margin-top: 2px;
  }

  /* Numbered list items — add a left indent so the digit column aligns */
  .motd-groupedLines .groupedLines__line--list {
    color: var(--fiber-cloud, #c8d2dd);
    padding-left: 1.5em;
  }

  /* Slash commands — cyan slash, dim command name */
  .motd-groupedLines .groupedLines__line--command {
    color: var(--fiber-fog, #8b96a4);
    padding-left: 1.5em;
  }

  /* Body lines — default fiber-cloud */
  .motd-groupedLines .groupedLines__line--body {
    color: var(--fiber-cloud, #c8d2dd);
  }

  /* Empty lines — collapse to half line-height for breathing room */
  .motd-groupedLines .groupedLines__line--empty {
    height: 0.55em;
    min-height: 0;
  }

  /* mIRC color spans inside MOTD — fiber-cloud by default. */
  .motd-groupedLines .groupedLines__line :global(b),
  .motd-groupedLines .groupedLines__line :global(strong) {
    font-weight: 600;
    color: var(--fiber-snow, #ecf2f8);
  }
  .motd-groupedLines :global(.irccolor),
  .motd-groupedLines :global(.irccolor-bg) {
    white-space: pre;
  }

  /* Closing "End of MOTD command" footer — dim rule on each side,
     centered, hairline above. Mirrors the homepage's `.kicker` pattern. */
  .motd-footer {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    padding-top: 8px;
  }
  .motd-footer-rule {
    flex: 1;
    height: 1px;
    background: var(--fiber-line, #1a212b);
  }
  .motd-footer-text {
    color: var(--fiber-mist, #4d5867);
    font-family: var(--font-mono-fiber, monospace);
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  /* ── ISUPPORT row wrapper ────────────────────────────────────────── */
  /* The new <ServerFeaturesPanel> handles its own header / collapse;
     this row is just the outer frame that prevents the panel from
     inheriting the timeline `.row` flex / 1-line-height.            */
  .row--isupport {
    padding: 2px 12px 2px 14px;
    background: transparent;
    display: block;
    border-bottom: 1px solid var(--fiber-line, #1a212b);
  }

  /* ── NOTICEs collapsible row ─────────────────────────────────────── */
  .row--notices {
    padding: 2px 12px 2px 26px;
    background: transparent;
    display: block;
    border-bottom: 1px solid var(--fiber-line, #1a212b);
  }
  details summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0;
  }
  details summary::-webkit-details-marker { display: none; }
  details summary .row-tag {
    color: var(--fiber-blue, #67e8f9);
    font-weight: 600;
    text-transform: none;
  }
  details summary:hover .row-tag { color: var(--fiber-blue-hi, #a5f3fc); }
  .notices-summary {
    color: var(--fiber-fog, #8b96a4);
    font-size: 11px;
    margin-left: 6px;
    font-family: var(--font-mono-fiber, monospace);
  }
  .notices-text {
    margin: 6px 0 0;
    padding: 4px 0 0;
    font-family: var(--font-mono-fiber, monospace);
    font-size: 11.5px;
    color: var(--fiber-cloud, #c8d2dd);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .notices-list {
    list-style: none;
    margin: 6px 0 0;
    padding: 4px 0 0;
    color: var(--fiber-fog, #8b96a4);
    font-family: var(--font-mono-fiber, monospace);
    font-size: 11.5px;
  }
  .notices-item {
    padding: 1px 0;
  }

  /* ── Empty state ────────────────────────────────────────────────── */
  .serverLogTimeline__empty {
    color: var(--fiber-mist, #4d5867);
    padding: 40px 24px;
    text-align: center;
    font-size: 13px;
    font-family: var(--font-mono-fiber, monospace);
    letter-spacing: 0.04em;
  }

  /* ── W4-T01: connection-events <details> wrap ─────────────────────
   *  Wraps every per-attempt detail row (phases + welcome + motd +
   *  numerics + isupport + notices) under a single <summary> so the
   *  user can collapse the entire detail stream to one line. The
   *  `<summary>` reads "Connection events (N)" — N is the count of
   *  nested rows computed in the template. Native browser toggle on
   *  click; the open state is bound to the global `serverlogCollapseEvents`
   *  pref via `bind:open` + local $state mirror + $effect.
   *
   *  The block has no chrome — just a hairline divider between the
   *  per-attempt header above and the wrapped detail rows. The cyan
   *  marker on the summary is the only color signal; it matches the
   *  existing `.row-cmd` / `.motd-kicker` cyan treatment so the user
   *  learns one color = "section heading".
   */
  .connection-events {
    margin: 0;
    padding: 0;
    border-bottom: 1px solid var(--fiber-line, #1a212b);
  }
  .connection-events > summary.connection-events-summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    color: var(--fiber-mist, #4d5867);
    font-family: var(--font-mono-fiber, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    user-select: none;
    background: transparent;
    transition: color 120ms ease, background-color 120ms ease;
  }
  .connection-events > summary.connection-events-summary:hover {
    color: var(--fiber-cloud, #c8d2dd);
    background: rgba(255, 255, 255, 0.02);
  }
  /* The disclosure triangle — cyan dot to match the rest of the
     section-marker language; hidden on webkit so we get one consistent
     shape across browsers (the ::marker is the fallback for firefox). */
  .connection-events > summary.connection-events-summary::-webkit-details-marker {
    display: none;
  }
  .connection-events > summary.connection-events-summary::before {
    content: "▸";
    color: var(--fiber-blue, #67e8f9);
    font-size: 10px;
    transition: transform 120ms ease;
    display: inline-block;
    width: 12px;
    text-align: center;
  }
  .connection-events[open] > summary.connection-events-summary::before {
    transform: rotate(90deg);
  }
  /* The body has no padding of its own — each nested row carries its
     own padding so the cyan stripe / numeric kicker / etc. align in
     their own columns. */
  .connection-events-body {
    display: block;
  }
  /* Hide the global [open] marker on the OUTER connection-events
     <details> so it doesn't render its own default triangle alongside
     the ::before above. */
  .connection-events > summary.connection-events-summary {
    list-style: none;
  }
</style>