// ─────────────────────────────────────────────────────────────────────
// ISUPPORT categorize — turn the flat isupport map into renderable buckets
// ─────────────────────────────────────────────────────────────────────
//
// `Network.isupport` (in `frontend/src/types.ts`) is a flat
// `Record<string, string>`. That shape is what the WebSocket sync emits
// and what the engine uses for lookups. But for *display* we want to:
//   · group tokens by purpose (channel-naming, user-limits, modes, …)
//   · leave a "Custom / server-specific" bucket for tokens that aren't
//     in the catalog (so weird entries like DYNAMITE=2 or HOOKS=30
//     still show up — they belong to whatever server the user is on)
//   · highlight standard vs. extension vs. server-specific entries
//     so a glance at the panel tells you "the spec says X, this server
//     also does Y".
//
// The categorize function is pure: it doesn't mutate input, doesn't
// depend on UI state, and is safe to memoize at the Svelte layer.
// ─────────────────────────────────────────────────────────────────────

import {
  ISUPPORT_CATALOG,
  ISUPPORT_CATEGORIES,
  lookupIsupport,
  type IsupportCategory,
  type IsupportCategoryId,
  type IsupportEntry,
} from './isupportCatalog';

export interface CategorizedFeature {
  /** Original case as the server sent it (e.g. "PREFIX" / "casemapping") */
  rawKey: string;
  /** Canonical key (uppercase) used for catalog lookup */
  key: string;
  /** Wire-format value, or empty string for bare flags */
  value: string;
  /** True when the server sent the bare key with no =value */
  isFlag: boolean;
  /** Catalog entry if we know what the token means */
  catalog: IsupportEntry | null;
  /** Banner stamp: core / extended / draft / legacy / ircv3 / server-specific. */
  status: 'core' | 'extended' | 'draft' | 'legacy' | 'ircv3' | 'server';
}

export interface CategorizedGroup {
  category: IsupportCategory;
  features: CategorizedFeature[];
}

export interface CategorizedOptions {
  /** Maximum features per group before the group is collapsed by default.
   *  0 = no auto-collapse. */
  collapseThreshold?: number;
}

/** Buckets a flat ISUPPORT map into renderable category groups.
 *
 *  Pure function: same input → same output.  Sort order is stable:
 *  catalog tokens are sorted by their catalog position (which roughly
 *  follows importance — PREFIX before USERLEN, etc.); unknown tokens
 *  are sorted alphabetically by upper-cased key so the list is
 *  deterministic for snapshot tests.
 *
 *  Options are reserved for future use (e.g. auto-collapsing categories
 *  above a feature-count threshold); the field is consumed so callers
 *  can already pass through.
 */
export function categorizeIsupport(
  isupport: Record<string, string>,
  _opts: CategorizedOptions = {},
): CategorizedGroup[] {
  const groups = new Map<IsupportCategoryId, CategorizedFeature[]>();

  // Build a quick lookup index from "display key" (the case sent on the
  // wire) to catalog entry. We use the canonical upper-case form for
  // matching so "PREFIX", "prefix", and "Prefix" all resolve.
  const entries = Object.entries(isupport);
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.toUpperCase();
    const catalog = lookupIsupport(key) ?? null;
    // A bare flag = key sent with no `=value` (e.g. "KNOCK" alone).
    // If the server sent "KEY=" with an empty value we still treat it
    // as a flag — the wire format collapses the trailing signaller.
    const isFlag = rawValue === '' || rawValue === undefined;
    // Catalog hits take the catalog's status (core/extended/.../ircv3).
    // Anything not in the catalog is a "server-specific" extension by
    // definition: it can only come from this IRCd's vendor-specific code.
    const status: CategorizedFeature['status'] = catalog
      ? (catalog.status ?? 'extended')
      : 'server';

    const categoryId: IsupportCategoryId = catalog
      ? catalog.category
      : 'server-specific';

    const feature: CategorizedFeature = {
      rawKey,
      key,
      value: rawValue,
      isFlag,
      catalog,
      status,
    };

    const bucket = groups.get(categoryId) ?? [];
    bucket.push(feature);
    groups.set(categoryId, bucket);
  }

  // Order: build a list matching the ISUPPORT_CATEGORIES declaration so
  // the UI renders in the same order the catalog was hand-curated (more
  // important categories first — Identity & Channels before IRCv3).
  const out: CategorizedGroup[] = [];
  for (const cat of ISUPPORT_CATEGORIES) {
    const features = groups.get(cat.id);
    if (!features || features.length === 0) continue;

    // Catalog hits first (sorted by their catalog order), unknown keys last.
    const known = features.filter((f) => f.catalog);
    const unknown = features.filter((f) => !f.catalog);
    known.sort((a, b) => {
      const ai = ISUPPORT_CATALOG.findIndex((e) => e.key === a.key);
      const bi = ISUPPORT_CATALOG.findIndex((e) => e.key === b.key);
      return ai - bi;
    });
    unknown.sort((a, b) => a.key.localeCompare(b.key));

    out.push({ category: cat, features: [...known, ...unknown] });
  }

  return out;
}

