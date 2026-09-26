<script lang="ts">
  let { account }: { account: string } = $props();
</script>

{#if account && account !== '*'}
  <span class="services-badge" title="Registered with services as {account}" aria-label="Registered with services as {account}">
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.25"/>
      <path d="M5 8.3l2 2 4-4.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </span>
{/if}

<style>
  /* Quiet by default: a hairline mark in the same grey as secondary text
     (realname, BOT pill), so it reads as metadata rather than a status
     light. Rows and list entries reveal it on hover. */
  .services-badge {
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
    color: #8b949e;
    opacity: 0.55;
    margin-left: 4px;
    position: relative;
    top: -1px;
    cursor: default;
    user-select: none;
    transition: opacity 120ms ease, color 120ms ease;
  }
  :global(.member-item:hover) .services-badge,
  :global(.messageRow:hover) .services-badge,
  :global(.userContext) .services-badge {
    opacity: 1;
    color: #7fbf6a;
  }
</style>
