// src/lib/profiles.ts
import { createLogger } from "./logger.js";
import type { Config, ProfileConfig } from "./config.js";

const logger = createLogger();

export interface ModeProfile {
  id: string;
  stopWords: ReadonlySet<string>;
  trivialPatterns: ReadonlyArray<RegExp>;
  locale?: string;
}

export const ENGLISH_PROFILE: ModeProfile = {
  id: "english",
  stopWords: new Set([
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
  ]),
  trivialPatterns: [
    /^(hi|hello|hey|thanks|thank you|ok|okay|cool|nice)\W*$/i,
    /^(yes|no|yep|nope|sure)\W*$/i,
  ],
  locale: "en-US",
};

export const PORTUGUESE_PROFILE: ModeProfile = {
  id: "portuguese",
  stopWords: new Set([
    "o", "a", "os", "as", "um", "uma", "de", "do", "da", "em", "para",
    "por", "com", "que", "e", "ou", "mas", "se", "não", "sim", "muito",
    "mais", "menos", "já", "no", "na", "nos", "nas",
  ]),
  trivialPatterns: [
    /^(oi|olá|ola|obrigado|obrigada|valeu|tudo bem)\W*$/i,
    /^(sim|não|nao|claro|tá|ta|ok)\W*$/i,
  ],
  locale: "pt-PT",
};

export const SPANISH_PROFILE: ModeProfile = {
  id: "spanish",
  stopWords: new Set([
    "el", "la", "los", "las", "un", "una", "de", "del", "en", "para",
    "por", "con", "que", "y", "o", "pero", "si", "no", "sí", "muy",
    "más", "menos", "ya", "al", "a",
  ]),
  trivialPatterns: [
    /^(hola|gracias|de nada|vale|listo)\W*$/i,
    /^(sí|si|no|claro|ok)\W*$/i,
  ],
  locale: "es-ES",
};

const BUILTIN: Record<string, ModeProfile> = {
  english: ENGLISH_PROFILE,
  portuguese: PORTUGUESE_PROFILE,
  spanish: SPANISH_PROFILE,
};

let hasWarnedUnknown = false;

export function resolveProfile(config: Config): ModeProfile {
  const fromEnv = process.env.MEMENTO_PROFILE?.toLowerCase();
  const fromConfig = config.profile?.id;
  const id = fromEnv ?? fromConfig ?? "english";

  if (BUILTIN[id]) return mergeWithCustom(BUILTIN[id], config.profile);

  // Unknown id → fall back to english + warn once
  if (!hasWarnedUnknown) {
    logger.warn(`Unknown profile "${id}", falling back to english.`);
    hasWarnedUnknown = true;
  }
  return mergeWithCustom(ENGLISH_PROFILE, config.profile);
}

function mergeWithCustom(base: ModeProfile, override?: ProfileConfig): ModeProfile {
  if (!override) return base;
  return {
    id: base.id,
    stopWords: new Set([...base.stopWords, ...(override.extraStopWords ?? [])]),
    trivialPatterns: [
      ...base.trivialPatterns,
      ...(override.extraTrivialPatterns ?? []).map(s => new RegExp(s, "i")),
    ],
    locale: override.locale && override.locale.length > 0 ? override.locale : base.locale,
  };
}
