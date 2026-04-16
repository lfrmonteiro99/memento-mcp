import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { PitfallsRepo } from "../../src/db/pitfalls.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("PitfallsRepo", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: PitfallsRepo;
  const dbPath = join(tmpdir(), `memento-pit-test-${Date.now()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); repo = new PitfallsRepo(db); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("stores a pitfall", () => {
    const id = repo.store("/proj", "FTS5 rank normalization", "Ranks need 0-1 normalization");
    const list = repo.list("/proj");
    expect(list.length).toBe(1);
    expect(list[0].occurrence_count).toBe(1);
  });

  it("auto-increments occurrence on duplicate title", () => {
    repo.store("/proj", "Same bug", "First time");
    repo.store("/proj", "Same bug", "Second time — different body");
    const list = repo.list("/proj");
    expect(list.length).toBe(1);
    expect(list[0].occurrence_count).toBe(2);
    expect(list[0].body).toBe("Second time — different body"); // updated
  });

  it("resolves a pitfall", () => {
    const id = repo.store("/proj", "Bug X", "Details");
    expect(repo.resolve(id)).toBe(true);
    const list = repo.list("/proj"); // unresolved only by default
    expect(list.length).toBe(0);
    const listAll = repo.list("/proj", 10, true);
    expect(listAll.length).toBe(1);
    expect(listAll[0].resolved).toBe(1);
  });
});
