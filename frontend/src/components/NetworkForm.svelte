<script lang="ts">
  import { ircState, setActiveBuffer } from '../stores/ircStore.svelte';
  import { addNetwork, updateNetwork } from '../stores/api';
  import { sendRaw } from '../stores/wsConnection.svelte.ts';
  import { collapsedMap } from '../stores/preferences.svelte';
  import { updateRoute } from '../lib/routing';
  import { parseChannelList, stripPrefix } from '../lib/utils';
  import { isFiberServer } from '../lib/fiberServer';
  import { normalizeHost, parseHostUrl } from '../lib/host';

  interface Props {
    mode: 'add' | 'edit';
    networkId: string | null;
    onClose: () => void;
    onAddNetwork?: (...args: any[]) => any;
    onUpdateNetwork?: (...args: any[]) => any;
    onSendRaw?: (networkId: string, line: string) => void;
  }
  let { mode, networkId, onClose, onAddNetwork = addNetwork, onUpdateNetwork = updateNetwork, onSendRaw = sendRaw }: Props = $props();

  const existing = $derived(
    mode === 'edit' && networkId
      ? ircState.networks.find(n => n.networkId === networkId)
      : null
  );

  const isFiber = $derived(
    existing ? isFiberServer(existing as any) : host.trim().toLowerCase() === 'irc.ircfiber.com'
  );
  const fiberUsername = $derived(ircState.me?.username ?? '');

  let name = $state('');
  let host = $state('');
  let port = $state(6697);
  let tls = $state<'enabled' | 'disabled' | 'required'>('enabled');
  let nick = $state('');
  let realName = $state('');
  let autoJoinChannels = $state('');
  let autoJoinDelaySeconds = $state(0);
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

  $effect(() => {
    if (existing) {
      name = existing.name;
      host = existing.host;
      port = existing.port;
      // Migrate legacy "enabled" on TLS-only ports to "required" so it works by default
      // (engine also treats enabled+6697 as required, but UI should show correct value).
      let initTls = existing.tls as 'enabled' | 'disabled' | 'required';
      if (initTls === 'enabled' && [6697,6698,7000,6699].includes(existing.port)) initTls = 'required';
      tls = initTls;
      nick = existing.nick;
      realName = existing.realName;
      autoJoinChannels = (existing.autoJoinChannels ?? []).join(', ');
      autoJoinDelaySeconds = existing.autoJoinDelaySeconds ?? 0;
      nspass = '';
      serverPass = '';
      commands = '';
      saslMechanism = (existing.sasl as 'none' | 'plain' | 'external' | 'scramSha256') || 'none';
      saslUsername = existing.saslUsername || '';
      saslPassword = existing.saslPassword || '';
    } else if (mode === 'add') {
      name = '';
      host = '';
      port = 6697;
      tls = 'required';
      nick = '';
      realName = '';
      autoJoinChannels = '';
      autoJoinDelaySeconds = 0;
      nspass = '';
      serverPass = '';
      commands = '';
      saslMechanism = 'none';
      saslUsername = '';
      saslPassword = '';
    }
  });

  // Keep TLS in sync when user changes port: 6697-family defaults to required
  $effect(() => {
    if (mode !== 'add') return;
    if ([6697,6698,7000,6699].includes(port) && tls === 'disabled') {
      // User explicitly disabled TLS on TLS port — respect it (e.g. testing plain)
    } else if ([6697,6698,7000,6699].includes(port) && tls === 'enabled') {
      tls = 'required';
    }
  });

  // Fiber lock: nick/realName always tracks the account username
  $effect(() => {
    if (!isFiber || !fiberUsername) return;
    if (existing && nick !== fiberUsername) nick = fiberUsername;
    if (existing && realName !== fiberUsername) realName = fiberUsername;
    if (isFiber) {
      host = 'irc.ircfiber.com';
      port = 6697;
      tls = 'required';
    }
  });

  async function handleSubmit(e?: Event): Promise<void> {
    e?.preventDefault();
    if (busy) return;
    // Fiber lock: force managed values for irc.ircfiber.com
    if (isFiber) {
      const fu = fiberUsername || nick;
      if (fu) {
        nick = fu;
        if (!realName || realName === existing?.realName) realName = fu;
      }
      // Keep auto-join locked to defaults — merge before parse
      const required = ['#welcome', '#ircfiber'];
      const lower = autoJoinChannels.toLowerCase();
      for (const ch of required) {
        if (!lower.includes(ch)) autoJoinChannels = autoJoinChannels ? autoJoinChannels + ', ' + ch : ch;
      }
    }
    // Normalize host: strips brackets, ircs:// scheme, and trailing :port if pasted as URL
    const normalizedHost = normalizeHost(host);
    // If user pasted a full ircs:// URL, also auto-extract port/tls via URL parse
    const parsed = parseHostUrl(host);
    let effectiveHost = normalizedHost;
    let effectivePort = port;
    let effectiveTls = tls;
    if (parsed) {
      effectiveHost = parsed.host;
      if (parsed.port) effectivePort = parsed.port;
      if (parsed.tls) effectiveTls = parsed.tls;
    }
    if (isFiber) {
      effectiveHost = 'irc.ircfiber.com';
      effectivePort = 6697;
      effectiveTls = 'required';
      if (fiberUsername) {
        nick = fiberUsername;
        realName = fiberUsername;
      }
    }
    if (!name || !effectiveHost || !nick) {
      error = 'Please provide a valid network name, hostname, and nickname';
      return;
    }
    busy = true;
    error = '';
    try {
      if (mode === 'add') {
        const result = await onAddNetwork({
          name, host: effectiveHost, port: effectivePort, tls: effectiveTls, nick, realName,
          autoJoinChannels, autoJoinDelaySeconds, nspass, serverPass, commands,
          sasl: saslMechanism,
          saslUsername: saslMechanism !== 'none' ? saslUsername : undefined,
          saslPassword: saslMechanism !== 'none' ? saslPassword : undefined,
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
            autoJoinChannels: (result.autoJoinChannels as string[]) ?? [],
            autoJoinDelaySeconds: (result.autoJoinDelaySeconds as number) ?? 0,
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
        onClose();
      } else if (networkId) {
        // Capture the nick BEFORE the API call so we can detect a change
        // and emit NICK + optimistically reflect it locally (mirrors what
        // /nick does — see slashCommands.ts).
        const priorNick = existing?.nick ?? '';
        const nickChanged = existing != null && nick !== priorNick;
        const priorRealName = existing?.realName ?? '';

        const parsedChannels = parseChannelList(autoJoinChannels);

        await onUpdateNetwork(networkId, {
          name, host: effectiveHost, port: effectivePort, tls: effectiveTls, nick, realName,
          sasl: saslMechanism,
          saslUsername: saslMechanism !== 'none' ? saslUsername : '',
          saslPassword: saslMechanism !== 'none' && saslPassword ? saslPassword : undefined,
          autoJoinChannels: parsedChannels,
          autoJoinDelaySeconds,
        });

        // Mirror the saved fields into local state so the form pre-fills
        // correctly on next open and the sidebar/settings reflect the
        // edits immediately (the engine sync will eventually catch up).
        if (existing) {
          existing.name = name;
          existing.host = effectiveHost;
          existing.port = effectivePort;
          existing.tls = effectiveTls;
          existing.sasl = saslMechanism;
          existing.saslUsername = saslUsername;
          if (realName) existing.realName = realName;
          existing.autoJoinChannels = parsedChannels;
          existing.autoJoinDelaySeconds = autoJoinDelaySeconds;
          // nick is handled separately below because it also needs NICK raw
          if (nickChanged) {
            existing.nick = nick;
            // Optimistic: reflect the new nick in the UI before the server
            // echoes back. The NICK event handler in updateChannelUsers
            // (ircStore.svelte.ts) will overwrite this with the authoritative
            // server-acknowledged value when the echo arrives. Remember
            // the pre-change nick so the echo handler can identify this
            // change as self even though currentNick has already moved.
            const oldNick = existing.currentNick || existing.nick || '';
            existing.pendingSelfNickChange = { oldNick, newNick: nick, setAt: Date.now() };
            existing.currentNick = nick;
            // Optimistic member list update (IRCCloud-style): rename every
            // matching entry in ALL buffers immediately so the sidebar shows
            // the new nick before the engine round-trip completes.
            for (const buf of existing.buffers) {
              if (buf.users) {
                for (const u of buf.users) {
                  if (stripPrefix(u.nick) === oldNick) {
                    u.nick = (u.prefix || '') + nick;
                  }
                }
              }
            }
            // Send NICK to the live IRC connection so the change happens
            // immediately (same wire path as /nick). The next sync/realname
            // may apply user mode changes (like +r) the way IRCCloud does.
            onSendRaw(existing.networkId, 'NICK ' + nick);
          }
          // realName changes don't take effect on a live connection without
          // a reconnect — mirror to local state so the form pre-fills
          // correctly, but the network-form footer already notes that.
          if (realName && realName !== priorRealName) {
            existing.realName = realName;
          }
        }
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
                     bind:value={host} placeholder="e.g. irc.libera.chat" required disabled={isFiber} />
            </td>
            <td class="port">
              <input id="add-network-port" class="input" type="number"
                     bind:value={port} min="1" max="65535" required disabled={isFiber} />
            </td>
            <td class="ssl">
              <label class="securePortRow" title="Use a secure connection to this server">
                <input type="checkbox" id="add-network-tls-secure"
                       checked={tls === 'required' || (tls === 'enabled' && port === 6697)}
                       onchange={(e) => { const el = e.currentTarget as HTMLInputElement; tls = el.checked ? 'required' : 'disabled'; }} disabled={isFiber} />
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
                     bind:value={nick} placeholder="Nick" required disabled={isFiber} />
            </td>
            <td class="realname">
              <input id="add-network-realname" class="input" type="text"
                     bind:value={realName} placeholder="optional" disabled={isFiber} />
            </td>
          </tr>
        </tbody>
      </table>
      {#if isFiber}
        <p class="fiberLockNote" style="margin: 6px 0 0; font-size: 12px; color: var(--text-muted, #888);">
          IRC Fiber server is managed — host, port and nick are locked to your username (<strong>{fiberUsername || nick}</strong>) and cannot be edited.
        </p>
      {/if}

      <table class="form addNetworkCells" cellpadding="0" cellspacing="0">
        <tbody>
          <tr>
            <th class="channels optional" colspan="2">
              <label for="add-network-channels">
                Channels to join <small class="explanation">— space, comma, or newline separated</small>
              </label>
            </th>
          </tr>
          <tr>
            <td class="channels optional" colspan="2">
              <textarea id="add-network-channels" class="input" rows="3"
                        bind:value={autoJoinChannels}
                        placeholder="e.g. #chat, #feedback&#10;#superbowl&#10;#Zod"></textarea>
              {#if isFiber}
                <p class="fiberLockNote" style="margin: 6px 0 0; font-size: 12px; color: var(--text-muted, #888);">
                  #welcome and #ircfiber are required for IRC Fiber and will always be joined.
                </p>
              {/if}
            </td>
          </tr>
        </tbody>
      </table>

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
                <tr>
                  <th class="joindelay optional" colspan="2">
                    <label for="add-network-join-delay">
                      Auto-join delay <small class="explanation">— seconds to wait after connecting before sending the channel JOINs above. Some IRCds (e.g. SuperNETs) reject JOINs sent in the first 5 seconds of a connection; set this to 6 or higher to wait that out. 0 joins immediately after registration.</small>
                    </label>
                  </th>
                </tr>
                <tr>
                  <td class="joindelay optional" colspan="2">
                    <input id="add-network-join-delay" class="input" type="number"
                           bind:value={autoJoinDelaySeconds} min="0" max="300" step="1" />
                  </td>
                </tr>

                {#if mode === 'add' || existing}
                  <!-- ── SASL Authentication ──────────────────────── -->
                  <tr>
                    <th class="sasl optional" colspan="2">
                      <label for="add-network-sasl-mechanism">
                        SASL authentication
                        <small class="explanation">
                          — replaceable authentication framework for IRC. Choose a mechanism below.
                          <a href="https://ircv3.net/specs/extensions/sasl-3.1" target="_blank" rel="noopener" class="sasl-learn-more">Learn more</a>
                        </small>
                      </label>
                    </th>
                  </tr>
                  <tr>
                    <td class="sasl optional" colspan="2">
                      <div class="sasl-mechanism-row">
                        <select id="add-network-sasl-mechanism" class="input sasl-mechanism-select"
                                bind:value={saslMechanism}>
                          <option value="none">None (no SASL)</option>
                          <option value="plain">PLAIN — password-based, sent in the clear (use TLS)</option>
                          <option value="external">EXTERNAL — TLS client certificate</option>
                          <option value="scramSha256">SCRAM-SHA-256 — salted challenge-response, mutual auth</option>
                        </select>
                        <div class="sasl-security-badge" class:sasl-security-badge--secure={saslMechanism === 'scramSha256'} class:sasl-security-badge--warning={saslMechanism === 'plain'} class:sasl-security-badge--info={saslMechanism === 'external'}>
                          {#if saslMechanism === 'none'}
                            <i class="fa fa-minus-circle"></i> Disabled
                          {:else if saslMechanism === 'plain'}
                            <i class="fa fa-exclamation-triangle"></i> Use TLS
                          {:else if saslMechanism === 'external'}
                            <i class="fa fa-id-card"></i> Certificate
                          {:else if saslMechanism === 'scramSha256'}
                            <i class="fa fa-shield"></i> Secure
                          {/if}
                        </div>
                      </div>
                    </td>
                  </tr>
                  {#if saslMechanism !== 'none'}
                    <tr>
                      <th class="sasl-username optional" colspan="2">
                        <label for="add-network-sasl-username">
                          {#if saslMechanism === 'external'}
                            SASL username <small class="explanation">— (optional) authz identity for certificate auth</small>
                          {:else}
                            SASL username <small class="explanation">— the authentication identity (required)</small>
                          {/if}
                        </label>
                      </th>
                    </tr>
                    <tr>
                      <td class="sasl-username optional" colspan="2">
                        <input id="add-network-sasl-username" class="input"
                               type="text" bind:value={saslUsername}
                               placeholder={saslMechanism === 'external' ? 'optional — leave blank for cert-derived identity' : 'e.g. mynick'}
                               autocomplete="username" />
                      </td>
                    </tr>
                  {/if}
                  {#if saslMechanism === 'plain' || saslMechanism === 'scramSha256'}
                    <tr>
                      <th class="sasl-password optional" colspan="2">
                        <label for="add-network-sasl-password">
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
                      <td class="sasl-password optional" colspan="2">
                        <div class="passwordRow">
                          <input id="add-network-sasl-password" class="input"
                                 type={revealSaslPassword ? 'text' : 'password'}
                                 bind:value={saslPassword}
                                 autocomplete="new-password"
                                 placeholder={mode === 'edit' ? 'Leave blank to keep current' : 'Required'} />
                          <label class="reveal">
                            <input type="checkbox" class="reveal" bind:checked={revealSaslPassword} />
                            <span>Reveal</span>
                          </label>
                        </div>
                      </td>
                    </tr>
                  {/if}
                {/if}
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
          <span class="reconnectNote">Nickname changes take effect immediately on the live connection. Changing your real name, SASL settings, or any host settings requires a reconnect.</span>
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
