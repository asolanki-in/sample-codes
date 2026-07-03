/**
 * Dependency-free string similarity used by the verb corrector and the
 * element matcher: Sørensen–Dice coefficient over character bigrams,
 * blended with a length-aware prefix bonus for very short strings
 * (bigram sets are unstable below ~4 chars).
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  if (a.length < 2 || b.length < 2) {
    return a[0] === b[0] ? 0.5 : 0;
  }
  const bigrams = (s: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      map.set(bg, (map.get(bg) ?? 0) + 1);
    }
    return map;
  };
  const ma = bigrams(a);
  const mb = bigrams(b);
  let overlap = 0;
  for (const [bg, count] of ma) {
    overlap += Math.min(count, mb.get(bg) ?? 0);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}
