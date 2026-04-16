// src/lib/classify.ts
import type { Config } from "./config.js";

const BUILTIN_TRIVIAL = new Set([
  "ok","sim","não","yes","no","bora","go","next","done","já","feito",
  "sure","yep","nope","k","thanks","obrigado","confirmo","approved",
  "got it","agreed","proceed","continue","lgtm",
]);

export function classifyPrompt(prompt: string, config: Config): "trivial" | "standard" | "complex" {
  const stripped = prompt.trim().toLowerCase().replace(/[!?.,]+$/, "");

  const hasCode = prompt.includes("```");
  const hasPath = /[/\\][\w.-]+[/\\]/.test(prompt);
  const hasSlashCmd = prompt.trimStart().startsWith("/");
  if (prompt.length > 150 || hasCode || hasPath || hasSlashCmd) return "complex";

  const trivial = new Set([...BUILTIN_TRIVIAL, ...config.hooks.customTrivialPatterns]);
  if (trivial.has(stripped) || stripped.length < 8) return "trivial";

  return "standard";
}
