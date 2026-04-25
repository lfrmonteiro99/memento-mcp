// src/engine/keyword-extractor.ts

export interface ExtractOptions {
  maxTokens?: number;
  preservePhrases?: boolean;
  minWordLength?: number;
  stopWords: ReadonlySet<string>;
}

export function extractKeywordsV2(
  text: string,
  options: ExtractOptions
): string[] {
  const { maxTokens = 8, preservePhrases = true, minWordLength = 4, stopWords } = options;

  if (!text) return [];

  const normalized = text.toLowerCase().replace(/[^\w\s'-]/g, " ");
  const words = normalized
    .split(/\s+/)
    .filter(w => w.length >= minWordLength && !stopWords.has(w));

  if (words.length === 0) return [];

  // Extract bigrams
  const phrases: string[] = [];
  if (preservePhrases && words.length >= 2) {
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i].length >= 3 && words[i + 1].length >= 3) {
        phrases.push(`${words[i]} ${words[i + 1]}`);
      }
    }
  }

  // Score terms by position and length
  const termScores = new Map<string, number>();

  words.forEach((word, index) => {
    const positionBoost = 1.0 - (index / words.length) * 0.3;
    const lengthBoost = Math.min(word.length / 8, 1.5);
    const score = (termScores.get(word) || 0) + positionBoost * lengthBoost;
    termScores.set(word, score);
  });

  phrases.forEach((phrase) => {
    const score = (termScores.get(phrase) || 0) + 2.0;
    termScores.set(phrase, score);
  });

  const ranked = [...termScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTokens)
    .map(([term]) => term);

  return ranked;
}

// N4: buildFtsQueryV2 takes a second argument controlling prefix matching.
// Callers pass config.search.ftsPrefixMatching (default true). When false,
// single-term tokens are used literally — phrases still use quoted syntax.
export function buildFtsQueryV2(keywords: string[], prefixMatching: boolean = true): string {
  if (keywords.length === 0) return "";

  const parts: string[] = [];
  for (const kw of keywords) {
    if (kw.includes(" ")) {
      parts.push(`"${kw}"`);
    } else if (prefixMatching) {
      parts.push(`${kw}*`);
    } else {
      parts.push(kw);
    }
  }

  return parts.join(" OR ");
}
