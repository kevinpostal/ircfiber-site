// ─────────────────────────────────────────────────────────────────────
// isupportCategorize — bucketing tests
// ─────────────────────────────────────────────────────────────────────
//
// The categorizer turns the wire-format Record<string, string> the
// engine sends into renderable `CategorizedGroup[]`. These tests
// exercise the sorting, unknown handling, stats, and (most
// importantly) the message-to-record parser that the timeline uses
// to hand the panel historical 005 lines.
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  categorizeIsupport,
  isupportStats,
  isupportFromMessages,
  splitIsupportText,
} from './isupportCategorize';
import { ISUPPORT_CATEGORIES } from './isupportCatalog';

describe('categorizeIsupport', () => {
  it('returns an empty array for an empty / null-ish input', () => {
    expect(categorizeIsupport({})).toEqual([]);
  });

  it('routes PREFIX to channel-modes and shows the catalog entry', () => {
    const groups = categorizeIsupport({ PREFIX: '(ov)@+' });
    expect(groups.length).toBe(1);
    expect(groups[0].category.id).toBe('channel-modes');
    expect(groups[0].features.length).toBe(1);
    expect(groups[0].features[0].catalog).toBeTruthy();
    expect(groups[0].features[0].catalog!.key).toBe('PREFIX');
  });

  it('preserves original key casing on wire (rawKey) but normalises for lookup (key)', () => {
    const groups = categorizeIsupport({ Prefix: '(ov)@+' });
    expect(groups[0].features[0].rawKey).toBe('Prefix');
    expect(groups[0].features[0].key).toBe('PREFIX');
  });

  it('routes bare flags (KNOCK, EXCEPTS, DEAF) as isFlag=true with empty value', () => {
    const groups = categorizeIsupport({ KNOCK: '', EXCEPTS: '', DEAF: '' });
    // Flatten and confirm all three are categorised as bare flags.
    const flat = groups.flatMap((g) => g.features);
    expect(flat.length).toBeGreaterThanOrEqual(3);
    for (const f of flat.filter((f) => ['KNOCK', 'EXCEPTS', 'DEAF'].includes(f.key))) {
      expect(f.isFlag).toBe(true);
      expect(f.value).toBe('');
    }
  });

  it('routes unknown tokens into server-specific, marks status=server', () => {
    const groups = categorizeIsupport({ DYNAMITE: '2', FUCKYOU: '99' });
    expect(groups.length).toBe(1);
    expect(groups[0].category.id).toBe('server-specific');
    const flat = groups[0].features;
    expect(flat.every((f) => f.catalog === null)).toBe(true);
    expect(flat.every((f) => f.status === 'server')).toBe(true);
  });

  it('keeps stats simple when only known tokens are present', () => {
    const groups = categorizeIsupport({
      PREFIX: '(ov)@+',
      CHANMODES: 'beI,k,l,imnpst',
      CHANTYPES: '#&',
      NICKLEN: '30',
      KICKLEN: '307',
      CASEMAPPING: 'ascii',
    });
    const stats = isupportStats(groups);
    expect(stats.total).toBe(6);
    expect(stats.known).toBe(6);
    expect(stats.serverSpecific).toBe(0);
    // Categories: channel-modes, channel-naming, user-limits, case-mapping
    expect(stats.categories).toBeGreaterThanOrEqual(4);
  });

  it('groups tokens by category, in the order the catalog declares them', () => {
    // Use tokens drawn from three different categories. The resulting
    // groups should iterate in the order from ISUPPORT_CATEGORIES —
    // server-identity, channel-naming, user-limits, … — not by
    // insertion order of the input.
    const groups = categorizeIsupport({
      KICKLEN: '307',          // user-limits
      CHANTYPES: '#&',          // channel-naming
      CASEMAPPING: 'ascii',     // case-mapping
      PREFIX: '(ov)@+',         // channel-modes
      KNOCK: '',                // capabilities
    });
    const ids = groups.map((g) => g.category.id);
    const ordered = ISUPPORT_CATEGORIES.map((c) => c.id);
    const orderInOrdered = ids.map((id) => ordered.indexOf(id));
    // Check sorted
    const sorted = [...orderInOrdered].sort((a, b) => a - b);
    expect(orderInOrdered).toEqual(sorted);
  });

  it('sorts unknown tokens alphabetically within the server-specific bucket', () => {
    const groups = categorizeIsupport({ ZEBRA: '1', ALPHA: '1', MU: '1' });
    const keys = groups[0].features.map((f) => f.key);
    expect(keys).toEqual(['ALPHA', 'MU', 'ZEBRA']);
  });
});

describe('isupportStats', () => {
  it('extracts NETWORK= for the panel header and IRCD= for the diagnostic chip', () => {
    const groups = categorizeIsupport({
      NETWORK: 'SuperNets',
      IRCD: 'charybdis-4.0.0',
      PREFIX: '(ov)@+',
    });
    const stats = isupportStats(groups);
    expect(stats.network?.value).toBe('SuperNets');
    expect(stats.ircd?.value).toBe('charybdis-4.0.0');
  });
});

