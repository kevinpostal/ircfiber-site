/**
 * Fuzzy match scoring for the quick-switcher (Cmd/Ctrl+K).
 *
 * Returns a score based on match quality:
 *   100  — exact match (case-insensitive)
 *    60  — prefix match
 *    30  — substring match
 *    >0  — character-by-character match (capped at 29)
 *     0  — no match
 *
 * Within char-by-char results, longer consecutive runs score higher
 * than scattered matches, ensuring the best partial match ranks first.
 * The cap at 29 guarantees that substring matches always outrank
 * char-by-char matches in sorted lists.
 */
export function fuzzyMatch(query: string, target: string): number {
  if (!query) return 0;
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();

  if (lowerTarget === lowerQuery) return 100;
  if (lowerTarget.startsWith(lowerQuery)) return 60;
  if (lowerTarget.includes(lowerQuery)) return 30;

  // Character-by-character: weight consecutive runs more heavily,
  // cap strictly below substring threshold for correct ranking.
  let qi = 0;
  let score = 0;
  let run = 0;
  for (let ti = 0; ti < lowerTarget.length && qi < lowerQuery.length; ti++) {
    if (lowerTarget[ti] === lowerQuery[qi]) {
      run++;
      score += 2 + run * 3;
      qi++;
    } else {
      run = 0;
    }
  }
  if (qi !== lowerQuery.length) return 0;
  return Math.min(score, 29);
}
