import type { ColorMatching } from './img2irc';

export type GlyphEntry = { ch: string; ct: number; cb: number; bytes: number; mask?: bigint };

// mirror of internal GLYPHS table — exported for reuse
export const GLYPH_TABLE: GlyphEntry[] = [
  { ch: ' ', ct: 0.0, cb: 0.0, bytes: 1, mask: 0x0000000000000000n },
  { ch: '=', ct: 0.122, cb: 0.120, bytes: 1 },
  { ch: 'Q', ct: 0.247, cb: 0.261, bytes: 1 },
  { ch: 'B', ct: 0.294, cb: 0.253, bytes: 1 },
  { ch: '*', ct: 0.183, cb: 0.010, bytes: 1 },
  { ch: 'g', ct: 0.149, cb: 0.321, bytes: 1 },
  { ch: 'F', ct: 0.245, cb: 0.107, bytes: 1 },
  { ch: '▀', ct: 1.0, cb: 0.0, bytes: 3, mask: 0x00000000ffffffffn },
  { ch: '▄', ct: 0.0, cb: 1.0, bytes: 3, mask: 0xffffffff00000000n },
  { ch: '▒', ct: 0.490, cb: 0.499, bytes: 3 },
  { ch: '░', ct: 0.183, cb: 0.181, bytes: 3 },
  { ch: '▓', ct: 0.796, cb: 0.816, bytes: 3 },
  { ch: '█', ct: 1.0, cb: 1.0, bytes: 3, mask: 0xffffffffffffffffn },
  { ch: '▌', ct: 0.5, cb: 0.5, bytes: 3, mask: 0x0f0f0f0f0f0f0f0fn },
  { ch: '▐', ct: 0.5, cb: 0.5, bytes: 3, mask: 0xf0f0f0f0f0f0f0f0n },
  { ch: '◤', ct: 0.8125, cb: 0.3125, bytes: 3, mask: 0x0103070f1f3f7fffn },
  { ch: '◢', ct: 0.1875, cb: 0.6875, bytes: 3, mask: 0xfefcf8f0e0c08000n },
  { ch: '◥', ct: 0.8125, cb: 0.3125, bytes: 3, mask: 0x80c0e0f0f8fcfeffn },
  { ch: '◣', ct: 0.1875, cb: 0.6875, bytes: 3, mask: 0x7f3f1f0f07030100n },
];

const glyphMap = new Map<string, GlyphEntry>();
for (const g of GLYPH_TABLE) glyphMap.set(g.ch, g);

const cache = new Map<string, GlyphEntry[]>();

export function glyphsToTable(chars: string, fallback: GlyphEntry[] = GLYPH_TABLE): GlyphEntry[] {
  if (!chars) return fallback;
  const key = chars;
  const hit = cache.get(key);
  if (hit) return hit;
  const out: GlyphEntry[] = [];
  const seen = new Set<string>();
  // always include space for empty cells
  if (!seen.has(' ')) { const sp = glyphMap.get(' '); if (sp) { out.push(sp); seen.add(' '); } }
  for (const ch of chars) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    const known = glyphMap.get(ch);
    if (known) out.push(known);
    else {
      // unknown char — synthesize placeholder with neutral coverage
      // estimate 0.5 coverage with 1 byte would be too optimistic; use 1 byte at 0/1 edge to avoid dominating
      out.push({ ch, ct: 0, cb: 1, bytes: 1 });
    }
  }
  // ensure at least fallback size
  if (out.length === 1) {
    // only space — return fallback
    cache.set(key, fallback);
    return fallback;
  }
  if (cache.size >= 8) {
    const first = cache.keys().next().value as string;
    cache.delete(first);
  }
  cache.set(key, out);
  return out;
}

export function getFilteredGlyphs(opts: { glyphAlphabet?: string; glyphGroups?: string[]; glyphInclude?: string; glyphExclude?: string; glyphIncludeRanges?: string[]; glyphExcludeRanges?: string[] }, catalogChars?: string): GlyphEntry[] | null {
  const alpha = opts.glyphAlphabet;
  if (alpha != null) return glyphsToTable(alpha);
  if (catalogChars != null) {
    let chars = catalogChars;
    // apply include/exclude and ranges if present
    if (opts.glyphInclude || opts.glyphExclude) {
      const inc = opts.glyphInclude ?? '';
      const exc = opts.glyphExclude ?? '';
      const incSet = inc ? new Set([...inc]) : null;
      const excSet = exc ? new Set([...exc]) : null;
      let filtered = '';
      for (const ch of chars) {
        if (incSet && !incSet.has(ch)) continue;
        if (excSet && excSet.has(ch)) continue;
        filtered += ch;
      }
      if (incSet && filtered.length === 0) filtered = inc; // if catalog filtered to empty, use include directly
      chars = filtered;
    }
    if (opts.glyphIncludeRanges?.length || opts.glyphExcludeRanges?.length) {
      try {
        const incR = opts.glyphIncludeRanges ?? [];
        const excR = opts.glyphExcludeRanges ?? [];
        // parse hex ranges
        const parse = (txt: string) => {
          const m = txt.match(/^([0-9a-f]{1,6})-([0-9a-f]{1,6})$/i);
          if (!m) throw new Error(`Invalid Unicode range "${txt}"; use hexadecimal START-END`);
          const s = parseInt(m[1], 16), e = parseInt(m[2], 16);
          if (s > e) throw new Error(`Invalid Unicode range "${txt}"; use hexadecimal START-END`);
          return [s, e] as [number, number];
        };
        const incRanges = incR.map(parse);
        const excRanges = excR.map(parse);
        let out = '';
        for (const ch of chars) {
          const cp = ch.codePointAt(0)!;
          if (incRanges.length) {
            let ok = false;
            for (const [s, e] of incRanges) if (cp >= s && cp <= e) { ok = true; break; }
            if (!ok) continue;
          }
          if (excRanges.length) {
            let bad = false;
            for (const [s, e] of excRanges) if (cp >= s && cp <= e) { bad = true; break; }
            if (bad) continue;
          }
          out += ch;
        }
        chars = out;
      } catch (e) {
        throw e;
      }
    }
    if (!chars) return null;
    return glyphsToTable(chars);
  }
  if (opts.glyphGroups?.length) return null; // caller should resolve via catalog
  return null;
}
