import type { NotificationOptions } from '../types';

const NOTIFICATION_TIMEOUT = 5000;
let permissionRequested = false;

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
}

export function notify(options: NotificationOptions): void {
  if (typeof document !== 'undefined' && !document.hidden) return;

  if (shouldRequest()) {
    requestPermission().then(granted => {
      if (granted) notify(options);
    });
    return;
  }

  if (!isAllowed()) return;

  try {
    const notification = new Notification(options.title, {
      body: options.body,
      icon: options.icon || '/favicon.ico',
      tag: 'ircfiber:' + options.tag,
      silent: false,
    });

    if (options.onClick) {
      const cb = options.onClick;
      notification.onclick = () => {
        window.focus();
        cb();
        notification.close();
      };
    }

    setTimeout(() => notification.close(), NOTIFICATION_TIMEOUT);
  } catch (e) {
    console.warn('Notification failed:', e);
  }
}
