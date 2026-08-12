import { describe, it, expect } from 'vitest';
import { msgCount, msgCountPacked, msgCountPackLe, estimatePackedMessages, IRC_HARD_LIMIT, IRC_SAFE_PAYLOAD } from './img2irc';

// Mirrors LambdaPareto.lean IrcRD theorems — the Viterbi DP realises
//   cost B D lam x = D x + lam * B x   and   Optimal lam x = ∀ y, cost lam x ≤ cost lam y
// so bytes/distortion monotonicity and Pareto are emergent properties of the DP.
// These tests pin the pure helpers that make bisection sound.

describe('LambdaPareto', () => {
  it('msgCount = ceil(b/C)', () => {
    expect(msgCount(400, 0)).toBe(0);
    expect(msgCount(400, 1)).toBe(1);
    expect(msgCount(400, 400)).toBe(1);
    expect(msgCount(400, 401)).toBe(2);
    expect(msgCount(400, 800)).toBe(2);
    expect(msgCount(512, 512)).toBe(1);
    expect(msgCount(512, 513)).toBe(2);
  });

  it('msgCount mono in b (Lean: msgCount_mono)', () => {
    const C = 400;
    for (const [b1, b2] of [[0, 10], [399, 400], [400, 401], [799, 800]] as const) {
      expect(msgCount(C, b1) <= msgCount(C, b2)).toBe(true);
    }
  });

  it('msgCount antitone in lam via bytes_antitone (Lean: msgCount_antitone)', () => {
    // Simulate two λ-optima where B decreases with λ (bytes_antitone)
    const C = 512;
    const B1 = 900, B2 = 700; // λ1 < λ2  → B2 ≤ B1
    expect(msgCount(C, B2) <= msgCount(C, B1)).toBe(true);
    // Also when B equal, msgCount equal; when B drops across boundary, msgCount drops
    expect(msgCount(C, 1024)).toBe(2);
    expect(msgCount(C, 1023)).toBe(2);
    expect(msgCount(C, 1025)).toBe(3);
    expect(msgCount(C, 1024) <= msgCount(C, 1025)).toBe(true);
  });

  it('fits upward closed (Lean: fits_upward_closed) — bisection soundness', () => {
    const C = IRC_HARD_LIMIT;
    const T = 1; // at most 1 message per line equivalent: b ≤ 512
    // Selector that is Optimal at every lam — mock B values antitone in lam
    const B = [600, 512, 400, 300]; // decreasing in lam
    const fits = B.map(b => msgCount(C, b) <= T); // [false,true,true,true]
    const firstFit = fits.indexOf(true);
    expect(firstFit).toBe(1);
    for (let i = firstFit; i < fits.length; i++) expect(fits[i]).toBe(true);
    // bisection would return the first feasible lam (index 1), which is Pareto-optimal for λ>0
  });

  it('msgCount pack never increases messages (Lean: msgCount_pack_le)', () => {
    for (const R of [0, 1, 2, 60, 120]) {
      for (const k of [1, 2, 3, 5, 20, 60]) {
        expect(msgCountPackLe(R, k)).toBe(true);
        expect(msgCountPacked(R, k)).toBe(R === 0 ? 0 : Math.ceil(R / k));
        expect(msgCountPacked(R, k) <= R).toBe(true);
      }
    }
    // concrete: 60 rows packed 3 per PRIVMSG → 20 messages (vs 60 without packing)
    expect(msgCountPacked(60, 3)).toBe(20);
    expect(msgCountPacked(60, 1)).toBe(60);
  });

  it('estimatePackedMessages uses packing', () => {
    const art = Array(60).fill('x').join('\n');
    expect(estimatePackedMessages(art, IRC_SAFE_PAYLOAD, 1)).toBe(60);
    expect(estimatePackedMessages(art, IRC_SAFE_PAYLOAD, 3)).toBe(20);
    expect(estimatePackedMessages('', IRC_SAFE_PAYLOAD, 3)).toBe(1); // one empty line → 1 row
    // empty art is still 1 line via split, but pack logic still holds ≤R
    expect(estimatePackedMessages('a\nb\nc', IRC_SAFE_PAYLOAD, 2)).toBe(2);
  });
});
