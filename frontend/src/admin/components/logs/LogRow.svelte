<script lang="ts">
  /**
   * LogRow -- one fixed-height (32px) row in the logs table.
   *
   * Displays: timestamp, severity chip, service, body (truncated to 200),
   * and a trace_id link (or `--` when absent).
   *
   * Clicking the row delegates to the parent via `onToggle(rowId, rect)`
   * so the parent can open the JsonDrawer overlay at the row's screen
   * rect. No inline-expansion lives here -- that would break the 32px
   * invariant the table's offset math depends on. Expansion is a separate
   * overlay (JsonDrawer) with its own z-index.
   *
   * The id derivation is delegated to `getRowId()` from ./rowId so
   * LogRow and LogTable agree on identity -- two callers stay in sync
   * through a single source of truth instead of a copy-paste.
   */
  import type { LogRow } from '../../stores/logsStore';
  import { truncate } from '../../lib/format';
  import { TAILNET_SIGNOZ_LOGS_URL } from '../../lib/signozUrl';
  import { getRowId } from './rowId';

  interface Props {
    row: LogRow;
    /** When true, the row gets a subtle highlight ring (selected state). */
    expanded?: boolean;
    /** Called with (id, rect) when the user clicks the row. */
    onToggle: (id: string, rect: DOMRect) => void;
  }
  let { row, expanded = false, onToggle }: Props = $props();

  /**
   * Format a unix-ms timestamp as HH:MM:SS.mmm. Local time -- SigNoz's
   * logs panel also renders the operator's local time for incoming
   * rows, and consistency between the toolbar's "Live since" pill and
   * the row timestamps matters more than UTC.
   */
  function formatTimestamp(ms: number): string {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const mmm = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${mmm}`;
  }

  /** 200-char cap on body to keep the 32px row invariant intact. */
  const BODY_MAX = 200;
  const bodyText = $derived(truncate(row.body, BODY_MAX));
  const timestampText = $derived(formatTimestamp(row.timestamp));

  /**
   * Severity -> tailwind classes. Uses theme tokens where they exist
   * (`primary`, `warn`, `danger`) and falls back to stock Tailwind for
   * DEBUG (no debug token in the theme). The chip is a small filled
   * pill -- readable at 32px row height without crowding the body.
   *
   * Color contrast is intentionally muted (20% alpha background) so the
   * chip stays a chip, not a shout.
   */
  const SEVERITY_CLASSES: Record<LogRow['severity'], string> = {
    DEBUG: 'bg-blue-500/20 text-blue-300',
    INFO: 'bg-primary/20 text-primary',
    WARN: 'bg-warn/20 text-warn',
    ERROR: 'bg-danger/20 text-danger',
    FATAL: 'bg-danger text-bg',
  };
  const severityClass = $derived(
    SEVERITY_CLASSES[row.severity] ?? 'bg-primary/20 text-primary',
  );

  /** URL into the tailnet SigNoz logs explorer filtered by this trace. */
  const traceUrl = $derived(
    row.traceId
      ? `${TAILNET_SIGNOZ_LOGS_URL}?filter=${encodeURIComponent(`trace_id = '${row.traceId}'`)}`
      : null,
  );

  function handleClick(e: MouseEvent): void {
    const el = e.currentTarget as HTMLElement;
    onToggle(getRowId(row), el.getBoundingClientRect());
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      onToggle(getRowId(row), el.getBoundingClientRect());
    }
  }
</script>

<div
  class="flex h-8 cursor-pointer items-center gap-3 border-b border-border/40 px-3 text-xs text-text hover:bg-surface-2"
  class:ring-1={expanded}
  class:ring-primary={expanded}
  data-testid="log-row"
  data-row-id={getRowId(row)}
  data-expanded={expanded ? 'true' : 'false'}
  role="button"
  tabindex="0"
  aria-expanded={expanded}
  onclick={handleClick}
  onkeydown={handleKeydown}
>
  <span
    class="w-24 shrink-0 font-mono text-muted"
    data-testid="log-row-timestamp"
  >{timestampText}</span>

  <span
    class="inline-flex h-5 w-16 shrink-0 items-center justify-center rounded px-1.5 font-semibold {severityClass}"
    data-testid="log-row-severity"
    data-severity={row.severity}
  >{row.severity}</span>

  <span
    class="w-40 shrink-0 truncate text-text"
    data-testid="log-row-service"
    title={row.service}
  >{row.service || '--'}</span>

  <span
    class="min-w-0 flex-1 truncate text-text"
    data-testid="log-row-body"
    title={row.body}
  >{bodyText}</span>

  {#if traceUrl}
    <a
      href={traceUrl}
      target="_blank"
      rel="noopener"
      class="shrink-0 font-mono text-primary underline"
      data-testid="log-row-trace-link"
      onclick={(e) => e.stopPropagation()}
    >{row.traceId}</a>
  {:else}
    <span
      class="shrink-0 font-mono text-muted"
      data-testid="log-row-trace-placeholder"
    >--</span>
  {/if}
</div>