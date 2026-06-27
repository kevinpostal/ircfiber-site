import type { NotificationOptions } from '../types';
import { escapeHtml } from './utils';

const NOTIFICATION_TIMEOUT = 5000;
let permissionRequested = false;

// notStore prevents Safari GC from collecting notification onclick handlers
// by holding a reference to each active Notification object.
const notStore = new Map<string, Notification>();

export function isSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function isAllowed(): boolean {
  return isSupported() && Notification.permission === 'granted';
}

export function shouldRequest(): boolean {
  return isSupported() && Notification.permission === 'default' && !permissionRequested;
}

export async function requestPermission(): Promise<boolean> {
  if (!isSupported()) return false;
  permissionRequested = true;
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
}

export function resetNotificationState(): void {
  permissionRequested = false;
  notStore.clear();
}

/**
 * Create a Notification wrapped with notStore for GC prevention and
 * tag-based dedup. The uid is the dedup key (typically the nick-based tag
 * like `${networkId}:${channel}:${nick}`). Closes any existing notification
 * with the same uid before creating a new one.
 */
function showNotification(
  uid: string,
  title: string,
  opts: { body: string; icon: string; tag: string; silent: boolean },
): Notification | null {
  if (!isAllowed()) return null;

  // Dedup: close existing notification for same uid
  const existing = notStore.get(uid);
  if (existing) existing.close();

  const not = new Notification(title, {
    body: opts.body,
    icon: opts.icon,
    tag: opts.tag,
    silent: opts.silent,
  });

  notStore.set(uid, not);
  not.onshow = () => notStore.set(uid, not);   // keep ref for Safari GC
  not.onclose = () => notStore.delete(uid);
  return not;
}

export function notify(options: NotificationOptions): void {
  if (shouldRequest()) {
    requestPermission().then(granted => {
      if (granted) notify(options);
    });
    return;
  }

  if (!isAllowed()) return;

  const autoDismiss = options.autoDismiss ?? true;
  const silent = options.silent ?? false;

  // Linux body escape: IRCCloud's escapeHtmlMinimal (escape &, <, >, ")
  let body = options.body;
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Linux')) {
    body = escapeHtml(body);
  }

  try {
    const uid = options.tag;
    const notification = showNotification(uid, options.title, {
      body,
      icon: options.icon || '/favicon.ico',
      tag: 'ircfiber:' + options.tag,
      silent,
    });

    if (!notification) return;

    if (options.onClick) {
      const cb = options.onClick;
      notification.onclick = () => {
        window.focus();
        cb();
        notification.close();
      };
    }

    if (autoDismiss) {
      setTimeout(() => notification.close(), NOTIFICATION_TIMEOUT);
    }
  } catch (e) {
    console.warn('Notification failed:', e);
  }
}
