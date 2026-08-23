import { describe, it, expect } from 'vitest';
import { blockKindRanges } from './blockKind';
describe('blockKind',()=>{
  it('half returns 4 ranges',()=>{ expect(blockKindRanges('half')).toEqual([[0x2580,0x2580],[0x2584,0x2584],[0x258C,0x258C],[0x2590,0x2590]]); });
  it('quarter returns 1',()=>{ expect(blockKindRanges('quarter')).toEqual([[0x2596,0x259F]]); });
  it('eighth returns 3',()=>{ expect(blockKindRanges('eighth').length).toBe(3); });
});
