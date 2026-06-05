<script lang="ts">
  import { getAllEmoji } from '../lib/emoji';

  interface Props {
    onSelect: (emoji: string) => void;
    onClose: () => void;
  }
  let { onSelect, onClose }: Props = $props();

  let query = $state('');
  let searchEl: HTMLInputElement;

  const allEmoji = getAllEmoji();
  const filtered = $derived(
    query
      ? allEmoji.filter(e => e.name.includes(query.toLowerCase())).slice(0, 80)
      : allEmoji
  );

  function handleClick(e: MouseEvent): void {
    e.stopPropagation();
  }
</script>

<div class="emoji-picker" onclick={handleClick} role="dialog" aria-label="Emoji picker">
  <div class="emoji-picker__header">
    <input
      type="text"
      bind:this={searchEl}
      bind:value={query}
      placeholder="Search emoji..."
      aria-label="Search emoji"
    />
    <button type="button" class="emoji-picker__close" onclick={onClose} aria-label="Close">&times;</button>
  </div>
  <div class="emoji-picker__grid">
    {#each filtered as e (e.name)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <button type="button" class="emoji-item" title={`:${e.name}:`}
              onclick={() => { onSelect(e.emoji); onClose(); }}>
        {e.emoji}
      </button>
    {/each}
  </div>
</div>
