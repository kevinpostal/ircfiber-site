/**
 * BoxMaskModel.lean — mask error model for subpixel glyphs
 *
 * Ω = finite set of subpixels. Glyph = mask M ⊆ Ω, target = S ⊆ Ω.
 *   err contrast S M = contrast * |S Δ M|
 *   cellCost w contrast bytes S M = err + w·bytes
 *
 * Lean theorems mirrored here as executable helpers:
 *  - err_ge_coverage / prune_admissible (coverage lower bound)
 *  - err_add_err_compl / min_err_le_half (complement free)
 *  - bestErr / bestErr_union / thin_alphabet_gap
 *  - line_beats_space_iff / err_equal_coverage / line_beats_dither_iff
 *  - coverage_blind_pays / vline_row_uniform_gap / diag_far_from_arms
 *  - transSeam / seam_state_count (3×)
 *
 * Masks are bigint bitsets where bit i = subpixel i (0 ≤ i < card Ω).
 * Card Ω is implicit in context (16 for R4, 36 for R6, 64 for 8×8).
 */

export function popcntBigint(m: bigint): number {
  let c=0; let x=m;
  while(x){ c+= Number(x & 1n); x >>= 1n; }
  return c;
}
export function cardOmega(n:number): number { return n; }

/** Lean BoxMask.err contrast S M = contrast * |(S Δ M).card| */
export function boxErr(contrast:number, S: bigint, M: bigint, omegaMask: bigint): number {
  // omegaMask restricts to Ω bits (for complement)
  const diff = (S ^ M) & omegaMask;
  return contrast * popcntBigint(diff);
}
export function boxCard(S: bigint, omegaMask: bigint): number { return popcntBigint(S & omegaMask); }

/** Lean BoxMask.cellCost w contrast bytes S M */
export function boxCellCost(w:number, contrast:number, bytes:number, S:bigint, M:bigint, omegaMask: bigint): number {
  return boxErr(contrast, S, M, omegaMask) + w * bytes;
}

/** Lean card_sub_le_symmDiff: |(S.card - M.card)| ≤ |S Δ M| */
export function coverageLowerBoundHolds(S: bigint, M: bigint, omegaMask: bigint): boolean {
  const sc=boxCard(S, omegaMask), mc=boxCard(M, omegaMask);
  const diffCard=popcntBigint((S ^ M) & omegaMask);
  return Math.abs(sc - mc) <= diffCard + 1e-9;
}
/** Lean err_ge_coverage: contrast*|Δcard| ≤ err */
export function errGeCoverage(contrast:number, S:bigint, M:bigint, omegaMask: bigint): boolean {
  if (contrast < 0) return false;
  const cov=Math.abs(boxCard(S,omegaMask)-boxCard(M,omegaMask));
  return contrast*cov <= boxErr(contrast,S,M,omegaMask)+1e-9;
}
/** Lean prune_admissible: if coverage cost already exceeds best, mask cost does too */
export function pruneAdmissible(w:number, contrast:number, bytes:number, best:number, S:bigint, M:bigint, omegaMask: bigint): boolean {
  const cov = Math.abs(boxCard(S,omegaMask)-boxCard(M,omegaMask));
  const coverageCost = contrast*cov + w*bytes;
  if (coverageCost < best) return false; // not prunable — need full check
  // if coverageCost ≥ best then cellCost ≥ coverageCost ≥ best
  return coverageCost >= best ? boxCellCost(w,contrast,bytes,S,M,omegaMask) >= best -1e-9 : false;
}

/** Lean err_add_err_compl: err(S,M)+err(S,Mᶜ)=contrast*|Ω| */
export function errAddErrCompl(contrast:number, S:bigint, M:bigint, omegaMask: bigint): number {
  const Mc = (~M) & omegaMask;
  return boxErr(contrast,S,M,omegaMask)+boxErr(contrast,S,Mc,omegaMask);
}
export function minErrLeHalf(contrast:number, S:bigint, M:bigint, omegaMask: bigint): boolean {
  const Mc=(~M)&omegaMask;
  return Math.min(boxErr(contrast,S,M,omegaMask), boxErr(contrast,S,Mc,omegaMask)) <= contrast*popcntBigint(omegaMask)/2 +1e-9;
}

