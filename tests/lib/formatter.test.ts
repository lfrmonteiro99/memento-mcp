// tests/lib/formatter.test.ts
import { describe, it, expect } from "vitest";
import { formatIndex, formatFull, formatDetail } from "../../src/lib/formatter.js";

const memory = {
  id: "ea6f7a28-69e3-4368-962c-e7da68d0ffdd",
  title: "User profile",
  body: "Luis Monteiro, developer at Sinmetro. " + "x".repeat(300),
  memory_type: "fact",
  source: "sqlite",
  score: 0.85,
  created_at: "2026-04-01T15:26:18Z",
};

describe("formatIndex", () => {
  it("returns compact one-line format with full ID", () => {
    const out = formatIndex([memory]);
    expect(out).toContain("[fact]");
    expect(out).toContain("User profile");
    expect(out).toContain("0.85");
    expect(out).toContain("ea6f7a28-69e3-4368-962c-e7da68d0ffdd");
    expect(out).not.toContain("Sinmetro"); // no body
  });
});

describe("formatFull", () => {
  it("includes body preview truncated to N chars", () => {
    const out = formatFull([memory], 200);
    expect(out).toContain("Sinmetro");
    expect(out).toContain("...");
    // formatFull now includes token cost markers and footer, so check that body is truncated
    expect(out).not.toContain(memory.body); // full body should not be present (it's truncated)
  });
});

describe("formatDetail", () => {
  it("returns complete body without truncation", () => {
    const out = formatDetail(memory);
    expect(out).toContain(memory.body); // full body, no truncation
  });
});
