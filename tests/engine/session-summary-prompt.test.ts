// tests/engine/session-summary-prompt.test.ts
// Tests for src/engine/llm/session-summary-prompt.ts

import { describe, it, expect } from "vitest";
import {
  buildSessionSummaryPrompt,
  SESSION_SUMMARY_SYSTEM_PROMPT,
} from "../../src/engine/llm/session-summary-prompt.js";
import type { SummaryInput } from "../../src/engine/llm/session-summary-prompt.js";

const baseInput: SummaryInput = {
  sessionId: "sess-abc12345-6789-abcd-efgh",
  sessionStart: "2026-04-25T10:00:00Z",
  sessionEnd: "2026-04-25T11:30:00Z",
  projectName: "my-project",
  captures: [
    { tool: "Bash", title: "Ran tests", body: "All 42 tests passed.", createdAt: "2026-04-25T10:05:00Z" },
    { tool: "Edit", title: "Fixed bug in parser.ts", body: "Removed off-by-one error in tokenizer.", createdAt: "2026-04-25T10:30:00Z" },
  ],
  decisionsCreated: [
    { title: "Use strict mode", body: "Enables strict TypeScript checking." },
  ],
  pitfallsCreated: [
    { title: "Don't use var", body: "Always use const/let." },
  ],
  injections: 3,
  budget: { spent: 200, total: 8000 },
};

describe("SESSION_SUMMARY_SYSTEM_PROMPT", () => {
  it("contains all four required sections", () => {
    expect(SESSION_SUMMARY_SYSTEM_PROMPT).toContain("## What changed");
    expect(SESSION_SUMMARY_SYSTEM_PROMPT).toContain("## Decisions");
    expect(SESSION_SUMMARY_SYSTEM_PROMPT).toContain("## Blockers");
    expect(SESSION_SUMMARY_SYSTEM_PROMPT).toContain("## Open questions");
  });

  it("mentions private tag rule", () => {
    expect(SESSION_SUMMARY_SYSTEM_PROMPT).toContain("<private>");
  });
});

describe("buildSessionSummaryPrompt", () => {
  it("returns system = SESSION_SUMMARY_SYSTEM_PROMPT", () => {
    const { system } = buildSessionSummaryPrompt(baseInput, 4000);
    expect(system).toBe(SESSION_SUMMARY_SYSTEM_PROMPT);
  });

  it("user prompt contains session ID prefix", () => {
    const { user } = buildSessionSummaryPrompt(baseInput, 4000);
    expect(user).toContain("sess-abc"); // first 8 chars of sessionId
  });

  it("user prompt contains project name", () => {
    const { user } = buildSessionSummaryPrompt(baseInput, 4000);
    expect(user).toContain("my-project");
  });

  it("user prompt contains capture tool and title", () => {
    const { user } = buildSessionSummaryPrompt(baseInput, 4000);
    expect(user).toContain("[Bash]");
    expect(user).toContain("Ran tests");
    expect(user).toContain("[Edit]");
    expect(user).toContain("Fixed bug in parser.ts");
  });

  it("user prompt contains decisions section when present", () => {
    const { user } = buildSessionSummaryPrompt(baseInput, 4000);
    expect(user).toContain("## Decisions logged");
    expect(user).toContain("Use strict mode");
  });

  it("user prompt contains pitfalls section when present", () => {
    const { user } = buildSessionSummaryPrompt(baseInput, 4000);
    expect(user).toContain("## Pitfalls logged");
    expect(user).toContain("Don't use var");
  });

  it("omits decisions/pitfalls sections when empty", () => {
    const input: SummaryInput = { ...baseInput, decisionsCreated: [], pitfallsCreated: [] };
    const { user } = buildSessionSummaryPrompt(input, 4000);
    expect(user).not.toContain("## Decisions logged");
    expect(user).not.toContain("## Pitfalls logged");
  });

  it("truncates when full content exceeds maxInputTokens", () => {
    // Generate a huge input
    const bigInput: SummaryInput = {
      ...baseInput,
      captures: Array.from({ length: 100 }, (_, i) => ({
        tool: "Bash",
        title: `Capture ${i} with some lengthy title text here`,
        body: "A".repeat(300),
        createdAt: "2026-04-25T10:00:00Z",
      })),
    };
    const { user } = buildSessionSummaryPrompt(bigInput, 50); // very tight budget
    expect(user).toContain("[truncated due to budget]");
  });

  it("does not truncate when content fits within maxInputTokens", () => {
    // Small input easily fits 4000 tokens
    const { user } = buildSessionSummaryPrompt(baseInput, 4000);
    expect(user).not.toContain("[truncated due to budget]");
  });

  // ----- CRITICAL: post-truncation private-tag leak regression test (Triage Bug #2) -----

  it("does NOT leak private content when truncation cuts mid <private> tag", () => {
    const secret = "SUPER_SECRET_VALUE_12345";
    // Place <private>secret</private> near the truncation boundary so the cut
    // can fall inside the tag, leaving a partial like "<private>SUPER_SECRET_VALUE_123"
    // The post-truncation scrub must catch this.
    const privateBody = `Normal content. <private>${secret}</private> more content after.`;

    // Build a large preamble so the truncation boundary falls near the private tag
    const preamble = "X".repeat(200);
    const input: SummaryInput = {
      ...baseInput,
      captures: [
        { tool: "Bash", title: preamble, body: privateBody, createdAt: "2026-04-25T10:00:00Z" },
        // Add more captures to push total over budget
        ...Array.from({ length: 20 }, (_, i) => ({
          tool: "Edit",
          title: `Extra capture ${i} with some content`,
          body: "B".repeat(200),
          createdAt: "2026-04-25T10:00:00Z",
        })),
      ],
      decisionsCreated: [],
      pitfallsCreated: [],
    };

    // Try multiple tight budgets to force cut at different positions around the private tag
    const budgets = [30, 40, 50, 60, 80, 100, 150];
    for (const budget of budgets) {
      const { user } = buildSessionSummaryPrompt(input, budget);
      expect(user, `secret leaked at budget=${budget}`).not.toContain(secret);
      // The partial tag itself should not be present either
      // (either fully redacted or truncated before the tag begins)
    }
  });

  it("redacts <private> tags in individual captures before truncation", () => {
    const input: SummaryInput = {
      ...baseInput,
      captures: [
        {
          tool: "Bash",
          title: "Test with private",
          body: "Before. <private>hidden content</private> After.",
          createdAt: "2026-04-25T10:00:00Z",
        },
      ],
    };
    const { user } = buildSessionSummaryPrompt(input, 4000);
    expect(user).not.toContain("hidden content");
    expect(user).toContain("[REDACTED]");
  });

  it("scrubs api_key= patterns from captures", () => {
    const input: SummaryInput = {
      ...baseInput,
      captures: [
        {
          tool: "Bash",
          title: "Setup env",
          body: "Run with api_key=sk-abc123xyz in the config.",
          createdAt: "2026-04-25T10:00:00Z",
        },
      ],
    };
    const { user } = buildSessionSummaryPrompt(input, 4000);
    expect(user).not.toContain("sk-abc123xyz");
    expect(user).toContain("[REDACTED]");
  });
});
