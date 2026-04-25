// src/engine/llm/session-summary-prompt.ts
// Prompt construction for LLM-assisted session summarization.

import { estimateTokensV2 } from "../token-estimator.js";
import { scrubSecrets } from "../text-utils.js";
import { redactPrivate } from "../privacy.js";

export interface SummaryInput {
  sessionId: string;
  sessionStart: string;
  sessionEnd: string;
  projectName: string;
  captures: Array<{ tool: string; title: string; body: string; createdAt: string }>;
  decisionsCreated: Array<{ title: string; body: string }>;
  pitfallsCreated: Array<{ title: string; body: string }>;
  injections: number;
  budget: { spent: number; total: number };
}

export const SESSION_SUMMARY_SYSTEM_PROMPT = `
You distill coding-session activity into a structured memory note.
Output STRICTLY in this format (no preamble, no JSON, no closing remarks):

## What changed
- bullet list of concrete changes (files edited, commands run, fixes landed)

## Decisions
- bullet list of choices made and why; if none, write "(none)"

## Blockers
- bullet list of unresolved issues hit during the session; if none, write "(none)"

## Open questions
- bullet list of things to revisit; if none, write "(none)"

Rules:
- Be terse. Aim for under 400 words total.
- Reference specific files, function names, error messages where possible.
- Do not invent things not present in the input.
- Skip obviously trivial actions (cd, ls, pwd).
- Never include API keys, passwords, or content inside <private>...</private> tags.
`.trim();

export function buildSessionSummaryPrompt(
  input: SummaryInput,
  maxInputTokens: number
): { system: string; user: string } {
  const lines: string[] = [];
  lines.push(`# Session ${input.sessionId.slice(0, 8)} on project "${input.projectName}"`);
  lines.push(`Duration: ${input.sessionStart} → ${input.sessionEnd}`);
  lines.push(`Memories injected: ${input.injections}`);
  lines.push(`Budget: ${input.budget.spent}/${input.budget.total} tokens`);
  lines.push("");
  lines.push("## Auto-captured during this session");

  for (const c of input.captures) {
    // Scrub each capture individually before adding to prompt
    const safeTitle = scrubSecrets(redactPrivate(c.title));
    const safeBody = scrubSecrets(redactPrivate(c.body));
    lines.push(`- [${c.tool}] ${safeTitle}`);
    if (safeBody) {
      lines.push(`  ${safeBody.slice(0, 240).replace(/\n/g, " ")}`);
    }
  }

  if (input.decisionsCreated.length > 0) {
    lines.push("");
    lines.push("## Decisions logged");
    for (const d of input.decisionsCreated) {
      const safeTitle = scrubSecrets(redactPrivate(d.title));
      const safeBody = scrubSecrets(redactPrivate(d.body));
      lines.push(`- ${safeTitle}: ${safeBody.slice(0, 240).replace(/\n/g, " ")}`);
    }
  }

  if (input.pitfallsCreated.length > 0) {
    lines.push("");
    lines.push("## Pitfalls logged");
    for (const p of input.pitfallsCreated) {
      const safeTitle = scrubSecrets(redactPrivate(p.title));
      const safeBody = scrubSecrets(redactPrivate(p.body));
      lines.push(`- ${safeTitle}: ${safeBody.slice(0, 240).replace(/\n/g, " ")}`);
    }
  }

  let user = lines.join("\n");

  // Truncate by token estimate (using estimateTokensV2, not a 4-char heuristic).
  // We approximate: run a bisection to find the char cut where estimated tokens <= maxInputTokens.
  // Simple approach: use the chars-per-token ratio from the estimator.
  // estimateTokensV2 uses ~3.0–4.5 chars/token depending on content type.
  // We compute the actual token estimate for the full string and truncate proportionally.
  const fullTokens = estimateTokensV2(user);
  if (fullTokens > maxInputTokens) {
    // Proportional char budget: chars * (maxInputTokens / fullTokens)
    const charBudget = Math.floor(user.length * (maxInputTokens / fullTokens));
    user = user.slice(0, charBudget) + "\n\n[truncated due to budget]";
  }

  // CRITICAL: re-scrub AFTER truncation in case the cut split a <private> tag
  // (triage bug #2: partial tag like "<private>secret</priv" won't match the full regex)
  user = scrubSecrets(redactPrivate(user));

  return { system: SESSION_SUMMARY_SYSTEM_PROMPT, user };
}
