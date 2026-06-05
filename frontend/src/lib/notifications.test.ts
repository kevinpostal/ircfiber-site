import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isSupported,
  isAllowed,
  shouldRequest,
  requestPermission,
  notify,
  resetNotificationState,
} from './notifications';

describe('notifications', () => {
  let mock_permission: NotificationPermission = 'default';
  let document_hidden = false;
  let notification_instances: Array<{
    title: string;
    options?: NotificationOptions;
    onclick: (() => void) | null;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  let mock_request_permission: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetNotificationState();
    mock_permission = 'default';
    document_hidden = false;
    notification_instances = [];

    mock_request_permission = vi.fn().mockImplementation(() => {
      return Promise.resolve(mock_permission);
    });

    function MockNotification(this: { title: string; options?: NotificationOptions; onclick: (() => void) | null; close: ReturnType<typeof vi.fn> }, title: string, options?: NotificationOptions) {
      const instance = {
        title,
        options,
        onclick: null as (() => void) | null,
        close: vi.fn(),
      };
      notification_instances.push(instance);
      Object.assign(this, instance);
      return instance;
    }
    const MockNotificationClass = MockNotification as unknown as typeof Notification;

    Object.defineProperty(MockNotification, 'permission', {
      get() { return mock_permission; },
      configurable: true,
    });
    Object.defineProperty(MockNotification, 'requestPermission', {
      value: mock_request_permission,
      configurable: true,
    });

    vi.stubGlobal('Notification', MockNotificationClass);
    vi.stubGlobal('window', {
      Notification: MockNotificationClass,
      focus: vi.fn(),
    });
    vi.stubGlobal('document', {
      get hidden() {
        return document_hidden;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('isSupported', () => {
    it('returns true when Notification is in window', () => {
      expect(isSupported()).toBe(true);
    });

    it('returns false when Notification is not in window', () => {
      vi.stubGlobal('window', {});
      expect(isSupported()).toBe(false);
    });
  });

  describe('isAllowed', () => {
    it('returns true when permission is granted', () => {
      mock_permission = 'granted';
      expect(isAllowed()).toBe(true);
    });

    it('returns false when permission is default', () => {
      mock_permission = 'default';
      expect(isAllowed()).toBe(false);
    });

    it('returns false when permission is denied', () => {
      mock_permission = 'denied';
      expect(isAllowed()).toBe(false);
    });
  });

  describe('shouldRequest', () => {
    it('returns true when permission is default and not yet requested', () => {
      mock_permission = 'default';
      expect(shouldRequest()).toBe(true);
    });

    it('returns false when permission is granted', () => {
      mock_permission = 'granted';
      expect(shouldRequest()).toBe(false);
    });

    it('returns false when permission is denied', () => {
      mock_permission = 'denied';
      expect(shouldRequest()).toBe(false);
    });

    it('returns false after requestPermission has been called', async () => {
      mock_permission = 'default';
      await requestPermission();
      expect(shouldRequest()).toBe(false);
    });
  });

  describe('requestPermission', () => {
    it('calls requestPermission on Notification', async () => {
      mock_permission = 'default';
      await requestPermission();
      expect(mock_request_permission).toHaveBeenCalled();
    });

    it('returns true when permission is granted', async () => {
      mock_permission = 'granted';
      const result = await requestPermission();
      expect(result).toBe(true);
    });

    it('returns false when permission is denied', async () => {
      mock_permission = 'denied';
      const result = await requestPermission();
      expect(result).toBe(false);
    });

    it('returns false when not supported', async () => {
      vi.stubGlobal('window', {});
      vi.stubGlobal('Notification', undefined);
      const result = await requestPermission();
      expect(result).toBe(false);
    });
  });

  describe('notify', () => {
    it('does nothing when document is visible', () => {
      document_hidden = false;
      mock_permission = 'granted';
      notify({ title: 'Test', body: 'Hello', tag: 'test' });
      expect(notification_instances).toHaveLength(0);
    });

    it('creates Notification when allowed and document hidden', () => {
      document_hidden = true;
      mock_permission = 'granted';
      notify({ title: 'Test', body: 'Hello', tag: 'test' });
      expect(notification_instances).toHaveLength(1);
      expect(notification_instances[0].title).toBe('Test');
      expect(notification_instances[0].options).toMatchObject({
        body: 'Hello',
        icon: '/favicon.ico',
        tag: 'ircfiber:test',
        silent: false,
      });
    });

    it('requests permission when shouldRequest is true', async () => {
      document_hidden = true;
      mock_permission = 'default';
      notify({ title: 'Test', body: 'Hello', tag: 'test' });
      await new Promise(r => setTimeout(r, 0));
      expect(mock_request_permission).toHaveBeenCalled();
    });

    it('calls onClick handler when notification is clicked', () => {
      document_hidden = true;
      mock_permission = 'granted';
      const on_click = vi.fn();
      notify({ title: 'Test', body: 'Hello', tag: 'test', onClick: on_click });
      expect(notification_instances).toHaveLength(1);
      if (notification_instances[0].onclick) {
        notification_instances[0].onclick();
      }
      expect(on_click).toHaveBeenCalled();
    });

    it('closes notification after timeout', () => {
      document_hidden = true;
      mock_permission = 'granted';
      vi.useFakeTimers();
      notify({ title: 'Test', body: 'Hello', tag: 'test' });
      expect(notification_instances).toHaveLength(1);
      vi.advanceTimersByTime(5000);
      expect(notification_instances[0].close).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
