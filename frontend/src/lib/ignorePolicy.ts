import type { IRCMessage } from '../types';
import { isIgnored } from '../stores/preferences.svelte';
import { messageHostmask } from './utils';

/** IRCCloud `MessageTypes.ignorable`: buffer_msg, me_msg, notice, invite, wallops.
 *  Joins/parts/quits/nick changes from ignored users are NOT hidden. */
export const IGNORABLE_COMMANDS = new Set(['PRIVMSG', 'NOTICE', 'INVITE', 'WALLOPS']);

/** Whether this message is both an ignorable type and from an ignored sender.
 *  Lives in its own module (not utils/messageHandler) to avoid an import
 *  cycle: preferences ← ignorePolicy ← {messageHandler, ircStore, views}. */
export function isMessageIgnored(msg: IRCMessage): boolean {
  if (!msg.nick) return false;
  if (!IGNORABLE_COMMANDS.has(msg.command) && msg.type !== 'action') return false;
  return isIgnored(msg.nick, messageHostmask(msg));
}