/** Compact stats used in panel headers ("48 features across 7
 *  categories" etc.). Pairs naturally with `categorizeIsupport`. */
export interface IsupportStats {
  total: number;
  known: number;
  serverSpecific: number;
  categories: number;
  core: number;
  ircv3: number;
  legacy: number;
  /** NETWORK=<value>, when present — gives the panel header a name */
  network?: CategorizedFeature | null;
  /** IRCD=<product>:<version> — diagnostic, when the server published one */
  ircd?: CategorizedFeature | null;
}

export function isupportStats(groups: CategorizedGroup[]): IsupportStats {
  let total = 0;
  let known = 0;
  let serverSpecific = 0;
  let core = 0;
  let ircv3 = 0;
  let legacy = 0;
  let ircd: CategorizedFeature | null = null;
  let network: CategorizedFeature | null = null;
  for (const g of groups) {
    for (const f of g.features) {
      total += 1;
      if (f.catalog) known += 1;
      else serverSpecific += 1;
      if (f.status === 'core') core += 1;
      else if (f.status === 'ircv3') ircv3 += 1;
      else if (f.status === 'legacy') legacy += 1;
      if (f.key === 'IRCD') ircd = f;
      else if (f.key === 'NETWORK') network = f;
    }
  }
  return {
    total,
    known,
    serverSpecific,
    categories: groups.length,
    core,
    ircv3,
    legacy,
    ircd,
    network,
  };
}

/** Parse an array of raw 005 messages into the wire-format
 *  `Record<string, string>` consumed by `categorizeIsupport`.
 *
 *  Each message's text is split using the same splitter the
 *  server-log timeline uses (handles the concatenated-no-spaces
 *  case SuperNets / UnrealIRCd emit).  Each token becomes one
 *  entry: "AWAYLEN=307" → { AWAYLEN: "307" }, "KNOCK" → { KNOCK: "" }.
 *
 *  The function is pure: pass the messages, get the map.
 */
export function isupportFromMessages(
  messages: ReadonlyArray<{ text?: string; params?: string[] }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of messages) {
    const text = (
      m.text
      ?? (m.params ? m.params.join(' ') : '')
      ?? ''
    );
    // Reuse the splitter from ServerLogTimeline — duplicated here so
    // the lib layer doesn't pull in UI-only code. Same regex contract.
    const tokens = splitIsupportText(text);
    for (const tok of tokens) {
      const eq = tok.indexOf('=');
      if (eq < 0) {
        out[tok.toUpperCase()] = '';
      } else {
        const key = tok.slice(0, eq).toUpperCase();
        const value = tok.slice(eq + 1);
        // Last write wins. Modern IRC servers (including ours) deduplicate
        // and emit each token exactly once across 005 lines, so collisions
        // only happen when a token genuinely changed mid-connection —
        // which would be a server-side bug, but we still prefer the
        // most-recent value.
        out[key] = value;
      }
    }
  }
  return out;
}

