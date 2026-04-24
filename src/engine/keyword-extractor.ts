// src/engine/keyword-extractor.ts

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "because", "but", "and", "or", "if", "while", "about", "this", "that",
  "these", "those", "what", "which", "who", "whom", "it", "its", "my",
  "your", "his", "her", "our", "their", "me", "him", "us", "them",
  "i", "you", "he", "she", "we", "they",
  // Dev-specific
  "function", "const", "let", "var", "return", "import", "export",
  "class", "new", "public", "private", "protected", "static", "void",
  // Portuguese common
  "o", "a", "os", "as", "um", "de", "do", "da", "em", "no", "na",
  "por", "para", "com", "que", "e", "se", "nao", "mais",
]);

export interface ExtractorOptions {
  maxTokens?: number;
  preservePhrases?: boolean;
  minWordLength?: number;
}

export function extractKeywordsV2(
  text: string,
  options: ExtractorOptions = {}
): string[] {
  const { maxTokens = 8, preservePhrases = true, minWordLength = 4 } = options;

  if (!text) return [];

  const normalized = text.toLowerCase().replace(/[^\w\s'-]/g, " ");
  const words = normalized
    .split(/\s+/)
    .filter(w => w.length >= minWordLength && !STOP_WORDS.has(w));

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
