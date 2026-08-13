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

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function addNotice(entry: Omit<NoticeEntry, 'id'>): void {
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
  if (idx >= 0) noticeState.entries.splice(idx, 1);
}

export function dismissAll(): void {
  noticeState.entries.length = 0;
}

export function dismissForNetwork(networkId: string): void {
  for (let i = noticeState.entries.length - 1; i >= 0; i--) {
    if (noticeState.entries[i].networkId === networkId) {
      noticeState.entries.splice(i, 1);
    }
  }
}
