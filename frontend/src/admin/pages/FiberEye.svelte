<script lang="ts">
  /**
   * FiberEye page — the connection watch: every ircd connect/quit the bot
   * recorded, the per-IP rollups it counts against the flood thresholds,
   * and the Z-lines it placed (or would place, while disarmed).
   *
   * Backed by /api/admin/fibereye/*. Enforcement ships disarmed: the Arm
   * button flips the `fibereye:armed` Redis key the bot reads, so it is
   * behind a confirmation — arming turns candidate rows into real bans.
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import FiberEyeBotCard from '../components/FiberEyeBotCard.svelte';
  import FiberEyeRulesCard from '../components/FiberEyeRulesCard.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { startPolling } from '../stores/polling';
  import { duration, relative } from '../lib/format';
  import { href } from '../lib/router';

  interface Counters {
    connects24h: number; quits24h: number; uniqueIps24h: number;
    sessionsOpen: number; bansActive: number; bansObserved24h: number;
    releases24h: number;
  }
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
    geoTimezone: string; geoPending: boolean;
    intelAsn: string; intelFlags: string; intelOperator: string; intelPrefix: string;
    intelRisk: number; intelAt: number;
  }
  interface IpRow {
    ipGroup: string; ip: string; ipVersion: number;
    firstSeen: number; lastSeen: number; connects: number; shortSessions: number;
    lastNick: string; lastAccount: string; lastRealname: string; lastClass: string;
    geoCity: string; geoRegion: string; geoCountry: string; geoOrg: string;
    geoTimezone: string; geoPending: boolean;
    intelAsn: string; intelFlags: string; intelOperator: string; intelPrefix: string;
    intelRisk: number; intelAt: number;
    strikes: number; bannedUntil: number; lastBanId: string;
  }
  interface Overview {
    armed: boolean;
    /** The bot heartbeat; rendered by FiberEyeBotCard, which fetches its own copy. */
    bot: Record<string, unknown> | null;
    alive: boolean;
    heartbeatAgeMs: number;
    runsInThisProcess: boolean;
    expectedNick: string;
    counters: Counters;
    candidates: BanRow[];
    recentBans: BanRow[];
  }
  interface Paged<T> { rows: T[]; total: number; page: number; limit: number; }

  const LIMIT = 50;

  let overview = $state<Overview | null>(null);
  let overviewError = $state<string | null>(null);
  let loading = $state(false);

  /// The ircd's own connect limits, read from its rendered config. Fetched
  /// once: these are deploy artifacts, not runtime state.
  interface IrcdRules {
    available: boolean;
    path: string;
    connectban: Record<string, string>;
    connflood: Record<string, string>;
    reason: string;
  }
  let ircdRules = $state<IrcdRules | null>(null);

  type Tab = 'sessions' | 'ips' | 'bans';
  let tab = $state<Tab>('sessions');
  let page = $state(0);
  /// The raw input value, and the debounced value the fetches actually use.
  let q = $state('');
  let qApplied = $state('');

  let sessions = $state<Paged<SessionRow> | null>(null);
  let ips = $state<Paged<IpRow> | null>(null);
  let bans = $state<Paged<BanRow> | null>(null);
  let tabError = $state<string | null>(null);
  let tabLoading = $state(false);
  /// A tab switch or a keystroke can outrun an in-flight page: only the
  /// newest request is allowed to write state.
  let seq = 0;

  let armBusy = $state(false);
  let ask = $state<'arm' | null>(null);

  /// 200 ms trailing debounce — the same shape as the logs toolbar's.
  let qDebounce: ReturnType<typeof setTimeout> | null = null;
  function onQueryInput(e: Event): void {
    const v = (e.currentTarget as HTMLInputElement).value;
    q = v;
    if (qDebounce) clearTimeout(qDebounce);
    qDebounce = setTimeout(() => {
      qDebounce = null;
      qApplied = v;
    }, 200);
  }

  let stop: (() => void) | null = null;
  onMount(() => {
    stop = startPolling(
      async () => { await fetchOverview(false); },
      { intervalMs: 30_000 },
    );
    void fetchIrcdRules();
  });
  onDestroy(() => {
    if (qDebounce) clearTimeout(qDebounce);
    stop?.();
  });

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  async function fetchOverview(spinner: boolean = overview === null) {
    if (spinner) loading = true;
    overviewError = null;
    try {
      overview = await api.get<Overview>('/api/admin/fibereye');
    } catch (e) {
      overviewError = errMsg(e);
    } finally { loading = false; }
  }

  /// Never fails the page: the endpoint answers 200 with `available:false`
  /// when the ircd conf dir is not mounted into the gateway.
  async function fetchIrcdRules() {
    try {
      ircdRules = await api.get<IrcdRules>('/api/admin/fibereye/ircd-rules');
    } catch {
      ircdRules = null;
    }
  }

  async function fetchTab(kind: Tab, p: number, needle: string) {
    const mine = ++seq;
    tabLoading = true;
    tabError = null;
    try {
      if (kind === 'sessions') {
        const r = await api.get<Paged<SessionRow>>('/api/admin/fibereye/sessions', {
          page: p, limit: LIMIT, q: needle || undefined,
        });
        if (mine === seq) sessions = r;
      } else if (kind === 'ips') {
        const r = await api.get<Paged<IpRow>>('/api/admin/fibereye/ips', {
          page: p, limit: LIMIT, q: needle || undefined, sort: 'lastSeen', state: 'all',
        });
        if (mine === seq) ips = r;
      } else {
        const r = await api.get<Paged<BanRow>>('/api/admin/fibereye/bans', {
          page: p, limit: LIMIT, state: 'all',
        });
        if (mine === seq) bans = r;
      }
    } catch (e) {
      if (mine === seq) tabError = errMsg(e);
    } finally {
      if (mine === seq) tabLoading = false;
    }
  }

  // A new tab or a new needle always starts at the first page, or the pager
  // would ask for a page the filtered result set does not have.
  $effect(() => { void tab; void qApplied; page = 0; });
  $effect(() => { void fetchTab(tab, page, qApplied); });

  const current = $derived<Paged<SessionRow> | Paged<IpRow> | Paged<BanRow> | null>(
    tab === 'sessions' ? sessions : tab === 'ips' ? ips : bans);
  const pageCount = $derived(Math.max(1, Math.ceil((current?.total ?? 0) / LIMIT)));

  async function goToPage(p: number) {
    const next = Math.min(Math.max(0, p), pageCount - 1);
    if (next === page) return;
    page = next;
  }

  function geoShort(r: { geoCity: string; geoCountry: string; geoOrg: string; geoPending: boolean }): string {
    const place = [r.geoCity, r.geoCountry].filter(Boolean).join(', ');
    if (place) return place;
    if (r.geoOrg) return r.geoOrg;
    return r.geoPending ? 'intel pending' : '—';
  }

  /** `vpn(Mullvad)+tor+hosting` → one chip per confirmed flag, toned by severity. */
  function flagChips(label: string): { text: string; tone: 'primary' | 'danger' | 'muted' }[] {
    if (!label) return [];
    return label.split('+').filter(Boolean).map((f) => ({
      text: f,
      tone: f.startsWith('vpn') ? 'primary' : f === 'tor' || f === 'proxy' || f === 'residential-proxy' ? 'danger' : 'muted',
    }));
  }

  function ipHref(ipGroup: string): string {
    // IPv6 groups contain ':' and '/', both of which are path syntax.
    return href('/fibereye/ip/' + encodeURIComponent(ipGroup));
  }

  const banTone = (state: string): 'danger' | 'warn' | 'muted' =>
    state === 'active' ? 'danger' : state === 'observed' ? 'warn' : 'muted';

  function confirmArm() {
    if (armBusy) return;
    ask = 'arm';
  }

  async function setArmed(armed: boolean) {
    armBusy = true;
    try {
      const r = await api.post<{ armed: boolean }>('/api/admin/fibereye/arm', { armed });
      toastSuccess(r.armed ? 'FiberEye is enforcing — floods are Z-lined' : 'FiberEye is observing only');
      ask = null;
      await fetchOverview(false);
    } catch (e) {
      toastError(errMsg(e));
    } finally { armBusy = false; }
  }

  async function release(banId: string, mask: string) {
    if (!banId) return;
    try {
      const r = await api.post<{ released: boolean; observeOnly: boolean }>(
        '/api/admin/fibereye/bans/release', { banId });
      toastSuccess(r.observeOnly
        ? `Cleared the observed ban for ${mask}`
        : `Removed the Z-line for ${mask}`);
      await fetchOverview(false);
      await fetchTab(tab, page, qApplied);
    } catch (e) {
      toastError(errMsg(e));
    }
  }
