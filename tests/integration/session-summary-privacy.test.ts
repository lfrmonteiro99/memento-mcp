// tests/integration/session-summary-privacy.test.ts
// Integration tests: captures with <private>...</private> and api_key=... strings
// produce a prompt with neither, at multiple truncation thresholds.
// Forces cut mid-tag in at least one case (regression test for triage bug #2).

import { describe, it, expect } from "vitest";
import { buildSessionSummaryPrompt } from "../../src/engine/llm/session-summary-prompt.js";
import type { SummaryInput } from "../../src/engine/llm/session-summary-prompt.js";
import { redactPrivate } from "../../src/engine/privacy.js";

const SECRET = "SUPER_SECRET_PRIVATE_VALUE_XYZ789";
const API_KEY = "sk-ant-api-realkey-ABCDEF1234567890";

function makeInput(overrides?: Partial<SummaryInput>): SummaryInput {
  return {
    sessionId: "sess-privacy-test-1234-5678",
    sessionStart: "2026-04-25T09:00:00Z",
    sessionEnd: "2026-04-25T10:00:00Z",
    projectName: "privacy-test-project",
    captures: [
      {
        tool: "Bash",
        title: "Normal capture",
        body: `Some normal output. api_key=${API_KEY} was configured. Build succeeded.`,
        createdAt: "2026-04-25T09:01:00Z",
      },
      {
        tool: "Read",
        title: "Read config file",
        body: `Config loaded. <private>${SECRET}</private> is the internal token. All good.`,
        createdAt: "2026-04-25T09:02:00Z",
      },
    ],
    decisionsCreated: [],
    pitfallsCreated: [],
    injections: 2,
    budget: { spent: 100, total: 8000 },
    ...overrides,
  };
}

describe("Privacy: <private> tag and api_key redaction", () => {
  it("redacts <private> content from prompt at normal budget", () => {
    const { user } = buildSessionSummaryPrompt(makeInput(), 4000);
    expect(user).not.toContain(SECRET);
    expect(user).not.toContain(`<private>`);
    expect(user).not.toContain(`</private>`);
  });

  it("redacts api_key= pattern from prompt at normal budget", () => {
    const { user } = buildSessionSummaryPrompt(makeInput(), 4000);
    expect(user).not.toContain(API_KEY);
    expect(user).not.toContain(`api_key=${API_KEY}`);
  });

  // Test at multiple truncation thresholds to force cut at different positions
  // including mid-<private> tag (the critical regression case)
  const budgets = [20, 30, 40, 50, 60, 80, 100, 150, 200, 500, 4000];

  for (const budget of budgets) {
    it(`secret does NOT appear in prompt at maxInputTokens=${budget}`, () => {
      const { user } = buildSessionSummaryPrompt(makeInput(), budget);
      expect(user, `SECRET leaked at budget=${budget}`).not.toContain(SECRET);
      expect(user, `API key leaked at budget=${budget}`).not.toContain(API_KEY);
    });
  }

  it("forces truncation mid-<private> tag and still redacts", () => {
    // Construct a capture where the <private> tag is positioned so that
    // the truncation boundary falls INSIDE the tag, producing a partial like:
    // "<private>SUPER_SECR" without the closing tag — the post-truncation
    // scrub must catch this.
    const preambleLength = 180; // chars to use up before the private tag
    const preamble = "A".repeat(preambleLength);

    const input = makeInput({
      captures: [
        {
          tool: "Bash",
          title: preamble,
          body: `<private>${SECRET}</private> trailing content here.`,
          createdAt: "2026-04-25T09:01:00Z",
        },
      ],
    });

    // Use very tight budgets to force the cut at various points near the tag
    for (const budget of [30, 40, 50, 60, 80]) {
      const { user } = buildSessionSummaryPrompt(input, budget);
      expect(user, `SECRET leaked mid-tag at budget=${budget}`).not.toContain(SECRET);
    }
  });

  it("LLM response with <private> echoed back is redacted", () => {
    // Simulate the hook applying redactPrivate to the LLM response
    const llmResponse = `## What changed\n- Fixed bug\n\n## Decisions\n- Used <private>${SECRET}</private> as config\n\n## Blockers\n- (none)\n\n## Open questions\n- (none)`;
    const redacted = redactPrivate(llmResponse);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("[REDACTED]");
  });
});

describe("Privacy: decisions and pitfalls redaction", () => {
  it("redacts <private> in decisions", () => {
    const input = makeInput({
      decisionsCreated: [
        { title: "Secret decision", body: `<private>${SECRET}</private> was chosen.` },
      ],
    });
    const { user } = buildSessionSummaryPrompt(input, 4000);
    expect(user).not.toContain(SECRET);
  });

  it("redacts api_key in pitfalls", () => {
    const input = makeInput({
      pitfallsCreated: [
        { title: "Don't hardcode keys", body: `Avoid api_key=${API_KEY} in source.` },
      ],
    });
    const { user } = buildSessionSummaryPrompt(input, 4000);
    expect(user).not.toContain(API_KEY);
  });
});
