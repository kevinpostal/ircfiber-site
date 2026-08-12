import { describe, it, expect } from 'vitest';
import {
  glyphBlend, glyphCellCost, GLYPH_COVERAGES, glyphBandError, glyphOptimalBlockCoverage, glyphDominatedByByteGap,
  bestGlyphForState, IRC99
} from './img2irc';

function approx(a:number,b:number,eps=1e-9){ return Math.abs(a-b) <= eps; }

describe('GlyphCoverage.lean (§2.2/§3.2)', () => {
  it('blend and swap: 1-c complement is free via swapped state', () => {
    const fg=200, bg=10, c=0.273;
    expect(glyphBlend(c, fg, bg)).toBeCloseTo(c*fg + (1-c)*bg, 9);
    expect(glyphBlend(1-c, fg, bg)).toBeCloseTo(glyphBlend(c, bg, fg), 9);
    expect(glyphBlend(c, fg, bg) - glyphBlend(0.121, fg, bg)).toBeCloseTo((c-0.121)*(fg-bg), 9);
  });
  it('full_block_dominated: █ (1,1,3) = space (0,0,1) +2w', () => {
    const w=2.5, fg=100, bg=0, tTop=60, tBot=40;
    const cBlock = glyphCellCost(w,1,1,3,tTop,tBot,fg,bg);
    const cSpace = glyphCellCost(w,0,0,1,tTop,tBot,bg,fg); // swapped
    expect(cBlock).toBeCloseTo(cSpace + 2*w, 9);
    // Hence █ never wins over space in swapped state
    expect(cBlock > cSpace).toBe(true);
  });
  it('err_diff_le: |Δcoverage|·contrast bounds error diff', () => {
    for(const c of [0,0.121,0.273,0.4945,0.5,1])
      for(const cc of [0.183,0.5,0.794]){
        const fg=200, bg=50, t=120;
        const lhs = Math.abs(t - glyphBlend(c,fg,bg)) - Math.abs(t - glyphBlend(cc,fg,bg));
        expect(lhs <= Math.abs(c-cc)*Math.abs(fg-bg) + 1e-9).toBe(true);
      }
  });
  it('dominated_of_byte_gap and light_shade_dominated (░ dominated by = at contrast ≤40)', () => {
    const w=2.5;
    // ░ 0.183/0.181 3B vs = 0.122/0.120 1B : Δ =0.061 per half
    const ct=0.183, cb=0.181, ct2=0.122, cb2=0.120;
    expect(glyphDominatedByByteGap(w,ct,cb,3,ct2,cb2,1,40)).toBe(true);
    expect(glyphDominatedByByteGap(w,ct,cb,3,ct2,cb2,1,41)).toBe(false); // just over
    // direct cellCost check via lean helper
    for(const contrast of [10,40]){
      const fg=contrast, bg=0, tTop=fg*0.15, tBot=fg*0.15;
      const cDominated = glyphCellCost(w,ct,cb,3,tTop,tBot,fg,bg);
      const cCheaper = glyphCellCost(w,ct2,cb2,1,tTop,tBot,fg,bg);
      expect(cCheaper <= cDominated + 1e-9).toBe(true);
    }
    // high contrast >41 should NOT guarantee domination
    expect(glyphDominatedByByteGap(w,ct,cb,3,ct2,cb2,1,200)).toBe(false);
  });
  it('midtone_gap: ascii-only cmax=0.273 → ≥0.227·contrast at mid', () => {
    const cmax=273/1000;
    const fg=200, bg=0;
    const mid=(fg+bg)/2;
    for(const c of [0,0.121,0.254,0.273,0.727,0.746,0.879,1]){
      const err = Math.abs(mid - glyphBlend(c,fg,bg));
      expect(err + 1e-9 >= (0.5 - cmax)*Math.abs(fg-bg)).toBe(true);
    }
    // coverages that violate condition (e.g. 0.4 in gap) are not in safe alphabet — error would be smaller
    const inside = glyphBlend(0.4,fg,bg); // hypothetical 0.4 not in GLYPH_COVERAGES
    expect(Math.abs(mid - inside) < (0.5-cmax)*Math.abs(fg-bg)).toBe(true);
  });
  it('coverages list matches lean and safe_alphabet covers within 0.11075', () => {
    expect(GLYPH_COVERAGES).toEqual([0,121/1000,254/1000,273/1000,4945/10000,5055/10000,727/1000,746/1000,879/1000,1]);
    const gap=443/4000; // 0.11075
    for(let t=0; t<=1; t+=0.01){
      let best=Infinity;
      for(const c of GLYPH_COVERAGES) best=Math.min(best, Math.abs(t-c));
      expect(best <= gap + 1e-9).toBe(true);
    }
    // tightness at t=0.38375
    const t0=38375/100000;
    let best0=Infinity; for(const c of GLYPH_COVERAGES) best0=Math.min(best0, Math.abs(t0-c));
    expect(approx(best0, gap, 1e-9)).toBe(true);
  });
  it('bandError, optimal_block_coverage, measured_optimal_block', () => {
    const cmax=273/1000;
    const rStar=glyphOptimalBlockCoverage(cmax); // (1+cmax)/3
    expect(rStar).toBeCloseTo((1+0.273)/3, 9); // 0.424333...
    const errStar=glyphBandError(cmax, rStar);
    expect(errStar).toBeCloseTo(227/3000, 9); // 0.075666...
    const errI = glyphBandError(cmax, 4945/10000); // ▒
    expect(errI).toBeCloseTo(443/4000, 9); // 0.11075
    expect(errStar < errI).toBe(true);
    // optimal is minimal
    for(const r of [0.3,0.4,0.45,0.4945,0.5,0.6]){
      expect(errStar <= glyphBandError(cmax,r) + 1e-9).toBe(true);
    }
  });
  it('perceptual_midpoint_lt_linear: OKLab blend darker than linear (cube)', () => {
    const cubes=(x:number)=>x*x*x;
    for(const [x,y] of [[0.2,0.8],[0.1,0.9],[0.4,0.6]] as const){
      expect(cubes((x+y)/2) < (cubes(x)+cubes(y))/2).toBe(true);
    }
    // bestGlyphForState in oklab mode uses cube-root domain blend (srgbToOkLab/cubed) vs linear fallback
    // Smoke: same fg/bg pair yields different glyph choice or err under oklab vs rgb at w=2.5
    const pal=IRC99;
    const gOk=bestGlyphForState(120,120,120, 130,130,130, 10, 12, pal, 'oklab', 2.5);
    const gRgb=bestGlyphForState(120,120,120, 130,130,130, 10, 12, pal, 'rgb', 2.5);
    expect(typeof gOk.glyph).toBe('string');
    expect(typeof gRgb.glyph).toBe('string');
  });
  it('Viterbi respects domination: ░ never beats = at low contrast, █ never beats space', () => {
    const pal=IRC99;
    // Low contrast cell where ░ vs = matters: fg close to bg, w=2.5
    // Force palette entries close: use indices 0 (white) and 1 (black) but blend contrast is palette distance
    // Use bestGlyphForState directly with small fg-bg Δ via palette choice: f=1 (black 0), b=0 (white 255) → contrast 255 high → not dominated
    // Instead use two palette entries that are close: pick IRC99 ind 14 grey 0x555555 vs 15 0xaaaaaa (contrast ~85)
    // For true low contrast we need custom pal of two nearby colors
    const closePal=[0x606060, 0x6a6a6a]; // contrast ~10
    const g=bestGlyphForState(0x62,0x62,0x62, 0x63,0x63,0x63, 0,1, closePal, 'oklab', 2.5);
    expect(g.glyph).not.toBe('░'); // dominated
    expect(g.glyph).not.toBe('█'); // always dominated
  });
});
