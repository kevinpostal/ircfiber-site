<script lang="ts">
  import { formatDate, formatRelativeTime } from '../lib/utils';
  interface Props { date: string; }
  let { date }: Props = $props();
</script>

<div class="row dateChange">
  <h3>{formatDate(date)} <span class="relTime">&#9201; {formatRelativeTime(date)}</span></h3>
</div>

<style>
  /* IRCCloud date rows scroll with the log — the floating date pinned to
     the top of the viewport is the ScrollClock overlay, not a sticky row.
     (Sticky here caused a doubled date bar while scrolled up.) */
  .dateChange h3 {
    margin: 0;
    padding: 3px 5px 8px;
    font-size: 14px;
    line-height: 18px;
    font-family: Hack, monospace;
    font-weight: 400;
    text-align: center;
    color: #e6e6e6;
    background: #333;
    box-shadow: inset 0 -3px 0 #4d4d4d, inset 0 -4px 0 #262626, inset 0 -1px 0 #262626;
  }
  .relTime {
    font-family: Hack, monospace;
  }
</style>
