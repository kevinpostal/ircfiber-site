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
          <div class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Gateway <span class="normal-case text-[10px] text-muted">— vibe.d REST + WS</span></div>
          <dl class="space-y-1 text-xs">
            <div class="flex gap-2"><dt class="w-16 shrink-0 font-medium text-muted">Commit:</dt><dd class="font-mono text-text">{data.gateway.short} <span class="text-muted">({data.gateway.branch})</span></dd></div>
            <div class="flex gap-2"><dt class="w-16 shrink-0 font-medium text-muted">Full hash:</dt><dd class="break-all font-mono text-[11px] text-muted">{data.gateway.commit}</dd></div>
            <div class="flex gap-2"><dt class="w-16 shrink-0 font-medium text-muted">Describe:</dt><dd class="font-mono text-muted">{data.gateway.describe} <span class="text-muted">·</span> <span class="font-medium text-text">v{data.gateway.version}</span></dd></div>
            <div class="flex gap-2"><dt class="w-16 shrink-0 font-medium text-muted">Built:</dt><dd class="text-muted">{fmtTime(data.gateway.builtAt)} <span class="text-muted">on</span> {data.gateway.builtHost}</dd></div>
          </dl>
          {#if data.gateway.deployed && data.gateway.deployed !== data.gateway.short && data.gateway.deployed !== data.gateway.commit}
            <div class="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">Deployed {data.gateway.deployed.slice(0,7)} ≠ baked {data.gateway.short} — redeploy pending?</div>
          {/if}
        </div>
        <div class="rounded-lg border border-border bg-surface-2 p-3">
          <div class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Frontend <span class="normal-case text-[10px] text-muted">— Svelte admin + Vite</span></div>
          <dl class="space-y-1 text-xs">
            <div class="flex gap-2"><dt class="w-16 shrink-0 font-medium text-muted">Commit:</dt><dd class="font-mono text-text">{BUILD_INFO.short} <span class="text-muted">({BUILD_INFO.branch})</span></dd></div>
            <div class="flex gap-2"><dt class="w-16 shrink-0 font-medium text-muted">Full hash:</dt><dd class="break-all font-mono text-[11px] text-muted">{BUILD_INFO.commit}</dd></div>
            <div class="flex gap-2"><dt class="w-16 shrink-0 font-medium text-muted">Describe:</dt><dd class="font-mono text-muted">{BUILD_INFO.describe} <span class="text-muted">·</span> <span class="font-medium text-text">v{BUILD_INFO.version}</span></dd></div>
            <div class="flex gap-2"><dt class="w-16 shrink-0 font-medium text-muted">Built:</dt><dd class="text-muted">{fmtTime(BUILD_INFO.builtAt)} <span class="text-muted">on</span> {BUILD_INFO.builtHost}</dd></div>
          </dl>
          {#if data.gateway.short !== BUILD_INFO.short && BUILD_INFO.short !== 'unknown'}
            <div class="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">Frontend {BUILD_INFO.short} ≠ gateway {data.gateway.short} — frontend/gateway drift</div>
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
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="h-2 w-2 rounded-full {eng.isHealthy ? 'bg-success' : 'bg-danger'}"></span>
                    <span class="font-mono text-sm font-medium text-text">{eng.serverId}</span>
                    <StatusBadge label={eng.isHealthy ? 'healthy' : 'down'} tone={eng.isHealthy ? 'success' : 'danger'} size="sm" />
                  </div>
                  <dl class="mt-1 space-y-0.5 text-xs">
                    <div class="flex gap-2"><dt class="w-16 shrink-0 font-medium text-muted">Commit:</dt><dd class="font-mono text-text">{eng.gitShort ?? '—'} <span class="text-muted">({eng.gitBranch ?? '—'})</span> <span class="text-muted">· {eng.gitDescribe ?? '—'}</span></dd></div>
                    <div class="flex gap-2"><dt class="w-16 shrink-0 font-medium text-muted">Full hash:</dt><dd class="break-all font-mono text-[11px] text-muted">{eng.gitHash ?? '—'}</dd></div>
                    <div class="flex gap-2"><dt class="w-16 shrink-0 font-medium text-muted">Version:</dt><dd class="text-muted">v{eng.version ?? '—'} <span class="text-muted">· built</span> {fmtTime(eng.buildTime)}</dd></div>
                  </dl>
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
