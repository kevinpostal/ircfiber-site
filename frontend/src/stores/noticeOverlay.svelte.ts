export interface NoticeEntry {
  id: string;
  nick: string;
  networkId: string;
  networkName: string;
  text: string;
  t: number;
  params?: string[];
}

export const noticeState = $state<{ entries: NoticeEntry[] }>({ entries: [] });

const DISMISSED_KEY = 'ircfiber:dismissedNotices';
const LIVE_KEY = 'ircfiber:noticeLive';
const BROADCAST_NAME = 'ircfiber:notices';
const MAX_DISMISSED = 200;

function noticeHash(entry: Pick<NoticeEntry, 'nick' | 'text' | 'networkId'>): string {
  return `${entry.networkId}|${entry.nick.toLowerCase()}|${entry.text}`;
}

function loadDismissed(): Set<string> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DISMISSED_KEY) : null;
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x) => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

let dismissedSet: Set<string> = loadDismissed();

function persistDismissed(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const arr = [...dismissedSet].slice(-MAX_DISMISSED);
    dismissedSet = new Set(arr);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(arr));
    broadcast('dismissed', arr);
  } catch {}
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── Cross-tab / cross-device realtime sync ──
// Live entries are broadcast via BroadcastChannel (instant) and
// localStorage (storage event, survives BroadcastChannel gaps and
// works as the durable source for a tab that was opened later).
// Dismissed hashes are stored under DISMISSED_KEY — the storage
// listener below keeps every tab's in-memory Set in sync so a
// dismiss in tab A prevents re-show in tab B.
let bc: BroadcastChannel | null = null;
function getBC(): BroadcastChannel | null {
  if (bc) return bc;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    bc = new BroadcastChannel(BROADCAST_NAME);
    bc.onmessage = handleBroadcast;
  } catch {
    return null;
  }
  return bc;
}

function broadcast(type: string, payload: unknown): void {
  try { getBC()?.postMessage({ type, payload }); } catch {}
}

function persistLive(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LIVE_KEY, JSON.stringify(noticeState.entries));
  } catch {}
}

function loadLiveFromStorage(): NoticeEntry[] | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LIVE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return arr.filter((e) => e && typeof e.id === 'string' && typeof e.nick === 'string');
  } catch { return null; }
}

function applyLiveEntries(next: NoticeEntry[]): void {
  // Replace array contents while preserving the $state proxy identity
  // so Svelte 5 reactivity triggers correctly in every subscriber.
  noticeState.entries.length = 0;
  noticeState.entries.push(...next);
}

function handleBroadcast(ev: MessageEvent): void {
  const msg = ev.data as { type?: string; payload?: unknown };
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'live') {
    const arr = msg.payload as NoticeEntry[];
    if (Array.isArray(arr)) applyLiveEntries(arr);
  } else if (msg.type === 'dismissed') {
    const arr = msg.payload as string[];
    if (Array.isArray(arr)) {
      dismissedSet = new Set(arr.filter((x) => typeof x === 'string'));
      // If a notice was dismissed elsewhere, remove it live too
      const hashes = dismissedSet;
      let changed = false;
      for (let i = noticeState.entries.length - 1; i >= 0; i--) {
        if (hashes.has(noticeHash(noticeState.entries[i]))) {
          noticeState.entries.splice(i, 1);
          changed = true;
        }
      }
      if (changed) persistLive();
    }
  }
}

// Hydrate this tab from any live state left by a sibling tab that was
// already showing notices when this tab loaded.
try {
  const existing = loadLiveFromStorage();
  if (existing && existing.length > 0 && noticeState.entries.length === 0) {
    // Only hydrate if we haven't already been populated by a WS event
    // in this tick — and filter through dismissedSet so a previously
    // dismissed solicitation doesn't reappear on refresh.
    const filtered = existing.filter((e) => !dismissedSet.has(noticeHash(e)));
    if (filtered.length > 0) applyLiveEntries(filtered.slice(-20));
  }
} catch {}

