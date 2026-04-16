// tests/lib/file-memory.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileMemories, searchFileMemories } from "../../src/lib/file-memory.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("file-memory", () => {
  const baseDir = join(tmpdir(), `memento-filemem-test-${Date.now()}`);
  const projectDir = join(baseDir, "-home-user-myproject", "memory");

  beforeEach(() => {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "user_role.md"), `---
name: user_role
description: Developer role info
type: fact
---

The user is a senior developer.`);
    writeFileSync(join(projectDir, "MEMORY.md"), "# index file - should be skipped");
  });

  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  it("reads .md files with frontmatter", () => {
    const mems = readFileMemories("/home/user/myproject", baseDir);
    expect(mems.length).toBe(1);
    expect(mems[0].title).toBe("user_role");
    expect(mems[0].memory_type).toBe("fact");
    expect(mems[0].body).toContain("senior developer");
  });

  it("skips MEMORY.md", () => {
    const mems = readFileMemories("/home/user/myproject", baseDir);
    expect(mems.every(m => !m.body.includes("index file"))).toBe(true);
  });

  it("returns empty for non-existent project", () => {
    expect(readFileMemories("/nope", baseDir)).toEqual([]);
  });

  it("search returns ranked results", () => {
    const results = searchFileMemories("senior developer", "/home/user/myproject", baseDir);
    expect(results.length).toBe(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("search returns empty for non-matching query", () => {
    expect(searchFileMemories("kubernetes", "/home/user/myproject", baseDir)).toEqual([]);
  });
});
