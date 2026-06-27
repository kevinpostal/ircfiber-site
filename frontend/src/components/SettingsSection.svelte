<script lang="ts">
  let { heading = '', children }: { heading?: string; children?: import('svelte').Snippet } = $props();
</script>

<section class="settings-section" role="region" aria-label={heading || undefined}>
  {#if heading}
    <h3 class="settings-section__heading">{heading}</h3>
  {/if}
  <div class="settings-section__body">
    {#if children}{@render children()}{/if}
  </div>
</section>