if (typeof window !== 'undefined') {
  // Storage event: fired in *other* tabs when one tab writes localStorage.
  // Handles both the live overlay and the dismissed set.
  window.addEventListener('storage', (e) => {
    if (!e.key) return;
    if (e.key === LIVE_KEY) {
      try {
        if (e.newValue === null) {
          applyLiveEntries([]);
        } else {
          const v = JSON.parse(e.newValue);
          if (Array.isArray(v)) {
            // Basic shape guard — don't trust cross-tab JSON blindly
            const clean = v.filter((x: unknown) => x && typeof (x as NoticeEntry).id === 'string');
            applyLiveEntries(clean.slice(-20) as NoticeEntry[]);
          }
        }
      } catch {}
    } else if (e.key === DISMISSED_KEY) {
      try {
        if (e.newValue === null) {
          dismissedSet = new Set();
        } else {
          const arr = JSON.parse(e.newValue);
          if (Array.isArray(arr)) {
            dismissedSet = new Set(arr.filter((x: unknown) => typeof x === 'string') as string[]);
            // Remove any live entries that were dismissed elsewhere
            let changed = false;
            for (let i = noticeState.entries.length - 1; i >= 0; i--) {
              if (dismissedSet.has(noticeHash(noticeState.entries[i]))) {
                noticeState.entries.splice(i, 1);
                changed = true;
              }
            }
            if (changed) persistLive();
          }
        }
      } catch {}
    }
  });
  // Ensure BroadcastChannel is created so future messages are received
  getBC();
}

export function addNotice(entry: Omit<NoticeEntry, 'id'>): void {
  // Skip if previously dismissed (persists across refresh) — prevents
  // "same notice show on manual page refresh" for solicitations like
  // EliManning [#superbowl] JOIN #5000 NOW which live in CHATHISTORY.
  if (dismissedSet.has(noticeHash(entry))) return;
  // Dedup: if same nick+text arrived within 2s, skip (burst duplicate)
  const now = Date.now();
  const isDup = noticeState.entries.some(
    (e) => e.nick === entry.nick && e.text === entry.text && Math.abs((e.t ?? now) - (entry.t ?? now)) < 2000,
  );
  if (isDup) return;
  const id = makeId();
  noticeState.entries.push({ ...entry, id });
  // Cap at 20
  if (noticeState.entries.length > 20) {
    noticeState.entries.splice(0, noticeState.entries.length - 20);
  }
  persistLive();
  broadcast('live', noticeState.entries);
}

export function dismissNotice(id: string): void {
  const idx = noticeState.entries.findIndex((e) => e.id === id);
  if (idx >= 0) {
    const [removed] = noticeState.entries.splice(idx, 1);
    if (removed) {
      dismissedSet.add(noticeHash(removed));
      persistDismissed();
    }
    persistLive();
    broadcast('live', noticeState.entries);
  }
}

export function dismissAll(): void {
  for (const e of noticeState.entries) dismissedSet.add(noticeHash(e));
  if (noticeState.entries.length > 0) persistDismissed();
  noticeState.entries.length = 0;
  persistLive();
  broadcast('live', noticeState.entries);
}

export function dismissForNetwork(networkId: string): void {
  for (let i = noticeState.entries.length - 1; i >= 0; i--) {
    if (noticeState.entries[i].networkId === networkId) {
      const [removed] = noticeState.entries.splice(i, 1);
      if (removed) dismissedSet.add(noticeHash(removed));
    }
  }
  persistDismissed();
  persistLive();
  broadcast('live', noticeState.entries);
}

// Test helper: clear persisted dismissed set
export function _clearDismissedForTest(): void {
  dismissedSet.clear();
  try { localStorage.removeItem(DISMISSED_KEY); } catch {}
  try { localStorage.removeItem(LIVE_KEY); } catch {}
  noticeState.entries.length = 0;
  try { broadcast('live', noticeState.entries); } catch {}
}

// Test helper: simulate storage event for cross-tab sync (used by tests)
export function _testStorageSync(key: string, newValue: string | null): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new StorageEvent('storage', { key, newValue } as StorageEventInit));
  }
}
