// ── Preferences Store ──
// All localStorage-backed reactive state

import { normalizeChannelName } from '../lib/utils';
import { parseIgnoreList } from '../lib/ignore';
import type { IgnoreMap } from '../lib/ignore';

// ── Global settings (IRCCloud-style) ──
export interface FeatureFlag {
  enabled: boolean;
}

export interface FeatureFlags {
  // W2-T03: prefVersion last-write-wins resolution. ON by default for Wave 2.
  usePrefVersion: boolean;
  // W1-T03: heartbeat_echo wire protocol.
  heartbeat: FeatureFlag;
  // W1-T04: edit-message wire protocol.
  editMessage: FeatureFlag;
  // W1-T06: buffersToDelete wire protocol.
  buffersToDelete: FeatureFlag;
  // W1-T08: temp_unavailable + idle events wire protocol.
  idleEvents: FeatureFlag;
}

export interface GlobalPrefs {
  theme: 'auto' | 'dark' | 'midnight';
  fontSize: number;
  compactMode: boolean;
  monospaceFont: boolean;
  showUserIcons: boolean;
  modeIndicator: 'dots' | 'symbols' | 'hidden';
  enlargeEmoji: boolean;
  sidebarLeft: boolean;
  coloriseMentions: boolean;
  formatColors: boolean;
  notificationSound: boolean;
  desktopNotifications: boolean;
  autoDismissNotifs: boolean;
  muteAll: boolean;
  typingIndicator: boolean;
  removeTrackers: boolean;
  customCSS: string;
  timestampFormat: '12h' | '24h' | 'relative';
  messageLayout: 'compact' | 'comfortable' | 'separate';
  inlineImages: boolean;
  inlineVideos: boolean;
  inlineTweets: boolean;
  inlinePastes: boolean;
  inlineReddit: boolean;
  inlineSocial: boolean;
  // W0-T01: feature-flag namespace gating Wave 1/2 protocol changes.
  // Most flags still default OFF for safe rollout; usePrefVersion
  // flips to ON in Wave 2 (prefVersion last-write-wins resolution).
  featureFlags: FeatureFlags;
}

export const DEFAULT_PREFS: GlobalPrefs = {
  theme: 'dark',
  fontSize: 14,
  compactMode: false,
  monospaceFont: true,
  showUserIcons: true,
  modeIndicator: 'dots',
  enlargeEmoji: true,
  sidebarLeft: false,
  coloriseMentions: true,
  formatColors: true,
  notificationSound: true,
  desktopNotifications: true,
  autoDismissNotifs: true,
  muteAll: false,
  typingIndicator: true,
  removeTrackers: false,
  customCSS: '',
  timestampFormat: 'relative',
  messageLayout: 'comfortable',
  inlineImages: true,
  inlineVideos: true,
  inlineTweets: true,
  inlinePastes: true,
  inlineReddit: true,
  inlineSocial: true,
  featureFlags: {
    usePrefVersion: true,
    heartbeat: { enabled: false },
    editMessage: { enabled: false },
    buffersToDelete: { enabled: false },
    idleEvents: { enabled: false },
  },
};

export const globalPrefs = $state<GlobalPrefs>(
  mergeDefaults(getStorageItem('ircfiber:globalPrefs', {}), DEFAULT_PREFS)
);

