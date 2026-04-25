// tests/tools/memory-get.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryGet } from "../../src/tools/memory-get.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, getDefaultConfigPath } from "../../src/lib/config.js";

const config = loadConfig(getDefaultConfigPath());

describe("handleMemoryGet — privacy redaction (issue #4)", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-get-test-${Date.now()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("default: redacts private content", async () => {
    const id = repo.store({ title: "test", body: "foo <private>bar</private> baz", memoryType: "fact", scope: "global" });
    const result = await handleMemoryGet(repo, db, config, { memory_id: id });
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("bar");
    expect(result).toContain("foo");
    expect(result).toContain("baz");
  });

  it("reveal_private=false (explicit): redacts private content", async () => {
    const id = repo.store({ title: "test", body: "foo <private>bar</private> baz", memoryType: "fact", scope: "global" });
    const result = await handleMemoryGet(repo, db, config, { memory_id: id, reveal_private: false });
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("bar");
  });

  it("reveal_private=true: returns full body with warning banner", async () => {
    const id = repo.store({ title: "test", body: "foo <private>bar</private> baz", memoryType: "fact", scope: "global" });
    const result = await handleMemoryGet(repo, db, config, { memory_id: id, reveal_private: true });
    expect(result).toContain("bar"); // private content visible
    expect(result).toContain("<private>bar</private>"); // tags preserved
    expect(result).toContain("Showing private content");
    expect(result).toContain("Do not share this output");
  });

  it("reveal_private=true: emits analytics_events row with event_type=private_revealed", async () => {
    const id = repo.store({ title: "secret mem", body: "x <private>y</private> z", memoryType: "fact", scope: "global" });
    await handleMemoryGet(repo, db, config, { memory_id: id, reveal_private: true });
    const event = db.prepare("SELECT * FROM analytics_events WHERE event_type = 'private_revealed' AND memory_id = ?").get(id) as any;
    expect(event).toBeDefined();
    const data = JSON.parse(event.event_data);
    expect(data.memory_id).toBe(id);
    expect(data.regions).toBe(1);
  });

  it("reveal_private=true with multiple regions: emits correct region count", async () => {
    const id = repo.store({ title: "multi", body: "a <private>s1</private> b <private>s2</private> c", memoryType: "fact", scope: "global" });
    await handleMemoryGet(repo, db, config, { memory_id: id, reveal_private: true });
    const event = db.prepare("SELECT * FROM analytics_events WHERE event_type = 'private_revealed' AND memory_id = ?").get(id) as any;
    expect(event).toBeDefined();
    const data = JSON.parse(event.event_data);
    expect(data.regions).toBe(2);
  });

  it("reveal_private=true on memory without private content: no warning banner, no analytics event", async () => {
    const id = repo.store({ title: "plain", body: "no secrets here", memoryType: "fact", scope: "global" });
    const result = await handleMemoryGet(repo, db, config, { memory_id: id, reveal_private: true });
    expect(result).not.toContain("Showing private content");
    const event = db.prepare("SELECT * FROM analytics_events WHERE event_type = 'private_revealed' AND memory_id = ?").get(id) as any;
    expect(event).toBeUndefined();
  });

  it("returns 'Memory not found.' for unknown id", async () => {
    const result = await handleMemoryGet(repo, db, config, { memory_id: "nonexistent-id" });
    expect(result).toBe("Memory not found.");
  });

  it("default (no reveal_private param): redacts correctly", async () => {
    const id = repo.store({ title: "default", body: "plain <private>secret</private> text", memoryType: "fact", scope: "global" });
    const result = await handleMemoryGet(repo, db, config, { memory_id: id });
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("secret");
  });
});
