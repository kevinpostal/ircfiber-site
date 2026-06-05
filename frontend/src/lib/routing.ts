import { ircState } from '../stores/ircStore.svelte';

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
