<script lang="ts">
  let { account }: { account: string } = $props();
</script>

{#if account && account !== '*'}
  <span class="services-badge" title="Registered with services as {account}" aria-label="Registered with services as {account}">
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="currentColor"/>
      <path d="M4.5 8.2l2.3 2.3 4.7-4.8" fill="none" stroke="#0b1a0d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </span>
{/if}

<style>
  .services-badge {
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
    color: #3fd12a;            /* same green as .mode_prefix.mode_VOICED */
    margin-left: 3px;
    position: relative;
    top: -1px;
    cursor: default;
    user-select: none;
  }
</style>
