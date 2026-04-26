// tests/tools/decisions-pitfalls-extra.test.ts
// Extra coverage for decisions-log.ts and pitfalls-log.ts beyond the happy paths
// already tested in decisions-pitfalls.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { DecisionsRepo } from "../../src/db/decisions.js";
import { PitfallsRepo } from "../../src/db/pitfalls.js";
import { handleDecisionsLog } from "../../src/tools/decisions-log.js";
import { handlePitfallsLog } from "../../src/tools/pitfalls-log.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("decisions tool — branch coverage", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: DecisionsRepo;
  const dbPath = join(tmpdir(), `memento-dec-extra-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); repo = new DecisionsRepo(db); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("rejects missing body on store", async () => {
    const r = await handleDecisionsLog(repo, {
      action: "store", project_path: "/p", title: "no body",
    });
    expect(r).toContain("required");
  });

  it("list returns 'No decisions found.' when empty", async () => {
    const r = await handleDecisionsLog(repo, { action: "list", project_path: "/p" });
    expect(r).toBe("No decisions found.");
  });

  it("search rejects missing query", async () => {
    const r = await handleDecisionsLog(repo, { action: "search", project_path: "/p" });
    expect(r).toContain("required");
  });

  it("search returns 'No decisions found.' when empty", async () => {
    const r = await handleDecisionsLog(repo, { action: "search", project_path: "/p", query: "anything" });
    expect(r).toBe("No decisions found.");
  });

  it("search returns matching decision", async () => {
    await handleDecisionsLog(repo, {
      action: "store", project_path: "/p", title: "Use Postgres",
      body: "Adopt Postgres over MySQL for relational store.",
      category: "database",
    });
    const r = await handleDecisionsLog(repo, {
      action: "search", project_path: "/p", query: "Postgres",
    });
    expect(r).toContain("Use Postgres");
    expect(r).toContain("[database]");
  });

  it("rejects invalid action", async () => {
    const r = await handleDecisionsLog(repo, { action: "frobnicate", project_path: "/p" });
    expect(r).toContain("Invalid action");
  });

  it("list includes category and importance fields", async () => {
    await handleDecisionsLog(repo, {
      action: "store", project_path: "/p", title: "D1", body: "rationale",
      category: "arch", importance: 0.9,
    });
    const r = await handleDecisionsLog(repo, { action: "list", project_path: "/p" });
    expect(r).toContain("[arch]");
    expect(r).toContain("Importance:");
  });

  it("supersedes_id is forwarded to repo", async () => {
    const first = await handleDecisionsLog(repo, {
      action: "store", project_path: "/p", title: "Old", body: "old body",
    });
    const oldId = first.split("ID: ")[1].trim();
    const r = await handleDecisionsLog(repo, {
      action: "store", project_path: "/p", title: "New", body: "new body",
      supersedes_id: oldId,
    });
    expect(r).toContain("Decision stored with ID:");
  });
});

describe("pitfalls tool — branch coverage", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: PitfallsRepo;
  const dbPath = join(tmpdir(), `memento-pit-extra-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); repo = new PitfallsRepo(db); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("rejects missing body on store", async () => {
    const r = await handlePitfallsLog(repo, {
      action: "store", project_path: "/p", title: "no body",
    });
    expect(r).toContain("required");
  });

  it("list returns 'No pitfalls found.' when empty", async () => {
    const r = await handlePitfallsLog(repo, { action: "list", project_path: "/p" });
    expect(r).toBe("No pitfalls found.");
  });

  it("list shows occurrence count for unresolved pitfalls", async () => {
    await handlePitfallsLog(repo, {
      action: "store", project_path: "/p", title: "Bug 1", body: "details",
    });
    const r = await handlePitfallsLog(repo, { action: "list", project_path: "/p" });
    expect(r).toContain("[x1]");
    expect(r).toContain("Bug 1");
  });

  it("list includes resolved pitfalls when include_resolved=true", async () => {
    const storeR = await handlePitfallsLog(repo, {
      action: "store", project_path: "/p", title: "Resolved bug", body: "d",
    });
    const id = storeR.split("ID: ")[1].trim();
    await handlePitfallsLog(repo, { action: "resolve", project_path: "/p", pitfall_id: id });

    const without = await handlePitfallsLog(repo, { action: "list", project_path: "/p" });
    expect(without).not.toContain("Resolved bug");

    const withResolved = await handlePitfallsLog(repo, {
      action: "list", project_path: "/p", include_resolved: true,
    });
    expect(withResolved).toContain("Resolved bug");
    expect(withResolved).toContain("[RESOLVED]");
  });

  it("resolve rejects missing pitfall_id", async () => {
    const r = await handlePitfallsLog(repo, { action: "resolve", project_path: "/p" });
    expect(r).toContain("required");
  });

  it("resolve reports not found for unknown id", async () => {
    const r = await handlePitfallsLog(repo, {
      action: "resolve", project_path: "/p", pitfall_id: "ghost-id",
    });
    expect(r).toContain("not found");
  });

  it("rejects invalid action", async () => {
    const r = await handlePitfallsLog(repo, { action: "delete", project_path: "/p" });
    expect(r).toContain("Invalid action");
  });
});
