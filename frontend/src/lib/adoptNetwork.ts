import { ircState, setActiveBuffer } from '../stores/ircStore.svelte';
import { collapsedMap } from '../stores/preferences.svelte';
import { updateRoute } from './routing';
import type { Network } from '../types';

/**
 * Push a freshly created network (the `POST /api/networks` response) into the
 * store so it shows up even if the engine cannot connect yet (bad address,
 * server down), expand it in the sidebar, and route to its `_server` log.
 * The periodic sync later replaces these placeholder connection fields with
 * the authoritative engine state.
 *
 * Shared by every add-network path: the form (`NetworkForm.svelte`) and the
 * one-click IRC Fiber provisioning card (`AddNetworkPage.svelte`).
 *
 * Returns the adopted networkId, or null when the response carried no id.
 */
export function adoptNetwork(result: Record<string, unknown> | null | undefined): string | null {
  if (!result || !result.id) return null;
  const net: Network = {
    networkId: result.id as string,
    name: result.name as string,
    host: result.host as string,
    port: result.port as number,
    tls: (result.tls as string) || 'enabled',
    nick: result.nick as string,
    realName: (result.realName as string) || (result.nick as string),
    currentNick: result.nick as string,
    sasl: (result.sasl as string) || 'none',
    saslUsername: (result.saslUsername as string) || '',
    saslPassword: '',
    connected: false,
    connecting: true,
    connectionState: 'connecting',
    status: 'unknown',
    disconnectReason: '',
    isAway: false,
    awayMessage: '',
    autoJoinChannels: (result.autoJoinChannels as string[]) ?? [],
    autoJoinDelaySeconds: (result.autoJoinDelaySeconds as number) ?? 0,
    egressNodeId: (result.egressNodeId as string) ?? '',
    buffers: [{
      name: '_server', type: 'server' as const, isJoined: true,
      unseen: false, unseenCount: 0, unseenHighlights: [], isPinned: false, isArchived: false,
      topic: '', topicSetBy: '', topicSetAt: 0, users: [],
      lastSeenMsgTime: null, firstUnseenMsgIndex: null,
      lastSeen: null, bottomSeen: null, clearedAt: null, modeFlags: {},
    }],
    awayNicks: new Set(),
    capabilities: new Set(),
    isupport: {},
    chanTypes: '#',
    egressLabel: null,
    egressHost: null,
    egressIp: null,
    egressLocation: null,
    lagMs: null,
    connectedAtMs: null,
    tlsInfo: null,
  };
  ircState.networks.push(net);
  // Ensure the new server starts expanded in the sidebar
  collapsedMap[net.networkId] = false;
  // Navigate to the new network's server buffer
  setActiveBuffer(net.networkId, '_server');
  updateRoute(net.networkId, '_server');
  return net.networkId;
}
