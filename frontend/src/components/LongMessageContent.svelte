<script lang="ts">
  import { countLines, previewText, MAX_PREVIEW_LINES, MAX_PREVIEW_CHARS } from '../lib/utils';

  interface Props {
    text: string;
    render: (text: string) => string;
    isBlockArt?: boolean;
  }

  let { text, render, isBlockArt = false }: Props = $props();

  let expanded = $state(false);

  const lineCount = $derived(countLines(text));
  const needsTruncation = $derived(!isBlockArt && (lineCount > MAX_PREVIEW_LINES || text.length > MAX_PREVIEW_CHARS));
  const displayText = $derived(expanded || isBlockArt ? text : previewText(text, false));
</script>

<span class="longMessageContent">{@html render(displayText)}{#if needsTruncation}<button
  type="button"
  class="messageTruncated"
  aria-expanded={expanded}
  onclick={() => expanded = !expanded}
>{expanded ? 'Show less' : `Show more${lineCount > MAX_PREVIEW_LINES ? ` (${lineCount - MAX_PREVIEW_LINES} lines)` : ' (truncated)'}`}</button>{/if}</span>
