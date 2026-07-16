<script lang="ts">
  // ─────────────────────────────────────────────────────────────────────
  // IRCCloud-style connection status banner (W3-T01)
  //
  // Mirrors IRCCloud's ConnectionStatusView.renderText pipeline:
  //   1. If the user is away, the Away banner takes precedence and the
  //      banner shows the "Click to come back" link.
  //   2. While the engine is connecting, we render "Connecting to <host>"
  //      (or "Reconnecting to <host>" when an attempt is in progress).
  //   3. While the engine is in the backoff loop between attempts, the
  //      `retryStatus` payload drives a live countdown.
  //   4. After a terminal failure, the rich `failInfo` branches
  //      (killed / ssl_certificate_error / connection_blocked /
  //      connecting_failed / socket_closed) pick the right headline +
  //      icon. Inline warnings from `connectionWarnings` are appended
  //      below as separate lines.
  //   5. Otherwise we render a generic "Disconnected: <reason>" banner
  //      with the click-to-reconnect button.
  //
  // The component uses Svelte 5 runes (`$props`, `$state`, `$derived`,
  // `$effect`, `$bindable`) only — no stores. Visual styling reuses the
  // fiber-dusk palette (`--fiber-blue-soft`, `--fiber-cloud`,
  // `--fiber-fog`) with a documented `--fiber-amber-soft` fallback for
  // fail-state backgrounds until that token is added to the palette.
  // ─────────────────────────────────────────────────────────────────────

  import { getActiveNetwork, setActiveBuffer, ircState } from '../stores/ircStore.svelte';
  import { sendRaw, requestSync } from '../stores/wsConnection.svelte.ts';
  import { reconnectNetwork, disconnectNetwork } from '../stores/api';
  import { serverlogCollapsedMap } from '../stores/preferences.svelte';
  import { groupServerLog, getServerLogCollapsedKey } from '../lib/serverLogGroups';
  import {
    connectionWarnings,
    renderReason,
    renderSSLVerify,
    renderRetryCountdown,
    FAIL_TYPES,
  } from '../lib/connectionWarnings';

  interface Props {
    onSendRaw?: (networkId: string, cmd: string) => void | Promise<void>;
    onReconnect?: (networkId: string) => void | Promise<void>;
  }
  let { onSendRaw = sendRaw, onReconnect = reconnectNetwork }: Props = $props();

  const activeNetwork = $derived(getActiveNetwork());

  // ── Derived state ────────────────────────────────────────────────
  const isAway = $derived(activeNetwork?.isAway ?? false);
  const isDisconnected = $derived(activeNetwork ? !activeNetwork.connected : false);
  const isConnecting = $derived(activeNetwork?.connectionState === 'connecting');
  const isWaitingToRetry = $derived(activeNetwork?.connectionState === 'waiting_to_retry');
  const isHandshake = $derived(activeNetwork?.connectionState === 'connected');
  const isJoining = $derived(activeNetwork?.connectionState === 'connected_joining');
  const isReadyWaiting = $derived(activeNetwork?.connectionState === 'connected_ready');
  const isQueued = $derived(activeNetwork?.connectionState === 'queued');
  const isQuitting = $derived(activeNetwork?.connectionState === 'quitting');
  const isIpRetry = $derived(activeNetwork?.connectionState === 'ip_retry');
  const disconnectReason = $derived(activeNetwork?.disconnectReason || '');

  // Show banner for any transient state. W3-rev1: lifted the showStatus
  // gate so transient mid-handshake states (`connected`, `connected_joining`,
  // `connected_ready`, `queued`, `quitting`, `ip_retry`) all keep the
  // banner visible — previously the `if (connected) hide` logic hid it
  // during the brief `connected` (handshake) window even when the engine
  // hadn't yet joined any channels. Mirrors IRCCloud's
  // `ConnectionStatusView.render` pipeline which always shows during the
  // transient window. Once the engine emits `connected_ready` and the
  // focus buffer is resolved (or the user is just `connected` with no
  // auto-joins), the engine flips connectionState away from these
  // transient values and the banner hides via the !isTransient fallback.
  const isTransient = $derived(
    isQueued ||
    isHandshake ||
    isJoining ||
    isReadyWaiting ||
    isQuitting ||
    isIpRetry ||
    isConnecting ||
    isWaitingToRetry ||
    (isDisconnected && !isConnecting && !isWaitingToRetry),
  );
  const showStatus = $derived(isAway || isTransient);

  // ── Headline text ────────────────────────────────────────────────
  //
  // Mirrors IRCCloud's `ConnectionStatusView.renderText`. The branches
  // are mutually exclusive — we evaluate the rich fail-info first, then
  // the live state, then fall through to a generic disconnect line.
  // W3-rev1 extended BannerKind to cover the full 11-state matrix lifted
  // from irccloud-webpack-study/app/src/view/connectionstatusview.js:64-123.
  type BannerKind =
    | 'away'
    | 'connecting'
    | 'queued'
    | 'handshake'
    | 'connected-joining'
    | 'connected-ready'
    | 'quitting'
    | 'ip-retry'
    | 'retry'
    | 'retry-giveup'
    | 'fail-killed'
    | 'fail-ssl'
    | 'fail-blocked'
    | 'fail-connecting'
    | 'fail-socket'
    | 'disconnected';

  interface BannerLine {
    text: string;
    icon?: 'check' | 'spinner' | 'warning' | 'clock';
    isSSL?: boolean;
  }

  const bannerKind: BannerKind = $derived.by(() => {
    if (!activeNetwork) return 'disconnected';
    if (isAway) return 'away';
    if (isWaitingToRetry) {
      // W3-rev1: distinguish "will retry" (retryStatus populated with a
      // future nextRetryAtMs) from "gave up" (retryStatus is null OR
      // nextRetryAtMs has been cleared to 0 by the engine's
      // emitZeroRetryStatus). The latter renders the static
      // "Reconnecting…" fallback instead of an empty headline.
      const rs = activeNetwork.retryStatus;
      const hasSchedule = !!rs && (rs.nextRetryAtMs ?? 0) > 0;
      return hasSchedule ? 'retry' : 'retry-giveup';
    }
    if (activeNetwork.failInfo) {
      const t = activeNetwork.failInfo.type;
      if (t === FAIL_TYPES.KILLED) return 'fail-killed';
      if (t === FAIL_TYPES.SSL_CERTIFICATE_ERROR || activeNetwork.failInfo.sslVerifyError) return 'fail-ssl';
      if (t === FAIL_TYPES.CONNECTION_BLOCKED) return 'fail-blocked';
      if (t === FAIL_TYPES.CONNECTING_FAILED) return 'fail-connecting';
      if (t === FAIL_TYPES.SOCKET_CLOSED) return 'fail-socket';
    }
    if (isQueued) return 'queued';
    if (isHandshake) return 'handshake';
    if (isJoining) return 'connected-joining';
    if (isReadyWaiting) return 'connected-ready';
    if (isQuitting) return 'quitting';
    if (isIpRetry) return 'ip-retry';
    if (isConnecting) return 'connecting';
    return 'disconnected';
  });

  const headline: string = $derived.by(() => {
    if (!activeNetwork) return '';
    const fail = activeNetwork.failInfo;
    const host = activeNetwork.host || 'server';
    switch (bannerKind) {
      case 'away':
        return 'Away';
      case 'queued':
        // W3-rev1: IRCCloud branch "queued" — engine emits this when
        // another connection is still in flight and our attempt is
        // waiting for a free worker slot. Pure status copy; no IP /
        // host substituted.
        return 'Connection queued; waiting our turn…';
      case 'connecting':
        return isReconnectingLabel()
          ? `Reconnecting to ${host}…`
          : `Connecting to ${host}…`;
      case 'handshake':
        // W3-rev1: shown during the `connected` window between the
        // engine emitting 001 (RPL_WELCOME) and the first JOIN echo.
        // IRCCloud lifts this verbatim from connectionstatusview.js:73.
        return 'Connected; handshaking…';
      case 'connected-joining':
        // W3-rev1: handshake done, JOINs in flight.
        return 'Connected; setting up…';
      case 'connected-ready': {
        // W3-rev1: engine has a focus buffer it intends to make-active
        // but hasn't joined yet. IRCCloud lifts the channel name from
        // `focusOnMakeBuffer`; an empty / '*' value falls back to the
        // generic "waiting to join…".
        const focus = (activeNetwork.focusOnMakeBuffer || '').trim();
        if (focus && focus !== '*') {
          return `Connected; waiting to join ${focus}…`;
        }
        return 'Connected; waiting to join…';
      }
      case 'quitting':
        // W3-rev1: user-initiated /disconnect. The engine flips to this
        // state while it flushes a QUIT line; the banner is informational
        // only (no button) — the user has already decided to leave.
        return 'Quitting…';
      case 'ip-retry': {
        // W3-rev1: per IRCCloud's `ip_retry` branch
        // (`connectionstatusview.js:78`). If the engine emitted an IP
        // via `failInfo.ip` (or a top-level `network.ip`), surface it
        // — otherwise fall back to a copy that omits the IP, and TODO
        // a future engine patch to ship the field.
        const ip = (fail?.ip || activeNetwork.ip || '').trim();
        const err = renderReason(fail?.reason || disconnectReason);
        if (ip && err) return `Connecting to ${ip} failed (${err}); resolving a new IP…`;
        if (ip)        return `Connecting to ${ip} failed; resolving a new IP…`;
        if (err)       return `Connecting failed (${err}); resolving a new IP…`;
        return 'Connecting failed; resolving a new IP…';
      }
      case 'retry':
        return renderRetryCountdown(activeNetwork.retryStatus);
      case 'retry-giveup':
        // W3-rev1: static fallback when the engine has cleared the
        // retryStatus payload (e.g. emitZeroRetryStatus) but kept
        // connectionState='waiting_to_retry'. Without this, the
        // banner would render an empty headline.
        return 'Reconnecting…';
      case 'fail-killed':
        return `Disconnected - Killed: ${renderReason(fail?.killedReason || fail?.reason)}`;
      case 'fail-ssl':
        return `Strict transport security error: ${renderSSLVerify(fail?.sslVerifyError)}`;
      case 'fail-blocked':
        return 'Disconnected - Connections to this server have been blocked';
      case 'fail-connecting':
        return `Failed to connect - ${renderReason(fail?.reason)}`;
      case 'fail-socket':
        return `Disconnected: ${renderReason(fail?.reason)}`;
      case 'disconnected':
      default: {
        const base = `Disconnected: ${renderReason(disconnectReason)}`;
        // Reserved engine signal — render gracefully even though it
        // isn't emitted yet. We accept it via either the new failInfo
        // path (engine-driven) or the legacy disconnectReason string
        // (engine just emits a plain string) so the suffix lands
        // regardless of which field the engine populates.
        if (fail?.reason === FAIL_TYPES.GAVE_UP_RETRYING ||
            disconnectReason === FAIL_TYPES.GAVE_UP_RETRYING) {
          return `${base}; Gave up retrying`;
        }
        return base;
      }
    }
  });

  function isReconnectingLabel(): boolean {
    // IRCCloud says "Reconnecting to" once a previous attempt has failed
    // (i.e. when `failInfo` or `disconnectReason` is populated and we're
    // back to connecting). The original component used the bare presence
    // of `disconnectReason` — we keep that, but exclude the empty
    // string case so a fresh "first attempt" still says "Connecting".
    return (disconnectReason || '').length > 0 || !!activeNetwork?.failInfo;
  }

  // ── Inline warnings (appended as separate lines inside the banner) ─
  //
  // These surface configuration mistakes and a "Check your host, port
  // and ssl settings" CTA when the connection actually failed. They
  // never replace the headline; they only append to it.
  const warnings: string[] = $derived.by(() => {
    if (!activeNetwork) return [];
    const includeCta =
      bannerKind === 'fail-connecting' ||
      bannerKind === 'fail-socket' ||
      bannerKind === 'disconnected';
    return connectionWarnings(
      activeNetwork.host,
      activeNetwork.port,
      activeNetwork.tls === 'required' || activeNetwork.tls === 'enabled',
      { includeConfigCta: includeCta },
    );
  });

  // ── Live countdown (re-render every second while retrying) ───────
  //
  // Without this $effect, the banner would render the *initial*
  // remaining-seconds value forever. We tick a `now` state every
  // second while waiting_to_retry so renderRetryCountdown sees a fresh
  // clock and the displayed countdown ticks down.
  let now = $state(Date.now());
  $effect(() => {
    if (!isWaitingToRetry) return;
    const id = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(id);
  });

  const retryText = $derived(
    activeNetwork?.retryStatus ? renderRetryCountdown(activeNetwork.retryStatus, now) : '',
  );

  // ── Button label + action ───────────────────────────────────────
  const buttonLabel = $derived.by(() => {
    if (!activeNetwork) return '';
    if (bannerKind === 'away') {
      // Banner doubles as the AWAY handler. IRCCloud-style: clicking
      // the banner clears the away status by sending AWAY with no
      // argument.
      return 'Click to come back (or type /back)';
    }
    if (activeNetwork.badRetry === true) {
      return 'Click to disconnect (or type /disconnect)';
    }
    return 'Click to reconnect (or type /reconnect)';
  });

  // The banner is clickable for AWAY (clear-away), disconnected
  // (reconnect), waiting_to_retry (cancel-via-reconnect). Connecting is
  // transient and has no in-band cancel — match IRCCloud.
  const isClickable = $derived(
    activeNetwork !== undefined &&
    activeNetwork !== null &&
    (bannerKind === 'away' || ((isDisconnected || isWaitingToRetry) && !isConnecting)),
  );

  // ── Handlers ─────────────────────────────────────────────────────
  function handleBack(e: MouseEvent): void {
    e.preventDefault();
    if (!activeNetwork) return;
    onSendRaw(activeNetwork.networkId, 'AWAY');
  }

  async function handleReconnect(e: MouseEvent): Promise<void> {
    e.preventDefault();
    if (!activeNetwork) return;
    const net = activeNetwork;

    // Collapse all existing server-log cards so only the new connection
    // attempt (fresh eid) stays expanded.
    const serverMessages = ircState.messages[`${net.networkId}:_server`] ?? [];
    for (const attempt of groupServerLog(serverMessages)) {
      const key = getServerLogCollapsedKey(attempt, net.networkId);
      if (key) serverlogCollapsedMap[key] = true;
    }

    net.connectionState = 'connecting';
    setActiveBuffer(net.networkId, '_server');
    try {
      await onReconnect(net.networkId);
      requestSync();
    } catch (err) { console.error(err); }
  }

  async function handleDisconnect(e: MouseEvent): Promise<void> {
    e.preventDefault();
    if (!activeNetwork) return;
    try {
      await disconnectNetwork(activeNetwork.networkId, 'user request');
    } catch (err) { console.error(err); }
  }

  function handleClick(e: MouseEvent): void {
    if (!activeNetwork) return;
    if (bannerKind === 'away') {
      // Inline AWAY handler — the banner itself is the click target.
      handleBack(e);
      return;
    }
    if (activeNetwork.badRetry === true) {
      handleDisconnect(e);
    } else {
      handleReconnect(e);
    }
  }

  // ── Visual helpers ───────────────────────────────────────────────
  const bannerClass = $derived.by(() => {
    const classes = ['connectionStatus', 'connectionStatus--show'];
    switch (bannerKind) {
      case 'away':
        classes.push('away', 'connectionStatus--away');
        break;
      case 'connecting':
        classes.push('connecting', 'connectionStatus--connecting');
        break;
      case 'queued':
        classes.push('queued', 'connectionStatus--queued');
        break;
      case 'handshake':
        classes.push('handshake', 'connectionStatus--handshake');
        break;
      case 'connected-joining':
        classes.push('connecting', 'connectionStatus--connected-joining');
        break;
      case 'connected-ready':
        classes.push('waiting', 'connectionStatus--connected-ready');
        break;
      case 'quitting':
        classes.push('quitting', 'connectionStatus--quitting');
        break;
      case 'ip-retry':
        classes.push('fail', 'connectionStatus--ip-retry');
        break;
      case 'retry':
      case 'retry-giveup':
        classes.push('waiting', 'connectionStatus--waiting');
        break;
      case 'fail-killed':
      case 'fail-ssl':
      case 'fail-blocked':
      case 'fail-connecting':
      case 'fail-socket':
        classes.push('fail', 'connectionStatus--fail');
        if (bannerKind === 'fail-ssl') classes.push('fail-ssl');
        break;
      case 'disconnected':
      default:
        classes.push('reconnect', 'connectionStatus--disconnected');
    }
    if (isClickable) classes.push('connectionStatus--clickable');
    return classes.join(' ');
  });

  const iconClass = $derived.by(() => {
    switch (bannerKind) {
      case 'away':           return 'fa fa-check-circle';
      case 'connecting':     return 'fa fa-spinner';
      case 'queued':         return 'fa fa-hourglass-half';
      case 'handshake':      return 'fa fa-spinner';
      case 'connected-joining': return 'fa fa-spinner';
      case 'connected-ready':return 'fa fa-clock-o';
      case 'quitting':       return 'fa fa-sign-out';
      case 'ip-retry':       return 'fa fa-warning';
      case 'retry':
      case 'retry-giveup':   return 'fa fa-clock-o';
      case 'fail-killed':
      case 'fail-ssl':
      case 'fail-blocked':
      case 'fail-connecting':
      case 'fail-socket':    return 'fa fa-warning';
      default:               return 'fa fa-warning';
    }
  });

  // ── Avoid touching the layout when there's no active network ──
  const showHost = $derived(activeNetwork !== undefined && activeNetwork !== null);
