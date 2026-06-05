import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import NotificationBadge from './NotificationBadge.svelte';
import { unreadMap, highlightMap } from '../stores/preferences.svelte';

beforeEach(() => {
  Object.keys(unreadMap).forEach((k) => delete (unreadMap as Record<string, unknown>)[k]);
  Object.keys(highlightMap).forEach((k) => delete (highlightMap as Record<string, unknown>)[k]);
});

describe('NotificationBadge', () => {
  it('updates document.title with unread count', async () => {
    unreadMap['net1:#chan'] = 3;
    render(NotificationBadge);
    await expect.poll(() => document.title).toBe('(3) IRC Fiber');
  });

  it('shows highlight in title', async () => {
    unreadMap['net1:#chan'] = 5;
    highlightMap['net1:#chan'] = true;
    render(NotificationBadge);
    await expect.poll(() => document.title).toBe('(5) IRC Fiber');
  });

  it('resets title when unread returns to zero', async () => {
    unreadMap['net1:#chan'] = 2;
    render(NotificationBadge);
    await expect.poll(() => document.title).toBe('(2) IRC Fiber');
    delete unreadMap['net1:#chan'];
    await expect.poll(() => document.title).toBe('IRC Fiber');
  });
});
