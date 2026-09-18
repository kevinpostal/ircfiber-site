import { YT_EMBED_ORIGIN } from './youtube';

// Speaks the same postMessage wire protocol as https://www.youtube.com/iframe_api
// without loading that script. After the page sends `{event:'listening'}`, the
// embed (loaded with enablejsapi=1) streams `infoDelivery` messages with the
// current playback position and state — ~4×/s while playing plus every state
// change. playerState codes: -1 unstarted, 0 ended, 1 playing, 2 paused,
// 3 buffering, 5 cued.

export const YT_STATE_PLAYING = 1;
export const YT_STATE_BUFFERING = 3;

export interface YtPlayerInfo {
  currentTime?: number;
  playerState?: number;
}

/**
 * Parse one `message` payload from the YouTube embed. Returns null for
 * anything that is not an infoDelivery/initialDelivery event carrying at
 * least one of the fields we track.
 */
export function parseYoutubeInfoMessage(data: unknown): YtPlayerInfo | null {
  if (typeof data !== 'string') return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const { event, info } = msg as { event?: unknown; info?: unknown };
  if (event !== 'infoDelivery' && event !== 'initialDelivery') return null;
  if (typeof info !== 'object' || info === null) return null;
  const { currentTime, playerState } = info as { currentTime?: unknown; playerState?: unknown };
  const out: YtPlayerInfo = {};
  if (typeof currentTime === 'number') out.currentTime = currentTime;
  if (typeof playerState === 'number') out.playerState = playerState;
  return out.currentTime === undefined && out.playerState === undefined ? null : out;
}

let nextId = 0;

/** Ask the embed to stream player info and forward it to onInfo. Returns cleanup. */
export function attachYoutubeBridge(
  iframe: HTMLIFrameElement,
  onInfo: (info: YtPlayerInfo) => void,
): () => void {
  const id = 'ircfiber-yt-' + ++nextId;
  const send = (): void => {
    iframe.contentWindow?.postMessage(
      JSON.stringify({ event: 'listening', id, channel: 'widget' }),
      YT_EMBED_ORIGIN,
    );
  };
  const onMessage = (e: MessageEvent): void => {
    if (e.origin !== YT_EMBED_ORIGIN || e.source !== iframe.contentWindow) return;
    const info = parseYoutubeInfoMessage(e.data);
    if (info) onInfo(info);
  };
  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', send);
  send();
  return () => {
    window.removeEventListener('message', onMessage);
    iframe.removeEventListener('load', send);
  };
}
