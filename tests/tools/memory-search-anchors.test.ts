import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { AnchorsRepo } from "../../src/db/anchors.js";
import { handleMemorySearch } from "../../src/tools/memory-search.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";

describe("memory_search annotates results with anchor_status (P4 Task 7)", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let anchorRepo: AnchorsRepo;
  const dbPath = join(tmpdir(), `memento-search-anc-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    anchorRepo = new AnchorsRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("renders [stale] marker on result whose anchor is stale", async () => {
    const id = memRepo.store({
      title: "ADR-401 OAuth2",
      body: "Use OAuth2 for service-to-service auth",
      memoryType: "decision",
      scope: "global",
    });
    const a = anchorRepo.attach({ memory_id: id, file_path: "src/auth.ts" });
    anchorRepo.markStale(a.id, "10/10 lines modified (100%)");

    const out = await handleMemorySearch(
      memRepo,
      DEFAULT_CONFIG,
      { query: "OAuth2", detail: "index" },
      db,
    );
    expect(out).toMatch(/ADR-401 OAuth2.*\[stale\]|\[stale\].*ADR-401/);
  });

  it("renders [anchor-deleted] when any anchor is anchor-deleted (precedence over stale)", async () => {
    const id = memRepo.store({
      title: "Pitfall: missing null check",
      body: "Always check user.email is non-null before parsing",
      memoryType: "pitfall",
      scope: "global",
    });
    const a1 = anchorRepo.attach({ memory_id: id, file_path: "src/old.ts" });
    const a2 = anchorRepo.attach({ memory_id: id, file_path: "src/new.ts" });
    anchorRepo.markStale(a1.id, "stale");
    anchorRepo.markAnchorDeleted(a2.id, "file removed");

    const out = await handleMemorySearch(
      memRepo,
      DEFAULT_CONFIG,
      { query: "null check", detail: "index" },
      db,
    );
    expect(out).toContain("[anchor-deleted]");
    expect(out).not.toContain("[stale]");
  });

  it("does not annotate memories without anchors", async () => {
    memRepo.store({
      title: "plain note",
      body: "no anchor on this one",
      memoryType: "fact",
      scope: "global",
    });
    const out = await handleMemorySearch(
      memRepo,
      DEFAULT_CONFIG,
      { query: "plain", detail: "index" },
      db,
    );
    expect(out).not.toMatch(/\[(stale|anchor-deleted|fresh)\]/);
  });
});
