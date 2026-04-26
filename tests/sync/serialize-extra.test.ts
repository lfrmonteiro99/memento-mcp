// tests/sync/serialize-extra.test.ts
// Branch coverage for src/sync/serialize.ts: every type-fallback branch in
// serializeMemory and parseMemoryFile, including missing/null/non-string values.
import { describe, it, expect } from "vitest";
import { serializeMemory, parseMemoryFile, parseTags } from "../../src/sync/serialize.js";

describe("serializeMemory — type fallbacks", () => {
  it("substitutes safe defaults when DB row fields are missing or wrong type", () => {
    const out = serializeMemory({}, { includePrivate: true });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      schema_version: 1,
      id: "",
      memory_type: "fact",
      scope: "team",
      title: "",
      body: null,
      tags: [],
      importance_score: 0.5,
      created_at: "",
      updated_at: "",
      deleted_at: null,
      supersedes_memory_id: null,
      claude_session_id: null,
      has_private: 0,
    });
  });

  it("coerces non-null deleted_at / supersedes_memory_id / claude_session_id via String()", () => {
    const out = serializeMemory({
      id: 42,
      title: "T",
      body: "B",
      deleted_at: 1700000000000,
      supersedes_memory_id: 7,
      claude_session_id: 99,
      importance_score: 0.9,
      has_private: 1,
    }, { includePrivate: true });
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe("42");
    expect(parsed.deleted_at).toBe("1700000000000");
    expect(parsed.supersedes_memory_id).toBe("7");
    expect(parsed.claude_session_id).toBe("99");
    expect(parsed.importance_score).toBe(0.9);
    expect(parsed.has_private).toBe(1);
  });

  it("falls back importance_score to 0.5 when not a number", () => {
    const out = serializeMemory({ importance_score: "bad" }, { includePrivate: true });
    expect(JSON.parse(out).importance_score).toBe(0.5);
  });

  it("falls back has_private to 0 when not a number", () => {
    const out = serializeMemory({ has_private: "yes" }, { includePrivate: true });
    expect(JSON.parse(out).has_private).toBe(0);
  });

  it("body=null pass-through is preserved", () => {
    const out = serializeMemory({ body: null }, { includePrivate: false });
    expect(JSON.parse(out).body).toBeNull();
  });
});

describe("parseMemoryFile — type fallbacks", () => {
  it("rejects non-object JSON (string, null)", () => {
    expect(() => parseMemoryFile('"x"')).toThrow(/JSON object/);
    expect(() => parseMemoryFile("null")).toThrow(/JSON object/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseMemoryFile("{not valid")).toThrow(/invalid JSON/);
  });

  it("substitutes safe defaults for missing fields", () => {
    const m = parseMemoryFile("{}");
    expect(m).toMatchObject({
      schema_version: 1,
      id: "",
      memory_type: "fact",
      scope: "team",
      title: "",
      body: null,
      tags: [],
      importance_score: 0.5,
      deleted_at: null,
      supersedes_memory_id: null,
      claude_session_id: null,
      has_private: 0,
    });
  });

  it("filters non-string entries from the tags array", () => {
    const m = parseMemoryFile(JSON.stringify({ tags: ["a", 7, null, "b", true] }));
    expect(m.tags).toEqual(["a", "b"]);
  });

  it("ignores future schema_version (permissive)", () => {
    const m = parseMemoryFile(JSON.stringify({ schema_version: 999, id: "x" }));
    expect(m.schema_version).toBe(999);
    expect(m.id).toBe("x");
  });

  it("coerces non-null nullable scalars via String()", () => {
    const m = parseMemoryFile(JSON.stringify({
      id: 7,
      deleted_at: 1700000000000,
      supersedes_memory_id: 42,
      claude_session_id: 99,
      body: 12345,
    }));
    expect(m.id).toBe("7");
    expect(m.deleted_at).toBe("1700000000000");
    expect(m.supersedes_memory_id).toBe("42");
    expect(m.claude_session_id).toBe("99");
    expect(m.body).toBe("12345");
  });

  it("falls back importance_score to 0.5 when not a number", () => {
    const m = parseMemoryFile(JSON.stringify({ importance_score: "bad" }));
    expect(m.importance_score).toBe(0.5);
  });

  it("uses provided schema_version when number, defaults to 1 otherwise", () => {
    expect(parseMemoryFile(JSON.stringify({ schema_version: 1 })).schema_version).toBe(1);
    expect(parseMemoryFile(JSON.stringify({ schema_version: "x" })).schema_version).toBe(1);
  });
});

describe("parseTags — input variants", () => {
  it("returns [] for null/undefined/empty", () => {
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags("")).toEqual([]);
  });

  it("filters non-string entries from a passed-in array", () => {
    expect(parseTags(["a", 7 as unknown as string, "b"])).toEqual(["a", "b"]);
  });

  it("recovers from invalid JSON array string by falling back to CSV", () => {
    // Looks like JSON but isn't valid → should fall through to CSV split.
    expect(parseTags("[broken")).toEqual(["[broken"]);
  });

  it("strips empty CSV entries", () => {
    expect(parseTags("a,, b ,c, ")).toEqual(["a", "b", "c"]);
  });
});
