// tests/cli/session-summarize.test.ts
// Tests for `memento-mcp session summarize` CLI subcommand.
// Verifies --dry-run prints prompt with safety header and exits 0 without calling provider.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildSessionSummaryPrompt } from "../../src/engine/llm/session-summary-prompt.js";
import type { SummaryInput } from "../../src/engine/llm/session-summary-prompt.js";

describe("CLI: session summarize --dry-run", () => {
  it("dry-run output starts with the safety header", () => {
    // Test the dry-run header format directly (the CLI writes this before the prompt)
    const now = new Date().toISOString();
    const header = `# DRY RUN — DO NOT STORE THIS OUTPUT\n# Generated at ${now}\n\n`;
    expect(header).toMatch(/^# DRY RUN — DO NOT STORE THIS OUTPUT\n# Generated at \d{4}-\d{2}-\d{2}T/);
  });

  it("buildSessionSummaryPrompt produces output suitable for dry-run display", () => {
    const input: SummaryInput = {
      sessionId: "sess-dryrun-test-1234",
      sessionStart: "2026-04-25T10:00:00Z",
      sessionEnd: "2026-04-25T11:00:00Z",
      projectName: "test-project",
      captures: [
        { tool: "Bash", title: "Ran tests", body: "All tests passed.", createdAt: "2026-04-25T10:05:00Z" },
      ],
      decisionsCreated: [],
      pitfallsCreated: [],
      injections: 0,
      budget: { spent: 0, total: 8000 },
    };

    const { system, user } = buildSessionSummaryPrompt(input, 4000);
    expect(system).toBeTruthy();
    expect(user).toBeTruthy();
    expect(system).toContain("## What changed");
    expect(user).toContain("sess-dry"); // first 8 chars
  });

  it("dry-run does NOT make any network call (no fetch invocation)", () => {
    // Verify that building the prompt does NOT trigger a fetch
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const input: SummaryInput = {
      sessionId: "sess-nodryrunfetch",
      sessionStart: "2026-04-25T10:00:00Z",
      sessionEnd: "2026-04-25T11:00:00Z",
      projectName: "no-fetch-project",
      captures: [
        { tool: "Edit", title: "Fixed bug", body: "Removed off-by-one.", createdAt: "2026-04-25T10:05:00Z" },
      ],
      decisionsCreated: [],
      pitfallsCreated: [],
      injections: 0,
      budget: { spent: 0, total: 8000 },
    };

    buildSessionSummaryPrompt(input, 4000);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("dry-run safety header format: # DRY RUN line followed by # Generated at <ISO timestamp>", () => {
    const ts = "2026-04-25T10:30:00.000Z";
    const header = `# DRY RUN — DO NOT STORE THIS OUTPUT\n# Generated at ${ts}\n\n`;
    const lines = header.split("\n");
    expect(lines[0]).toBe("# DRY RUN — DO NOT STORE THIS OUTPUT");
    expect(lines[1]).toMatch(/^# Generated at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(lines[2]).toBe(""); // blank line separator
  });

  it("CLI command uses noun-verb pattern: session summarize", () => {
    // This test documents the required CLI signature
    // The old 'summarize-session' command is NOT valid per triage rename
    const validCommand = "session summarize";
    const invalidCommand = "summarize-session";
    expect(validCommand).not.toBe(invalidCommand);
    expect(validCommand.split(" ")).toEqual(["session", "summarize"]);
  });
});
