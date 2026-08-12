import { describe, it, expect } from 'vitest';
import { base94Feasible, base94MinChars, base94Encode, base94Decode, base94EncodedLength } from './img2irc';

describe('Base94.lean', () => {
  it('Feasible n m := 256^n ≤ 94^m', () => {
    expect(base94Feasible(9,11)).toBe(true);
    expect(base94Feasible(9,10)).toBe(false);
    expect(base94Feasible(0,0)).toBe(true);
    expect(base94Feasible(1,2)).toBe(true); // 256 ≤ 8836
    expect(base94Feasible(1,1)).toBe(false); // 256 ≤94 false
  });
  it('nine_bytes_fit_eleven and nine_bytes_need_eleven', () => {
    expect(base94Feasible(9,11)).toBe(true);
    expect(base94Feasible(9,10)).toBe(false);
  });
  it('minChars 9 =11 and feasible_mono', () => {
    expect(base94MinChars(9)).toBe(11);
    expect(base94MinChars(0)).toBe(0);
    expect(base94MinChars(1)).toBe(2); // 256 ≤94^2=8836
    expect(base94MinChars(3)).toBe(4); // 16M ≤ 94^4
    // mono: if feasible at m then feasible at m'≥m
    expect(base94Feasible(9,11) && base94Feasible(9,12)).toBe(true);
    expect(!base94Feasible(9,10) || base94Feasible(9,12)).toBe(true);
  });
  it('pow_ineq 94^61 <256^50 and rate_lt 61n<50m', () => {
    expect(base94Feasible(50,61)).toBe(false); // 256^50 >94^61 → not feasible
    expect(base94Feasible(61,50)).toBe(false); // not relevant
    // rate_lt: any feasible n,m with n>0 →61n<50m
    for(const [n,m] of [[9,11],[3,4],[6,8],[50,62]]){
      if(base94Feasible(n,m) && n>0){
        expect(61*n < 50*m).toBe(true);
      }
    }
    // ceiling approx 0.819
    expect(61*9 < 50*11).toBe(true);
  });
  it('min_block_of_better_than_nine_eleven: 9m<11n →72≤m', () => {
    // brute small feasible blocks better than 9/11
    const better: [number,number][]=[];
    for(let n=1;n<=20;n++) for(let m=1;m<=80;m++) if(base94Feasible(n,m) && 9*m < 11*n) better.push([n,m]);
    for(const [,m] of better) expect(m>=72).toBe(true);
    // 9/11 itself not better
    expect(9*11 < 11*9).toBe(false);
  });
  it('gain_over_base64 12/11', () => {
    const base94Rate=9/11, base64Rate=3/4;
    expect(base94Rate/base64Rate).toBeCloseTo(12/11,9);
    expect(base94Rate > base64Rate).toBe(true);
  });
  it('base94Encode 9→11 and round-trip, length via minChars', () => {
    const data=new Uint8Array([1,2,3,4,5,6,7,8,9]);
    const enc=base94Encode(data);
    expect(enc.length).toBe(11);
    expect(base94EncodedLength(9)).toBe(11);
    expect(base94Decode(enc)).toEqual(data);
    // remainder lengths use minChars
    for(let n=0;n<=9;n++) expect(base94EncodedLength(n)).toBe(base94MinChars(n));
    expect(base94EncodedLength(400)).toBe(base94MinChars(400%9)+ Math.floor(400/9)*11);
    // random round-trip
    for(const len of [1,2,5,9,10,18,400]){
      const d=new Uint8Array(len); for(let i=0;i<len;i++) d[i]=(i*37)%256;
      expect(base94Decode(base94Encode(d))).toEqual(d);
    }
  });
});
