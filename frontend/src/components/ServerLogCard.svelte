<script lang="ts">
  import type { Network, IRCMessage } from '../types';
  import {
    type ServerLogAttempt,
    phaseToLabel,
    attemptDuration,
    formatDuration,
    numericBody,
    formatIsupport,
  } from '../lib/serverLogGroups';
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import { serverlogCollapsedMap, serverlogHiddenMap } from '../stores/preferences.svelte';
  import { updateServerlogCollapsed } from '../stores/api';

  interface Props {
    attempt: ServerLogAttempt;
    network: Network | null;
    /** True for the most recent (last) attempt in the timeline.
     *  The latest card always starts expanded so the user can see
     *  the current connection state and logs. Older cards collapsed. */
    isLatest?: boolean;
  }

  let { attempt, network, isLatest = false }: Props = $props();

  // Phase events (queued, connecting, welcome) are transient — they flow
  // through the WebSocket in real-time but aren't persisted in scrollback.
  // After page refresh, the buffer only has raw IRC (001-004) and lifecycle
  // events (DISCONNECT). Override the card status from the network's real
  // connection state so the latest card always reflects reality.
  const effectiveStatus = $derived.by(() => {
    if (attempt.status === 'success') return 'success';
    if (!isLatest) return attempt.status;
    const cs = network?.connectionState;
    const c = network?.connected;
    if (cs === 'connected' || c === true) return 'success';
    return attempt.status;
  });

  // ── Enterprise-grade persistent collapse state ──
  // Keyed by `networkId:eid` (or `networkId:msgid:<msgid>` for legacy
  // scrollback without eid) so collapses survive page refresh, cross-tab
  // navigation, and cross-device sessions via Redis-backed pref sync.
  // The latest connected card starts expanded; everything else follows
  // the persisted preference map.
  const collapsedKey = $derived.by((): string => {
    if (!network?.networkId) return '';
    const start = attempt.start;
    if (start?.eid) return `${network.networkId}:${start.eid}`;
    if (start?.msgid) return `${network.networkId}:msgid:${start.msgid}`;
    return `${network.networkId}:id:${start?.id || 'synthetic'}`;
  });

  const expanded = $derived.by((): boolean => {
    // If the user has explicitly persisted a collapse state for this card,
    // honor it — even for the latest connected card. Otherwise the user's
    // collapse choice is lost on every page refresh, and the card pops
    // back open until they re-collapse it (visible flash).
    if (serverlogCollapsedMap[collapsedKey] === true) return false;
    // No persisted state: latest connected card defaults to expanded
    // (so the user sees MOTD / welcome banner immediately). All other
    // cards also default expanded until the user collapses them.
    return true;
  });

  // Auto-collapse when the connection ends. Once a user manually
  // disconnects (or the connection dies), the connection log is no
  // longer "live" — collapsing it gets it out of the way until they
  // intentionally re-open it. The collapse state is persisted so it
  // survives page refresh, just like a manual collapse.
  $effect(() => {
    const status = effectiveStatus;
    if ((status === 'disconnected' || status === 'error')
        && collapsedKey && network?.networkId
        && serverlogCollapsedMap[collapsedKey] !== true) {
      const eid = attempt.start?.eid ? Number(attempt.start.eid) : undefined;
      const msgid = (!attempt.start?.eid && attempt.start?.msgid) ? attempt.start.msgid : undefined;
      serverlogCollapsedMap[collapsedKey] = true;
      try {
        const data = JSON.parse(localStorage.getItem('ircfiber:serverlogCollapsed') || '{}');
        data[collapsedKey] = true;
        localStorage.setItem('ircfiber:serverlogCollapsed', JSON.stringify(data));
      } catch {}
      updateServerlogCollapsed(network.networkId, eid || undefined, msgid || undefined, true);
    }
  });

  function toggleExpanded(): void {
    if (!collapsedKey || !network?.networkId) return;
    const next = !expanded;
    const eid = attempt.start?.eid ? Number(attempt.start.eid) : undefined;
    const msgid = (!attempt.start?.eid && attempt.start?.msgid) ? attempt.start.msgid : undefined;
    // Update in-memory map + persist to localStorage immediately so a fast
    // page refresh (<500ms debounce) doesn't lose the collapse state.
    // The API call + pref_update WS event handles cross-tab/device sync.
    serverlogCollapsedMap[collapsedKey] = !next;
    try {
      const data = JSON.parse(localStorage.getItem('ircfiber:serverlogCollapsed') || '{}');
      if (!next) data[collapsedKey] = true;
      else delete data[collapsedKey];
      localStorage.setItem('ircfiber:serverlogCollapsed', JSON.stringify(data));
    } catch {}
    updateServerlogCollapsed(network.networkId, eid || undefined, msgid || undefined, !next);
  }

  /** Dismiss (hide) this connection attempt card from the timeline. */
  function dismiss(e: MouseEvent): void {
    e.stopPropagation();
    if (!collapsedKey) return;
    serverlogHiddenMap[collapsedKey] = true;
    // Sync to localStorage immediately so a fast page refresh doesn't
    // lose the dismiss (the debounced persist may not have fired yet).
    try {
      const data = JSON.parse(localStorage.getItem('ircfiber:serverlogHidden') || '{}');
      data[collapsedKey] = true;
      localStorage.setItem('ircfiber:serverlogHidden', JSON.stringify(data));
    } catch {}
  }

  let showRawTraffic = $state(false);
  let showCap = $state(false);
  // Phase timeline (TCP/TLS/Register/Ready) starts collapsed — once you've
  // seen "Connected", the per-step timestamps are low-value noise. Toggle
  // to re-expand if you're debugging a specific registration step.
  let showPhases = $state(false);

  // Always show MOTD (per product decision) — never collapsed
  const motdLines = $derived(attempt.motd.map((m) => numericBody(m)));

  // Raw IRC traffic count for the details summary
  const rawCount = $derived(attempt.notices.length + attempt.numeric.length);
  const capCount = $derived(attempt.cap.length);

  // Pull host:port from the network if available, otherwise from the attempt's text
  const hostLabel = $derived(getHostLabel(attempt, network));

  const statusLabel = $derived(getStatusLabel(effectiveStatus));

  const durationMs = $derived(attemptDuration(attempt));
  const durationLabel = $derived(durationMs != null ? formatDuration(durationMs) : '');

  function getHostLabel(a: ServerLogAttempt, net: Network | null): string {
    if (net?.host) {
      return `${net.host}${net.port ? ':' + net.port : ''}`;
    }
    // Try to extract from the connecting phase text (engine uses
    // "Connecting to host:port..."). Fall back to a dash.
    const connecting = a.phases.find((m) => m.phase === 'connecting' || m.phase === 'tcp_open');
    const text = connecting?.text ?? '';
    const match = text.match(/(\S+:\d+)/);
    return match ? match[1] : '—';
  }

  function getStatusLabel(s: string): string {
    switch (s) {
      case 'success':       return 'Connected';
      case 'error':         return 'Failed';
      case 'disconnected':  return 'Disconnected';
      case 'pending':       return 'Connecting…';
      default:              return 'Connecting…';
    }
  }

  function formatTime(ts: number | undefined): string {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour12: false });
  }

  function renderLine(text: string): string {
    return parseIrcFormatting(text);
  }

  // Light syntax coloring for welcome-banner lines (001-004, MOTD).
  // Wraps common patterns (hostnames, versions, dates, nicks, mode
  // strings) in muted-colored spans so users can scan the data faster.
  // The colors are subtle — just enough to break up the visual wall.
  function colorizeWelcomeLine(line: string): string {
    const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    let out = esc(line);
    // Version strings: ergo-v2.18.0, ircd-seven-1.0.0, etc.
    out = out.replace(/\b([a-z]+-v?\d[\w.-]*)\b/gi, '<span class="sv-version">$1</span>');
    // Hostnames: irc.ircfiber.com, irc.gangnet.org, etc.
    out = out.replace(/\b([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?\b/gi, '<span class="sv-host">$&</span>');
    // Dates: Sat, 27 Jun 2026 04:40:05 UTC
    out = out.replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+\w+\b/g,
      '<span class="sv-date">$&</span>');
    // Nickname at end of welcome line: "Network <nick>" — single word after " IRC Network "
    out = out.replace(/ IRC Network (\S+)/g, ' IRC Network <span class="sv-nick">$1</span>');
    // Channel mode strings: sequences of ASCII letters that look like modes
    // (BERTZios CEIMRUabefhiklmnoqstuv Iabefhkloqv). Match 8+ consecutive
    // letters with mixed case — typical IRC mode sets.
    out = out.replace(/\b([A-Za-z]{8,}(?:\s+[A-Za-z]{8,})*)\b/g, (m) => {
      if (/[a-z]/.test(m) && /[A-Z]/.test(m) && m.length >= 8) {
        return '<span class="sv-modes">' + m + '</span>';
      }
      return m;
    });
    return out;
  }

  // NICK collision retries produce duplicate 001-004 sequences (one per
  // attempted nick). Only show the LAST complete group — find the final
  // RPL_WELCOME (001) and show everything from there.
  function deduplicateWelcome(msgs: IRCMessage[]): IRCMessage[] {
    let lastIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].command === '001') { lastIdx = i; break; }
    }
    return lastIdx >= 0 ? msgs.slice(lastIdx) : msgs;
  }
