<script lang="ts">
  /**
   * LogTable -- virtualized list of LogRows.
   *
   * Layout:
   *   [viewport (fixed height, scrollable)]
   *     [spacer (height = rows.length * ROW_HEIGHT)]
   *       [absolutely positioned LogRows at index * ROW_HEIGHT]
   *
   * Virtualization math:
   *   startIdx = floor(scrollTop / ROW_HEIGHT) - OVERSCAN
   *   endIdx   = startIdx + ceil(viewport / ROW_HEIGHT) + 2 * OVERSCAN
   *
   * The outer viewport height is INVARIANT under expand/collapse. The
   * row's "expanded" state is shown only as a highlight ring -- the
   * actual expanded content lives in JsonDrawer (an overlay), so the
   * 32px row height never changes and the offset math never needs to
   * be re-derived. Clicking a row fires `onToggle(id, rect)` and the
   * parent decides what to do (typically: open JsonDrawer).
   *
   * Performance:
   *   - Rows are sliced out of the rendered set (not hidden via CSS),
   *     so 10k-row tables only mount a few dozen nodes.
   *   - scrollTop is a $state. The visibleRange is a $derived.by that
   *     only re-evaluates when scrollTop changes.
   *   - Each row's `top` is set via inline `style` -- no style
   *     recalculation per scroll, only attribute changes.
   */
  import LogRow from './LogRow.svelte';
  import type { LogRow as LogRowType } from '../../stores/logsStore';
  import { getRowId } from './rowId';

  interface Props {
    rows: LogRowType[];
    /** ids that the parent considers "selected" (gets the highlight ring). */
    expandedIds: Set<string>;
    onToggle: (id: string, rect: DOMRect) => void;
    /** Outer viewport height in px. Defaults to 600. */
    height?: number;
  }
  let { rows, expandedIds, onToggle, height = 600 }: Props = $props();

  /**
   * Single source of truth for the row-height invariant. Changing this
   * would require re-validating every virtualization math call site.
   */
  const ROW_HEIGHT = 32;

  /**
   * Render `OVERSCAN` extra rows above and below the visible window so
   * fast scrolling never flashes an empty region. 5 rows = ~160px of
   * "pre-mounted" buffer, which covers a single fling on a trackpad.
   */
  const OVERSCAN = 5;

  /**
   * Current scroll offset of the viewport. Tracked as a $state so the
   * `$derived.by(visibleRange)` re-runs only when this changes.
   */
  let scrollTop = $state(0);

  /**
   * Total scrollable height of the inner spacer. Equals
   * `rows.length * ROW_HEIGHT` -- the table's vertical reach, not the
   * viewport height. When rows is empty this is 0 and the spacer
   * collapses; the outer viewport stays at its `height` value.
   */
  const totalHeight = $derived(rows.length * ROW_HEIGHT);

  /**
   * [startIdx, endIdx) into `rows` that should actually be mounted.
   * Clamps at both ends so we never slice with a negative start or
   * an end beyond the array length.
   */
  const visibleRange = $derived.by<{ start: number; end: number }>(() => {
    const rawStart = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
    const visibleCount = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
    const start = Math.max(0, rawStart);
    const end = Math.min(rows.length, start + visibleCount);
    return { start, end };
  });

  function onScroll(e: Event): void {
    const t = e.currentTarget as HTMLElement;
    scrollTop = t.scrollTop;
  }
</script>

<div
  class="log-table-viewport overflow-auto rounded border border-border bg-surface"
  style:height="{height}px"
  style:overflow="auto"
  data-testid="log-table-viewport"
  data-row-count={rows.length}
  onscroll={onScroll}
>
  <div
    class="log-table-spacer relative w-full"
    style:height="{totalHeight}px"
    data-testid="log-table-spacer"
    data-empty={rows.length === 0 ? 'true' : 'false'}
  >
    {#each rows.slice(visibleRange.start, visibleRange.end) as row, i (getRowId(row))}
      {@const idx = visibleRange.start + i}
      <div
        class="absolute left-0 right-0"
        style:top="{idx * ROW_HEIGHT}px"
        style:height="{ROW_HEIGHT}px"
        data-testid="log-table-row-anchor"
      >
        <LogRow
          {row}
          expanded={expandedIds.has(getRowId(row))}
          {onToggle}
        />
      </div>
    {/each}
  </div>
</div>