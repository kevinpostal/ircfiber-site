import { describe, it, expect } from 'vitest';
import {
  erasureSingletonBoundHolds, erasureMinMessages, erasureOverhead,
  erasureSymbolsNeeded, erasureNeededMessages, base94EncodedLength
} from './img2irc';

describe('Erasure.lean §2.6 Singleton bound', () => {
  it('singleton_bound: |P| ≤ |Sym|^(n−r)', () => {
    // Example: P = 256^400 bytes, Sym=94 (Base94), n−r must hold
    const symCard=94, payloadBytes=10, r=2;
    const payloadCard=Math.pow(256, 4); // smaller for safe integer range (256^4 fits in JS)
    // if n=6, r=2 → n−r=4 → 94^4 = 78M < 256^4=4B → fails, need larger n
    expect(erasureSingletonBoundHolds(payloadCard, symCard, 4, 0)).toBe(false); // 94^4 <256^4
    expect(erasureSingletonBoundHolds(payloadCard, symCard, 6, 2)).toBe(false); // same n−r=4
    // with enough symbols: n=10,r=2 → 94^8 huge >256^4
    expect(erasureSingletonBoundHolds(payloadCard, symCard, 10, 2)).toBe(true);
    // trivial
    expect(erasureSingletonBoundHolds(1, 94, 0, 0)).toBe(true);
    expect(erasureSingletonBoundHolds(100, 2, 7, 0)).toBe(true); // 2^7=128 ≥100
    expect(erasureSingletonBoundHolds(100, 2, 6, 0)).toBe(false); // 2^6=64 <100
  });
  it('messages_ge: if |Sym|^(k−1) < |P| then n ≥ k+r (r costs ≥r)', () => {
    const symCard=94;
    // choose k such that sym^(k−1) < payload < sym^k
    const k=5, r=2;
    const payloadCard=Math.pow(symCard, k-1)+1; // just over sym^(k−1)
    const nOk=k+r, nShort=k+r-1;
    expect(erasureSingletonBoundHolds(payloadCard, symCard, nOk, r)).toBe(true);
    expect(erasureSingletonBoundHolds(payloadCard, symCard, nShort, r)).toBe(false);
    expect(erasureMinMessages(k,r)).toBe(k+r);
    expect(erasureOverhead(r)).toBe(r);
    // Lean: messages_ge concludes k+r ≤ n for any feasible n
    // So if n = k+r-1, the bound would be violated
  });
  it('symbols needed and needed messages for byte payloads', () => {
    expect(erasureSymbolsNeeded(0,94)).toBe(0);
    expect(erasureSymbolsNeeded(9,94)).toBe(11); // 9 bytes →11 base94 chars (Base94.lean optimal)
    expect(erasureSymbolsNeeded(9,94)).toBe(base94EncodedLength(9));
    expect(erasureSymbolsNeeded(400,94)).toBe(base94EncodedLength(400));
    // overhead r adds exactly r
    expect(erasureNeededMessages(9,94,0)).toBe(11);
    expect(erasureNeededMessages(9,94,2)).toBe(13);
    expect(erasureNeededMessages(400,94,3)).toBe(base94EncodedLength(400)+3);
    expect(erasureNeededMessages(0,94,2)).toBe(2); // empty payload still needs r
  });
  it('overhead is at least r (Singleton lower bound)', () => {
    for(const r of [0,1,2,5,10]){
      const k=10;
      expect(erasureMinMessages(k,r) - k).toBe(r);
      expect(erasureOverhead(r)).toBe(r);
    }
  });
});
