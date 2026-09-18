export interface DockedVideo {
  videoId: string;
  /** Position the dock iframe starts from; fixed at dock time (drives the iframe src — never updated live). */
  startSeconds: number;
  /** Live playback position reported by whichever iframe currently plays it. */
  positionSeconds: number;
  origin: { networkId: string; bufferName: string } | null;
}

export const mediaDock = $state<{ video: DockedVideo | null }>({ video: null });

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
