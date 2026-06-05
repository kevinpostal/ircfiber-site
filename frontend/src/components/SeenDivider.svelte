<script lang="ts">
  import { ircState } from '../stores/ircStore.svelte';

  const label = $derived(
    ircState.focusLost
      ? 'New messages since you tabbed out'
      : 'New messages'
  );
</script>

<div class="row seenDivider">
  <hr class="seenDividerLine" />
  <h4 class="divider-text-wrapper">
    <span class="divider-text">{label}</span>
  </h4>
  <hr class="seenDividerLine" />
</div>