describe('splitIsupportText', () => {
  it('splits normal space-separated isupport into individual tokens', () => {
    const tokens = splitIsupportText('CHANTYPES=# EXCEPTS INVEX CHANMODES=b,e,I');
    expect(tokens).toEqual(['CHANTYPES=#', 'EXCEPTS', 'INVEX', 'CHANMODES=b,e,I']);
  });

  it('handles empty input by returning an empty array', () => {
    expect(splitIsupportText('')).toEqual([]);
  });

  it('re-splits SuperNets-style concatenated (no spaces) into KEY=VALUE tokens', () => {
    const tokens = splitIsupportText('ACCOUNTEXTBAN=account,aAWAYLEN=307BOT=BCHANLIMIT=#:10CASEMAPPING=ascii');
    expect(tokens).toEqual([
      'ACCOUNTEXTBAN=account,a',
      'AWAYLEN=307',
      'BOT=B',
      'CHANLIMIT=#:10',
      'CASEMAPPING=ascii',
    ]);
  });

  it('passes through single-token or short texts unchanged', () => {
    expect(splitIsupportText('PREFIX=(ov)@+')).toEqual(['PREFIX=(ov)@+']);
    expect(splitIsupportText('KNOCK')).toEqual(['KNOCK']);
  });
});

describe('isupportFromMessages', () => {
  it('parses a single key=value into { KEY: value }', () => {
    const out = isupportFromMessages([{ text: 'AWAYLEN=390' }]);
    expect(out).toEqual({ AWAYLEN: '390' });
  });

  it('parses a bare flag (no =) into { KEY: "" }', () => {
    const out = isupportFromMessages([{ text: 'KNOCK' }]);
    expect(out).toEqual({ KNOCK: '' });
  });

  it('aggregates multiple messages into a single Record', () => {
    const out = isupportFromMessages([
      { text: 'AWAYLEN=390' },
      { text: 'BOT=B' },
      { text: 'EXCEPTS' },
      { text: 'CHANMODES=Ibe,k,fl,CEMRUimnstu' },
    ]);
    expect(out).toEqual({
      AWAYLEN: '390',
      BOT: 'B',
      EXCEPTS: '',
      CHANMODES: 'Ibe,k,fl,CEMRUimnstu',
    });
  });

  it('handles SuperNets-style concatenated text by re-splitting it', () => {
    const out = isupportFromMessages([
      { text: 'ACCOUNTEXTBAN=account,aAWAYLEN=307BOT=BCHANLIMIT=#:10CASEMAPPING=ascii' },
    ]);
    expect(out).toEqual({
      ACCOUNTEXTBAN: 'account,a',
      AWAYLEN: '307',
      BOT: 'B',
      CHANLIMIT: '#:10',
      CASEMAPPING: 'ascii',
    });
  });

  it('normalises keys to upper-case (PREFIX / prefix / Prefix collapse)', () => {
    const out = isupportFromMessages([{ text: 'prefix=(ov)@+' }]);
    expect(out).toEqual({ PREFIX: '(ov)@+' });
  });

  it('returns {} for empty input array', () => {
    expect(isupportFromMessages([])).toEqual({});
  });

  it('handles a bare flag at the end of concatenated text', () => {
    // E.g. AWAYLEN=307 followed by KNOCK with no = sign
    const out = isupportFromMessages([
      { text: 'AWAYLEN=307KNOCK' },
    ]);
    expect(out).toEqual({ AWAYLEN: '307', KNOCK: '' });
  });

  it('falls back to single-token split for unknown keys with single-letter values', () => {
    // SERVERSPECIFICKEYS=ABC → reads as a single key even when no known
    // key is in the catalog. The fallback accepts ≥2-char chain + '='.
    const out = isupportFromMessages([{ text: 'SERVERSPECIFICKEYS=ABC' }]);
    expect(out).toEqual({ SERVERSPECIFICKEYS: 'ABC' });
  });

  it('processes a realistic SuperNets dump', () => {
    // Trimmed subset of the real SuperNets concatenation pattern from
    // production (see AGENTS.md). Validates the splitter stays correct
    // when fed many tokens at once.
    const out = isupportFromMessages([
      { text: 'CHANLIMIT=#:10CHANMODES=beI,fkL,lFH,cdimnprstzCHANNELLEN=32CHANTYPES=#CASEMAPPING=ascii' },
    ]);
    expect(out).toEqual({
      CHANLIMIT: '#:10',
      CHANMODES: 'beI,fkL,lFH,cdimnprstz',
      CHANNELLEN: '32',
      CHANTYPES: '#',
      CASEMAPPING: 'ascii',
    });
  });
});