function mergeDefaults(saved: Partial<GlobalPrefs>, defaults: GlobalPrefs): GlobalPrefs {
  const out = { ...defaults, ...saved } as GlobalPrefs;
  // Deep-merge the featureFlags namespace so partial saved data (e.g.
  // a user who enabled one flag before others were added) does not lose
  // the nested { enabled: false } defaults. Plain spread would replace
  // the entire featureFlags object and unset untouched nested flags.
  if (saved.featureFlags || defaults.featureFlags) {
    const savedFf = (saved.featureFlags ?? {}) as Partial<FeatureFlags>;
    const defaultsFf = defaults.featureFlags;
    out.featureFlags = {
      ...defaultsFf,
      ...savedFf,
      heartbeat: { ...defaultsFf.heartbeat, ...(savedFf.heartbeat ?? {}) },
      editMessage: { ...defaultsFf.editMessage, ...(savedFf.editMessage ?? {}) },
      buffersToDelete: { ...defaultsFf.buffersToDelete, ...(savedFf.buffersToDelete ?? {}) },
      idleEvents: { ...defaultsFf.idleEvents, ...(savedFf.idleEvents ?? {}) },
    };
  }
  return out;
}

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
// Channels the user has explicitly deleted from the UI. Persists across
// refreshes so the next sync (which re-includes parted/auto-join channels)
// doesn't bring the buffer back.
export const hiddenChannelsMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:hiddenChannels', {}));
export const ignoreList = $state<string[]>(getStorageItem('ircfiber:ignores', []));
export const highlightWords = $state<string[]>(getStorageItem('ircfiber:highlightWords', []));
export const serverlogCollapsedMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:serverlogCollapsed', {}));
export const membersCollapsedMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:membersCollapsed', {}));
export const collapsedMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:collapsed', {}));
export const inactiveCollapsedMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:inactiveCollapsed', {}));
export const conversationsCollapsedMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:conversationsCollapsed', {}));
// User-defined sidebar order for networks (top-to-bottom). Mirrors IRCCloud's
// `reorder-connections` stream message: a full ordered list of networkIds is
// sent on every change. Networks not in the list are appended at the end in
// their natural order. The Sidebar component reads this when iterating
// ircState.networks.
export const networkOrder = $state<string[]>(getStorageItem('ircfiber:networkOrder', []));
// Per-buffer last-read message timestamp (IRCCloud-style lastSeen)
export const lastSeenMap = $state<Record<string, number>>(getStorageItem('ircfiber:lastSeen', {}));
// Per-buffer bottom-seen message timestamp (IRCCloud-style bottomSeen)
export const bottomSeenMap = $state<Record<string, number>>(getStorageItem('ircfiber:bottomSeen', {}));
export const focusSeenMap = $state<Record<string, number>>(getStorageItem('ircfiber:focusSeen', {}));
// IRCCloud-style: when true, the user has disabled the "post a snippet?"
// prompt that appears when sending multi-line or very long messages. The
// prompt itself still works on each send; this flag is a per-user
// preference, persisted in localStorage (key: pastebin-disableprompt).
// Exported as a getter so callers can read the value in templates, and
// mutated via setPastebinDisablePrompt() to keep Svelte's $state
// export-reassignment rules happy.
let _pastebinDisablePrompt = $state<boolean>(getStorageItem('ircfiber:pastebinDisablePrompt', false));
export function getPastebinDisablePrompt(): boolean { return _pastebinDisablePrompt; }

// IRCCloud parity: setPastebinPrompts(false) disables the prompt, true
// re-enables it.  Used by the "Offer to post a snippet" checkbox in the
// PastebinDialog.
export function setPastebinDisablePrompt(value: boolean): void {
  _pastebinDisablePrompt = value;
}

// Per-buffer channel preferences (showUnread, mute, formatColor, etc.)
// Key: `${networkId}:${bufferName}`. Value: partial record of toggles.
export interface BufferPrefs {
  showUnread?: boolean;
  markAsRead?: boolean;
  mute?: boolean;
  notifyAll?: boolean;
  formatColor?: boolean;
  showJoinPart?: boolean;
  collapseDisconnects?: boolean;
  replyCollapse?: boolean;
  replyQuote?: boolean;
  typing?: boolean;
  inlineFiles?: boolean;
  inlineImages?: boolean;
  inlinePastes?: boolean;
  inlineSocial?: boolean;
  inlineReddit?: boolean;
}
export const bufferPrefsMap = $state<Record<string, BufferPrefs>>(
  getStorageItem('ircfiber:bufferPrefs', {})
);

export function getBufferPrefs(networkId: string, bufferName: string): BufferPrefs {
  return bufferPrefsMap[`${networkId}:${normalizeChannelName(bufferName)}`] ?? {};
}

export function setBufferPref<K extends keyof BufferPrefs>(
  networkId: string,
  bufferName: string,
  key: K,
  value: BufferPrefs[K]
): void {
  const mapKey = `${networkId}:${normalizeChannelName(bufferName)}`;
  const current = bufferPrefsMap[mapKey] ?? {};
  bufferPrefsMap[mapKey] = { ...current, [key]: value };
}

// Throttle localStorage writes so high-frequency changes (unread, highlight,
// lastSeen, bottomSeen) don't block the main thread on every single message.
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 500; // flush at most twice a second
const persistedMaps = new Map<string, unknown>();

function schedulePersist(keyPrefix: string, map: unknown): void {
  persistedMaps.set(keyPrefix, map);
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    for (const [key, data] of persistedMaps) {
      setStorageItem(key, data);
    }
    persistedMaps.clear();
  }, PERSIST_DEBOUNCE_MS);
}

/** Schedules a persist after reading the map's keys so Svelte 5 tracks mutations. */
function schedulePersistMap<T>(keyPrefix: string, map: Record<string, T>): void {
  // Reading keys subscribes the effect to additions/removals on the $state proxy.
  // Without this read, passing the proxy reference alone won't re-trigger the effect.
  Object.keys(map);
  schedulePersist(keyPrefix, map);
}

