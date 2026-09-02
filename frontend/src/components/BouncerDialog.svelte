<script lang="ts">
  import { onMount } from 'svelte';
  import { ircState } from '../stores/ircStore.svelte';
  import { fetchBouncer, generateBouncerPassword, revokeBouncerPassword, updateBncPlaybackLines, type BouncerInfo } from '../stores/api';

  interface Props {
    networkId: string | null;
    onClose: () => void;
  }
  let { networkId, onClose }: Props = $props();

  let info = $state<BouncerInfo | null>(null);
  let error: string = $state('');
  let busy: boolean = $state(false);
  let copied: boolean = $state(false);
  let confirmRevoke: boolean = $state(false);
  let playbackInput: string = $state('');
  let playbackSaved: boolean = $state(false);
  let playbackTimer: ReturnType<typeof setTimeout> | null = null;

  const network = $derived(ircState.networks.find(n => n.networkId === networkId) ?? null);
  const networkLabel = $derived(network ? `${network.name} (${network.host}:${network.port})` : '');
  const nick = $derived(network ? (network.currentNick || network.nick) : '');
  const token = $derived(info?.password?.startsWith('bnc:') ? info.password.slice(4) : '');

  onMount(() => { void load(); });

  async function load(): Promise<void> {
    if (!networkId) return;
    error = '';
    try {
      info = await fetchBouncer(networkId);
      playbackInput = String(info.playbackLines);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not load bouncer settings';
    }
  }

  async function generate(): Promise<void> {
    if (!networkId || busy) return;
    busy = true;
    error = '';
    confirmRevoke = false;
    try {
      info = await generateBouncerPassword(networkId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not generate bouncer password';
    } finally {
      busy = false;
    }
  }

  async function revoke(): Promise<void> {
    if (!networkId || busy) return;
    if (!confirmRevoke) { confirmRevoke = true; return; }
    busy = true;
    error = '';
    try {
      await revokeBouncerPassword(networkId);
      confirmRevoke = false;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not revoke bouncer password';
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
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not save playback setting';
    }
  }

  function copyPassword(): void {
    const value = info?.password;
    if (!value) return;
    const done = () => {
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
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

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }
</script>

<div class="overlay_prompt overlay_class_bouncer_prompt" role="presentation" onkeydown={onKeydown}>
  <div class="overlayHead">
    <span class="buffer bufferLink">{networkLabel}</span>
  </div>
  <div class="overlay">
    {#if !info && !error}
      <p class="content">Loading…</p>
    {:else if info && !info.enabled}
      <p class="content">The bouncer isn't enabled on this server.</p>
      <p class="buttons">
        <button type="button" class="close" onclick={onClose}><span>Close</span></button>
      </p>
    {:else}
      <p class="content">Connect a 3rd-party IRC client to this connection through the IRC Fiber bouncer.</p>
      {#if info}
        <dl class="bouncer-details">
          <dt>Server</dt>
          <dd class="monospace">{info.host}</dd>
          <dt>Port</dt>
          <dd class="monospace">{info.port}{#if info.tls} <span class="muted">(TLS)</span>{/if}</dd>
          <dt>Nick</dt>
          <dd class="monospace">{nick}</dd>
          <dt>Server password</dt>
          <dd>
            {#if info.password}
              <span class="password-row">
                <input class="input monospace" type="text" readonly value={info.password} aria-label="Bouncer server password" onfocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
                <button type="button" class="copy" onclick={copyPassword}>{copied ? 'Copied' : 'Copy'}</button>
              </span>
            {:else}
              <span class="muted">Generate a unique server password to connect with a 3rd-party client.</span>
            {/if}
          </dd>
        </dl>
        {#if info.password}
          <p class="content help">
            To replay missed messages when your client reconnects, include a clientid in the password:
            <code>bnc@laptop:{token}</code> — use a different clientid for each client (no spaces).
          </p>
        {/if}
        <div class="playback">
          <label for="bnc-playback">History on connect</label>
          <span class="playback-row">
            <input id="bnc-playback" class="input monospace" type="number" min="0" max={info.playbackMax} step="10" value={playbackInput} oninput={onPlaybackInput} aria-describedby="bnc-playback-help" />
            <span class="muted">lines per channel{#if playbackSaved} · saved{/if}</span>
          </span>
          <p id="bnc-playback-help" class="content help">
            Replayed to clients that can't fetch history themselves (WeeChat, irssi, mIRC, HexChat). Clients that support IRCv3 <code>CHATHISTORY</code> (Halloy, Goguma, gamja, The Lounge) skip this and scroll back on demand. 0 disables; max {info.playbackMax}.
          </p>
        </div>
      {/if}
      {#if error}
        <p class="error">{error}</p>
      {/if}
      <p class="buttons">
        {#if info?.password}
          <button type="button" class="confirm delete" disabled={busy} onclick={revoke}><span>{confirmRevoke ? 'Click again to revoke' : 'Revoke'}</span></button>
          <button type="button" class="confirm action" disabled={busy} onclick={generate}><span>Regenerate</span></button>
        {:else}
          <button type="button" class="confirm action" disabled={busy} onclick={generate}><span>Generate password</span></button>
        {/if}
        <button type="button" class="close" onclick={onClose}><span>Close</span></button>
      </p>
      <p class="content note">This password grants full access to this connection. Revoking or regenerating it disconnects any client using it.</p>
    {/if}
  </div>
</div>

<style>
  .bouncer-details {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 8px 16px;
    margin: 0 0 12px 0;
    font-size: 0.875rem;
  }
  .bouncer-details dt {
    color: #8b949e;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    align-self: center;
  }
  .bouncer-details dd {
    margin: 0;
    color: #d9d9d9;
    word-break: break-all;
  }
  .monospace { font-family: var(--font-mono); font-size: 12px; }
  .muted { color: #8b949e; font-family: inherit; }
  .password-row { display: flex; gap: 6px; align-items: center; }
  .password-row .input {
    flex: 1;
    min-width: 0;
    background: #0d1117;
    color: #d9d9d9;
    border: 1px solid #2c2f35;
    border-radius: 4px;
    padding: 6px 8px;
  }
  .password-row .copy {
    background: transparent;
    color: #b6b6b6;
    border: 1px solid #2c2f35;
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 0.8125rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .password-row .copy:hover { background: #2c2f35; color: #fff; }
  .help code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: #0d1117;
    border: 1px solid #2c2f35;
    border-radius: 3px;
    padding: 1px 4px;
    word-break: break-all;
  }
  .playback { margin: 4px 0 10px 0; font-size: 0.875rem; }
  .playback label {
    display: block;
    color: #8b949e;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
  }
  .playback-row { display: flex; gap: 8px; align-items: center; }
  .playback-row .input {
    width: 90px;
    background: #0d1117;
    color: #d9d9d9;
    border: 1px solid #2c2f35;
    border-radius: 4px;
    padding: 6px 8px;
  }
  .playback .help { margin: 6px 0 0 0; }
  .error { color: #f85149; font-size: 0.875rem; margin: 0 0 8px 0; }
  .note { color: #8b949e; font-size: 0.8125rem; margin: 10px 0 0 0; }
  .buttons button:disabled { opacity: 0.6; cursor: default; }
</style>
