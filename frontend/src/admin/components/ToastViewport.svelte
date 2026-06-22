<script lang="ts">
  /**
   * ToastViewport — fixed bottom-right stack of toast notifications.
   * Mounted once at the app shell level; reads from `toasts` store.
   */
  import { fly } from 'svelte/transition';
  import { toasts, type Toast } from '../stores/ui';

  const kindClass: Record<Toast['kind'], string> = {
    success: 'border-success/40 bg-success/10 text-success',
    error: 'border-danger/40 bg-danger/10 text-danger',
    info: 'border-info/40 bg-info/10 text-info',
    warn: 'border-warn/40 bg-warn/10 text-warn',
  };

  const kindIcon: Record<Toast['kind'], string> = {
    success: '✓',
    error: '✕',
    info: 'ⓘ',
    warn: '⚠',
  };
</script>

<div class="pointer-events-none fixed bottom-6 right-6 z-50 flex w-full max-w-sm flex-col gap-2">
  {#each $toasts as t (t.id)}
    <div
      class="pointer-events-auto flex items-start gap-2 rounded-md border bg-surface px-3 py-2 text-sm shadow-lg {kindClass[t.kind]}"
      transition:fly={{ y: 16, duration: 200 }}
    >
      <span class="mt-0.5 text-base">{kindIcon[t.kind]}</span>
      <span class="flex-1 text-text">{t.message}</span>
    </div>
  {/each}
</div>