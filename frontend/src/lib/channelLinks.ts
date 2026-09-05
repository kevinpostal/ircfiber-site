import { ircState, setActiveBuffer, initiateRejoin } from '../stores/ircStore.svelte';
import { normalizeChannelName } from './utils';
import { updateRoute } from './routing';

/**
 * Open a channel named in message text — IRCCloud's channel-link semantics
 * (`common-5650bddb.js` route handler: `r = i.findBuffer(o); … r ||
 * (r = i.openNewBuffer(a)); r.select()`): an existing buffer is selected,
 * an unknown channel is joined and then selected. `autolinker` emits the
 * anchors (`a.channelLink` with `data-channel`); this is the click side.
 */
export function openChannelLink(networkId: string, channel: string): void {
  const chan = normalizeChannelName(channel.trim());
  if (!chan) return;
  const net = ircState.networks.find((n) => n.networkId === networkId);
  if (!net) return;
  const existing = net.buffers.find((b) => b.name.toLowerCase() === chan.toLowerCase());
  if (!existing || !existing.isJoined) {
    // Creates the buffer, marks the join in flight, and sends JOIN —
    // idempotent when a JOIN is already pending.
    initiateRejoin(networkId, chan);
  }
  setActiveBuffer(networkId, existing?.name ?? chan);
  updateRoute(networkId, existing?.name ?? chan);
}

/**
 * Delegated click handler for any container whose HTML may hold
 * autolinker channel anchors (message rows, topics, list overlays).
 * Returns true when the event was a channel-link click and was handled.
 */
export function handleChannelLinkClick(e: MouseEvent, networkId: string | null = null): boolean {
  const target = e.target as HTMLElement | null;
  const link = target?.closest?.('a.channelLink') as HTMLAnchorElement | null;
  if (!link) return false;
  e.preventDefault();
  const chan = link.getAttribute('data-channel') || link.textContent || '';
  const nid = networkId ?? ircState.activeBuffer.networkId;
  if (!chan || !nid) return true;
  openChannelLink(nid, chan);
  return true;
}
