<script lang="ts">
  /**
   * BridgeServPanel — Discord <-> IRC bridge management (IRCD page → BridgeServ).
   *
   * Two cards, two data paths — the same split NickServPanel uses:
   *   1. "Bridges" is the live `BridgeServ LIST` inventory
   *      (`/api/admin/ircd/bridge/bridges`). Every successful mutation
   *      re-fetches it via `afterAction()`.
   *   2. "Add bridge" founds a bridge from three identifiers: the IRC
   *      channel, the Discord guild (space) and the Discord channel. The
   *      guild and channel pickers come straight from the Discord REST API
   *      through the gateway, so they stay synchronous and keep working
   *      while the sidecar is down.
   *
   * Repoint reuses the add form pre-filled from the row and POSTs to `set`
   * with the same body shape. Remove goes through a typed confirmation and
   * POSTs `{channel}` to `del`.
   *
   * When any endpoint answers 503 the sidecar is not configured and the
   * whole tab degrades to one explanatory panel instead of error toasts —
   * the same degradation the IRCD page uses when Anope is unconfigured.
   */
  import { onMount } from 'svelte';
  import Card from './Card.svelte';
  import EmptyState from './EmptyState.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';

  interface BridgeRow {
    ircChannel: string; space: string; channel: string; suffix: string;
    network: string; endpoint: boolean; reserved: number;
  }
  interface BridgesResponse {
    bridges: BridgeRow[]; raw: string[]; connected: boolean;
  }
  interface Guild { id: string; name: string; }
  interface DiscordChannel { id: string; name: string; }

  const BRIDGES = '/api/admin/ircd/bridge/bridges';
  const GUILDS = '/api/admin/ircd/bridge/guilds';
  const CHANNELS = '/api/admin/ircd/bridge/channels';
  const ADD = '/api/admin/ircd/bridge/add';
  const SET = '/api/admin/ircd/bridge/set';
  const DEL = '/api/admin/ircd/bridge/del';

  let bridges = $state<BridgeRow[]>([]);
  let raw = $state<string[]>([]);
  let connected = $state(false);
  let listError = $state<string | null>(null);
  let listLoading = $state(false);

  let guilds = $state<Guild[]>([]);
  let guildsError = $state<string | null>(null);
  let guildsLoading = $state(false);

  let discordChannels = $state<DiscordChannel[]>([]);
  let channelsError = $state<string | null>(null);
  let channelsLoading = $state(false);
  /// Channel names seen so far, keyed by guild then channel id. Every
  /// channels fetch extends it, so table rows can resolve names without a
  /// request per row; unknown ids fall back to the raw snowflake.
  let channelNames = $state<Record<string, Record<string, string>>>({});

  /// True once any bridge endpoint answers 503: the sidecar is not
  /// configured, so the tab renders one explanatory panel and issues no
  /// further requests that would only toast the same refusal.
  let notConfigured = $state(false);

  let actionError = $state<string | null>(null);
  /// Which mutation is in flight, so only its button shows "Loading…".
  let acting = $state('');

  let ircChannel = $state('');
  let guildId = $state('');
  let foreignChannel = $state('');
  let suffix = $state('');
  /// Non-null while repointing: the IRC channel of the row being edited.
  /// The submit target follows it — `set` for a repoint, `add` otherwise.
  let repointTarget = $state<string | null>(null);
  /// The IRC channel a Remove is being confirmed for, null when none is
  /// pending. One bridge at a time by construction — no multi-select.
  let removeTarget = $state<string | null>(null);
  /// Which channel the running remove is for, so only the row that started
  /// it dims and cannot be pressed again.
  let removingChannel = $state('');

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  onMount(() => {
    void loadBridges();
    void loadGuilds();
  });

  async function loadBridges() {
    listLoading = true;
    listError = null;
    try {
      const r = await api.get<BridgesResponse>(BRIDGES);
      bridges = r.bridges ?? [];
      raw = r.raw ?? [];
      connected = r.connected === true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) notConfigured = true;
      else listError = errMsg(e);
    } finally {
      listLoading = false;
    }
  }

  async function loadGuilds() {
    guildsLoading = true;
    guildsError = null;
    try {
      const r = await api.get<{ guilds: Guild[] }>(GUILDS);
      guilds = r.guilds ?? [];
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) notConfigured = true;
      else guildsError = errMsg(e);
    } finally {
      guildsLoading = false;
    }
  }

  async function loadChannels(guild: string) {
    channelsLoading = true;
    channelsError = null;
    try {
      const r = await api.get<{ channels: DiscordChannel[] }>(CHANNELS, { guild });
      discordChannels = r.channels ?? [];
      const names: Record<string, string> = { ...(channelNames[guild] ?? {}) };
      for (const c of discordChannels) names[c.id] = c.name;
      channelNames = { ...channelNames, [guild]: names };
    } catch (e) {
      discordChannels = [];
      if (e instanceof ApiError && e.status === 503) notConfigured = true;
      else channelsError = errMsg(e);
    } finally {
      channelsLoading = false;
    }
  }

  /// A new guild invalidates the picked channel: the ids are per-guild
  /// snowflakes, so keeping the previous selection would submit a channel
  /// from the wrong guild.
  function onGuildChange() {
    foreignChannel = '';
    discordChannels = [];
    channelsError = null;
    if (guildId) void loadChannels(guildId);
  }

  /// The list is authoritative over the form, so refresh it after every
  /// mutation: adding, repointing and removing all change which rows exist.
  async function afterAction() {
    await loadBridges();
  }

  function guildName(space: string): string {
    return guilds.find((g) => g.id === space)?.name ?? space;
  }
  function channelName(b: BridgeRow): string {
    return channelNames[b.space]?.[b.channel] ?? b.channel;
  }

  function startRepoint(b: BridgeRow) {
    actionError = null;
    repointTarget = b.ircChannel;
    ircChannel = b.ircChannel;
    guildId = b.space;
    foreignChannel = '';
    suffix = b.suffix ?? '';
    discordChannels = [];
    channelsError = null;
    if (guildId) void loadChannels(guildId);
  }

  function cancelRepoint() {
    repointTarget = null;
    ircChannel = '';
    guildId = '';
    foreignChannel = '';
    suffix = '';
    discordChannels = [];
    channelsError = null;
    actionError = null;
  }

  async function submit() {
    const channel = ircChannel.trim();
    if (!channel) { toastError('An IRC channel is required, e.g. #dmz.'); return; }
    if (!guildId) { toastError('Pick a Discord guild first.'); return; }
    if (!foreignChannel) { toastError('Pick a Discord channel first.'); return; }
    acting = repointTarget ? 'set' : 'add';
    actionError = null;
    try {
      const r = await api.post<{ lines: string[] }>(repointTarget ? SET : ADD, {
        channel,
        space: guildId,
        foreignChannel,
        suffix: suffix.trim(),
      });
      toastSuccess((repointTarget ? 'Repointed ' : 'Added ') + channel);
      if (r.lines?.length) toastSuccess(r.lines.join('\n'));
      cancelRepoint();
      await afterAction();
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) notConfigured = true;
      else {
        actionError = errMsg(e);
        toastError(actionError);
      }
    } finally {
      acting = '';
    }
  }

  /// Removes the bridge the confirmation named. Reachable only from
  /// `ConfirmDialog`: the row buttons set `removeTarget` and nothing else
  /// posts.
  async function remove() {
    const channel = removeTarget ?? '';
    removeTarget = null;
    if (!channel) return;
    acting = 'remove';
    removingChannel = channel;
    actionError = null;
    try {
      const r = await api.post<{ lines: string[] }>(DEL, { channel });
      toastSuccess('Removed ' + channel);
      if (r.lines?.length) toastSuccess(r.lines.join('\n'));
      if (repointTarget === channel) cancelRepoint();
      await afterAction();
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) notConfigured = true;
      else {
        actionError = errMsg(e);
        toastError(actionError);
      }
    } finally {
      acting = '';
      removingChannel = '';
    }
  }

  const btn = 'rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40';
  const input =
    'rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder-muted focus:border-primary focus:outline-none';
