import type { Network } from '../types';

// The client-only tags this UI sends, spelled the way CLIENTTAGDENY spells
// them: no `+` prefix (IRCv3 message-tags, RPL_ISUPPORT Tokens).
const TAG_REPLY = 'reply';
const TAG_REACT = 'draft/react';
const TAG_UNREACT = 'draft/unreact';
const TAG_TYPING = 'typing';

export interface ClientTagFeatures {
  /** Send a PRIVMSG carrying `+reply` — the Reply affordances. */
  reply: boolean;
  /** Send a `+draft/react` / `+draft/unreact` TAGMSG named by `+reply`. */
  react: boolean;
  /** Send a `+typing` TAGMSG — the typing heartbeat. */
  typing: boolean;
}

/**
 * Which client-only tag features one network's server actually carries.
 *
 * Two independent gates, both read from state the engine already ships:
 *
 * 1. `message-tags` (`Network.capabilities`, from the WS sync `caps` array).
 *    Without it the server implements neither client-only tags nor TAGMSG
 *    ("Servers MUST NOT deliver TAGMSG to clients that haven't negotiated
 *    the message tags capability"), and the engine strips the tags of an
 *    outgoing PRIVMSG anyway (connection.d tagPrefix). Unknown caps count
 *    as unsupported, matching how Edit/Delete gate on their draft caps.
 * 2. `CLIENTTAGDENY` (`Network.isupport`). Comma-separated tag names with
 *    no `+` prefix; a leading `*` blocks everything and `-name` exempts one
 *    tag from that catch-all; empty or absent means everything is allowed.
 *    Its stated purpose is exactly this: letting a client remove UI that
 *    relies on a blocked tag.
 *
 * Tag names are case-sensitive opaque identifiers per the spec, so matching
 * is exact — only the ISUPPORT *key* is upper-cased by the engine, never
 * the value.
 */
export function clientTagFeatures(
  net: Pick<Network, 'capabilities' | 'isupport'> | null | undefined,
): ClientTagFeatures {
  if (!net?.capabilities?.has('message-tags')) {
    return { reply: false, react: false, typing: false };
  }
  const entries = (net.isupport?.['CLIENTTAGDENY'] ?? '')
    .split(',')
    .map(e => e.trim())
    .filter(e => e.length > 0);
  if (entries.length === 0) return { reply: true, react: true, typing: true };

  const denyAll = entries[0] === '*';
  const exempt = new Set<string>();
  const denied = new Set<string>();
  for (const e of entries) {
    if (e === '*') continue;
    if (e.startsWith('-')) exempt.add(e.slice(1));
    else denied.add(e);
  }
  // Under a catch-all only the exemptions matter (a bare name there is
  // already blocked); otherwise the list is the blocklist.
  const allowed = (tag: string): boolean => (denyAll ? exempt.has(tag) : !denied.has(tag));

  return {
    reply: allowed(TAG_REPLY),
    // A reaction toggles both directions and names its target row with
    // `+reply`, so all three must survive or the chips would lie.
    react: allowed(TAG_REACT) && allowed(TAG_UNREACT) && allowed(TAG_REPLY),
    typing: allowed(TAG_TYPING),
  };
}
