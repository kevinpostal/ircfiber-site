<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    fetchBouncer, generateBouncerPassword, revokeBouncerPassword, updateBouncerSettings,
    resetBouncerDevice, fetchBouncerClients, disconnectBouncerClient, reconnectNetwork,
    updateBufferPrefs,
    type BouncerInfo, type BouncerClient, type BouncerNetwork, type BouncerDevice,
    type BouncerActivity, type BouncerSettings,
  } from '../stores/api';
  import { saveNetworkIdentity } from '../lib/networkIdentity';
  import { formatShortRelativeTime } from '../lib/utils';
  import SettingsSection from './SettingsSection.svelte';

  let info = $state<BouncerInfo | null>(null);
  let loadError = $state('');
  let error = $state('');
  let busy = $state(false);
  /** Which value was just copied ('password', 'username' or a network id). */
  let copiedKey = $state('');
  let confirmRevoke = $state(false);
  /** Which disclosure is open, keyed 'setup' or 'identity:<networkId>'. */
  let open = $state<Record<string, boolean>>({});

  function toggle(key: string): void {
    open = { ...open, [key]: !open[key] };
  }

  async function load(): Promise<void> {
    busy = true;
    loadError = '';
    try {
      const next = await fetchBouncer();
      info = next;
      playbackInput = String(next.playbackLines);
      cidrInput = next.allowedCidrs.join('\n');
      maxClientsInput = String(next.maxClients);
      awayInput = next.awayMessage;
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
  onDestroy(() => {
    if (clientsTimer) clearInterval(clientsTimer);
    if (settingsTimer) clearTimeout(settingsTimer);
  });

  /** Difference between this browser's clock and the gateway's. */
  let skew = $derived(clientsNow ? Date.now() - clientsNow : 0);

  function ago(ms: number): string {
    if (!ms) return '';
    return `${formatShortRelativeTime(ms + skew)} ago`;
  }

  function onDate(ms: number): string {
    if (!ms) return '';
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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

  // ── Access policy ──────────────────────────────────────────────────
  // One endpoint, one save path: every control sends the keys it owns and
  // adopts what comes back, so a server-side clamp is what the UI shows.
  let playbackInput = $state('');
  let cidrInput = $state('');
  let maxClientsInput = $state('');
  let awayInput = $state('');
  let accessError = $state('');
  let savedKey = $state('');
  let settingsTimer: ReturnType<typeof setTimeout> | null = null;

  async function saveSettings(patch: BouncerSettings, key: string): Promise<void> {
    if (!info) return;
    accessError = '';
    try {
      const stored = await updateBouncerSettings(patch);
      info = {
        ...info,
        playbackLines: stored.playbackLines,
        playbackMax: stored.playbackMax,
        requireTls: stored.requireTls,
        allowedCidrs: stored.allowedCidrs,
        maxClients: stored.maxClients,
        maxClientsCeiling: stored.maxClientsCeiling,
        awayMessage: stored.awayMessage,
      };
      playbackInput = String(stored.playbackLines);
      maxClientsInput = String(stored.maxClients);
      awayInput = stored.awayMessage;
      savedKey = key;
      setTimeout(() => { if (savedKey === key) savedKey = ''; }, 2000);
    } catch (e: unknown) {
      accessError = (e as Error).message || 'Could not save bouncer settings';
    }
  }

  /** Coalesces keystrokes; one in-flight save per burst. */
  function debounceSave(patch: BouncerSettings, key: string): void {
    savedKey = '';
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => { void saveSettings(patch, key); }, 500);
  }

  function onPlaybackInput(e: Event): void {
    playbackInput = (e.currentTarget as HTMLInputElement).value;
    const n = Number.parseInt(playbackInput, 10);
    if (!Number.isFinite(n)) return;
    debounceSave({ playbackLines: n }, 'playback');
  }

  function onMaxClientsInput(e: Event): void {
    maxClientsInput = (e.currentTarget as HTMLInputElement).value;
    const n = Number.parseInt(maxClientsInput, 10);
    if (!Number.isFinite(n)) return;
    debounceSave({ maxClients: n }, 'maxClients');
  }

  function onAwayInput(e: Event): void {
    awayInput = (e.currentTarget as HTMLInputElement).value;
    debounceSave({ awayMessage: awayInput }, 'away');
  }

  function onCidrInput(e: Event): void {
    cidrInput = (e.currentTarget as HTMLTextAreaElement).value;
    const list = cidrInput.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    debounceSave({ allowedCidrs: list }, 'cidrs');
  }

  function onRequireTls(e: Event): void {
    void saveSettings({ requireTls: (e.currentTarget as HTMLInputElement).checked }, 'tls');
  }

  // ── Per-network identity ───────────────────────────────────────────
  let identityDraft = $state<Record<string, { nick: string; ident: string; realName: string }>>({});
  let identityBusy = $state('');
  let identityError = $state<Record<string, string>>({});
  /** Networks whose ident/realname changed and are still connected. */
  let needsReconnect = $state<Record<string, boolean>>({});

  function draftFor(net: BouncerNetwork): { nick: string; ident: string; realName: string } {
    return identityDraft[net.id] ?? { nick: net.nick, ident: net.ident, realName: net.realName };
  }

  function setDraft(net: BouncerNetwork, field: 'nick' | 'ident' | 'realName', value: string): void {
    const cur = draftFor(net);
    identityDraft = { ...identityDraft, [net.id]: { ...cur, [field]: value } };
  }

  async function saveIdentity(net: BouncerNetwork): Promise<void> {
    if (identityBusy) return;
    const draft = draftFor(net);
    identityBusy = net.id;
    identityError = { ...identityError, [net.id]: '' };
    try {
      const res = await saveNetworkIdentity(
        { networkId: net.id, nick: draft.nick, ident: draft.ident, realName: draft.realName },
        { nick: net.nick, ident: net.ident, realName: net.realName },
      );
      needsReconnect = { ...needsReconnect, [net.id]: res.needsReconnect && net.connected };
      await load();
      identityDraft = { ...identityDraft, [net.id]: draft };
    } catch (e: unknown) {
      identityError = { ...identityError, [net.id]: (e as Error).message || 'Could not save identity' };
    } finally {
      identityBusy = '';
    }
  }

  async function reconnect(net: BouncerNetwork): Promise<void> {
    try {
      await reconnectNetwork(net.id);
      needsReconnect = { ...needsReconnect, [net.id]: false };
    } catch (e: unknown) {
      identityError = { ...identityError, [net.id]: (e as Error).message || 'Could not reconnect' };
    }
  }

  /** Clears one channel's persisted detach (the same pref the bouncer writes). */
  async function attachChannel(net: BouncerNetwork, channel: string): Promise<void> {
    try {
      await updateBufferPrefs(net.id, channel, { bncDetached: false });
      await load();
    } catch (e: unknown) {
      identityError = { ...identityError, [net.id]: (e as Error).message || 'Could not attach that channel' };
    }
  }

  // ── Devices ────────────────────────────────────────────────────────
  let resetArm = $state('');
  let resetBusy = $state(false);
  let deviceError = $state('');

  function deviceName(d: BouncerDevice): string {
    return d.anonymous ? `${d.clientId} (no client id)` : d.clientId;
  }

  function deviceCursors(d: BouncerDevice): string {
    return d.networks.map((n) => `${n.networkName}: ${n.cursor}`).join(' · ');
  }

  async function resetDevice(d: BouncerDevice): Promise<void> {
    if (resetBusy) return;
    if (resetArm !== d.id) { resetArm = d.id; return; }
    resetBusy = true;
    deviceError = '';
    try {
      await resetBouncerDevice(d.id);
      resetArm = '';
      await load();
    } catch (e: unknown) {
      deviceError = (e as Error).message || 'Could not reset that device';
    } finally {
      resetBusy = false;
    }
  }

  // ── Activity ───────────────────────────────────────────────────────
  function eventLabel(a: BouncerActivity): string {
    if (a.event === 'attach') return 'attached';
    if (a.event === 'detach') return 'disconnected';
    return 'refused';
  }

  // ── Client setup snippets ──────────────────────────────────────────
  /** Copy-ready lines for the clients that need a per-network login. */
  let snippets = $derived.by(() => {
    if (!info) return [] as { id: string; name: string; line: string }[];
    const host = info.host;
    const port = info.port;
    const user = info.username;
    const slug = info.networks[0]?.slug ?? 'network';
    const pass = info.password ?? '<password>';
    return [
      { id: 'weechat', name: 'WeeChat', line: `/server add ircfiber ${host}/${port} -ssl -password=${user}/${slug}:${pass}` },
      { id: 'irssi', name: 'irssi', line: `/connect -ssl ${host} ${port} ${user}/${slug}:${pass}` },
      { id: 'hexchat', name: 'mIRC / HexChat', line: `${host}/${port}${info.tls ? ' (TLS)' : ''} — password: ${user}/${slug}:${pass}` },
      { id: 'halloy', name: 'Halloy / Goguma', line: `${host}/${port}${info.tls ? ' (TLS)' : ''} — password: ${user}:${pass} (shows every network)` },
    ];
  });

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

  /** `Created 12 Sep 2026 · last used 3m ago from 1.2.3.4` — clauses that
   *  have no value are left out rather than shown as "unknown". */
  let passwordMeta = $derived.by(() => {
    if (!info?.password) return '';
    const parts: string[] = [];
    if (info.passwordCreatedAt) parts.push(`Created ${onDate(info.passwordCreatedAt)}`);
    if (info.passwordLastUsedAt) {
      const from = info.passwordLastIp ? ` from ${info.passwordLastIp}` : '';
      const via = info.passwordLastClient ? ` (${info.passwordLastClient})` : '';
      parts.push(`last used ${ago(info.passwordLastUsedAt)}${from}${via}`);
    } else if (info.passwordCreatedAt) {
      parts.push('never used');
    }
    return parts.join(' · ');
  });
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
          {#if passwordMeta}
            <span class="settings-label-desc" data-testid="bnc-password-meta">{passwordMeta}</span>
          {/if}
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
      <div class="settings-row settings-bouncer-disclosure">
        <button class="settings-bouncer-toggle" aria-expanded={!!open.setup} aria-controls="bnc-setup"
                onclick={() => toggle('setup')}>{open.setup ? '▾' : '▸'} Client setup</button>
      </div>
      {#if open.setup}
        <div id="bnc-setup" class="settings-rows settings-bouncer-nested">
          {#each snippets as s (s.id)}
            <div class="settings-row">
              <div class="settings-label">
                <span class="settings-label-text">{s.name}</span>
                <span class="settings-label-desc settings-bouncer-mono">{s.line}</span>
              </div>
              <div class="settings-control">
                <button class="settings-btn settings-btn--secondary settings-btn--small"
                        onclick={() => copy(s.id, s.line)}>{copiedKey === s.id ? 'Copied' : 'Copy'}</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
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
          <div class="settings-row settings-bouncer-disclosure">
            <button class="settings-bouncer-toggle" aria-expanded={!!open[`identity:${net.id}`]}
                    aria-controls={`bnc-identity-${net.id}`}
                    onclick={() => toggle(`identity:${net.id}`)}>{open[`identity:${net.id}`] ? '▾' : '▸'} Identity</button>
          </div>
          {#if open[`identity:${net.id}`]}
            {@const draft = draftFor(net)}
            <div id={`bnc-identity-${net.id}`} class="settings-rows settings-bouncer-nested">
              <div class="settings-row">
                <div class="settings-label">
                  <label class="settings-label-text" for={`bnc-nick-${net.id}`}>Nick</label>
                </div>
                <div class="settings-control">
                  <input id={`bnc-nick-${net.id}`} class="settings-input settings-bouncer-mono" type="text"
                         value={draft.nick} disabled={net.managed}
                         oninput={(e) => setDraft(net, 'nick', (e.currentTarget as HTMLInputElement).value)} />
                </div>
              </div>
              <div class="settings-row">
                <div class="settings-label">
                  <label class="settings-label-text" for={`bnc-ident-${net.id}`}>Ident</label>
                  <span class="settings-label-desc">The IRC username before the <code>@</code> in your hostmask</span>
                </div>
                <div class="settings-control">
                  <input id={`bnc-ident-${net.id}`} class="settings-input settings-bouncer-mono" type="text"
                         placeholder="defaults to nick" maxlength="10" value={draft.ident} disabled={net.managed}
                         oninput={(e) => setDraft(net, 'ident', (e.currentTarget as HTMLInputElement).value)} />
                </div>
              </div>
              <div class="settings-row">
                <div class="settings-label">
                  <label class="settings-label-text" for={`bnc-realname-${net.id}`}>Full name</label>
                </div>
                <div class="settings-control">
                  <input id={`bnc-realname-${net.id}`} class="settings-input" type="text"
                         value={draft.realName} disabled={net.managed}
                         oninput={(e) => setDraft(net, 'realName', (e.currentTarget as HTMLInputElement).value)} />
                </div>
              </div>
              <div class="settings-row">
                <div class="settings-label">
                  {#if net.managed}
                    <span class="settings-label-desc">This network is managed by IRC Fiber — its identity tracks your account.</span>
                  {:else}
                    <span class="settings-label-desc">Ident and full name apply when the connection is re-established.</span>
                  {/if}
                  {#if identityError[net.id]}
                    <span class="settings-error">{identityError[net.id]}</span>
                  {/if}
                </div>
                <div class="settings-control settings-bouncer-copy-row">
                  <button class="settings-btn settings-btn--small" disabled={net.managed || identityBusy === net.id}
                          onclick={() => void saveIdentity(net)}>Save</button>
                  {#if needsReconnect[net.id]}
                    <button class="settings-btn settings-btn--secondary settings-btn--small"
                            onclick={() => void reconnect(net)}>Reconnect now</button>
                  {/if}
                </div>
              </div>
            </div>
          {/if}
          {#if net.detached.length > 0}
            <div class="settings-rows settings-bouncer-nested">
              {#each net.detached as chan (chan)}
                <div class="settings-row" data-testid="bnc-detached-row">
                  <div class="settings-label">
                    <span class="settings-label-text settings-bouncer-mono">{chan}</span>
                    <span class="settings-label-desc">Detached — still joined upstream, backlog kept</span>
                  </div>
                  <div class="settings-control">
                    <button class="settings-btn settings-btn--secondary settings-btn--small"
                            onclick={() => void attachChannel(net, chan)}>Attach</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
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

  <SettingsSection heading="Devices">
    <div class="settings-rows">
      {#if clientsError}
        <div class="settings-error">{clientsError}</div>
      {/if}
      {#if info.password}
        {#if clients.length === 0}
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
      {:else}
        <div class="settings-empty">Generate a bouncer password to connect a client.</div>
      {/if}
      {#if deviceError}
        <div class="settings-error">{deviceError}</div>
      {/if}
      {#each info.devices as d (d.id)}
        <div class="settings-row" data-testid="bnc-device-row">
          <div class="settings-label">
            <span class="settings-label-text settings-bouncer-mono">{deviceName(d)}{#if d.online} · online{/if}</span>
            <span class="settings-label-desc settings-bouncer-mono">{deviceCursors(d)}</span>
          </div>
          <div class="settings-control">
            <button class="settings-btn settings-btn--secondary settings-btn--small" disabled={resetBusy}
                    onclick={() => void resetDevice(d)}>{resetArm === d.id ? 'Click again to reset' : 'Reset backlog'}</button>
          </div>
        </div>
      {/each}
      <div class="settings-label-desc">
        A device with a client id replays only what it missed. Resetting makes its next connection replay the history buffer instead.
      </div>
    </div>
  </SettingsSection>

  <SettingsSection heading="Access">
    <div class="settings-rows">
      <div class="settings-row">
        <div class="settings-label">
          <span class="settings-label-text">Require TLS</span>
          <span class="settings-label-desc">Refuse bouncer clients that connect without encryption</span>
        </div>
        <div class="settings-control">
          <label class="toggle-switch">
            <input type="checkbox" checked={info.requireTls} aria-label="Require TLS" onchange={onRequireTls} />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <label class="settings-label-text" for="bnc-cidrs">Allowed addresses</label>
          <span class="settings-label-desc" id="bnc-cidrs-help">
            One IP or CIDR range per line (<code>203.0.113.9</code>, <code>10.0.0.0/8</code>, <code>2001:db8::/32</code>). Empty allows any address.
          </span>
        </div>
        <div class="settings-control">
          <textarea id="bnc-cidrs" class="settings-textarea settings-bouncer-mono" rows="3"
                    aria-describedby="bnc-cidrs-help" value={cidrInput} oninput={onCidrInput}></textarea>
          {#if savedKey === 'cidrs'}<span class="settings-value">saved</span>{/if}
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <label class="settings-label-text" for="bnc-max-clients">Max connected clients</label>
          <span class="settings-label-desc">0 = unlimited; at most {info.maxClientsCeiling}</span>
        </div>
        <div class="settings-control settings-bouncer-copy-row">
          <input id="bnc-max-clients" class="settings-input settings-bouncer-mono settings-bouncer-number" type="number"
                 min="0" max={info.maxClientsCeiling} step="1" value={maxClientsInput} oninput={onMaxClientsInput} />
          {#if savedKey === 'maxClients'}<span class="settings-value">saved</span>{/if}
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <label class="settings-label-text" for="bnc-away">Away message when nothing is connected</label>
          <span class="settings-label-desc">Sent upstream when your last client detaches, cleared when one attaches. Empty disables it.</span>
        </div>
        <div class="settings-control settings-bouncer-copy-row">
          <input id="bnc-away" class="settings-input" type="text" maxlength="200"
                 placeholder="off" value={awayInput} oninput={onAwayInput} />
          {#if savedKey === 'away'}<span class="settings-value">saved</span>{/if}
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <label class="settings-label-text" for="bnc-playback">History on connect</label>
          <span class="settings-label-desc" id="bnc-playback-help">
            Lines per channel replayed to clients that can't fetch history themselves (WeeChat, irssi, mIRC, HexChat). Clients that support IRCv3 <code>CHATHISTORY</code> (Halloy, Goguma, gamja, The Lounge) scroll back on demand instead. 0 disables; max {info.playbackMax}.
          </span>
        </div>
        <div class="settings-control settings-bouncer-copy-row">
          <input id="bnc-playback" class="settings-input settings-bouncer-mono settings-bouncer-number" type="number" min="0" max={info.playbackMax} step="10"
                 value={playbackInput} oninput={onPlaybackInput} aria-describedby="bnc-playback-help" />
          {#if savedKey === 'playback'}<span class="settings-value">saved</span>{/if}
        </div>
      </div>
      {#if accessError}
        <div class="settings-error">{accessError}</div>
      {/if}
    </div>
  </SettingsSection>

  <SettingsSection heading="Activity">
    <div class="settings-rows">
      {#if info.activity.length === 0}
        <div class="settings-empty">No bouncer activity yet.</div>
      {:else}
        {#each info.activity as a, i (`${a.t}-${i}`)}
          <div class="settings-row" data-testid="bnc-activity-row">
            <div class="settings-label">
              <span class="settings-label-text">{eventLabel(a)}{#if a.reason} · {a.reason}{/if}</span>
              <span class="settings-label-desc settings-bouncer-mono">
                {a.ip || 'unknown address'}{#if a.clientId} · {a.clientId}{/if}{#if a.networkName} · {a.networkName}{/if}{#if a.tls} · TLS{/if}
              </span>
            </div>
            <div class="settings-control">
              <span class="settings-value">{ago(a.t)}</span>
            </div>
          </div>
        {/each}
      {/if}
      <div class="settings-label-desc">
        The last 20 bouncer events on your account, kept for 90 days.
      </div>
    </div>
  </SettingsSection>
{/if}

<style>
  .settings-bouncer-mono { font-family: var(--font-mono); font-size: 12px; }
  .settings-bouncer-copy-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .settings-bouncer-copy-row .settings-input { flex: 1; min-width: 160px; }
  .settings-bouncer-number { width: 90px; flex: 0 0 auto; }
  .settings-bouncer-disclosure { padding-top: 0; }
  .settings-bouncer-nested { padding: 0 0 4px 12px; border-left: 1px solid #2c2f35; }
  .settings-bouncer-toggle {
    background: none;
    border: 0;
    padding: 0;
    color: #8b949e;
    font-size: 11px;
    cursor: pointer;
  }
  .settings-bouncer-toggle:hover { color: #c9d1d9; }
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
