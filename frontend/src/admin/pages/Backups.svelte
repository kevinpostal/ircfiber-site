<script lang="ts">
  /**
   * Backups page — daily k3s CronJob backups (ircfiber-mongo-backup /
   * ircfiber-redis-backup in ircfiber-prod): per-job schedule and freshness,
   * durable run history, retained snapshot inventory with volume usage, plus
   * Run now / Suspend-Resume actions and the last job's pod-log tail for
   * failure triage. Backed by /api/admin/backups/*.
   *
   * The page never restores and never deletes an archive: restore stays
   * `site/deploy/playbooks/restore.yml`, deletion stays the jobs' own
   * 14-day prune.
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { startPolling } from '../stores/polling';
  import { bytes, duration, relative } from '../lib/format';

  interface ActiveRun { name: string; startTime: number; }
  interface JobEntry {
    name: string; kind: string; schedule: string; suspended: boolean;
    lastScheduleTime: number; lastSuccessTime: number; nextRunAt: number;
    state: string; active: ActiveRun[];
  }
  interface RunEntry {
    kind: string; status: string; stage: string; startedAt: number;
    finishedAt: number; durationMs: number; file: string; bytes: number;
    node: string; message: string;
  }
  interface SnapshotEntry { name: string; kind: string; bytes: number; mtime: number; }
  interface Overview {
    jobs: JobEntry[];
    runs: RunEntry[];
    snapshots: SnapshotEntry[];
    volume: { totalBytes: number; usedBytes: number; availBytes: number; capturedAt?: number };
    control: { available: boolean; error: string };
    history: { mongoError: string; redisError: string };
    overall: string;
  }

  const CRON_FOR_KIND: Record<string, string> = {
    mongo: 'ircfiber-mongo-backup',
    redis: 'ircfiber-redis-backup',
  };

  let overview = $state<Overview | null>(null);
  let overviewError = $state<string | null>(null);
  let loading = $state(false);

  let logJob = $state('');
  let logPod = $state('');
  let logText = $state<string | null>(null);
  let logLoading = $state(false);
  let logError = $state<string | null>(null);

  type Ask = { action: 'run' | 'suspend'; job: JobEntry };
  let ask = $state<Ask | null>(null);
  let acting = $state(false);

  let stop: (() => void) | null = null;
  onMount(() => {
    stop = startPolling(
      async () => { await fetchOverview(false); },
      { intervalMs: 30_000 },
    );
  });
  onDestroy(() => stop?.());

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  async function fetchOverview(spinner: boolean = overview === null) {
    if (spinner) loading = true;
    overviewError = null;
    try {
      overview = await api.get<Overview>('/api/admin/backups');
    } catch (e) {
      overviewError = errMsg(e);
    } finally { loading = false; }
  }

  function badgeTone(state: string): 'success' | 'warn' | 'danger' | 'muted' {
    if (state === 'ok') return 'success';
    if (state === 'late' || state === 'never') return 'warn';
    if (state === 'failed') return 'danger';
    return 'muted';
  }

  function lastRunFor(job: JobEntry): RunEntry | null {
    if (!overview) return null;
    const rows = overview.runs.filter((r) => r.kind === job.kind);
    if (rows.length === 0) return null;
    return rows.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
  }

  function confirmRun(job: JobEntry) { ask = { action: 'run', job }; }
  function confirmSuspend(job: JobEntry) { ask = { action: 'suspend', job }; }

  async function doConfirm() {
    if (!ask || acting) return;
    const { action, job } = ask;
    acting = true;
    try {
      if (action === 'run') {
        const r = await api.post<{ job: string }>(`/api/admin/backups/${job.name}/run`);
        toastSuccess(`Manual run started: ${r.job}`);
      } else {
        const r = await api.post<{ name: string; suspended: boolean }>(
          `/api/admin/backups/${job.name}/suspend`, { suspend: !job.suspended });
        toastSuccess(r.suspended ? `Suspended ${r.name}` : `Resumed ${r.name}`);
      }
      ask = null;
      await fetchOverview(false);
    } catch (e) {
      toastError(errMsg(e));
    } finally { acting = false; }
  }

  async function fetchLog(kind: string) {
    const name = CRON_FOR_KIND[kind];
    if (!name) return;
    logLoading = true; logError = null; logText = null; logJob = ''; logPod = '';
    try {
      const r = await api.get<{ job: string; pod: string; log: string }>(
        `/api/admin/backups/${name}/logs`);
      logJob = r.job; logPod = r.pod; logText = r.log;
    } catch (e) {
      logError = errMsg(e);
    } finally { logLoading = false; }
  }

  const controlDown = $derived(overview !== null && !overview.control.available);
  const totalBytes = $derived((overview?.snapshots ?? []).reduce((a, s) => a + (s.bytes || 0), 0));
  const oldestMtime = $derived(
    (overview?.snapshots ?? []).reduce((a, s) => Math.min(a, s.mtime || Date.now()), Date.now()));
  const historyNotes = $derived(
    [overview?.history.mongoError, overview?.history.redisError].filter((e) => e && e.length > 0));
</script>

<PageHeader
  title="Backups"
  subtitle="Daily k3s CronJob archives of prod MongoDB + Redis"
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
  {/snippet}
</PageHeader>

{#if overviewError}
  <Card><p class="text-sm text-danger">{overviewError}</p></Card>
{:else if overview}
  {#if controlDown}
    <div class="mb-4 rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-text" role="alert">
      Control plane unavailable — {overview.control.error}. History below is from the last published run.
    </div>
  {/if}

  <div class="grid gap-4 md:grid-cols-2">
    {#each overview.jobs as job (job.name)}
      {@const last = lastRunFor(job)}
      <Card>
        <div class="mb-2 flex items-center justify-between gap-2">
          <h3 class="font-mono text-sm font-semibold text-heading">{job.name}</h3>
          <StatusBadge label={job.state} tone={badgeTone(job.state)} />
        </div>
        <dl class="space-y-1 text-sm">
          <div class="flex justify-between gap-4"><dt class="text-muted">Schedule (UTC)</dt><dd class="font-mono">{job.schedule || '—'}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Next run</dt><dd class="font-mono">{job.nextRunAt > 0 ? relative(job.nextRunAt) : (job.schedule || '—')}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Last success</dt><dd class="font-mono">{job.lastSuccessTime > 0 ? relative(job.lastSuccessTime) : '—'}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Last archive</dt><dd class="font-mono">{last ? bytes(last.bytes) : '—'}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Last duration</dt><dd class="font-mono">{last ? duration(last.durationMs) : '—'}</dd></div>
        </dl>
        {#if job.active.length > 0}
          <p class="mt-2 text-xs text-info">Active run: {job.active[0].name}</p>
        {/if}
        {#if job.suspended}
          <p class="mt-2 text-xs text-warn">Suspended — re-applying cronjob-backup.yaml clears this.</p>
        {/if}
        <div class="mt-3 flex gap-2">
          <button
            type="button"
            onclick={() => confirmRun(job)}
            disabled={controlDown || job.active.length > 0}
            class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-40"
          >
            Run now
          </button>
          <button
            type="button"
            onclick={() => confirmSuspend(job)}
            disabled={controlDown}
            class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs hover:border-primary/40 disabled:opacity-40"
          >
            {job.suspended ? 'Resume' : 'Suspend'}
          </button>
        </div>
      </Card>
    {/each}
  </div>

  <div class="mb-4 mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
    <KpiCard label="Snapshots" value={overview.snapshots.length} {loading} />
    <KpiCard label="Archive bytes" value={bytes(totalBytes)} {loading} />
    <KpiCard label="Volume free" value={bytes(overview.volume.availBytes)} {loading} />
    <KpiCard label="Oldest snapshot" value={overview.snapshots.length ? relative(oldestMtime) : '—'} {loading} />
  </div>

  <Card>
    <div class="mb-3 flex items-center justify-between">
      <h3 class="text-sm font-semibold text-heading">Snapshots ({overview.snapshots.length})</h3>
      {#if overview.volume.capturedAt}
        <span class="text-xs text-muted">inventoried {relative(overview.volume.capturedAt)}</span>
      {/if}
    </div>
    {#if overview.snapshots.length === 0}
      <EmptyState title="No snapshots" description="No published run has reported an archive inventory yet." />
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead>
            <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
              <th class="py-2 pr-4">Name</th>
              <th class="py-2 pr-4">Kind</th>
              <th class="py-2 pr-4">Size</th>
              <th class="py-2 pr-4">Age</th>
            </tr>
          </thead>
          <tbody>
            {#each overview.snapshots as s (s.name)}
              <tr class="border-b border-border/50 last:border-0">
                <td class="py-2 pr-4 font-mono">{s.name}</td>
                <td class="py-2 pr-4 font-mono text-muted">{s.kind || '—'}</td>
                <td class="py-2 pr-4 font-mono">{bytes(s.bytes)}</td>
                <td class="py-2 pr-4 font-mono text-muted">{relative(s.mtime)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>

  <div class="mt-4">
    <Card>
      <h3 class="mb-3 text-sm font-semibold text-heading">Recent runs ({overview.runs.length})</h3>
      {#if overview.runs.length === 0}
        <EmptyState title="No runs" description="No published run records yet — the next scheduled run will publish one." />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                <th class="py-2 pr-4">Kind</th>
                <th class="py-2 pr-4">Status</th>
                <th class="py-2 pr-4">Started</th>
                <th class="py-2 pr-4">Duration</th>
                <th class="py-2 pr-4">Size</th>
                <th class="py-2 pr-4">File</th>
                <th class="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {#each overview.runs as r (`${r.kind}-${r.startedAt}`)}
                <tr class="border-b border-border/50 last:border-0">
                  <td class="py-2 pr-4 font-mono">{r.kind}</td>
                  <td class="py-2 pr-4">
                    <StatusBadge label={r.status} tone={r.status === 'ok' ? 'success' : r.status === 'failed' ? 'danger' : 'muted'} size="sm" />
                  </td>
                  <td class="py-2 pr-4 font-mono text-muted">{relative(r.startedAt)}</td>
                  <td class="py-2 pr-4 font-mono">{duration(r.durationMs)}</td>
                  <td class="py-2 pr-4 font-mono">{bytes(r.bytes)}</td>
                  <td class="max-w-xs truncate py-2 pr-4 font-mono text-muted" title={r.file}>{r.file || '—'}</td>
                  <td class="py-2 text-right">
                    <button
                      type="button"
                      onclick={() => void fetchLog(r.kind)}
                      class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
                    >
                      Log
                    </button>
                  </td>
                </tr>
                {#if r.status === 'failed'}
                  <tr class="border-b border-border/50">
                    <td colspan="7" class="px-4 py-2 text-xs text-danger">
                      <span class="font-mono">[{r.stage}]</span> {r.message}
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      {#if historyNotes.length > 0}
        {#each historyNotes as note}
          <p class="mt-2 text-xs text-muted">History note: {note}</p>
        {/each}
      {/if}
      {#if logLoading}
        <p class="mt-3 text-xs text-muted">Loading pod log…</p>
      {:else if logError}
        <p class="mt-3 text-xs text-danger">{logError}</p>
      {:else if logText !== null}
        <div class="mt-3">
          <p class="mb-1 font-mono text-xs text-muted">{logJob} · {logPod}</p>
          <pre class="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 font-mono text-xs text-text">{logText}</pre>
        </div>
      {/if}
    </Card>
  </div>
{:else}
  <Card><p class="text-sm text-muted">Loading…</p></Card>
{/if}

<ConfirmDialog
  open={ask !== null}
  title={ask?.action === 'run' ? `Run ${ask?.job.name} now?` : ask?.job.suspended ? `Resume ${ask?.job.name}?` : `Suspend ${ask?.job.name}?`}
  message={ask?.action === 'run'
    ? `${ask?.job.name} dumps the live prod database right away. Continue?`
    : ask?.job.suspended
      ? `${ask?.job.name} resumes its daily schedule. Continue?`
      : `${ask?.job.name} stops running until resumed. Re-applying cronjob-backup.yaml also clears this. Continue?`}
  confirmLabel={acting ? 'Working…' : ask?.action === 'run' ? 'Run now' : ask?.job.suspended ? 'Resume' : 'Suspend'}
  cancelLabel="Cancel"
  tone={ask?.action === 'run' ? 'primary' : 'warn'}
  onConfirm={doConfirm}
  onCancel={() => { if (!acting) ask = null; }}
/>
