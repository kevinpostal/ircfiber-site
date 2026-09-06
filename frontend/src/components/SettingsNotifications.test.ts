import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import SettingsNotifications from './SettingsNotifications.svelte';
import { globalPrefs } from '../stores/preferences.svelte';
import { resetNotificationState } from '../lib/notifications';

/**
 * The contract these guard is "one user gesture produces exactly ONE
 * server write". The previous implementation persisted `true` and then
 * `false` from the permission callback; those two requests raced in the
 * gateway and the stale one won (sent true→false, assigned prefVersion
 * 19→18), so the switch silently came back on after a reload.
 */

let writes: Array<Record<string, unknown>>;
let mockPermission: NotificationPermission;
let requestResult: NotificationPermission;

function notificationsToggle() {
  return page.getByRole('checkbox').first();
}

beforeEach(() => {
  writes = [];
  mockPermission = 'default';
  requestResult = 'granted';
  resetNotificationState();

  globalPrefs.desktopNotifications = false;
  globalPrefs.muteAll = false;

  function MockNotification(this: unknown) { /* never constructed here */ }
  Object.defineProperty(MockNotification, 'permission', {
    get() { return mockPermission; },
    configurable: true,
  });
  Object.defineProperty(MockNotification, 'requestPermission', {
    value: async () => { mockPermission = requestResult; return requestResult; },
    configurable: true,
  });
  vi.stubGlobal('Notification', MockNotification as unknown as typeof Notification);

  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
    if (url.includes('notification-prefs')) {
      writes.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ prefVersion: writes.length }), { status: 200 });
    }
    return realFetch(input as RequestInfo, init);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetNotificationState();
});

/** The store write is fired from a lazily imported module — let it land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 10));
    if (writes.length > 0) break;
  }
  await new Promise((r) => setTimeout(r, 30));
}

describe('SettingsNotifications — desktop notifications toggle', () => {
  it('enabling with permission granted writes true exactly once', async () => {
    mockPermission = 'granted';
    render(SettingsNotifications);
    await userEvent.click(notificationsToggle());
    await settle();
    expect(writes).toEqual([{ desktopNotifications: true }]);
    expect(globalPrefs.desktopNotifications).toBe(true);
  });

  it('enabling prompts and, when allowed, writes true exactly once', async () => {
    mockPermission = 'default';
    requestResult = 'granted';
    render(SettingsNotifications);
    await userEvent.click(notificationsToggle());
    await settle();
    expect(writes).toEqual([{ desktopNotifications: true }]);
    expect(globalPrefs.desktopNotifications).toBe(true);
  });

  it('enabling when the browser blocks it writes false ONCE, never true', async () => {
    mockPermission = 'denied';
    render(SettingsNotifications);
    await userEvent.click(notificationsToggle());
    await settle();
    // The old code wrote true then false — that pair is what raced.
    expect(writes).toEqual([{ desktopNotifications: false }]);
    expect(globalPrefs.desktopNotifications).toBe(false);
    await expect.element(
      page.getByText('Blocked by your browser', { exact: false }),
    ).toBeInTheDocument();
  });

  it('enabling when the prompt is dismissed writes false ONCE and says so', async () => {
    mockPermission = 'default';
    requestResult = 'default';   // user dismissed
    render(SettingsNotifications);
    await userEvent.click(notificationsToggle());
    await settle();
    expect(writes).toEqual([{ desktopNotifications: false }]);
    expect(globalPrefs.desktopNotifications).toBe(false);
    // Must NOT claim the browser denied it — a dismissal is retryable.
    await expect.element(
      page.getByText('permission not granted', { exact: false }),
    ).toBeInTheDocument();
  });

  it('disabling writes false exactly once and never prompts', async () => {
    mockPermission = 'granted';
    globalPrefs.desktopNotifications = true;
    render(SettingsNotifications);
    await userEvent.click(notificationsToggle());
    await settle();
    expect(writes).toEqual([{ desktopNotifications: false }]);
    expect(globalPrefs.desktopNotifications).toBe(false);
  });
});
