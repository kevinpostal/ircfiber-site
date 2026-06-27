import { ircState } from '../stores/ircStore.svelte';

export type SettingsTab = 'design' | 'account' | 'notifications' | 'chat' | 'advanced';

export function updateRoute(networkId: string, bufferName: string): void {
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;
  let path: string;
  if (bufferName === '_server') {
    path = '/irc/' + encodeURIComponent(net.name);
  } else if (bufferName.startsWith('#')) {
    path = '/irc/' + encodeURIComponent(net.name) + '/channel/' + encodeURIComponent(bufferName.substring(1));
  } else {
    path = '/irc/' + encodeURIComponent(net.name) + '/messages/' + encodeURIComponent(bufferName);
  }
  if (window.location.pathname !== path) {
    history.pushState({ networkId, bufferName }, '', path);
  }
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
