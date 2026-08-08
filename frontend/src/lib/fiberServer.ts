import type { Network } from '../types';
import { isUserDisconnected } from '../stores/ircStore.svelte';

/**
 * Is this the platform-provisioned IRC Fiber server?
 * host === "irc.ircfiber.com" && systemManaged
 */
export function isFiberServer(net: Pick<Network, 'host' | 'systemManaged'>): boolean {
  return net.host === 'irc.ircfiber.com' && !!net.systemManaged;
}

/**
 * Smartly detect if the IRC Fiber server is down and should be hidden from the UI.
 * We keep the network in ircState.networks so it can auto-reappear when the server
 * comes back, but we don't render it in the sidebar.
 *
 * Detection covers:
 * - DNS timeout / not found
 * - TCP timeout / connection refused
 * - TLS handshake failure (server down, not TLS)
 * - Circuit breaker open (retryStatus)
 * - FailInfo present
 * - HostCircuitBreaker after 5 failures
 */
export function isFiberServerDown(net: Network): boolean {
  if (!isFiberServer(net)) return false;
  // Admin kill-switch: disabled Fiber networks are always hidden
  if ((net as any).disabled) return true;
  if (net.connected) return false;
  // User explicitly hit Disconnect — keep visible with Reconnect button
  if (isUserDisconnected(net.networkId)) return false;
  if (net.disconnectReason === 'You disconnected') return false;
  if (net.disconnectReason?.toLowerCase().includes('you disconnected')) return false;

  // Smart detection: retryStatus / failInfo indicates the server is down
  if (net.retryStatus && net.retryStatus.attemptCount >= 1) return true;
  if (net.failInfo) return true;

  const reason = (net.disconnectReason || '').toLowerCase();
  if (
    reason.includes('failed to connect') ||
    reason.includes('timed out') ||
    reason.includes('timeout') ||
    reason.includes('refused') ||
    reason.includes('tls') ||
    reason.includes('circuit') ||
    reason.includes('dns') ||
    reason.includes('not found') ||
    reason.includes('host') ||
    reason.includes('kicked') ||
    reason.includes('connection closed') ||
    reason.includes('connection lost') ||
    reason.includes('unreachable')
  ) {
    return true;
  }

  // Even during retry/connecting, if fiber has failure evidence, hide it
  const st = net.status || net.connectionState || '';
  if (['waiting_to_retry', 'connecting', 'queued'].includes(st)) {
    if (net.retryStatus || net.failInfo || reason) return true;
    const lastSeen = net.lastSeenAt || 0;
    if (lastSeen && Date.now() - lastSeen > 30000) return true;
    // For fiber, hide by default when not connected and in retry (server down)
    return true;
  }
  if (st === 'disconnected') return true;

  // Fallback: fiber and not connected -> hide (avoids perpetual disconnected entry)
  const lastSeen = net.lastSeenAt || 0;
  if (lastSeen && Date.now() - lastSeen > 30000) return true;
  return !net.connected;
}

/** Alias for Sidebar compatibility */
export const isServerDown = isFiberServerDown;
