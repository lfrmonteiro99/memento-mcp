export type TextType = "prose" | "code" | "structured" | "whitespace_heavy";

const CHARS_PER_TOKEN: Record<TextType, number> = {
  prose: 4.0,
  code: 3.2,
  structured: 3.0,
  whitespace_heavy: 4.5,
};

const FRAMING_OVERHEAD = 4;

export function classifyTextType(text: string): TextType {
  if (!text || text.length === 0) return "prose";

  const sample = text.substring(0, 500);
  const len = sample.length;

  const jsonLike = sample.trimStart().startsWith("{") || sample.trimStart().startsWith("[");
  const codeChars = (sample.match(/[{}();=<>[\]|&!+\-*/\\@#$%^~`]/g) || []).length;
  const whitespace = (sample.match(/\s/g) || []).length;

  const codeRatio = codeChars / len;
  const whitespaceRatio = whitespace / len;

  if (jsonLike || codeRatio > 0.1) return codeRatio > 0.1 ? "code" : "structured";
  if (whitespaceRatio > 0.3) return "whitespace_heavy";
  return "prose";
}

export function estimateTokensV2(text: string): number {
  if (!text) return 0;
  const len = text.length;
  if (len === 0) return 0;

  const textType = classifyTextType(text);
  const charsPerToken = CHARS_PER_TOKEN[textType];
  const baseTokens = Math.ceil(len / charsPerToken);

  return baseTokens + FRAMING_OVERHEAD;
}
