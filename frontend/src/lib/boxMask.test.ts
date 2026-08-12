import { describe, it, expect } from 'vitest';
import {
  popcntBigint, R4_OMEGA_MASK, R4_HLINE, R4_VLINE, r4RowMask,
  R6_OMEGA_MASK, r6ArmMask, R6_DIAG,
  boxErr, boxCellCost, coverageLowerBoundHolds, errGeCoverage, pruneAdmissible,
  errAddErrCompl, minErrLeHalf, bestErr, bestErrUnionHolds,
  lineBeatsSpaceIff, errEqualCoverage, lineBeatsDitherIff, transSeam, seamStateCount
} from './boxMask';

describe('BoxMaskModel.lean mask model', () => {
  it('err / card_symmDiff / err_self / triangle', () => {
    const S=0b1010n, M=0b1100n, mask=0b1111n;
    expect(popcntBigint((S ^ M) & mask)).toBe(2);
    expect(boxErr(10,S,S,mask)).toBe(0);
    expect(boxErr(5,S,M,mask)).toBe(10);
    // triangle
    const A=0b0011n,B=0b0101n,C=0b1001n;
    const dAC=popcntBigint((A^C)&mask), dAB=popcntBigint((A^B)&mask), dBC=popcntBigint((B^C)&mask);
    expect(dAC <= dAB+dBC).toBe(true);
  });
  it('err_ge_coverage and prune_admissible (coverage lower bound)', () => {
    const S=0b11110000n, M=0b10101010n, mask=0xFFn;
    expect(coverageLowerBoundHolds(S,M,mask)).toBe(true);
    expect(errGeCoverage(10,S,M,mask)).toBe(true);
    // pruning: coverage already exceeds best → true cost does too
    const w=2.5, contrast=10, bytes=3;
    const cov=Math.abs(4-4)*contrast + w*bytes; // coverage cost
    // pick best just below coverage → prunable
    expect(pruneAdmissible(w,contrast,bytes,cov-0.1,S,M,mask)).toBe(true);
  });
  it('complement free: err+err_compl = contrast*|Ω|, min ≤ half', () => {
    const S=0b10101010n, M=0b11001100n, omega=0xFFn, contrast=7;
    expect(errAddErrCompl(contrast,S,M,omega)).toBeCloseTo(contrast*8,9);
    expect(minErrLeHalf(contrast,S,M,omega)).toBe(true);
  });
  it('bestErr_union and thin_alphabet_gap', () => {
    const A=[0n, 0b1111n], B=[0b1010n], S=0b1100n, mask=0b1111n, contrast=10;
    expect(bestErrUnionHolds(contrast,A,B,S,mask)).toBe(true);
    // thin: ρ=2 stroke, Ω=16, S=8 (hline/vline) → min 8-2=6 away
    const S16=R4_HLINE, Mthin=0n; // blank (0) ≤ρ
    const thinGap=Math.min(8,8)-0; // not directly asserting; just that bestErr≥ contrast*6 for thin
    expect(boxErr(10,S16,Mthin, R4_OMEGA_MASK) >= 60-1e-9).toBe(true); // 8*? actually 8*10=80? blank vs 8 →8*10=80
  });
  it('economics: line_beats_space and line_beats_dither', () => {
    const S=0b1111n, mask=0b1111n, w=2.5;
    expect(lineBeatsSpaceIff(w,10,S,mask)).toBe(true); // ↔ holds (both true)
    expect(lineBeatsSpaceIff(2.5,1,0b1111n,0b1111n)).toBe(true); // ↔ holds (both false) — 5≤4 false, 7.5≤6.5 false
    // dither equal coverage
    const D=0b1100n; // same card 2? need equal card test: S=0b1010 (2), D=0b0101 (2) same card, overlap 0
    const S2=0b1010n, D2=0b0101n, mask4=0b1111n;
    const inter=0; // popcnt 0
    expect(errEqualCoverage(10,S2,D2,mask4)).toBe(40);
    expect(lineBeatsDitherIff(w,10,S2,D2,mask4)).toBe(true); // ↔ holds (both true: 2.5<20, 7.5<42.5)
    expect(lineBeatsDitherIff(w,1,S2,D2,mask4)).toBe(true); // ↔ holds (both false: 2.5<2 false, 7.5<6.5 false)
    // actual economics: high contrast → line beats dither, low → not
    expect(boxCellCost(w,10,3,S2,S2,mask4) < boxCellCost(w,10,1,S2,D2,mask4)).toBe(true);
    expect(boxCellCost(w,1,3,S2,S2,mask4) < boxCellCost(w,1,1,S2,D2,mask4)).toBe(false);
  });
});