/** Flush any pending persistence writes immediately. Useful in tests. */
export function flushPersist(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  for (const [key, data] of persistedMaps) {
    setStorageItem(key, data);
  }
  persistedMaps.clear();
}

// Persist on change — $effect.root allows effects outside components
$effect.root(() => {
  $effect(() => schedulePersistMap('ircfiber:clearedAt', clearedAtMap));
  $effect(() => schedulePersistMap('ircfiber:unread', unreadMap));
  $effect(() => schedulePersistMap('ircfiber:highlight', highlightMap));
  $effect(() => schedulePersistMap('ircfiber:archived', archivedMap));
  $effect(() => schedulePersistMap('ircfiber:pinned', pinnedMap));
  $effect(() => {
    schedulePersistMap('ircfiber:hiddenChannels', hiddenChannelsMap);
  });
  $effect(() => { setStorageItem('ircfiber:ignores', ignoreList); });
  $effect(() => { setStorageItem('ircfiber:highlightWords', highlightWords); });
  $effect(() => schedulePersistMap('ircfiber:serverlogCollapsed', serverlogCollapsedMap));
  $effect(() => schedulePersistMap('ircfiber:membersCollapsed', membersCollapsedMap));
  $effect(() => schedulePersistMap('ircfiber:collapsed', collapsedMap));
  $effect(() => schedulePersistMap('ircfiber:inactiveCollapsed', inactiveCollapsedMap));
  $effect(() => schedulePersistMap('ircfiber:conversationsCollapsed', conversationsCollapsedMap));
  $effect(() => { setStorageItem('ircfiber:networkOrder', networkOrder); });
  $effect(() => schedulePersistMap('ircfiber:lastSeen', lastSeenMap));
  $effect(() => schedulePersistMap('ircfiber:bottomSeen', bottomSeenMap));
  $effect(() => schedulePersistMap('ircfiber:focusSeen', focusSeenMap));
  $effect(() => setStorageItem('ircfiber:pastebinDisablePrompt', _pastebinDisablePrompt));
  $effect(() => schedulePersistMap('ircfiber:bufferPrefs', bufferPrefsMap));
  $effect(() => { setStorageItem('ircfiber:globalPrefs', globalPrefs); });
});

