<script lang="ts">
  import { ircState, setActiveBuffer } from '../stores/ircStore.svelte';
  import { addNetwork } from '../stores/api';
  import { collapsedMap } from '../stores/preferences.svelte';
  import { updateRoute } from '../lib/routing';

  interface NetworkPreset {
    name: string;
    host: string;
    port: number;
    tls: 'enabled' | 'disabled' | 'required';
    nick?: string;
  }

  const PRESETS: NetworkPreset[] = [
    { name: 'IRCCloud', host: 'irc.irccloud.com', port: 6697, tls: 'required' },
    { name: 'Libera.Chat', host: 'irc.libera.chat', port: 6697, tls: 'required' },
    { name: 'IRCNet', host: 'open.ircnet.net', port: 6697, tls: 'required' },
    { name: 'Undernet', host: 'irc.undernet.org', port: 6697, tls: 'required' },
    { name: 'OFTC', host: 'irc.oftc.net', port: 6697, tls: 'required' },
    { name: 'EFnet', host: 'irc.efnet.org', port: 6697, tls: 'required' },
    { name: 'GeekShed', host: 'irc.geekshed.net', port: 6697, tls: 'required' },
    { name: 'Rizon', host: 'irc.rizon.net', port: 6697, tls: 'required' },
    { name: 'QuakeNet', host: 'irc.quakenet.org', port: 6667, tls: 'disabled' },
    { name: 'DALNet', host: 'irc.dal.net', port: 6667, tls: 'disabled' },
    { name: 'GameSurge', host: 'irc.gamesurge.net', port: 6667, tls: 'disabled' },
    { name: 'hackint', host: 'irc.hackint.org', port: 6697, tls: 'required' },
    { name: 'Espernet', host: 'irc.esper.net', port: 6697, tls: 'required' },
    { name: 'synIRC', host: 'irc.synirc.net', port: 6697, tls: 'required' },
    { name: 'P2P-NET', host: 'irc.p2p-net.net', port: 6697, tls: 'required' },
    { name: 'euIRCnet', host: 'irc.euirc.net', port: 6697, tls: 'required' },
    { name: 'SlashNET', host: 'irc.slashnet.org', port: 6697, tls: 'required' },
    { name: 'Atrum', host: 'irc.atrum.org', port: 6697, tls: 'required' },
    { name: 'tilde.chat', host: 'tilde.chat', port: 6697, tls: 'required' },
    { name: 'IRCNow', host: 'irc.ircnow.org', port: 6697, tls: 'required' },
    { name: 'BRASnet', host: 'irc.brasnet.org', port: 6697, tls: 'required' },
    { name: 'ChatHUB', host: 'irc.chathub.org', port: 6697, tls: 'required' },
    { name: 'LibertaCasa', host: 'irc.libertacasa.com', port: 6697, tls: 'required' },
    { name: 'TwiT', host: 'irc.twit.tv', port: 6697, tls: 'required' },
    { name: 'Snoonet', host: 'irc.snoonet.org', port: 6697, tls: 'required' },
  ];

  let host = $state('');
  let port = $state(6697);
  let tls = $state<'enabled' | 'disabled' | 'required'>('enabled');
  let nick = $state('');
  let realName = $state('');
  let autoJoinChannels = $state('');
  let nspass = $state('');
  let serverPass = $state('');
  let commands = $state('');
  let showAdvanced = $state(false);
  let revealNickserv = $state(false);
  let revealServerPass = $state(false);
  let saslMechanism = $state<'none' | 'plain' | 'external' | 'scramSha256'>('none');
  let saslUsername = $state('');
  let saslPassword = $state('');
  let revealSaslPassword = $state(false);
  let error = $state('');
  let busy = $state(false);

  function selectPreset(preset: NetworkPreset): void {
    host = preset.host;
    port = preset.port;
    tls = preset.tls;
    if (!nick) nick = preset.nick || '';
  }

  function onCustomHostInput(): void {
    // If the user types a custom host, clear the preset selection visual
  }

  async function handleSubmit(): Promise<void> {
    if (busy) return;
    if (!host || !nick) {
      error = 'Please provide a hostname and nickname';
      return;
    }
    busy = true;
    error = '';
    try {
      const result = await addNetwork({
        name: host,
        host, port, tls, nick, realName,
        autoJoinChannels, nspass, commands,
        sasl: saslMechanism,
        saslUsername: saslMechanism !== 'none' ? saslUsername : undefined,
        saslPassword: saslMechanism !== 'none' ? saslPassword : undefined,
      });
      if (result && result.id) {
        const net: import('../types').Network = {
          networkId: result.id as string,
          name: result.name as string,
          host: result.host as string,
          port: result.port as number,
          tls: ((result.tls as string) || 'enabled') as 'enabled' | 'disabled' | 'required',
          nick: result.nick as string,
          realName: (result.realName as string) || (result.nick as string),
          currentNick: result.nick as string,
          sasl: (result.sasl as string) || 'none',
          saslUsername: (result.saslUsername as string) || '',
          saslPassword: '',
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
            lastSeen: null, bottomSeen: null, clearedAt: null, modeFlags: {},
          }],
          awayNicks: new Set(),
          capabilities: new Set(),
          isupport: {},
          chanTypes: '#',
        };
        ircState.networks.push(net);
        // Ensure the new server starts expanded in the sidebar
        collapsedMap[net.networkId] = false;
        // Navigate to the new network's server buffer
        setActiveBuffer(net.networkId, '_server');
        updateRoute(net.networkId, '_server');
      }
    } catch (e: unknown) {
      const err = e as Error;
      error = err.message || 'Failed to save network';
    } finally {
      busy = false;
    }
  }
