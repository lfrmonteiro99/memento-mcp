// tests/lib/import-formats.test.ts — unit tests for the FORMATS registry,
// covering default-path resolution, walk-up-to-git-root, and per-format read().
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  FORMATS,
  firstExistingPath,
  detectAllInProject,
} from "../../src/lib/import-formats.js";

function makeProject(): string {
  const dir = join(tmpdir(), `formats-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("FORMATS registry", () => {
  it("contains all 8 supported format keys", () => {
    expect(Object.keys(FORMATS).sort()).toEqual([
      "agents-md",
      "claude-md",
      "cline",
      "copilot",
      "cursor",
      "gemini-md",
      "roo",
      "windsurf",
    ]);
  });

  it("each format has a unique source tag prefixed with import-", () => {
    const sources = Object.values(FORMATS).map(f => f.source);
    expect(new Set(sources).size).toBe(sources.length);
    for (const s of sources) expect(s).toMatch(/^import-/);
  });
});

// ---------------------------------------------------------------------------
// Default path resolution
// ---------------------------------------------------------------------------
describe("default path resolution", () => {
  it("claude-md project default is ./CLAUDE.md", () => {
    const r = FORMATS["claude-md"].resolve("project", "/proj", "/home/me");
    expect(r).toEqual(["/proj/CLAUDE.md"]);
  });

  it("claude-md global default is ~/.claude/CLAUDE.md", () => {
    const r = FORMATS["claude-md"].resolve("global", "/proj", "/home/me");
    expect(r).toEqual(["/home/me/.claude/CLAUDE.md"]);
  });

  it("cursor returns dir then legacy file", () => {
    const r = FORMATS["cursor"].resolve("project", "/proj", "/home/me");
    expect(r).toEqual(["/proj/.cursor/rules", "/proj/.cursorrules"]);
  });

  it("gemini-md global default is ~/.gemini/GEMINI.md", () => {
    const r = FORMATS["gemini-md"].resolve("global", "/proj", "/home/me");
    expect(r).toEqual(["/home/me/.gemini/GEMINI.md"]);
  });

  it("windsurf project tries .windsurfrules then global_rules.md", () => {
    const r = FORMATS["windsurf"].resolve("project", "/proj", "/home/me");
    expect(r).toEqual(["/proj/.windsurfrules", "/proj/global_rules.md"]);
  });

  it("windsurf global resolves to ~/.codeium/...", () => {
    const r = FORMATS["windsurf"].resolve("global", "/proj", "/home/me");
    expect(r[0]).toContain(".codeium");
    expect(r[0]).toContain("global_rules.md");
  });

  it("roo project resolves dir then legacy", () => {
    const r = FORMATS["roo"].resolve("project", "/proj", "/home/me");
    expect(r).toEqual(["/proj/.roo/rules", "/proj/.roorules"]);
  });

  it("cline resolves a single .clinerules path", () => {
    const r = FORMATS["cline"].resolve("project", "/proj", "/home/me");
    expect(r).toEqual(["/proj/.clinerules"]);
  });
});

// ---------------------------------------------------------------------------
// Walk-up-to-git-root behavior
// ---------------------------------------------------------------------------
describe("AGENTS.md walk-up", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeProject();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds AGENTS.md at the project root from a nested cwd", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "AGENTS.md"), "## Top\nbody\n");
    const nested = join(dir, "sub", "sub2");
    mkdirSync(nested, { recursive: true });

    const candidates = FORMATS["agents-md"].resolve("project", nested, "/home/me");
    expect(candidates[0]).toBe(join(dir, "AGENTS.md"));
  });

  it("returns the direct path when AGENTS.md is missing entirely", () => {
    const r = FORMATS["agents-md"].resolve("project", dir, "/home/me");
    expect(r[0]).toBe(join(dir, "AGENTS.md"));
  });

  it("does NOT cross the git root", () => {
    // git root at dir/sub; AGENTS.md only at dir (above git root).
    writeFileSync(join(dir, "AGENTS.md"), "## a\nbody\n");
    const sub = join(dir, "sub");
    mkdirSync(join(sub, ".git"), { recursive: true });
    const cwd = join(sub, "deeper");
    mkdirSync(cwd, { recursive: true });

    const r = FORMATS["agents-md"].resolve("project", cwd, "/home/me");
    // The walker stops at sub/.git and never reaches dir/AGENTS.md.
    expect(r[0]).toBe(join(cwd, "AGENTS.md"));
  });
});

// ---------------------------------------------------------------------------
// firstExistingPath
// ---------------------------------------------------------------------------
describe("firstExistingPath", () => {
  let dir: string;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns the first candidate that exists", () => {
    writeFileSync(join(dir, ".cursorrules"), "x");
    const path = firstExistingPath(FORMATS["cursor"], "project", dir, "/home/me");
    // .cursor/rules dir does not exist, so legacy file wins.
    expect(path).toBe(join(dir, ".cursorrules"));
  });

  it("returns the dir when both exist", () => {
    mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(dir, ".cursorrules"), "x");
    const path = firstExistingPath(FORMATS["cursor"], "project", dir, "/home/me");
    expect(path).toBe(join(dir, ".cursor", "rules"));
  });

  it("returns null when no candidate exists", () => {
    expect(firstExistingPath(FORMATS["cursor"], "project", dir, "/home/me")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectAllInProject
// ---------------------------------------------------------------------------
describe("detectAllInProject", () => {
  let dir: string;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns hits in canonical priority order", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "## a\nb\n");
    writeFileSync(join(dir, "AGENTS.md"), "## c\nd\n");
    mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "rules", "r.mdc"), "## x\ny\n");

    const hits = detectAllInProject(dir, "/home/me");
    const keys = hits.map(h => h.spec.key);
    // Canonical: claude-md → cursor → copilot → agents-md → ...
    expect(keys).toEqual(["claude-md", "cursor", "agents-md"]);
  });

  it("returns [] when nothing matches", () => {
    expect(detectAllInProject(dir, "/home/me")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// read() for cursor (dir aggregation + frontmatter)
// ---------------------------------------------------------------------------
describe("cursor.read aggregates .cursor/rules dir", () => {
  let dir: string;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("merges sections from multiple .mdc files in alphabetical order", () => {
    const rulesDir = join(dir, ".cursor", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "auth.mdc"), `---
description: Auth conventions
globs: ["src/api/**/*.ts"]
alwaysApply: true
---
## Always validate JWT signature on entry
Reject unsigned or expired tokens at the route layer.
`);
    writeFileSync(join(rulesDir, "style.mdc"), `## Coding style
We use 2-space indentation throughout.
`);

    const r = FORMATS["cursor"].read(rulesDir, "fact");
    expect(r.sections.length).toBeGreaterThanOrEqual(2);

    // Frontmatter → tags merged into sections from auth.mdc
    const authSection = r.sections.find(s => s.title.includes("[auth.mdc]"))!;
    expect(authSection).toBeDefined();
    expect(authSection.inferredTags).toContain("cursor:always");
    expect(authSection.inferredTags.some(t => t.startsWith("glob:"))).toBe(true);

    // Style section has no glob/always tags from frontmatter (none present)
    const styleSection = r.sections.find(s => s.title.includes("[style.mdc]"))!;
    expect(styleSection).toBeDefined();
    expect(styleSection.inferredTags).not.toContain("cursor:always");
    expect(styleSection.inferredTags.some(t => t.startsWith("glob:"))).toBe(false);

    // Title prefixing
    expect(authSection.title.startsWith("[auth.mdc]")).toBe(true);
    expect(styleSection.title.startsWith("[style.mdc]")).toBe(true);
  });

  it("reads .cursorrules legacy file as plain markdown when no dir present", () => {
    writeFileSync(join(dir, ".cursorrules"), `## Legacy rule
some body content here for the rule.
`);
    const r = FORMATS["cursor"].read(join(dir, ".cursorrules"), "fact");
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].title).toBe("Legacy rule");
    // No frontmatter tags merged (legacy plain markdown)
    expect(r.sections[0].inferredTags.some(t => t.startsWith("glob:"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// read() for copilot (file + dir aggregate)
// ---------------------------------------------------------------------------
describe("copilot.read aggregates instructions dir + sibling file", () => {
  let dir: string;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("combines copilot-instructions.md with .github/instructions/*.md", () => {
    const ghDir = join(dir, ".github");
    mkdirSync(join(ghDir, "instructions"), { recursive: true });
    writeFileSync(join(ghDir, "copilot-instructions.md"), `## Test naming
Test files live next to source as *.test.ts.
`);
    writeFileSync(join(ghDir, "instructions", "api.instructions.md"), `---
applyTo: "src/api/**"
---
## API responses
Always return {data, error} envelope.
`);

    const r = FORMATS["copilot"].read(join(ghDir, "instructions"), "fact");
    expect(r.sections.length).toBe(2);

    const apiSection = r.sections.find(s => s.title.includes("API responses") || s.title.includes("[api"));
    expect(apiSection).toBeDefined();
    expect(apiSection!.inferredTags.some(t => t.startsWith("glob:"))).toBe(true);

    const testSection = r.sections.find(s => s.title.includes("Test naming"));
    expect(testSection).toBeDefined();
    expect(testSection!.inferredTags.some(t => t.startsWith("glob:"))).toBe(false);
  });

  it("works when starting from the file path (sibling dir auto-discovered)", () => {
    const ghDir = join(dir, ".github");
    mkdirSync(join(ghDir, "instructions"), { recursive: true });
    writeFileSync(join(ghDir, "copilot-instructions.md"), `## Top rule
body for the top rule with enough length.
`);
    writeFileSync(join(ghDir, "instructions", "x.instructions.md"), `## Path rule
body for the path-specific rule.
`);

    const r = FORMATS["copilot"].read(join(ghDir, "copilot-instructions.md"), "fact");
    expect(r.sections.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// read() for roo (recursive walk)
// ---------------------------------------------------------------------------
describe("roo.read walks .roo/rules recursively", () => {
  let dir: string;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("aggregates files from nested subdirs in alphabetical order", () => {
    const rooDir = join(dir, ".roo", "rules");
    mkdirSync(join(rooDir, "security"), { recursive: true });
    writeFileSync(join(rooDir, "000-base.md"), `## Base rule
this is the base rule body.
`);
    writeFileSync(join(rooDir, "security", "100-auth.md"), `## Auth rule
this is the auth-related rule body.
`);

    const r = FORMATS["roo"].read(rooDir, "fact");
    expect(r.sections.length).toBe(2);
    // Sections come from alphabetically-walked files.
    const titles = r.sections.map(s => s.title);
    expect(titles.some(t => t.includes("[000-base.md]"))).toBe(true);
    expect(titles.some(t => t.includes("[100-auth.md]"))).toBe(true);
  });
});
