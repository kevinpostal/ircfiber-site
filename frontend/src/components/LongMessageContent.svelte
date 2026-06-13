<script lang="ts">
  import { countLines, previewText, MAX_PREVIEW_LINES } from '../lib/utils';

  interface Props {
    text: string;
    render: (text: string) => string;
  }

  let { text, render }: Props = $props();

  let expanded = $state(false);

  const lineCount = $derived(countLines(text));
  const needsTruncation = $derived(lineCount > MAX_PREVIEW_LINES);
  const displayText = $derived(previewText(text, expanded || !needsTruncation));
</script>

<span class="longMessageContent">
  {@html render(displayText)}
  {#if needsTruncation}
    <button
      type="button"
      class="messageTruncated"
      aria-expanded={expanded}
      onclick={() => expanded = !expanded}
    >{expanded ? 'Show less' : `Show more (${lineCount - MAX_PREVIEW_LINES} lines)`}</button>
  {/if}
</span>
