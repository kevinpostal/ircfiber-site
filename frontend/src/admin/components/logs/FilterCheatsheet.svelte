<script lang="ts">
  /**
   * FilterCheatsheet - modal that lists every supported SigNoz log
   * filter field with an example expression and a plain-English
   * explanation. Triggered by the `?` keypress when the Logs page
   * is focused; closes on Esc or backdrop click.
   *
   * Bound from parent: <FilterCheatsheet bind:open={showCheatsheet} onClose={...} />
   */
  import { tick } from 'svelte';
import Dialog from '../../../components/Dialog.svelte';

  interface Props {
    open?: boolean;
    onClose?: () => void;
  }
  let { open = $bindable(false), onClose }: Props = $props();

  // svelte-ignore non_reactive_update -- bind:this target, not user state
  let firstFocusableRef: HTMLButtonElement | undefined;
  // svelte-ignore non_reactive_update -- bind:this target, not user state
  let lastFocusableRef: HTMLAnchorElement | undefined;

  // Focus the first focusable element on open so keyboard users
  // can immediately Tab/Shift-Tab through the trap.
  $effect(() => {
    if (open) {
      tick().then(() => firstFocusableRef?.focus());
    }
  });

  function close() {
    open = false;
    onClose?.();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab' && firstFocusableRef && lastFocusableRef) {
      // Minimal focus trap: if tabbing past the last button, wrap to
      // the first; if shift-tabbing past the first, wrap to the last.
      if (e.shiftKey && document.activeElement === firstFocusableRef) {
        e.preventDefault();
        lastFocusableRef.focus();
      } else if (!e.shiftKey && document.activeElement === lastFocusableRef) {
        e.preventDefault();
        firstFocusableRef.focus();
      }
    }
  }

  function onBackdropClick(e: MouseEvent) {
    // Only close when the click landed on the backdrop itself, not
    // bubbled up from a child element inside the dialog.
    if (e.target === e.currentTarget) {
      close();
    }
  }

  function openDocs(e: MouseEvent) {
    e.preventDefault();
    window.open('https://signoz.io/docs/userguide/logs_query_builder/', '_blank', 'noopener');
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<Dialog open={open} onClose={close} label="SigNoz filter syntax" class="w-full max-w-2xl rounded-lg border border-border bg-surface p-6 shadow-2xl" hideClose>
  <div class="filter-cheatsheet-backdrop" onclick={onBackdropClick} style="position:fixed;inset:0" aria-hidden="true"></div>
  <div
      data-testid="filter-cheatsheet-dialog"
      aria-labelledby="filter-cheatsheet-title"
    >
      <h2
        id="filter-cheatsheet-title"
        class="mb-1 text-base font-semibold text-heading"
      >
        SigNoz filter syntax
      </h2>
      <p class="mb-4 text-xs text-muted">
        Press <kbd class="rounded border border-border bg-surface-2 px-1 font-mono text-[10px]">?</kbd>
        to toggle this panel. <kbd class="rounded border border-border bg-surface-2 px-1 font-mono text-[10px]">Esc</kbd>
        closes.
      </p>

      <div class="space-y-3">
        <div>
          <code class="block rounded bg-surface-2 p-2 text-xs font-mono text-text">severity_text = 'ERROR'</code>
          <p class="mt-1 text-xs text-muted">Match logs at a specific severity (DEBUG / INFO / WARN / ERROR / FATAL).</p>
        </div>
        <div>
          <code class="block rounded bg-surface-2 p-2 text-xs font-mono text-text">body CONTAINS 'timeout'</code>
          <p class="mt-1 text-xs text-muted">Case-insensitive substring search in the log body.</p>
        </div>
        <div>
          <code class="block rounded bg-surface-2 p-2 text-xs font-mono text-text">service.name IN ('frontend', 'gateway')</code>
          <p class="mt-1 text-xs text-muted">Match logs from one or more named services (multi-select dropdown).</p>
        </div>
        <div>
          <code class="block rounded bg-surface-2 p-2 text-xs font-mono text-text">trace_id = 'a1b2c3d4e5f6'</code>
          <p class="mt-1 text-xs text-muted">Filter by OpenTelemetry trace ID (hex, lowercase).</p>
        </div>
        <div>
          <code class="block rounded bg-surface-2 p-2 text-xs font-mono text-text">resource.k8s.pod.name = 'gateway-abc123'</code>
          <p class="mt-1 text-xs text-muted">Match resource attributes with dot-paths (deployment target, host, etc.).</p>
        </div>
        <div>
          <code class="block rounded bg-surface-2 p-2 text-xs font-mono text-text">attribute.user_id = '42'</code>
          <p class="mt-1 text-xs text-muted">Match span attributes set by your application code.</p>
        </div>
      </div>

      <div class="mt-6 flex items-center justify-end gap-2">
        <button
          bind:this={firstFocusableRef}
          type="button"
          class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-text hover:bg-border/40"
          onclick={close}
        >
          Close
        </button>
        <a
          bind:this={lastFocusableRef}
          href="https://signoz.io/docs/userguide/logs_query_builder/"
          target="_blank"
          rel="noopener"
          class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90"
          onclick={openDocs}
        >
          SigNoz docs >
        </a>
      </div>
  </div>
</Dialog>
