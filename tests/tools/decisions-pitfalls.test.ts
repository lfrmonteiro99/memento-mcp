// tests/tools/decisions-pitfalls.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { DecisionsRepo } from "../../src/db/decisions.js";
import { PitfallsRepo } from "../../src/db/pitfalls.js";
import { handleDecisionsLog } from "../../src/tools/decisions-log.js";
import { handlePitfallsLog } from "../../src/tools/pitfalls-log.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("decisions tool", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: DecisionsRepo;
  const dbPath = join(tmpdir(), `memento-dec-tools-${Date.now()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); repo = new DecisionsRepo(db); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("store returns ID", async () => {
    const r = await handleDecisionsLog(repo, { action: "store", project_path: "/p", title: "Use TS", body: "Chose TypeScript" });
    expect(r).toContain("Decision stored with ID:");
  });

  it("store rejects missing title", async () => {
    const r = await handleDecisionsLog(repo, { action: "store", project_path: "/p", body: "no title" });
    expect(r).toContain("required");
  });

  it("list returns stored decisions", async () => {
    await handleDecisionsLog(repo, { action: "store", project_path: "/p", title: "D1", body: "body1" });
    const r = await handleDecisionsLog(repo, { action: "list", project_path: "/p" });
    expect(r).toContain("D1");
  });
});

describe("pitfalls tool", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: PitfallsRepo;
  const dbPath = join(tmpdir(), `memento-pit-tools-${Date.now()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); repo = new PitfallsRepo(db); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("store returns ID", async () => {
    const r = await handlePitfallsLog(repo, { action: "store", project_path: "/p", title: "Bug X", body: "details" });
    expect(r).toContain("Pitfall logged");
  });

  it("resolve works", async () => {
    const storeR = await handlePitfallsLog(repo, { action: "store", project_path: "/p", title: "Bug", body: "d" });
    const id = storeR.split("ID: ")[1];
    const r = await handlePitfallsLog(repo, { action: "resolve", project_path: "/p", pitfall_id: id });
    expect(r).toContain("resolved");
  });
});
