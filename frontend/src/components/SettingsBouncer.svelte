<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fetchBouncer, generateBouncerPassword, revokeBouncerPassword, updateBncPlaybackLines, fetchBouncerClients, disconnectBouncerClient, type BouncerInfo, type BouncerClient } from '../stores/api';
  import { formatShortRelativeTime } from '../lib/utils';
  import SettingsSection from './SettingsSection.svelte';

  let info = $state<BouncerInfo | null>(null);
  let loadError = $state('');
  let error = $state('');
  let busy = $state(false);
  /** Which value was just copied ('password', 'username' or a network id). */
  let copiedKey = $state('');
  let confirmRevoke = $state(false);
  let playbackInput = $state('');
  let playbackSaved = $state(false);
  let playbackTimer: ReturnType<typeof setTimeout> | null = null;

  async function load(): Promise<void> {
    busy = true;
    loadError = '';
    try {
      info = await fetchBouncer();
      playbackInput = String(info.playbackLines);
      void loadClients();
    } catch (e: unknown) {
      loadError = (e as Error).message || 'Could not load bouncer settings';
    } finally {
      busy = false;
    }
  }

  // ── Active sessions (own attached BNC clients) ──────────────────────
  // Same presence records the admin Bouncer page reads, scoped to the
  // caller by GET /api/me/bouncer/clients. Polled on the presence refresh
  // cadence (15 s) so a row disappears at most a minute after a client
  // vanishes without a clean QUIT.
  let clients = $state<BouncerClient[]>([]);
  let clientsNow = $state(0);
  let clientsError = $state('');
  /** sid of the row whose Disconnect button is armed, then in flight. */
  let disconnectArm = $state('');
  let disconnectBusy = $state(false);

  async function loadClients(): Promise<void> {
    if (!info?.password) { clients = []; return; }
    try {
      const res = await fetchBouncerClients();
      clients = res.clients;
      clientsNow = res.now;
      clientsError = '';
    } catch (e: unknown) {
      clientsError = (e as Error).message || 'Could not load active sessions';
    }
  }

  let clientsTimer: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    void load();
    clientsTimer = setInterval(() => { void loadClients(); }, 15_000);
  });
  onDestroy(() => { if (clientsTimer) clearInterval(clientsTimer); });

  /** Difference between this browser's clock and the gateway's. */
  let skew = $derived(clientsNow ? Date.now() - clientsNow : 0);

  function ago(ms: number): string {
    if (!ms) return '';
    return `${formatShortRelativeTime(ms + skew)} ago`;
  }

  function clientName(c: BouncerClient): string {
    if (c.clientId) return c.clientId;
    if (c.nick) return c.nick;
    return 'anonymous';
  }

  async function disconnect(c: BouncerClient): Promise<void> {
    if (disconnectBusy) return;
    if (disconnectArm !== c.sid) { disconnectArm = c.sid; return; }
    disconnectBusy = true;
    try {
      await disconnectBouncerClient(c.sid);
      disconnectArm = '';
      await loadClients();
    } catch (e: unknown) {
      clientsError = (e as Error).message || 'Could not disconnect that session';
    } finally {
      disconnectBusy = false;
    }
  }

  async function generate(): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      info = await generateBouncerPassword();
      disconnectArm = '';
      void loadClients();
    } catch (e: unknown) {
      error = (e as Error).message || 'Could not generate bouncer password';
    } finally {
      busy = false;
    }
  }

  async function revoke(): Promise<void> {
    if (busy) return;
    if (!confirmRevoke) { confirmRevoke = true; return; }
    busy = true;
    error = '';
    try {
      await revokeBouncerPassword();
      confirmRevoke = false;
      disconnectArm = '';
      await load();
    } catch (e: unknown) {
      error = (e as Error).message || 'Could not revoke bouncer password';
    } finally {
      busy = false;
    }
  }

  // Debounced save of the playback size; the server clamps to [0, playbackMax].
  function onPlaybackInput(e: Event): void {
    playbackInput = (e.currentTarget as HTMLInputElement).value;
    playbackSaved = false;
    if (playbackTimer) clearTimeout(playbackTimer);
    playbackTimer = setTimeout(() => { void savePlayback(); }, 500);
  }

  async function savePlayback(): Promise<void> {
    if (!info) return;
    const n = Number.parseInt(playbackInput, 10);
    if (!Number.isFinite(n)) return;
    try {
      const saved = await updateBncPlaybackLines(Math.max(0, Math.min(info.playbackMax, n)));
      info = { ...info, playbackLines: saved };
      playbackInput = String(saved);
      playbackSaved = true;
    } catch (e: unknown) {
      error = (e as Error).message || 'Could not save playback setting';
    }
  }

  function copy(key: string, value: string): void {
    if (!value) return;
    const done = () => {
      copiedKey = key;
      setTimeout(() => { if (copiedKey === key) copiedKey = ''; }, 2000);
    };
    navigator.clipboard.writeText(value).then(done).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    });
  }

  function selectAll(e: Event): void {
    (e.currentTarget as HTMLInputElement).select();
  }

  </script>

