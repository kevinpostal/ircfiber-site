<script lang="ts">
  /**
   * The one full-page add-network surface (`/?/add-network`), rendered in
   * App's `.main-area` slot next to the sidebar — same shell as
   * Settings/Shortcuts/Feedback.
   *
   * `welcome` (`/?/add-network=welcome`, where POST /register lands) adds the
   * post-signup hero and clickable IRC Fiber channel chips; the form below is
   * the same `NetworkForm` the Edit-network dialog uses, so both surfaces are
   * literally the same design.
   */
  import { ircState } from '../stores/ircStore.svelte';
  import { provisionDefaultFiber } from '../stores/api';
  import { adoptNetwork } from '../lib/adoptNetwork';
  import { isFiberServer, FIBER_DEFAULT_CHANNELS } from '../lib/fiberServer';
  import NetworkForm from './NetworkForm.svelte';

  interface Props {
    welcome: boolean;
    onSwitchBuffer: (networkId: string, bufferName: string) => void;
    onClose: () => void;
  }
  let { welcome, onSwitchBuffer, onClose }: Props = $props();

  let fiberBusy = $state(false);
  let fiberError = $state('');

  const fiberNet = $derived(ircState.networks.find(n => isFiberServer(n)) ?? null);

  // The constant list, not the buffer list, is the source of the chips so they
  // exist before the JOINs land: switchToBuffer auto-creates the buffer and
  // App's maybeAutoJoinChannel issues the JOIN. Extra channels the user has
  // joined on the Fiber server are appended.
  const fiberChannels = $derived.by(() => {
    const out = [...FIBER_DEFAULT_CHANNELS];
    for (const b of fiberNet?.buffers ?? [])
      if (b.type === 'channel' && !out.includes(b.name)) out.push(b.name);
    return out;
  });

  /** The IRC Fiber card: provision the platform network in one click. */
  async function connectFiber(): Promise<void> {
    if (fiberBusy) return;
    fiberBusy = true;
    fiberError = '';
    try {
      adoptNetwork(await provisionDefaultFiber());
      onClose();
    } catch (e: unknown) {
      fiberError = (e as Error).message || 'IRC Fiber is not available right now';
    } finally {
      fiberBusy = false;
    }
  }
</script>

<div id="addNetworkPage">
  <header class="bufferstatus">
    <div class="status bufferHead">
      <h2 class="bufferHeading" id="addNetworkHeading">
        {welcome ? 'Welcome to IRC Fiber' : 'Join a new network'}
      </h2>
      {#if ircState.networks.length > 0}
        <button class="settings-done" onclick={onClose}>Done</button>
      {/if}
    </div>
  </header>
  <div id="addNetworkScroll" class="chat-body">
    <div id="addNetworkContents">
      {#if welcome}
        <div class="welcomeHero">
          <h1 class="welcomeHero__title">
            Welcome to IRC Fiber{ircState.me?.username ? `, ${ircState.me.username}` : ''}
          </h1>
          <p class="welcomeHero__sub">
            {#if fiberNet}
              You're already on our server — pick a channel to start chatting, or add
              another IRC network below. Your connection stays online when you close this tab.
            {:else}
              Always connected, infinite history. Start on our own server, or join any
              IRC network below — your connection stays online even when you close this tab.
            {/if}
          </p>
        </div>
      {/if}

      {#if fiberNet}
        {#if welcome}
          <div class="fiberChannels" data-testid="fiber-channels">
            {#each fiberChannels as ch (ch)}
              <button type="button" class="fiberChannels__chip"
                      onclick={() => onSwitchBuffer(fiberNet.networkId, ch)}>{ch}</button>
            {/each}
          </div>
        {/if}
      {:else}
        <!-- Recovery path: provisioning is skipped when the admin kill-switch
             irc:config:fiberEnabled is off, or when no engine was healthy at
             signup (default_network.d). -->
        <div class="fiberCard" data-testid="fiber-card">
          <div class="fiberCard__body">
            <div class="fiberCard__name"><span class="fiberCard__dot"></span>IRC Fiber</div>
            <div class="fiberCard__desc">
              Our community server — <b>#ircfiber</b> and <b>#support</b>, no setup needed.
            </div>
            {#if fiberError}
              <p class="userError fiberCard__error">{fiberError}</p>
            {/if}
          </div>
          <button type="button" class="fiberCard__connect" onclick={connectFiber} disabled={fiberBusy}>
            {fiberBusy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      {/if}

      <h2 class="welcomeDivider">
        <span>{welcome && fiberNet ? 'or join another network' : 'join a network'}</span>
      </h2>

      <div id="addNetworkEditor">
        <NetworkForm mode="add" networkId={null} showHeading={false} onClose={onClose} />
      </div>
    </div>
  </div>
</div>

<style>
  .welcomeHero {
    margin-bottom: 20px;
  }
  .welcomeHero__title {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .welcomeHero__sub {
    margin: 0;
    color: var(--text-secondary, #8b949e);
    font-size: 13px;
    line-height: 1.5;
    max-width: 560px;
  }
  .fiberChannels {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 22px;
  }
  .fiberChannels__chip {
    padding: 6px 14px;
    border: 1px solid var(--border, #30363d);
    border-radius: 999px;
    background: var(--surface-2, rgba(88, 166, 255, 0.05));
    color: var(--text-primary, #d1d5db);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .fiberChannels__chip:hover { border-color: #58a6ff; color: #58a6ff; }
  .fiberCard {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 16px;
    margin-bottom: 22px;
    border: 1px solid var(--border, #30363d);
    border-radius: 8px;
    background: var(--surface-2, rgba(88, 166, 255, 0.05));
  }
  .fiberCard__body { flex: 1; min-width: 0; }
  .fiberCard__name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    font-size: 14px;
    margin-bottom: 2px;
  }
  .fiberCard__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #3fb950;
    flex: none;
  }
  .fiberCard__desc {
    color: var(--text-secondary, #8b949e);
    font-size: 12.5px;
  }
  .fiberCard__error { margin: 6px 0 0; }
  .fiberCard__connect {
    flex: none;
    padding: 8px 18px;
    border-radius: 6px;
    border: none;
    background: var(--accent, #238636);
    color: #fff;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
  }
  .fiberCard__connect:hover { filter: brightness(1.1); }
  .fiberCard__connect:disabled { opacity: 0.6; cursor: default; }
  .welcomeDivider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 0 14px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary, #6e7681);
  }
  .welcomeDivider::before,
  .welcomeDivider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border, #30363d);
  }
  #addNetworkPage {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  #addNetworkHeading {
    margin: 0;
    padding: 10px 16px;
    flex: 1;
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
</style>
