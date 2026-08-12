import { describe, it, expect } from 'vitest';
import {
  BOX_TABLE, DBL_TABLE, LIGHT_HEAVY_BLOCK, DASHED_BLOCK, DOUBLE_BLOCK, ARC_BLOCK, DIAGONAL_BLOCK, BOX_DRAWING_BLOCK,
  boxCode, dblCode, armWeightsFromIdx, armIdx, arity, isAxisUniform, isDoubleRealisable,
  isBoxCodeInjective, boxCodeRangeIsInsert32LightHeavy, dblCodeDomainHolds, boxDrawingPartitionHolds, utf8Size, boxDrawingRowBytes
} from './boxArmCode';

describe('BoxArmCode.lean light/heavy perfect code', () => {
  it('boxCode_injective', () => { expect(isBoxCodeInjective()).toBe(true); });
  it('boxCode_range = insert 32 lightHeavyBlock (80+space=81)', () => {
    expect(boxCodeRangeIsInsert32LightHeavy()).toBe(true);
    expect(LIGHT_HEAVY_BLOCK.size).toBe(80);
    expect(BOX_TABLE.length).toBe(81);
    expect(new Set(BOX_TABLE).size).toBe(81);
  });
  it('boxCode_eq_space_iff and mem_block', () => {
    for(let i=0;i<81;i++){ const w=armWeightsFromIdx(i); if(arity(w)===0) expect(boxCode(w)).toBe(32); else expect(BOX_DRAWING_BLOCK.has(boxCode(w))).toBe(true); }
  });
  it('boxCode_halfArms/collinear/corners/tees/cross partition by arity', () => {
    const half=[...Array(81)].map((_,i)=>armWeightsFromIdx(i)).filter(w=>arity(w)===1).map(w=>boxCode(w));
    expect(new Set(half).size).toBe(8); // 4 directions ×2 weights
    for(const cp of half) expect(cp>=9588 && cp<=9595).toBe(true);
    const collinear=[...Array(81)].map((_,i)=>armWeightsFromIdx(i)).filter(w=>arity(w)===2 && ((w[0]&&w[2])||(w[1]&&w[3]))).map(boxCode);
    for(const cp of collinear) expect((cp>=9472&&cp<=9475)||(cp>=9596&&cp<=9599)).toBe(true);
    const corners=[...Array(81)].map((_,i)=>armWeightsFromIdx(i)).filter(w=>arity(w)===2 && !((w[0]&&w[2])||(w[1]&&w[3]))).map(boxCode);
    for(const cp of corners) expect(cp>=9484&&cp<=9499).toBe(true);
    expect(corners.length).toBe(16);
    const tees=[...Array(81)].map((_,i)=>armWeightsFromIdx(i)).filter(w=>arity(w)===3).map(boxCode);
    for(const cp of tees) expect(cp>=9500&&cp<=9531).toBe(true);
    expect(tees.length).toBe(32);
    const cross=[...Array(81)].map((_,i)=>armWeightsFromIdx(i)).filter(w=>arity(w)===4).map(boxCode);
    for(const cp of cross) expect(cp>=9532&&cp<=9547).toBe(true);
    expect(cross.length).toBe(16);
  });
});

describe('BoxArmCode.lean double family', () => {
  it('dblCode_domain: dblCode≠0 ↔ DoubleRealisable (axis-uniform, ≥2 arms, doubled)', () => {
    expect(dblCodeDomainHolds()).toBe(true);
  });
  it('dblCode_injOn and range = doubleBlock (29)', () => {
    const realisable=[...Array(81)].map((_,i)=>armWeightsFromIdx(i)).filter(isDoubleRealisable);
    expect(realisable.length).toBe(29);
    expect(DOUBLE_BLOCK.size).toBe(29);
    const img=new Set(realisable.map(dblCode));
    expect(img.size).toBe(29);
    for(const v of img) expect(DOUBLE_BLOCK.has(v)).toBe(true);
    // inj
    const seen=new Map<number,string>();
    for(const w of realisable){ const cp=dblCode(w); expect(seen.has(cp)).toBe(false); seen.set(cp, w.toString()); }
  });
  it('double missing card 51', () => {
    const missing=[...Array(81)].map((_,i)=>armWeightsFromIdx(i)).filter(w=> arity(w)>=1 && !isDoubleRealisable(w));
    expect(missing.length).toBe(51);
  });
});

describe('BoxArmCode.lean partition and bytes', () => {
  it('boxDrawing_partition and card 80+12+29+4+3=128', () => {
    expect(boxDrawingPartitionHolds()).toBe(true);
    expect(BOX_DRAWING_BLOCK.size).toBe(128);
    expect(LIGHT_HEAVY_BLOCK.size).toBe(80);
    expect(DASHED_BLOCK.size).toBe(12);
    expect(DOUBLE_BLOCK.size).toBe(29);
    expect(ARC_BLOCK.size).toBe(4);
    expect(DIAGONAL_BLOCK.size).toBe(3);
  });
  it('boxDrawing_utf8Size =3 and row bytes =3n', () => {
    for(let cp=9472; cp<=9599; cp++) expect(utf8Size(cp)).toBe(3);
    // also inside light heavy
    for(const cp of LIGHT_HEAVY_BLOCK) expect(utf8Size(cp)).toBe(3);
    for(const cp of DOUBLE_BLOCK) expect(utf8Size(cp)).toBe(3);
    // row
    expect(boxDrawingRowBytes([9472,9473,9588])).toBe(9);
    expect(boxDrawingRowBytes([32,9472])).toBe(4); // space 1 + box 3
    const chars=[...Array(10)].map((_,i)=>9472+i);
    expect(boxDrawingRowBytes(chars)).toBe(30);
  });
  it('armIdx round-trip 27*up+9*right+3*down+left', () => {
    for(let i=0;i<81;i++){ const w=armWeightsFromIdx(i); expect(armIdx(w)).toBe(i); }
  });
});
