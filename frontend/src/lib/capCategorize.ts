// ─────────────────────────────────────────────────────────────────────
// CAP categorize — turn a flat CAP map into renderable buckets
// ─────────────────────────────────────────────────────────────────────
// Mirrors `isupportCategorize.ts` but for IRCv3 CAP tokens.

import {
  CAP_CATALOG,
  CAP_CATEGORIES,
  lookupCap,
  type CapCategory,
  type CapCategoryId,
  type CapEntry,
} from './capCatalog';

export interface CategorizedCap {
  rawKey: string;
  key: string;         // canonical lower-case form
  value: string;       // payload after '=', or '' for bare caps
  isFlag: boolean;
  catalog: CapEntry | null;
  status: 'core' | 'extended' | 'draft' | 'vendor' | 'ircv3' | 'server';
}

export interface CategorizedCapGroup {
  category: CapCategory;
  caps: CategorizedCap[];
}

export interface CapStats {
  total: number;
  known: number;
  serverSpecific: number;
  categories: number;
  draft: number;
  vendor: number;
  ircv3: number;
}

/** Buckets a flat CAP map into renderable category groups. */
export function categorizeCaps(
  caps: Record<string, string>,
): CategorizedCapGroup[] {
  const groups = new Map<CapCategoryId, CategorizedCap[]>();

  for (const [rawKey, rawValue] of Object.entries(caps)) {
    const key = rawKey.toLowerCase();
    const catalog = lookupCap(rawKey) ?? null;
    const isFlag = rawValue === '' || rawValue === undefined;
    const status: CategorizedCap['status'] = catalog
      ? (catalog.status as CategorizedCap['status'] ?? 'ircv3')
      : 'server';

    const categoryId: CapCategoryId = catalog ? catalog.category : 'server-specific';

    const cap: CategorizedCap = {
      rawKey,
      key,
      value: rawValue,
      isFlag,
      catalog,
      status,
    };

    const bucket = groups.get(categoryId) ?? [];
    bucket.push(cap);
    groups.set(categoryId, bucket);
  }

  const out: CategorizedCapGroup[] = [];
  for (const cat of CAP_CATEGORIES) {
    const capsInCat = groups.get(cat.id);
    if (!capsInCat || capsInCat.length === 0) continue;

    const known = capsInCat.filter((c) => c.catalog);
    const unknown = capsInCat.filter((c) => !c.catalog);
    known.sort((a, b) => {
      const ai = CAP_CATALOG.findIndex((e) => e.key.toLowerCase() === a.key);
      const bi = CAP_CATALOG.findIndex((e) => e.key.toLowerCase() === b.key);
      return ai - bi;
    });
    unknown.sort((a, b) => a.key.localeCompare(b.key));

    out.push({ category: cat, caps: [...known, ...unknown] });
  }

  return out;
}

export function capStats(groups: CategorizedCapGroup[]): CapStats {
  let total = 0;
  let known = 0;
  let serverSpecific = 0;
  let draft = 0;
  let vendor = 0;
  let ircv3 = 0;
  for (const g of groups) {
    for (const c of g.caps) {
      total += 1;
      if (c.catalog) known += 1;
      else serverSpecific += 1;
      if (c.status === 'draft') draft += 1;
      else if (c.status === 'vendor') vendor += 1;
      else if (c.status === 'ircv3') ircv3 += 1;
    }
  }
  return {
    total,
    known,
    serverSpecific,
    categories: groups.length,
    draft,
    vendor,
    ircv3,
  };
}

/** Parse CAP LS tokens from a list of notice texts / CAP LS lines.
 *  Handles both:
 *    - raw CAP LS lines: "account-notify account-tag away-notify …"
 *    - server NOTICE lines: "*** Looking up your hostname…" — ignored
 *  Returns Record<cap, value> where bare caps map to ''.
 */
export function capsFromNotices(
  texts: ReadonlyArray<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const text of texts) {
    if (!text) continue;
    // Skip server NOTICEs that start with *** or contain non-cap chatter
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (/^\*+\s/.test(trimmed)) continue;
    // Capability lines are space-separated tokens; skip lines that look like prose
    // (heuristic: single line with no spaces after '*' check is still a cap line if it contains known caps)
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    // If >60% of tokens contain spaces? not needed. Just parse every token that looks like a cap name
    let sawCapLike = false;
    for (const tok of tokens) {
      // Split key=value for the cap-like check — value may contain commas
      const eqIdx = tok.indexOf('=');
      const keyPart = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
      if (!/^[a-z0-9_.\/-]+$/i.test(keyPart)) {
        // Key contains characters not allowed in cap names — this is prose
        sawCapLike = false;
        break;
      }
      // Value part (after =) can be anything, so only validate the key
      if (!/^[a-z0-9_.\/-]+(=.+)?$/i.test(tok)) {
        sawCapLike = false;
        break;
      }
      if (keyPart.includes('/') || keyPart.includes('.')) sawCapLike = true;
      else if (keyPart.includes('-')) sawCapLike = true;
      else if (/^[a-z]+$/i.test(keyPart) && keyPart.length >= 2) sawCapLike = true;
      else if (eqIdx >= 0 && /^[a-z]+$/i.test(keyPart) && keyPart.length >= 2) sawCapLike = true;
    }
    if (!sawCapLike && tokens.length === 1 && /^[a-z-]+$/i.test(tokens[0])) {
      sawCapLike = true;
    }
    // If line looks like prose (e.g. "Found your hostname (cached)"), bail
    // Prose heuristic: contains words like "your", "Looking", "hostname" etc.
    if (!sawCapLike) continue;
    if (/^(Found|Looking|Checking|Your host is)/i.test(trimmed)) continue;

    for (const tok of tokens) {
      const eq = tok.indexOf('=');
      if (eq < 0) {
        out[tok.toLowerCase()] = '';
      } else {
        const k = tok.slice(0, eq).toLowerCase();
        const v = tok.slice(eq + 1);
        out[k] = v;
      }
    }
  }
  return out;
}

/** Convenience: extract caps from attempt notices shaped like { text }. */
export function capsFromNoticeMessages(
  messages: ReadonlyArray<{ text?: string; params?: string[] }>,
): Record<string, string> {
  const texts: string[] = [];
  for (const m of messages) {
    const t = m.text ?? (m.params ? m.params.join(' ') : '') ?? '';
    if (t) texts.push(t);
  }
  return capsFromNotices(texts);
}
