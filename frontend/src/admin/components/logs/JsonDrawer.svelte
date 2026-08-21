<script lang="ts">
  /**
   * JsonDrawer -- overlay-expand UI for a single log row's raw JSON.
   *
   * Rendered as a fixed-positioned panel + a full-viewport backdrop.
   * The viewport row never grows because of this component: the parent
   * LogTable keeps its 32px row invariant while JsonDrawer floats above
   * it (z-40). Click the backdrop, the X button, or press Escape to
   * close; the parent owns the `row` prop and just flips it to null.
   *
   * Key highlighting:
   *   - `prettyJson` walks the JSON output line-by-line and wraps each
   *     `"key":` token in a `<span class="text-primary">` so the test
   *     suite can assert that "key highlighting" actually happened
   *     (a plain JSON dump would fail that assertion).
   *   - HTML-escapes `&`, `<`, `>` before the span-wrap pass so the
   *     rendered output cannot inject arbitrary markup.
   *
   * Anchor positioning:
   *   - When `anchorRect` is provided (the click that opened the drawer),
   *     the panel snaps to the row's screen position with a clamp so it
   *     never overflows the viewport.
   *   - When `anchorRect` is null (e.g. opened via keyboard without a
   *     prior click), the panel centers itself.
   *
   * SSR-safety: the position math reads `window.innerWidth` /
   * `window.innerHeight` -- guarded with `typeof window` so the module
   * can be imported by node-side tests without throwing.
   */
  import Dialog from '../../../components/Dialog.svelte';
  import type { LogRow } from '../../stores/logsStore';
  import { TAILNET_SIGNOZ_LOGS_URL } from '../../lib/signozUrl';

  interface Props {
    /** The row to expand, or null when the drawer is closed. */
    row: LogRow | null;
    /** Bounding rect of the clicked row, used for anchor positioning. */
    anchorRect: DOMRect | null;
    /** Called when the user dismisses the drawer (X / Esc / backdrop). */
    onClose: () => void;
  }
  let { row, anchorRect, onClose }: Props = $props();

  function onKeydown(e: KeyboardEvent): void {
    if (!row) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  /**
   * Pretty-print with key highlighting. Walks the line-oriented output
   * of JSON.stringify and wraps each leading-of-line "key": token in a
   * span. Values are left as-is (no nested spans), which keeps the
   * HTML small and the test assertion simple: any rendered `<span>` in
   * the pre block corresponds to a JSON key.
   *
   * Security: escapes `&`, `<`, `>` before the wrap pass so a malicious
   * log body cannot inject script tags or break the surrounding markup.
   */
  function prettyJson(value: unknown): string {
    const json = JSON.stringify(value, null, 2) ?? '';
    const escaped = json
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // `^` + /m flags match the leading-of-line `"key":` token. The
    // character class `[^"\\]+` rejects keys that contain a literal
    // backslash or quote (which would only happen inside an already
    // escaped value, not at a key position).
    return escaped.replace(
      /^([ \t]*)"([^"\\]+)":/gm,
      '$1<span class="text-primary">"$2"</span>:',
    );
  }

  /** Inline style for the drawer panel. Fixed positioning, clamped. */
  const drawerStyle = $derived.by<string>(() => {
    if (typeof window === 'undefined') {
      return 'position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 480px; max-height: 320px;';
    }
    if (!anchorRect) {
      return 'position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 480px; max-height: 320px;';
    }
    const w = 480;
    const h = 320;
    const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - w - 8);
    const top = Math.min(Math.max(8, anchorRect.top + 32), window.innerHeight - h - 8);
    return `position: fixed; left: ${left}px; top: ${top}px; width: ${w}px; max-height: ${h}px;`;
  });

  /** SigNoz deep link filtered to this trace, shown in the drawer footer. */
  const fullSigNozUrl = $derived(
    row
      ? `${TAILNET_SIGNOZ_LOGS_URL}?filter=${encodeURIComponent(`trace_id = '${row.traceId ?? ''}'`)}`
      : '#',
  );
</script>

<svelte:window onkeydown={onKeydown} />

<Dialog open={!!row} onClose={onClose} label="Log details" class="json-drawer-dialog overflow-auto rounded-lg border border-border bg-surface p-4 shadow-2xl" hideClose>
  {#if row}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="json-drawer-title"
    data-testid="json-drawer"
    style={drawerStyle}
  >
    <div class="mb-2 flex items-center justify-between">
      <h3 id="json-drawer-title" class="text-sm font-semibold text-text">Log details</h3>
      <button
        type="button"
        onclick={onClose}
        data-testid="json-drawer-close"
        aria-label="Close"
        class="rounded border border-border bg-surface-2 px-2 py-0.5 text-xs text-text hover:bg-border/40"
      >X</button>
    </div>
    <div class="rounded bg-surface-2 p-2 font-mono text-xs text-text">
      <pre
        class="whitespace-pre-wrap break-words"
        data-testid="json-drawer-pre"
      >{@html prettyJson(row.rawJson)}</pre>
    </div>
    <div class="mt-2 flex gap-2 text-xs">
      <a
        href={fullSigNozUrl}
        target="_blank"
        rel="noopener"
        class="text-primary underline"
        data-testid="json-drawer-signoz-link"
      >View in full SigNoz</a>
    </div>
  </div>
  {/if}
</Dialog>
{#if row}
<div data-testid="json-drawer-backdrop" aria-hidden="true" onclick={onClose} style="position:fixed;inset:0;background:rgba(0,0,0,0.35)"></div>
{/if}
