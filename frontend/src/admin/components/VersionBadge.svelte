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
    if (!data?.gateway) return `frontend ${BUILD_INFO.short} @ ${BUILD_INFO.branch} — gateway not yet fetched`;
    const g = data.gateway;
    return `gateway ${g.short} (${g.describe}) @ ${g.branch}\nbuilt ${g.builtAt} on ${g.builtHost}\ncommit ${g.commit}\nfrontend ${BUILD_INFO.short} @ ${BUILD_INFO.branch} built ${BUILD_INFO.builtAt}`;
  });
</script>

<a
  href="#/version"
  title={tooltip}
  class="hidden items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] font-mono text-muted hover:border-primary/30 hover:text-text md:flex"
>
  <span class="h-2 w-2 rounded-full bg-success"></span>
  <span>{gatewayShort}</span>
  {#if gatewayBranch !== 'unknown'}
    <span class="text-[10px] text-muted">({gatewayBranch})</span>
  {/if}
</a>
<!-- mobile: just short -->
<a href="#/version" title={tooltip} class="flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] font-mono text-muted md:hidden">
  {gatewayShort.slice(0,7)}
</a>
