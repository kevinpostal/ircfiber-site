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
  } catch {}
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
}

export function dismissNotice(id: string): void {
  const idx = noticeState.entries.findIndex((e) => e.id === id);
  if (idx >= 0) {
    const [removed] = noticeState.entries.splice(idx, 1);
    if (removed) {
      dismissedSet.add(noticeHash(removed));
      persistDismissed();
    }
  }
}

export function dismissAll(): void {
  for (const e of noticeState.entries) dismissedSet.add(noticeHash(e));
  if (noticeState.entries.length > 0) persistDismissed();
  noticeState.entries.length = 0;
}

export function dismissForNetwork(networkId: string): void {
  for (let i = noticeState.entries.length - 1; i >= 0; i--) {
    if (noticeState.entries[i].networkId === networkId) {
      const [removed] = noticeState.entries.splice(i, 1);
      if (removed) dismissedSet.add(noticeHash(removed));
    }
  }
  persistDismissed();
}

// Test helper: clear persisted dismissed set
export function _clearDismissedForTest(): void {
  dismissedSet.clear();
  try { localStorage.removeItem(DISMISSED_KEY); } catch {}
}
