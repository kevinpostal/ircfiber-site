export type GlyphGroup = { name: string; characters: string; count: number };

const ORDER: Record<string, number> = { default: 0, smooth: 1, all: 2 };

export class GlyphCatalog {
  groups: GlyphGroup[] = [];
  private byName = new Map<string, GlyphGroup>();

  async load(url: string | URL): Promise<GlyphGroup[]> {
    const res = await fetch(String(url));
    if (!res.ok) throw new Error(`glyphs.json ${res.status}`);
    const j = await res.json() as { version: number; groups: Array<{ name: string; codepoints: number[] }> };
    if (j.version !== 1) throw new Error(`glyphs.json version ${j.version} unsupported`);
    const out: GlyphGroup[] = [];
    for (const g of j.groups) {
      const chars = codepointsToString(g.codepoints);
      const gg: GlyphGroup = { name: g.name, characters: chars, count: chars.length };
      out.push(gg);
      this.byName.set(g.name, gg);
    }
    out.sort((a, b) => {
      const oa = ORDER[a.name] ?? 99;
      const ob = ORDER[b.name] ?? 99;
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name);
    });
    // keep sorted also in map order not needed
    this.groups = out;
    return out;
  }

  characters(names: string[]): string {
    const seen = new Set<string>();
    let s = '';
    for (const n of names) {
      const g = this.byName.get(n);
      if (!g) continue;
      for (const ch of g.characters) {
        if (!seen.has(ch)) { seen.add(ch); s += ch; }
      }
    }
    return s;
  }

  get(name: string): GlyphGroup | undefined { return this.byName.get(name); }
}

function codepointsToString(cps: number[]): string {
  const filtered: string[] = [];
  const seen = new Set<number>();
  for (const cp of cps) {
    if (cp < 0 || cp > 0x10ffff) continue;
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (seen.has(cp)) continue;
    seen.add(cp);
    try { filtered.push(String.fromCodePoint(cp)); } catch {}
  }
  return filtered.join('');
}

export function parseRanges(text: string): { ranges: Array<[number, number]>; error?: string } {
  const ranges: Array<[number, number]> = [];
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (!/^[0-9a-f]{1,6}-[0-9a-f]{1,6}$/i.test(line)) {
      return { ranges: [], error: `Invalid Unicode range "${line}"; use hexadecimal START-END` };
    }
    const [a, b] = line.split('-');
    const s = parseInt(a, 16);
    const e = parseInt(b, 16);
    if (s > e) return { ranges: [], error: `Invalid Unicode range "${line}"; use hexadecimal START-END` };
    ranges.push([s, e]);
  }
  return { ranges };
}

export function applyRanges(chars: string, includeRanges: string[], excludeRanges: string[]): string {
  if (!includeRanges.length && !excludeRanges.length) return chars;
  let inc: Array<[number, number]> | null = null;
  let exc: Array<[number, number]> | null = null;
  if (includeRanges.length) {
    const r = parseRanges(includeRanges.join('\n'));
    if (r.error) throw new Error(r.error);
    inc = r.ranges;
  }
  if (excludeRanges.length) {
    const r = parseRanges(excludeRanges.join('\n'));
    if (r.error) throw new Error(r.error);
    exc = r.ranges;
  }
  let out = '';
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;
    if (inc) {
      let ok = false;
      for (const [s, e] of inc) if (cp >= s && cp <= e) { ok = true; break; }
      if (!ok) continue;
    }
    if (exc) {
      let bad = false;
      for (const [s, e] of exc) if (cp >= s && cp <= e) { bad = true; break; }
      if (bad) continue;
    }
    out += ch;
  }
  return out;
}

export function filterChars(chars: string, include: string, exclude: string): string {
  if (!include && !exclude) return chars;
  const incSet = include ? new Set([...include]) : null;
  const excSet = exclude ? new Set([...exclude]) : null;
  let out = '';
  for (const ch of chars) {
    if (incSet && !incSet.has(ch)) continue;
    if (excSet && excSet.has(ch)) continue;
    out += ch;
  }
  // if include specified, only those chars; if chars empty and include provided, use include intersection
  if (incSet && chars.length === 0) return '';
  return out;
}
