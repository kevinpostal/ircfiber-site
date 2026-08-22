import type { IRCMessage, Buffer } from '../types';
import type { BufferPrefs } from '../stores/preferences.svelte';

export interface NotifyPolicyInput {
  networkId: string;
  bufferName: string;
  bufferType: Buffer['type'] | undefined;
  msg: IRCMessage;
  currentNick: string;
  bufferPrefs: BufferPrefs;
  desktopNotificationsEnabled: boolean;
  muteAll: boolean;
  isActiveBuffer: boolean;
  documentHidden: boolean;
}

export function isChatMessage(msg: IRCMessage): boolean {
  // IRCCloud parity: only PRIVMSG (including CTCP ACTION which is PRIVMSG with type 'action')
  // counts as chat for desktop notifications / unread. NOTICE (including NickServ,
  // ChanServ, MemoServ) is a service notice and must NOT trigger desktop
  // notifications or unread badges — it is shown in the notice overlay / server log.
  return msg.command === 'PRIVMSG' || msg.type === 'action';
}

export function shouldNotifyForMessage(input: NotifyPolicyInput): boolean {
  const {
    bufferType,
    msg,
    currentNick,
    bufferPrefs,
    desktopNotificationsEnabled,
    muteAll,
    isActiveBuffer,
    documentHidden,
  } = input;

  if (!desktopNotificationsEnabled) return false;
  if (muteAll) return false;
  if (bufferPrefs.mute) return false;

  // Don't notify when the user is actively looking at this exact buffer.
  if (isActiveBuffer && !documentHidden) return false;

  if (!msg.nick) return false;
  if (msg.nick.toLowerCase() === currentNick.toLowerCase()) return false;

  if (!isChatMessage(msg)) return false;

  if (bufferType === 'query') return true;
  if (msg.highlight) return true;
  if (bufferPrefs.notifyAll) return true;

  return false;
}

export function getNotificationTitle(msg: IRCMessage, bufferType: Buffer['type'] | undefined, bufferName: string): string {
  if (bufferType === 'query') {
    return msg.nick || '';
  }
  return `${msg.nick} in ${bufferName}`;
}