/** Split a (possibly concatenated) ISUPPORT text blob into
 *  `[KEY=VALUE]` / `[KEY]` tokens.
 *
 *  Modern IRC servers send one token per trailing parameter:
 *    ":host 005 nick CHANTYPES=# EXCEPTS INVEX :are supported…"
 *  Some IRCds (e.g. SuperNets) concatenate every token into one
 *  long trailing with no separator. We detect the concatenated
 *  case via the pattern "more than one KEY= pair inside the same
 *  no-space string" and re-split on uppercase-token boundaries.
 *
 *  Detection rule: if the text has no whitespace AND its
 *  uppercase-key pattern matches more than once, it is concatenated.
 *  That avoids false positives on short single-token entries like
 *  "PREFIX=(qaohv)~&@%+" or "DEAF=d" (length doesn't matter).
 *
 *  Concatenated splitting uses a regex with a `(?= ...)` lookahead
 *  that consumes the value forward until the next KEY= starts.  This
 *  correctly handles values that start with a single uppercase
 *  letter (e.g. "BOT=B" → key="BOT", value="B" — the "B" alone
 *  isn't a 2-char KEY start, so it's captured into the value
 *  rather than treating it as the next KEY).
 *
 *  Duplicated from `ServerLogTimeline.svelte` so this lib is
 *  independent of UI code. The contract is identical.
 */
export function splitIsupportText(text: string): string[] {
  if (!text) return [];
  if (text.includes(' ')) {
    return text.split(/\s+/).filter(Boolean);
  }
  // Concatenated case — walk through KEY=VALUE pairs linearly. The
  // catalog-aware splitter handles single-token entries correctly too
  // (e.g. "PREFIX=(qaohv)~&@%+" emits exactly one token) so we don't
  // need a heuristic to bail out early.
  //
  // Why a known-keys set: a value of "BOT=B" is genuinely ambiguous
  // between "(BOT,B)" and "(BOT=, B=…)." Most IRCds don't publish a
  // single-letter KEY called just "B", but they DO publish "CHANLIMIT".
  // So when we find an uppercase run like "BCHANLIMIT=" we read the
  // known-key SUFFIX (CHANLIMIT) and the leading "B" stays as the
  // previous key's value.
  //
  // Algorithm:
  //   1. Find the start of the next KEY (≥2-char chain, possibly with
  //      a known-key offset inside it).
  //   2. Read the KEY — longest known-key match preferred, otherwise the
  //      full chain.
  //   3. If the KEY is followed by `=`, find where its value ends by
  //      looking for the next KEY start. Anything between is the value.
  //   4. Emit "KEY=value" (or just "KEY" for bare flags).
  const knownKeys = new Set<string>(ISUPPORT_CATALOG.map((e) => e.key));
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = readKeyStart(text, cursor, knownKeys);
    if (start < 0) break;
    cursor = start;

    // Read the KEY at cursor. Either a known key, or a ≥2-char chain.
    const knownLen = tryReadKnownKey(text, cursor, knownKeys);
    let keyLen: number;
    if (knownLen > 0) {
      keyLen = knownLen;
    } else {
      let chainEnd = cursor + 1;
      while (chainEnd < text.length && isAsciiUpperOrDigit(text[chainEnd])) {
        chainEnd += 1;
      }
      keyLen = chainEnd - cursor;
      if (keyLen < 2) {
        // Read past single uppercase value chars and try again.
        cursor += 1;
        continue;
      }
    }
    const key = text.substr(cursor, keyLen);
    cursor += keyLen;

    if (cursor < text.length && text[cursor] === '=') {
      cursor += 1; // consume '='
      // Find where the value ends (= the next KEY start).
      const valueEnd = readKeyStart(text, cursor, knownKeys);
      const endIdx = valueEnd < 0 ? text.length : valueEnd;
      const value = text.slice(cursor, endIdx);
      tokens.push(key + '=' + value);
      cursor = endIdx;
    } else {
      tokens.push(key);
    }
  }
  return tokens;
}

/** Find the index where the next KEY starts. Returns -1 if none.
 *
 *  A KEY starts at an uppercase letter. The candidate KEY is the
 *  longest match in the catalog starting at that position; if none,
 *  we look for known-key suffixes inside the chain (so "BCHANLIMIT"
 *  picks "CHANLIMIT" at offset 1, leaving "B" as the previous value).
 *
 *  Returns the offset of the (effective) KEY start, or -1 if no KEY
 *  is found before end-of-string.
 */
