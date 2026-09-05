import { ircState } from '../stores/ircStore.svelte';

export type SettingsTab = 'design' | 'account' | 'notifications' | 'chat' | 'advanced';

/**
 * Encode a channel buffer name for the `/channel/<part>` URL segment.
 * The full name is preserved (`##test` stays `##test`, percent-encoded)
 * so the URL → buffer round-trip is lossless. Legacy URLs stored the
 * name with one `#` stripped (`/channel/test`); the reader below still
 * accepts those.
 */
export function channelUrlPart(bufferName: string): string {
  return encodeURIComponent(bufferName);
}

/**
 * Decode a `/channel/<part>` URL segment back to a buffer name.
 * New URLs decode to the full name (`#test`, `##test`, `&foo`) and are
 * kept as-is; legacy segments without a prefix (`test`) get `#`.
 */
export function bufferNameFromChannelPart(target: string): string {
  return /^[#&+!]/.test(target) ? target : '#' + target;
}

export function updateRoute(networkId: string, bufferName: string): void {
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;
  let path: string;
  if (bufferName === '_server') {
    path = '/irc/' + encodeURIComponent(net.name);
  } else if (bufferName.startsWith('#')) {
    path = '/irc/' + encodeURIComponent(net.name) + '/channel/' + channelUrlPart(bufferName);
  } else {
    path = '/irc/' + encodeURIComponent(net.name) + '/messages/' + encodeURIComponent(bufferName);
  }
  if (window.location.pathname !== path) {
    history.pushState({ networkId, bufferName }, '', path);
  }
  // Keep `lastVisited` as fresh as the URL. The gateway writes this cookie
  // only on full-page GETs of /irc/* and redirects bare "/" to it
  // (web/package.d `index()`), so before this line an SPA channel switch
  // never updated it: typing the domain or opening the PWA landed you on
  // the channel of your last page LOAD, not your last active channel —
  // IRCCloud restores `last_selected_bid` instead, and this cookie is our
  // equivalent marker. Same raw format the server writes (the path is
  // already URL-encoded and cookie-safe).
  try {
    document.cookie = 'lastVisited=' + path + '; path=/; max-age=' + 90 * 24 * 3600;
  } catch { /* non-browser test env */ }
}

export function navigateSettings(tab: SettingsTab): void {
  history.replaceState({ settings: true, tab }, '', '/?/settings=' + tab);
}

export function getSettingsTabFromUrl(): SettingsTab | null {
  const m = window.location.search.match(/^\?\/settings(?:=(design|account|notifications|chat|advanced))?$/);
  if (!m) return null;
  return (m[1] as SettingsTab) || 'design';
}

export function isSettingsUrl(): boolean {
  return /^\?\/settings/.test(window.location.search);
}

export function navigateBackFromSettings(): void {
  const net = ircState.networks.find(n => n.networkId === ircState.activeBuffer.networkId);
  if (net && ircState.activeBuffer.bufferName) {
    updateRoute(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName);
  } else if (ircState.networks.length > 0) {
    updateRoute(ircState.networks[0].networkId, '_server');
  } else {
    window.location.href = '/';
  }
}

export function navigateShortcuts(): void {
  history.pushState({ shortcuts: true }, '', '/?/shortcuts');
}

export function isShortcutsUrl(): boolean {
  return /^\?\/shortcuts$/.test(window.location.search);
}

export function navigateBackFromShortcuts(): void {
  const net = ircState.networks.find(n => n.networkId === ircState.activeBuffer.networkId);
  if (net && ircState.activeBuffer.bufferName) {
    updateRoute(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName);
  } else if (ircState.networks.length > 0) {
    updateRoute(ircState.networks[0].networkId, '_server');
  } else {
    window.location.href = '/';
  }
}

export function navigateToFileViewer(id: string): void {
  history.pushState({ fileView: true, id }, '', `/?/view=${encodeURIComponent(id)}`);
}
export function getFileViewerIdFromUrl(): string | null {
  const m = window.location.search.match(/^\?\/view=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
export function isFileViewerUrl(): boolean {
  return /^\?\/view=/.test(window.location.search);
}
export function navigateBackFromFileViewer(): void {
  history.back();
}
export function navigateToPastebin(id: string): void {
  history.pushState({ pastebinView: true, id }, '', `/?/pastebin=${encodeURIComponent(id)}`);
}
export function getPastebinIdFromUrl(): string | null {
  const m = window.location.search.match(/^\?\/pastebin=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
export function isPastebinUrl(): boolean { return /^\?\/pastebin=/.test(window.location.search); }
export function navigateBackFromPastebin(): void {
  // Direct-link visitors (e.g. a shared public pastebin URL) have no
  // in-app history: history.back() would be a dead button, so send
  // them to the landing page instead.
  if (window.history.length > 1) history.back();
  else window.location.href = '/';
}
