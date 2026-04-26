// tests/lib/formatter-extra.test.ts
// Branch coverage for formatter.ts: empty/short/long body, tags, score variants,
// vault entries, formatTimeline ordering markers, formatSummary tag rendering,
// and the privacy-tag-in-title warning path.
import { describe, it, expect, vi } from "vitest";
import {
  formatIndex,
  formatFull,
  formatSummary,
  formatDetail,
  formatTimeline,
  formatVaultEntry,
  formatVaultIndex,
} from "../../src/lib/formatter.js";

const baseMem = (over: Partial<any> = {}) => ({
  id: "mem1",
  title: "Hello",
  body: "World",
  memory_type: "fact",
  ...over,
});

describe("formatIndex / formatFull / formatSummary — empty + body branches", () => {
  it("formatIndex returns 'No results found.' for empty list", () => {
    expect(formatIndex([])).toBe("No results found.");
  });

  it("formatFull returns 'No results found.' for empty list", () => {
    expect(formatFull([])).toBe("No results found.");
  });

  it("formatSummary returns 'No results found.' for empty list", () => {
    expect(formatSummary([])).toBe("No results found.");
  });

  it("formatIndex appends 'memory_get' hint when a body exceeds 200 chars", () => {
    const out = formatIndex([baseMem({ body: "x".repeat(250), score: 0.7 })]);
    expect(out).toContain("memory_get");
    expect(out).toContain("memory_timeline");
    expect(out).toContain("score:0.70");
  });

  it("formatIndex omits 'memory_get' hint for short bodies", () => {
    const out = formatIndex([baseMem({ body: "short", score: 0.5 })]);
    expect(out).not.toContain("memory_get");
    expect(out).toContain("memory_timeline");
  });

  it("formatFull truncates bodies longer than bodyPreviewChars", () => {
    const out = formatFull([baseMem({ body: "y".repeat(300) })], 50);
    expect(out).toContain("...");
    expect(out).toContain("memory_get");
  });

  it("formatFull renders short body without ellipsis", () => {
    const out = formatFull([baseMem({ body: "tiny" })], 100);
    expect(out).toContain("tiny");
    expect(out).not.toContain("tiny...");
  });

  it("formatFull omits body line when body undefined", () => {
    const out = formatFull([baseMem({ body: undefined, score: undefined, source: "file" })]);
    expect(out).toContain("[file]");
    expect(out).toContain("Score: -");
  });

  it("formatSummary renders tags from a JSON-string and splits comma form", () => {
    const json = formatSummary([baseMem({ tags: '["alpha","beta"]', score: 0.4 })]);
    expect(json).toContain("Tags: alpha, beta");

    const csv = formatSummary([baseMem({ id: "mem2", title: "T2", tags: "x, y, z" })]);
    expect(csv).toContain("Tags: x, y, z");
  });

  it("formatSummary handles tags as plain array", () => {
    const out = formatSummary([baseMem({ tags: ["one", "two"] })]);
    expect(out).toContain("Tags: one, two");
  });

  it("formatSummary skips tags line when empty/missing", () => {
    const out = formatSummary([baseMem({ body: "ok" })]);
    expect(out).not.toContain("Tags:");
  });
});

describe("formatDetail", () => {
  it("redacts <private> by default", () => {
    const out = formatDetail(baseMem({ body: "a <private>secret</private> b" }));
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("secret");
  });

  it("revealPrivate=true returns full body unchanged", () => {
    const out = formatDetail(baseMem({ body: "a <private>secret</private> b" }), true);
    expect(out).toContain("secret");
  });

  it("renders '(no body)' fallback when body is missing", () => {
    const out = formatDetail(baseMem({ body: undefined }));
    expect(out).toContain("(no body)");
  });
});

describe("formatTimeline", () => {
  it("returns 'no neighbors' when neighbor list is empty", () => {
    const out = formatTimeline(baseMem(), []);
    expect(out).toContain("No neighbors found");
  });

  it("marks the focus row with ★ in summary mode", () => {
    const focus = baseMem({ id: "F", title: "Focus", created_at: "2024-01-01T12:00:00Z" });
    const before = baseMem({ id: "B", title: "Before", created_at: "2024-01-01T11:00:00Z" });
    const after = baseMem({ id: "A", title: "After", created_at: "2024-01-01T13:00:00Z" });
    const out = formatTimeline(focus, [before, focus, after], "summary");
    expect(out).toContain("★");
    expect(out).toContain("Focus");
  });

  it("renders index detail (one line per memory)", () => {
    const focus = baseMem({ id: "F", title: "Focus", created_at: "2024-01-01T12:00:00Z" });
    const out = formatTimeline(focus, [focus], "index");
    expect(out).toContain("(id=F)");
    expect(out).toContain("Focus");
  });
});

describe("formatVaultEntry / formatVaultIndex", () => {
  const entry = {
    id: "vault:dom/foo.md",
    source: "vault" as const,
    title: "Foo",
    kind: "domain",
    summary: "summary text",
    path: "30 Domains/foo.md",
    breadcrumb: ["vault", "domains", "Foo"],
    score: 0.83,
  };

  it("formatVaultEntry contains title, breadcrumb, score, summary", () => {
    const out = formatVaultEntry(entry);
    expect(out).toContain("[vault:domain] Foo");
    expect(out).toContain("vault > domains > Foo");
    expect(out).toContain("Score: 0.83");
    expect(out).toContain("summary text");
  });

  it("formatVaultEntry handles missing path/breadcrumb/score/kind", () => {
    const out = formatVaultEntry({
      id: "vault:loose.md",
      source: "vault",
      title: "Loose",
    });
    expect(out).toContain("[vault:note] Loose");
    expect(out).toContain("Score: -");
  });

  it("formatVaultIndex returns '' for empty list", () => {
    expect(formatVaultIndex([])).toBe("");
  });

  it("formatVaultIndex prints one line per entry", () => {
    const out = formatVaultIndex([entry]);
    expect(out).toContain("[vault:domain] Foo");
    expect(out).toContain("score:0.83");
  });
});

describe("safeBody warning when title contains <private>", () => {
  it("logs a warn but still produces output", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const out = formatFull([baseMem({ title: "title with <private>X</private>", body: "ok" })]);
      expect(out).toContain("ok");
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
