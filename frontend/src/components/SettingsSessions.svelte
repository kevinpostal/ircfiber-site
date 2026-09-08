<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchLoginSessions, revokeLoginSession, type LoginSession, type LoginSessionsInfo } from '../stores/api';
  import { waitForWsSessionId } from '../stores/wsConnection.svelte';
  import { describeUserAgent } from '../lib/userAgent';
  import { formatShortRelativeTime } from '../lib/utils';
  import SettingsSection from './SettingsSection.svelte';

  let info = $state<LoginSessionsInfo | null>(null);
  let loadError = $state('');
  let busy = $state(false);
  /** `ref` of the row whose Revoke button is armed, then in flight. Two-step
   *  because the rows are told apart only by IP and user agent, which look
   *  alike when the same person signs in twice from one network. */
  let confirmRef = $state('');
  let revokingRef = $state('');
  let revokeError = $state('');
  let revokeNote = $state('');

  async function load(): Promise<void> {
    busy = true;
    loadError = '';
    try {
      // Wait briefly for this tab's WS session id: the page can mount before
      // the handshake lands, and without it the server cannot mark which
      // client row is the tab you are looking at.
      info = await fetchLoginSessions(await waitForWsSessionId());
    } catch (e: unknown) {
      loadError = (e as Error).message || 'Failed to load your login sessions';
    } finally {
      busy = false;
    }
  }

  async function revoke(s: LoginSession): Promise<void> {
    // The server refuses this anyway (409); not offering it is clearer.
    if (s.current) return;
    revokingRef = s.ref;
    revokeError = '';
    revokeNote = '';
    try {
      const { clientsDropped } = await revokeLoginSession(s.ref);
      revokeNote = clientsDropped > 0
        ? `Signed that browser out and closed ${clientsDropped} connected tab${clientsDropped === 1 ? '' : 's'}.`
        : 'Signed that browser out.';
      confirmRef = '';
      await load();
    } catch (e: unknown) {
      revokeError = (e as Error).message || 'Could not revoke that session';
    } finally {
      revokingRef = '';
    }
  }

  onMount(() => { void load(); });

  const stampFmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  function stamp(ms: number): string {
    if (!ms) return 'unknown';
    return stampFmt.format(new Date(ms));
  }

  /** Difference between this browser's clock and the gateway's, so a skewed
   *  device does not report "in 2 hours" as an age. */
  let skew = $derived(info ? Date.now() - info.now : 0);

  function ago(ms: number): string {
    if (!ms) return '';
    return `${formatShortRelativeTime(ms + skew)} ago`;
  }

  function ua(raw: string): string {
    return describeUserAgent(raw).label;
  }

  function clientLabel(s: LoginSession): string {
    if (s.clientCount === 0) return '—';
    return String(s.clientCount);
  }
</script>

<SettingsSection heading="Login sessions">
  <div class="settings-rows">
    <div class="settings-row">
      <div class="settings-label">
        <div class="settings-label-text">Where you are signed in</div>
        <div class="settings-label-desc">
          One row per browser that signed in to this account, with the tabs
          it currently has connected nested underneath. Sessions expire on
          their own; signing out removes one immediately.
        </div>
      </div>
      <div class="settings-control">
        <button class="settings-btn settings-btn--secondary settings-btn--small"
                onclick={() => void load()} disabled={busy}>
          {busy ? 'Loading…' : 'Refresh'}
        </button>
      </div>
    </div>

    {#if revokeError}
      <div class="settings-error">{revokeError}</div>
    {/if}
    {#if revokeNote}
      <div class="settings-value">{revokeNote}</div>
    {/if}

    {#if loadError}
      <div class="settings-error">{loadError}</div>
    {:else if !info}
      <div class="settings-empty">Loading your sessions…</div>
    {:else if info.sessions.length === 0}
      <div class="settings-empty">No login sessions on record.</div>
    {:else}
      <div class="settings-sessions">
        <table class="settings-sessions-table">
          <thead>
            <tr>
              <th scope="col">Login date</th>
              <th scope="col">Expires</th>
              <th scope="col">Login IP</th>
              <th scope="col">Login user agent</th>
              <th scope="col" class="settings-sessions-count">Active clients</th>
              <th scope="col" class="settings-sessions-actions"></th>
            </tr>
          </thead>
          {#each info.sessions as s (s.ref)}
            <tbody class:settings-sessions-mine={s.current}>
              <tr class="settings-sessions-session">
                <td>
                  {stamp(s.createdAt)}
                  {#if s.current}<span class="settings-sessions-badge">This browser</span>{/if}
                </td>
                <td>{s.expiresAt ? stamp(s.expiresAt) : 'never'}</td>
                <td class="settings-sessions-ip">{s.clientIp || 'unknown'}</td>
                <td class="settings-sessions-ua" title={s.userAgent}>{ua(s.userAgent)}</td>
                <td class="settings-sessions-count">{clientLabel(s)}</td>
                <td class="settings-sessions-actions">
                  {#if s.current}
                    <span class="settings-label-desc">in use</span>
                  {:else if confirmRef === s.ref}
                    <button class="settings-btn settings-btn--danger settings-btn--small"
                            onclick={() => void revoke(s)} disabled={revokingRef === s.ref}>
                      {revokingRef === s.ref ? 'Revoking…' : 'Confirm'}
                    </button>
                    <button class="settings-btn settings-btn--secondary settings-btn--small"
                            onclick={() => { confirmRef = ''; }}>Cancel</button>
                  {:else}
                    <button class="settings-btn settings-btn--secondary settings-btn--small"
                            onclick={() => { confirmRef = s.ref; revokeError = ''; revokeNote = ''; }}
                    >Revoke</button>
                  {/if}
                </td>
              </tr>
              {#if s.clients.length > 0}
                <tr class="settings-sessions-subhead">
                  <th scope="col" colspan="2">Client start</th>
                  <th scope="col">Client IP</th>
                  <th scope="col">Client user agent</th>
                  <th scope="col"></th>
                  <th scope="col"></th>
                </tr>
                {#each s.clients as c (c.ref)}
                  <tr class="settings-sessions-client">
                    <td>{stamp(c.connectedAt)}</td>
                    <td>{ago(c.connectedAt)}</td>
                    <td class="settings-sessions-ip">{c.clientIp || 'unknown'}</td>
                    <td class="settings-sessions-ua" title={c.userAgent}>{ua(c.userAgent)}</td>
                    <td class="settings-sessions-count">
                      {#if c.current}<span class="settings-sessions-badge">Current</span>{/if}
                    </td>
                    <td class="settings-sessions-actions"></td>
                  </tr>
                {/each}
              {/if}
            </tbody>
          {/each}
        </table>
      </div>
      <div class="settings-label-desc">
        {info.total} session{info.total === 1 ? '' : 's'},
        {info.liveClients} live client{info.liveClients === 1 ? '' : 's'}.
        Clients are the tabs holding a connection to this gateway right now,
        so closing a tab clears its row while the login itself stays valid.
        Revoking a session signs that browser out and closes its tabs;
        end this one with Sign out instead.
      </div>
    {/if}
  </div>
</SettingsSection>
