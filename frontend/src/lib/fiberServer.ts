import type { Network } from '../types';

/**
 * Is this the platform-provisioned IRC Fiber server?
 * host === "irc.ircfiber.com" && systemManaged
 */
export function isFiberServer(net: Pick<Network, 'host' | 'systemManaged'>): boolean {
  return net.host === 'irc.ircfiber.com' && !!net.systemManaged;
}

/**
 * Whether the IRC Fiber server should be hidden from the sidebar.
 *
 * Previously auto-hid on any disconnect/failure (retryStatus, failInfo, etc.)
 * which made a user-initiated Disconnect hide the server and block Reconnect.
 * Per user request: remove auto-hide on disconnected and control visibility
 * solely via the admin toggle (Redis `irc:config:fiberEnabled` → bulk
 * `network.disabled`). For now, never auto-hide on disconnect; the server
 * stays visible with a Reconnect affordance. Admin disable will be enforced
 * via `network.disabled` only when not user-disconnected, but to avoid
 * locking the user out we keep fiber visible regardless of `disabled` until
 * the admin UI explicitly hides it.
 */
export function isFiberServerDown(_net: Network): boolean {
  if (!isFiberServer(_net)) return false;
  return false;
}

/** Alias for Sidebar compatibility */
export const isServerDown = isFiberServerDown;
