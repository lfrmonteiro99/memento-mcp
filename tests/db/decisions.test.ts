import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { DecisionsRepo } from "../../src/db/decisions.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("DecisionsRepo", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: DecisionsRepo;
  const dbPath = join(tmpdir(), `memento-dec-test-${Date.now()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); repo = new DecisionsRepo(db); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("stores and lists decisions", () => {
    repo.store("/proj", "Use React", "Frontend framework choice", "architecture");
    const list = repo.list("/proj");
    expect(list.length).toBe(1);
    expect(list[0].title).toBe("Use React");
    expect(list[0].category).toBe("architecture");
  });

  it("searches decisions via FTS5", () => {
    repo.store("/proj", "Use React", "We chose React over Vue", "architecture");
    repo.store("/proj", "Use PostgreSQL", "Relational DB pick", "tooling");
    const results = repo.search("React", "/proj");
    expect(results.length).toBe(1);
    expect(results[0].title).toContain("React");
  });

  it("supersedes previous decision", () => {
    const id1 = repo.store("/proj", "Use MySQL", "First pick", "tooling");
    repo.store("/proj", "Use PostgreSQL", "Changed to PG", "tooling", 0.7, id1);
    const list = repo.list("/proj");
    expect(list.length).toBe(1);
    expect(list[0].title).toBe("Use PostgreSQL");
  });
});
