// src/engine/privacy.ts
// Privacy module: <private>...</private> tag redaction and FTS stripping.
//
// IMPORTANT: all exported functions create fresh RegExp instances per call
// (or reset lastIndex) to avoid stateful-global-regex bugs.

const PRIVATE_TAG_PATTERN = "<private>[\\s\\S]*?</private>";

export function redactPrivate(text: string, replacement = "[REDACTED]"): string {
  return text.replace(new RegExp(PRIVATE_TAG_PATTERN, "g"), replacement);
}

export function stripPrivate(text: string): string {
  // For FTS indexing: drop the entire private region so tokens never enter the index.
  return text.replace(new RegExp(PRIVATE_TAG_PATTERN, "g"), " ");
}

export function hasPrivate(text: string): boolean {
  return new RegExp(PRIVATE_TAG_PATTERN, "g").test(text);
}

export interface TagValidation {
  valid: boolean;
  opens: number;
  closes: number;
}

export function validateTags(text: string): TagValidation {
  const opens = (text.match(/<private>/g) ?? []).length;
  const closes = (text.match(/<\/private>/g) ?? []).length;
  return { valid: opens === closes, opens, closes };
}
