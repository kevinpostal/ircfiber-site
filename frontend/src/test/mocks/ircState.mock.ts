import type { Network, ActiveBuffer, IRCMessage, OverlayState, ContextMenuState } from '../../types';

export function make_mock_irc_state() {
  return $state({
    networks: [] as Network[],
    activeBuffer: { networkId: null, bufferName: null } as ActiveBuffer,
    messages: {} as Record<string, IRCMessage[]>,
    me: null,
    wsConnected: false,
    focusLost: false,
    lastSeenMsgTime: null as number | null,
    optimisticMessages: new Map<string, IRCMessage>(),
    overlay: { type: null, data: null } as OverlayState,
    contextMenu: { visible: false, x: 0, y: 0, actions: [] } as ContextMenuState,
  });
}
