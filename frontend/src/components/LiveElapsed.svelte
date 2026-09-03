<script lang="ts">
  // Ticks on its own interval and renders the time elapsed since `since`.
  // Isolated in its own component so the periodic update only re-renders
  // this text node — the surrounding log / header (hundreds of rows) is
  // untouched. This is the only elapsed-time ticker in the app: the
  // server log's live phase row, the header uptime / connecting pill and
  // any countdown all reuse it with their own `format`.
  import { formatDuration } from '../lib/serverLogGroups';

  interface Props {
    /** Unix ms the counter starts from. */
    since: number;
    /** Text rendered before the label. */
    prefix?: string;
    /** Label formatter for the elapsed ms; defaults to `formatDuration`. */
    format?: (ms: number) => string;
    /** Tick interval in ms (1 Hz by default). */
    interval?: number;
  }
  let { since, prefix = '', format = formatDuration, interval = 1000 }: Props = $props();

  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => { now = Date.now(); }, interval);
    return () => clearInterval(id);
  });

  const label = $derived(format(Math.max(0, now - since)));
</script>

<span class="live-elapsed" data-testid="live-elapsed">{prefix}{label}</span>

<style>
  .live-elapsed { font-variant-numeric: tabular-nums; }
</style>