// ── Helpers ──
export function getClearedAt(networkId: string, bufferName: string): number | null {
  return clearedAtMap[`${networkId}:${bufferName}`] ?? null;
}
export function setClearedAt(networkId: string, bufferName: string): void {
  clearedAtMap[`${networkId}:${bufferName}`] = Date.now();
  // Write to localStorage synchronously so a fast page refresh (<500ms
  // debounce) doesn't lose the cleared state — same pattern as hideChannel.
  setStorageItem('ircfiber:clearedAt', clearedAtMap);
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

export function getFocusSeen(networkId: string, bufferName: string): number | null {
  return focusSeenMap[`${networkId}:${normalizeChannelName(bufferName)}`] ?? null;
}
export function setFocusSeen(networkId: string, bufferName: string, ts: number): void {
  focusSeenMap[`${networkId}:${normalizeChannelName(bufferName)}`] = ts;
}

// ── Ignore map (3-level host→user→nick) ──
let ignoreMap: IgnoreMap = parseIgnoreList(ignoreList);

export function rebuildIgnoreMap(): void {
  ignoreMap = parseIgnoreList(ignoreList);
}

$effect.root(() => {
  $effect(() => {
    // Rebuild the 3-level map whenever ignoreList changes (automatic via $state).
    // This covers slash-command mutations, cross-tab sync, and direct edits.
    ignoreMap = parseIgnoreList(ignoreList);
  });
});

export function isIgnored(nick: string): boolean {
  if (!nick) return false;
  return ignoreMap.check(nick);
}

// ── Hidden channels (user-deleted) ──
// Distinct from archivedMap: archived channels reappear in the "Archived"
// sidebar section so the user can re-join them. Hidden channels are gone
// entirely from the UI; the user must /join them to bring them back.
export function hideChannel(networkId: string, bufferName: string): void {
  hiddenChannelsMap[`${networkId}:${normalizeChannelName(bufferName)}`] = true;
  // Write to localStorage immediately so a fast page refresh (<500ms debounce)
  // doesn't lose the hidden state. The debounced schedulePersist still runs
  // to handle cross-tab sync via the `storage` event listener below.
  setStorageItem('ircfiber:hiddenChannels', hiddenChannelsMap);
  schedulePersist('ircfiber:hiddenChannels', hiddenChannelsMap);
}
export function unhideChannel(networkId: string, bufferName: string): void {
  delete hiddenChannelsMap[`${networkId}:${normalizeChannelName(bufferName)}`];
  schedulePersist('ircfiber:hiddenChannels', hiddenChannelsMap);
}
export function isChannelHidden(networkId: string, bufferName: string): boolean {
  return !!hiddenChannelsMap[`${networkId}:${normalizeChannelName(bufferName)}`];
}

// ── Cross-tab sync ──
// The `storage` event fires in OTHER tabs/windows when localStorage is
// modified. We listen for it and update the corresponding reactive maps so
// the UI in all open tabs stays in sync (e.g. toggling "Show unread
// message indicator" in one tab updates the Sidebar/context-menu state in
// every other tab in real time).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key) return;
    const applyObject = <T>(map: Record<string, T>) => {
      try {
        if (e.newValue === null) {
          for (const k of Object.keys(map)) delete map[k];
          return;
        }
        const v = JSON.parse(e.newValue);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return;
        // Surgically update: remove keys no longer present, then merge in
        // the new keys. This preserves Svelte 5's fine-grained reactivity
        // for each key (the previous "delete all + Object.assign" approach
        // would replace the whole map in a way that broke $derived tracking).
        for (const k of Object.keys(map)) {
          if (!(k in v)) delete map[k];
        }
        Object.assign(map, v);
      } catch {}
    };
    const applyArray = (arr: unknown[]) => {
      try {
        arr.length = 0;
        if (e.newValue === null) return;
        const v = JSON.parse(e.newValue);
        if (Array.isArray(v)) arr.push(...v);
      } catch {}
    };

    switch (e.key) {
      case 'ircfiber:clearedAt':        applyObject(clearedAtMap); break;
      case 'ircfiber:unread':           applyObject(unreadMap); break;
      case 'ircfiber:highlight':        applyObject(highlightMap); break;
      case 'ircfiber:archived':         applyObject(archivedMap); break;
      case 'ircfiber:pinned':           applyObject(pinnedMap); break;
      case 'ircfiber:hiddenChannels':   applyObject(hiddenChannelsMap); break;
      case 'ircfiber:serverlogCollapsed':   applyObject(serverlogCollapsedMap); break;
      case 'ircfiber:membersCollapsed': {
        // Briefly suppress layout animations (e.g. member panel slide) so
        // the other tab snaps to the final state without re-playing the
        // animation that the originating tab already showed. Without this,
        // every open tab would re-animate every time a setting changes
        // somewhere else.
        suppressAnimations();
        applyObject(membersCollapsedMap);
        break;
      }
      case 'ircfiber:collapsed':         applyObject(collapsedMap); break;
      case 'ircfiber:inactiveCollapsed': applyObject(inactiveCollapsedMap); break;
      case 'ircfiber:conversationsCollapsed': applyObject(conversationsCollapsedMap); break;
      case 'ircfiber:networkOrder':      applyArray(networkOrder); break;
      case 'ircfiber:lastSeen':          applyObject(lastSeenMap); break;
      case 'ircfiber:bottomSeen':        applyObject(bottomSeenMap); break;
      case 'ircfiber:focusSeen':         applyObject(focusSeenMap); break;
      case 'ircfiber:bufferPrefs':       applyObject(bufferPrefsMap as Record<string, BufferPrefs>); break;
      case 'ircfiber:ignores':           applyArray(ignoreList); break;
      case 'ircfiber:highlightWords':    applyArray(highlightWords); break;
      case 'ircfiber:globalPrefs': {
        try {
          if (e.newValue) {
            const v = JSON.parse(e.newValue);
            if (v && typeof v === 'object') Object.assign(globalPrefs, v);
          }
        } catch {}
        break;
      }
    }
  });
}

// Add the `no-anim` class to the main wrap (and any inner elements with
// their own transitions like #member-sidebar.show) for one frame, so
// layout transitions triggered by cross-tab state syncs (member panel,
// sidebar width, etc.) don't replay their slide animation in every
// other tab. The originating tab already showed the animation; the
// remaining tabs should just snap to the final layout.
export function suppressAnimations(): void {
  if (typeof document === 'undefined') return;
  const targets = document.querySelectorAll<HTMLElement>(
    '#wrap, #wrap #member-sidebar.show, .sidebar, .message-container, .bufferstatus'
  );
  targets.forEach((el) => el.classList.add('no-anim'));
  // Remove on the next two animation frames so the new layout commits
  // without animation, and any *subsequent* local interaction still
  // animates normally.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      targets.forEach((el) => el.classList.remove('no-anim'));
    });
  });
}