function readKeyStart(
  text: string,
  from: number,
  knownKeys: Set<string>,
): number {
  let i = from;
  while (i < text.length) {
    // Skip non-alphanumeric (value separators, digit-only value
    // characters, punctuation). Note: lowercase letters are also
    // skipped past value content, but we ALSO accept them as part
    // of a key chain below so a server that sends "prefix=…" still
    // gets recognized via the catalog match.
    while (i < text.length && (text[i] < '0' || (text[i] > '9' && text[i] < 'A') || (text[i] > 'Z' && text[i] < 'a') || text[i] > 'z')) {
      i += 1;
    }
    if (i >= text.length) return -1;
    // First try a known KEY match at exactly position i.
    const directLen = tryReadKnownKey(text, i, knownKeys);
    if (directLen > 0) return i;

    // Walk the [A-Z][A-Za-z0-9]* chain at i. The first char must be
    // uppercase per RFC 2812 ISUPPORT convention; if it's lowercase
    // we treat it as value text and advance one char.
    if (isAsciiLower(text[i])) {
      // Single lowercase char that's not part of any known key —
      // treat as value text and advance one char.
      i += 1;
      continue;
    }
    // First char is uppercase. Walk the chain including subsequent
    // upper/lowercase/digit chars.
    let chainEnd = i + 1;
    while (chainEnd < text.length && isAsciiAlnum(text[chainEnd])) {
      chainEnd += 1;
    }
    const chainLen = chainEnd - i;

    // Try known-key matches starting at offsets within the chain. The
    // leading unmatched characters (from i up to the matching offset)
    // are value text (e.g. a single-letter value).
    for (let offset = i + 1; offset + 1 < chainEnd; offset += 1) {
      // Skip past lowercase prefix chars that don't form a KEY
      // boundary themselves.
      if (isAsciiLower(text[offset])) continue;
      const suffixLen = tryReadKnownKey(text, offset, knownKeys);
      if (suffixLen > 0) {
        return offset;
      }
    }

    // No known key matches anywhere in the chain. If the chain is ≥2
    // chars followed by '=' (which signals "this is a real KEY=VALUE"),
    // return its start so the caller treats it as an unknown KEY.
    // Otherwise keep scanning forward (skipping the chain) — there
    // may be more keys later in the string.
    if (chainLen >= 2 && text[chainEnd] === '=') {
      return i;
    }
    i = chainEnd;
  }
  return -1;
}

/** Try the longest known-key match starting at `start`. Returns
 *  the match length when found and verified to be at a real KEY
 *  boundary (followed by `=` or end-of-string), else 0.
 *
 *  ISUPPORT keys are case-insensitive per RFC 2812 (the server may
 *  send "prefix=…" and we still recognise it). All candidates are
 *  uppercased for comparison against the catalog.
 *
 *  Walk lengths longest-to-shortest. We skip over any candidate whose
 *  last char isn't `[A-Za-z0-9]` (i.e. starts to include `=` or `:`)
 *  — those can't be the whole KEY. We CONTINUE rather than break
 *  so shorter valid candidates still get a chance (e.g. "BOT=B…"
 *  yields no match for len=4, but len=3 "BOT" is the real key).
 */
function tryReadKnownKey(
  text: string,
  start: number,
  knownKeys: Set<string>,
): number {
  const maxLen = Math.min(20, text.length - start);
  for (let len = maxLen; len >= 2; len -= 1) {
    if (!isAsciiAlnum(text[start + len - 1])) continue;
    const candidate = text.substr(start, len).toUpperCase();
    if (knownKeys.has(candidate)) {
      const after = start + len;
      if (after === text.length || text[after] === '=') {
        return len;
      }
    }
  }
  return 0;
}

function isAsciiUpper(c: string): boolean {
  return c >= 'A' && c <= 'Z';
}
function isAsciiLower(c: string): boolean {
  return c >= 'a' && c <= 'z';
}
function isAsciiUpperOrDigit(c: string): boolean {
  return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}
function isAsciiAlnum(c: string): boolean {
  return (
    (c >= 'A' && c <= 'Z') ||
    (c >= 'a' && c <= 'z') ||
    (c >= '0' && c <= '9')
  );
}