<SettingsSection heading="Bouncer">
  <div class="settings-rows">
    {#if loadError}
      <div class="settings-error">{loadError}</div>
    {:else if !info}
      <div class="settings-empty">Loading bouncer settings…</div>
    {:else if !info.enabled}
      <div class="settings-empty">The bouncer isn't enabled on this server.</div>
    {:else}
      <div class="settings-row">
        <div class="settings-label">
          <span class="settings-label-text">Server</span>
          <span class="settings-label-desc">Point your IRC client at this host</span>
        </div>
        <div class="settings-control">
          <span class="settings-value settings-bouncer-mono">{info.host}</span>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <span class="settings-label-text">Port</span>
        </div>
        <div class="settings-control">
          <span class="settings-value settings-bouncer-mono">{info.port}{#if info.tls} · TLS{/if}</span>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <span class="settings-label-text">Username</span>
          <span class="settings-label-desc">Your IRC Fiber username; one login reaches every network on your account</span>
        </div>
        <div class="settings-control settings-bouncer-copy-row">
          <input class="settings-input settings-bouncer-mono" type="text" readonly value={info.username}
                 aria-label="Bouncer username" onfocus={selectAll} />
          <button class="settings-btn settings-btn--secondary settings-btn--small"
                  onclick={() => copy('username', info?.username ?? '')}>{copiedKey === 'username' ? 'Copied' : 'Copy'}</button>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <span class="settings-label-text">Password</span>
          <span class="settings-label-desc">
            This password grants access to every network on your account. Revoking or regenerating it disconnects any client using it.
          </span>
        </div>
        <div class="settings-control settings-bouncer-copy-row">
          {#if info.password}
            <input class="settings-input settings-bouncer-mono" type="text" readonly value={info.password}
                   aria-label="Bouncer password" onfocus={selectAll} />
            <button class="settings-btn settings-btn--secondary settings-btn--small"
                    onclick={() => copy('password', info?.password ?? '')}>{copiedKey === 'password' ? 'Copied' : 'Copy'}</button>
            <button class="settings-btn settings-btn--secondary settings-btn--small" disabled={busy}
                    onclick={() => void generate()}>Regenerate</button>
            <button class="settings-btn settings-btn--danger settings-btn--small" disabled={busy}
                    onclick={() => void revoke()}>{confirmRevoke ? 'Click again to revoke' : 'Revoke'}</button>
          {:else}
            <button class="settings-btn settings-btn--small" disabled={busy}
                    onclick={() => void generate()}>Generate password</button>
          {/if}
        </div>
      </div>
      {#if error}
        <div class="settings-error">{error}</div>
      {/if}
    {/if}
  </div>
</SettingsSection>

{#if info?.enabled}
  <SettingsSection heading="Networks">
    <div class="settings-rows">
      {#if info.networks.length === 0}
        <div class="settings-empty">Add a network first.</div>
      {:else}
        {#each info.networks as net (net.id)}
          <div class="settings-row">
            <div class="settings-label">
              <span class="settings-label-text">{net.name}</span>
              <span class="settings-label-desc settings-bouncer-mono">{net.host}:{net.port}{#if net.connected} · connected{/if}</span>
            </div>
            <div class="settings-control settings-bouncer-copy-row">
              <input class="settings-input settings-bouncer-mono" type="text" readonly value={`${info.username}/${net.slug}`}
                     aria-label={`Bouncer username for ${net.name}`} onfocus={selectAll} />
              <button class="settings-btn settings-btn--secondary settings-btn--small"
                      onclick={() => copy(net.id, `${info?.username ?? ''}/${net.slug}`)}>{copiedKey === net.id ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        {/each}
      {/if}
      <div class="settings-label-desc">
        Clients that support bouncer networks (Goguma, senpai, gamja, Halloy) sign in with just your username and show every network.
        Other clients (WeeChat, irssi, mIRC, HexChat) connect once per network using the username above.
        Add <code>@&lt;clientid&gt;</code> (e.g. <code>{info.username}/{info.networks[0]?.slug ?? 'network'}@laptop</code>)
        so each client replays only what it missed.
      </div>
    </div>
  </SettingsSection>

  {#if info.password}
  <SettingsSection heading="Active sessions">
    <div class="settings-rows">
      {#if clientsError}
        <div class="settings-error">{clientsError}</div>
      {:else if clients.length === 0}
        <div class="settings-empty">No clients connected through the bouncer right now.</div>
      {:else}
        {#each clients as c (c.sid)}
          {@const lastMs = Math.max(c.lastRecvMs, c.lastSendMs)}
          <div class="settings-row" data-testid="bnc-session-row">
            <div class="settings-label">
              <span class="settings-label-text settings-bouncer-mono">{clientName(c)}</span>
              <span class="settings-label-desc settings-bouncer-mono">{c.networkName || 'bouncer'} · as {c.nick || '…'} · {c.peer || 'unknown peer'}{#if c.tls} · TLS{/if}</span>
              <span class="settings-label-desc">connected {ago(c.attachedAt)}{#if lastMs} · active {ago(lastMs)}{/if}</span>
            </div>
            <div class="settings-control">
              <button class="settings-btn settings-btn--danger settings-btn--small" disabled={disconnectBusy}
                      onclick={() => void disconnect(c)}>{disconnectArm === c.sid ? 'Click again to disconnect' : 'Disconnect'}</button>
            </div>
          </div>
        {/each}
      {/if}
      <div class="settings-label-desc">
        Every IRC client currently attached with your bouncer password — the same live list the admin Bouncer page shows, scoped to your account. Disconnecting drops that client; it can reconnect immediately with the same password.
      </div>
    </div>
  </SettingsSection>
  {/if}

  <SettingsSection heading="History on connect">
    <div class="settings-rows">
      <div class="settings-row">
        <div class="settings-label">
          <label class="settings-label-text" for="bnc-playback">Lines per channel</label>
          <span class="settings-label-desc" id="bnc-playback-help">
            Replayed to clients that can't fetch history themselves (WeeChat, irssi, mIRC, HexChat). Clients that support IRCv3 <code>CHATHISTORY</code> (Halloy, Goguma, gamja, The Lounge) skip this and scroll back on demand. 0 disables; max {info.playbackMax}.
          </span>
        </div>
        <div class="settings-control settings-bouncer-copy-row">
          <input id="bnc-playback" class="settings-input settings-bouncer-mono settings-bouncer-number" type="number" min="0" max={info.playbackMax} step="10"
                 value={playbackInput} oninput={onPlaybackInput} aria-describedby="bnc-playback-help" />
          {#if playbackSaved}<span class="settings-value">saved</span>{/if}
        </div>
      </div>
    </div>
  </SettingsSection>
{/if}

<style>
  .settings-bouncer-mono { font-family: var(--font-mono); font-size: 12px; }
  .settings-bouncer-copy-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .settings-bouncer-copy-row .settings-input { flex: 1; min-width: 160px; }
  .settings-bouncer-number { width: 90px; flex: 0 0 auto; }
  code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: #0d1117;
    border: 1px solid #2c2f35;
    border-radius: 3px;
    padding: 1px 4px;
    word-break: break-all;
  }
</style>
