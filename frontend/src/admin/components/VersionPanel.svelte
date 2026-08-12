<script lang="ts">
  import { onMount } from 'svelte';
  import { version, versionError, versionLoading, fetchVersion, type VersionResponse } from '../stores/version';
  import { BUILD_INFO } from '../../lib/buildInfo';
  import Card from './Card.svelte';
  import StatusBadge from './StatusBadge.svelte';

  let data: VersionResponse | null = null;
  let loading = true;
  let error: string | null = null;

  const unsub = version.subscribe(v => { if(v) data = v; });
  const unsubErr = versionError.subscribe(e => error = e);
  const unsubLoad = versionLoading.subscribe(v => loading = v);

  onMount(() => {
    fetchVersion();
    return () => { unsub(); unsubErr(); unsubLoad(); };
  });

  function fmtTime(s: string): string {
    if (!s || s === 'unknown') return '—';
    try { return new Date(s).toLocaleString(); } catch { return s; }
  }
  function short(v: string): string { return v && v !== 'unknown' ? v.slice(0,7) : '—'; }
</script>

<Card title="Build Versions" subtitle="Gateway, engines and frontend — git commit, branch, built time">
  {#snippet actions()}
    <button type="button" onclick={fetchVersion} class="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text hover:border-primary/40">Refresh</button>
  {/snippet}

  {#if loading && !data}
    <div class="flex h-24 items-center justify-center"><div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div></div>
  {:else if error && !data}
    <div class="text-sm text-danger">Failed to load version: {error}</div>
  {:else if data}
    <div class="space-y-6">
      <!-- Gateway + Frontend -->
      <div class="grid gap-4 md:grid-cols-2">
        <div class="rounded-lg border border-border bg-surface-2 p-3">
          <div class="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Gateway</div>
          <div class="font-mono text-sm font-semibold text-text">{data.gateway.short} <span class="text-xs text-muted">({data.gateway.branch})</span></div>
          <div class="mt-1 break-all text-xs text-muted">{data.gateway.commit}</div>
          <div class="text-xs text-muted">{data.gateway.describe} · v{data.gateway.version}</div>
          <div class="text-xs text-muted">built {fmtTime(data.gateway.builtAt)} on {data.gateway.builtHost}</div>
          {#if data.gateway.deployed && data.gateway.deployed !== data.gateway.short && data.gateway.deployed !== data.gateway.commit}
            <div class="mt-1 text-xs text-amber-600">deployed {data.gateway.deployed} ≠ baked {data.gateway.short} — redeploy pending?</div>
          {/if}
        </div>
        <div class="rounded-lg border border-border bg-surface-2 p-3">
          <div class="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Frontend</div>
          <div class="font-mono text-sm font-semibold text-text">{BUILD_INFO.short} <span class="text-xs text-muted">({BUILD_INFO.branch})</span></div>
          <div class="mt-1 break-all text-xs text-muted">{BUILD_INFO.commit}</div>
          <div class="text-xs text-muted">{BUILD_INFO.describe} · v{BUILD_INFO.version}</div>
          <div class="text-xs text-muted">built {fmtTime(BUILD_INFO.builtAt)} on {BUILD_INFO.builtHost}</div>
          {#if data.gateway.short !== BUILD_INFO.short && BUILD_INFO.short !== 'unknown'}
            <div class="mt-1 text-xs text-amber-600">frontend {BUILD_INFO.short} ≠ gateway {data.gateway.short} — frontend/gateway drift</div>
          {/if}
        </div>
      </div>

      <!-- Engines -->
      <div>
        <div class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Engines ({data.engines.length})</div>
        {#if data.engines.length === 0}
          <div class="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted">No engines registered</div>
        {:else}
          <div class="space-y-2">
            {#each data.engines as eng (eng.serverId)}
              <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="h-2 w-2 rounded-full {eng.isHealthy ? 'bg-success' : 'bg-danger'}"></span>
                    <span class="font-mono text-sm font-medium text-text">{eng.serverId}</span>
                    <StatusBadge label={eng.isHealthy ? 'healthy' : 'down'} tone={eng.isHealthy ? 'success' : 'danger'} size="sm" />
                  </div>
                  <div class="mt-1 font-mono text-xs text-muted">{eng.gitShort ?? '—'} <span class="text-[11px]">({eng.gitBranch ?? '—'})</span> · {eng.gitDescribe ?? '—'}</div>
                  <div class="break-all font-mono text-[11px] text-muted">{eng.gitHash ?? '—'}</div>
                  <div class="text-xs text-muted">v{eng.version ?? '—'} · built {fmtTime(eng.buildTime)}</div>
                </div>
                <div class="text-xs">
                  {#if eng.gitShort && data.gateway.short && eng.gitShort !== data.gateway.short}
                    <span class="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">drift vs gateway</span>
                  {:else if eng.gitShort === data.gateway.short}
                    <span class="rounded bg-success/10 px-1.5 py-0.5 text-success">in sync</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="text-xs text-muted">
        <a href="/api/version" target="_blank" class="text-primary hover:underline">Raw JSON → /api/version</a>
        <span class="mx-1">·</span>
        <a href="/api/git" target="_blank" class="text-primary hover:underline">/api/git</a>
      </div>
    </div>
  {/if}
</Card>
