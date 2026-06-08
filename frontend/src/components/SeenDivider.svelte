<script lang="ts">
  import { ircState } from '../stores/ircStore.svelte';

  interface Props {
    type?: 'focus' | 'bottom' | 'last';
  }
  let { type = 'focus' }: Props = $props();

  const label = $derived(
    type === 'focus' && ircState.focusLost
      ? 'New messages since you tabbed out'
      : type === 'bottom'
      ? 'Newer messages below'
      : 'New messages'
  );
</script>

<div class="row seenDivider" class:focusSeen={type === 'focus'} class:bottomSeen={type === 'bottom'}>
  <hr class="seenDividerLine" />
  <h4 class="divider-text-wrapper">
    <span class="divider-text">{label}</span>
  </h4>
  <hr class="seenDividerLine" />
</div>
