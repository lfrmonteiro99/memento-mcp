import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { FileMemoryCache } from "../../src/engine/file-memory-cache.js";

describe("FileMemoryCache", () => {
  const testDir = join(tmpdir(), `memento-filecache-test-${process.pid}-${randomUUID()}`);
  let cache: FileMemoryCache;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    cache = new FileMemoryCache(60_000);
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("reads file memories on first access", () => {
    const path = join(testDir, "test.md");
    writeFileSync(path, "---\nname: Test Memory\ntype: fact\n---\nTest body content");
    const results = cache.getFileMemories([path]);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Test Memory");
    expect(results[0].memory_type).toBe("fact");
  });

  it("returns cached results on second access (same result reference)", () => {
    const path = join(testDir, "cached.md");
    writeFileSync(path, "---\nname: Cached\n---\nBody");
    const first = cache.getFileMemories([path]);
    const second = cache.getFileMemories([path]);
    expect(first).toEqual(second);
    expect(cache.hits()).toBeGreaterThan(0);
  });

  it("invalidates cache when file mtime changes", () => {
    const path = join(testDir, "modified.md");
    writeFileSync(path, "---\nname: Original\n---\nOriginal body");
    const firstRead = cache.getFileMemories([path]);
    expect(firstRead[0].title).toBe("Original");

    writeFileSync(path, "---\nname: Modified\n---\nModified body");
    const future = new Date(Date.now() + 5_000);
    utimesSync(path, future, future);
    const secondRead = cache.getFileMemories([path]);
    expect(secondRead[0].title).toBe("Modified");
  });

  it("handles non-existent files gracefully", () => {
    const results = cache.getFileMemories([join(testDir, "nonexistent.md")]);
    expect(results.length).toBe(0);
  });

  it("handles multiple files", () => {
    writeFileSync(join(testDir, "a.md"), "---\nname: A\n---\nBody A");
    writeFileSync(join(testDir, "b.md"), "---\nname: B\n---\nBody B");
    const results = cache.getFileMemories([join(testDir, "a.md"), join(testDir, "b.md")]);
    expect(results.length).toBe(2);
    expect(results.map(m => m.title).sort()).toEqual(["A", "B"]);
  });

  it("TTL=0 disables caching", () => {
    const path = join(testDir, "nottl.md");
    writeFileSync(path, "---\nname: NoTTL\n---\nBody");
    const zeroCache = new FileMemoryCache(0);
    zeroCache.getFileMemories([path]);
    zeroCache.getFileMemories([path]);
    expect(zeroCache.hits()).toBe(0);
  });
});
