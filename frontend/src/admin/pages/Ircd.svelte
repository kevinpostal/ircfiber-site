<script lang="ts">
  /**
   * Ircd page — InspIRCd management: live overview, channels, bans, config,
   * logs (last hour of ircd + services logs via the SigNoz proxy).
   * Backed by /api/admin/ircd/* (gateway opens a short-lived oper session
   * to ircd:6667). Status polls; channels/bans/config refresh on demand.
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { queryRange } from '../../lib/signoz';
  import { highlightIrcdConf } from '../lib/ircd-highlight';
  import { toastSuccess, toastError } from '../stores/ui';
  import { startPolling } from '../stores/polling';

  interface IrcdUsers {
    users: number; invisible: number; opers: number; unknown: number;
    channels: number; local: number; localMax: number;
    global: number; globalMax: number;
  }
  interface StatusResponse {
    server: string; version: string; versionComment: string;
    uptime: string; maxConnections: string;
    users: IrcdUsers; motd: string[];
  }
  interface ChannelEntry { name: string; users: number; modes: string; topic: string; }
  interface MemberEntry { nick: string; prefix: string; raw: string; }
  interface BanEntry {
    type: 'gline' | 'kline' | 'zline'; mask: string;
    setAt: number; durationSecs: number; setter: string; reason: string;
  }

  type Tab = 'overview' | 'channels' | 'bans' | 'config' | 'logs';
  let tab = $state<Tab>('overview');

  let status = $state<StatusResponse | null>(null);
  let statusError = $state<string | null>(null);
  let loading = $state(false);
  let lastFetchedAt = $state<number | null>(null);

  let channels = $state<ChannelEntry[]>([]);
  let channelsError = $state<string | null>(null);
  let channelsLoading = $state(false);
  let expanded = $state<Record<string, MemberEntry[]>>({});
  let expanding = $state<Record<string, boolean>>({});

  let bans = $state<{ glines: BanEntry[]; klines: BanEntry[]; zlines: BanEntry[] } | null>(null);
  let bansError = $state<string | null>(null);
  let bansLoading = $state(false);
  let newBan = $state({ type: 'gline', mask: '', duration: '1d', reason: '' });

  interface LogEntry { ts: number; service: string; severity: string; body: string; }

  // service.name is the Docker container name (fluent-bit promotes
  // container_name). Both ircd + services share this tab.
  const ircdServices = ['ircfiber-ircd', 'ircfiber-services'];
  let logRows = $state<LogEntry[]>([]);
  let logsError = $state<string | null>(null);
  let logsLoading = $state(false);
  let logFilter = $state('');

  const confFiles = ['inspircd.conf', 'modules.conf', 'opers.conf', 'motd'] as const;
  let confFile = $state<(typeof confFiles)[number]>('inspircd.conf');
  let confContent = $state<string | null>(null);
  let confError = $state<string | null>(null);
  let confLoading = $state(false);

  let stop: (() => void) | null = null;
  onMount(() => {
    // Background ticks stay silent so the KPI cards don't flash their
    // loading skeletons on every refresh (default cadence is 5s).
    stop = startPolling(
      async () => {
        await fetchStatus(false);
        if (tab === 'logs') await fetchLogs(false);
        lastFetchedAt = Date.now();
      },
      { intervalMs: 15_000 },
    );
    void fetchChannels();
    void fetchBans();
  });
  onDestroy(() => stop?.());

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }
  function notConfigured(msg: string): boolean {
    return /not configured/i.test(msg);
  }

  // spinner defaults to first-load only: background polls update values
  // in place instead of flashing skeletons.
  async function fetchStatus(spinner: boolean = status === null) {
    if (spinner) loading = true;
    statusError = null;
    try {
      status = await api.get<StatusResponse>('/api/admin/ircd/status');
    } catch (e) {
      statusError = errMsg(e);
    } finally { loading = false; }
  }

  async function fetchChannels() {
    channelsLoading = true; channelsError = null;
    try {
      const r = await api.get<{ channels: ChannelEntry[] }>('/api/admin/ircd/channels');
      channels = r.channels ?? [];
    } catch (e) {
      channelsError = errMsg(e);
    } finally { channelsLoading = false; }
  }

  async function toggleMembers(name: string) {
    if (expanded[name]) {
      const { [name]: _drop, ...rest } = expanded;
      expanded = rest;
      return;
    }
    expanding = { ...expanding, [name]: true };
    try {
      const r = await api.get<{ members: MemberEntry[] }>('/api/admin/ircd/channel', { channel: name });
      expanded = { ...expanded, [name]: r.members ?? [] };
    } catch (e) {
      toastError(errMsg(e));
    } finally {
      const { [name]: _drop, ...rest } = expanding;
      expanding = rest;
    }
  }

  async function fetchBans() {
    bansLoading = true; bansError = null;
    try {
      bans = await api.get<{ glines: BanEntry[]; klines: BanEntry[]; zlines: BanEntry[] }>('/api/admin/ircd/bans');
    } catch (e) {
      bansError = errMsg(e);
    } finally { bansLoading = false; }
  }

  async function addBan() {
    if (!newBan.mask.trim()) {
      toastError('Mask is required, e.g. *@*.example.com or 192.0.2.10');
      return;
    }
    try {
      await api.post('/api/admin/ircd/bans', {
        type: newBan.type,
        mask: newBan.mask.trim(),
        duration: newBan.duration.trim() || (newBan.type === 'zline' ? '1h' : '1d'),
        reason: newBan.reason.trim(),
      });
      toastSuccess(`Added ${newBan.type} ${newBan.mask.trim()}`);
      newBan = { type: 'gline', mask: '', duration: '1d', reason: '' };
      await fetchBans();
    } catch (e) {
      toastError(errMsg(e));
    }
  }

  async function removeBan(b: BanEntry) {
    if (!confirm(`Remove ${b.type} ${b.mask}?`)) return;
    try {
      await api.post('/api/admin/ircd/bans/delete', { type: b.type, mask: b.mask });
      toastSuccess(`Removed ${b.type} ${b.mask}`);
      await fetchBans();
    } catch (e) {
      toastError(errMsg(e));
    }
  }

  async function rehash() {
    if (!confirm('Rehash ircd (reload inspircd.conf)? Connected users stay online.')) return;
    try {
      const r = await api.post<{ rehashed: string }>('/api/admin/ircd/rehash');
      toastSuccess(`Rehashed ${r.rehashed}`);
      await fetchStatus();
    } catch (e) {
      toastError(errMsg(e));
    }
  }

  function parseLogRow(r: unknown): LogEntry {
    const o = (r ?? {}) as Record<string, unknown>;
    let ms: number;
    if (typeof o.timestamp_nano === 'number') ms = o.timestamp_nano / 1e6;
    else if (typeof o.timestamp === 'number') ms = o.timestamp > 1e14 ? o.timestamp / 1e6 : o.timestamp;
    else ms = Date.now();
    return {
      ts: ms,
      service: typeof o.service_name === 'string' ? o.service_name : '',
      severity: typeof o.severity_text === 'string' ? o.severity_text : 'INFO',
      body: typeof o.body === 'string' ? o.body : '',
    };
  }

  // Last hour of ircd + services logs via the gateway SigNoz proxy
  // (same /api/admin/logs/query_range envelope the Logs page uses).
  async function fetchLogs(spinner: boolean = logRows.length === 0) {
    if (spinner) logsLoading = true;
    logsError = null;
    try {
      const now = Date.now();
      const clauses = [`service.name IN (${ircdServices.map((s) => `'${s}'`).join(',')})`];
      const q = logFilter.trim();
      if (q) clauses.push(`body CONTAINS '${q.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
      const res = await queryRange({
        start: now - 60 * 60 * 1000,
        end: now,
        requestType: 'raw',
        schemaVersion: 'v1',
        compositeQuery: {
          queryType: 'builder',
          panelType: 'list',
          queries: [
            {
              type: 'builder_query',
              spec: {
                name: 'A',
                signal: 'logs',
                stepInterval: null,
                filter: { expression: clauses.join(' AND ') },
              },
            },
          ],
        },
      });
      const data = (res?.data ?? {}) as Record<string, { list?: unknown[] }>;
      const list = data['A']?.list;
      logRows = (Array.isArray(list) ? list : []).slice(-200).map(parseLogRow);
    } catch (e) {
      logsError = errMsg(e);
    } finally {
      logsLoading = false;
    }
  }

  function fmtTime(ms: number): string {
    return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
  }

  function sevClass(sev: string): string {
    const s = sev.toUpperCase();
    if (s.includes('ERROR') || s.includes('FATAL')) return 'text-danger';
    if (s.includes('WARN')) return 'text-amber-500';
    return 'text-muted';
  }

  async function fetchConfig() {
    confLoading = true; confError = null; confContent = null;
    try {
      const r = await api.get<{ content: string }>('/api/admin/ircd/config', { file: confFile });
      confContent = r.content;
    } catch (e) {
      confError = errMsg(e);
    } finally { confLoading = false; }
  }

  function fmtDuration(secs: number): string {
    if (secs <= 0) return 'permanent';
    if (secs < 3600) return `${Math.round(secs / 60)}m`;
    if (secs < 86400) return `${Math.round(secs / 3600)}h`;
    return `${Math.round(secs / 86400)}d`;
  }
  function fmtSetAt(unix: number): string {
    if (!unix) return '—';
    return new Date(unix * 1000).toLocaleString();
  }

  const banGroups = $derived([
    { label: 'G-lines', entries: bans?.glines ?? [] },
    { label: 'K-lines', entries: bans?.klines ?? [] },
    { label: 'Z-lines', entries: bans?.zlines ?? [] },
  ]);
  const totalBans = $derived((bans?.glines.length ?? 0) + (bans?.klines.length ?? 0) + (bans?.zlines.length ?? 0));

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'channels', label: 'Channels' },
    { id: 'bans', label: 'Bans' },
    { id: 'config', label: 'Config' },
    { id: 'logs', label: 'Logs' },
  ];
</script>

<PageHeader
  title="IRCD"
  subtitle={status?.server ? `${status.server} · ${status.version} · ${status.versionComment}` : 'InspIRCd management'}
>
  {#snippet actions()}
    <button
      type="button"
      onclick={() => { void fetchStatus(true); void fetchChannels(); void fetchBans(); }}
      class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm hover:border-primary/40"
    >
      Refresh
    </button>
    <button
      type="button"
      onclick={() => void rehash()}
      class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg hover:bg-primary/90"
    >
      Rehash
    </button>
  {/snippet}
</PageHeader>

{#if statusError && notConfigured(statusError)}
  <Card>
    <EmptyState
      title="IRCd management is not configured"
      hint="Set IRCFIBER_IRCD_HOST, IRCFIBER_IRCD_OPER and IRCFIBER_IRCD_OPER_PASSWORD on the gateway (deploy writes them from vault_ircd_dashboard_password), then redeploy the gateway."
    />
  </Card>
{:else}
  <div class="mb-4 flex gap-1 border-b border-border">
    {#each tabs as t}
      <button
        type="button"
        onclick={() => {
          tab = t.id;
          if (t.id === 'config' && confContent === null && !confLoading) void fetchConfig();
          if (t.id === 'logs' && logRows.length === 0 && !logsLoading) void fetchLogs();
        }}
        class="px-4 py-2 text-sm font-medium transition {tab === t.id
          ? 'border-b-2 border-primary text-heading'
          : 'text-muted hover:text-text'}"
      >
        {t.label}
        {#if t.id === 'bans' && totalBans > 0}
          <span class="ml-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-primary">{totalBans}</span>
        {/if}
        {#if t.id === 'channels' && channels.length > 0}
          <span class="ml-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-primary">{channels.length}</span>
        {/if}
      </button>
    {/each}
  </div>

  {#if tab === 'overview'}
    {#if statusError}
      <Card><p class="text-sm text-danger">{statusError}</p></Card>
    {:else if status}
      <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Users" value={status.users.global >= 0 ? status.users.global : '—'} {loading} />
        <KpiCard label="Channels" value={status.users.channels >= 0 ? status.users.channels : '—'} {loading} />
        <KpiCard label="Opers" value={status.users.opers >= 0 ? status.users.opers : '—'} {loading} />
        <KpiCard label="Local max" value={status.users.localMax >= 0 ? `${status.users.local}/${status.users.localMax}` : '—'} {loading} />
      </div>
      <div class="grid gap-4 md:grid-cols-2">
        <Card>
          <h3 class="mb-2 text-sm font-semibold text-heading">Server</h3>
          <dl class="space-y-1 text-sm">
            <div class="flex justify-between gap-4"><dt class="text-muted">Uptime</dt><dd class="font-mono">{status.uptime || '—'}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-muted">Peak connections</dt><dd class="font-mono text-xs">{status.maxConnections || '—'}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-muted">Invisible</dt><dd class="font-mono">{status.users.invisible >= 0 ? status.users.invisible : '—'}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-muted">Unknown conns</dt><dd class="font-mono">{status.users.unknown >= 0 ? status.users.unknown : '—'}</dd></div>
          </dl>
        </Card>
        <Card>
          <h3 class="mb-2 text-sm font-semibold text-heading">Message of the day</h3>
          {#if status.motd.length === 0}
            <p class="text-sm text-muted">(empty)</p>
          {:else}
            <pre class="max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-text">{status.motd.join('\n')}</pre>
          {/if}
        </Card>
      </div>
    {:else}
      <Card><p class="text-sm text-muted">Loading…</p></Card>
    {/if}
  {:else if tab === 'channels'}
    <Card>
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-heading">Channels ({channels.length})</h3>
        <button
          type="button"
          onclick={() => void fetchChannels()}
          class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
        >
          {channelsLoading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {#if channelsError}
        <p class="text-sm text-danger">{channelsError}</p>
      {:else if channels.length === 0}
        <EmptyState title="No channels" hint="No visible channels right now." />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                <th class="py-2 pr-4">Channel</th>
                <th class="py-2 pr-4">Users</th>
                <th class="py-2 pr-4">Modes</th>
                <th class="py-2 pr-4">Topic</th>
                <th class="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {#each channels as c}
                <tr class="border-b border-border/50 last:border-0">
                  <td class="py-2 pr-4 font-mono font-semibold">{c.name}</td>
                  <td class="py-2 pr-4 font-mono">{c.users}</td>
                  <td class="py-2 pr-4 font-mono text-muted">{c.modes || '—'}</td>
                  <td class="max-w-md truncate py-2 pr-4 text-muted">{c.topic || '—'}</td>
                  <td class="py-2 text-right">
                    <button
                      type="button"
                      onclick={() => void toggleMembers(c.name)}
                      class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
                    >
                      {expanded[c.name] ? 'Hide' : expanding[c.name] ? '…' : 'Members'}
                    </button>
                  </td>
                </tr>
                {#if expanded[c.name]}
                  <tr class="border-b border-border/50 bg-surface-2/50">
                    <td colspan="5" class="px-4 py-2">
                      <div class="flex flex-wrap gap-1.5">
                        {#each expanded[c.name] as m}
                          <span class="rounded bg-border/40 px-2 py-0.5 font-mono text-xs" title={m.prefix ? `status: ${m.prefix}` : 'no status'}>
                            {m.prefix}{m.nick}
                          </span>
                        {/each}
                      </div>
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Card>
  {:else if tab === 'bans'}
    <Card>
      <h3 class="mb-3 text-sm font-semibold text-heading">Add ban</h3>
      <form
        class="grid gap-2 md:grid-cols-[110px_1fr_110px_1fr_auto]"
        onsubmit={(e) => { e.preventDefault(); void addBan(); }}
      >
        <select bind:value={newBan.type} class="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm" aria-label="Ban type">
          <option value="gline">G-line</option>
          <option value="kline">K-line</option>
          <option value="zline">Z-line</option>
        </select>
        <input
          bind:value={newBan.mask}
          placeholder={newBan.type === 'zline' ? 'IP, e.g. 192.0.2.10' : 'Mask, e.g. *@*.example.com'}
          class="rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm"
          aria-label="Ban mask"
        />
        <input
          bind:value={newBan.duration}
          placeholder="1d"
          title="Duration: 30m, 1h, 7d, or 0 for permanent"
          class="rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm"
          aria-label="Duration"
        />
        <input
          bind:value={newBan.reason}
          placeholder="Reason (optional)"
          class="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm"
          aria-label="Reason"
        />
        <button type="submit" class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg hover:bg-primary/90">
          Ban
        </button>
      </form>
      <dl class="mt-3 grid gap-2 text-xs text-muted md:grid-cols-3">
        <div class="rounded-md border border-border/60 bg-surface-2/50 p-2">
          <dt class="font-semibold text-text">G-line — network-wide user@host ban</dt>
          <dd class="mt-0.5">Matches <code class="font-mono">user@host</code> masks on every server. Use for abusive users and hostnames. E.g. <code class="font-mono">spammer@*.example.com</code>.</dd>
        </div>
        <div class="rounded-md border border-border/60 bg-surface-2/50 p-2">
          <dt class="font-semibold text-text">K-line — this-server user@host ban</dt>
          <dd class="mt-0.5">Same mask format as a G-line but enforced only on irc.ircfiber.com. Use for server-local abuse that shouldn't affect the whole network.</dd>
        </div>
        <div class="rounded-md border border-border/60 bg-surface-2/50 p-2">
          <dt class="font-semibold text-text">Z-line — IP block before registration</dt>
          <dd class="mt-0.5">Matches raw IPs only, rejected before registration completes — ident changes can't evade it. Use for bots and IP-based floods. E.g. <code class="font-mono">192.0.2.10</code>.</dd>
        </div>
      </dl>
      <p class="mt-2 text-xs text-muted">Additions are confirmed against the live list. Duration 0 is permanent.</p>
    </Card>
    <div class="mt-4 space-y-4">
      {#if bansError}
        <Card><p class="text-sm text-danger">{bansError}</p></Card>
      {:else}
        {#each banGroups as g}
          <Card>
            <div class="mb-2 flex items-center justify-between">
              <h3 class="text-sm font-semibold text-heading">{g.label} ({g.entries.length})</h3>
              <button
                type="button"
                onclick={() => void fetchBans()}
                class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
              >
                {bansLoading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
            {#if g.entries.length === 0}
              <p class="text-sm text-muted">None.</p>
            {:else}
              <div class="overflow-x-auto">
                <table class="w-full text-left text-sm">
                  <thead>
                    <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                      <th class="py-2 pr-4">Mask</th>
                      <th class="py-2 pr-4">Set by</th>
                      <th class="py-2 pr-4">Set at</th>
                      <th class="py-2 pr-4">Expires</th>
                      <th class="py-2 pr-4">Reason</th>
                      <th class="py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each g.entries as b}
                      <tr class="border-b border-border/50 last:border-0">
                        <td class="py-2 pr-4 font-mono">{b.mask}</td>
                        <td class="py-2 pr-4">{b.setter}</td>
                        <td class="py-2 pr-4 text-muted">{fmtSetAt(b.setAt)}</td>
                        <td class="py-2 pr-4 font-mono">{fmtDuration(b.durationSecs)}</td>
                        <td class="max-w-xs truncate py-2 pr-4 text-muted">{b.reason || '—'}</td>
                        <td class="py-2 text-right">
                          <button
                            type="button"
                            onclick={() => void removeBan(b)}
                            class="rounded-md border border-danger/40 px-2.5 py-1 text-xs text-danger hover:bg-danger/10"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </Card>
        {/each}
      {/if}
    </div>
  {:else if tab === 'config'}
    <Card>
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <select
          bind:value={confFile}
          onchange={() => void fetchConfig()}
          class="rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm"
          aria-label="Config file"
        >
          {#each confFiles as f}
            <option value={f}>{f}</option>
          {/each}
        </select>
        <button
          type="button"
          onclick={() => void fetchConfig()}
          class="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs hover:border-primary/40"
        >
          {confLoading ? 'Loading…' : 'Reload'}
        </button>
        <span class="text-xs text-muted">Read-only · secrets shown as <code>***REDACTED***</code> · edits stay in Ansible</span>
      </div>
      {#if confError}
        <p class="text-sm text-danger">{confError}</p>
      {:else if confContent !== null}
        <pre class="max-h-[60vh] overflow-auto whitespace-pre font-mono text-xs leading-relaxed text-text">{@html highlightIrcdConf(confContent)}</pre>
      {:else}
        <p class="text-sm text-muted">Loading…</p>
      {/if}
    </Card>
  {:else if tab === 'logs'}
    <Card>
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <form
          class="flex min-w-52 flex-1 gap-2"
          onsubmit={(e) => { e.preventDefault(); void fetchLogs(true); }}
        >
          <input
            bind:value={logFilter}
            placeholder="Filter, e.g. netcrave or CAPAB"
            class="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-sm"
            aria-label="Log text filter"
          />
          <button type="submit" class="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs hover:border-primary/40">
            Search
          </button>
        </form>
        <button
          type="button"
          onclick={() => void fetchLogs(true)}
          class="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs hover:border-primary/40"
        >
          {logsLoading ? 'Loading…' : 'Refresh'}
        </button>
        <span class="text-xs text-muted">Last hour · ircfiber-ircd + ircfiber-services · via SigNoz</span>
      </div>
      {#if logsError}
        <p class="text-sm text-danger">{logsError}</p>
      {:else if logsLoading && logRows.length === 0}
        <p class="text-sm text-muted">Loading…</p>
      {:else if logRows.length === 0}
        <EmptyState title="No ircd logs" description="Nothing from ircfiber-ircd or ircfiber-services in the last hour. If SigNoz is unreachable this shows the proxy error instead." />
      {:else}
        <div class="max-h-[60vh] space-y-0.5 overflow-auto font-mono text-xs leading-relaxed">
          {#each logRows as r}
            <div class="flex gap-2 border-b border-border/30 py-0.5 last:border-0">
              <span class="shrink-0 text-muted" title={new Date(r.ts).toLocaleString()}>{fmtTime(r.ts)}</span>
              <span class="shrink-0 text-primary">{r.service.replace('ircfiber-', '')}</span>
              <span class="shrink-0 {sevClass(r.severity)}">{r.severity}</span>
              <span class="min-w-0 flex-1 whitespace-pre-wrap break-words text-text">{r.body}</span>
            </div>
          {/each}
        </div>
      {/if}
    </Card>
  {/if}
{/if}