</script>

<div id="addNetworkPage">
  <header class="bufferstatus">
    <div class="status bufferHead">
      <h2 class="bufferHeading" id="addNetworkHeading">Join a new network</h2>
    </div>
  </header>
  <div id="addNetworkScroll" class="chat-body">

  <div id="addNetworkContents">
    <div id="addNetworkEditor">
      <form id="addNetworkForm" class="addNetworkForm networkEditor" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} novalidate>
        <table cellpadding="0" cellspacing="0" class="form addNetworkCells networkEditorCells networkEditorCells__network">
          <thead>
          <tr>
            <th scope="col" class="hostname"><label for="addNetworkHostname">Hostname</label></th>
            <th scope="col" class="port"><label for="addNetworkPort">Port</label></th>
            <th scope="col" class="ssl"></th>
          </tr>
          </thead>
          <tbody>
          <tr>
            <td class="hostname">
              <select class="input addNetworkHostname" id="addNetworkHostname"
                      onchange={(e) => {
                        const val = (e.currentTarget as HTMLSelectElement).value;
                        const preset = PRESETS.find(p => p.host === val);
                        if (preset) { selectPreset(preset); }
                      }}>
                <option class="placeholder" value="">Choose a network…</option>
                {#each PRESETS as preset}
                  <option value={preset.host}>{preset.name}</option>
                {/each}
              </select>
              <div>
                <input class="input addNetworkHostnameSelect" placeholder="Or enter a hostname…"
                       bind:value={host} oninput={onCustomHostInput} />
              </div>
            </td>
            <td class="port">
              <input class="input addNetworkPort" id="addNetworkPort" bind:value={port} />
            </td>
            <td class="ssl">
              <label class="securePortRow">
                <input type="checkbox" class="addNetworkSSL" id="addNetworkSSL"
                       checked={tls === 'required' || (tls === 'enabled' && port === 6697)}
                       onchange={(e) => { const el = e.currentTarget as HTMLInputElement; tls = el.checked ? 'required' : 'disabled'; }} />
                <span><i class="fa fa-shield" title="Use a secure connection to this server"></i>Secure port</span>
              </label>
            </td>
          </tr>
          </tbody>
        </table>

        <h2 class="addNetworkHeading networkEditorHeading networkEditorHeading__Identity addNetworkIdentityHeading">
          <span><i class="fa fa-user"></i>Your identity</span>
        </h2>
        <table cellpadding="0" cellspacing="0" class="form addNetworkCells networkEditorCells">
          <thead>
          <tr>
            <th scope="col" class="nickname"><label for="addNetworkNick">Nickname</label></th>
            <th scope="col" class="realname"><label for="addNetworkRealname">Full name <small>(optional)</small></label></th>
          </tr>
          </thead>
          <tbody>
          <tr>
            <td class="nickname">
              <input class="input addNetworkNick" id="addNetworkNick" bind:value={nick} placeholder="Nick" />
            </td>
            <td class="realname">
              <input class="input addNetworkRealname" id="addNetworkRealname" bind:value={realName} placeholder="optional" />
            </td>
          </tr>
          </tbody>
        </table>

        <table cellpadding="0" cellspacing="0" class="form addNetworkCells networkEditorCells">
          <tbody>
          <tr>
            <th scope="col" class="channels optional">
              <label for="addNetworkChannels">
                Channels to join <small class="explanation">— comma or line separated, password after a space</small>
              </label>
            </th>
          </tr>
          <tr>
            <td class="channels optional">
              <textarea class="input addNetworkChannels" id="addNetworkChannels"
                        bind:value={autoJoinChannels} rows="4"
                        placeholder="e.g. #chat, #feedback, #secretchat password1"></textarea>
            </td>
          </tr>
          </tbody>
        </table>

        <div class="networkEditor__container addNetworkAdvancedContainer"
             class:networkEditor__container--collapsed={!showAdvanced}>
          <h2 class="addNetworkHeading networkEditorHeading networkEditorHeading__Advanced addNetworkAdvancedHeading">
            <button type="button" onclick={() => showAdvanced = !showAdvanced} aria-expanded={showAdvanced}>
              <i class="fa fa-cog"></i>Advanced options
              <span class="caret">{showAdvanced ? '\u25BE' : '\u25B8'}</span>
            </button>
          </h2>
          {#if showAdvanced}
            <table cellpadding="0" cellspacing="0" class="form addNetworkCells networkEditorCells">
              <tbody>
              <tr>
                <th scope="col" class="nspass optional">
                  <label for="addNetworkNspass">
                    NickServ password <small class="explanation">— if the server supports it and you've registered your nickname</small>
                  </label>
                </th>
              </tr>
              <tr>
                <td class="nspass optional">
                  <input class="input addNetworkNspass password" id="addNetworkNspass"
                         bind:value={nspass} type={revealNickserv ? 'text' : 'password'} autocomplete="new-password" />
                  <span>
                    <input type="checkbox" class="reveal" id="addNetworkNspassReveal" bind:checked={revealNickserv} />
                    <label for="addNetworkNspassReveal">Reveal</label>
                  </span>
                </td>
              </tr>
              <tr>
                <th scope="col" class="joincommands optional">
                  <label for="addNetworkCommands">
                    Commands to run on connect <small class="explanation">— one per line, e.g. for opering up on connect.<br />If you need to add a (eg, 15 sec) delay between commands, you can write: <code>WAIT 15</code></small>
                  </label>
                </th>
              </tr>
              <tr>
                <td class="joincommands optional">
                  <textarea class="input addNetworkCommands" id="addNetworkCommands" rows="4"
                            bind:value={commands}
                            placeholder="AUTH &lt;user&gt; &lt;password&gt; etc..."></textarea>
                </td>
              </tr>
              <tr>
                <th scope="col" class="server_pass optional">
                  <label for="addNetworkPassword">
                    Server password <small class="explanation">— (optional) for private servers</small>
                  </label>
                </th>
              </tr>
              <tr>
                <td class="server_pass optional">
                  <input class="input addNetworkPassword password" id="addNetworkPassword"
                         bind:value={serverPass} type={revealServerPass ? 'text' : 'password'} autocomplete="new-password" />
                  <span>
                    <input type="checkbox" class="reveal" id="addNetworkPasswordReveal" bind:checked={revealServerPass} />
                    <label for="addNetworkPasswordReveal">Reveal</label>
                  </span>
                </td>
              </tr>

              <!-- ── SASL Authentication ──────────────────────────── -->
              <tr>
                <th scope="col" class="sasl optional">
                  <label for="addNetworkSaslMechanism">
                    SASL authentication
                    <small class="explanation">— replaceable authentication framework for IRC.
                      <a href="https://ircv3.net/specs/extensions/sasl-3.1" target="_blank" rel="noopener">Learn more</a>
                    </small>
                  </label>
                </th>
              </tr>
              <tr>
                <td class="sasl optional">
                  <div class="sasl-mechanism-row">
                    <select class="input addNetworkSaslMechanism" id="addNetworkSaslMechanism"
                            bind:value={saslMechanism}>
                      <option value="none">None (no SASL)</option>
                      <option value="plain">PLAIN — password-based, sent in the clear (use TLS)</option>
                      <option value="external">EXTERNAL — TLS client certificate</option>
                      <option value="scramSha256">SCRAM-SHA-256 — salted challenge-response, mutual auth</option>
                    </select>
                    <span class="sasl-security-badge"
                          class:sasl-security-badge--secure={saslMechanism === 'scramSha256'}
                          class:sasl-security-badge--warning={saslMechanism === 'plain'}
                          class:sasl-security-badge--info={saslMechanism === 'external'}>
                      {#if saslMechanism === 'none'}
                        <i class="fa fa-minus-circle"></i> Disabled
                      {:else if saslMechanism === 'plain'}
                        <i class="fa fa-exclamation-triangle"></i> Use TLS
                      {:else if saslMechanism === 'external'}
                        <i class="fa fa-id-card"></i> Certificate
                      {:else if saslMechanism === 'scramSha256'}
                        <i class="fa fa-shield"></i> Secure
                      {/if}
                    </span>
                  </div>
                </td>
              </tr>
              {#if saslMechanism !== 'none'}
                <tr>
                  <th scope="col" class="sasl-username optional">
                    <label for="addNetworkSaslUsername">
                      {#if saslMechanism === 'external'}
                        SASL username <small class="explanation">— (optional) authz identity for certificate auth</small>
                      {:else}
                        SASL username <small class="explanation">— the authentication identity (required)</small>
                      {/if}
                    </label>
                  </th>
                </tr>
                <tr>
                  <td class="sasl-username optional">
                    <input class="input addNetworkSaslUsername" id="addNetworkSaslUsername"
                           type="text" bind:value={saslUsername}
                           placeholder={saslMechanism === 'external' ? 'optional — leave blank for cert-derived identity' : 'e.g. mynick'}
                           autocomplete="username" />
                  </td>
                </tr>
              {/if}
              {#if saslMechanism === 'plain' || saslMechanism === 'scramSha256'}
                <tr>
                  <th scope="col" class="sasl-password optional">
                    <label for="addNetworkSaslPassword">
                      SASL password
                      <small class="explanation">
                        {#if saslMechanism === 'scramSha256'}
                          — SCRAM stores this as a salted hash on the server; your password is never sent in the clear
                        {:else}
                          — SASL PLAIN transmits in base64 (use TLS to encrypt the connection)
                        {/if}
                      </small>
                    </label>
                  </th>
                </tr>
                <tr>
                  <td class="sasl-password optional">
                    <input class="input addNetworkSaslPassword password" id="addNetworkSaslPassword"
                           type={revealSaslPassword ? 'text' : 'password'}
                           bind:value={saslPassword} autocomplete="new-password"
                           placeholder="Required" />
                    <span>
                      <input type="checkbox" class="reveal" id="addNetworkSaslPasswordReveal" bind:checked={revealSaslPassword} />
                      <label for="addNetworkSaslPasswordReveal">Reveal</label>
                    </span>
                  </td>
                </tr>
              {/if}

              </tbody>
            </table>
          {/if}
        </div>

        {#if error}
          <p class="userError" tabindex="-1">{error}</p>
        {/if}

        <p class="form addNetworkSubmit">
          <button class="action primary" type="submit" disabled={busy}>
            <span>Join network</span>
          </button>
        </p>
      </form>
    </div>
  </div>
</div>
</div>

<style>
  #addNetworkPage {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  #addNetworkHeading {
    margin: 0;
    padding: 10px 16px;
  }
  #addNetworkScroll {
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem 2rem;
  }
  #addNetworkContents {
    position: relative;
    max-width: 720px;
  }
  #addNetworkEditor :global(.addNetworkHostname) {
    width: 100%;
  }
  #addNetworkEditor :global(.addNetworkPort) {
    width: 5em;
  }
  #addNetworkEditor :global(.networkEditorCells) {
    width: 100%;
  }
  #addNetworkEditor :global(.networkEditorCells th) {
    text-align: left;
    padding: 0.5rem 0.75rem 0.25rem 0;
    white-space: nowrap;
  }
  #addNetworkEditor :global(.networkEditorCells td) {
    padding: 0.125rem 0.75rem 0.5rem 0;
    vertical-align: top;
  }
  #addNetworkEditor :global(.input) {
    width: 100%;
    box-sizing: border-box;
  }
  #addNetworkEditor :global(.securePortRow) {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    white-space: nowrap;
    padding-top: 0.25rem;
  }
  #addNetworkEditor :global(.addNetworkAdvancedHeading) {
    margin-top: 1rem;
  }
  #addNetworkEditor :global(.addNetworkAdvancedHeading button) {
    background: none;
    border: none;
    color: inherit;
    font-size: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  #addNetworkEditor :global(.addNetworkAdvancedHeading .caret) {
    font-size: 0.8em;
  }
  #addNetworkEditor :global(.userError) {
    color: #f85149;
    margin: 0.5rem 0;
  }
  #addNetworkEditor :global(.password) {
    width: 100%;
    max-width: 20em;
  }
  #addNetworkEditor :global(.reveal) {
    margin-left: 0.3rem;
  }
  #addNetworkEditor :global(.addNetworkSubmit) {
    margin-top: 1rem;
  }
  #addNetworkEditor :global(.addNetworkSubmit .primary) {
    display: inline-flex;
    align-items: center;
    padding: 0.5rem 1.5rem;
    font-size: 0.875rem;
    font-weight: 600;
    background: #238636;
    color: #fff;
    border: 1px solid #238636;
    border-radius: 3px;
    cursor: pointer;
    transition: background 0.15s;
  }
  #addNetworkEditor :global(.addNetworkSubmit .primary:hover) {
    background: #2ea043;
    border-color: #2ea043;
  }
  #addNetworkEditor :global(.addNetworkSubmit .primary:disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }
  #addNetworkEditor :global(.explanation) {
    color: #8b949e;
    font-weight: normal;
  }
  #addNetworkEditor :global(.addNetworkCells) {
    border-collapse: collapse;
  }
  #addNetworkEditor :global(textarea) {
    resize: vertical;
    min-height: 4em;
  }

  /* ── SASL Authentication UI ───────────────────────────── */
  #addNetworkEditor :global(.sasl-mechanism-row) {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  #addNetworkEditor :global(.addNetworkSaslMechanism) {
    flex: 1;
    min-width: 20em;
  }
  #addNetworkEditor :global(.sasl-security-badge) {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.6rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  #addNetworkEditor :global(.sasl-security-badge--secure) {
    background: #1a3a2a;
    color: #3fb950;
    border: 1px solid #238636;
  }
  #addNetworkEditor :global(.sasl-security-badge--warning) {
    background: #3a2a1a;
    color: #d29922;
    border: 1px solid #9e6a03;
  }
  #addNetworkEditor :global(.sasl-security-badge--info) {
    background: #1a2a3a;
    color: #58a6ff;
    border: 1px solid #1f6feb;
  }
  #addNetworkEditor :global(.sasl-learn-more) {
    color: #58a6ff;
    text-decoration: none;
  }
  #addNetworkEditor :global(.sasl-learn-more:hover) {
    text-decoration: underline;
  }
</style>
