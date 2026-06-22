<script lang="ts">
  /**
   * EmptyState — shown when a list has no data.
   */
  interface Props {
    title: string;
    description?: string;
    icon?: string;
    children?: import('svelte').Snippet;
  }
  let { title, description, icon = '📭', children }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center gap-3 py-12 text-center">
  <div class="text-4xl">{icon}</div>
  <div>
    <h3 class="text-base font-semibold text-heading">{title}</h3>
    {#if description}
      <p class="mt-1 text-sm text-muted">{description}</p>
    {/if}
  </div>
  {#if children}
    <div>{@render children()}</div>
  {/if}
</div>