<script lang="ts">
  /**
   * ConfirmDialog — modal confirmation for destructive actions.
   * Use via `<ConfirmDialog>` in templates; controlled by `open` prop.
   */
  import { fade, scale } from 'svelte/transition';
  interface Props {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'danger' | 'warn' | 'primary';
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
  }
  let { open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'danger', onConfirm, onCancel }: Props = $props();
  let busy = $state(false);

  async function handleConfirm() {
    if (busy) return;
    busy = true;
    try { await onConfirm(); } finally { busy = false; }
  }

  const confirmClass = $derived(tone === 'danger'
    ? 'bg-danger text-white hover:bg-danger/90'
    : tone === 'warn'
    ? 'bg-warn text-bg hover:bg-warn/90'
    : 'bg-primary text-primary-fg hover:bg-primary/90');
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    transition:fade={{ duration: 120 }}
    onclick={onCancel}
    role="presentation"
  >
    <div
      class="w-full max-w-md rounded-lg border border-border bg-surface shadow-2xl"
      transition:scale={{ duration: 140, start: 0.96 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="border-b border-border px-5 py-4">
        <h2 id="confirm-title" class="text-base font-semibold text-heading">{title}</h2>
      </div>
      <div class="px-5 py-4 text-sm text-text">{message}</div>
      <div class="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        <button
          type="button"
          class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-text hover:bg-border disabled:opacity-50"
          onclick={onCancel}
          disabled={busy}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-xs font-semibold {confirmClass} disabled:opacity-50"
          onclick={handleConfirm}
          disabled={busy}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}