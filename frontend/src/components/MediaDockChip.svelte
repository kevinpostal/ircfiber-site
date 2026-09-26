<!--
  Taskbar chip for the minimized YouTube mini player. Lives in the compose
  status row (InputArea.svelte) beside the typing slot. Owns the chip's mount
  animation and the `mediaDock.chipRect` snapshot MediaDock.svelte animates
  to / from. Height must stay ≤ 21px: the row is pinned at 25px.
-->
<script lang="ts">
  import { mediaDock, closeDock, restoreDock } from '../stores/mediaDock.svelte';
  import { DOCK_ANIM_MS } from '../lib/mediaDockLayout';

  let el = $state<HTMLDivElement | null>(null);
  const shown = $derived(!!mediaDock.video && mediaDock.minimized);

  function snapshot(): void {
    if (!el) return;
    const r = el.getBoundingClientRect();
    mediaDock.chipRect = { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  $effect(() => {
    if (!el) return;
    // Minimize target for MediaDock (it awaits tick() then reads chipRect).
    snapshot();
    if (
      typeof el.animate === 'function' &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      el.animate(
        [
          { opacity: 0, transform: 'scale(0.85)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: DOCK_ANIM_MS * 0.6, delay: DOCK_ANIM_MS * 0.4, easing: 'ease-out', fill: 'backwards' },
      );
    }
  });

  /** Rect must be taken before the `{#if}` unmounts us. */
  function onRestore(): void {
    snapshot();
    restoreDock();
  }

  const mmss = $derived.by(() => {
    const s = Math.max(0, Math.floor(mediaDock.video?.positionSeconds ?? 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });
</script>

{#if shown}
  <div class="mediaDockChip" bind:this={el} role="group" aria-label="Minimized YouTube player">
    <button
      type="button"
      class="mediaDockChip__restore"
      aria-label="Restore YouTube mini player"
      onclick={onRestore}
    >
      <span class="mediaDockChip__icon" aria-hidden="true">▶</span>YouTube<span class="mediaDockChip__time">{mmss}</span>
    </button>
    <button type="button" class="mediaDockChip__close" aria-label="Close mini player" onclick={closeDock}>×</button>
  </div>
{/if}

<style>
  /* Mirrors .typing-pill (_chatInput.scss) so the two read as one family. */
  .mediaDockChip {
    box-sizing: border-box;
    height: 21px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 4px 0 8px;
    font-size: 11px;
    line-height: 1;
    color: #d1d5db;
    background: rgba(42, 45, 51, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    white-space: nowrap;
  }
  .mediaDockChip button {
    display: inline-flex;
    align-items: center;
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    padding: 0 4px;
    font: inherit;
  }
  .mediaDockChip button:hover {
    color: #fff;
  }
  .mediaDockChip__icon {
    color: #ff0033;
    font-size: 9px;
    margin-right: 5px;
  }
  .mediaDockChip__time {
    color: #8b949e;
    font-variant-numeric: tabular-nums;
    margin-left: 6px;
  }
  .mediaDockChip__close {
    font-size: 14px;
  }
</style>
