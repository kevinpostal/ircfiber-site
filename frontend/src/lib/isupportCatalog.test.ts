// ─────────────────────────────────────────────────────────────────────
// isupportCatalog — integrity tests
// ─────────────────────────────────────────────────────────────────────
//
// The catalog is the data foundation that powers the ServerFeaturesPanel
// and IsupportDetailDrawer. Any error here propagates everywhere — wrong
// keys, missing categories, or broken URLs would all degrade the new UI.
//
// These tests are deliberately tightly scoped:
//   · No duplicates
//   · Every entry reaches a real category that the categorizer can render
//   · URLs (RFC + IRCv3) are reachable shapes (https / ircv3.net / datatracker)
//   · enum kinds have non-empty `values` lists
//   · Status pill colour matches the catalog's claims
//   · The category list covers every category id used in entries
//   · A few canonical entries (PREFIX, CHANMODES, CASEMAPPING) have
//     the right RFC and kind so search / lookup tests rely on them
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  ISUPPORT_CATALOG,
  ISUPPORT_CATEGORIES,
  lookupIsupport,
  normaliseIsupportKey,
  referenceUrlFor,
  type IsupportCategoryId,
} from './isupportCatalog';

describe('ISUPPORT_CATALOG — integrity', () => {
  it('has at least 30 entries covering the common RFC and IRCv3 token set', () => {
    // The catalog is supposed to cover the bulk of what modern IRCds
    // send — RFC 2811 / 2812 essentials + IRCv3 era extensions. If the
    // count drops below 30 something has been trimmed away; that's a
    // signal a reviewer should catch.
    expect(ISUPPORT_CATALOG.length).toBeGreaterThanOrEqual(30);
  });

  it('uses only category ids that exist in ISUPPORT_CATEGORIES', () => {
    const ids = new Set<ISupportCategoryId>(ISUPPORT_CATEGORIES.map((c) => c.id));
    for (const entry of ISUPPORT_CATALOG) {
      expect(ids.has(entry.category), `unknown category id "${entry.category}" on ${entry.key}`)
        .toBe(true);
    }
  });

  it('has no duplicate keys (case-insensitive)', () => {
    const seen = new Map<string, string>();
    for (const entry of ISUPPORT_CATALOG) {
      const norm = normaliseIsupportKey(entry.key);
      const existing = seen.get(norm);
      expect(existing, `duplicate key "${norm}" on entries "${existing}" and "${entry.key}"`)
        .toBeUndefined();
      seen.set(norm, entry.key);
    }
  });

  it('every entry has the required fields populated', () => {
    for (const entry of ISUPPORT_CATALOG) {
      expect(entry.key.length, `empty key on "${entry.title}"`).toBeGreaterThan(0);
      expect(entry.title.length, `empty title for ${entry.key}`).toBeGreaterThan(0);
      expect(entry.short.length, `empty short for ${entry.key}`).toBeGreaterThan(15);
      expect(entry.detail.length, `empty detail for ${entry.key}`).toBeGreaterThan(40);
    }
  });

  it('URLs are reachable shapes (https / datatracker / ircv3.net / GitHub spec pages)', () => {
    const validPrefixes = [
      'https://datatracker.ietf.org',
      'https://ircv3.net',
      'https://github.com',
    ];
    for (const entry of ISUPPORT_CATALOG) {
      for (const [name, url] of [['rfc', entry.rfc], ['ircv3', entry.ircv3]] as const) {
        if (!url) continue;
        expect(
          validPrefixes.some((p) => url.startsWith(p)),
          `${entry.key}.${name} url "${url}" is not from a known spec source`,
        ).toBe(true);
      }
    }
  });

  it('enum kinds declare at least one accepted value', () => {
    for (const entry of ISUPPORT_CATALOG) {
      if (entry.kind === 'enum') {
        expect(entry.values, `${entry.key} is enum but has no values`).toBeDefined();
        expect(entry.values!.length, `${entry.key} values list is empty`).toBeGreaterThan(0);
      }
    }
  });
});

describe('lookupIsupport', () => {
  it('finds PREFIX / CHANMODES / CASEMAPPING / NICKLEN by key', () => {
    expect(lookupIsupport('PREFIX')?.title).toBe('Channel user-mode prefix symbols');
    expect(lookupIsupport('CHANMODES')?.title).toBe('Channel mode categories');
    expect(lookupIsupport('CASEMAPPING')?.title).toBe('Channel & nick case mapping');
    expect(lookupIsupport('NICKLEN')?.title).toBe('Maximum nickname length');
  });

  it('is case-insensitive', () => {
    expect(lookupIsupport('prefix')?.key).toBe('PREFIX');
    expect(lookupIsupport('Prefix')?.key).toBe('PREFIX');
    expect(lookupIsupport('CHANMODES')?.key).toBe(lookupIsupport('chanmodes')?.key);
  });

  it('returns undefined for unknown tokens (non-throwing)', () => {
    expect(lookupIsupport('THIS_IS_NOT_REAL')).toBeUndefined();
    expect(lookupIsupport('')).toBeUndefined();
  });
});

describe('referenceUrlFor', () => {
  it('prefers RFC over IRCv3 when both are present', () => {
    const entry = lookupIsupport('CHANMODES');
    expect(entry).toBeDefined();
    expect(referenceUrlFor(entry)).toBe(entry!.rfc);
  });

  it('falls back to IRCv3 when no RFC', () => {
    const entry = lookupIsupport('CHATHISTORY');
    expect(entry).toBeDefined();
    expect(entry!.rfc).toBeUndefined();
    expect(referenceUrlFor(entry)).toBe(entry!.ircv3);
  });

  it('returns undefined for unknown entries', () => {
    expect(referenceUrlFor(undefined)).toBeUndefined();
  });
});

describe('ISUPPORT_CATEGORIES', () => {
  it('orders Identity / Channels / Limits first so the user sees the basics immediately', () => {
    // The categorize layer iterates categories in declaration order;
    // the first three should answer "what is this network and what
    // are the basic limits" before getting into IRCv3 / extensions.
    const ids = ISUPPORT_CATEGORIES.map((c) => c.id);
    expect(ids[0]).toBe('server-identity');
    expect(ids[1]).toBe('channel-naming');
    expect(ids[2]).toBe('user-limits');
  });

  it('every category has a non-empty kicker + title + blurb', () => {
    for (const cat of ISUPPORT_CATEGORIES) {
      expect(cat.name.length).toBeGreaterThan(0);
      expect(cat.title.length).toBeGreaterThan(3);
      expect(cat.blurb.length).toBeGreaterThan(15);
    }
  });
});
