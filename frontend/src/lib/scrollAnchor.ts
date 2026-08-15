/**
 * Anchor-based scroll preservation for history loads.
 *
 * The viewport must keep the messages being read in view when older chat
 * prepends above them. Summing row heights or diffing scrollHeight is
 * unreliable (off-screen art rows report intrinsic sizes; the backlog
 * divider / date separators sit between rows), so instead we capture the
 * anchor row — the first message row visible in the container — and after
 * the prepend we shift scrollTop by the anchor's ACTUAL displacement.
 *
 * NOTE: the anchor cannot be referenced by element across the prepend —
 * the keyed {#each} keys include the absolute index, so a prepend shifts
 * every index and Svelte re-creates all row elements. The anchor is
 * therefore re-found by message id after the mutation.
 */
let pending: { msgid: string; top: number } | null = null;

export function captureScrollAnchor(container: HTMLElement | null): void {
  if (!container) {
    pending = null;
    return;
  }
  const rows = Array.from(container.querySelectorAll('.row.messageRow')) as HTMLElement[];
  const cr = container.getBoundingClientRect();
  const anchor = rows.find((r) => r.getBoundingClientRect().bottom > cr.top + 4) ?? rows[0] ?? null;
  pending = anchor ? { msgid: anchor.dataset.msgid || 't:' + anchor.dataset.time, top: anchor.getBoundingClientRect().top } : null;
}

export function takeScrollAnchor(): { msgid: string; top: number } | null {
  const a = pending;
  pending = null;
  return a;
}

export function consumeScrollAnchor(container: HTMLElement | null): number | null {
  const a = pending;
  pending = null;
  if (!a || !container) return null;
  // The index-keyed {#each} re-creates row elements on prepend, so re-find
  // the anchor by message id in the current DOM.
  const rows = Array.from(container.querySelectorAll('.row.messageRow')) as HTMLElement[];
  const match = rows.find((r) => (r.dataset.msgid || 't:' + r.dataset.time) === a.msgid);
  if (!match) return null;
  return match.getBoundingClientRect().top - a.top;
}
