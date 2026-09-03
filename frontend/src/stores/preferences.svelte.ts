// ── Preferences Store ──
// All localStorage-backed reactive state

import { normalizeChannelName } from '../lib/utils';
import { parseIgnoreList } from '../lib/ignore';
import type { IgnoreMap } from '../lib/ignore';


/** TTL for localStorage-backed caches. Anything older than this on
 *  read is dropped and the default value is returned. Prevents stale
 *  unread/highlight/lastSeen maps from years-old sessions from
 *  haunting the UI after a long absence. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Global settings (IRCCloud-style) ──
export interface FeatureFlag {
  enabled: boolean;
}

export interface FeatureFlags {
  // W2-T03: prefVersion last-write-wins resolution. ON by default for Wave 2.
  usePrefVersion: boolean;
  // W1-T04: edit-message wire protocol.
  editMessage: FeatureFlag;
  // W1-T06: buffersToDelete wire protocol.
  buffersToDelete: FeatureFlag;
	// W1-T08: temp_unavailable + idle events wire protocol.
	idleEvents: FeatureFlag;
	// W5-T01: XHR long-poll fallback when WebSocket fails.
	xhrFallback: FeatureFlag;
}

export interface GlobalPrefs {
  theme: 'dark' | 'midnight' | 'dusk' | 'tropic' | 'emerald' | 'sand' | 'orchid';
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
  defaultScrollPreset: number;
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
  defaultScrollPreset: 2,
  featureFlags: {
    usePrefVersion: true,
    editMessage: { enabled: true },
    buffersToDelete: { enabled: true },
		idleEvents: { enabled: true },
		xhrFallback: { enabled: true },
	},
};
export const globalPrefs = $state<GlobalPrefs>(
  mergeDefaults(getStorageItem('ircfiber:globalPrefs', {}), DEFAULT_PREFS)
);

// ── Global notification prefs cross-device helpers ──
// Flat bools keep prefVersion fan-out uniform (one counter for all prefs).
// Server is source of truth after first sync; localStorage remains instant
// cross-tab path via `storage` event. Toggles are low frequency — no debounce
// needed for server call. Mirrors `setShowMemberPrefixes` / `updateShowMemberPrefixes`.
export function setGlobalNotifPref<K extends keyof Pick<GlobalPrefs, 'desktopNotifications' | 'notificationSound' | 'autoDismissNotifs' | 'muteAll'>>(
  key: K,
  value: GlobalPrefs[K],
): void {
  (globalPrefs as unknown as Record<string, unknown>)[key] = value;
  setStorageItem('ircfiber:globalPrefs', globalPrefs);
  // Fire-and-forget cross-device sync — import lazily to avoid circular deps at top level.
  import('./api').then(({ updateNotificationPrefs }) => {
    updateNotificationPrefs({ [key]: value } as Record<string, boolean>).catch((e) => console.warn('[prefs] updateNotificationPrefs failed', e));
  }).catch(() => {});
}

let _lastNotifPrefVersion = 0;
export function applyServerNotificationPrefs(
  p: Partial<Pick<GlobalPrefs, 'desktopNotifications' | 'notificationSound' | 'autoDismissNotifs' | 'muteAll'>>,
  prefVersion: number,
): void {
  if (typeof prefVersion === 'number' && prefVersion > 0 && prefVersion <= _lastNotifPrefVersion) return;
  if (typeof prefVersion === 'number' && prefVersion > _lastNotifPrefVersion) _lastNotifPrefVersion = prefVersion;
  let changed = false;
  for (const k of ['desktopNotifications', 'notificationSound', 'autoDismissNotifs', 'muteAll'] as const) {
    if (p[k] !== undefined && typeof p[k] === 'boolean') {
      (globalPrefs as unknown as Record<string, unknown>)[k] = p[k];
      changed = true;
    }
  }
  if (changed) setStorageItem('ircfiber:globalPrefs', globalPrefs);
}

export function getLastNotifPrefVersion(): number { return _lastNotifPrefVersion; }
function mergeDefaults(saved: Partial<GlobalPrefs>, defaults: GlobalPrefs): GlobalPrefs {
  const out = { ...defaults, ...saved } as GlobalPrefs;
  // Clamp scroll preset to valid range
  if (typeof out.defaultScrollPreset !== 'number' || out.defaultScrollPreset < 0 || out.defaultScrollPreset > 4) {
    out.defaultScrollPreset = defaults.defaultScrollPreset;
  } else {
    out.defaultScrollPreset = Math.round(out.defaultScrollPreset);
  }
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
      editMessage: { ...defaultsFf.editMessage, ...(savedFf.editMessage ?? {}) },
      buffersToDelete: { ...defaultsFf.buffersToDelete, ...(savedFf.buffersToDelete ?? {}) },
		idleEvents: { ...defaultsFf.idleEvents, ...(savedFf.idleEvents ?? {}) },
		xhrFallback: { ...defaultsFf.xhrFallback, ...(savedFf.xhrFallback ?? {}) },
    };
  }
  return out;
}

function getStorageItem<T>(key: string, defaultValue: T): T {
  try {
    // TTL guard: any persisted value older than CACHE_TTL_MS is dropped
    // and the default is returned. The sibling `_savedAt` key records
    // when the value was last written; if it's missing (legacy data
    // written before the TTL feature shipped) we keep the value as-is
    // — absence of `_savedAt` means "indefinite", which preserves
    // backwards compatibility with existing users.
    const savedAtRaw = localStorage.getItem(key + ':_savedAt');
    if (savedAtRaw !== null) {
      const savedAt = parseInt(savedAtRaw, 10);
      if (Number.isFinite(savedAt) && Date.now() - savedAt > CACHE_TTL_MS) {
        return defaultValue;
      }
    }
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
export function setStorageItem(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    // Sibling timestamp so getStorageItem can apply TTL. Writes happen
    // together so the value and its age are always in sync.
    localStorage.setItem(key + ':_savedAt', String(Date.now()));
  } catch (e) {
    // Storage might be full or unavailable
    console.warn('Failed to persist', key, e);
  }
}

// ── Persistence stores ──
export const clearedAtMap = $state<Record<string, number>>(getStorageItem('ircfiber:clearedAt', {}));
/** Unseen important-message count per buffer key (`nid:name`); absent = 0 (IRCCloud `unseen` = count > 0). */
export const unseenMap = $state<Record<string, number>>(getStorageItem('ircfiber:unseen', {}));
/** IRCCloud `unseenHighlights` per buffer key: ascending `t` of unseen highlightable messages. */
export const unseenHighlightsMap = $state<Record<string, number[]>>(getStorageItem('ircfiber:unseenHighlights', {}));
export const archivedMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:archived', {}));
export const pinnedMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:pinned', {}));
// Channels the user has explicitly deleted from the UI. Persists across
// refreshes so the next sync (which re-includes parted/auto-join channels)
// doesn't bring the buffer back.
export const hiddenChannelsMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:hiddenChannels', {}));
export const ignoreList = $state<string[]>(getStorageItem('ircfiber:ignores', []));
export const highlightWords = $state<string[]>(getStorageItem('ircfiber:highlightWords', []));
export const serverlogCollapsedMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:serverlogCollapsed', {}));
export const serverlogHiddenMap = $state<Record<string, boolean>>(getStorageItem('ircfiber:serverlogHidden', {}));
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

