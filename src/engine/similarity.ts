export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

// I2: Returns Set<string> to deduplicate trigrams, preventing similarity > 1.0
// when strings contain repeated characters (e.g. "aaaa" has only 1 unique trigram).
export function extractTrigrams(s: string): Set<string> {
  const lower = s.toLowerCase();
  const trigrams = new Set<string>();
  for (let i = 0; i <= lower.length - 3; i++) {
    trigrams.add(lower.substring(i, i + 3));
  }
  return trigrams;
}

export function trigramSimilarity(a: string, b: string): number {
  // I2: Use Set intersection/union throughout to keep values in [0, 1]
  const setA = extractTrigrams(a);
  const setB = extractTrigrams(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(t => setB.has(t)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  // Clamp to [0, 1] as a safety net
  return Math.min(1, Math.max(0, intersection.size / union.size));
}

export function combinedSimilarity(
  a: { title: string; body: string },
  b: { title: string; body: string }
): number {
  const titleSim = trigramSimilarity(a.title, b.title);
  const bodySim = jaccardSimilarity(a.body, b.body);
  return titleSim * 0.4 + bodySim * 0.6;
}
