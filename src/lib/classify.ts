// src/lib/classify.ts
import type { Config } from "./config.js";
import type { ModeProfile } from "./profiles.js";

export function classifyPrompt(prompt: string, config: Config, profile: ModeProfile): "trivial" | "standard" | "complex" {
  const stripped = prompt.trim().toLowerCase().replace(/[!?.,]+$/, "");

  const hasCode = prompt.includes("```");
  const hasPath = /[/\\][\w.-]+[/\\]/.test(prompt);
  const hasSlashCmd = prompt.trimStart().startsWith("/");
  if (prompt.length > 150 || hasCode || hasPath || hasSlashCmd) return "complex";

  // Combine profile trivial patterns with custom patterns from config
  const patterns = [
    ...profile.trivialPatterns,
    ...config.hooks.customTrivialPatterns.map(s => new RegExp(s, "i")),
  ];

  // Check if any pattern matches
  for (const pattern of patterns) {
    if (pattern.test(stripped)) return "trivial";
  }

  // Fallback to short length check
  if (stripped.length < 8) return "trivial";

  return "standard";
}