</script>

{#if notConfigured}
  <Card>
    <EmptyState
      title="The Discord bridge is not configured"
      description="The gateway has no bridge RPC endpoint configured (IRCFIBER_BRIDGE_RPC_URL). Set it and the bridge credentials on the gateway, then redeploy."
    />
  </Card>
{:else}
  <Card class="mb-4">
    <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 class="text-sm font-semibold text-heading">Bridges ({bridges.length})</h3>
        <p class="mt-0.5 text-xs text-muted">
          Discord channels relayed to IRC by BridgeServ · live `LIST`
        </p>
      </div>
      <button type="button" onclick={() => void loadBridges()} class={btn}>
        {listLoading ? 'Loading…' : 'Refresh'}
      </button>
    </div>

    {#if listError}
      <p class="text-sm text-danger">{listError}</p>
    {:else if bridges.length === 0}
      <EmptyState
        title="No bridges"
        description={connected
          ? 'No channel is bridged. Add one below.'
          : 'The bridge service is not reachable — the sidecar may be down.'}
      />
      {#if raw.length > 0}
        <pre class="mt-3 overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs text-muted">{raw.join('\n')}</pre>
      {/if}
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead>
            <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
              <th class="py-2 pr-4">IRC channel</th>
              <th class="py-2 pr-4">Discord guild</th>
              <th class="py-2 pr-4">Discord channel</th>
              <th class="py-2 pr-4">Suffix</th>
              <th class="py-2 pr-4">Webhook</th>
              <th class="py-2 pr-4">Reserved</th>
              <th class="py-2 text-right"></th>
            </tr>
          </thead>
          <tbody data-testid="bridge-rows">
            {#each bridges as b (b.ircChannel)}
              <tr
                class="border-b border-border/50 transition-opacity last:border-0 {removingChannel ===
                b.ircChannel
                  ? 'opacity-40'
                  : ''}"
              >
                <td class="py-2 pr-4 font-mono font-semibold">{b.ircChannel}</td>
                <td class="py-2 pr-4">{guildName(b.space)}</td>
                <td class="py-2 pr-4 font-mono">{channelName(b)}</td>
                <td class="py-2 pr-4 font-mono">{b.suffix || '—'}</td>
                <td class="py-2 pr-4">{b.endpoint ? 'yes' : 'no'}</td>
                <td class="py-2 pr-4 tabular-nums">{b.reserved}</td>
                <td class="py-2 text-right">
                  <div class="flex items-center justify-end gap-1">
                    <button type="button" class={btn} onclick={() => startRepoint(b)} aria-label="Repoint {b.ircChannel}">
                      Repoint
                    </button>
                    <button
                      type="button"
                      data-testid="bridge-remove-{b.ircChannel}"
                      aria-label="Remove {b.ircChannel}"
                      disabled={acting === 'remove' && removingChannel === b.ircChannel}
                      onclick={() => (removeTarget = b.ircChannel)}
                      class="rounded-md border border-danger/40 px-2.5 py-1 text-xs text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {acting === 'remove' && removingChannel === b.ircChannel ? 'Loading…' : 'Remove'}
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>

  {#if actionError}
    <p data-testid="bridge-action-error" class="mb-4 text-sm text-danger">{actionError}</p>
  {/if}

  <Card>
    <h3 class="text-sm font-semibold text-heading">
      {repointTarget ? `Repoint ${repointTarget}` : 'Add bridge'}
    </h3>
    <p class="mt-0.5 text-xs text-muted">
      {repointTarget
        ? 'Move this IRC channel to a different Discord guild/channel. The suffix carries over unless changed.'
        : 'Relay a Discord channel into an IRC channel. The bridge is created on BridgeServ immediately.'}
    </p>

    {#if guildsError}
      <p class="mt-2 text-sm text-danger">{guildsError}</p>
    {/if}

    <div class="mt-3 grid gap-3 sm:grid-cols-2">
      <label class="flex flex-col gap-1 text-xs text-muted">
        IRC channel
        <input
          type="text"
          bind:value={ircChannel}
          placeholder="#dmz"
          aria-label="IRC channel"
          disabled={repointTarget !== null}
          class={input}
        />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        Nick suffix
        <input
          type="text"
          bind:value={suffix}
          placeholder="-d (optional)"
          aria-label="Nick suffix"
          class={input}
        />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        Discord guild
        {#if guildsLoading}
          <span class="py-1.5 text-sm">Loading…</span>
        {:else}
          <select bind:value={guildId} onchange={onGuildChange} aria-label="Discord guild" class={input}>
            <option value="">— pick a guild —</option>
            {#each guilds as g (g.id)}
              <option value={g.id}>{g.name}</option>
            {/each}
          </select>
        {/if}
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">
        Discord channel
        <select
          bind:value={foreignChannel}
          aria-label="Discord channel"
          disabled={!guildId || channelsLoading}
          class="{input} disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">{channelsLoading ? 'Loading…' : '— pick a channel —'}</option>
          {#each discordChannels as c (c.id)}
            <option value={c.id}>{c.name}</option>
          {/each}
        </select>
      </label>
    </div>
    {#if channelsError}
      <p class="mt-2 text-sm text-danger">{channelsError}</p>
    {/if}
    <p class="mt-2 text-xs text-muted">
      The suffix is appended to every bridged nick. Characters outside the IRC
      nickname alphabet need `networkinfo:nick_chars` on the ircd, otherwise
      BridgeServ refuses the bridge.
    </p>

    <div class="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onclick={() => void submit()}
        disabled={acting === 'add' || acting === 'set'}
        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {acting === 'add' || acting === 'set' ? 'Loading…' : repointTarget ? 'Save' : 'Add bridge'}
      </button>
      {#if repointTarget}
        <button type="button" onclick={cancelRepoint} class={btn}>
          Cancel
        </button>
      {/if}
    </div>
  </Card>
{/if}

<ConfirmDialog
  open={removeTarget !== null}
  tone="danger"
  title="Remove this bridge?"
  message={`${removeTarget ?? ''} stops relaying between IRC and Discord and its webhook is deleted. Bridged users leave the IRC channel. This cannot be undone — type the IRC channel name to confirm.`}
  confirmLabel="Remove bridge"
  requireText={removeTarget ?? ''}
  onConfirm={remove}
  onCancel={() => (removeTarget = null)}
/>