</script>

<PageHeader
  title="FiberEye"
  subtitle="Every ircd connect and quit, per-IP flood detection and the Z-lines it places"
>
  {#snippet actions()}
    <button
      type="button"
      onclick={() => void fetchOverview(true)}
      disabled={loading}
      class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
    >
      {loading ? 'Loading…' : 'Refresh'}
    </button>
    {#if overview?.armed}
      <button
        type="button"
        onclick={() => void setArmed(false)}
        disabled={armBusy}
        class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
      >
        Disarm enforcement
      </button>
    {:else}
      <button
        type="button"
        onclick={confirmArm}
        disabled={armBusy || overview === null}
        class="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/20 disabled:opacity-40"
      >
        Arm enforcement
      </button>
    {/if}
  {/snippet}
</PageHeader>

{#if overviewError}
  <Card><p class="text-sm text-danger">{overviewError}</p></Card>
{:else if overview}
  <div class="mb-4 flex items-center gap-3">
    <StatusBadge
      label={overview.armed ? 'Enforcing' : 'Observing'}
      tone={overview.armed ? 'warn' : 'muted'}
    />
    <span class="text-xs text-muted">
      {overview.armed
        ? 'A tripped rule places a timed Z-line on the ircd.'
        : 'Rules are evaluated and recorded, but no Z-line is placed.'}
    </span>
  </div>

  <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
    <KpiCard label="Connects (24 h)" value={overview.counters.connects24h} {loading} />
    <KpiCard label="Unique IPs (24 h)" value={overview.counters.uniqueIps24h} {loading} />
    <KpiCard label="Open sessions" value={overview.counters.sessionsOpen} {loading} />
    <KpiCard label="Active bans" value={overview.counters.bansActive} {loading} tone={overview.counters.bansActive > 0 ? 'danger' : 'default'} />
    <KpiCard label="Would-ban (24 h)" value={overview.counters.bansObserved24h} {loading} tone={overview.counters.bansObserved24h > 0 ? 'warn' : 'default'} />
    <KpiCard label="Self-releases (24 h)" value={overview.counters.releases24h} {loading} />
  </div>

  <FiberEyeBotCard />

  <div class="mt-4">
    <FiberEyeRulesCard />
  </div>

  {#if ircdRules}
    <div class="mt-4">
      <Card
        title="The ircd's own limits"
        subtitle="InspIRCd refuses floods before FiberEye ever sees them. Rendered by the deploy — read-only here."
      >
        {#if ircdRules.available}
          <div class="grid gap-4 text-sm md:grid-cols-2">
            <dl class="space-y-1">
              <div class="flex justify-between gap-4"><dt class="text-muted">&lt;connectban&gt; threshold</dt><dd class="font-mono">{ircdRules.connectban.threshold ?? '—'}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">ban duration</dt><dd class="font-mono">{ircdRules.connectban.banduration ?? '—'}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">v4 / v6 grouping</dt><dd class="font-mono">/{ircdRules.connectban.ipv4cidr ?? '?'} · /{ircdRules.connectban.ipv6cidr ?? '?'}</dd></div>
            </dl>
            <dl class="space-y-1">
              <div class="flex justify-between gap-4"><dt class="text-muted">&lt;connflood&gt; maxconns</dt><dd class="font-mono">{ircdRules.connflood.maxconns ?? '—'}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">period</dt><dd class="font-mono">{ircdRules.connflood.period ?? '—'}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">lockout</dt><dd class="font-mono">{ircdRules.connflood.timeout ?? '—'}</dd></div>
            </dl>
          </div>
          <p class="mt-3 border-t border-border pt-3 text-xs text-muted">
            Rendered into the ircd config by the deploy and changed with <code class="font-mono">make deploy-ircd</code>;
            <code class="font-mono">&lt;connflood&gt;</code> is server-wide, <code class="font-mono">&lt;connectban&gt;</code> is per address group.
            <a class="ml-1 text-primary hover:underline" href={href('/ircd')}>Open the config viewer</a>
          </p>
        {:else}
          <p class="text-xs text-muted">{ircdRules.reason}</p>
        {/if}
      </Card>
    </div>
  {/if}

  {#if overview.candidates.length > 0}
    <div class="mt-4">
      <Card
        title={overview.armed ? 'Rules tripped, not yet placed' : 'Would-ban candidates'}
        subtitle="Rules that tripped while enforcement was disarmed — retune the thresholds from these before arming"
      >
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                <th class="py-2 pr-4">Mask</th>
                <th class="py-2 pr-4">Rule</th>
                <th class="py-2 pr-4">When</th>
                <th class="py-2 pr-4">Evidence</th>
                <th class="py-2 pr-4">Would last</th>
                <th class="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {#each overview.candidates as c (c.id)}
                <tr class="border-b border-border/50 last:border-0">
                  <td class="py-2 pr-4 font-mono">
                    <a href={ipHref(c.ipGroup)} class="hover:text-primary">{c.mask}</a>
                  </td>
                  <td class="py-2 pr-4 font-mono text-muted">{c.rule}</td>
                  <td class="py-2 pr-4 font-mono text-muted">{relative(c.placedAtMs)}</td>
                  <td class="py-2 pr-4 font-mono text-xs text-muted">
                    {c.evidence.connects} connects · {c.evidence.nicks} nicks ·
                    {c.evidence.shortSessions} short / {c.evidence.windowSeconds}s
                  </td>
                  <td class="py-2 pr-4 font-mono">{duration(c.durationSeconds * 1000)}</td>
                  <td class="py-2 text-right">
                    <button
                      type="button"
                      onclick={() => void release(c.id, c.mask)}
                      class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
                    >
                      Release
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  {/if}

  <div class="mt-4">
    <Card>
      <div class="mb-3 flex flex-wrap items-center gap-2">
        {#each [{ id: 'sessions', label: 'Sessions' }, { id: 'ips', label: 'IPs' }, { id: 'bans', label: 'Bans' }] as t (t.id)}
          <button
            type="button"
            onclick={() => { tab = t.id as Tab; }}
            class="rounded-md border px-2.5 py-1 text-xs {tab === t.id
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border bg-surface-2 text-muted hover:border-primary/40'}"
          >
            {t.label}
          </button>
        {/each}
        {#if tab !== 'bans'}
          <input
            type="search"
            value={q}
            oninput={onQueryInput}
            placeholder={tab === 'sessions'
              ? 'Search nick, ident, IP, real name or account'
              : 'Search IP, nick, real name or account'}
            aria-label="Search FiberEye records"
            class="ml-auto w-72 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm"
          />
        {/if}
        <span class="{tab !== 'bans' ? '' : 'ml-auto '}text-xs text-muted">
          {tabLoading ? 'Loading…' : `${current?.total ?? 0} rows`}
        </span>
      </div>

      {#if tabError}
        <p class="text-sm text-danger">{tabError}</p>
      {:else if tab === 'sessions'}
        {#if !sessions || sessions.rows.length === 0}
          <EmptyState
            title="No sessions recorded"
            description={qApplied
              ? 'No connect matches this search within the retention window.'
              : 'FiberEye has not seen a connect yet — check that it is opered.'}
          />
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead>
                <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                  <th class="py-2 pr-4">When</th>
                  <th class="py-2 pr-4">Nick</th>
                  <th class="py-2 pr-4">Account</th>
                  <th class="py-2 pr-4">IP</th>
                  <th class="py-2 pr-4">Real name</th>
                  <th class="py-2 pr-4">Class</th>
                  <th class="py-2 pr-4">Port</th>
                  <th class="py-2 pr-4">Duration</th>
                </tr>
              </thead>
              <tbody>
                {#each sessions.rows as s (s.id)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2 pr-4 font-mono text-muted">{relative(s.ts)}</td>
                    <td class="py-2 pr-4 font-mono">{s.nick}</td>
                    <td class="py-2 pr-4 font-mono text-muted">{s.account || '—'}</td>
                    <td class="py-2 pr-4">
                      <a href={ipHref(s.ipGroup)} class="font-mono hover:text-primary">{s.ip}</a>
                      <span class="ml-1 text-xs text-muted">{geoShort(s)}</span>
                    </td>
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
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {:else if tab === 'ips'}
        {#if !ips || ips.rows.length === 0}
          <EmptyState
            title="No addresses recorded"
            description={qApplied
              ? 'No address matches this search within the retention window.'
              : 'Per-IP rollups appear as soon as FiberEye records its first connect.'}
          />
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead>
                <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                  <th class="py-2 pr-4">IP group</th>
                  <th class="py-2 pr-4">Connects</th>
                  <th class="py-2 pr-4">First seen</th>
                  <th class="py-2 pr-4">Last seen</th>
                  <th class="py-2 pr-4">Last nick</th>
                  <th class="py-2 pr-4">Geo / ASN</th>
                  <th class="py-2 pr-4">State</th>
                  <th class="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {#each ips.rows as row (row.ipGroup)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2 pr-4 font-mono">{row.ipGroup}</td>
                    <td class="py-2 pr-4 font-mono">{row.connects}<span class="ml-1 text-xs text-muted">· {row.shortSessions} short</span></td>
                    <td class="py-2 pr-4 font-mono text-muted">{relative(row.firstSeen)}</td>
                    <td class="py-2 pr-4 font-mono text-muted">{relative(row.lastSeen)}</td>
                    <td class="py-2 pr-4 font-mono">{row.lastNick || '—'}</td>
                    <td class="max-w-xs py-2 pr-4 text-xs text-muted" title={row.geoOrg}>
                      <span class="truncate">{geoShort(row)}</span>
                      {#each flagChips(row.intelFlags) as chip (chip.text)}
                        <span class="ml-1"><StatusBadge label={chip.text} tone={chip.tone} size="sm" dot={false} /></span>
                      {/each}
                    </td>
                    <td class="py-2 pr-4">
                      {#if row.bannedUntil > Date.now()}
                        <StatusBadge label="Banned" tone="danger" size="sm" />
                      {:else if row.strikes > 0}
                        <StatusBadge label={`${row.strikes} strike${row.strikes === 1 ? '' : 's'}`} tone="warn" size="sm" />
                      {:else}
                        <StatusBadge label="Seen" tone="muted" size="sm" />
                      {/if}
                    </td>
                    <td class="py-2 text-right">
                      <a
                        href={ipHref(row.ipGroup)}
                        class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
                      >
                        View
                      </a>
                      {#if row.bannedUntil > Date.now()}
                        <button
                          type="button"
                          onclick={() => void release(row.lastBanId, row.ipGroup)}
                          disabled={!row.lastBanId}
                          class="ml-2 rounded-md border border-danger/40 bg-surface-2 px-2.5 py-1 text-xs text-danger hover:border-danger disabled:opacity-40"
                        >
                          Release
                        </button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {:else}
        {#if !bans || bans.rows.length === 0}
          <EmptyState
            title="No bans recorded"
            description="No rule has tripped yet — neither placed nor observed."
          />
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
                  <th class="py-2 pr-4">Reason</th>
                  <th class="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {#each bans.rows as b (b.id)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2 pr-4 font-mono">
                      <a href={ipHref(b.ipGroup)} class="hover:text-primary">{b.mask}</a>
                    </td>
                    <td class="py-2 pr-4 font-mono text-muted">{b.rule}</td>
                    <td class="py-2 pr-4 font-mono text-muted">{relative(b.placedAtMs)}</td>
                    <td class="py-2 pr-4 font-mono text-muted">{relative(b.expiresAtMs)}</td>
                    <td class="py-2 pr-4 font-mono">{b.strikes}</td>
                    <td class="py-2 pr-4"><StatusBadge label={b.state} tone={banTone(b.state)} size="sm" /></td>
                    <td class="max-w-sm truncate py-2 pr-4 text-xs text-muted" title={b.placeError || b.reason}>
                      {b.reason}{#if b.placeError}<span class="ml-1 text-danger">({b.placeError})</span>{/if}
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
      {/if}

      {#if pageCount > 1 && current}
        <div
          class="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs text-muted"
          data-testid="fibereye-pager"
        >
          <div>
            Showing {page * LIMIT + 1}–{page * LIMIT + current.rows.length} of {current.total}
          </div>
          <div class="flex items-center gap-1">
            <button
              type="button"
              aria-label="First page"
              onclick={() => goToPage(0)}
              disabled={page === 0}
              class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
            >«</button>
            <button
              type="button"
              aria-label="Previous page"
              onclick={() => goToPage(page - 1)}
              disabled={page === 0}
              class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
            >‹</button>
            <span class="px-2">{page + 1} / {pageCount}</span>
            <button
              type="button"
              aria-label="Next page"
              onclick={() => goToPage(page + 1)}
              disabled={page >= pageCount - 1}
              class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
            >›</button>
            <button
              type="button"
              aria-label="Last page"
              onclick={() => goToPage(pageCount - 1)}
              disabled={page >= pageCount - 1}
              class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
            >»</button>
          </div>
        </div>
      {/if}
    </Card>
  </div>
{:else}
  <Card><p class="text-sm text-muted">Loading…</p></Card>
{/if}

<ConfirmDialog
  open={ask === 'arm'}
  title="Arm FiberEye enforcement?"
  message="Every rule that trips places a timed Z-line on the ircd, disconnecting matching clients. Review the candidate rows first — the thresholds are shown on the bot card."
  confirmLabel="Arm"
  cancelLabel="Cancel"
  tone="danger"
  onConfirm={() => setArmed(true)}
  onCancel={() => { if (!armBusy) ask = null; }}
/>