/** Lean bestErr contrast A S = inf'_{M∈A} err */
export function bestErr(contrast:number, A: bigint[], S:bigint, omegaMask: bigint): number {
  let best=Infinity; for(const M of A) best=Math.min(best, boxErr(contrast,S,M,omegaMask)); return best;
}
export function bestErrUnionHolds(contrast:number, A:bigint[], B:bigint[], S:bigint, omegaMask: bigint): boolean {
  const u=[...A,...B];
  return Math.abs(bestErr(contrast,u,S,omegaMask) - Math.min(bestErr(contrast,A,S,omegaMask), bestErr(contrast,B,S,omegaMask))) < 1e-9;
}

/** Lean line_beats_space_iff: 3B exact stroke ≤ 1B blank ↔ 2w ≤ contrast*|S| */
export function lineBeatsSpaceIff(w:number, contrast:number, S:bigint, omegaMask: bigint): boolean {
  const exact=boxCellCost(w,contrast,3,S,S,omegaMask);
  const blank=boxCellCost(w,contrast,1,S,0n,omegaMask);
  const cond=2*w <= contrast*boxCard(S,omegaMask)+1e-9;
  return (exact <= blank+1e-9) === cond;
}
export function errEqualCoverage(contrast:number, S:bigint, D:bigint, omegaMask: bigint): number {
  // assumes card D = card S
  const inter=popcntBigint((S & D) & omegaMask);
  return contrast * 2 * (boxCard(S,omegaMask)-inter);
}
export function lineBeatsDitherIff(w:number, contrast:number, S:bigint, D:bigint, omegaMask: bigint): boolean {
  const exact=boxCellCost(w,contrast,3,S,S,omegaMask);
  const dither=boxCellCost(w,contrast,1,S,D,omegaMask);
  const inter=popcntBigint((S & D) & omegaMask);
  const cond=w < contrast * (boxCard(S,omegaMask)-inter) -1e-9;
  return (exact < dither) === cond;
}

// ── Concrete rasters 4×4 (R4) ───────────────
export const R4_OMEGA_MASK: bigint = (1n<<16n)-1n; // 4×4=16
function r4Filter(pred:(r:number,c:number)=>boolean): bigint {
  let m=0n; for(let r=0;r<4;r++) for(let c=0;c<4;c++) if(pred(r,c)) m |= 1n << BigInt(r*4+c);
  return m;
}
export const R4_HLINE: bigint = r4Filter((r,c)=> r===1||r===2); // 8 cells
export const R4_VLINE: bigint = r4Filter((r,c)=> c===1||c===2); // 8 cells
export function r4RowMask(R: Set<number>): bigint {
  let m=0n; for(let r=0;r<4;r++) if(R.has(r)) for(let c=0;c<4;c++) m|=1n<<BigInt(r*4+c);
  return m;
}

// ── 6×6 arm masks (R6) ───────────────
export const R6_OMEGA_MASK: bigint = (1n<<36n)-1n;
export function r6ArmMask(u:boolean,r:boolean,d:boolean,l:boolean): bigint {
  let m=0n;
  for(let rr=0;rr<6;rr++) for(let cc=0;cc<6;cc++){
    const up   = u && (cc===2||cc===3) && rr<=3;
    const down = d && (cc===2||cc===3) && rr>=2;
    const left = l && (rr===2||rr===3) && cc<=3;
    const right= r && (rr===2||rr===3) && cc>=2;
    if(up||down||left||right) m|=1n<<BigInt(rr*6+cc);
  }
  return m;
}
export const R6_DIAG: bigint = (()=>{let m=0n; for(let i=0;i<6;i++) m|=1n<<BigInt(i*6+i); return m;})();
export const R6_DIAG_CARD=6;

// ── Seam DP (triples state) ───────────────
// Lean transSeam colPref s' s = colPref(s'.1,s.1) + (s'.2==s.2?0:seam)
// Seam awareness multiplies state |C×Fin3| =3|C|
export function transSeam(colPref:(a:string,b:string)=>number, seam:number, sPrev:{c:string, arm:number}, s:{c:string, arm:number}): number {
  return colPref(sPrev.c, s.c) + (sPrev.arm===s.arm?0:seam);
}
export function seamStateCount(cardC:number): number { return 3*cardC; }
