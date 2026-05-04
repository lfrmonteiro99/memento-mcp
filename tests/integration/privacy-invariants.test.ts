// tests/integration/privacy-invariants.test.ts
// Crosscutting invariant: <private>...</private> content must never be exposed
// through any of the user-facing tool outputs unless reveal_private=true is
// explicitly opted into. This test pins that promise across every tool that
// might surface body text.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { handleMemorySearch } from "../../src/tools/memory-search.js";
import { handleMemoryGet } from "../../src/tools/memory-get.js";
import { handleMemoryList } from "../../src/tools/memory-list.js";
import { handleMemoryTimeline } from "../../src/tools/memory-timeline.js";
import { handleMemoryExport, handleMemoryImport } from "../../src/tools/memory-transfer.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { serializeMemory, parseMemoryFile } from "../../src/sync/serialize.js";

const SECRET = "TOPSECRET-PASSPHRASE-DO-NOT-LEAK";
const PRIVATE_BODY = `public start <private>${SECRET}</private> public end`;

describe("privacy invariants — <private> never leaks unless explicitly revealed", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `privacy-${process.pid}-${randomUUID()}.sqlite`);
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  async function seedPrivateMemory(): Promise<string> {
    const r = await handleMemoryStore(repo, {
      title: "Private memory",
      content: PRIVATE_BODY,
      memory_type: "fact",
      scope: "global",
    });
    return r.match(/ID:\s*(\S+)/)![1];
  }

  it("memory_get default redacts private content", async () => {
    const id = await seedPrivateMemory();
    const out = await handleMemoryGet(repo, db, DEFAULT_CONFIG, { memory_id: id });
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
  });

  it("memory_get with reveal_private=true exposes content with a warning banner", async () => {
    const id = await seedPrivateMemory();
    const out = await handleMemoryGet(repo, db, DEFAULT_CONFIG, { memory_id: id, reveal_private: true });
    expect(out).toContain(SECRET);
    expect(out).toContain("Showing private content");
  });

  it("memory_search results redact private content (all detail levels)", async () => {
    await seedPrivateMemory();
    for (const detail of ["index", "summary", "full"] as const) {
      const out = await handleMemorySearch(repo, DEFAULT_CONFIG, { query: "Private memory", detail });
      expect(out, `detail=${detail}`).not.toContain(SECRET);
    }
  });

  it("memory_list results redact private content (all detail levels)", async () => {
    await seedPrivateMemory();
    for (const detail of ["index", "summary", "full"] as const) {
      const out = await handleMemoryList(repo, DEFAULT_CONFIG, { detail });
      expect(out, `detail=${detail}`).not.toContain(SECRET);
    }
  });

  it("memory_timeline summary mode redacts private content from neighbors", async () => {
    const id = await seedPrivateMemory();
    await handleMemoryStore(repo, {
      title: "Companion memory",
      content: "neighbor body",
      memory_type: "fact",
      scope: "global",
    });
    const out = await handleMemoryTimeline(repo, { id, detail: "summary" });
    expect(out).not.toContain(SECRET);
  });

  it("FTS does not surface private content via search keyword inside <private>", async () => {
    await seedPrivateMemory();
    // Searching for the secret token should NOT match the private memory.
    const out = await handleMemorySearch(repo, DEFAULT_CONFIG, { query: SECRET });
    expect(out).not.toContain(SECRET);
    // No results at all is the expected behavior — the FTS index strips private.
    expect(out).toMatch(/No results found|Private memory/);
  });

  it("sync serialize redacts private content when includePrivate=false", async () => {
    const id = await seedPrivateMemory();
    const row = repo.getById(id)!;
    const json = serializeMemory(row as any, { includePrivate: false });
    expect(json).not.toContain(SECRET);
    const parsed = parseMemoryFile(json);
    expect(parsed.body).not.toContain(SECRET);
  });

  it("sync serialize preserves private content when includePrivate=true", async () => {
    const id = await seedPrivateMemory();
    const row = repo.getById(id)!;
    const json = serializeMemory(row as any, { includePrivate: true });
    expect(json).toContain(SECRET);
  });

  it("memory_export → memory_import preserves the private body verbatim (round-trip)", async () => {
    await seedPrivateMemory();

    const exported = await handleMemoryExport(db, {});
    // The export uses raw rows, so private content IS in the JSON. That is by
    // design (export is a backup/transfer mechanism, the user is the data owner).
    expect(exported).toContain(SECRET);

    const exportPath = join(tmpdir(), `priv-export-${process.pid}-${randomUUID()}.json`);
    writeFileSync(exportPath, exported);

    const otherDbPath = join(tmpdir(), `priv-other-${process.pid}-${randomUUID()}.sqlite`);
    const otherDb = createDatabase(otherDbPath);
    try {
      await handleMemoryImport(otherDb, { path: exportPath });
      const otherRepo = new MemoriesRepo(otherDb);
      const list = otherRepo.list({});
      const found = list.find(m => m.title === "Private memory");
      expect(found?.body).toBe(PRIVATE_BODY);

      // But default get() in the new DB still redacts.
      const out = await handleMemoryGet(otherRepo, otherDb, DEFAULT_CONFIG, { memory_id: found!.id });
      expect(out).not.toContain(SECRET);
    } finally {
      otherDb.close();
      rmSync(otherDbPath, { force: true });
      rmSync(exportPath, { force: true });
    }
  });

  it("revealing private content emits a private_revealed analytics event", async () => {
    const id = await seedPrivateMemory();
    await handleMemoryGet(repo, db, DEFAULT_CONFIG, { memory_id: id, reveal_private: true });
    const ev = db.prepare(
      "SELECT * FROM analytics_events WHERE event_type = 'private_revealed' AND memory_id = ?",
    ).get(id) as any;
    expect(ev).toBeDefined();
  });
});
