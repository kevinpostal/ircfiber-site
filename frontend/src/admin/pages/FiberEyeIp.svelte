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
    geoTimezone: string; geoPending: boolean;
    intelAsn: string; intelFlags: string; intelOperator: string; intelPrefix: string;
    intelRisk: number; intelAt: number;
  }
  interface IpRollup {
    ipGroup: string; ip: string; ipVersion: number;
    firstSeen: number; lastSeen: number; connects: number; shortSessions: number;
    lastNick: string; lastAccount: string; lastRealname: string; lastClass: string;
    geoCity: string; geoRegion: string; geoCountry: string; geoOrg: string;
    geoTimezone: string; geoPending: boolean;
    intelAsn: string; intelFlags: string; intelOperator: string; intelPrefix: string;
    intelRisk: number; intelAt: number;
    strikes: number; bannedUntil: number; lastBanId: string;
  }
  interface ZLine {
    mask: string; setAtMs: number; durationSecs: number; setter: string;
    reason: string; autoPlaced: boolean;
  }
  /** One provenance mark: who supplied a field, when, for how long; votes for the flags. */
  interface SourceMark {
    src: string; at: number; ttl: number; confidence: number;
    votes?: Record<string, string>;
  }
  /** The canonical record (docs/IP_INTEL.md §2). A field without a provenance entry is never shown. */
  interface IpIntel {
    identity: { ip: string; ipVersion: number; prefix: string; group: string; hostname: string; isBogon: boolean };
    network: {
      asn: string; asName: string; asDomain: string; asType: string; isp: string; org: string;
      rir: string; allocatedAt: string; netname: string; assignment: string; rpki: string;
    };
    geo: {
      countryCode: string; continentCode: string; region: string; regionCode: string; city: string;
      timezone: string; latitude?: number; longitude?: number; isEu: boolean;
    };
    classification: {
      isVpn: boolean; isProxy: boolean; isTor: boolean; isRelay: boolean; isHosting: boolean;
      isResidentialProxy: boolean; isMobile: boolean; vpnOperator: string; networkType: string;
    };
    reputation: {
      riskScore: number; sfsFrequency: number; sfsLastSeen: string; sfsTorExit: boolean; dnsbl: string[];
      vendorFirstSeen: number; vendorLastSeen: number; timesSeen: number;
      firstSeen: number; lastSeen: number; sessionCount: number;
    };
    contact: { abuseEmail: string; abuseSource: string };
    infra: { ports: number[]; hostnames: string[]; tags: string[]; vulns: string[] };
    provenance: Record<string, SourceMark>;
    degraded: string[];
    schemaVersion: number;
    assembledAt: number;
  }
  interface IpDetail {
    ip: string;
    rollup: IpRollup | null;
    sessions: SessionRow[];
    distinctNicks: string[];
    distinctAccounts: string[];
    bans: BanRow[];
    zline: ZLine | null;
    intel: IpIntel | null;
    intelSources: string[];
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
  const banTone = (state: string): 'danger' | 'warn' | 'muted' =>
    state === 'active' ? 'danger' : state === 'observed' ? 'warn' : 'muted';

  // ── IP intelligence ──────────────────────────────────────────────
  const intel = $derived(data?.intel ?? null);
  /** The exact address the record is keyed by (the rollup may be a /64 group). */
  const exactIp = $derived(intel?.identity.ip || rollup?.ip || ip || '');
  let deepBusy = $state(false);

  /** A field is renderable only when it carries provenance (IP_INTEL.md §2.1 rule 1). */
  function has(key: string): boolean {
    return !!intel && key in intel.provenance;
  }
  /** The value when provenanced, else an em dash — never a default. */
  function show(key: string, value: string | number | boolean | undefined | null): string {
    if (!has(key)) return '—';
    if (value === undefined || value === null || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    return String(value);
  }
  function srcOf(key: string): string {
    return intel?.provenance[key]?.src ?? '';
  }

  const FLAGS: { key: keyof IpIntel['classification']; name: string; tone: 'primary' | 'danger' | 'muted' }[] = [
    { key: 'isVpn', name: 'vpn', tone: 'primary' },
    { key: 'isProxy', name: 'proxy', tone: 'danger' },
    { key: 'isTor', name: 'tor', tone: 'danger' },
    { key: 'isRelay', name: 'relay', tone: 'muted' },
    { key: 'isHosting', name: 'hosting', tone: 'muted' },
    { key: 'isResidentialProxy', name: 'residential-proxy', tone: 'danger' },
    { key: 'isMobile', name: 'mobile', tone: 'muted' },
  ];
  /** Confirmed flags as chips; an unconfirmed vote (confidence < 1) as a `?` chip. */
  const flagChips = $derived.by(() => {
    if (!intel) return [] as { text: string; tone: 'primary' | 'danger' | 'muted'; title: string }[];
    const out: { text: string; tone: 'primary' | 'danger' | 'muted'; title: string }[] = [];
    for (const f of FLAGS) {
      const m = intel.provenance[`classification.${f.key}`];
      if (!m) continue;
      const value = intel.classification[f.key] as boolean;
      const unconfirmed = m.confidence < 1;
      const anyYes = Object.values(m.votes ?? {}).includes('true');
      if (!value && !(unconfirmed && anyYes)) continue;
      let text = f.name;
      if (f.key === 'isVpn' && intel.classification.vpnOperator) text += `(${intel.classification.vpnOperator})`;
      if (unconfirmed) text += '?';
      const votes = Object.entries(m.votes ?? {}).map(([s, v]) => `${s}: ${v}`).join(', ');
      out.push({ text, tone: unconfirmed ? 'muted' : f.tone, title: `${m.src} · confidence ${m.confidence}${votes ? ' · ' + votes : ''}` });
    }
    return out;
  });
  /** source → flag → vote, for the voter table. */
  const voters = $derived.by(() => {
    const cols: (keyof IpIntel['classification'])[] = ['isVpn', 'isProxy', 'isTor', 'isHosting'];
    const rows = new Map<string, Record<string, string>>();
    if (!intel) return { cols, rows: [] as { src: string; votes: Record<string, string> }[] };
    for (const c of cols) {
      const m = intel.provenance[`classification.${c}`];
      for (const [src, v] of Object.entries(m?.votes ?? {})) {
        if (!rows.has(src)) rows.set(src, {});
        rows.get(src)![c] = v;
      }
    }
    return { cols, rows: [...rows.entries()].map(([src, votes]) => ({ src, votes })) };
  });
  const provenanceRows = $derived.by(() =>
    intel ? Object.entries(intel.provenance).sort(([a], [b]) => a.localeCompare(b)) : []);
  const hasInfra = $derived(has('infra'));
  const dateOnly = (ms: number): string => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '—');

  async function deepLookup() {
    if (!exactIp || !data) return;
    deepBusy = true;
    try {
      const r = await api.post<{ intel: IpIntel }>('/api/admin/fibereye/ip/deep', { ip: exactIp });
      data = { ...data, intel: r.intel };
      toastSuccess(`Deep lookup for ${exactIp}: ${r.intel.degraded.length ? r.intel.degraded.length + ' source(s) degraded' : 'all sources answered'}`);
    } catch (e) {
      toastError(errMsg(e));
    } finally { deepBusy = false; }
  }
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
        <div class="flex justify-between gap-4"><dt class="text-muted">Strikes</dt><dd class="font-mono">{rollup.strikes}</dd></div>
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
    <Card title="IP intelligence" subtitle={intel ? `${exactIp} · assembled ${relative(intel.assembledAt)}` : exactIp}>
      {#snippet actions()}
        <button
          type="button"
          onclick={() => void deepLookup()}
          disabled={deepBusy || !exactIp}
          title="Refetch every source and add Shodan InternetDB. Internal use only — Shodan InternetDB is non-commercial."
          class="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text hover:border-primary/40 disabled:opacity-50"
        >
          {deepBusy ? 'Looking up…' : 'Deep lookup'}
        </button>
      {/snippet}

      {#if !intel}
        <p class="text-sm text-muted">
          No record yet for {exactIp || 'this address'} — FiberEye assembles one on the next connect,
          or run a deep lookup now.
        </p>
      {:else}
        <div class="grid gap-6 md:grid-cols-2">
          <section>
            <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Network</h3>
            <dl class="space-y-1 text-sm">
              <div class="flex justify-between gap-4"><dt class="text-muted">ASN</dt><dd class="font-mono text-right">{show('network.asn', intel.network.asn)}{#if has('network.asName')}<span class="ml-1 text-xs text-muted">{intel.network.asName}</span>{/if}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">Domain / type</dt><dd class="font-mono text-xs text-right">{show('network.asDomain', intel.network.asDomain)} · {show('network.asType', intel.network.asType)}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">ISP / org</dt><dd class="text-right text-xs">{show('network.isp', intel.network.isp)} · {show('network.org', intel.network.org)}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">Prefix</dt><dd class="font-mono text-xs">{show('identity.prefix', intel.identity.prefix)}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">RPKI</dt><dd>
                {#if has('network.rpki')}
                  <StatusBadge label={intel.network.rpki} tone={intel.network.rpki === 'invalid' ? 'danger' : intel.network.rpki === 'valid' ? 'success' : 'muted'} size="sm" dot={false} />
                {:else}—{/if}
              </dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">RIR</dt><dd class="font-mono text-xs">{show('network.rir', intel.network.rir)}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">Netname</dt><dd class="font-mono text-xs">{show('network.netname', intel.network.netname)}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">Assignment</dt><dd class="font-mono text-xs">{show('network.assignment', intel.network.assignment)}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">Allocated</dt><dd class="font-mono text-xs">{show('network.allocatedAt', intel.network.allocatedAt)}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">Abuse contact</dt><dd class="font-mono text-xs">{show('contact.abuseEmail', intel.contact.abuseEmail)}{#if has('contact.abuseEmail')}<span class="ml-1 text-muted">({intel.contact.abuseSource})</span>{/if}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">rDNS</dt><dd class="font-mono text-xs">{show('identity.hostname', intel.identity.hostname)}</dd></div>
            </dl>
          </section>

          <section>
            <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Geo</h3>
            <dl class="space-y-1 text-sm">
              <div class="flex justify-between gap-4"><dt class="text-muted">City</dt><dd class="text-right">{show('geo.city', intel.geo.city)}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">Region</dt><dd class="text-right">{show('geo.region', intel.geo.region)}{#if has('geo.regionCode')}<span class="ml-1 text-xs text-muted">({intel.geo.regionCode})</span>{/if}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">Country</dt><dd class="font-mono">{show('geo.countryCode', intel.geo.countryCode)}{#if has('geo.continentCode')}<span class="ml-1 text-xs text-muted">· {intel.geo.continentCode}</span>{/if}{#if has('geo.isEu') && intel.geo.isEu}<span class="ml-1 text-xs text-muted">· EU</span>{/if}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">Timezone</dt><dd class="font-mono text-xs">{show('geo.timezone', intel.geo.timezone)}</dd></div>
            </dl>

            <h3 class="mb-2 mt-4 text-xs uppercase tracking-wider text-muted">Classification</h3>
            {#if flagChips.length === 0}
              <p class="text-sm text-muted">{has('classification.isVpn') || has('classification.isTor') ? 'No flags confirmed' : '—'}</p>
            {:else}
              <div class="flex flex-wrap gap-1">
                {#each flagChips as chip (chip.text)}
                  <span title={chip.title}><StatusBadge label={chip.text} tone={chip.tone} size="sm" dot={false} /></span>
                {/each}
              </div>
            {/if}
            <dl class="mt-2 space-y-1 text-sm">
              <div class="flex justify-between gap-4"><dt class="text-muted">VPN operator</dt><dd class="text-right">{show('classification.vpnOperator', intel.classification.vpnOperator)}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">Network type</dt><dd class="font-mono text-xs">{show('classification.networkType', intel.classification.networkType)}</dd></div>
            </dl>
            {#if voters.rows.length > 0}
              <table class="mt-2 w-full text-xs">
                <thead class="text-left text-muted">
                  <tr><th class="py-1 pr-3">source</th>{#each voters.cols as c (c)}<th class="py-1 pr-3">{c}</th>{/each}</tr>
                </thead>
                <tbody>
                  {#each voters.rows as v (v.src)}
                    <tr class="border-t border-border">
                      <td class="py-1 pr-3 font-mono">{v.src}</td>
                      {#each voters.cols as c (c)}<td class="py-1 pr-3 font-mono {v.votes[c] === 'true' ? 'text-warn' : 'text-muted'}">{v.votes[c] ?? '—'}</td>{/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          </section>

          <section>
            <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Reputation</h3>
            <dl class="space-y-1 text-sm">
              <div class="flex justify-between gap-4"><dt class="text-muted">Risk (proxycheck)</dt><dd class="font-mono {has('reputation.riskScore') && intel.reputation.riskScore >= 70 ? 'text-danger' : ''}">{has('reputation.riskScore') ? `${intel.reputation.riskScore}/100` : '—'}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">Vendor sightings</dt><dd class="font-mono text-xs">{has('reputation.timesSeen') ? `${intel.reputation.timesSeen}× · ${dateOnly(intel.reputation.vendorFirstSeen)} → ${dateOnly(intel.reputation.vendorLastSeen)}` : '—'}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">StopForumSpam</dt><dd class="font-mono text-xs">{has('reputation.sfsFrequency') ? `freq ${intel.reputation.sfsFrequency}${intel.reputation.sfsLastSeen ? ' · last ' + intel.reputation.sfsLastSeen : ''}${intel.reputation.sfsTorExit ? ' · torexit' : ''}` : '—'}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">DNSBL</dt><dd class="font-mono text-xs {intel.reputation.dnsbl.length ? 'text-warn' : ''}">{has('reputation.dnsbl.dronebl') || has('reputation.dnsbl.efnetrbl') ? (intel.reputation.dnsbl.length ? intel.reputation.dnsbl.join(', ') : 'not listed') : '—'}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted">Our sightings</dt><dd class="font-mono text-xs">{intel.reputation.sessionCount > 0 ? `${intel.reputation.sessionCount} · ${relative(intel.reputation.firstSeen)} → ${relative(intel.reputation.lastSeen)}` : '—'}</dd></div>
            </dl>

            {#if hasInfra}
              <h3 class="mb-2 mt-4 text-xs uppercase tracking-wider text-muted">Infrastructure</h3>
              <dl class="space-y-1 text-sm">
                <div class="flex justify-between gap-4"><dt class="text-muted">Open ports</dt><dd class="font-mono text-xs">{intel.infra.ports.length ? intel.infra.ports.join(', ') : 'none observed'}</dd></div>
                <div class="flex justify-between gap-4"><dt class="text-muted">Hostnames</dt><dd class="font-mono text-xs text-right">{intel.infra.hostnames.length ? intel.infra.hostnames.join(', ') : '—'}</dd></div>
                <div class="flex justify-between gap-4"><dt class="text-muted">Tags</dt><dd class="font-mono text-xs">{intel.infra.tags.length ? intel.infra.tags.join(', ') : '—'}</dd></div>
                <div class="flex justify-between gap-4"><dt class="text-muted">Vulns</dt><dd class="font-mono text-xs {intel.infra.vulns.length ? 'text-danger' : ''}">{intel.infra.vulns.length ? intel.infra.vulns.join(', ') : '—'}</dd></div>
              </dl>
              <p class="mt-1 text-xs text-muted">Internal use only — Shodan InternetDB is non-commercial.</p>
            {/if}
          </section>

          <section>
            <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">Provenance</h3>
            <div class="max-h-72 overflow-auto">
              <table class="w-full text-xs">
                <thead class="text-left text-muted">
                  <tr><th class="py-1 pr-3">field</th><th class="py-1 pr-3">source</th><th class="py-1 pr-3">fetched</th><th class="py-1">ttl</th></tr>
                </thead>
                <tbody>
                  {#each provenanceRows as [key, m] (key)}
                    <tr class="border-t border-border">
                      <td class="py-1 pr-3 font-mono">{key}</td>
                      <td class="py-1 pr-3 font-mono">{m.src}</td>
                      <td class="py-1 pr-3 text-muted">{m.at > 0 ? relative(m.at) : '—'}</td>
                      <td class="py-1 text-muted">{m.ttl > 0 ? duration(m.ttl * 1000) : '—'}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if intel.degraded.length > 0}
              <p class="mt-2 text-xs text-warn">Degraded: {intel.degraded.join(', ')}</p>
            {/if}
            {#if data.intelSources?.length}
              <p class="mt-1 text-xs text-muted">Sources on this deployment: {data.intelSources.join(', ')}</p>
            {/if}
          </section>
        </div>
      {/if}
    </Card>
  </div>

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
