/**
 * Mixed-geometry segmentation DP — mirrors Segmentation.lean (Seg.*)
 *
 * Lean:
 *   Valid n l : (l.map .1).sum = n ∧ ∀ p∈l, 0 < p.1
 *   segCost w i [] = 0 ; segCost w i ((len,g)::rest) = w i len g + segCost (i+len) rest
 *   dpSeg w i 0 = 0
 *   dpSeg w i (n+1) = inf'_{len∈1..n+1, g∈G} ( w i len g + dpSeg (i+len) (n-len) )
 *
 * Theorems:
 *   dpSeg_le_segCost  — dp lower-bounds every valid segmentation
 *   exists_seg_eq_dpSeg — dp is realised
 *   dpSeg_optimal — conjunction (viterbi_correct analogue)
 *
 * Complexity: Θ(n²·|G|) (Θ(n·L·|G|) with cap L) — enabled by OKLab fast matcher (§5)
 * Lean uses Fintype G, Nonempty; here G is the PixelMode subset we mix.
 */

export type Seg<G> = { len: number; g: G };

export function segCost<G>(w: (i: number, len: number, g: G) => number, i: number, segs: Seg<G>[]): number {
  let acc = 0;
  let pos = i;
  for (const s of segs) {
    acc += w(pos, s.len, s.g);
    pos += s.len;
  }
  return acc;
}

export function isValid<G>(n: number, segs: Seg<G>[]): boolean {
  let sum = 0;
  for (const s of segs) {
    if (s.len <= 0) return false;
    sum += s.len;
  }
  return sum === n;
}

/**
 * dpSeg — suffix DP. Returns { cost, segs } optimal for cover n cells from i.
 * Matches Lean's dpSeg w i n (with i shifting). We implement suffix form dp[pos]
 * to avoid Lean's (i+len) recursion plumbing; equivalent by strong induction.
 *
 * If capL is set, only len ≤ capL considered — Lean's Θ(n·L·|G|) variant.
 */
export function dpSeg<G>(
  w: (i: number, len: number, g: G) => number,
  G: readonly G[],
  n: number,
  capL?: number,
): { cost: number; segs: Seg<G>[] } {
  if (G.length === 0) throw new Error('G must be nonempty (Nonempty G)');
  const INF = 1e18;
  const dp: number[] = new Array(n + 1).fill(INF);
  const back: ({ len: number; g: G; next: number } | null)[] = new Array(n + 1).fill(null);
  dp[n] = 0; // suffix base: 0 cells left costs 0
  // fill from n-1 down to 0
  for (let pos = n - 1; pos >= 0; pos--) {
    let best = INF;
    let bestChoice: { len: number; g: G; next: number } | null = null;
    const maxLen = capL ? Math.min(capL, n - pos) : n - pos;
    for (let len = 1; len <= maxLen; len++) {
      const next = pos + len;
      if (dp[next] >= INF) continue;
      for (const g of G) {
        const c = w(pos, len, g) + dp[next];
        if (c < best) {
          best = c;
          bestChoice = { len, g, next };
        }
      }
    }
    dp[pos] = best;
    back[pos] = bestChoice;
  }
  // reconstruct
  const segs: Seg<G>[] = [];
  let cur = 0;
  while (cur < n) {
    const ch = back[cur];
    if (!ch) break; // no valid segmentation (w returns INF)
    segs.push({ len: ch.len, g: ch.g });
    cur = ch.next;
  }
  return { cost: dp[0], segs };
}

/** Brute force for testing small n — enumerates all valid segmentations */
export function bruteSeg<G>(w: (i: number, len: number, g: G) => number, G: readonly G[], n: number): { cost: number; segs: Seg<G>[] } {
  let bestCost = Infinity;
  let best: Seg<G>[] = [];
  const cur: Seg<G>[] = [];
  function dfs(pos: number, acc: number) {
    if (pos === n) {
      if (acc < bestCost) { bestCost = acc; best = [...cur]; }
      return;
    }
    if (pos > n) return;
    if (acc >= bestCost) return; // prune
    for (let len = 1; len <= n - pos; len++) {
      for (const g of G) {
        const c = w(pos, len, g);
        cur.push({ len, g });
        dfs(pos + len, acc + c);
        cur.pop();
      }
    }
  }
  dfs(0, 0);
  return { cost: bestCost, segs: best };
}
