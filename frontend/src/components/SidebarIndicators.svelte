<script lang="ts">
  // IRCCloud sidebar indicators (OFe6.updateIndicators): a blue/red/yellow
  // bar pinned to the top or bottom edge of the sidebar whenever an unseen
  // buffer row or a failed connection header is scrolled out of view.
  // Click → scroll the row into view (23 px below the top); Alt/Shift
  // click → select the first hidden unseen buffer. Wheel → scroll sidebar.
  import { onMount } from 'svelte';
  import { ircState, getUnseenBuffers } from '../stores/ircStore.svelte';
  import { collapsedMap } from '../stores/preferences.svelte';

  interface Props {
    sidebarEl: HTMLElement | undefined;
    onSwitchBuffer: (networkId: string, bufferName: string) => void;
  }
  let { sidebarEl, onSwitchBuffer }: Props = $props();

  interface Side {
    show: 'unread' | 'failed' | null;
    badged: boolean;
    top: number;
    scrollTarget: HTMLElement | null;
    scrollBuffer: { networkId: string; bufferName: string } | null;
    highlights: number;
    buffers: number;
    failed: number;
  }
  function emptySide(): Side {
    return { show: null, badged: false, top: 0, scrollTarget: null, scrollBuffer: null, highlights: 0, buffers: 0, failed: 0 };
  }

  let above: Side = $state(emptySide());
  let below: Side = $state(emptySide());
  let left = $state(0);
  let width = $state(0);
  let belowHeight = $state(11);
  let hover: 'above' | 'below' | null = $state(null);
  let tooltipEl: HTMLDivElement | undefined = $state();
  let tooltipLeft = $state(0);
  let tooltipTop = $state(0);

  function place(side: Side, row: HTMLElement, kind: 'unread' | 'failed', badged: boolean, buf: { networkId: string; bufferName: string } | null): void {
    if (kind === 'failed') {
      side.failed++;
      if (!side.show) { side.show = 'failed'; side.scrollTarget = row; }
    } else {
      side.buffers++;
      if (side.show !== 'failed' || !side.scrollTarget) { side.show = 'unread'; side.scrollTarget = row; side.scrollBuffer = buf; }
      if (badged) side.badged = true;
    }
  }

  export function updateIndicators(): void {
    const sidebar = sidebarEl;
    if (!sidebar) return;
    const sidebarRect = sidebar.getBoundingClientRect();
    const a = emptySide();
    const b = emptySide();
    left = sidebarRect.left;
    width = sidebarRect.width;
    a.top = sidebarRect.top;
    b.top = sidebarRect.bottom - belowHeight - 1;
    const sidebarHeight = sidebarRect.height;
    const classify = (row: HTMLElement | null, kind: 'unread' | 'failed', badged: boolean, buf: { networkId: string; bufferName: string } | null, highlights: number): void => {
      if (!row) return;
      const r = row.getBoundingClientRect();
      const top = r.top - sidebarRect.top;
      if (top + r.height < 5) { place(a, row, kind, badged, buf); if (kind === 'unread') a.highlights += highlights; }
      else if (top + 5 > sidebarHeight) { place(b, row, kind, badged, buf); if (kind === 'unread') b.highlights += highlights; }
    };
    for (const net of ircState.networks) {
      const failed = !net.connected && !!(net.failInfo || net.retryStatus);
      if (!failed) continue;
      classify(sidebar.querySelector<HTMLElement>(`.connection[data-network-id="${CSS.escape(net.networkId)}"] .network-header`), 'failed', false, null, 0);
    }
    for (const { net, buf } of getUnseenBuffers()) {
      const row = collapsedMap[net.networkId]
        ? sidebar.querySelector<HTMLElement>(`.connection[data-network-id="${CSS.escape(net.networkId)}"] .network-header`)
        : sidebar.querySelector<HTMLElement>(`li[data-buffer-key="${CSS.escape(`${net.networkId}:${buf.name}`)}"]`);
      if (!row) continue;
      const badged = buf.unseenHighlights.length > 0;
      classify(row, 'unread', badged, { networkId: net.networkId, bufferName: buf.name }, buf.unseenHighlights.length);
    }
    above = a;
    below = b;
    if (tooltipEl) {
      tooltipLeft = sidebarRect.left - tooltipEl.offsetWidth - 7;
      if (tooltipLeft < 0) tooltipLeft = sidebarRect.left + sidebarRect.width + 5;
    }
  }

  function scrollToView(el: HTMLElement): void {
    const sidebar = sidebarEl;
    if (!sidebar) return;
    const sr = sidebar.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top + r.height >= sr.bottom || r.top <= sr.top) {
      sidebar.scrollTop = r.top - sr.top + sidebar.scrollTop - 23;
    }
  }

  function onClick(side: Side, e: MouseEvent): void {
    e.preventDefault();
    if ((e.altKey || e.shiftKey) && side.scrollBuffer) {
      onSwitchBuffer(side.scrollBuffer.networkId, side.scrollBuffer.bufferName);
    } else if (side.scrollTarget) {
      scrollToView(side.scrollTarget);
    }
  }

  function onWheel(e: WheelEvent): void {
    if (!sidebarEl) return;
    e.preventDefault();
    sidebarEl.scrollTop += e.deltaY;
  }

  function summary(side: Side): string {
    const parts: string[] = [];
    if (side.highlights > 0) parts.push(`<span class="sidebarIndicatorTooltip__badge">${side.highlights}</span>&nbsp;highlight${side.highlights === 1 ? '' : 's'}`);
    if (side.buffers > 0) parts.push(`${side.buffers}&nbsp;unread`);
    if (side.failed > 0) parts.push(`<span class="sidebarIndicatorTooltip__failed">${side.failed}&nbsp;failed</span>`);
    return parts.join(' • ');
  }

  const hovered = $derived(hover === 'above' ? above : hover === 'below' ? below : null);

  $effect(() => {
    // Recompute on unseen changes, connection state, collapse state.
    getUnseenBuffers();
    for (const n of ircState.networks) { void n.connected; void n.failInfo; void n.retryStatus; }
    void Object.keys(collapsedMap).length;
    void sidebarEl;
    queueMicrotask(updateIndicators);
  });

  $effect(() => {
    if (hover === 'above') tooltipTop = above.top;
    else if (hover === 'below') tooltipTop = below.top - (tooltipEl?.offsetHeight ?? 0) + belowHeight;
  });

  onMount(() => {
    window.addEventListener('resize', updateIndicators);
    updateIndicators();
    return () => window.removeEventListener('resize', updateIndicators);
  });

  $effect(() => {
    const el = sidebarEl;
    if (!el) return;
    el.addEventListener('scroll', updateIndicators, { passive: true });
    return () => el.removeEventListener('scroll', updateIndicators);
  });
