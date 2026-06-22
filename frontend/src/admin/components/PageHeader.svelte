<script lang="ts">
  /**
   * PageHeader — title + optional subtitle + breadcrumbs + actions slot.
   */
  interface Crumb { label: string; href?: string; }
  interface Props {
    title: string;
    subtitle?: string;
    breadcrumbs?: Crumb[];
    actions?: import('svelte').Snippet;
  }
  let { title, subtitle, breadcrumbs = [], actions }: Props = $props();
</script>

<header class="mb-6">
  {#if breadcrumbs.length > 0}
    <nav class="mb-2 flex items-center gap-1 text-xs text-muted">
      {#each breadcrumbs as crumb, i}
        {#if i > 0}
          <span>/</span>
        {/if}
        {#if crumb.href}
          <a href={crumb.href} class="hover:text-primary">{crumb.label}</a>
        {:else}
          <span>{crumb.label}</span>
        {/if}
      {/each}
    </nav>
  {/if}
  <div class="flex items-start justify-between gap-4">
    <div class="min-w-0 flex-1">
      <h1 class="text-2xl font-semibold text-heading">{title}</h1>
      {#if subtitle}
        <p class="mt-1 text-sm text-muted">{subtitle}</p>
      {/if}
    </div>
    {#if actions}
      <div class="flex shrink-0 items-center gap-2">
        {@render actions()}
      </div>
    {/if}
  </div>
</header>