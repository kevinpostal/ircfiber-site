<script lang="ts">
  import { onMount } from 'svelte';
  import { version, fetchVersion } from '../stores/version';
  import { BUILD_INFO } from '../../lib/buildInfo';

  let data = $state<any>(null);
  let err: string | null = null;

  onMount(async () => {
    try {
      const r = await fetch('/api/version', { credentials: 'include' });
      if (r.ok) data = await r.json();
    } catch (e: any) { err = e?.message ?? String(e); }
    // also subscribe to store if already fetched elsewhere
    const unsub = version.subscribe(v => { if(v) data = v; });
    if (!data) fetchVersion();
    return () => unsub();
  });

  const gatewayShort = $derived(data?.gateway?.short ?? data?.short ?? BUILD_INFO.short);
  const gatewayBranch = $derived(data?.gateway?.branch ?? data?.branch ?? BUILD_INFO.branch);
  const tooltip = $derived.by(() => {
    if (!data?.gateway) return `Frontend\n  Commit: ${BUILD_INFO.short} (${BUILD_INFO.branch})\n  Full: ${BUILD_INFO.commit}\n  Describe: ${BUILD_INFO.describe}\n  Version: v${BUILD_INFO.version}\n  Built: ${BUILD_INFO.builtAt} on ${BUILD_INFO.builtHost}\n— gateway not yet fetched`;
    const g = data.gateway;
    return `Gateway\n  Commit: ${g.short} (${g.branch})\n  Full: ${g.commit}\n  Describe: ${g.describe} · v${g.version}\n  Built: ${g.builtAt} on ${g.builtHost}\nFrontend\n  Commit: ${BUILD_INFO.short} (${BUILD_INFO.branch})\n  Full: ${BUILD_INFO.commit}\n  Describe: ${BUILD_INFO.describe} · v${BUILD_INFO.version}\n  Built: ${BUILD_INFO.builtAt} on ${BUILD_INFO.builtHost}`;
  });
</script>

<a
  href="#/version"
  title={tooltip}
  class="hidden items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] font-mono text-muted hover:border-primary/30 hover:text-text md:flex"
>
  <span class="h-2 w-2 rounded-full bg-success"></span>
  <span class="text-[10px] text-muted">Gateway:</span> <span>{gatewayShort}</span>
  {#if gatewayBranch !== 'unknown'}
    <span class="text-[10px] text-muted">({gatewayBranch})</span>
  {/if}
</a>
<!-- mobile: just short -->
<a href="#/version" title={tooltip} class="flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] font-mono text-muted md:hidden">
  {gatewayShort.slice(0,7)}
</a>