</script>

<a class="sidebarIndicator" id="sidebarIndicatorAbove" href="#above"
   class:sidebarIndicatorUnread={above.show === 'unread'}
   class:sidebarIndicatorBadged={above.show === 'unread' && above.badged}
   class:sidebarIndicatorFailed={above.show === 'failed'}
   style="left:{left}px;width:{width}px;top:{above.top}px"
   onclick={(e) => onClick(above, e)}
   onwheel={onWheel}
   onmouseenter={() => (hover = 'above')}
   onmouseleave={() => (hover = null)}
   aria-label="Scroll to unread above"></a>
<a class="sidebarIndicator" id="sidebarIndicatorBelow" href="#below"
   class:sidebarIndicatorUnread={below.show === 'unread'}
   class:sidebarIndicatorBadged={below.show === 'unread' && below.badged}
   class:sidebarIndicatorFailed={below.show === 'failed'}
   style="left:{left}px;width:{width}px;top:{below.top}px"
   onclick={(e) => onClick(below, e)}
   onwheel={onWheel}
   onmouseenter={() => (hover = 'below')}
   onmouseleave={() => (hover = null)}
   aria-label="Scroll to unread below"></a>
<div class="sidebarIndicatorTooltip" bind:this={tooltipEl}
     class:sidebarIndicatorTooltip--show={!!hovered && !!hovered.show}
     style="left:{tooltipLeft}px;top:{tooltipTop}px">
  <p class="sidebarIndicatorTooltip__summary">{@html hovered ? summary(hovered) : ''}</p>
  <p class="sidebarIndicatorTooltip__hint">click to scroll • alt-click to select</p>
</div>

<style>
  .sidebarIndicator { position: fixed; display: none; height: 11px; border: 1px solid; z-index: 20; box-sizing: border-box; }
  .sidebarIndicatorUnread { display: block; background: #1e72ff; border-color: #123e92; }
  .sidebarIndicatorBadged { background: #ff1f1a; border-color: #d20004; }
  .sidebarIndicatorFailed { display: block; background: #f8df26; border-color: #dbb300; }
  #sidebarIndicatorAbove { border-width: 0 0 2px; }
  #sidebarIndicatorBelow { margin-bottom: 1px; border-width: 1px 0; }
  .sidebarIndicatorTooltip {
    position: fixed; display: none; width: 230px; padding: 0 5px; border: 1px solid;
    border-color: #c0dbff #4e9afa #4e9afa #c0dbff; border-radius: 2px 0 0 0; background: #e2edff; color: #000;
    text-align: center; box-shadow: 2px 2px 0 #9cc7ff; z-index: 21; box-sizing: border-box;
  }
  .sidebarIndicatorTooltip--show { display: block; }
  .sidebarIndicatorTooltip__summary { font-size: 14px; line-height: 18px; padding: 4px 0 0; margin: 0; }
  .sidebarIndicatorTooltip__hint { font-size: 12px; color: #679fff; padding: 0 0 3px; margin: 0; }
  .sidebarIndicatorTooltip :global(.sidebarIndicatorTooltip__failed) { color: #ff9100; }
  .sidebarIndicatorTooltip :global(.sidebarIndicatorTooltip__badge) {
    display: inline-block; font-size: 11px; color: #fff; background-color: #ff1f1a; border-radius: 50%;
    font-weight: 600; width: 18px; height: 18px; line-height: 18px; text-align: center;
  }
</style>
