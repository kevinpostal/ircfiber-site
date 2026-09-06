import type { IRCMessage, Buffer, Network } from '../types';
import { isImportantMessage, isHighlightableMessage } from '../stores/ircStore.svelte';
import { getBufferPrefs, globalPrefs } from '../stores/preferences.svelte';
import { stripIrcFormatting } from './ircFormatting';
import { replaceColons } from './emoji';
import { extractImageUrlsFromText, proxiedImageUrl } from './imageInline';

/**
 * Port of IRCCloud's `Message.isNotable()` + `BufferNotificationView.shouldNotify()`
 * (bundle common-5650bddb.js @1012211 / @656343). The predicates themselves
 * (`isImportantMessage`, `isHighlightableMessage`) already live in ircStore as
 * ports of `Message.isImportant()` / `Message.isHighlightable()`, so this module
 * only composes them and formats the presentation.
 */
export interface NotifyPolicyInput {
  msg: IRCMessage;
  net: Network;
  buf: Buffer;
  /** isMessageIgnored(msg), computed once by the caller. */
  ignored: boolean;
  /** IRCCloud session.isInitialized() — ircState.bootComplete. */
  bootComplete: boolean;
  desktopNotificationsEnabled: boolean;
  muteAll: boolean;
  isActiveBuffer: boolean;
  /** IRCCloud session.isFocused() — isSessionFocused(). */
  sessionFocused: boolean;
  /** getBottomSeen(networkId, bufferName): locked only while scrolled up. */
  bottomSeen: number | null;
}

/**
 * IRCCloud `Message.isNotable()`:
 *   isNotableExempt = isSelf() || !isImportant() || isIgnored()
 *   isNotable = !exempt && !buffer.shouldMuteNotifications()
 *               && (isHighlightable() || (isChannel() && shouldNotifyAll() && !isNotice()))
 */
export function isNotableMessage(msg: IRCMessage, net: Network, buf: Buffer, ignored: boolean): boolean {
  if (ignored) return false;
  // Covers self / empty text / the important-type list (PRIVMSG, action,
  // NOTICE with a nick, INVITE, WALLOPS).
  if (!isImportantMessage(msg, net)) return false;
  const prefs = getBufferPrefs(net.networkId, buf.name);
  if (prefs.mute) return false;
  if (isHighlightableMessage(msg, net, buf)) return true;
  // IRCCloud gates "notify for all messages" on isChannel(); Fiber also
  // exposes the per-buffer "All messages" radio on the server log
  // (components/ServerLogContextMenu.svelte), so honour it there too.
  return buf.type !== 'query' && msg.command !== 'NOTICE' && prefs.notifyAll === true;
}

/** IRCCloud `BufferNotificationView.shouldNotify()`. */
export function shouldNotifyForMessage(i: NotifyPolicyInput): boolean {
  if (!i.bootComplete) return false;
  if (!i.desktopNotificationsEnabled) return false;
  if (i.muteAll) return false;
  if (!isNotableMessage(i.msg, i.net, i.buf, i.ignored)) return false;
  // IRCCloud `isBelowBottomSeen(m)`: only meaningful while bottomSeen is
  // locked (the reader scrolled up). Unlocked ⇒ falsy ⇒ the active+focused
  // buffer stays silent; locked below the new message ⇒ notify anyway.
  const belowBottomSeen = i.bottomSeen !== null && (i.msg.t ?? 0) > i.bottomSeen;
  if (!belowBottomSeen && i.isActiveBuffer && i.sessionFocused) return false;
  return true;
}

/** IRCCloud notification titles (bundle @656537). */
export function getNotificationTitle(msg: IRCMessage, buf: Buffer, networkName: string): string {
  if (msg.command === 'INVITE') return `Channel invite from: ${msg.nick} (${networkName})`;
  if (msg.command === 'WALLOPS') return `${msg.nick} (${networkName})`;
  return `${msg.nick} \u2014 ${buf.type === 'channel' ? buf.name : networkName}`;
}

/** IRCCloud notification bodies: stripped text run through emoji replacement. */
export function getNotificationBody(msg: IRCMessage): string {
  // Engine INVITE params: [0] = invitee, [1] = channel.
  if (msg.command === 'INVITE') return `Invite to join ${msg.params?.[1] ?? ''}`;
  return replaceColons(stripIrcFormatting(msg.text || ''));
}

/**
 * IRCCloud's `formatter.linker.singleImage`: the message's single inline image
 * becomes the notification icon. Gated exactly like MessageRow's inline
 * previews (global `inlineImages` + per-buffer "Embed external media").
 */
export function getNotificationIcon(net: Network, buf: Buffer, msg: IRCMessage): string | undefined {
  if (!globalPrefs.inlineImages) return undefined;
  if (getBufferPrefs(net.networkId, buf.name).inlineImages === false) return undefined;
  const [first] = extractImageUrlsFromText(msg.text || '');
  return first ? proxiedImageUrl(first) : undefined;
}
