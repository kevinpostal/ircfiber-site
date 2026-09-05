import type { Network, Buffer, IRCMessage, Member } from '../types';

let counter = 0;
const id = () => `id-${++counter}`;

export function createMessage(overrides: Partial<IRCMessage> = {}): IRCMessage {
  return {
    id: id(),
    command: 'PRIVMSG',
    nick: 'alice',
    text: 'hello',
    t: Date.now(),
    ...overrides,
  };
}

export function createNetwork(overrides: Partial<Network> = {}): Network {
  return {
    networkId: id(),
    name: 'libera',
    host: 'irc.libera.chat',
    port: 6697,
    tls: 'required',
    nick: 'tester',
    realName: 'tester',
    currentNick: 'tester',
    sasl: 'none',
    saslUsername: '',
    saslPassword: '',
    connected: true,
    connecting: false,
    connectionState: 'connected',
    status: 'connected',
    disconnectReason: '',
    isAway: false,
    awayMessage: '',
    buffers: [],
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
    ...overrides,
  };
}

export function createBuffer(overrides: Partial<Buffer> = {}): Buffer {
  return {
    name: '#channel',
    type: 'channel',
    isJoined: true,
    unseen: false,
    unseenCount: 0,
    unseenHighlights: [],
    isPinned: false,
    isArchived: false,
    topic: '',
    topicSetBy: '',
    topicSetAt: 0,
    users: [],
    lastSeenMsgTime: null,
    firstUnseenMsgIndex: null,
    lastSeen: null,
    bottomSeen: null,
    clearedAt: null,
    modeFlags: {},
    ...overrides,
  };
}

export function createMember(overrides: Partial<Member> = {}): Member {
  return {
    nick: 'alice',
    prefix: '',
    category: 'MEMBER',
    ident: '',
    realname: '',
    isAway: false,
    awayMessage: '',
    lastSpoke: 0,
    lastHighlighted: 0,
    account: '',
    isBot: false,
    ...overrides,
  };
}

export function createServerBuffer(): Buffer {
  return createBuffer({ name: '_server', type: 'server' });
}

export function createNetworkWithChannels(
  channels: string[],
  overrides: Partial<Network> = {}
): Network {
  return createNetwork({
    ...overrides,
    buffers: channels.map((c) => createBuffer({ name: c, type: 'channel' })),
  });
}
