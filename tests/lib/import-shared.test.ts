// tests/lib/import-shared.test.ts — unit tests for the shared import helpers.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  parseImportFlags,
  stripFrontmatter,
  frontmatterToTags,
  walkRulesDir,
  prefixSectionTitles,
} from "../../src/lib/import-shared.js";

// ---------------------------------------------------------------------------
// parseImportFlags
// ---------------------------------------------------------------------------
describe("parseImportFlags", () => {
  it("returns sensible defaults when no args", () => {
    expect(parseImportFlags([])).toEqual({
      importPath: undefined,
      scope: "project",
      defaultType: "fact",
      dryRun: false,
      noConfirm: false,
    });
  });

  it("parses --scope and --type", () => {
    const r = parseImportFlags(["--scope", "global", "--type", "decision"]);
    expect(r.scope).toBe("global");
    expect(r.defaultType).toBe("decision");
  });

  it("parses --dry-run and --no-confirm", () => {
    const r = parseImportFlags(["--dry-run", "--no-confirm"]);
    expect(r.dryRun).toBe(true);
    expect(r.noConfirm).toBe(true);
  });

  it("captures the first non-flag argument as importPath", () => {
    const r = parseImportFlags(["/tmp/path/CLAUDE.md", "--no-confirm"]);
    expect(r.importPath).toBe("/tmp/path/CLAUDE.md");
  });

  it("captures importPath after flags too", () => {
    const r = parseImportFlags(["--no-confirm", "/tmp/x.md"]);
    expect(r.importPath).toBe("/tmp/x.md");
  });
});