describe('BoxMaskModel concrete rasters', () => {
  it('R4 hline/vline cards 8, coverage equal, Δ=8, blind pays ≥8 avg 4', () => {
    expect(popcntBigint(R4_HLINE)).toBe(8);
    expect(popcntBigint(R4_VLINE)).toBe(8);
    // top/bottom coverage identical
    const top=(m:bigint)=> popcntBigint(m & 0b11111111n) // rough: first 8 bits are rows 0-1? Actually 4×4 row0=bits0-3 etc. top rows 0,1 = bits0-7
    // Instead check via row filter count: both have 4 in top half
    let hTop=0,vTop=0,hBot=0,vBot=0;
    for(let r=0;r<4;r++) for(let c=0;c<4;c++){ const bit=1n<<BigInt(r*4+c); const inH=(R4_HLINE&bit)!==0n, inV=(R4_VLINE&bit)!==0n; if(r<=1){hTop+=inH?1:0; vTop+=inV?1:0;} else {hBot+=inH?1:0; vBot+=inV?1:0;}}
    expect(hTop).toBe(vTop); expect(hBot).toBe(vBot);
    expect(popcntBigint((R4_HLINE ^ R4_VLINE) & R4_OMEGA_MASK)).toBe(8);
    const contrast=10;
    for(const M of [0n, R4_HLINE, R4_VLINE, R4_HLINE^R4_VLINE]){
      expect(boxErr(contrast,R4_HLINE,M,R4_OMEGA_MASK)+boxErr(contrast,R4_VLINE,M,R4_OMEGA_MASK) >= contrast*8 -1e-9).toBe(true);
    }
    // row-uniform masks are 8 away from vline
    for(let rows=0;rows<16;rows++){
      const R=new Set<number>(); for(let r=0;r<4;r++) if(rows>>r &1) R.add(r);
      expect(popcntBigint((R4_VLINE ^ r4RowMask(R)) & R4_OMEGA_MASK) >= 8).toBe(true);
    }
    expect(popcntBigint((R4_VLINE ^ R4_VLINE) & R4_OMEGA_MASK)).toBe(0);
  });
  it('R6 diag far from arms (6 ≤ Δ), blank distance 6', () => {
    expect(popcntBigint(R6_DIAG)).toBe(6);
    expect(popcntBigint((R6_DIAG ^ r6ArmMask(false,false,false,false)) & R6_OMEGA_MASK)).toBe(6);
    for(let mask=0;mask<16;mask++){
      const u=!!(mask&1), r=!!(mask&2), d=!!(mask&4), l=!!(mask&8);
      expect(popcntBigint((R6_DIAG ^ r6ArmMask(u,r,d,l)) & R6_OMEGA_MASK) >= 6).toBe(true);
    }
    expect(popcntBigint((R6_DIAG ^ R6_DIAG) & R6_OMEGA_MASK)).toBe(0);
  });
});

describe('BoxMaskModel seam DP', () => {
  it('transSeam adds seam penalty and seam_state_count =3|C|', () => {
    const col=(a:string,b:string)=> a===b?0:3;
    expect(transSeam(col, 5, {c:'a',arm:0},{c:'a',arm:0})).toBe(0);
    expect(transSeam(col, 5, {c:'a',arm:0},{c:'a',arm:1})).toBe(5);
    expect(transSeam(col, 5, {c:'a',arm:0},{c:'b',arm:0})).toBe(3);
    expect(transSeam(col, 5, {c:'a',arm:0},{c:'b',arm:1})).toBe(8);
    expect(seamStateCount(12)).toBe(36);
    expect(seamStateCount(144)).toBe(432);
  });
});
