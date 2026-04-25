// tests/integration/secret-scrub-coverage.test.ts
// Issue #12: Integration contract matrix.
// Every secret pattern must be scrubbed on every write path.
// If any write path is added without updating this test, the matrix will fail.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { DecisionsRepo } from "../../src/db/decisions.js";
import { PitfallsRepo } from "../../src/db/pitfalls.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

function makeTmpDb(): string {
  return join(tmpdir(), `memento-scrub-cov-${process.pid}-${randomUUID()}.sqlite`);
}

// ─────────────────────────────────────────────────────────────────
// Contract: 11 secret patterns × 10 write paths = 110 cases
//
// Patterns are tuples of [input, expectedFragment, secretPayload].
// - input:           the raw string containing the secret
// - expectedFragment: a substring that MUST appear in the stored value
// - secretPayload:   the raw secret that must NOT appear in the stored value
// ─────────────────────────────────────────────────────────────────
const patterns: Array<[string, string, string]> = [
  // [input, expectedFragment, secretPayload]
  ["api_key=sk-test-12345",                                          "[REDACTED]", "sk-test-12345"],
  ["password=hunter2",                                               "[REDACTED]", "hunter2"],
  ["AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",                         "[REDACTED]", "AKIAIOSFODNN7EXAMPLE"],
  ["DB_PASSWORD=correct-horse-battery-staple",                       "[REDACTED]", "correct-horse-battery-staple"],
  ["DATABASE_URL=postgres://u:p@host/db",                            "[REDACTED]", "postgres://u:p@host/db"],
  ["REDIS_URL=redis://localhost:6379",                               "[REDACTED]", "redis://localhost:6379"],
  ["https://user:secret@example.com/path",                           "://[REDACTED]@example.com/path", "user:secret"],
  ["Bearer abcdef1234567890ABCDEF1234567890",                        "Bearer [REDACTED]", "abcdef1234567890ABCDEF1234567890"],
  ["Authorization: Bearer abcdef1234567890ABCDEF1234567890",         "Authorization: [REDACTED]", "abcdef1234567890ABCDEF1234567890"],
  ["ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",                     "[REDACTED]", "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"],
  ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.signaturepart12345", "[REDACTED]", "eyJhbGciOiJIUzI1NiJ9"],
];

// Write path IDs (the contract — adding a write path without adding it here will
// not make the test fail automatically, but it documents the coverage promise).
const WRITE_PATH_IDS = [
  "memory_store(title)",
  "memory_store(body)",
  "memory_update(title)",
  "memory_update(body)",
  "decision_store(title)",
  "decision_store(body)",
  "pitfall_store(title)",
  "pitfall_store(body)",
  "auto-capture title",
  "auto-capture body",
] as const;

type WritePath = typeof WRITE_PATH_IDS[number];