// ── W2-T03 / W4-T01: server-log "connection events" preference ──
//
// IRCCloud collapses connection-attempt events (phases + welcome +
// MOTD + numerics + ISUPPORT + notices) under a single global
// `<details>` element, default-collapsed. fiber mirrors that UX:
// the pref is GLOBAL (not per-network) and defaults to TRUE so the
// server-log timeline stays restrained out of the box.
//
// When true (default), the `<details class="connection-events">` block in
// ServerLogTimeline is collapsed — the user sees just the per-attempt
// header (Connecting / Connected / Disconnected) and the count badge in
// the summary, not the individual phase / welcome / MOTD / ISUPPORT /
// NOTICE rows.
//
// Distinct from `serverlogCollapsedMap`, which is per-attempt (each
// connection attempt's own collapse state). This is a GLOBAL pref that
// applies across all networks + attempts, matching IRCCloud's behaviour.
//
// Key lives at `ircfiber:serverlogCollapseEvents`. The getter / setter
// pair is the read API consumed by ServerLogTimeline.svelte (W4-T01)
// and any future disclosure / collapse affordance. The setter writes
// to localStorage immediately so a fast page-refresh (< 500ms debounce)
// preserves the user's toggle.
//
// Cross-device sync is intentionally NOT wired to a server endpoint
// here — the pref lives in localStorage only. Tying it to the existing
// `updateServerlogCollapsed` REST call (which is shaped for the
// per-attempt `serverlogCollapsedMap` and uses different storage keys)
// would conflate two orthogonal collapse concepts. If cross-device
// sync is requested later, the cheapest path is a new
// `updateServerlogCollapseEvents` server-side route that mirrors the
// localStorage key shape; tracked as a follow-up.
//
// Persistence:
//   · Read on first import via `getStorageItem` (TTL-aware).
//   · Written immediately on every setter call (no debounce) so a fast
//     page refresh (< 500ms debounce window) doesn't lose the choice.
//   · Re-read on `storage` events from other tabs (see storage switch
//     below) so opening a second tab inherits the user's choice.
let _serverlogCollapseEvents = $state<boolean>(
  getStorageItem('ircfiber:serverlogCollapseEvents', true)
);

