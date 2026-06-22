<script lang="ts">
  /**
   * Card — standard rounded panel with optional title + actions slot.
   */
  interface Props {
    title?: string;
    subtitle?: string;
    children?: import('svelte').Snippet;
    actions?: import('svelte').Snippet;
    class?: string;
  }
  let { title, subtitle, children, actions, class: klass = '' }: Props = $props();
</script>

<section class="rounded-lg border border-border bg-surface-2 overflow-hidden {klass}">
  {#if title || actions}
    <header class="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
      <div class="min-w-0 flex-1">
        {#if title}
          <h2 class="text-sm font-semibold text-heading">{title}</h2>
        {/if}
        {#if subtitle}
          <p class="mt-0.5 text-xs text-muted">{subtitle}</p>
        {/if}
      </div>
      {#if actions}
        <div class="flex shrink-0 items-center gap-2">
          {@render actions()}
        </div>
      {/if}
    </header>
  {/if}
  {#if children}
    <div class="p-5">
      {@render children()}
    </div>
  {/if}
</section>