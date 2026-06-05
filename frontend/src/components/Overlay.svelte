<script lang="ts">
  import { ircState, setActiveBuffer } from '../stores/ircStore.svelte';
  import { sendRaw } from '../stores/wsConnection';
  import { updateRoute } from '../lib/routing';
  import type { WhoisData, BanEntry, ChannelDeleteConfirmData } from '../types';

  function close(): void {
    ircState.overlay.type = null;
    ircState.overlay.data = null;
  }

  function confirmDelete(data: ChannelDeleteConfirmData): void {
    const { networkId, bufferName } = data;
    const net = ircState.networks.find(n => n.networkId === networkId);
    if (net) {
      sendRaw(networkId, 'PART ' + bufferName);
      const channels = net.buffers.filter(b => b.name !== '_server' && b.isJoined !== false);
      const delIdx = channels.findIndex(b => b.name === bufferName);
      const idx = net.buffers.findIndex(b => b.name === bufferName);
      if (idx >= 0) net.buffers.splice(idx, 1);
      if (delIdx > 0) {
        setActiveBuffer(networkId, channels[delIdx - 1].name);
        updateRoute(networkId, channels[delIdx - 1].name);
      } else {
        setActiveBuffer(networkId, '_server');
        updateRoute(networkId, '_server');
      }
    }
    close();
  }
</script>

{#if ircState.overlay.type}
  <div class="overlay-backdrop" onclick={close} role="presentation"></div>
  <div class="overlay-panel" class:centered={ircState.overlay.type === 'channel_delete_confirm'} role="dialog" aria-modal="true">
    <button class="overlay-close" class:hidden={ircState.overlay.type === 'channel_delete_confirm'} onclick={close} aria-label="Close">&times;</button>

    {#if ircState.overlay.type === 'whois' && ircState.overlay.data}
      {@const w = ircState.overlay.data as WhoisData}
      <h2>WHOIS: {w.nick}</h2>
      <dl class="whois-info">
        <dt>User</dt><dd>{w.user}@{w.host}</dd>
        <dt>Real name</dt><dd>{w.realname}</dd>
        <dt>Server</dt><dd>{w.server} ({w.serverInfo})</dd>
        {#if w.account}<dt>Account</dt><dd>{w.account}</dd>{/if}
        {#if w.channels && w.channels.length > 0}<dt>Channels</dt><dd>{w.channels.join(' ')}</dd>{/if}
        {#if w.idle > 0}<dt>Idle</dt><dd>{w.idle} seconds</dd>{/if}
        {#if w.secure}<dt>Secure</dt><dd>Yes (TLS)</dd>{/if}
        {#if w.away}<dt>Away</dt><dd>{w.away}</dd>{/if}
        {#if w.signon > 0}
          <dt>Signed on</dt><dd>{new Date(w.signon * 1000).toLocaleString()}</dd>
        {/if}
      </dl>
    {:else if ircState.overlay.type === 'banlist' && ircState.overlay.data}
      {@const bans = ircState.overlay.data as BanEntry[]}
      <h2>Ban List ({bans.length})</h2>
      {#if bans.length === 0}
        <p>No bans set.</p>
      {:else}
        <table class="banlist-table">
          <thead><tr><th>Mask</th><th>Set by</th><th>Date</th></tr></thead>
          <tbody>
            {#each bans as ban}
              <tr>
                <td><code>{ban.mask}</code></td>
                <td>{ban.setBy}</td>
                <td>{new Date(ban.setAt * 1000).toLocaleString()}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else if ircState.overlay.type === 'channel_delete_confirm' && ircState.overlay.data}
      {@const d = ircState.overlay.data as ChannelDeleteConfirmData}
      <div class="overlay_prompt overlay_class_channel_delete_confirm">
        <div class="overlayHead">
          <span class="buffer bufferLink">{d.networkName} ({d.networkHost})</span>
        </div>
        <div class="overlay">
          <p class="content">Are you sure you want to delete your history for {d.bufferName}</p>
          <p class="buttons">
            <button class="confirm delete" onclick={() => confirmDelete(d)}><span>OK</span></button>
            <button type="button" class="close" onclick={close}><span>Cancel</span></button>
          </p>
        </div>
      </div>
    {/if}
  </div>
{/if}
