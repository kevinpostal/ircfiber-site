<script lang="ts">
  /**
   * FiberEye Map — where the connections came from, inside a chosen time
   * window.
   *
   * Backed by GET /api/admin/fibereye/map. The server resolves the relative
   * presets against its own clock and does the clustering, so only the
   * range *token* travels (`custom` is the one case that sends absolute
   * unix-ms bounds). Coordinates come from the IP-intelligence records;
   * groups whose record has none are reported as `Unlocated` rather than
   * dropped, and they still count in the country table.
   *
   * The basemap is a vendored Natural Earth outline: no third-party
   * request, no API key, no usage policy to honour. Raster tiles were
   * tried and dropped — CARTO stamps "API KEY REQUIRED" across every
   * unkeyed tile, and OpenStreetMap's volunteer servers refuse
   * third-party apps under their tile usage policy. Projection is
   * geoMercator.
   */
  import { onMount, onDestroy } from 'svelte';
  import { Chart, Svg, GeoPath, GeoPoint } from 'layerchart';
  import { geoMercator, type GeoPermissibleObjects } from 'd3-geo';

  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastError } from '../stores/ui';
  import { startPolling } from '../stores/polling';
  import { relative, shortNumber } from '../lib/format';
  import { href } from '../lib/router';

  interface MapSample {
    ipGroup: string; ip: string; ipVersion: number;
    connects: number; lastTs: number;
    nick: string; account: string; connClass: string;
    city: string; region: string; country: string;
    org: string; asn: string; flags: string; risk: number;
    bannedUntil: number; strikes: number; geoPending: boolean;
  }
  interface MapCluster {
    lat: number; lon: number;
    city: string; region: string; country: string; topOrg: string;
    groups: number; connects: number; lastTs: number;
    banned: number; flagged: number;
    samples: MapSample[];
  }
  interface MapCountry { country: string; groups: number; connects: number; banned: number; }
  interface MapSummary {
    sessions: number; groups: number; returned: number;
    located: number; unlocated: number; truncated: number;
  }
  interface MapResponse {
    range: string; start: number; end: number;
    summary: MapSummary;
    clusters: MapCluster[];
    countries: MapCountry[];
  }

  const PRESETS = ['1h', '24h', '7d', '30d', 'all'] as const;
  type Preset = (typeof PRESETS)[number];
  const PRESET_LABELS: Record<Preset, string> = {
    '1h': '1h', '24h': '24h', '7d': '7d', '30d': '30d', all: 'All',
  };

  const RANGE_KEY = 'ircfiber:admin:eyemap:range';

  /**
   * Framing. Fitting a constant rather than the loaded outline keeps the
   * view stable while the outline chunk is still downloading. Mercator is
   * unusable past ~±85°; ±62° is the populated band.
   */
  const WORLD_FIT = {
    type: 'Polygon' as const,
    coordinates: [[[-180, -62], [180, -62], [180, 78], [-180, 78], [-180, -62]]],
  };

  let range = $state<Preset | 'custom'>(readRange());
  /** The `datetime-local` inputs; committed to customStart/End on Apply. */
  let customRangeOpen = $state(false);
  let customFrom = $state('');
  let customTo = $state('');
  let customStart = $state(0);
  let customEnd = $state(0);

  let data = $state<MapResponse | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let selected = $state<MapCluster | null>(null);
  /** The vendored outline, loaded lazily (~800 KB of JSON). */
  let world = $state<GeoPermissibleObjects | null>(null);
  /** A preset click can outrun an in-flight fetch; only the newest writes. */
  let seq = 0;

  function readRange(): Preset | 'custom' {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      if (v && (PRESETS as readonly string[]).includes(v)) return v as Preset;
    } catch { /* private mode / storage disabled */ }
    return '24h';
  }
  function persist(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  async function load(showSpinner = true): Promise<void> {
    const mine = ++seq;
    if (showSpinner) loading = true;
    try {
      const res = await api.get<MapResponse>(
        '/api/admin/fibereye/map',
        range === 'custom'
          ? { range, start: customStart, end: customEnd }
          : { range },
      );
      if (mine !== seq) return;
      data = res;
      error = null;
      // Keep the open panel pointed at the same cell across a refresh; drop
      // it when that cell no longer has traffic in the window.
      if (selected) {
        const still = res.clusters.find((c) => c.lat === selected!.lat && c.lon === selected!.lon);
        selected = still ?? null;
      }
    } catch (e) {
      if (mine !== seq) return;
      error = errMsg(e);
      toastError(error);
    } finally {
      if (mine === seq) loading = false;
    }
  }

  function setPreset(p: Preset): void {
    range = p;
    customRangeOpen = false;
    persist(RANGE_KEY, p);
    selected = null;
    void load();
  }

  function openCustom(): void {
    customRangeOpen = !customRangeOpen;
  }

  function applyCustom(e: Event): void {
    e.preventDefault();
    const from = Date.parse(customFrom);
    const to = Date.parse(customTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      toastError('Pick a start and an end, with the end after the start.');
      return;
    }
    customStart = from;
    customEnd = to;
    range = 'custom';
    // Deliberately not persisted: a reload should land on a live window,
    // not on a frozen one from last week.
    selected = null;
    void load();
  }

  const clusters = $derived(data?.clusters ?? []);
  const maxConnects = $derived(clusters.reduce((m, c) => Math.max(m, c.connects), 1));

  /** Area-proportional, so a 400-connect cell does not swamp a 4-connect one. */
  function radius(c: MapCluster): number {
    return 3 + 9 * Math.sqrt(c.connects / maxConnects);
  }
  function toneClass(c: MapCluster): string {
    if (c.banned > 0) return 'fill-danger/70 stroke-danger';
    if (c.flagged > 0) return 'fill-warn/60 stroke-warn';
    return 'fill-primary/60 stroke-primary';
  }
  function clusterLabel(c: MapCluster): string {
    const place = [c.city, c.region, c.country].filter(Boolean).join(', ');
    return place || `${c.lat.toFixed(1)}, ${c.lon.toFixed(1)}`;
  }

  let stop: (() => void) | null = null;
  onMount(() => {
    // 60 s, not the FiberEye page's 30 s: this endpoint runs two
    // aggregations that may scan the whole retention window. A fixed
    // absolute range cannot go stale, so polling it would be pure load.
    stop = startPolling(async () => {
      if (range === 'custom') return;
      await load(false);
    }, { intervalMs: 60_000 });

    // Dynamic import: a static one would inline ~800 KB of JSON into the
    // shared admin chunk that every admin page downloads.
    void (async () => {
      try {
        const mod = await import('../assets/world-countries-110m.geo.json');
        // The JSON's `properties` typing is far wider than GeoJSON's, so
        // the cast is the honest one-liner rather than a structural lie.
        world = mod.default as unknown as GeoPermissibleObjects;
      } catch {
        // Tiles mode still works; the outline layer just stays empty.
        world = null;
      }
    })();
  });
  onDestroy(() => { stop?.(); });
</script>

<PageHeader
  title="FiberEye Map"
  subtitle="Where the connections came from, inside the selected time window"
>
  {#snippet actions()}
    <a
      href={href('/fibereye')}
      class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
    >
      Connection watch
    </a>
    <button
      type="button"
      onclick={() => void load(true)}
      disabled={loading}
      class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
    >
      {loading ? 'Loading…' : 'Refresh'}
    </button>
  {/snippet}
</PageHeader>

<div class="mb-4 flex flex-wrap items-center gap-2">
  <span class="text-xs text-muted">Window:</span>
  {#each PRESETS as preset}
    <button
      type="button"
      onclick={() => setPreset(preset)}
      class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-muted hover:bg-border/40"
      class:text-text={range === preset}
      class:font-semibold={range === preset}
      data-testid="eyemap-preset-{preset}"
    >{PRESET_LABELS[preset]}</button>
  {/each}
  <button
    type="button"
    onclick={openCustom}
    class="rounded border border-border bg-surface-2 px-2 py-1 text-xs hover:bg-border/40"
    class:text-text={range === 'custom'}
    class:text-muted={range !== 'custom'}
    class:font-semibold={range === 'custom'}
    data-testid="eyemap-preset-custom"
    aria-label="Custom time range"
  >&hellip;</button>
</div>

{#if customRangeOpen}
  <form
    onsubmit={applyCustom}
    class="mb-4 flex flex-wrap items-center gap-2 text-xs"
    data-testid="eyemap-custom-form"
  >
    <input
      type="datetime-local"
      bind:value={customFrom}
      aria-label="Start time"
      class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text"
    />
    <span class="text-muted">to</span>
    <input
      type="datetime-local"
      bind:value={customTo}
      aria-label="End time"
      class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text"
    />
    <button
      type="submit"
      class="rounded bg-primary px-3 py-1 text-xs text-bg"
      data-testid="eyemap-custom-apply"
    >Apply</button>
  </form>
{/if}

{#if error}
  <Card><p class="text-sm text-danger">{error}</p></Card>
{/if}

<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
  <KpiCard label="Connects" value={data ? shortNumber(data.summary.sessions) : '—'} {loading} />
  <KpiCard label="Unique IPs" value={data ? shortNumber(data.summary.groups) : '—'} {loading} />
  <KpiCard label="Located" value={data ? shortNumber(data.summary.located) : '—'} {loading} />
  <KpiCard
    label="Unlocated"
    value={data ? shortNumber(data.summary.unlocated) : '—'}
    tone="muted"
    hint="no coordinates in the IP-intelligence record"
    {loading}
  />
</div>

<Card
  title="Observed locations"
  subtitle={data
    ? `${data.summary.returned} IP groups in ${clusters.length} cells · ${new Date(data.start).toLocaleString()} → ${new Date(data.end).toLocaleString()}`
    : 'Loading…'}
>
  <div class="h-[480px] w-full" data-testid="eyemap-canvas">
    <Chart geo={{ projection: geoMercator, fitGeojson: WORLD_FIT }}>
      <Svg>
        {#if world}
          <GeoPath geojson={world} class="fill-border/60 stroke-muted/40" />
        {/if}
        {#each clusters as c, i (c.lat + ':' + c.lon)}
          <GeoPoint lat={c.lat} long={c.lon}>
            <!-- GeoPoint's slot renders inside a <g> already translated to
                 the projected point, so the circle sits at the origin. -->
            <circle
              cx="0"
              cy="0"
              r={radius(c)}
              stroke-width="1"
              class="cursor-pointer {toneClass(c)}"
              role="button"
              tabindex="0"
              aria-label="{clusterLabel(c)}: {c.connects} connects from {c.groups} IP groups"
              data-testid="eyemap-cluster-{i}"
              onclick={() => (selected = c)}
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selected = c; }
              }}
            />
          </GeoPoint>
        {/each}
      </Svg>
    </Chart>
  </div>

  {#if data && data.summary.truncated > 0}
    <p class="mt-2 text-xs text-warn" data-testid="eyemap-truncated">
      Showing the busiest {data.summary.returned} of {data.summary.groups} IP groups.
    </p>
  {/if}
  {#if data && clusters.length === 0}
    <p class="mt-2 text-xs text-muted">
      No located IP groups in this window
      {#if data.summary.unlocated > 0}
        — {data.summary.unlocated} of {data.summary.returned} have no coordinates in their
        IP-intelligence record
      {/if}.
    </p>
  {/if}
</Card>

{#if selected}
  <div class="mt-4">
    <Card
      title={clusterLabel(selected)}
      subtitle="{selected.groups} IP groups · {selected.connects} connects · last {relative(selected.lastTs)}"
    >
      {#snippet actions()}
        <button
          type="button"
          onclick={() => (selected = null)}
          class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
        >
          Close
        </button>
      {/snippet}
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs uppercase tracking-wider text-muted">
            <tr>
              <th class="px-3 py-2">IP group</th>
              <th class="px-3 py-2">Nick</th>
              <th class="px-3 py-2">Account</th>
              <th class="px-3 py-2 text-right">Connects</th>
              <th class="px-3 py-2">Last seen</th>
              <th class="px-3 py-2">Network</th>
            </tr>
          </thead>
          <tbody>
            {#each selected.samples as s (s.ipGroup)}
              <tr class="border-t border-border">
                <td class="px-3 py-2 font-mono text-xs">
                  <a
                    href={href('/fibereye/ip/' + encodeURIComponent(s.ipGroup))}
                    class="text-primary hover:underline"
                  >{s.ipGroup}</a>
                  {#if s.bannedUntil > Date.now()}
                    <span class="ml-2 align-middle"><StatusBadge label="Banned" tone="danger" size="sm" /></span>
                  {/if}
                </td>
                <td class="px-3 py-2">{s.nick || '—'}</td>
                <td class="px-3 py-2">{s.account || '—'}</td>
                <td class="px-3 py-2 text-right">{s.connects}</td>
                <td class="px-3 py-2 text-xs text-muted">{relative(s.lastTs)}</td>
                <td class="px-3 py-2 text-xs">
                  <div>{s.org || s.asn || '—'}</div>
                  {#if s.flags}
                    <div class="mt-0.5 text-warn">{s.flags}</div>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if selected.groups > selected.samples.length}
        <p class="mt-2 text-xs text-muted">
          Showing the busiest {selected.samples.length} of {selected.groups} IP groups in this cell.
        </p>
      {/if}
    </Card>
  </div>
{/if}

<div class="mt-4">
  <Card title="By country" subtitle="Every IP group in the window, including those without coordinates">
    {#if data && data.countries.length}
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs uppercase tracking-wider text-muted">
            <tr>
              <th class="px-3 py-2">Country</th>
              <th class="px-3 py-2 text-right">IP groups</th>
              <th class="px-3 py-2 text-right">Connects</th>
              <th class="px-3 py-2 text-right">Banned</th>
            </tr>
          </thead>
          <tbody>
            {#each data.countries as row (row.country)}
              <tr class="border-t border-border">
                <td class="px-3 py-2 font-mono text-xs">{row.country}</td>
                <td class="px-3 py-2 text-right">{row.groups}</td>
                <td class="px-3 py-2 text-right">{row.connects}</td>
                <td class="px-3 py-2 text-right" class:text-danger={row.banned > 0}>{row.banned}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <EmptyState title="No connections in this window" icon="🗺️" />
    {/if}
  </Card>
</div>