</script>

<div class="serverLogCard status-{effectiveStatus}" class:expanded class:collapsed={!expanded}>
  <button
    type="button"
    class="serverLogCard__header"
    onclick={toggleExpanded}
    aria-expanded={expanded}
  >
    <span class="serverLogCard__icon" aria-hidden="true">
      {#if effectiveStatus === 'success'}
        <i class="fa-solid fa-circle-check"></i>
      {:else if effectiveStatus === 'error'}
        <i class="fa-solid fa-circle-xmark"></i>
      {:else if effectiveStatus === 'disconnected'}
        <i class="fa-solid fa-circle-pause"></i>
      {:else}
        <i class="fa-solid fa-spinner"></i>
      {/if}
    </span>
    <span class="serverLogCard__status">{statusLabel}</span>
    <span class="serverLogCard__host">{hostLabel}</span>
    <span class="serverLogCard__meta">
      <span class="serverLogCard__time">{formatTime(attempt.start.t)}</span>
      {#if durationLabel && effectiveStatus !== 'pending'}
        <span class="serverLogCard__duration">· {durationLabel}</span>
      {/if}
    </span>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <span class="serverLogCard__dismiss" role="button" tabindex="0"
          title="Dismiss this connection log"
          onclick={dismiss}>
      <i class="fa-solid fa-xmark"></i>
    </span>
    <span class="serverLogCard__chevron" aria-hidden="true">
      <i class="fa-solid fa-chevron-{expanded ? 'up' : 'down'}"></i>
    </span>
  </button>

  {#if expanded}
    <div class="serverLogCard__body">
      {#if attempt.phases.length > 0}
        <div class="serverLogCard__rawSection">
          <button
            type="button"
            class="serverLogCard__rawToggle"
            data-toggle="phases"
            aria-expanded={showPhases}
            onclick={() => (showPhases = !showPhases)}
          >
            <i class="fa-solid fa-chevron-{showPhases ? 'down' : 'right'}"></i>
            Connection steps <span class="serverLogCard__toggleCount">({attempt.phases.length})</span>
          </button>
          {#if showPhases}
            <ol class="serverLogTimeline">
              {#each attempt.phases as msg, i (i)}
                {@const chipPhase = (() => {
                  // Map engine phase tags directly.
                  if (msg.phase) return msg.phase;
                  // Map lifecycle commands into a phase for consistent chip styling.
                  if (msg.command === 'DISCONNECT' || msg.command === 'DISCONNECTED') return 'disconnected';
                  if (msg.command === 'CONNECT' || msg.command === 'CONNECTED') return 'info';
                  return '';
                })()}
                {@const isLast = i === attempt.phases.length - 1}
                <li class="serverLogTimeline__item phase-{chipPhase} status-{effectiveStatus}" class:isLast>
                  {#if chipPhase}
                    <span class="serverLogTimeline__chip" data-phase={chipPhase}>
                      {phaseToLabel(chipPhase)}
                    </span>
                  {:else}
                    <span class="serverLogTimeline__chip serverLogTimeline__chip--lifecycle">
                      {msg.command.toLowerCase()}
                    </span>
                  {/if}
                  <span class="serverLogTimeline__body">
                    {#if msg.text}{@html renderLine(msg.text)}{:else}&nbsp;{/if}
                  </span>
                  <span class="serverLogTimeline__time" title={msg.timestamp ?? ''}>
                    {formatTime(msg.t)}
                  </span>
                </li>
              {/each}
            </ol>
          {/if}
        </div>
      {/if}

      {#if attempt.numeric.length > 0}
        <div class="serverLogCard__rawSection">
          <button
            type="button"
            class="serverLogCard__rawToggle"
            data-toggle="server-info"
            aria-expanded={showRawTraffic}
            onclick={() => (showRawTraffic = !showRawTraffic)}
          >
            <i class="fa-solid fa-chevron-{showRawTraffic ? 'down' : 'right'}"></i>
            Server info <span class="serverLogCard__toggleCount">({attempt.numeric.length})</span>
          </button>
          {#if showRawTraffic}
            <div class="serverLogCard__rawBody">
              {#each attempt.numeric as msg, i (i)}
                <div class="serverLogCard__rawLine" data-cmd={msg.command}>
                  {numericBody(msg)}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if attempt.cap.length > 0}
        <div class="serverLogCard__rawSection">
          <button
            type="button"
            class="serverLogCard__rawToggle"
            data-toggle="isupport"
            aria-expanded={showCap}
            onclick={() => (showCap = !showCap)}
          >
            <i class="fa-solid fa-chevron-{showCap ? 'down' : 'right'}"></i>
            ISUPPORT <span class="serverLogCard__toggleCount">({attempt.cap.length})</span>
          </button>
          {#if showCap}
            <div class="serverLogCard__rawBody serverLogCard__rawBody--cap">
              {#each attempt.cap as msg, i (i)}
                <div class="serverLogCard__rawLine" data-cmd={msg.command}>
                  {@html formatIsupport(msg).replace(/\n/g, '<br>')}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if attempt.welcome.length > 0}
        {@const bannerMsgs = deduplicateWelcome(attempt.welcome)}
        <div class="serverLogMotd serverLogMotd--info" aria-label="Server welcome banner">
          <div class="serverLogMotd__label">Welcome</div>
          {#each bannerMsgs as msg, i (i)}
            <div class="serverLogMotd__line">{@html colorizeWelcomeLine(renderLine(numericBody(msg)))}</div>
          {/each}
        </div>
      {/if}

      {#if motdLines.length > 0}
        <div class="serverLogMotd" aria-label="Message of the Day">
          <div class="serverLogMotd__label">MOTD</div>
          {#each motdLines as line, i (i)}
            <div class="serverLogMotd__line">{@html renderLine(line)}</div>
          {/each}
        </div>
      {/if}

      {#if attempt.notices.length > 0}
        <div class="serverLogCard__rawSection">
          <button
            type="button"
            class="serverLogCard__rawToggle"
            data-toggle="raw-irc"
            aria-expanded={showRawTraffic}
            onclick={() => (showRawTraffic = !showRawTraffic)}
          >
            <i class="fa-solid fa-chevron-{showRawTraffic ? 'down' : 'right'}"></i>
            Raw IRC traffic <span class="serverLogCard__toggleCount">({attempt.notices.length})</span>
          </button>
          {#if showRawTraffic}
            <div class="serverLogCard__rawBody">
              {#each attempt.notices as msg, i (i)}
                <div class="serverLogCard__rawLine">
                  {msg.text}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>