import { describe, it, expect } from "vitest";
import { formatSummary } from "../../src/lib/formatter.js";

const memory = {
  id: "abc-123",
  title: "UserService auth flow",
  body: "The UserService handles authentication via OAuth2 tokens. It validates JWTs and checks permissions against the RBAC table. Sessions are managed through Redis with a 30-minute TTL.",
  memory_type: "architecture",
  tags: '["auth","service","oauth"]',
  created_at: "2026-04-10T10:00:00Z",
  score: 0.75,
};

describe("formatSummary", () => {
  it("includes title and first 2 sentences of body", () => {
    const out = formatSummary([memory]);
    expect(out).toContain("UserService auth flow");
    expect(out).toContain("OAuth2 tokens");
    expect(out).toContain("validates JWTs");
    // Should NOT include 3rd sentence
    expect(out).not.toContain("Redis");
  });

  it("includes up to 5 tags", () => {
    const out = formatSummary([memory]);
    expect(out).toContain("auth");
    expect(out).toContain("service");
  });

  it("returns 'No results found.' for empty array", () => {
    expect(formatSummary([])).toBe("No results found.");
  });

  it("handles memory with no body", () => {
    const out = formatSummary([{ ...memory, body: undefined }]);
    expect(out).toContain("UserService auth flow");
  });

  it("handles memory with no tags", () => {
    const out = formatSummary([{ ...memory, tags: undefined }]);
    expect(out).toContain("UserService auth flow");
    expect(out).not.toContain("Tags:");
  });
});
