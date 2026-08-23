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
    {@const sync = (() => {
      const siteSync = data.gateway.commit !== 'unknown' && BUILD_INFO.commit !== 'unknown' && data.gateway.commit === BUILD_INFO.commit;
      const filteredEngineHashes = data.engines.map(e => e.gitHash).filter(c => c && c !== 'unknown');
      const engineSync = data.engines.length === 0 || new Set(filteredEngineHashes).size === 1;
      const allSync = siteSync && engineSync;
      const times = [
        { name: 'Gateway', time: data.gateway.builtAt, commit: data.gateway.short },
        { name: 'Frontend', time: BUILD_INFO.builtAt, commit: BUILD_INFO.short },
        ...data.engines.map(e => ({ name: e.serverId, time: e.buildTime, commit: e.gitShort }))
      ].filter(t => t.time && t.time !== 'unknown').sort((a,b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      const mostRecent = times[0] ?? null;
      return { siteSync, engineSync, allSync, mostRecent };
    })()}
    <div class="space-y-6">
      {#if sync}
        {#if sync.siteSync}
          <div class="rounded-md bg-success/10 px-3 py-2 text-xs font-medium text-success">✓ Site in sync — gateway {data.gateway.short} == frontend {BUILD_INFO.short} {#if sync.mostRecent}· Most recent: {sync.mostRecent.name} {sync.mostRecent.commit?.slice(0,7)} at {fmtTime(sync.mostRecent.time)}{/if}</div>
        {:else if data.gateway.commit === 'unknown' || BUILD_INFO.commit === 'unknown'}
          <div class="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">Site commit unknown — gateway {data.gateway.short} · frontend {BUILD_INFO.short}</div>
        {:else}
          <div class="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">⚠ Site drift — gateway {data.gateway.short} ≠ frontend {BUILD_INFO.short}<div class="mt-1 text-[11px]">Gateway {data.gateway.short} · Frontend {BUILD_INFO.short}</div></div>
        {/if}
        {#if data.engines.length > 0}
          {#if sync.engineSync}
            <div class="rounded-md bg-success/10 px-3 py-2 text-xs font-medium text-success">✓ Engines in sync at <span class="font-mono">{data.engines[0].gitShort?.slice(0,7) ?? '—'}</span> — {data.engines.length} engine(s) same commit</div>
          {:else}
            <div class="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">⚠ Engines out of sync — {data.engines.map(e=>e.gitShort || '—').join(', ')}<div class="mt-1 text-[11px]">Engines differ — not compared to site (expected after split)</div></div>
          {/if}
        {/if}
      {/if}
      <div class="grid gap-4 md:grid-cols-2">
        <div class="rounded-lg border border-border bg-surface-2 p-3">
          <div class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Gateway <span class="normal-case text-[10px] text-muted">— vibe.d REST + WS</span></div>
          <div class="space-y-1 text-xs">
            <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Commit:</span><span class="font-mono text-text">{data.gateway.short} <span class="text-muted">({data.gateway.branch})</span></span></div>
            <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Full hash:</span><span class="break-all font-mono text-[11px] text-muted">{data.gateway.commit}</span></div>
            <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Describe:</span><span class="font-mono text-muted">{data.gateway.describe} <span class="text-muted">·</span> <span class="font-medium text-text">v{data.gateway.version}</span></span></div>
            <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Message:</span><span class="truncate text-text" title={data.gateway.message ?? ''}>{#if data.gateway.commitUrl}<a href={data.gateway.commitUrl} target="_blank" class="hover:underline hover:text-primary">{data.gateway.message ?? data.gateway.describe}</a>{:else}{data.gateway.message ?? data.gateway.describe}{/if}</span></div>
            <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Built:</span><span class="text-muted">{fmtTime(data.gateway.builtAt)} <span class="text-muted">on</span> {data.gateway.builtHost}</span></div>
          </div>
          {#if data.gateway.deployed && data.gateway.deployed !== data.gateway.short && data.gateway.deployed !== data.gateway.commit}
            <div class="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">Deployed {data.gateway.deployed.slice(0,7)} ≠ baked {data.gateway.short} — redeploy pending?</div>
          {/if}
        </div>
        <div class="rounded-lg border border-border bg-surface-2 p-3">
          <div class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Frontend <span class="normal-case text-[10px] text-muted">— Svelte admin + Vite</span></div>
          <div class="space-y-1 text-xs">
            <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Commit:</span><span class="font-mono text-text">{BUILD_INFO.short} <span class="text-muted">({BUILD_INFO.branch})</span></span></div>
            <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Full hash:</span><span class="break-all font-mono text-[11px] text-muted">{BUILD_INFO.commit}</span></div>
            <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Describe:</span><span class="font-mono text-muted">{BUILD_INFO.describe} <span class="text-muted">·</span> <span class="font-medium text-text">v{BUILD_INFO.version}</span></span></div>
            <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Message:</span><span class="truncate text-text" title={(BUILD_INFO as any).message ?? ''}>{#if (BUILD_INFO as any).commitUrl}<a href={(BUILD_INFO as any).commitUrl} target="_blank" class="hover:underline hover:text-primary">{(BUILD_INFO as any).message ?? BUILD_INFO.describe}</a>{:else}{(BUILD_INFO as any).message ?? BUILD_INFO.describe}{/if}</span></div>
            <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Built:</span><span class="text-muted">{fmtTime(BUILD_INFO.builtAt)} <span class="text-muted">on</span> {BUILD_INFO.builtHost}</span></div>
          </div>
          {#if data.gateway.short !== BUILD_INFO.short && BUILD_INFO.short !== 'unknown'}
            <div class="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">Frontend {BUILD_INFO.short} ≠ gateway {data.gateway.short} — frontend/gateway drift</div>
          {/if}
        </div>
      </div>
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
                  <div class="mt-1 space-y-0.5 text-xs">
                    <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Commit:</span><span class="font-mono text-text">{eng.gitShort ?? '—'} <span class="text-muted">({eng.gitBranch ?? '—'})</span> <span class="text-muted">· {eng.gitDescribe ?? '—'}</span></span></div>
                    <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Full hash:</span><span class="break-all font-mono text-[11px] text-muted">{eng.gitHash ?? '—'}</span></div>
                    <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Message:</span><span class="truncate text-text" title={eng.gitMessage ?? ''}>{#if eng.gitCommitUrl}<a href={eng.gitCommitUrl} target="_blank" class="hover:underline hover:text-primary">{eng.gitMessage ?? eng.gitDescribe ?? '—'}</a>{:else}{eng.gitMessage ?? eng.gitDescribe ?? '—'}{/if}</span></div>
                    <div class="flex gap-2"><span class="w-16 shrink-0 font-medium text-muted">Version:</span><span class="text-muted">v{eng.version ?? '—'} <span class="text-muted">· built</span> {fmtTime(eng.buildTime)}</span></div>
                  </div>
                </div>
                <div class="text-xs">
                  {#if eng.gitShort && data.gateway.short && eng.gitShort !== data.gateway.short}
                    <span class="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">drift vs site (info)</span>
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
