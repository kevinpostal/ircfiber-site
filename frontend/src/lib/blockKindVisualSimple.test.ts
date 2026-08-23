import { describe, it, expect } from 'vitest';
import { blockKindRanges } from './blockKind';
import { glyphsToTable, GLYPHS } from './img2irc';

const KINDS = ['full','half','quarter','eighth','triangle','corner','geometric','box'] as const;
const REP: Record<string,string> = {
  full:'█', half:'▀', quarter:'▖', eighth:'▁', triangle:'▲', corner:'◢', geometric:'■', box:'─'
};

describe('BlockKind visual distinct', () => {
  it.each(KINDS)('kind %s has distinct glyph and table', (kind) => {
    const ranges = blockKindRanges(kind as any);
    let chars = '';
    const seen = new Set<string>();
    for(const [lo,hi] of ranges) for(let cp=lo; cp<=hi; cp++){ if(cp>=0xD800&&cp<=0xDFFF) continue; const ch=String.fromCodePoint(cp); if(!seen.has(ch)){seen.add(ch); chars+=ch;}}
    if(!chars.includes(' ')) chars=' '+chars;
    expect(chars).toContain(REP[kind]);
    const table = glyphsToTable(chars);
    expect(table.some(g=>g.ch===REP[kind])).toBe(true);
    // also ensure different kinds have different first non-space glyph
    const otherKind = KINDS.find(k=>k!==kind)!;
    const otherRanges = blockKindRanges(otherKind as any);
    let otherChars='';
    const seen2=new Set<string>();
    for(const [lo,hi] of otherRanges) for(let cp=lo; cp<=hi; cp++){ if(cp>=0xD800&&cp<=0xDFFF) continue; const ch=String.fromCodePoint(cp); if(!seen2.has(ch)){seen2.add(ch); otherChars+=ch;}}
    if(!otherChars.includes(' ')) otherChars=' '+otherChars;
    expect(chars).not.toBe(otherChars);
  });
});
