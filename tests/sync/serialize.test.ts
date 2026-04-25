// tests/sync/serialize.test.ts
import { describe, it, expect } from "vitest";
import { serializeMemory, parseMemoryFile, parseTags, hashMemoryJson, SCHEMA_VERSION } from "../../src/sync/serialize.js";

describe("sync serialize", () => {
  const baseRow = {
    id: "abc-123",
    memory_type: "decision",
    scope: "team",
    title: "Use Postgres",
    body: "Chose pg over mysql",
    tags: JSON.stringify(["area:db", "architecture"]),
    importance_score: 0.7,
    created_at: "2026-04-25T14:00:00Z",
    updated_at: "2026-04-25T14:00:00Z",
    deleted_at: null,
    supersedes_memory_id: null,
    claude_session_id: null,
    has_private: 0,
  };

  it("serializes to canonical JSON with sorted keys", () => {
    const json = serializeMemory(baseRow, { includePrivate: false });
    const parsed = JSON.parse(json);
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });

  it("output ends with trailing newline and uses 2-space indent", () => {
    const json = serializeMemory(baseRow, { includePrivate: false });
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toContain('\n  "id": "abc-123"');
  });

  it("is deterministic across runs", () => {
    const a = serializeMemory(baseRow, { includePrivate: false });
    const b = serializeMemory(baseRow, { includePrivate: false });
    expect(a).toBe(b);
  });

  it("includes schema_version 1", () => {
    const json = serializeMemory(baseRow, { includePrivate: false });
    expect(JSON.parse(json).schema_version).toBe(1);
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("redacts <private> regions in body when includePrivate=false", () => {
    const row = { ...baseRow, body: "public <private>secret-password</private> more public" };
    const json = serializeMemory(row, { includePrivate: false });
    expect(json).not.toContain("secret-password");
    expect(json).toContain("[REDACTED]");
  });

  it("preserves <private> regions when includePrivate=true", () => {
    const row = { ...baseRow, body: "public <private>secret-password</private> more public" };
    const json = serializeMemory(row, { includePrivate: true });
    expect(json).toContain("secret-password");
  });

  it("scrubs secrets in title", () => {
    const row = { ...baseRow, title: "DB_PASSWORD=hunter2 broken" };
    const json = serializeMemory(row, { includePrivate: false });
    expect(json).not.toContain("hunter2");
    expect(json).toContain("[REDACTED]");
  });

  it("scrubs secrets in tags", () => {
    const row = { ...baseRow, tags: JSON.stringify(["api_key=sk-abc12345abc", "area:db"]) };
    const json = serializeMemory(row, { includePrivate: false });
    expect(json).not.toContain("sk-abc12345abc");
  });

  it("does NOT include source field", () => {
    const row = { ...baseRow, source: "auto-capture" };
    const json = serializeMemory(row, { includePrivate: false });
    expect(JSON.parse(json).source).toBeUndefined();
  });

  it("round-trips through parseMemoryFile", () => {
    const json = serializeMemory(baseRow, { includePrivate: false });
    const parsed = parseMemoryFile(json);
    expect(parsed.id).toBe("abc-123");
    expect(parsed.memory_type).toBe("decision");
    expect(parsed.scope).toBe("team");
  });

  it("parseMemoryFile rejects malformed JSON", () => {
    expect(() => parseMemoryFile("{not json")).toThrow();
  });

  it("parseTags handles JSON array, CSV, and null", () => {
    expect(parseTags(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
    expect(parseTags("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
  });

  it("hashMemoryJson produces a hex digest", () => {
    const json = serializeMemory(baseRow, { includePrivate: false });
    const hash = hashMemoryJson(json);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it("hashMemoryJson is deterministic for same input", () => {
    const json = serializeMemory(baseRow, { includePrivate: false });
    expect(hashMemoryJson(json)).toBe(hashMemoryJson(json));
  });

  it("hashMemoryJson differs for different content", () => {
    const j1 = serializeMemory(baseRow, { includePrivate: false });
    const j2 = serializeMemory({ ...baseRow, body: "different" }, { includePrivate: false });
    expect(hashMemoryJson(j1)).not.toBe(hashMemoryJson(j2));
  });
});
