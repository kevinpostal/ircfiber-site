<script lang="ts">
  import { onDestroy } from 'svelte';
  import { mediaDock, closeDock, reportDockPosition, setDockLayout } from '../stores/mediaDock.svelte';
  import { youtubeEmbedUrl } from '../lib/youtube';
  import { attachYoutubeBridge } from '../lib/youtubePlayerBridge';
  import {
    DOCK_BAR_H_FALLBACK,
    clampDockLayout,
    resizeDockWidth,
    type DockLayout,
    type DockViewport,
  } from '../lib/mediaDockLayout';

  interface Props {
    onSwitchBuffer: (networkId: string, bufferName: string) => void;
  }

  let { onSwitchBuffer }: Props = $props();

  let iframeEl = $state<HTMLIFrameElement | undefined>();
  let rootEl = $state<HTMLDivElement | null>(null);
  let barEl = $state<HTMLDivElement | null>(null);

  // Derived from startSeconds only — reading the live positionSeconds here
  // would reload the iframe on every info tick.
  const src = $derived(
    mediaDock.video
      ? youtubeEmbedUrl(mediaDock.video.videoId, { start: mediaDock.video.startSeconds, autoplay: true })
      : '',
  );

  $effect(() => {
    if (!iframeEl) return;
    return attachYoutubeBridge(iframeEl, (info) => {
      if (info.currentTime !== undefined) reportDockPosition(info.currentTime);
    });
  });

  // ── Layout: drag by the bar, resize from the corner grip ──────────────
  //
  // Only CSS on `.mediaDock` changes during a gesture; the `{#key}` iframe
  // block is never touched (moving or re-parenting an iframe reloads it).
  //
  // Live viewport size. The dock renders `shown` = the stored layout clamped
  // against this, so a shrinking window pulls the dock inside without
  // rewriting the user's saved spot (Android fires `resize` when the soft
  // keyboard opens — that must never persist), and growing it back restores
  // the saved position.
  let vp = $state({ vw: window.innerWidth, vh: window.innerHeight });
  $effect(() => {
    const onResize = () => {
      vp.vw = window.innerWidth;
      vp.vh = window.innerHeight;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  function barH(): number {
    return barEl?.offsetHeight || DOCK_BAR_H_FALLBACK;
  }
  function viewportNow(): DockViewport {
    return { vw: vp.vw, vh: vp.vh, barH: barH() };
  }

  const shown = $derived(
    mediaDock.layout ? clampDockLayout(mediaDock.layout, { vw: vp.vw, vh: vp.vh, barH: barH() }) : null,
  );

  interface Gesture {
    kind: 'move' | 'resize';
    pointerId: number;
    startX: number;
    startY: number;
    /** Layout at pointerdown (explicit coords even when the dock sat in its CSS corner). */
    start: DockLayout;
    /** Store value before the gesture, restored when the pointer never moved. */
    prev: DockLayout | null;
    moved: boolean;
  }
  let gesture: Gesture | null = null;
  let gesturing = $state(false);

  /** The rendered layout, measuring the CSS default corner when nothing is stored yet. */
  function currentLayout(): DockLayout {
    if (shown) return shown;
    const r = rootEl?.getBoundingClientRect();
    if (!r) return clampDockLayout({ x: vp.vw, y: vp.vh, w: 320 }, viewportNow());
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) };
  }

  function beginGesture(e: PointerEvent, kind: 'move' | 'resize'): void {
    if (gesture || e.button !== 0) return;
    // A press on × / "Go to channel" is a click, not a grab.
    if (kind === 'move' && (e.target as Element | null)?.closest('button')) return;
    e.preventDefault();
    const start = currentLayout();
    gesture = {
      kind,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      start,
      prev: mediaDock.layout,
      moved: false,
    };
    gesturing = true;
    setDockLayout(start, false);
    // Real browsers: capture keeps the stream on the bar even over the
    // cross-origin iframe. Synthetic events throw NotFoundError here; the
    // window listeners below are the mechanism that actually has to work.
    // The browser releases capture implicitly on pointerup/cancel.
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* not a real active pointer */
    }
    // Attached imperatively (not in an $effect) so a pointermove that follows
    // synchronously is not missed.
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
  }

  function onPointerMove(e: PointerEvent): void {
    const g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved) {
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      g.moved = true;
    }
    const vpNow = viewportNow();
    const s = g.start;
    if (g.kind === 'move') {
      setDockLayout(clampDockLayout({ x: s.x + dx, y: s.y + dy, w: s.w }, vpNow), false);
    } else {
      setDockLayout({ ...s, w: resizeDockWidth(s.w + dx, s.x, s.y, vpNow) }, false);
    }
  }

  function onPointerEnd(e: PointerEvent): void {
    if (gesture && e.pointerId === gesture.pointerId) endGesture();
  }

  function endGesture(): void {
    const g = gesture;
    if (!g) return;
    gesture = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerEnd);
    window.removeEventListener('pointercancel', onPointerEnd);
    gesturing = false;
    if (g.moved) {
      // Persist exactly once, with whatever the last move clamped to.
      setDockLayout(mediaDock.layout, true);
    } else {
      // A plain click must not pin the dock to absolute coordinates.
      setDockLayout(g.prev, false);
    }
  }

  onDestroy(endGesture);

  /** Double-click the bar: back to the stylesheet's default corner. */
  function resetLayout(e: MouseEvent): void {
    if ((e.target as Element | null)?.closest('button')) return;
    setDockLayout(null);
  }

  /** Keyboard resize on the grip: arrows step the width by 16px, keeping 16:9. */
  function resizeByKey(e: KeyboardEvent): void {
    let delta: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') delta = 16;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') delta = -16;
    else return;
    e.preventDefault();
    const cur = currentLayout();
    setDockLayout({ ...cur, w: resizeDockWidth(cur.w + delta, cur.x, cur.y, viewportNow()) });
  }