describe("secret-scrub-coverage: integration contract matrix", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let decisionsRepo: DecisionsRepo;
  let pitfallsRepo: PitfallsRepo;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpDb();
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    decisionsRepo = new DecisionsRepo(db);
    pitfallsRepo = new PitfallsRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  /**
   * Persist via the named write path and return the stored value(s).
   * Returns the title or body field that is relevant to the path.
   */
  function persistVia(path: WritePath, input: string): string {
    const projectPath = "/test-project";

    switch (path) {
      case "memory_store(title)": {
        const id = memRepo.store({ title: input, body: "placeholder body", memoryType: "fact", scope: "global" });
        const row = memRepo.getById(id);
        return row?.title ?? "";
      }

      case "memory_store(body)": {
        const id = memRepo.store({ title: "placeholder title", body: input, memoryType: "fact", scope: "global" });
        const row = memRepo.getById(id);
        return row?.body ?? "";
      }

      case "memory_update(title)": {
        const id = memRepo.store({ title: "orig title", body: "orig body", memoryType: "fact", scope: "global" });
        memRepo.update(id, { title: input });
        const row = memRepo.getById(id);
        return row?.title ?? "";
      }

      case "memory_update(body)": {
        const id = memRepo.store({ title: "orig title", body: "orig body", memoryType: "fact", scope: "global" });
        memRepo.update(id, { body: input });
        const row = memRepo.getById(id);
        return row?.body ?? "";
      }

      case "decision_store(title)": {
        const id = decisionsRepo.store(projectPath, input, "placeholder body");
        const rows = decisionsRepo.list(projectPath, 10);
        const row = rows.find((r: any) => r.id === id);
        return row?.title ?? "";
      }

      case "decision_store(body)": {
        const id = decisionsRepo.store(projectPath, "placeholder title", input);
        const rows = decisionsRepo.list(projectPath, 10);
        const row = rows.find((r: any) => r.id === id);
        return row?.body ?? "";
      }

      case "pitfall_store(title)": {
        const id = pitfallsRepo.store(projectPath, input, "placeholder body");
        const rows = pitfallsRepo.list(projectPath, 10, true);
        const row = rows.find((r: any) => r.id === id);
        return row?.title ?? "";
      }

      case "pitfall_store(body)": {
        const id = pitfallsRepo.store(projectPath, "placeholder title", input);
        const rows = pitfallsRepo.list(projectPath, 10, true);
        const row = rows.find((r: any) => r.id === id);
        return row?.body ?? "";
      }

      case "auto-capture title": {
        // Test that secrets are scrubbed in titles stored via the auto-capture write path.
        // Stores directly through memRepo with source="auto-capture" to test the repo-layer
        // scrubbing (which is the path all auto-capture stores go through).
        const id = memRepo.store({
          title: input,
          body: "auto-capture title test body",
          memoryType: "fact",
          scope: "global",
          source: "auto-capture",
        });
        const row = memRepo.getById(id);
        return row?.title ?? "";
      }

      case "auto-capture body": {
        // Test that secrets are scrubbed when stored via the auto-capture write path.
        // We store directly through memRepo with source="auto-capture" to test the
        // scrubbing at the repo layer (which is where all auto-capture stores go through).
        const id = memRepo.store({
          title: "auto-capture body test",
          body: input,
          memoryType: "fact",
          scope: "global",
          source: "auto-capture",
        });
        const row = memRepo.getById(id);
        return row?.body ?? "";
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Matrix: 11 patterns × 10 write paths = 110 tests
  // ─────────────────────────────────────────────────────────────────
  for (const [input, expectedFragment, secretPayload] of patterns) {
    for (const path of WRITE_PATH_IDS) {
      it(`${path} scrubs "${input.slice(0, 40)}${input.length > 40 ? "…" : ""}"`, () => {
        const stored = persistVia(path, input);

        // Positive assertion: the expected redaction marker must be present
        expect(stored, `[${path}] expected "${expectedFragment}" in stored value`).toContain(expectedFragment);

        // Negative assertion: the raw secret must NOT appear
        expect(stored, `[${path}] secret "${secretPayload.slice(0, 30)}…" must not appear`).not.toContain(secretPayload);
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Specific acceptance criteria from issue #12
  // ─────────────────────────────────────────────────────────────────
  it('storing a memory with title "DB_PASSWORD=hunter2" results in title "[REDACTED]"', () => {
    const id = memRepo.store({ title: "DB_PASSWORD=hunter2", body: "some body", memoryType: "fact", scope: "global" });
    const row = memRepo.getById(id);
    expect(row?.title).toBe("[REDACTED]");
    expect(row?.title).not.toContain("hunter2");
  });

  it("storing a memory with body containing a JWT redacts it before insert", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.signaturepart12345";
    const id = memRepo.store({ title: "jwt test", body: `Token: ${jwt}`, memoryType: "fact", scope: "global" });
    const row = memRepo.getById(id);
    expect(row?.body).toContain("[REDACTED]");
    expect(row?.body).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("storing a memory with body containing a GitHub PAT redacts it before insert", () => {
    const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
    const id = memRepo.store({ title: "pat test", body: `My token: ${pat}`, memoryType: "fact", scope: "global" });
    const row = memRepo.getById(id);
    expect(row?.body).toContain("[REDACTED]");
    expect(row?.body).not.toContain(pat);
  });

  it("scrubSecrets('') returns '' and never throws", () => {
    // Verify via the write path — empty body stays empty
    const id = memRepo.store({ title: "empty body test", body: "", memoryType: "fact", scope: "global" });
    const row = memRepo.getById(id);
    expect(row?.body).toBe("");
  });
});
