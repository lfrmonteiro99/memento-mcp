// tests/sync/push-pull.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { push, pull, init, status } from "../../src/sync/git-sync.js";
import { DEFAULT_SYNC_CONFIG } from "../../src/lib/config.js";

describe("sync push/pull round-trip", () => {
  let tmpRoot: string;
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-sync-pp-${Date.now()}-${Math.random()}.sqlite`);

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "memento-sync-pp-"));
    db = createDatabase(dbPath);
    init(tmpRoot);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("init creates .memento/ folder with README and .gitignore", () => {
    expect(existsSync(join(tmpRoot, ".memento"))).toBe(true);
    expect(existsSync(join(tmpRoot, ".memento", "README.md"))).toBe(true);
    expect(existsSync(join(tmpRoot, ".memento", ".gitignore"))).toBe(true);
  });

  it("init does NOT delete existing .memento/policy.toml", () => {
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(join(tmpRoot, ".memento"), { recursive: true });
    writeFileSync(join(tmpRoot, ".memento", "policy.toml"), "schema_version = 1\n");
    init(tmpRoot);
    expect(existsSync(join(tmpRoot, ".memento", "policy.toml"))).toBe(true);
  });

  it("push writes a JSON file for each team-scoped memory", async () => {
    const repo = new MemoriesRepo(db);
    const projectId = repo.ensureProject(tmpRoot);
    const id1 = repo.store({ title: "t1", body: "b1", scope: "team", projectId });
    const id2 = repo.store({ title: "t2", body: "b2", scope: "team", projectId });
    repo.store({ title: "t3", body: "b3", scope: "project", projectId }); // not team

    const result = await push({
      db, projectRoot: tmpRoot, dryRun: false, config: DEFAULT_SYNC_CONFIG,
    });

    expect(result.written).toBe(2);
    expect(existsSync(join(tmpRoot, ".memento", "memories", `${id1}.json`))).toBe(true);
    expect(existsSync(join(tmpRoot, ".memento", "memories", `${id2}.json`))).toBe(true);
  });

  it("push --dry-run writes nothing", async () => {
    const repo = new MemoriesRepo(db);
    const projectId = repo.ensureProject(tmpRoot);
    const id = repo.store({ title: "t", body: "b", scope: "team", projectId });

    const result = await push({
      db, projectRoot: tmpRoot, dryRun: true, config: DEFAULT_SYNC_CONFIG,
    });

    expect(result.written).toBe(1);
    expect(existsSync(join(tmpRoot, ".memento", "memories", `${id}.json`))).toBe(false);
  });

  it("push is idempotent — re-running with no changes skips", async () => {
    const repo = new MemoriesRepo(db);
    const projectId = repo.ensureProject(tmpRoot);
    repo.store({ title: "t", body: "b", scope: "team", projectId });

    const r1 = await push({ db, projectRoot: tmpRoot, dryRun: false, config: DEFAULT_SYNC_CONFIG });
    expect(r1.written).toBe(1);

    const r2 = await push({ db, projectRoot: tmpRoot, dryRun: false, config: DEFAULT_SYNC_CONFIG });
    expect(r2.written).toBe(0);
    expect(r2.skipped).toBe(1);
  });

  it("pull creates DB rows from files", async () => {
    const repo = new MemoriesRepo(db);
    const projectId = repo.ensureProject(tmpRoot);
    const id = repo.store({ title: "t", body: "b", scope: "team", projectId });
    await push({ db, projectRoot: tmpRoot, dryRun: false, config: DEFAULT_SYNC_CONFIG });

    // Wipe the memory from DB
    db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    db.prepare("DELETE FROM sync_file_hashes").run();

    const result = await pull({ db, projectRoot: tmpRoot, dryRun: false, config: DEFAULT_SYNC_CONFIG });
    expect(result.created).toBe(1);

    const restored = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as any;
    expect(restored).toBeTruthy();
    expect(restored.title).toBe("t");
  });

  it("pull is idempotent — re-running with no external changes returns 0 changes", async () => {
    const repo = new MemoriesRepo(db);
    const projectId = repo.ensureProject(tmpRoot);
    repo.store({ title: "t", body: "b", scope: "team", projectId });
    await push({ db, projectRoot: tmpRoot, dryRun: false, config: DEFAULT_SYNC_CONFIG });

    const r1 = await pull({ db, projectRoot: tmpRoot, dryRun: false, config: DEFAULT_SYNC_CONFIG });
    const r2 = await pull({ db, projectRoot: tmpRoot, dryRun: false, config: DEFAULT_SYNC_CONFIG });
    expect(r2.created).toBe(0);
    expect(r2.updated).toBe(0);
  });

  it("status reports drift between DB and files", async () => {
    const repo = new MemoriesRepo(db);
    const projectId = repo.ensureProject(tmpRoot);
    repo.store({ title: "t1", body: "b1", scope: "team", projectId });
    await push({ db, projectRoot: tmpRoot, dryRun: false, config: DEFAULT_SYNC_CONFIG });
    repo.store({ title: "t2", body: "b2", scope: "team", projectId }); // db only

    const s = status(db, tmpRoot);
    expect(s.dbOnly.length).toBe(1);
    expect(s.fileOnly.length).toBe(0);
    expect(s.inSync).toBe(1);
  });

  it("file content is canonical (sorted keys, trailing newline)", async () => {
    const repo = new MemoriesRepo(db);
    const projectId = repo.ensureProject(tmpRoot);
    const id = repo.store({ title: "t", body: "b", scope: "team", projectId });
    await push({ db, projectRoot: tmpRoot, dryRun: false, config: DEFAULT_SYNC_CONFIG });

    const text = readFileSync(join(tmpRoot, ".memento", "memories", `${id}.json`), "utf-8");
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text);
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });

  it("schema does NOT include edges field (decoupled from #7)", async () => {
    const repo = new MemoriesRepo(db);
    const projectId = repo.ensureProject(tmpRoot);
    const id = repo.store({ title: "t", body: "b", scope: "team", projectId });
    await push({ db, projectRoot: tmpRoot, dryRun: false, config: DEFAULT_SYNC_CONFIG });

    const text = readFileSync(join(tmpRoot, ".memento", "memories", `${id}.json`), "utf-8");
    const parsed = JSON.parse(text);
    expect(parsed.edges).toBeUndefined();
  });
});