</script>

{#if mediaDock.video}
  <div
    class="mediaDock"
    bind:this={rootEl}
    role="region"
    aria-label="Mini player"
    class:mediaDock--free={!!shown}
    class:mediaDock--dragging={gesturing}
    style:left={shown ? `${shown.x}px` : null}
    style:top={shown ? `${shown.y}px` : null}
    style:width={shown ? `${shown.w}px` : null}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="mediaDock__bar"
      bind:this={barEl}
      onpointerdown={(e) => beginGesture(e, 'move')}
      ondblclick={resetLayout}
    >
      <span class="mediaDock__title">YouTube</span>
      {#if mediaDock.video.origin}
        {@const origin = mediaDock.video.origin}
        <button
          type="button"
          class="mediaDock__btn"
          onclick={() => onSwitchBuffer(origin.networkId, origin.bufferName)}
        >Go to channel</button>
      {/if}
      <button
        type="button"
        class="mediaDock__btn mediaDock__close"
        aria-label="Close mini player"
        onclick={closeDock}
      >×</button>
    </div>
    {#key mediaDock.video.videoId}
      <iframe
        bind:this={iframeEl}
        type="text/html"
        class="mediaDock__frame"
        {src}
        title="YouTube video {mediaDock.video.videoId}"
        allowfullscreen
        sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-presentation"
        referrerpolicy="strict-origin-when-cross-origin"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
      ></iframe>
    {/key}
    <button
      type="button"
      class="mediaDock__resize"
      aria-label="Resize mini player"
      onpointerdown={(e) => beginGesture(e, 'resize')}
      onkeydown={resizeByKey}
    ></button>
  </div>
{/if}

<style>
  /* z-index 95: above chat chrome (input 20, floating date 10), below
     modals/overlays (99/100) and context menus (400). */
  .mediaDock {
    position: fixed;
    right: 16px;
    bottom: 76px;
    width: 320px;
    /* border-box: the stored width is the measured rect width, so the first
       drag must not grow the box by the 2px border. 16 = 2 × DOCK_MARGIN. */
    box-sizing: border-box;
    max-width: calc(100vw - 16px);
    z-index: 95;
    background: #1a1d21;
    border: 1px solid #2c2f35;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }
  /* Explicit coordinates: drop the stylesheet corner so the box is not
     stretched between `top` and `bottom: 76px`. */
  .mediaDock--free {
    right: auto;
    bottom: auto;
  }
  .mediaDock__bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    font-size: 12px;
    color: #8b949e;
    cursor: grab;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .mediaDock--dragging .mediaDock__bar {
    cursor: grabbing;
  }
  /* The cross-origin iframe would otherwise swallow the pointer mid-gesture. */
  .mediaDock--dragging .mediaDock__frame {
    pointer-events: none;
  }
  .mediaDock__title {
    flex: 1;
  }
  .mediaDock__btn {
    background: none;
    border: 0;
    color: #d1d5db;
    cursor: pointer;
    font-size: 12px;
    padding: 2px 6px;
  }
  .mediaDock__close {
    font-size: 16px;
    line-height: 1;
  }
  .mediaDock__frame {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    border: 0;
    background: #000;
  }
  .mediaDock__resize {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    /* Diagonal hatch, no image asset. */
    background: repeating-linear-gradient(
      135deg,
      rgba(255, 255, 255, 0) 0 4px,
      rgba(255, 255, 255, 0.35) 4px 5px
    );
    cursor: nwse-resize;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    z-index: 1;
  }
  .mediaDock__resize:focus-visible {
    outline: 1px solid #4a6fa5;
  }
</style>