/** Read the current "show connection events" pref. Default: `true`
 *  (collapsed). Consumed by ServerLogTimeline.svelte's wrapping
 *  `<details open={!getServerlogCollapseEvents()}>` attribute. */
export function getServerlogCollapseEvents(): boolean {
  return _serverlogCollapseEvents;
}

export function setServerlogCollapseEvents(value: boolean): void {
  _serverlogCollapseEvents = value;
  setStorageItem('ircfiber:serverlogCollapseEvents', value);
}

// ── Member list prefix visibility ──
//
// Controls whether mode-prefix glyphs (@, +, %, etc.) are shown in the
// member list sidebar. Default true (show). Synced cross-tab via
// localStorage `storage` event and cross-device via `pref_update`
// (`showMemberPrefixes` key) + `stat_user` boot seed. The setter writes
// to localStorage immediately so a fast refresh (<500ms debounce) keeps
// the choice; the Settings UI also POSTs to
// `/api/me/show-member-prefixes` which then fans out via WS.
let _showMemberPrefixes = $state<boolean>(
  getStorageItem('ircfiber:showMemberPrefixes', true)
);

export function getShowMemberPrefixes(): boolean {
  return _showMemberPrefixes;
}

export function setShowMemberPrefixes(value: boolean): void {
  _showMemberPrefixes = value;
  setStorageItem('ircfiber:showMemberPrefixes', value);
}

// Per-buffer channel preferences (showUnread, mute, formatColor, etc.)
export interface BufferPrefs {
  showUnread?: boolean;
  /** Red badge with the unseen message count (mentions always show theirs). Default true. */
  showUnreadCount?: boolean;
  markAsRead?: boolean;
  mute?: boolean;
  notifyAll?: boolean;
  formatColor?: boolean;
  showJoinPart?: boolean;
  showAway?: boolean;
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
  $effect(() => schedulePersistMap('ircfiber:unseen', unseenMap));
  $effect(() => schedulePersistMap('ircfiber:unseenHighlights', unseenHighlightsMap));
  $effect(() => schedulePersistMap('ircfiber:archived', archivedMap));
  $effect(() => schedulePersistMap('ircfiber:pinned', pinnedMap));
  $effect(() => {
    schedulePersistMap('ircfiber:hiddenChannels', hiddenChannelsMap);
  });
  $effect(() => { setStorageItem('ircfiber:ignores', ignoreList); });
  $effect(() => { setStorageItem('ircfiber:highlightWords', highlightWords); });
  $effect(() => schedulePersistMap('ircfiber:serverlogCollapsed', serverlogCollapsedMap));
  $effect(() => schedulePersistMap('ircfiber:serverlogHidden', serverlogHiddenMap));
  $effect(() => schedulePersistMap('ircfiber:membersCollapsed', membersCollapsedMap));
  $effect(() => schedulePersistMap('ircfiber:collapsed', collapsedMap));
  $effect(() => schedulePersistMap('ircfiber:inactiveCollapsed', inactiveCollapsedMap));
  $effect(() => schedulePersistMap('ircfiber:conversationsCollapsed', conversationsCollapsedMap));
  $effect(() => { setStorageItem('ircfiber:networkOrder', networkOrder); });
  $effect(() => schedulePersistMap('ircfiber:lastSeen', lastSeenMap));
  $effect(() => schedulePersistMap('ircfiber:bottomSeen', bottomSeenMap));
  $effect(() => schedulePersistMap('ircfiber:focusSeen', focusSeenMap));
  $effect(() => setStorageItem('ircfiber:pastebinDisablePrompt', _pastebinDisablePrompt));
  $effect(() => setStorageItem('ircfiber:serverlogCollapseEvents', _serverlogCollapseEvents));
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
  // Write-through so a fast disconnect/reload (<500ms debounce) doesn't
  // lose the read marker and re-raise the same unread notice on reconnect.
  // Same pattern as hideChannel.
  setStorageItem('ircfiber:lastSeen', lastSeenMap);
  schedulePersist('ircfiber:lastSeen', lastSeenMap);
}
export function getBottomSeen(networkId: string, bufferName: string): number | null {
  return bottomSeenMap[`${networkId}:${normalizeChannelName(bufferName)}`] ?? null;
}
export function setBottomSeen(networkId: string, bufferName: string, ts: number): void {
  bottomSeenMap[`${networkId}:${normalizeChannelName(bufferName)}`] = ts;
  setStorageItem('ircfiber:bottomSeen', bottomSeenMap);
  schedulePersist('ircfiber:bottomSeen', bottomSeenMap);
}