</script>

<!--
  Outer `.connectionstatuscell` keeps the same class name as the
  legacy component so ChatArea's existing styling continues to apply.
  The inner `.connectionStatus` carries the new fiber-dusk palette.
-->
<div class="connectionstatuscell" class:show={showStatus}>
  {#if showHost}
    <div class={bannerClass}>
      <!--
        svelte-ignore a11y_click_events_have_key_events — the banner
        is keyboard-accessible via the role="button" + tabindex + the
        matching keydown handler below.
      -->
      <a
        class="connectionStatus__inner"
        href="/"
        role={isClickable ? 'button' : undefined}
        tabindex={isClickable ? 0 : -1}
        aria-disabled={isClickable ? undefined : 'true'}
        onclick={isClickable ? handleClick : undefined}
        onkeydown={isClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleClick(e as unknown as MouseEvent);
              }
            }
          : undefined}
      >
        <span class="connectionStatus__icon" aria-hidden="true">
          <i class={iconClass}></i>
        </span>
        <span class="connectionStatus__headline">
          {#if isAway}
            <span class="connectionStatus__away-label">{headline}</span>
          {:else if bannerKind === 'retry'}
            {retryText || headline}
          {:else}
            {headline}
          {/if}
        </span>
        {#if isClickable}
          <span class="connectionStatus__cta">{buttonLabel}</span>
        {/if}
      </a>

      {#if warnings.length > 0}
        <ul class="connectionStatus__warnings" aria-label="Connection warnings">
          {#each warnings as warning}
            <li class="connectionStatus__warning">{warning}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* ── Connection status banner — IRCCloud dusk palette (W3-T01) ──
     Matches the IRCCloud "ConnectionStatusView" structure: outer
     `.connectionStatus` (full-width flex row) + inner clickable
     `<a>` carrying the icon + headline + CTA. Warnings render below
     the inner row as a separate <ul>. Transitions over 200ms so the
     palette swap during a state change is smooth. */

  .connectionstatuscell {
    padding: 0;
    border: 0;
  }

  .connectionStatus {
    /* Container itself is padding: 0 / border: 0 — the inner <a>
       carries all the visible chrome so we can collapse cleanly when
       the banner is hidden. */
    padding: 0;
    border: 0;
  }

  /* ── Inner clickable row ─────────────────────────────────────── */
  :global(.connectionStatus--show) > .connectionStatus__inner {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    padding: 5px 7px 5px 27px;
    border-top: 1px solid;
    border-bottom: 1px solid;
    background-color: var(--fiber-blue-soft);
    color: var(--fiber-cloud);
    text-decoration: none;
    cursor: pointer;
    transition: background-color 200ms ease, border-color 200ms ease, color 200ms ease;
  }

  :global(.connectionStatus--clickable) > .connectionStatus__inner {
    cursor: pointer;
  }

  /* Hover / focus: brighten to the cyan accent border + slightly
     brighter background so the user sees the banner is interactive. */
  :global(.connectionStatus--clickable) > .connectionStatus__inner:hover,
  :global(.connectionStatus--clickable) > .connectionStatus__inner:focus {
    border-top-color: var(--fiber-blue);
    border-bottom-color: var(--fiber-blue);
    background-color: var(--fiber-blue-dim);
    outline: none;
    text-decoration: none;
  }

  /* ── State-specific palettes ──────────────────────────────────── */

  /* Connecting (live spinner) */
  :global(.connectionStatus--connecting) > .connectionStatus__inner {
    border-top-color: var(--fiber-blue);
    border-bottom-color: var(--fiber-blue);
  }

  /* Waiting for retry (live countdown) — same cyan family but with a
     subtle tint shift so the user can tell connecting vs retrying. */
  :global(.connectionStatus--waiting) > .connectionStatus__inner {
    border-top-color: var(--fiber-blue);
    border-bottom-color: var(--fiber-blue);
  }

  /* Away — fog background */
  :global(.connectionStatus--away) > .connectionStatus__inner {
    background-color: var(--fiber-fog);
    color: var(--fiber-cloud);
    border-top-color: var(--fiber-mist);
    border-bottom-color: var(--fiber-mist);
  }

  /* Fail states — amber.
     TODO: --fiber-amber-soft isn't defined yet; we ship with a literal
     rgba fallback so the palette match is correct in dev. Once
     _variables.scss gains the token, remove the fallback. */
  :global(.connectionStatus--fail) > .connectionStatus__inner {
    background-color: var(--fiber-amber-soft, rgba(251, 191, 36, 0.08));
    color: var(--fiber-cloud);
    border-top-color: var(--fiber-amber);
    border-bottom-color: var(--fiber-amber);
  }

  :global(.connectionStatus--fail-ssl) > .connectionStatus__inner {
    /* Slightly stronger amber tint so TLS verify failures stand out
       from generic connection-refused errors. */
    background-color: var(--fiber-amber-soft, rgba(251, 191, 36, 0.12));
  }

  /* ── Icon + text layout ───────────────────────────────────────── */

  .connectionStatus__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    flex-shrink: 0;
    color: inherit;
  }

  .connectionStatus__icon i {
    font-size: 14px;
    line-height: 1;
  }

  .connectionStatus__headline {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }

  .connectionStatus__cta {
    /* Right-aligned, brighter accent colour, no underline by default.
       Margin-left:auto so it floats right even when the flex layout
       has only one row item. */
    margin-left: auto;
    color: var(--fiber-blue-hi);
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .connectionStatus__away-label {
    font-weight: 600;
    color: var(--fiber-snow);
  }

  /* ── Spinner animation (live "connecting") ────────────────────── */
  :global(.connectionStatus--connecting) .connectionStatus__icon i {
    animation: connectionStatus-spin 1.1s linear infinite;
  }

  @keyframes connectionStatus-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  /* ── Inline warnings (rendered as a separate list below the
       clickable row) ─────────────────────────────────────────── */
  .connectionStatus__warnings {
    list-style: none;
    margin: 0;
    padding: 4px 12px 6px 27px;
    border-top: 0;
    background-color: var(--fiber-blue-soft);
    color: var(--fiber-cloud);
    font-size: 12px;
    line-height: 1.5;
  }

  :global(.connectionStatus--fail) .connectionStatus__warnings {
    background-color: var(--fiber-amber-soft, rgba(251, 191, 36, 0.08));
  }

  :global(.connectionStatus--away) .connectionStatus__warnings {
    background-color: var(--fiber-fog);
  }

  .connectionStatus__warning {
    margin: 0;
    padding: 1px 0;
  }

  /* The CTA-style warning ("Check your host, port and ssl settings")
     sits on its own line so the user can scan past the others. */
  .connectionStatus__warning:last-child {
    color: var(--fiber-blue-hi);
  }

  /* ── Hidden helpers ──────────────────────────────────────────── */
  .back {
    display: none;
  }
</style>