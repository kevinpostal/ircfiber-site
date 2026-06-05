<script lang="ts">
  import { formatDateTimeTitle, formatShortRelativeTime } from '../lib/utils';

  interface Props {
    position: 'above' | 'below';
    count: number;
    timestamp?: number | null;
    mentions?: number;
    onClick: () => void;
  }
  let { position, count, timestamp, mentions = 0, onClick }: Props = $props();

  const THRESHOLD = 100;
  const relativeText = $derived(timestamp ? formatShortRelativeTime(timestamp) : '');
  const fullTitle = $derived(timestamp ? formatDateTimeTitle(new Date(timestamp)) : '');
  // IRCCloud-style: if count > 100, show only timeago ("a day of unread messages").
  // Otherwise show count + timeago in parens ("42 unread messages (a day)").
  const tooMany = $derived(count > THRESHOLD);
</script>

<div class="chattercell {position === 'above' ? 'upperchattercell' : 'lowerchattercell'}">
  <div class="extras {position === 'above' ? 'bufferAboveExtras' : 'bufferBelowExtras'}">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <span class="extrasBar" role="button" tabindex="0" onclick={onClick}>
      <span class="extrasButton">{position === 'above' ? '\u2191' : '\u2193'}</span>
      {#if mentions > 0}
        <span>
          <span class="extrasBadge">{mentions}</span>
          <span> mention{mentions !== 1 ? 's' : ''}{count > 0 ? ' and ' : ''}</span>
        </span>
      {/if}
      {#if tooMany && timestamp}
        <span>
          <span title={fullTitle}>{relativeText}</span>
          <span> of unread messages</span>
        </span>
      {:else if count > 0}
        <span>
          <span class="extrasBadge">{count}</span>
          <span> unread message{count !== 1 ? 's' : ''}</span>
          {#if timestamp}
            <span> (<span title={fullTitle}>{relativeText}</span>)</span>
          {/if}
        </span>
      {/if}
    </span>
  </div>
</div>