// ---------------------------------------------------------------------------
// stripFrontmatter
// ---------------------------------------------------------------------------
describe("stripFrontmatter", () => {
  it("returns empty fm and original body when no frontmatter", () => {
    const content = "## Heading\nbody text";
    const r = stripFrontmatter(content);
    expect(r.fm).toEqual({});
    expect(r.body).toBe(content);
  });

  it("parses simple key: value pairs", () => {
    const content = `---
description: My rules
alwaysApply: true
---
## Body
text`;
    const r = stripFrontmatter(content);
    expect(r.fm.description).toBe("My rules");
    expect(r.fm.alwaysApply).toBe("true");
    expect(r.body).toBe("## Body\ntext");
  });

  it("unquotes double-quoted values", () => {
    const content = `---
applyTo: "src/api/**"
---
body`;
    expect(stripFrontmatter(content).fm.applyTo).toBe("src/api/**");
  });

  it("unquotes single-quoted values", () => {
    const content = `---
description: 'an apostrophe-quoted value'
---
body`;
    expect(stripFrontmatter(content).fm.description).toBe("an apostrophe-quoted value");
  });

  it("strips brackets from list values", () => {
    const content = `---
globs: ["src/**/*.ts", "lib/**/*.ts"]
---
body`;
    const r = stripFrontmatter(content);
    expect(r.fm.globs).toBe('"src/**/*.ts", "lib/**/*.ts"');
  });

  it("accepts bare comma-separated lists", () => {
    const content = `---
globs: a, b, c
---
body`;
    expect(stripFrontmatter(content).fm.globs).toBe("a, b, c");
  });

  it("ignores commented lines", () => {
    const content = `---
# this is a comment
description: real value
---
body`;
    const r = stripFrontmatter(content);
    expect(r.fm.description).toBe("real value");
    expect(Object.keys(r.fm).filter(k => k !== "description")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const content = `---\r\ndescription: crlf\r\n---\r\n## Body\r\ntext`;
    const r = stripFrontmatter(content);
    expect(r.fm.description).toBe("crlf");
    expect(r.body).toContain("## Body");
  });

  it("returns original content untouched when frontmatter has no closing ---", () => {
    const content = `---\ndescription: missing close\nstill no close\n## Body`;
    const r = stripFrontmatter(content);
    expect(r.fm).toEqual({});
    expect(r.body).toBe(content);
  });

  it("returns empty fm when --- is not at the very start", () => {
    const content = `Some preamble\n---\ndescription: x\n---\nbody`;
    const r = stripFrontmatter(content);
    expect(r.fm).toEqual({});
    expect(r.body).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// frontmatterToTags
// ---------------------------------------------------------------------------
describe("frontmatterToTags", () => {
  it("returns [] for empty fm", () => {
    expect(frontmatterToTags({})).toEqual([]);
  });

  it("emits glob:* tags from globs (slash-stripped, lowercased)", () => {
    const tags = frontmatterToTags({ globs: '"src/**/*.ts"' });
    // src/**/*.ts → strip /' → src + ** + * + .ts → "src***.ts" (3 stars)
    expect(tags).toEqual(["glob:src***.ts"]);
  });

  it("emits glob:* tags from applyTo (alias)", () => {
    const tags = frontmatterToTags({ applyTo: "src/api/**" });
    expect(tags).toEqual(["glob:srcapi**"]);
  });

  it("splits comma-separated glob lists", () => {
    const tags = frontmatterToTags({ globs: '"a", "b"' });
    expect(tags).toEqual(["glob:a", "glob:b"]);
  });

  it("caps glob tags at 5", () => {
    const tags = frontmatterToTags({ globs: "a, b, c, d, e, f, g" });
    expect(tags).toHaveLength(5);
    expect(tags).toEqual(["glob:a", "glob:b", "glob:c", "glob:d", "glob:e"]);
  });

  it("emits cursor:always when alwaysApply is true (string)", () => {
    expect(frontmatterToTags({ alwaysApply: "true" })).toContain("cursor:always");
  });

  it("does NOT emit cursor:always for false or unset", () => {
    expect(frontmatterToTags({ alwaysApply: "false" })).not.toContain("cursor:always");
    expect(frontmatterToTags({})).not.toContain("cursor:always");
  });

  it("combines globs + alwaysApply", () => {
    const tags = frontmatterToTags({ globs: '"x"', alwaysApply: "true" });
    expect(tags).toContain("glob:x");
    expect(tags).toContain("cursor:always");
  });

  it("ignores unknown frontmatter keys", () => {
    const tags = frontmatterToTags({ description: "ignored", random: "ignored" });
    expect(tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// walkRulesDir
// ---------------------------------------------------------------------------
describe("walkRulesDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `walk-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] for missing dir", () => {
    expect(walkRulesDir("/no/such/dir/exists/here", [".md"], false)).toEqual([]);
  });

  it("returns matching files in alphabetical order", () => {
    writeFileSync(join(dir, "b.md"), "x");
    writeFileSync(join(dir, "a.md"), "x");
    writeFileSync(join(dir, "c.md"), "x");
    const r = walkRulesDir(dir, [".md"], false);
    expect(r.map(p => p.split("/").pop())).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("filters by extension", () => {
    writeFileSync(join(dir, "keep.md"), "x");
    writeFileSync(join(dir, "skip.txt"), "x");
    writeFileSync(join(dir, "keep.mdc"), "x");
    const r = walkRulesDir(dir, [".md", ".mdc"], false);
    expect(r.map(p => p.split("/").pop()).sort()).toEqual(["keep.md", "keep.mdc"]);
  });

  it("does NOT recurse when recursive is false", () => {
    writeFileSync(join(dir, "top.md"), "x");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "nested.md"), "x");
    const r = walkRulesDir(dir, [".md"], false);
    expect(r.map(p => p.split("/").pop())).toEqual(["top.md"]);
  });

  it("recurses when recursive is true", () => {
    writeFileSync(join(dir, "top.md"), "x");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "nested.md"), "x");
    const r = walkRulesDir(dir, [".md"], true);
    expect(r.map(p => p.split("/").pop()).sort()).toEqual(["nested.md", "top.md"]);
  });

  it("skips dotfiles", () => {
    writeFileSync(join(dir, "visible.md"), "x");
    writeFileSync(join(dir, ".hidden.md"), "x");
    const r = walkRulesDir(dir, [".md"], false);
    expect(r.map(p => p.split("/").pop())).toEqual(["visible.md"]);
  });
});

// ---------------------------------------------------------------------------
// prefixSectionTitles
// ---------------------------------------------------------------------------
describe("prefixSectionTitles", () => {
  it("prepends [basename] to every title", () => {
    const sections = [
      { title: "A", body: "x", inferredType: "fact", inferredTags: [] },
      { title: "B", body: "y", inferredType: "fact", inferredTags: [] },
    ];
    const out = prefixSectionTitles(sections, "/tmp/dir/auth.mdc");
    expect(out[0].title).toBe("[auth.mdc] A");
    expect(out[1].title).toBe("[auth.mdc] B");
  });

  it("does not mutate the input", () => {
    const sections = [{ title: "A", body: "x", inferredType: "fact", inferredTags: [] }];
    prefixSectionTitles(sections, "/tmp/x.mdc");
    expect(sections[0].title).toBe("A");
  });
});
