// ── Preferences Store ──
// All localStorage-backed reactive state

import { normalizeChannelName } from '../lib/utils';

function getStorageItem<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    const v = JSON.parse(raw);
    if (v === null || v === undefined) return defaultValue;
    // If default expects a plain object, ensure loaded value is one too
    if (defaultValue !== null && typeof defaultValue === 'object' && !Array.isArray(defaultValue)) {
      if (typeof v !== 'object' || Array.isArray(v)) return defaultValue;
    }
    return v;
  } catch {
    return defaultValue;
  }
}
function setStorageItem(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Storage might be full or unavailable
    console.warn('Failed to persist', key, e);
  }
}

// ── Persistence stores ──
export const clearedAtMap = $state<Record<string, number>>(getStorageItem('ircfiber:clearedAt', {}));
export const unreadMap = $state<Record<string, number>>(getStorageItem('ircfiber:unread', {}));
export const highlightMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:highlight', {}));
export const archivedMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:archived', {}));
export const pinnedMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:pinned', {}));
export const ignoreList = $state<string[]>(getStorageItem('ircfiber:ignores', []));
export const highlightWords = $state<string[]>(getStorageItem('ircfiber:highlightWords', []));
export const membersCollapsedMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:membersCollapsed', {}));
// Per-buffer last-read message timestamp (IRCCloud-style lastSeen)
export const lastSeenMap = $state<Record<string, number>>(getStorageItem('ircfiber:lastSeen', {}));
// Per-buffer bottom-seen message timestamp (IRCCloud-style bottomSeen)
export const bottomSeenMap = $state<Record<string, number>>(getStorageItem('ircfiber:bottomSeen', {}));

// Persist on change — $effect.root allows effects outside components
$effect.root(() => {
  $effect(() => { setStorageItem('ircfiber:clearedAt', clearedAtMap); });
  $effect(() => { setStorageItem('ircfiber:unread', unreadMap); });
  $effect(() => { setStorageItem('ircfiber:highlight', highlightMap); });
  $effect(() => { setStorageItem('ircfiber:archived', archivedMap); });
  $effect(() => { setStorageItem('ircfiber:pinned', pinnedMap); });
  $effect(() => { setStorageItem('ircfiber:ignores', ignoreList); });
  $effect(() => { setStorageItem('ircfiber:highlightWords', highlightWords); });
  $effect(() => { setStorageItem('ircfiber:membersCollapsed', membersCollapsedMap); });
  $effect(() => { setStorageItem('ircfiber:lastSeen', lastSeenMap); });
  $effect(() => { setStorageItem('ircfiber:bottomSeen', bottomSeenMap); });
});

// ── Helpers ──
export function getClearedAt(networkId: string, bufferName: string): number | null {
  return clearedAtMap[`${networkId}:${bufferName}`] ?? null;
}
export function setClearedAt(networkId: string, bufferName: string): void {
  clearedAtMap[`${networkId}:${bufferName}`] = Date.now();
}
export function clearClearedAt(networkId: string, bufferName: string): void {
  delete clearedAtMap[`${networkId}:${bufferName}`];
}
export function getLastSeen(networkId: string, bufferName: string): number | null {
  return lastSeenMap[`${networkId}:${normalizeChannelName(bufferName)}`] ?? null;
}
export function setLastSeen(networkId: string, bufferName: string, ts: number): void {
  lastSeenMap[`${networkId}:${normalizeChannelName(bufferName)}`] = ts;
}
export function getBottomSeen(networkId: string, bufferName: string): number | null {
  return bottomSeenMap[`${networkId}:${normalizeChannelName(bufferName)}`] ?? null;
}
export function setBottomSeen(networkId: string, bufferName: string, ts: number): void {
  bottomSeenMap[`${networkId}:${normalizeChannelName(bufferName)}`] = ts;
}

export function isIgnored(nick: string): boolean {
  if (!nick) return false;
  return ignoreList.some(pattern => {
    if (pattern.includes('*') || pattern.includes('?')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      return regex.test(nick);
    }
    return pattern.toLowerCase() === nick.toLowerCase();
  });
}
