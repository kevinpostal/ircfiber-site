<script lang="ts">
  import { formatDateTimeTitle, formatShortRelativeTime } from '../lib/utils';

  interface Props {
    position: 'above' | 'below';
    count: number;
    timestamp?: number | null;
    mentions?: number;
    onClick: (e?: MouseEvent) => void;
    onDismiss?: () => void;
  }
  let { position, count, timestamp, mentions = 0, onClick, onDismiss }: Props = $props();

  const THRESHOLD = 100;
  // Live tick so "less than a minute" → "a minute ago" without needing a new message.
  let nowTick = $state(Date.now());
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    // Restart timer when timestamp changes (or on mount)
    if (timestamp) {
      nowTick = Date.now();
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = setInterval(() => { nowTick = Date.now(); }, 30000);
      return () => { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } };
    } else {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }
  });
  const relativeText = $derived.by(() => {
    // Depend on nowTick so the derived re-runs every 30s while mounted
    void nowTick;
    return timestamp ? formatShortRelativeTime(timestamp) : '';
  });
  const fullTitle = $derived(timestamp ? formatDateTimeTitle(new Date(timestamp)) : '');
  // IRCCloud-style: if count > 100, show only timeago ("a day of unread messages").
  // Otherwise show count + timeago in parens ("42 unread messages (a day)").
  const tooMany = $derived(count > THRESHOLD);
</script>

<div class="chattercell show {position === 'above' ? 'upperchattercell' : 'lowerchattercell'}">
  <div class="extras {position === 'above' ? 'bufferAboveExtras' : 'bufferBelowExtras'}">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <span class="extrasBar" role="button" tabindex="0" onclick={(e) => onClick(e)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
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
    {#if onDismiss}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <span class="extrasDismiss" role="button" tabindex="0" title="Mark as read (Esc)" onclick={onDismiss} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDismiss(); } }}>Mark as read</span>
    {/if}
  </div>
</div>

<style>
  .extrasDismiss { margin-left: 10px; cursor: pointer; opacity: 0.8; font-size: 12px; }
  .extrasDismiss:hover { text-decoration: underline; opacity: 1; }
</style>
