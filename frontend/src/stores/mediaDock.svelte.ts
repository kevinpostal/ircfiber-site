import { DOCK_LAYOUT_KEY, parseDockLayout, type DockLayout } from '../lib/mediaDockLayout';

export type { DockLayout };

export interface DockedVideo {
  videoId: string;
  /** Position the dock iframe starts from; fixed at dock time (drives the iframe src — never updated live). */
  startSeconds: number;
  /** Live playback position reported by whichever iframe currently plays it. */
  positionSeconds: number;
  origin: { networkId: string; bufferName: string } | null;
}

/**
 * Read the persisted dock layout. Raw dot-key on purpose: the `ircfiber:*`
 * preference helpers apply a 24h TTL and are wiped on sign-out, and the
 * player position should survive both (same pattern as `ircfiber.sidebarCollapsed`).
 */
export function loadDockLayout(): DockLayout | null {
  try {
    return parseDockLayout(localStorage.getItem(DOCK_LAYOUT_KEY));
  } catch {
    return null;
  }
}

export const mediaDock = $state<{ video: DockedVideo | null; layout: DockLayout | null }>({
  video: null,
  // The user's saved spot, unclamped. MediaDock.svelte clamps it against the
  // live viewport when rendering so a shrunken window never overwrites it.
  layout: loadDockLayout(),
});

/** Replaces any existing docked video (latest wins). */
export function dockVideo(v: Omit<DockedVideo, 'positionSeconds'>): void {
  mediaDock.video = { ...v, positionSeconds: v.startSeconds };
}

export function closeDock(): void {
  mediaDock.video = null;
}

export function reportDockPosition(seconds: number): void {
  if (mediaDock.video) mediaDock.video.positionSeconds = seconds;
}

/**
 * Set the dock layout (`null` = stylesheet default corner). With `persist`
 * (the default) it is also written to localStorage; gestures pass `false`
 * for every intermediate frame and persist once on pointerup.
 */
export function setDockLayout(l: DockLayout | null, persist = true): void {
  mediaDock.layout = l;
  if (!persist) return;
  try {
    if (l) localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify({ x: l.x, y: l.y, w: l.w }));
    else localStorage.removeItem(DOCK_LAYOUT_KEY);
  } catch {
    /* storage unavailable or full — in-memory layout still works */
  }
}
