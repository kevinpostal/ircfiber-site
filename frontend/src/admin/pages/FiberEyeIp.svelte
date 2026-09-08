<script lang="ts">
  /**
   * FiberEyeIp — per-address detail for one FiberEye IP group.
   * Route: /fibereye/ip/:ip — the group is URL-encoded in the hash because
   * an IPv6 group ("2603:8001:98f0:1530::/64") contains both ':' and '/'.
   *
   * The `zline` in the payload is the live `STATS Z` entry, not a Mongo
   * row: it is what the ircd is actually enforcing right now.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { duration, relative } from '../lib/format';
  import { href } from '../lib/router';

  interface BanRow {
    id: string; mask: string; ipGroup: string; type: string; rule: string;
    reason: string; durationSeconds: number; placedAtMs: number; expiresAtMs: number;
    strikes: number; observeOnly: boolean; placed: boolean; placeError: string;
    releasedAtMs: number; releasedBy: string;
    evidence: { connects: number; nicks: number; shortSessions: number; windowSeconds: number };
    state: string;
  }
  interface SessionRow {
    id: string; ts: number; nick: string; ident: string; host: string; ip: string;
    ipGroup: string; ipVersion: number; realname: string; connClass: string;
    port: number; tls: boolean; account: string;
    quitTs: number; quitReason: string; durationMs: number;
    geoCity: string; geoRegion: string; geoCountry: string; geoOrg: string;
    geoTimezone: string; geoPrivacy: string; geoPending: boolean;
  }
  interface IpRollup {
    ipGroup: string; ip: string; ipVersion: number;
    firstSeen: number; lastSeen: number; connects: number; shortSessions: number;
    lastNick: string; lastAccount: string; lastRealname: string; lastClass: string;
    geoCity: string; geoRegion: string; geoCountry: string; geoOrg: string;
    geoTimezone: string; geoPrivacy: string; geoPending: boolean;
    strikes: number; bannedUntil: number; lastBanId: string;
  }
  interface ZLine {
    mask: string; setAtMs: number; durationSecs: number; setter: string;
    reason: string; autoPlaced: boolean;
  }
  interface IpDetail {
    ip: string;
    rollup: IpRollup | null;
    sessions: SessionRow[];
    distinctNicks: string[];
    distinctAccounts: string[];
    bans: BanRow[];
    zline: ZLine | null;
  }

  interface Props { ip?: string; }
  let { ip }: Props = $props();

  let data = $state<IpDetail | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  onMount(() => void load());

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  async function load() {
    if (!ip) return;
    loading = true;
    error = null;
    try {
      data = await api.get<IpDetail>('/api/admin/fibereye/ip', { ip });
    } catch (e) {
      error = errMsg(e);
    } finally { loading = false; }
  }

  async function release(banId: string, mask: string) {
    if (!banId) return;
    try {
      const r = await api.post<{ released: boolean; observeOnly: boolean }>(
        '/api/admin/fibereye/bans/release', { banId });
      toastSuccess(r.observeOnly
        ? `Cleared the observed ban for ${mask}`
        : `Removed the Z-line for ${mask}`);
      await load();
    } catch (e) {
      toastError(errMsg(e));
    }
  }

  const rollup = $derived(data?.rollup ?? null);
  const banned = $derived((rollup?.bannedUntil ?? 0) > Date.now());
  const geo = $derived.by(() => {
    const r = rollup;
    if (!r) return '—';
    const place = [r.geoCity, r.geoRegion, r.geoCountry].filter(Boolean).join(', ');
    if (place) return place;
    return r.geoPending ? 'geo pending' : '—';
  });
  const banTone = (state: string): 'danger' | 'warn' | 'muted' =>
    state === 'active' ? 'danger' : state === 'observed' ? 'warn' : 'muted';
</script>

<PageHeader
  title={ip ?? '—'}
  subtitle="Every connect FiberEye recorded for this address group"
  breadcrumbs={[{ label: 'FiberEye', href: href('/fibereye') }, { label: ip ?? '—' }]}
>
  {#snippet actions()}
    <button
      type="button"
      onclick={() => void load()}
      disabled={loading}
      class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
    >
      {loading ? 'Loading…' : 'Refresh'}
    </button>
    {#if banned && rollup?.lastBanId}
      <button
        type="button"
        onclick={() => void release(rollup?.lastBanId ?? '', rollup?.ipGroup ?? '')}
        class="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/20"
      >
        Release
      </button>
    {/if}
  {/snippet}
</PageHeader>

{#if error}
  <Card><p class="text-sm text-danger">{error}</p></Card>
{:else if data}
  <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
    <KpiCard label="Connects" value={rollup?.connects ?? 0} {loading} />
    <KpiCard label="Short sessions" value={rollup?.shortSessions ?? 0} {loading} />
    <KpiCard label="Distinct nicks" value={data.distinctNicks.length} {loading} />
    <KpiCard
      label="Strikes"
      value={rollup?.strikes ?? 0}
      tone={(rollup?.strikes ?? 0) > 0 ? 'warn' : 'default'}
      {loading}
    />
  </div>

  <Card title="Rollup">
    {#snippet actions()}
      <StatusBadge
        label={banned ? 'Banned' : (rollup?.strikes ?? 0) > 0 ? 'Struck' : 'Seen'}
        tone={banned ? 'danger' : (rollup?.strikes ?? 0) > 0 ? 'warn' : 'muted'}
        size="sm"
      />
    {/snippet}
    {#if rollup}
      <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div class="flex justify-between gap-4"><dt class="text-muted">IP group</dt><dd class="font-mono">{rollup.ipGroup}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">Last address</dt><dd class="font-mono">{rollup.ip} (v{rollup.ipVersion})</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">First seen</dt><dd class="font-mono text-xs">{relative(rollup.firstSeen)}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">Last seen</dt><dd class="font-mono text-xs">{relative(rollup.lastSeen)}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">Last nick</dt><dd class="font-mono">{rollup.lastNick || '—'}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">Last account</dt><dd class="font-mono">{rollup.lastAccount || '—'}</dd></div>
        <div class="flex justify-between gap-4"><dt class="shrink-0 text-muted">Last real name</dt><dd class="min-w-0 truncate text-right text-xs" title={rollup.lastRealname}>{rollup.lastRealname || '—'}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">Last class</dt><dd class="font-mono">{rollup.lastClass || '—'}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">Location</dt><dd class="text-right text-xs">{geo}</dd></div>
        <div class="flex justify-between gap-4"><dt class="shrink-0 text-muted">Network</dt><dd class="min-w-0 truncate text-right text-xs" title={rollup.geoOrg}>{rollup.geoOrg || '—'}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">Timezone</dt><dd class="font-mono text-xs">{rollup.geoTimezone || '—'}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">Privacy</dt><dd class="font-mono text-xs">{rollup.geoPrivacy || '—'}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">Banned until</dt><dd class="font-mono text-xs">{rollup.bannedUntil > 0 ? relative(rollup.bannedUntil) : '—'}</dd></div>
      </dl>
    {:else}
      <p class="text-sm text-muted">
        No rollup for this address — nothing has connected from it inside the retention window.
      </p>
    {/if}

    <div class="mt-4 border-t border-border pt-3">
      <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Live Z-line</h3>
      {#if data.zline}
        <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div class="flex justify-between gap-4"><dt class="text-muted">Mask</dt><dd class="font-mono">{data.zline.mask}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Setter</dt><dd class="font-mono">{data.zline.setter || '—'}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Set</dt><dd class="font-mono text-xs">{relative(data.zline.setAtMs)}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Lasts</dt><dd class="font-mono text-xs">{data.zline.durationSecs > 0 ? duration(data.zline.durationSecs * 1000) : 'permanent'}</dd></div>
          <div class="flex justify-between gap-4 sm:col-span-2"><dt class="shrink-0 text-muted">Reason</dt><dd class="min-w-0 text-right text-xs" title={data.zline.reason}>{data.zline.reason}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Placed by FiberEye</dt><dd class="font-mono text-xs">{data.zline.autoPlaced ? 'yes' : 'no — set by a human oper'}</dd></div>
        </dl>
      {:else}
        <p class="text-sm text-muted">—</p>
      {/if}
    </div>

    <div class="mt-4 grid gap-4 border-t border-border pt-3 md:grid-cols-2">
      <div>
        <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">
          Nicks ({data.distinctNicks.length})
        </h3>
        {#if data.distinctNicks.length === 0}
          <p class="text-sm text-muted">—</p>
        {:else}
          <div class="flex flex-wrap gap-1">
            {#each data.distinctNicks as n (n)}
              <span class="rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-xs">{n}</span>
            {/each}
          </div>
        {/if}
      </div>
      <div>
        <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">
          Accounts ({data.distinctAccounts.length})
        </h3>
        {#if data.distinctAccounts.length === 0}
          <p class="text-sm text-muted">—</p>
        {:else}
          <div class="flex flex-wrap gap-1">
            {#each data.distinctAccounts as a (a)}
              <span class="rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-xs">{a}</span>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </Card>

  <div class="mt-4">
    <Card>
      <h3 class="mb-3 text-sm font-semibold text-heading">Bans ({data.bans.length})</h3>
      {#if data.bans.length === 0}
        <EmptyState title="No bans" description="No FiberEye rule has ever tripped for this address." />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                <th class="py-2 pr-4">Mask</th>
                <th class="py-2 pr-4">Rule</th>
                <th class="py-2 pr-4">Placed</th>
                <th class="py-2 pr-4">Expires</th>
                <th class="py-2 pr-4">Strikes</th>
                <th class="py-2 pr-4">State</th>
                <th class="py-2 pr-4">Evidence</th>
                <th class="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {#each data.bans as b (b.id)}
                <tr class="border-b border-border/50 last:border-0">
                  <td class="py-2 pr-4 font-mono">{b.mask}</td>
                  <td class="py-2 pr-4 font-mono text-muted">{b.rule}</td>
                  <td class="py-2 pr-4 font-mono text-muted">{relative(b.placedAtMs)}</td>
                  <td class="py-2 pr-4 font-mono text-muted">{relative(b.expiresAtMs)}</td>
                  <td class="py-2 pr-4 font-mono">{b.strikes}</td>
                  <td class="py-2 pr-4"><StatusBadge label={b.state} tone={banTone(b.state)} size="sm" /></td>
                  <td class="py-2 pr-4 font-mono text-xs text-muted">
                    {b.evidence.connects} connects · {b.evidence.nicks} nicks ·
                    {b.evidence.shortSessions} short / {b.evidence.windowSeconds}s
                  </td>
                  <td class="py-2 text-right">
                    {#if b.state === 'active' || b.state === 'observed'}
                      <button
                        type="button"
                        onclick={() => void release(b.id, b.mask)}
                        class="rounded-md border border-danger/40 bg-surface-2 px-2.5 py-1 text-xs text-danger hover:border-danger"
                      >
                        Release
                      </button>
                    {:else}
                      <span class="text-xs text-muted">{b.releasedBy || '—'}</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Card>
  </div>

  <div class="mt-4">
    <Card>
      <h3 class="mb-3 text-sm font-semibold text-heading">Sessions ({data.sessions.length})</h3>
      {#if data.sessions.length === 0}
        <EmptyState
          title="No sessions"
          description="Nothing has connected from this address inside the retention window."
        />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                <th class="py-2 pr-4">When</th>
                <th class="py-2 pr-4">Nick</th>
                <th class="py-2 pr-4">Ident</th>
                <th class="py-2 pr-4">Account</th>
                <th class="py-2 pr-4">Address</th>
                <th class="py-2 pr-4">Real name</th>
                <th class="py-2 pr-4">Class</th>
                <th class="py-2 pr-4">Port</th>
                <th class="py-2 pr-4">Duration</th>
                <th class="py-2 pr-4">Quit</th>
              </tr>
            </thead>
            <tbody>
              {#each data.sessions as s (s.id)}
                <tr class="border-b border-border/50 last:border-0">
                  <td class="py-2 pr-4 font-mono text-muted">{relative(s.ts)}</td>
                  <td class="py-2 pr-4 font-mono">{s.nick}</td>
                  <td class="py-2 pr-4 font-mono text-muted">{s.ident || '—'}</td>
                  <td class="py-2 pr-4 font-mono text-muted">{s.account || '—'}</td>
                  <td class="py-2 pr-4 font-mono text-xs">{s.ip}</td>
                  <td class="max-w-xs truncate py-2 pr-4 text-xs text-muted" title={s.realname}>{s.realname || '—'}</td>
                  <td class="py-2 pr-4 font-mono text-muted">{s.connClass || '—'}</td>
                  <td class="py-2 pr-4 font-mono text-muted">{s.port}{s.tls ? ' TLS' : ''}</td>
                  <td class="py-2 pr-4 font-mono">
                    {#if s.quitTs === 0}
                      <span class="text-success">open</span>
                    {:else}
                      {duration(s.durationMs)}
                    {/if}
                  </td>
                  <td class="max-w-xs truncate py-2 pr-4 text-xs text-muted" title={s.quitReason}>{s.quitReason || '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Card>
  </div>
{:else}
  <Card><p class="text-sm text-muted">Loading…</p></Card>
{/if}
