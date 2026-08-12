import { describe, it, expect } from 'vitest';
import {
  srgbToOkLab, // not exported — use via okLab helpers indirectly; we test via exposed clustering helpers
  okLabCentroid, okLabSumSqDist, okLabSumSqDistDecomp,
  luminanceThresholdForSplit, luminanceSplitCost, luminanceCellCost, kmObjectiveOkLab,
  smartPaletteA
} from './img2irc';

// Need srgbToOkLab for direct check — import via internal if not exported, use okLabCentroid's construction
// We'll test centroids via okLab helpers instead.

describe('Clustering.lean §1 centroids', () => {
  it('sum_sq_dist_decomp: Σ‖x−c‖² = Σ‖x−mean‖² + n‖c−mean‖²', () => {
    const pts=[[0.2,0.1,0.05],[0.4,0.15,0.07],[0.3,0.12,0.06]] as number[][];
    const c=[0.5,0.2,0.1];
    const { left, right }=okLabSumSqDistDecomp(pts,c);
    expect(left).toBeCloseTo(right, 9);
    // also centroid minimizes
    const m=okLabCentroid(pts);
    expect(okLabSumSqDist(pts,m) <= left + 1e-9).toBe(true);
    expect(okLabSumSqDist(pts,m) <= okLabSumSqDist(pts,[0,0,0]) + 1e-9).toBe(true);
  });
  it('centroid minimizes (empty set trivial)', () => {
    expect(okLabCentroid([])).toEqual([0,0,0]);
    expect(okLabSumSqDist([], [1,1,1])).toBe(0);
  });
  it('smartPaletteA Lloyd step is centroid step (IrcCluster.centroid_step_le)', () => {
    // 4 pixels two clusters: should converge to near two centroids and lower objective
    const pW=4,pH=1;
    const d=new Uint8ClampedArray(pW*pH*4);
    // two reds, two blues
    for(let i=0;i<4;i++){ const off=i*4; d[off]= i<2?200:20; d[off+1]=10; d[off+2]= i<2?20:200; d[off+3]=255; }
    const pal1=smartPaletteA(d,pW,pH,2);
    expect(pal1.length).toBe(2);
    // centroids should be distinct and near red/blue (one has high R, other high B)
    const r0=(pal1[0]>>16)&255, b0=pal1[0]&255, r1=(pal1[1]>>16)&255,b1=pal1[1]&255;
    expect((r0>100 && b1>100) || (r1>100 && b0>100)).toBe(true);
  });
});

describe('Clustering.lean §2 two-colour threshold', () => {
  it('nearest = threshold at (c1+c2)/2 and threshold_minimizes', () => {
    const lumas=[10,12,11,100,105,102];
    const thresh=luminanceThresholdForSplit(lumas);
    // largest gap is ~88 between 12 and 100 → mid ~56
    expect(thresh).toBeGreaterThan(20);
    expect(thresh).toBeLessThan(90);
    // Build two-threshold split vs arbitrary S
    const S=new Set([0,1,2]); // low luminances
    const T=new Set<number>(); for(let i=0;i<lumas.length;i++) if(lumas[i] <= thresh) T.add(i);
    expect(T).toEqual(S); // optimal threshold equals low group
    expect(luminanceCellCost(lumas, T) <= luminanceCellCost(lumas, S) + 1e-9).toBe(true);
    // Any other S is worse
    const Sbad=new Set([0,3]); // mixing
    expect(luminanceCellCost(lumas, T) <= luminanceCellCost(lumas, Sbad)+1e-9).toBe(true);
  });
  it('exists_optimal_split and gap>16 else 127', () => {
    expect(luminanceThresholdForSplit([10,11,12,13])).toBe(127); // no large gap
    expect(luminanceThresholdForSplit([0,0,0,255,255,255])).toBeGreaterThan(100);
  });
  it('splitCost/nearest minimizes for fixed c1,c2', () => {
    const lumas=[5,6,50,51], c1=5.5, c2=50.5;
    const Snear=new Set<number>(); for(let i=0;i<lumas.length;i++) if((lumas[i]-c1)*(lumas[i]-c1) <= (lumas[i]-c2)*(lumas[i]-c2)) Snear.add(i);
    expect(Snear).toEqual(new Set([0,1]));
    const costNear=luminanceSplitCost(lumas,Snear,c1,c2);
    const costBad=luminanceSplitCost(lumas,new Set([0,2]),c1,c2);
    expect(costNear <= costBad).toBe(true);
  });
});

describe('Clustering.lean §3 k-means with pen + descent', () => {
  it('kmObjective fiberwise and assign/centroid steps decrease', () => {
    const pts=[[0,0,0],[0.1,0,0],[1,0,0],[1.1,0,0]] as number[][];
    const pen=[0, 0.5]; // index cost
    const cents=[[0.05,0,0],[1.05,0,0]] as number[][];
    const a=(i:number)=> i<2?0:1;
    const aBad=(i:number)=> i%2; // interleaved worse
    const objGood=kmObjectiveOkLab(pts, pen, a, cents);
    const objBad=kmObjectiveOkLab(pts, pen, aBad, cents);
    expect(objGood <= objBad).toBe(true);
    // centroid step: recompute means
    const mean0=okLabCentroid([pts[0],pts[1]]), mean1=okLabCentroid([pts[2],pts[3]]);
    const cents2=[mean0,mean1];
    const objAfterCentroid=kmObjectiveOkLab(pts, pen, a, cents2);
    expect(objAfterCentroid <= objGood + 1e-9).toBe(true);
  });
  it('descent antitone and stabilizes on finite assignments', () => {
    // Finite state: 2 points, K=2 → 4 assignments; Lloyd alternation must stabilize
    const pts=[[0,0,0],[1,0,0]] as number[][];
    let cents=[[0,0,0],[1,0,0]] as number[][];
    let assign=(i:number)=> i;
    let prev=Infinity;
    for(let iter=0; iter<10; iter++){
      const pen=[0,0];
      const cur=kmObjectiveOkLab(pts,pen,assign,cents);
      expect(cur <= prev + 1e-9).toBe(true);
      prev=cur;
      // assign step
      const nextAssign=(i:number)=>{
        let best=0,bd=Infinity;
        for(let k=0;k<2;k++){ const d=(pts[i][0]-cents[k][0])**2+(pts[i][1]-cents[k][1])**2+(pts[i][2]-cents[k][2])**2; if(d<bd){bd=d; best=k;}}
        return best;
      };
      assign=nextAssign;
      // centroid step
      const groups:[number[][],number[][]]=[[],[]];
      for(let i=0;i<pts.length;i++) groups[assign(i)].push(pts[i]);
      cents=[groups[0].length?okLabCentroid(groups[0]):cents[0], groups[1].length?okLabCentroid(groups[1]):cents[1]];
    }
  });
});
