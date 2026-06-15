<script lang="ts">
  import { ircState, setActiveBuffer } from '../stores/ircStore.svelte';
  import { addNetwork, updateNetwork } from '../stores/api';
  import { updateRoute } from '../lib/routing';

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
  let tls = $state<'enabled' | 'disabled' | 'required'>('enabled');
  let nick = $state('');
  let realName = $state('');
  let autoJoinChannels = $state('');
  let nspass = $state('');
  let serverPass = $state('');
  let commands = $state('');
  let showNickserv = $state(false);
  let showAdvanced = $state(false);
  let revealNickserv = $state(false);
  let revealServerPass = $state(false);
  let error = $state('');
  let busy = $state(false);

  $effect(() => {
    if (existing) {
      name = existing.name;
      host = existing.host;
      port = existing.port;
      tls = existing.tls;
      nick = existing.nick;
      realName = existing.realName;
      autoJoinChannels = '';
      nspass = '';
      serverPass = '';
      commands = '';
    } else if (mode === 'add') {
      name = '';
      host = '';
      port = 6697;
      tls = 'enabled';
      nick = '';
      realName = '';
      autoJoinChannels = '';
      nspass = '';
      serverPass = '';
      commands = '';
    }
  });

  async function handleSubmit(e?: Event): Promise<void> {
    e?.preventDefault();
    if (busy) return;
    if (!name || !host || !nick) {
      error = 'Please provide a valid network name, hostname, and nickname';
      return;
    }
    busy = true;
    error = '';
    try {
      if (mode === 'add') {
        const result = await onAddNetwork({
          name, host, port, tls, nick, realName,
          autoJoinChannels, nspass, serverPass, commands,
        });
        // Immediately add the network to the UI so it shows up even if the
        // IRC engine can't connect (bad address, server down, etc.). The
        // periodic sync will later update the state with real connection info.
        if (result && result.id) {
          const net: import('../types').Network = {
            networkId: result.id as string,
            name: result.name as string,
            host: result.host as string,
            port: result.port as number,
            tls: (result.tls as string) || 'enabled',
            nick: result.nick as string,
            realName: (result.realName as string) || (result.nick as string),
            currentNick: result.nick as string,
            connected: false,
            connecting: true,
            connectionState: 'connecting',
            status: 'unknown',
            disconnectReason: '',
            isAway: false,
            awayMessage: '',
            buffers: [{
              name: '_server', type: 'server' as const, isJoined: true,
              unreadCount: 0, highlight: false, isPinned: false, isArchived: false,
              topic: '', topicSetBy: '', topicSetAt: 0, users: [],
              lastSeenMsgTime: null, firstUnseenMsgIndex: null,
            }],
            awayNicks: new Set(),
            capabilities: new Set(),
            isupport: {},
            chanTypes: '#',
          };
          ircState.networks.push(net);
          // Navigate to the new network's server buffer
          setActiveBuffer(net.networkId, '_server');
          updateRoute(net.networkId, '_server');
        }
        onClose();
      } else if (networkId) {
        await onUpdateNetwork(networkId, {
          name, host, port, tls, nick, realName,
        });
        onClose();
      }
    } catch (e: unknown) {
      const err = e as Error;
      error = err.message || 'Failed to save network';
    } finally {
      busy = false;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="add-network-prompt">
  <div class="overlaycontents">
    <h2 class="addNetworkHeading mainHeading">
      {mode === 'add' ? 'Join a new network' : 'Edit network'}
    </h2>
    <form class="addNetworkForm" onsubmit={handleSubmit} novalidate>
      <table class="form addNetworkCells" cellpadding="0" cellspacing="0">
        <tbody>
          <tr>
            <th class="netname" colspan="2">
              <label for="add-network-name">Network name</label>
            </th>
          </tr>
          <tr>
            <td class="netname" colspan="2">
              <input id="add-network-name" class="input" type="text"
                     bind:value={name} placeholder="e.g. Libera" required />
            </td>
          </tr>
        </tbody>
      </table>

      <table class="form networkEditorCells networkEditorCells__network" cellpadding="0" cellspacing="0">
        <tbody>
          <tr>
            <th class="hostname"><label for="add-network-host">Hostname</label></th>
            <th class="port" colspan="2"><label for="add-network-port">Port</label></th>
          </tr>
          <tr>
            <td class="hostname">
              <input id="add-network-host" class="input" type="text"
                     bind:value={host} placeholder="e.g. irc.libera.chat" required />
            </td>
            <td class="port">
              <input id="add-network-port" class="input" type="number"
                     bind:value={port} min="1" max="65535" required />
            </td>
            <td class="ssl">
              <label class="securePortRow" title="Use a secure connection to this server">
                <input type="checkbox" id="add-network-tls-secure"
                       checked={tls === 'required' || (tls === 'enabled' && port === 6697)}
                       onchange={(e) => { const el = e.currentTarget as HTMLInputElement; tls = el.checked ? 'required' : 'disabled'; }} />
                <i class="fa fa-shield"></i>
                <span>Secure port</span>
              </label>
              <select id="add-network-tls" class="input" bind:value={tls} style="display: none;">
                <option value="enabled">TLS Enabled</option>
                <option value="disabled">TLS Disabled</option>
                <option value="required">TLS Required</option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>

      <table class="form networkEditorCells networkEditorCells__identity" cellpadding="0" cellspacing="0">
        <thead>
          <tr>
            <th colspan="2" class="networkEditorHeading networkEditorHeading__Identity">
              <i class="fa fa-user"></i> Your identity
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th class="nickname"><label for="add-network-nick">Nickname</label></th>
            <th class="realname"><label for="add-network-realname">Full name <small class="explanation">(optional)</small></label></th>
          </tr>
          <tr>
            <td class="nickname">
              <input id="add-network-nick" class="input" type="text"
                     bind:value={nick} placeholder="Nick" required />
            </td>
            <td class="realname">
              <input id="add-network-realname" class="input" type="text"
                     bind:value={realName} placeholder="optional" />
            </td>
          </tr>
        </tbody>
      </table>

      {#if mode === 'add'}
        <table class="form addNetworkCells" cellpadding="0" cellspacing="0">
          <tbody>
            <tr>
              <th class="channels optional" colspan="2">
                <label for="add-network-channels">
                  Channels to join <small class="explanation">— comma or line separated, password after a space</small>
                </label>
              </th>
            </tr>
            <tr>
              <td class="channels optional" colspan="2">
                <textarea id="add-network-channels" class="input" rows="3"
                          bind:value={autoJoinChannels}
                          placeholder="e.g. #chat, #feedback, #secretchat password1"></textarea>
              </td>
            </tr>
          </tbody>
        </table>
      {/if}

      <div class="addNetworkAdvancedContainer networkEditor__container"
           class:networkEditor__container--collapsed={!showAdvanced}>
        <h3 class="addNetworkAdvancedHeading">
          <button type="button" onclick={() => showAdvanced = !showAdvanced}
                  aria-expanded={showAdvanced}
                  aria-controls="advanced-section">
            <i class="fa fa-cog"></i>
            <span>Advanced options</span>
            <span class="caret">{showAdvanced ? '▾' : '▸'}</span>
          </button>
        </h3>
        {#if showAdvanced}
          <div id="advanced-section" class="advanced-section">
            <table class="form addNetworkCells" cellpadding="0" cellspacing="0">
              <tbody>
                <tr>
                  <th class="nspass optional" colspan="2">
                    <label for="add-network-nspass">
                      NickServ password <small class="explanation">— if the server supports it and you've registered your nickname</small>
                    </label>
                  </th>
                </tr>
                <tr>
                  <td class="nspass optional" colspan="2">
                    <div class="passwordRow">
                      <input id="add-network-nspass" class="input"
                             type={revealNickserv ? 'text' : 'password'}
                             bind:value={nspass} autocomplete="new-password" />
                      <label class="reveal">
                        <input type="checkbox" class="reveal" bind:checked={revealNickserv} />
                        <span>Reveal</span>
                      </label>
                    </div>
                  </td>
                </tr>
                <tr>
                  <th class="joincommands optional" colspan="2">
                    <label for="add-network-commands">
                      Commands to run on connect <small class="explanation">— one per line, e.g. for opering up on connect. If you need to add a (eg, 15 sec) delay between commands, you can write: <code>WAIT 15</code></small>
                    </label>
                  </th>
                </tr>
                <tr>
                  <td class="joincommands optional" colspan="2">
                    <textarea id="add-network-commands" class="input" rows="5"
                              bind:value={commands}
                              placeholder="AUTH <user> <password> etc..."></textarea>
                  </td>
                </tr>
                <tr>
                  <th class="serverpass optional" colspan="2">
                    <label for="add-network-serverpass">
                      Server password <small class="explanation">— (optional) for private servers</small>
                    </label>
                  </th>
                </tr>
                <tr>
                  <td class="serverpass optional" colspan="2">
                    <div class="passwordRow">
                      <input id="add-network-serverpass" class="input"
                             type={revealServerPass ? 'text' : 'password'}
                             bind:value={serverPass} autocomplete="new-password" />
                      <label class="reveal">
                        <input type="checkbox" class="reveal" bind:checked={revealServerPass} />
                        <span>Reveal</span>
                      </label>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        {/if}
      </div>

      {#if error}
        <p class="userError" tabindex="-1">{error}</p>
      {/if}

      <div class="formButtons">
        {#if mode === 'edit'}
          <span class="reconnectNote">Changing your real name or any of the host settings requires a reconnect</span>
        {/if}
        <button type="button" class="action secondary" onclick={onClose} disabled={busy}>
          <span>Cancel</span>
        </button>
        <button type="button" class="action primary" onclick={() => handleSubmit()} disabled={busy}>
          <span>{mode === 'add' ? 'Join network' : 'Save'}</span>
        </button>
      </div>
    </form>
  </div>
</div>
