<script lang="ts">
  import { ircState } from '../stores/ircStore.svelte';
  import { addNetwork, updateNetwork } from '../stores/api';

  interface Props {
    mode: 'add' | 'edit';
    networkId: string | null;
    onClose: () => void;
    onAddNetwork?: (...args: any[]) => any;
    onUpdateNetwork?: (...args: any[]) => any;
  }
  let { mode, networkId, onClose, onAddNetwork = addNetwork, onUpdateNetwork = updateNetwork }: Props = $props();

  const existing = $derived(
    mode === 'edit' && networkId
      ? ircState.networks.find(n => n.networkId === networkId)
      : null
  );

  let name = $state('');
  let host = $state('');
  let port = $state(6697);
  let tls = $state('enabled');
  let verifyTls = $state(true);
  let nick = $state('');
  let realName = $state('');
  let autoJoinChannels = $state('');
  let nspass = $state('');
  let commands = $state('');
  let error = $state('');

  $effect(() => {
    if (existing) {
      name = existing.name;
      host = existing.host;
      port = existing.port;
      tls = existing.tls;
      verifyTls = existing.verifyTls;
      nick = existing.nick;
      realName = existing.realName;
    } else if (mode === 'add') {
      name = '';
      host = '';
      port = 6697;
      tls = 'enabled';
      verifyTls = true;
      nick = '';
      realName = '';
      autoJoinChannels = '';
      nspass = '';
      commands = '';
    }
  });

  async function handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    error = '';
    try {
      if (mode === 'add') {
        await onAddNetwork({ name, host, port, tls, verifyTls, nick, realName, autoJoinChannels, nspass, commands });
        onClose();
      } else if (networkId) {
        await onUpdateNetwork(networkId, { name, host, port, tls, verifyTls, nick, realName });
        onClose();
      }
    } catch (e: unknown) {
      const err = e as Error;
      error = err.message || 'Failed to save network';
    }
  }
</script>

<div class="modal mainContainer" style="display: block;">
  <h2 class="bufferHead">{mode === 'add' ? 'Join a new network' : 'Edit network'}</h2>
  <div class="overlaycontents">
    <form class="addNetworkForm" onsubmit={handleSubmit}>
      <p class="form">
        <label for="add-network-name">Network name</label>
        <br />
        <input id="add-network-name" class="input" type="text" bind:value={name} placeholder="e.g. Libera" required />
      </p>
      <table class="form addNetworkCells" cellpadding="0" cellspacing="0">
        <tbody>
          <tr>
            <th class="hostname"><label for="add-network-host">Hostname</label></th>
            <th class="port"><label for="add-network-port">Port</label></th>
            <th class="ssl"></th>
          </tr>
          <tr>
            <td class="hostname">
              <input id="add-network-host" class="input" type="text" bind:value={host} placeholder="e.g. irc.libera.chat" required />
            </td>
            <td class="port">
              <input id="add-network-port" class="input" type="number" bind:value={port} required />
            </td>
            <td class="ssl">
              <select id="add-network-tls" class="input" bind:value={tls}>
                <option value="enabled">TLS Enabled</option>
                <option value="disabled">TLS Disabled</option>
                <option value="required">TLS Required</option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>
      <h2 class="addNetworkHeading">Your identity</h2>
      <table class="form addNetworkCells" cellpadding="0" cellspacing="0">
        <tbody>
          <tr>
            <th class="nickname"><label for="add-network-nick">Nickname</label></th>
            <th class="realname"><label for="add-network-realname">Full name (optional)</label></th>
          </tr>
          <tr>
            <td class="nickname">
              <input id="add-network-nick" class="input" type="text" bind:value={nick} placeholder="Nick" required />
            </td>
            <td class="realname">
              <input id="add-network-realname" class="input" type="text" bind:value={realName} placeholder="optional" />
            </td>
          </tr>
        </tbody>
      </table>
      {#if mode === 'add'}
        <table class="form addNetworkCells" cellpadding="0" cellspacing="0">
          <tbody>
            <tr>
              <th class="channels optional">
                <label for="add-network-channels">Channels to join <small>— comma separated</small></label>
              </th>
            </tr>
            <tr>
              <td class="channels optional">
                <input id="add-network-channels" class="input" type="text" bind:value={autoJoinChannels} placeholder="e.g. #chat, #feedback" />
              </td>
            </tr>
          </tbody>
        </table>
        <h2 class="addNetworkHeading">Advanced options</h2>
        <table class="form addNetworkCells" cellpadding="0" cellspacing="0">
          <tbody>
            <tr>
              <th class="verifytls optional">
                <label for="add-network-verifytls">
                  <input id="add-network-verifytls" type="checkbox" bind:checked={verifyTls} />
                  Verify TLS certificate
                  <small>— uncheck for self-signed certs</small>
                </label>
              </th>
            </tr>
            <tr>
              <th class="nspass optional">
                <label for="add-network-nspass">NickServ password <small>— if the server supports it</small></label>
              </th>
            </tr>
            <tr>
              <td class="nspass optional">
                <input id="add-network-nspass" class="input" type="password" bind:value={nspass} autocomplete="new-password" />
              </td>
            </tr>
            <tr>
              <th class="joincommands optional">
                <label for="add-network-commands">Commands to run on connect <small>— one per line</small></label>
              </th>
            </tr>
            <tr>
              <td class="joincommands optional">
                <textarea id="add-network-commands" class="input" rows="4" placeholder="AUTH <user> <password> etc..." bind:value={commands}></textarea>
              </td>
            </tr>
          </tbody>
        </table>
      {/if}
      <p class="userError" tabindex="-1">{error}</p>
      <p class="form addNetworkSubmit">
        <button class="action" type="submit">
          <span>{mode === 'add' ? 'Join network' : 'Save changes'}</span>
        </button>
      </p>
    </form>
  </div>
  <div class="overlaycontainer">
    <button class="close" type="button" onclick={onClose}>
      <span>&times;</span>
    </button>
  </div>
</div>
