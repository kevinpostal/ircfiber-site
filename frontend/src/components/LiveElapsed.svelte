<script lang="ts">
  // Ticks once a second and renders the time elapsed since `since`.
  // Isolated in its own component so the 1 Hz update only re-renders this
  // text node — the surrounding ServerLogTimeline (hundreds of rows) is
  // untouched, which is why the timeline's own ticker had been disabled.
  import { formatDuration } from '../lib/serverLogGroups';

  interface Props {
    /** Unix ms the counter starts from. */
    since: number;
    /** Optional cap: stop ticking once this many ms have elapsed (e.g. a known deadline). */
    prefix?: string;
  }
  let { since, prefix = '' }: Props = $props();

  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(id);
  });

  const label = $derived(formatDuration(Math.max(0, now - since)));
</script>

<span class="live-elapsed" data-testid="live-elapsed">{prefix}{label}</span>

<style>
  .live-elapsed { font-variant-numeric: tabular-nums; }
</style>
