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
  import { isFiberServer } from '../lib/fiberServer';
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
  const isJoining = $derived(activeNetwork?.connectionState === 'connected_joining');
  const isReadyWaiting = $derived(activeNetwork?.connectionState === 'connected_ready');
  const isQueued = $derived(activeNetwork?.connectionState === 'queued');
  const isQuitting = $derived(activeNetwork?.connectionState === 'quitting');
  const isIpRetry = $derived(activeNetwork?.connectionState === 'ip_retry');
  const isFiber = $derived(activeNetwork ? isFiberServer(activeNetwork) : false);
  const disconnectReason = $derived(activeNetwork?.disconnectReason || '');
  // Show banner for any transient state. The engine's `ConnectionState`
  // enum has only one "alive" value — `connected` — and never transitions
  // out of it until the next disconnect. So `connectionState === 'connected'`
  // means "fully connected and ready" (the brief 001→JOIN window is
  // already past by the time 001 publishes and the heartbeat fires),
  // NOT "still in the transient handshake window" — the banner must hide.
  //
  // W3-rev1 originally included `isHandshake` (= `connectionState === 'connected'`)
  // in `isTransient`, mirroring IRCCloud's transient handshake branch.
  // But our engine never flips `connectionState` to a non-transient value
  // once registration completes, so the banner stuck at
  // "Connected; handshaking…" forever — visible to users who had joined
  // channels and were actively chatting.
  const isTransient = $derived(
    isQueued ||
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
  //
  // Note: spelled out with explicit intermediate constants so Svelte's
  // runtime expression optimiser doesn't drop the `!isConnecting` gate.
  // An equivalent one-liner (`(isDisconnected || isWaitingToRetry) && !isConnecting`)
  // was observed to drop the negation in some 5.x builds.
  const isClickable = $derived.by(() => {
    if (!activeNetwork) return false;
    if (bannerKind === 'away') return true;
    const isReconnectableState = isDisconnected || isWaitingToRetry;
    if (!isConnecting && isReconnectableState) return true;
    return false;
  });

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
    if (isFiber) return;
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
      if (isFiber) {
        handleReconnect(e);
      } else {
        handleDisconnect(e);
      }
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

  // ── Avoid touching the layout when there's no active network ──
  const showHost = $derived(activeNetwork !== undefined && activeNetwork !== null);

  // ── Accessible name on the clickable row ─────────────────────────────
  // The visible headline carries the message; the aria-label adds the
  // action hint ("Click to reconnect …") so screen-reader users hear
  // both. Non-clickable rows use the headline alone — there's no action
  // to advertise.
  const rowLabel = $derived.by(() => {
    if (!activeNetwork) return '';
    return isClickable ? `${headline}. ${buttonLabel}` : headline;
  });
</script>

<!--
  Calm minimal-mono redesign. Three structural changes vs the W3-T01
  bar:

    1. Whole row IS the button (real <button>, not <a href="/">) — the
       fake-link hack with role="button" + manual keydown is gone. Native
       activation handles Enter/Space and disabled state for free.
    2. No spinner / icon badge / CTA pill — the state is signalled by a
       2px coloured left rule on the outer container. Calm by default.
    3. Warnings render in their own <ul>, indented to align with the
       headline, in fog-tone so they don't compete with the headline.

  Outer `.connectionstatuscell` keeps the same class name as the legacy
  component so ChatArea's existing styling continues to apply. Outer
  borders + disabled-state are part of the inner `.connectionStatus` so
  the cell itself stays chrome-free.
-->
<div class="connectionstatuscell" class:show={showStatus}>
  {#if showHost && activeNetwork}
    <div class={bannerClass}>
      <button
        type="button"
        class="connectionStatus__row"
        disabled={!isClickable}
        aria-label={rowLabel}
        onclick={isClickable ? handleClick : undefined}
      >
        <span class="connectionStatus__headline">
          {#if bannerKind === 'retry'}
            {retryText || headline}
          {:else}
            {headline}
          {/if}
        </span>
      </button>

      {#if warnings.length > 0}
        <ul class="connectionStatus__warnings" aria-label="Connection warnings">
          {#each warnings as warning}
            <li>{warning}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* ── Connection status banner — calm minimal mono ────────────────
     Three deliberate constraints:
       • No spinner / icon badge / CTA pill. The state is signalled
         by a 2px coloured left rule on the outer container.
       • No tinted background per state — the bar is chrome-free
         apart from hairline borders. Headline copy carries the
         semantic meaning.
       • Whole row IS the button — real <button type="button">, not
         the legacy <a href="/"> + role="button" hack. Native
         activation handles Enter/Space + disabled state.

     Outer `.connectionstatuscell` keeps the same class name as the
     legacy component so ChatArea's existing styling continues to
     apply. The outer cell stays chrome-free so ChatArea's collapse
     animation when `show` toggles stays clean. */

  .connectionstatuscell {
    padding: 0;
    border: 0;
    display: block;
  }

  .connectionStatus {
    /* Container carries the top + bottom hairlines + the 2px left
       state edge. The inner button does the rest. No tinted
       background — the headline copy is the entire visible surface.
       Monospace matches the timeline so the two surfaces read as one
       real-time log. */
    font-family: var(--font-mono-fiber, var(--font-mono, monospace));
    border-top: 1px solid var(--fiber-line);
    border-bottom: 1px solid var(--fiber-line);
    border-left: 2px solid var(--fiber-line);
    background: transparent;
    transition: border-left-color 160ms ease;
  }

  /* ── Clickable row — the entire bar ────────────────────────────── */
  .connectionStatus__row {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    padding: 6px 12px 6px 10px;
    color: var(--fiber-snow);
    font: inherit;
    font-size: 12.5px;
    line-height: 1.4;
    letter-spacing: 0.005em;
    cursor: default;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: background-color 160ms ease;
  }

  .connectionStatus__row:disabled {
    cursor: default;
    color: var(--fiber-cloud);
  }

  .connectionStatus__row:not(:disabled) {
    cursor: pointer;
  }

  .connectionStatus__row:not(:disabled):hover,
  .connectionStatus__row:not(:disabled):focus-visible {
    background-color: rgba(255, 255, 255, 0.025);
  }

  .connectionStatus__row:focus-visible {
    outline: 2px solid var(--fiber-blue);
    outline-offset: -2px;
  }

  /* ── Headline ──────────────────────────────────────────────────── */
  .connectionStatus__headline {
    display: block;
    font-weight: 400;
    color: inherit;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── State-coloured left edge ─────────────────────────────────── */
  /* The left rule IS the only signal of state. Headline copy carries
     the semantic meaning; the colour is just to help users skim a
     column of banners when several nets are flapping at once. */
  :global(.connectionStatus--connecting),
  :global(.connectionStatus--connected-joining),
  :global(.connectionStatus--connected-ready),
  :global(.connectionStatus--queued),
  :global(.connectionStatus--waiting) {
    border-left-color: var(--fiber-blue);
  }

  :global(.connectionStatus--ip-retry) {
    border-left-color: var(--fiber-blue);
  }

  :global(.connectionStatus--quitting) {
    border-left-color: var(--fiber-fog);
  }

  :global(.connectionStatus--away) {
    border-left-color: var(--fiber-mist);
  }
  :global(.connectionStatus--away) .connectionStatus__headline {
    color: var(--fiber-fog);
    font-style: italic;
  }

  :global(.connectionStatus--fail) {
    border-left-color: var(--fiber-amber);
  }

  /* Fail hover gets the barest amber tint (1.5x the row's resting tint)
     so the click affordance reads without overpowering the calm. */
  :global(.connectionStatus--fail.connectionStatus--clickable) .connectionStatus__row:not(:disabled):hover,
  :global(.connectionStatus--fail.connectionStatus--clickable) .connectionStatus__row:not(:disabled):focus-visible {
    background-color: rgba(251, 191, 36, 0.04);
  }

  /* ── Inline warnings (rendered as a separate list below the
       headline) ──────────────────────────────────────────────── */
  .connectionStatus__warnings {
    list-style: none;
    margin: 0;
    padding: 0 12px 7px 14px;
    border: 0;
    background: transparent;
    color: var(--fiber-fog);
    font-size: 11.5px;
    line-height: 1.55;
  }

  .connectionStatus__warnings li {
    margin: 0;
    padding: 1px 0;
  }

  /* The CTA-style warning ("Check your host, port and ssl settings")
     sits on its own line so the user can scan past the others. */
  .connectionStatus__warnings li:last-child {
    color: var(--fiber-cloud);
    font-weight: 500;
  }

  :global(.connectionStatus--fail) .connectionStatus__warnings li:last-child {
    color: var(--fiber-amber);
  }
</style>