export function getFocusSeen(networkId: string, bufferName: string): number | null {
  return focusSeenMap[`${networkId}:${normalizeChannelName(bufferName)}`] ?? null;
}
export function setFocusSeen(networkId: string, bufferName: string, ts: number): void {
  focusSeenMap[`${networkId}:${normalizeChannelName(bufferName)}`] = ts;
}
export function clearFocusSeen(networkId: string, bufferName: string): void {
  delete focusSeenMap[`${networkId}:${normalizeChannelName(bufferName)}`];
}
export function clearBottomSeen(networkId: string, bufferName: string): void {
  delete bottomSeenMap[`${networkId}:${normalizeChannelName(bufferName)}`];
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
      case 'ircfiber:unseen':           applyObject(unseenMap); break;
      case 'ircfiber:unseenHighlights': applyObject(unseenHighlightsMap); break;
      case 'ircfiber:archived':         applyObject(archivedMap); break;
      case 'ircfiber:pinned':           applyObject(pinnedMap); break;
      case 'ircfiber:hiddenChannels':   applyObject(hiddenChannelsMap); break;
      case 'ircfiber:serverlogCollapsed':   applyObject(serverlogCollapsedMap); break;
      case 'ircfiber:serverlogHidden':      applyObject(serverlogHiddenMap); break;
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
      case 'ircfiber:serverlogCollapseEvents': {
        // Cross-tab mirror — a second tab toggling the pref via the
        // server-log context menu (W4-T01) updates this tab in real
        // time. The dispatch is single-key so we don't accidentally
        // replay a multi-key storage event from another tab. Scalar
        // pref — re-read straight into the local $state. Null and
        // malformed JSON both fall back to the default (true).
        if (e.newValue === null) {
          _serverlogCollapseEvents = true;
        } else {
          try {
            const v = JSON.parse(e.newValue);
            _serverlogCollapseEvents = v === true || v === false ? v : true;
          } catch {
            _serverlogCollapseEvents = true;
          }
        }
        break;
      }
      case 'ircfiber:globalPrefs': {
        try {
          if (e.newValue) {
            const v = JSON.parse(e.newValue);
            if (v && typeof v === 'object') Object.assign(globalPrefs, v);
          }
        } catch {}
        break;
      }
      case 'ircfiber:showMemberPrefixes': {
        if (e.newValue === null) {
          _showMemberPrefixes = true;
        } else {
          try {
            const v = JSON.parse(e.newValue);
            _showMemberPrefixes = v === true || v === false ? v : true;
          } catch {
            _showMemberPrefixes = true;
          }
        }
        break;
      }
      case 'ircfiber:pastebinDisablePrompt': {
        if (e.newValue === null) {
          _pastebinDisablePrompt = false;
        } else {
          try {
            const v = JSON.parse(e.newValue);
            _pastebinDisablePrompt = v === true || v === false ? v : false;
          } catch {
            _pastebinDisablePrompt = false;
          }
        }
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
