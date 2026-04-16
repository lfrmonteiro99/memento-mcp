# Memento MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite Python claude-memory into a distributable TypeScript npm package with token optimization (smart hooks, progressive disclosure, adaptive budget).

**Architecture:** MCP server over stdio using @modelcontextprotocol/sdk. SQLite via better-sqlite3 with FTS5 full-text search. Hooks as standalone bin entry points. Config via TOML with env override.

**Tech Stack:** TypeScript, Node.js >=18, better-sqlite3, smol-toml, vitest, tsup

**Spec:** `docs/2026-04-16-memento-mcp-design.md`

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `LICENSE`

- [ ] **Step 1: Initialize git repo and create package.json**

```bash
cd /home/luis-monteiro/Documentos/dev/memento-mcp
git init
```

```json
// package.json
{
  "name": "memento-mcp",
  "version": "1.0.0",
  "description": "Persistent memory MCP server with typed memories, decay scoring, and token-aware context injection",
  "type": "module",
  "engines": { "node": ">=18" },
  "license": "MIT",
  "author": "Luis Monteiro",
  "repository": { "type": "git", "url": "https://github.com/luismonteiro-sinmetro/memento-mcp.git" },
  "bin": {
    "memento-mcp": "./dist/cli/main.js",
    "memento-hook-search": "./dist/hooks/search-context.js",
    "memento-hook-session": "./dist/hooks/session-context.js"
  },
  "scripts": {
    "build": "tsup src/index.ts src/cli/main.ts src/hooks/search-context.ts src/hooks/session-context.ts --format esm --dts --clean",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepublishOnly": "npm run build && npm test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^11.0.0",
    "smol-toml": "^1.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.0.0",
    "@types/node": "^22.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "files": ["dist", "README.md", "LICENSE"]
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000,
  },
});
```

- [ ] **Step 4: Create .gitignore and LICENSE**

```gitignore
# .gitignore
node_modules/
dist/
*.sqlite
*.sqlite-wal
*.sqlite-shm
.env
```

LICENSE: MIT license text with "Luis Monteiro" as copyright holder.

- [ ] **Step 5: Install dependencies and verify build toolchain**

```bash
npm install
npx vitest run  # should exit with "no test files found" (not an error crash)
npx tsup --version  # verify tsup is available
```

- [ ] **Step 6: Create src directory structure (empty files)**

```bash
mkdir -p src/{tools,db,hooks,lib,cli}
mkdir -p tests/{db,hooks,lib,tools}
touch src/index.ts
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: project scaffolding — package.json, tsconfig, vitest, gitignore"
```

---

### Task 2: Logger + Config (pure lib, no deps)

**Files:**
- Create: `src/lib/logger.ts`
- Create: `src/lib/config.ts`
- Test: `tests/lib/logger.test.ts`
- Test: `tests/lib/config.test.ts`

- [ ] **Step 1: Write logger tests**

```typescript
// tests/lib/logger.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, LogLevel } from "../../src/lib/logger.js";

describe("logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => { stderrSpy.mockRestore(); });

  it("logs error at warn level", () => {
    const log = createLogger(LogLevel.WARN);
    log.error("test error");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ERROR] test error")
    );
  });

  it("suppresses debug at warn level", () => {
    const log = createLogger(LogLevel.WARN);
    log.debug("hidden");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("logs debug at debug level", () => {
    const log = createLogger(LogLevel.DEBUG);
    log.debug("visible");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[DEBUG] visible")
    );
  });

  it("never writes to stdout", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = createLogger(LogLevel.DEBUG);
    log.error("err");
    log.warn("warn");
    log.info("info");
    log.debug("debug");
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
npx vitest run tests/lib/logger.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement logger**

```typescript
// src/lib/logger.ts
export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.WARN]: "WARN",
  [LogLevel.INFO]: "INFO",
  [LogLevel.DEBUG]: "DEBUG",
};

export interface Logger {
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
}

export function createLogger(level: LogLevel = LogLevel.WARN): Logger {
  function log(msgLevel: LogLevel, msg: string): void {
    if (msgLevel <= level) {
      const prefix = `[memento-mcp] [${LEVEL_NAMES[msgLevel]}]`;
      process.stderr.write(`${prefix} ${msg}\n`);
    }
  }
  return {
    error: (msg) => log(LogLevel.ERROR, msg),
    warn: (msg) => log(LogLevel.WARN, msg),
    info: (msg) => log(LogLevel.INFO, msg),
    debug: (msg) => log(LogLevel.DEBUG, msg),
  };
}

export function logLevelFromEnv(): LogLevel {
  const val = process.env.MEMENTO_LOG_LEVEL?.toLowerCase();
  if (val === "error") return LogLevel.ERROR;
  if (val === "info") return LogLevel.INFO;
  if (val === "debug") return LogLevel.DEBUG;
  return LogLevel.WARN;
}
```

- [ ] **Step 4: Run test — verify PASS**

```bash
npx vitest run tests/lib/logger.test.ts
```

- [ ] **Step 5: Write config tests**

```typescript
// tests/lib/config.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../../src/lib/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("config", () => {
  const tmpDir = join(tmpdir(), "memento-config-test-" + Date.now());

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MEMENTO_BUDGET;
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig("/nonexistent/path/config.toml");
    expect(config.budget.total).toBe(DEFAULT_CONFIG.budget.total);
    expect(config.budget.floor).toBe(500);
    expect(config.pruning.maxAgeDays).toBe(60);
  });

  it("merges TOML overrides with defaults", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(cfgPath, '[budget]\ntotal = 5000\n');
    const config = loadConfig(cfgPath);
    expect(config.budget.total).toBe(5000);
    expect(config.budget.floor).toBe(500); // default preserved
  });

  it("env vars override TOML and defaults", () => {
    process.env.MEMENTO_BUDGET = "3000";
    const config = loadConfig("/nonexistent/path/config.toml");
    expect(config.budget.total).toBe(3000);
  });

  it("custom trivial patterns load from TOML", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(cfgPath, '[hooks]\ncustom_trivial_patterns = ["roger", "ack"]\n');
    const config = loadConfig(cfgPath);
    expect(config.hooks.customTrivialPatterns).toEqual(["roger", "ack"]);
  });
});
```

- [ ] **Step 6: Implement config**

```typescript
// src/lib/config.ts
import { readFileSync } from "node:fs";
import { parse as parseTOML } from "smol-toml";

export interface Config {
  budget: { total: number; floor: number; refill: number; sessionTimeout: number };
  search: { defaultDetail: "index" | "full"; maxResults: number; bodyPreviewChars: number };
  hooks: { trivialSkip: boolean; sessionStartMemories: number; sessionStartPitfalls: number; customTrivialPatterns: string[] };
  pruning: { enabled: boolean; maxAgeDays: number; minImportance: number; intervalHours: number };
  database: { path: string };
}

export const DEFAULT_CONFIG: Config = {
  budget: { total: 8000, floor: 500, refill: 200, sessionTimeout: 1800 },
  search: { defaultDetail: "full", maxResults: 10, bodyPreviewChars: 200 },
  hooks: { trivialSkip: true, sessionStartMemories: 5, sessionStartPitfalls: 5, customTrivialPatterns: [] },
  pruning: { enabled: true, maxAgeDays: 60, minImportance: 0.3, intervalHours: 24 },
  database: { path: "" },
};

export function loadConfig(configPath: string): Config {
  const config = structuredClone(DEFAULT_CONFIG);

  // Layer 2: TOML file
  try {
    const raw = readFileSync(configPath, "utf-8");
    const toml = parseTOML(raw) as Record<string, any>;
    if (toml.budget) {
      if (toml.budget.total != null) config.budget.total = Number(toml.budget.total);
      if (toml.budget.floor != null) config.budget.floor = Number(toml.budget.floor);
      if (toml.budget.refill != null) config.budget.refill = Number(toml.budget.refill);
      if (toml.budget.session_timeout != null) config.budget.sessionTimeout = Number(toml.budget.session_timeout);
    }
    if (toml.search) {
      if (toml.search.default_detail) config.search.defaultDetail = toml.search.default_detail;
      if (toml.search.max_results != null) config.search.maxResults = Number(toml.search.max_results);
      if (toml.search.body_preview_chars != null) config.search.bodyPreviewChars = Number(toml.search.body_preview_chars);
    }
    if (toml.hooks) {
      if (toml.hooks.trivial_skip != null) config.hooks.trivialSkip = Boolean(toml.hooks.trivial_skip);
      if (toml.hooks.session_start_memories != null) config.hooks.sessionStartMemories = Number(toml.hooks.session_start_memories);
      if (toml.hooks.session_start_pitfalls != null) config.hooks.sessionStartPitfalls = Number(toml.hooks.session_start_pitfalls);
      if (Array.isArray(toml.hooks.custom_trivial_patterns)) config.hooks.customTrivialPatterns = toml.hooks.custom_trivial_patterns;
    }
    if (toml.pruning) {
      if (toml.pruning.enabled != null) config.pruning.enabled = Boolean(toml.pruning.enabled);
      if (toml.pruning.max_age_days != null) config.pruning.maxAgeDays = Number(toml.pruning.max_age_days);
      if (toml.pruning.min_importance != null) config.pruning.minImportance = Number(toml.pruning.min_importance);
      if (toml.pruning.interval_hours != null) config.pruning.intervalHours = Number(toml.pruning.interval_hours);
    }
    if (toml.database) {
      if (toml.database.path) config.database.path = String(toml.database.path);
    }
  } catch {
    // File not found or invalid TOML — use defaults
  }

  // Layer 3: env vars
  if (process.env.MEMENTO_BUDGET) config.budget.total = Number(process.env.MEMENTO_BUDGET);
  if (process.env.MEMENTO_FLOOR) config.budget.floor = Number(process.env.MEMENTO_FLOOR);
  if (process.env.MEMENTO_REFILL) config.budget.refill = Number(process.env.MEMENTO_REFILL);
  if (process.env.MEMENTO_SESSION_TIMEOUT) config.budget.sessionTimeout = Number(process.env.MEMENTO_SESSION_TIMEOUT);

  return config;
}
```

- [ ] **Step 7: Run all tests — verify PASS**

```bash
npx vitest run
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add logger (stderr-only) and config loader (TOML + env override)"
```

---

### Task 3: Decay + Classify + Budget + Formatter (pure lib)

**Files:**
- Create: `src/lib/decay.ts`
- Create: `src/lib/classify.ts`
- Create: `src/lib/budget.ts`
- Create: `src/lib/formatter.ts`
- Test: `tests/lib/decay.test.ts`
- Test: `tests/lib/classify.test.ts`
- Test: `tests/lib/budget.test.ts`
- Test: `tests/lib/formatter.test.ts`

- [ ] **Step 1: Write decay tests**

```typescript
// tests/lib/decay.test.ts
import { describe, it, expect } from "vitest";
import { daysSince, getDecayFactor, applyDecay } from "../../src/lib/decay.js";

describe("decay", () => {
  it("returns 1.0 for timestamps within 14 days", () => {
    const recent = new Date(Date.now() - 5 * 86400_000).toISOString();
    expect(getDecayFactor(daysSince(recent))).toBe(1.0);
  });

  it("returns 0.75 for timestamps 14-30 days old", () => {
    const mid = new Date(Date.now() - 20 * 86400_000).toISOString();
    expect(getDecayFactor(daysSince(mid))).toBe(0.75);
  });

  it("returns 0.5 for timestamps older than 30 days", () => {
    const old = new Date(Date.now() - 60 * 86400_000).toISOString();
    expect(getDecayFactor(daysSince(old))).toBe(0.5);
  });

  it("returns 0.5 for empty/missing timestamp", () => {
    expect(getDecayFactor(daysSince(""))).toBe(0.5);
    expect(getDecayFactor(daysSince(undefined as any))).toBe(0.5);
  });

  it("applyDecay multiplies base score by factor", () => {
    const recent = new Date().toISOString();
    expect(applyDecay(0.8, recent)).toBeCloseTo(0.8);
    const old = new Date(Date.now() - 60 * 86400_000).toISOString();
    expect(applyDecay(0.8, old)).toBeCloseTo(0.4);
  });
});
```

- [ ] **Step 2: Implement decay**

```typescript
// src/lib/decay.ts
export function daysSince(timestampIso: string | undefined): number {
  if (!timestampIso) return 999;
  try {
    const ts = new Date(timestampIso).getTime();
    return (Date.now() - ts) / 86_400_000;
  } catch {
    return 999;
  }
}

export function getDecayFactor(days: number): number {
  if (days > 30) return 0.5;
  if (days > 14) return 0.75;
  return 1.0;
}

export function applyDecay(baseScore: number, lastAccessed: string | undefined): number {
  return baseScore * getDecayFactor(daysSince(lastAccessed));
}
```

- [ ] **Step 3: Write classify tests**

```typescript
// tests/lib/classify.test.ts
import { describe, it, expect } from "vitest";
import { classifyPrompt } from "../../src/lib/classify.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";

const cfg = DEFAULT_CONFIG;

describe("classifyPrompt", () => {
  it.each(["ok", "sim", "yes", "no", "bora", "done", "lgtm", "k"])
    ('classifies "%s" as trivial', (prompt) => {
      expect(classifyPrompt(prompt, cfg)).toBe("trivial");
    });

  it("classifies short prompts (<8 chars) as trivial", () => {
    expect(classifyPrompt("hi", cfg)).toBe("trivial");
    expect(classifyPrompt("sup?", cfg)).toBe("trivial");
  });

  it("strips trailing punctuation before matching", () => {
    expect(classifyPrompt("ok!!", cfg)).toBe("trivial");
    expect(classifyPrompt("yes.", cfg)).toBe("trivial");
  });

  it("classifies prompts with code blocks as complex", () => {
    expect(classifyPrompt("fix this:\n```\nconst x = 1;\n```", cfg)).toBe("complex");
  });

  it("classifies prompts with file paths as complex", () => {
    expect(classifyPrompt("check /home/user/file.ts", cfg)).toBe("complex");
  });

  it("classifies slash commands as complex", () => {
    expect(classifyPrompt("/commit", cfg)).toBe("complex");
  });

  it("classifies long prompts (>150 chars) as complex", () => {
    expect(classifyPrompt("a".repeat(151), cfg)).toBe("complex");
  });

  it("does NOT classify 'yes/no' as complex (/ between words, not a path)", () => {
    expect(classifyPrompt("is it yes/no?", cfg)).toBe("standard");
  });

  it("classifies normal questions as standard", () => {
    expect(classifyPrompt("what does this function do?", cfg)).toBe("standard");
    expect(classifyPrompt("fix the auth bug in login.ts", cfg)).toBe("standard");
  });

  it("merges custom trivial patterns from config", () => {
    const custom = { ...cfg, hooks: { ...cfg.hooks, customTrivialPatterns: ["roger", "ack"] } };
    expect(classifyPrompt("roger", custom)).toBe("trivial");
    expect(classifyPrompt("ack", custom)).toBe("trivial");
  });
});
```

- [ ] **Step 4: Implement classify**

```typescript
// src/lib/classify.ts
import type { Config } from "./config.js";

const BUILTIN_TRIVIAL = new Set([
  "ok","sim","não","yes","no","bora","go","next","done","já","feito",
  "sure","yep","nope","k","thanks","obrigado","confirmo","approved",
  "got it","agreed","proceed","continue","lgtm",
]);

export function classifyPrompt(prompt: string, config: Config): "trivial" | "standard" | "complex" {
  const stripped = prompt.trim().toLowerCase().replace(/[!?.,]+$/, "");

  const trivial = new Set([...BUILTIN_TRIVIAL, ...config.hooks.customTrivialPatterns]);
  if (trivial.has(stripped) || stripped.length < 8) return "trivial";

  const hasCode = prompt.includes("```");
  const hasPath = /[/\\][\w.-]+[/\\]/.test(prompt);
  const hasSlashCmd = prompt.trimStart().startsWith("/");
  if (prompt.length > 150 || hasCode || hasPath || hasSlashCmd) return "complex";

  return "standard";
}
```

- [ ] **Step 5: Write budget tests**

```typescript
// tests/lib/budget.test.ts
import { describe, it, expect } from "vitest";
import { estimateTokens } from "../../src/lib/budget.js";

describe("estimateTokens", () => {
  it("estimates ~1 token per 4 chars", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 → ceil = 3
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles long text", () => {
    const text = "a".repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });
});
```

- [ ] **Step 6: Implement budget**

```typescript
// src/lib/budget.ts
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
```

- [ ] **Step 7: Write formatter tests**

```typescript
// tests/lib/formatter.test.ts
import { describe, it, expect } from "vitest";
import { formatIndex, formatFull, formatDetail } from "../../src/lib/formatter.js";

const memory = {
  id: "ea6f7a28-69e3-4368-962c-e7da68d0ffdd",
  title: "User profile",
  body: "Luis Monteiro, developer at Sinmetro. " + "x".repeat(300),
  memory_type: "fact",
  source: "sqlite",
  score: 0.85,
  created_at: "2026-04-01T15:26:18Z",
};

describe("formatIndex", () => {
  it("returns compact one-line format with full ID", () => {
    const out = formatIndex([memory]);
    expect(out).toContain("[fact]");
    expect(out).toContain("User profile");
    expect(out).toContain("0.85");
    expect(out).toContain("ea6f7a28-69e3-4368-962c-e7da68d0ffdd");
    expect(out).not.toContain("Sinmetro"); // no body
  });
});

describe("formatFull", () => {
  it("includes body preview truncated to N chars", () => {
    const out = formatFull([memory], 200);
    expect(out).toContain("Sinmetro");
    expect(out).toContain("...");
    expect(out.length).toBeLessThan(memory.body.length);
  });
});

describe("formatDetail", () => {
  it("returns complete body without truncation", () => {
    const out = formatDetail(memory);
    expect(out).toContain(memory.body); // full body, no truncation
  });
});
```

- [ ] **Step 8: Implement formatter**

```typescript
// src/lib/formatter.ts
export interface MemoryRow {
  id: string;
  title: string;
  body?: string;
  memory_type: string;
  source?: string;
  score?: number;
  importance_score?: number;
  created_at?: string;
  [key: string]: any;
}

export function formatIndex(memories: MemoryRow[]): string {
  if (!memories.length) return "No results found.";
  return memories.map(m => {
    const score = typeof m.score === "number" ? m.score.toFixed(2) : "-";
    return `- [${m.memory_type}] ${m.title} (score:${score}, id:${m.id})`;
  }).join("\n");
}

export function formatFull(memories: MemoryRow[], bodyPreviewChars = 200): string {
  if (!memories.length) return "No results found.";
  return memories.map(m => {
    const src = m.source ?? "sqlite";
    const score = typeof m.score === "number" ? m.score.toFixed(2) : "-";
    const lines = [
      `[${src}] (${m.memory_type}) ${m.title}`,
      `  ID: ${m.id}`,
    ];
    if (m.body) {
      const preview = m.body.length > bodyPreviewChars
        ? m.body.slice(0, bodyPreviewChars) + "..."
        : m.body;
      lines.push(`  ${preview}`);
    }
    lines.push(`  Score: ${score} | Created: ${m.created_at ?? "?"}`);
    return lines.join("\n");
  }).join("\n\n");
}

export function formatDetail(memory: MemoryRow): string {
  if (!memory) return "Memory not found.";
  return `[${memory.memory_type}] ${memory.title}\nID: ${memory.id}\n\n${memory.body ?? "(no body)"}`;
}
```

- [ ] **Step 9: Run all tests — verify PASS**

```bash
npx vitest run
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add decay, classify, budget, formatter libs with full test coverage"
```

---

### Task 4: Database — Connection + Migrations

**Files:**
- Create: `src/db/database.ts`
- Test: `tests/db/database.test.ts`

- [ ] **Step 1: Write database tests**

```typescript
// tests/db/database.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";

describe("database", () => {
  let db: Database.Database;
  const dbPath = join(tmpdir(), `memento-test-${Date.now()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("creates all tables", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((r: any) => r.name);
    expect(tables).toContain("projects");
    expect(tables).toContain("memories");
    expect(tables).toContain("decisions");
    expect(tables).toContain("pitfalls");
    expect(tables).toContain("sessions");
  });

  it("creates FTS5 virtual tables", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'"
    ).all().map((r: any) => r.name);
    expect(tables).toContain("memory_fts");
    expect(tables).toContain("decisions_fts");
  });

  it("sets WAL journal mode", () => {
    const mode = db.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
  });

  it("tracks schema version via user_version", () => {
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBe(1);
  });

  it("is idempotent — calling createDatabase twice on same path doesn't error", () => {
    db.close();
    const db2 = createDatabase(dbPath);
    const version = db2.pragma("user_version", { simple: true });
    expect(version).toBe(1);
    db2.close();
    db = createDatabase(dbPath); // re-open for afterEach
  });

  it("creates FTS sync triggers", () => {
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger'"
    ).all().map((r: any) => r.name);
    expect(triggers).toContain("memories_ai");
    expect(triggers).toContain("memories_au");
    expect(triggers).toContain("memories_ad");
    expect(triggers).toContain("decisions_ai");
    expect(triggers).toContain("decisions_au");
    expect(triggers).toContain("decisions_ad");
  });
});
```

- [ ] **Step 2: Run tests — verify FAIL**

```bash
npx vitest run tests/db/database.test.ts
```

- [ ] **Step 3: Implement database.ts**

```typescript
// src/db/database.ts
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    root_path  TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
    id                   TEXT PRIMARY KEY,
    project_id           TEXT REFERENCES projects(id),
    memory_type          TEXT NOT NULL DEFAULT 'fact',
    scope                TEXT NOT NULL DEFAULT 'project',
    title                TEXT NOT NULL,
    body                 TEXT,
    tags                 TEXT,
    importance_score     REAL DEFAULT 0.5,
    confidence_score     REAL DEFAULT 0.5,
    access_count         INTEGER NOT NULL DEFAULT 0,
    last_accessed_at     TEXT,
    is_pinned            INTEGER NOT NULL DEFAULT 0,
    supersedes_memory_id TEXT REFERENCES memories(id),
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(project_id, updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_pruning ON memories(is_pinned, importance_score, last_accessed_at) WHERE deleted_at IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    title, body,
    content='memories', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS decisions (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id),
    title            TEXT NOT NULL,
    body             TEXT NOT NULL,
    category         TEXT NOT NULL DEFAULT 'general',
    importance_score REAL NOT NULL DEFAULT 0.5,
    supersedes_id    TEXT REFERENCES decisions(id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id, importance_score DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
    title, body,
    content='decisions', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS pitfalls (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id),
    title            TEXT NOT NULL,
    body             TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    importance_score REAL NOT NULL DEFAULT 0.5,
    last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
    resolved         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_pitfalls_project ON pitfalls(project_id) WHERE deleted_at IS NULL AND resolved = 0;

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    budget      INTEGER NOT NULL DEFAULT 8000,
    spent       INTEGER NOT NULL DEFAULT 0,
    floor       INTEGER NOT NULL DEFAULT 500,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_active TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS sync triggers
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
    INSERT INTO decisions_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
    INSERT INTO decisions_fts(decisions_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
    INSERT INTO decisions_fts(decisions_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO decisions_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
`,
  },
];

export function createDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new BetterSqlite3(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const currentVersion = db.pragma("user_version", { simple: true }) as number;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    }
  }

  return db;
}

export function nowIso(): string {
  return new Date().toISOString().replace("T", "T").split(".")[0] + "Z";
}
```

- [ ] **Step 4: Run tests — verify PASS**

```bash
npx vitest run tests/db/database.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add SQLite database with migrations, FTS5, WAL mode, triggers"
```

---

### Task 5: Database — Memories CRUD + FTS5 Search

**Files:**
- Create: `src/db/memories.ts`
- Test: `tests/db/memories.test.ts`

- [ ] **Step 1: Write memories tests**

```typescript
// tests/db/memories.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, nowIso } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("MemoriesRepo", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-mem-test-${Date.now()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("stores and retrieves a memory", () => {
    const id = repo.store({
      title: "test memory",
      body: "test body content",
      memoryType: "fact",
      scope: "global",
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const mem = repo.getById(id);
    expect(mem).not.toBeNull();
    expect(mem!.title).toBe("test memory");
    expect(mem!.body).toBe("test body content");
  });

  it("searches via FTS5", () => {
    repo.store({ title: "React hooks guide", body: "useState and useEffect patterns", memoryType: "fact", scope: "global" });
    repo.store({ title: "Python decorators", body: "function wrapping patterns", memoryType: "fact", scope: "global" });
    const results = repo.search("React hooks");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain("React");
  });

  it("sanitizes FTS5 query tokens (double quotes)", () => {
    repo.store({ title: 'He said "hello"', body: "greeting test", memoryType: "fact", scope: "global" });
    // Should not crash
    const results = repo.search('"hello"');
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("soft-deletes a memory", () => {
    const id = repo.store({ title: "to delete", body: "x", memoryType: "fact", scope: "global" });
    expect(repo.delete(id)).toBe(true);
    expect(repo.getById(id)).toBeNull(); // hidden from reads
    expect(repo.delete(id)).toBe(false); // already deleted
  });

  it("supersedes a previous memory", () => {
    const id1 = repo.store({ title: "v1", body: "first", memoryType: "fact", scope: "global" });
    const id2 = repo.store({ title: "v2", body: "second", memoryType: "fact", scope: "global", supersedesId: id1 });
    expect(repo.getById(id1)).toBeNull(); // superseded = soft-deleted
    expect(repo.getById(id2)!.title).toBe("v2");
  });

  it("filters by project scope (includes global)", () => {
    repo.store({ title: "global mem", body: "g", memoryType: "fact", scope: "global" });
    repo.store({ title: "project mem", body: "p", memoryType: "fact", scope: "project", projectPath: "/home/user/proj" });
    repo.store({ title: "other proj", body: "o", memoryType: "fact", scope: "project", projectPath: "/home/user/other" });
    const results = repo.search("mem", { projectPath: "/home/user/proj" });
    const titles = results.map(r => r.title);
    expect(titles).toContain("global mem");
    expect(titles).toContain("project mem");
    expect(titles).not.toContain("other proj");
  });

  it("updates access tracking on search", () => {
    const id = repo.store({ title: "tracked", body: "content", memoryType: "fact", scope: "global" });
    repo.search("tracked");
    const mem = db.prepare("SELECT access_count FROM memories WHERE id = ?").get(id) as any;
    expect(mem.access_count).toBe(1);
  });

  it("lists memories with filters", () => {
    repo.store({ title: "a fact", body: "x", memoryType: "fact", scope: "global" });
    repo.store({ title: "a decision", body: "x", memoryType: "decision", scope: "global" });
    const facts = repo.list({ memoryType: "fact" });
    expect(facts.every(m => m.memory_type === "fact")).toBe(true);
  });

  it("prunes stale memories", () => {
    const id = repo.store({ title: "old", body: "x", memoryType: "fact", scope: "global", importance: 0.1 });
    // Manually set last_accessed_at to 90 days ago
    db.prepare("UPDATE memories SET last_accessed_at = datetime('now', '-90 days') WHERE id = ?").run(id);
    const count = repo.pruneStale(60, 0.3);
    expect(count).toBe(1);
    expect(repo.getById(id)).toBeNull();
  });

  it("does NOT prune pinned memories", () => {
    const id = repo.store({ title: "pinned", body: "x", memoryType: "fact", scope: "global", importance: 0.1, pin: true });
    db.prepare("UPDATE memories SET last_accessed_at = datetime('now', '-90 days') WHERE id = ?").run(id);
    const count = repo.pruneStale(60, 0.3);
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests — verify FAIL**

- [ ] **Step 3: Implement memories.ts**

```typescript
// src/db/memories.ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowIso } from "./database.js";

function sanitizeFtsToken(token: string): string {
  return token.replace(/"/g, '""');
}

function buildFtsQuery(query: string): string {
  const tokens = query.split(/\s+/).filter(t => t.length > 0);
  if (!tokens.length) return "";
  return tokens.map(t => `"${sanitizeFtsToken(t)}"`).join(" OR ");
}

export interface StoreParams {
  title: string;
  body: string;
  memoryType?: string;
  scope?: string;
  projectPath?: string;
  tags?: string[];
  importance?: number;
  supersedesId?: string;
  pin?: boolean;
}

export interface SearchOptions {
  projectPath?: string;
  memoryType?: string;
  limit?: number;
}

export class MemoriesRepo {
  constructor(private db: Database.Database) {}

  private getOrCreateProject(rootPath: string): string {
    const row = this.db.prepare("SELECT id FROM projects WHERE root_path = ?").get(rootPath) as any;
    if (row) return row.id;
    const id = randomUUID();
    const name = rootPath.split("/").pop() ?? rootPath;
    this.db.prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)").run(id, name, rootPath);
    return id;
  }

  store(params: StoreParams): string {
    const id = randomUUID();
    const now = nowIso();
    const projectId = params.projectPath ? this.getOrCreateProject(params.projectPath) : null;
    const tagsStr = params.tags?.join(",") ?? null;

    if (params.supersedesId) {
      this.db.prepare("UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, params.supersedesId);
    }

    this.db.prepare(`
      INSERT INTO memories (id, project_id, memory_type, scope, title, body, tags,
                            importance_score, is_pinned, supersedes_memory_id,
                            created_at, updated_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, params.memoryType ?? "fact", params.scope ?? "project",
           params.title, params.body, tagsStr, params.importance ?? 0.5,
           params.pin ? 1 : 0, params.supersedesId ?? null, now, now, now);
    return id;
  }

  getById(id: string): any | null {
    return this.db.prepare("SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL").get(id) ?? null;
  }

  search(query: string, opts: SearchOptions = {}): any[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    const params: any[] = [ftsQuery];
    const whereClauses = ["m.deleted_at IS NULL"];

    if (opts.projectPath) {
      const projectId = this.getOrCreateProject(opts.projectPath);
      whereClauses.push("(m.project_id = ? OR m.scope = 'global')");
      params.push(projectId);
    }
    if (opts.memoryType) {
      whereClauses.push("m.memory_type = ?");
      params.push(opts.memoryType);
    }

    const limit = opts.limit ?? 10;
    params.push(limit);

    const rows = this.db.prepare(`
      SELECT m.*, rank FROM memory_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memory_fts MATCH ? AND ${whereClauses.join(" AND ")}
      ORDER BY rank LIMIT ?
    `).all(...params) as any[];

    // Update access tracking
    const now = nowIso();
    const updateStmt = this.db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?"
    );
    for (const r of rows) {
      updateStmt.run(now, r.id);
    }

    return rows;
  }

  list(opts: { projectPath?: string; memoryType?: string; scope?: string; pinnedOnly?: boolean; limit?: number } = {}): any[] {
    const whereClauses = ["deleted_at IS NULL"];
    const params: any[] = [];

    if (opts.projectPath) {
      const projectId = this.getOrCreateProject(opts.projectPath);
      whereClauses.push("(project_id = ? OR scope = 'global')");
      params.push(projectId);
    }
    if (opts.memoryType) { whereClauses.push("memory_type = ?"); params.push(opts.memoryType); }
    if (opts.scope) { whereClauses.push("scope = ?"); params.push(opts.scope); }
    if (opts.pinnedOnly) { whereClauses.push("is_pinned = 1"); }

    params.push(opts.limit ?? 20);

    return this.db.prepare(`
      SELECT * FROM memories WHERE ${whereClauses.join(" AND ")}
      ORDER BY is_pinned DESC, importance_score DESC, updated_at DESC LIMIT ?
    `).all(...params) as any[];
  }

  delete(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
    ).run(nowIso(), id);
    return result.changes > 0;
  }

  pruneStale(maxAgeDays = 60, minImportance = 0.3): number {
    const result = this.db.prepare(`
      UPDATE memories SET deleted_at = ?
      WHERE deleted_at IS NULL AND is_pinned = 0
        AND importance_score < ? AND last_accessed_at < datetime('now', ? || ' days')
    `).run(nowIso(), minImportance, `-${maxAgeDays}`);
    return result.changes;
  }
}
```

- [ ] **Step 4: Run tests — verify PASS**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add MemoriesRepo — CRUD, FTS5 search, access tracking, pruning"
```

---

### Task 6: Database — Decisions + Pitfalls + Sessions

**Files:**
- Create: `src/db/decisions.ts`
- Create: `src/db/pitfalls.ts`
- Create: `src/db/sessions.ts`
- Test: `tests/db/decisions.test.ts`
- Test: `tests/db/pitfalls.test.ts`
- Test: `tests/db/sessions.test.ts`

- [ ] **Step 1: Write decisions tests**

```typescript
// tests/db/decisions.test.ts
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
```

- [ ] **Step 2: Write pitfalls tests**

```typescript
// tests/db/pitfalls.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { PitfallsRepo } from "../../src/db/pitfalls.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("PitfallsRepo", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: PitfallsRepo;
  const dbPath = join(tmpdir(), `memento-pit-test-${Date.now()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); repo = new PitfallsRepo(db); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("stores a pitfall", () => {
    const id = repo.store("/proj", "FTS5 rank normalization", "Ranks need 0-1 normalization");
    const list = repo.list("/proj");
    expect(list.length).toBe(1);
    expect(list[0].occurrence_count).toBe(1);
  });

  it("auto-increments occurrence on duplicate title", () => {
    repo.store("/proj", "Same bug", "First time");
    repo.store("/proj", "Same bug", "Second time — different body");
    const list = repo.list("/proj");
    expect(list.length).toBe(1);
    expect(list[0].occurrence_count).toBe(2);
    expect(list[0].body).toBe("Second time — different body"); // updated
  });

  it("resolves a pitfall", () => {
    const id = repo.store("/proj", "Bug X", "Details");
    expect(repo.resolve(id)).toBe(true);
    const list = repo.list("/proj"); // unresolved only by default
    expect(list.length).toBe(0);
    const listAll = repo.list("/proj", 10, true);
    expect(listAll.length).toBe(1);
    expect(listAll[0].resolved).toBe(1);
  });
});
```

- [ ] **Step 3: Write sessions tests**

```typescript
// tests/db/sessions.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SessionsRepo", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: SessionsRepo;
  const dbPath = join(tmpdir(), `memento-sess-test-${Date.now()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); repo = new SessionsRepo(db); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("creates a new session with defaults", () => {
    const s = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    expect(s.budget).toBe(8000);
    expect(s.spent).toBe(0);
    expect(s.floor).toBe(500);
  });

  it("reuses active session within timeout", () => {
    const s1 = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    const s2 = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    expect(s1.id).toBe(s2.id);
  });

  it("creates new session after timeout", () => {
    const s1 = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    // Manually age the session
    db.prepare("UPDATE sessions SET last_active = datetime('now', '-31 minutes') WHERE id = ?").run(s1.id);
    const s2 = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    expect(s2.id).not.toBe(s1.id);
  });

  it("debits tokens from session", () => {
    const s = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    repo.debit(s.id, 1000);
    const updated = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    expect(updated.spent).toBe(1000);
  });

  it("refills tokens", () => {
    const s = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    repo.debit(s.id, 5000);
    repo.refill(s.id, 200);
    const updated = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    expect(updated.spent).toBe(4800);
  });

  it("refill does not go below 0 spent", () => {
    const s = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    repo.refill(s.id, 200);
    const updated = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    expect(updated.spent).toBe(0);
  });
});
```

- [ ] **Step 4: Run all tests — verify FAIL**

- [ ] **Step 5: Implement decisions.ts, pitfalls.ts, sessions.ts**

```typescript
// src/db/decisions.ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowIso } from "./database.js";

function buildFtsQuery(query: string): string {
  const tokens = query.split(/\s+/).filter(t => t.length > 0);
  if (!tokens.length) return "";
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export class DecisionsRepo {
  constructor(private db: Database.Database) {}

  private getOrCreateProject(rootPath: string): string {
    const row = this.db.prepare("SELECT id FROM projects WHERE root_path = ?").get(rootPath) as any;
    if (row) return row.id;
    const id = randomUUID();
    this.db.prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)").run(id, rootPath.split("/").pop() ?? rootPath, rootPath);
    return id;
  }

  store(projectPath: string, title: string, body: string, category = "general", importance = 0.7, supersedesId?: string): string {
    const projectId = this.getOrCreateProject(projectPath);
    const id = randomUUID();
    const now = nowIso();
    if (supersedesId) {
      this.db.prepare("UPDATE decisions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, supersedesId);
    }
    this.db.prepare(`
      INSERT INTO decisions (id, project_id, title, body, category, importance_score, supersedes_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, title, body, category, importance, supersedesId ?? null, now);
    return id;
  }

  list(projectPath: string, limit = 10): any[] {
    const projectId = this.getOrCreateProject(projectPath);
    return this.db.prepare(`
      SELECT * FROM decisions WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY importance_score DESC, created_at DESC LIMIT ?
    `).all(projectId, limit) as any[];
  }

  search(query: string, projectPath: string, limit = 10): any[] {
    const projectId = this.getOrCreateProject(projectPath);
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    return this.db.prepare(`
      SELECT d.*, rank FROM decisions_fts fts
      JOIN decisions d ON d.rowid = fts.rowid
      WHERE decisions_fts MATCH ? AND d.project_id = ? AND d.deleted_at IS NULL
      ORDER BY rank LIMIT ?
    `).all(ftsQuery, projectId, limit) as any[];
  }
}
```

```typescript
// src/db/pitfalls.ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowIso } from "./database.js";

export class PitfallsRepo {
  constructor(private db: Database.Database) {}

  private getOrCreateProject(rootPath: string): string {
    const row = this.db.prepare("SELECT id FROM projects WHERE root_path = ?").get(rootPath) as any;
    if (row) return row.id;
    const id = randomUUID();
    this.db.prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)").run(id, rootPath.split("/").pop() ?? rootPath, rootPath);
    return id;
  }

  store(projectPath: string, title: string, body: string, importance = 0.6): string {
    const projectId = this.getOrCreateProject(projectPath);
    const now = nowIso();
    const existing = this.db.prepare(
      "SELECT id, occurrence_count FROM pitfalls WHERE project_id = ? AND title = ? AND deleted_at IS NULL AND resolved = 0"
    ).get(projectId, title) as any;

    if (existing) {
      this.db.prepare("UPDATE pitfalls SET occurrence_count = occurrence_count + 1, last_seen_at = ?, body = ? WHERE id = ?")
        .run(now, body, existing.id);
      return existing.id;
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO pitfalls (id, project_id, title, body, importance_score, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, title, body, importance, now, now);
    return id;
  }

  list(projectPath: string, limit = 10, includeResolved = false): any[] {
    const projectId = this.getOrCreateProject(projectPath);
    const resolvedClause = includeResolved ? "" : "AND resolved = 0";
    return this.db.prepare(`
      SELECT * FROM pitfalls WHERE project_id = ? AND deleted_at IS NULL ${resolvedClause}
      ORDER BY occurrence_count DESC, importance_score DESC LIMIT ?
    `).all(projectId, limit) as any[];
  }

  resolve(pitfallId: string): boolean {
    return this.db.prepare("UPDATE pitfalls SET resolved = 1 WHERE id = ? AND deleted_at IS NULL").run(pitfallId).changes > 0;
  }
}
```

```typescript
// src/db/sessions.ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowIso } from "./database.js";

export interface SessionConfig {
  total: number;
  floor: number;
  sessionTimeout: number; // seconds
}

export interface Session {
  id: string;
  budget: number;
  spent: number;
  floor: number;
  created_at: string;
  last_active: string;
}

export class SessionsRepo {
  constructor(private db: Database.Database) {}

  getOrCreate(config: SessionConfig): Session {
    const timeoutMinutes = Math.floor(config.sessionTimeout / 60);
    const active = this.db.prepare(`
      SELECT * FROM sessions
      WHERE last_active > datetime('now', ? || ' minutes')
      ORDER BY last_active DESC LIMIT 1
    `).get(`-${timeoutMinutes}`) as Session | undefined;

    if (active) {
      this.db.prepare("UPDATE sessions SET last_active = ? WHERE id = ?").run(nowIso(), active.id);
      return active;
    }

    const id = randomUUID();
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO sessions (id, budget, spent, floor, created_at, last_active)
      VALUES (?, ?, 0, ?, ?, ?)
    `).run(id, config.total, config.floor, now, now);

    return { id, budget: config.total, spent: 0, floor: config.floor, created_at: now, last_active: now };
  }

  debit(sessionId: string, tokens: number): void {
    this.db.prepare("UPDATE sessions SET spent = spent + ?, last_active = ? WHERE id = ?")
      .run(tokens, nowIso(), sessionId);
  }

  refill(sessionId: string, tokens: number): void {
    this.db.prepare("UPDATE sessions SET spent = MAX(0, spent - ?), last_active = ? WHERE id = ?")
      .run(tokens, nowIso(), sessionId);
  }
}
```

- [ ] **Step 6: Run all tests — verify PASS**

```bash
npx vitest run
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add DecisionsRepo, PitfallsRepo, SessionsRepo with full test coverage"
```

---

### Task 7: File Memory Reader

**Files:**
- Create: `src/lib/file-memory.ts`
- Test: `tests/lib/file-memory.test.ts`

- [ ] **Step 1: Write file-memory tests**

```typescript
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
```

- [ ] **Step 2: Implement file-memory.ts**

```typescript
// src/lib/file-memory.ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

function sanitizePath(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}

interface FileMemory {
  id: string;
  title: string;
  description: string;
  body: string;
  memory_type: string;
  scope: string;
  source: string;
  filepath: string;
  score?: number;
}

function parseMemoryFile(filepath: string): FileMemory | null {
  try {
    const content = readFileSync(filepath, "utf-8");
    const basename = filepath.split("/").pop()?.replace(".md", "") ?? "unknown";
    let title = basename;
    let description = "";
    let memoryType = "fact";
    let body = content;

    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/);
    if (match) {
      const [, frontmatter, rest] = match;
      body = rest;
      for (const line of frontmatter.split("\n")) {
        if (line.startsWith("name:")) title = line.slice(5).trim();
        else if (line.startsWith("description:")) description = line.slice(12).trim();
        else if (line.startsWith("type:")) memoryType = line.slice(5).trim();
      }
    }

    return { id: `file:${filepath}`, title, description, body: body.trim(), memory_type: memoryType, scope: "project", source: "file", filepath };
  } catch {
    return null;
  }
}

export function readFileMemories(projectPath?: string, claudeProjectsDir?: string): FileMemory[] {
  const baseDir = claudeProjectsDir ?? DEFAULT_CLAUDE_PROJECTS;
  if (!existsSync(baseDir)) return [];

  const results: FileMemory[] = [];
  const dirs: string[] = [];

  if (projectPath) {
    const sanitized = sanitizePath(projectPath);
    const memDir = join(baseDir, sanitized, "memory");
    if (existsSync(memDir)) dirs.push(memDir);
  } else {
    try {
      for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const memDir = join(baseDir, entry.name, "memory");
          if (existsSync(memDir)) dirs.push(memDir);
        }
      }
    } catch { /* ignore */ }
  }

  for (const dir of dirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (file.endsWith(".md") && file !== "MEMORY.md") {
          const parsed = parseMemoryFile(join(dir, file));
          if (parsed) results.push(parsed);
        }
      }
    } catch { /* ignore */ }
  }

  return results;
}

export function searchFileMemories(query: string, projectPath?: string, claudeProjectsDir?: string): FileMemory[] {
  const memories = readFileMemories(projectPath, claudeProjectsDir);
  const queryTokens = new Set(query.toLowerCase().split(/\s+/).filter(Boolean));
  if (!queryTokens.size) return [];

  const scored: FileMemory[] = [];
  for (const mem of memories) {
    const text = `${mem.title} ${mem.body}`.toLowerCase();
    const textTokens = new Set(text.split(/\s+/));
    let overlap = 0;
    for (const qt of queryTokens) {
      if (textTokens.has(qt)) overlap++;
    }
    if (overlap > 0) {
      mem.score = overlap / queryTokens.size;
      scored.push(mem);
    }
  }

  return scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
```

- [ ] **Step 3: Run tests — verify PASS**

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add file-memory reader for Claude Code .md memory files"
```

---

### Task 8: MCP Tools

**Files:**
- Create: `src/tools/memory-store.ts`
- Create: `src/tools/memory-search.ts`
- Create: `src/tools/memory-get.ts`
- Create: `src/tools/memory-list.ts`
- Create: `src/tools/memory-delete.ts`
- Create: `src/tools/decisions-log.ts`
- Create: `src/tools/pitfalls-log.ts`
- Test: `tests/tools/memory-tools.test.ts`
- Test: `tests/tools/decisions-pitfalls.test.ts`

This task creates the MCP tool handler functions. Each tool is a function that receives params and returns a string. The MCP server wiring (Task 10) registers them.

- [ ] **Step 1: Write memory tools tests**

```typescript
// tests/tools/memory-tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { handleMemorySearch } from "../../src/tools/memory-search.js";
import { handleMemoryGet } from "../../src/tools/memory-get.js";
import { handleMemoryList } from "../../src/tools/memory-list.js";
import { handleMemoryDelete } from "../../src/tools/memory-delete.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("memory tools", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-tools-test-${Date.now()}.sqlite`);
  const config = DEFAULT_CONFIG;

  beforeEach(() => { db = createDatabase(dbPath); repo = new MemoriesRepo(db); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("memory_store returns ID", async () => {
    const result = await handleMemoryStore(repo, { title: "test", content: "body", memory_type: "fact", scope: "global" });
    expect(result).toContain("Memory stored with ID:");
  });

  it("memory_search detail=index returns compact format", async () => {
    repo.store({ title: "React hooks", body: "patterns guide", memoryType: "fact", scope: "global" });
    const result = await handleMemorySearch(repo, config, { query: "React", detail: "index" });
    expect(result).toContain("[fact]");
    expect(result).toContain("React hooks");
    expect(result).not.toContain("patterns guide"); // body not in index
  });

  it("memory_search detail=full includes body preview", async () => {
    repo.store({ title: "React hooks", body: "patterns guide with details", memoryType: "fact", scope: "global" });
    const result = await handleMemorySearch(repo, config, { query: "React", detail: "full" });
    expect(result).toContain("patterns guide");
  });

  it("memory_get returns full body", async () => {
    const longBody = "detailed content ".repeat(50);
    const id = repo.store({ title: "detailed", body: longBody, memoryType: "fact", scope: "global" });
    const result = await handleMemoryGet(repo, { memory_id: id });
    expect(result).toContain(longBody); // not truncated
  });

  it("memory_get returns error for missing ID", async () => {
    const result = await handleMemoryGet(repo, { memory_id: "nonexistent" });
    expect(result).toContain("not found");
  });

  it("memory_list returns memories", async () => {
    repo.store({ title: "item1", body: "b1", memoryType: "fact", scope: "global" });
    const result = await handleMemoryList(repo, config, {});
    expect(result).toContain("item1");
  });

  it("memory_delete soft-deletes", async () => {
    const id = repo.store({ title: "to remove", body: "x", memoryType: "fact", scope: "global" });
    const result = await handleMemoryDelete(repo, { memory_id: id });
    expect(result).toContain("deleted");
  });
});
```

- [ ] **Step 2: Implement all memory tool handlers**

Each tool handler is a pure function: receives repo + params, returns string. No MCP SDK dependency.

```typescript
// src/tools/memory-store.ts
import type { MemoriesRepo } from "../db/memories.js";

export async function handleMemoryStore(repo: MemoriesRepo, params: {
  title: string; content: string; memory_type?: string; scope?: string;
  project_path?: string; tags?: string[]; importance?: number;
  supersedes_id?: string; pin?: boolean;
}): Promise<string> {
  const id = repo.store({
    title: params.title, body: params.content,
    memoryType: params.memory_type, scope: params.scope,
    projectPath: params.project_path, tags: params.tags,
    importance: params.importance, supersedesId: params.supersedes_id,
    pin: params.pin,
  });
  return `Memory stored with ID: ${id}`;
}
```

```typescript
// src/tools/memory-search.ts
import type { MemoriesRepo } from "../db/memories.js";
import type { Config } from "../lib/config.js";
import { applyDecay } from "../lib/decay.js";
import { searchFileMemories } from "../lib/file-memory.js";
import { formatIndex, formatFull } from "../lib/formatter.js";

export async function handleMemorySearch(repo: MemoriesRepo, config: Config, params: {
  query: string; project_path?: string; memory_type?: string;
  limit?: number; detail?: "index" | "full"; include_file_memories?: boolean;
}): Promise<string> {
  const limit = params.limit ?? config.search.maxResults;
  const detail = params.detail ?? config.search.defaultDetail;
  const results: any[] = [];

  const sqliteResults = repo.search(params.query, {
    projectPath: params.project_path, memoryType: params.memory_type, limit,
  });

  // Normalize FTS5 ranks and apply decay
  const rawRanks = sqliteResults.map(r => Math.abs(r.rank ?? 0));
  const maxRank = Math.max(...rawRanks, 1);
  for (const r of sqliteResults) {
    const normalizedRank = Math.abs(r.rank ?? 0) / maxRank;
    const baseScore = normalizedRank * 0.6 + (r.importance_score ?? 0.5) * 0.4;
    r.score = applyDecay(baseScore, r.last_accessed_at);
    r.source = "sqlite";
    results.push(r);
  }

  if (params.include_file_memories !== false) {
    const fileResults = searchFileMemories(params.query, params.project_path);
    for (const r of fileResults) { r.source = "file"; results.push(r); }
  }

  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const limited = results.slice(0, limit);

  return detail === "index"
    ? formatIndex(limited)
    : formatFull(limited, config.search.bodyPreviewChars);
}
```

```typescript
// src/tools/memory-get.ts
import type { MemoriesRepo } from "../db/memories.js";
import { readFileMemories } from "../lib/file-memory.js";
import { formatDetail } from "../lib/formatter.js";

export async function handleMemoryGet(repo: MemoriesRepo, params: { memory_id: string }): Promise<string> {
  // Handle file-based memories
  if (params.memory_id.startsWith("file:")) {
    const allFiles = readFileMemories();
    const match = allFiles.find(f => f.id === params.memory_id);
    return match ? formatDetail(match) : "Memory not found.";
  }
  const mem = repo.getById(params.memory_id);
  return mem ? formatDetail(mem) : "Memory not found.";
}
```

```typescript
// src/tools/memory-list.ts
import type { MemoriesRepo } from "../db/memories.js";
import type { Config } from "../lib/config.js";
import { readFileMemories } from "../lib/file-memory.js";
import { formatIndex, formatFull } from "../lib/formatter.js";

export async function handleMemoryList(repo: MemoriesRepo, config: Config, params: {
  project_path?: string; memory_type?: string; scope?: string;
  pinned_only?: boolean; limit?: number; detail?: "index" | "full";
  include_file_memories?: boolean;
}): Promise<string> {
  const detail = params.detail ?? config.search.defaultDetail;
  const results: any[] = repo.list({
    projectPath: params.project_path, memoryType: params.memory_type,
    scope: params.scope, pinnedOnly: params.pinned_only, limit: params.limit,
  });
  for (const r of results) r.source = "sqlite";

  if (params.include_file_memories) {
    const fileResults = readFileMemories(params.project_path);
    for (const r of fileResults) { (r as any).importance_score = 1.0; (r as any).created_at = "(file)"; results.push(r); }
  }

  return detail === "index" ? formatIndex(results) : formatFull(results, config.search.bodyPreviewChars);
}
```

```typescript
// src/tools/memory-delete.ts
import type { MemoriesRepo } from "../db/memories.js";

export async function handleMemoryDelete(repo: MemoriesRepo, params: { memory_id: string }): Promise<string> {
  if (params.memory_id.startsWith("file:")) return "Cannot delete file-based memories.";
  return repo.delete(params.memory_id)
    ? `Memory ${params.memory_id} deleted.`
    : `Memory ${params.memory_id} not found or already deleted.`;
}
```

```typescript
// src/tools/decisions-log.ts
import type { DecisionsRepo } from "../db/decisions.js";

export async function handleDecisionsLog(repo: DecisionsRepo, params: {
  action: string; project_path: string; title?: string; body?: string;
  category?: string; importance?: number; supersedes_id?: string;
  query?: string; limit?: number;
}): Promise<string> {
  if (params.action === "store") {
    if (!params.title || !params.body) return "title and body are required for action='store'.";
    const id = repo.store(params.project_path, params.title, params.body, params.category, params.importance, params.supersedes_id);
    return `Decision stored with ID: ${id}`;
  }
  if (params.action === "list") {
    const decisions = repo.list(params.project_path, params.limit);
    if (!decisions.length) return "No decisions found.";
    return decisions.map(d =>
      `[${d.category}] ${d.title}\n  ID: ${d.id}\n  ${(d.body as string).slice(0, 300)}\n  Importance: ${d.importance_score} | Created: ${d.created_at}`
    ).join("\n\n");
  }
  if (params.action === "search") {
    if (!params.query) return "query is required for action='search'.";
    const results = repo.search(params.query, params.project_path, params.limit);
    if (!results.length) return "No decisions found.";
    return results.map(d =>
      `[${d.category}] ${d.title}\n  ID: ${d.id}\n  ${(d.body as string).slice(0, 300)}`
    ).join("\n\n");
  }
  return `Invalid action: ${params.action}. Use 'store', 'list', or 'search'.`;
}
```

```typescript
// src/tools/pitfalls-log.ts
import type { PitfallsRepo } from "../db/pitfalls.js";

export async function handlePitfallsLog(repo: PitfallsRepo, params: {
  action: string; project_path: string; title?: string; body?: string;
  importance?: number; limit?: number; include_resolved?: boolean; pitfall_id?: string;
}): Promise<string> {
  if (params.action === "store") {
    if (!params.title || !params.body) return "title and body are required for action='store'.";
    const id = repo.store(params.project_path, params.title, params.body, params.importance);
    return `Pitfall logged/updated with ID: ${id}`;
  }
  if (params.action === "list") {
    const pitfalls = repo.list(params.project_path, params.limit, params.include_resolved);
    if (!pitfalls.length) return "No pitfalls found.";
    return pitfalls.map(p => {
      const status = p.resolved ? "RESOLVED" : `x${p.occurrence_count}`;
      return `[${status}] ${p.title}\n  ID: ${p.id}\n  ${(p.body as string).slice(0, 300)}\n  Last seen: ${p.last_seen_at}`;
    }).join("\n\n");
  }
  if (params.action === "resolve") {
    if (!params.pitfall_id) return "pitfall_id is required for action='resolve'.";
    return repo.resolve(params.pitfall_id)
      ? `Pitfall ${params.pitfall_id} marked as resolved.`
      : `Pitfall ${params.pitfall_id} not found.`;
  }
  return `Invalid action: ${params.action}. Use 'store', 'list', or 'resolve'.`;
}
```

- [ ] **Step 3: Write decisions+pitfalls tools tests**

```typescript
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
```

- [ ] **Step 4: Run all tests — verify PASS**

```bash
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add all 7 MCP tool handlers with tests"
```

---

### Task 9: Hooks (smart skip + budget-aware)

**Files:**
- Create: `src/hooks/search-context.ts`
- Create: `src/hooks/session-context.ts`
- Test: `tests/hooks/search-context.test.ts`
- Test: `tests/hooks/session-context.test.ts`

- [ ] **Step 1: Write hook integration tests**

```typescript
// tests/hooks/search-context.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processSearchHook } from "../../src/hooks/search-context.js";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("search-context hook", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let sessRepo: SessionsRepo;
  const dbPath = join(tmpdir(), `memento-hook-test-${Date.now()}.sqlite`);
  const config = DEFAULT_CONFIG;

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    sessRepo = new SessionsRepo(db);
    memRepo.store({ title: "React guide", body: "hooks and state management", memoryType: "fact", scope: "global" });
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("returns context for standard prompt", () => {
    const output = processSearchHook("how do React hooks work?", memRepo, sessRepo, config);
    expect(output).toContain("React guide");
  });

  it("returns empty for trivial prompt", () => {
    const output = processSearchHook("ok", memRepo, sessRepo, config);
    expect(output).toBe("");
  });

  it("returns empty for very short prompt", () => {
    const output = processSearchHook("yes", memRepo, sessRepo, config);
    expect(output).toBe("");
  });

  it("respects budget floor (always returns at least 1 result)", () => {
    // Drain budget
    const session = sessRepo.getOrCreate(config.budget);
    sessRepo.debit(session.id, config.budget.total - config.budget.floor + 1);
    const output = processSearchHook("how do React hooks work?", memRepo, sessRepo, config);
    // Should still return something (floor allows 1 result)
    expect(output).not.toBe("");
  });

  it("debits tokens from session budget", () => {
    const before = sessRepo.getOrCreate(config.budget);
    processSearchHook("how do React hooks work?", memRepo, sessRepo, config);
    const after = sessRepo.getOrCreate(config.budget);
    expect(after.spent).toBeGreaterThan(before.spent);
  });
});
```

```typescript
// tests/hooks/session-context.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { processSessionHook } from "../../src/hooks/session-context.js";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { PitfallsRepo } from "../../src/db/pitfalls.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("session-context hook", () => {
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-sesshook-test-${Date.now()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("outputs recent memories and pitfalls", () => {
    const memRepo = new MemoriesRepo(db);
    const pitRepo = new PitfallsRepo(db);
    const sessRepo = new SessionsRepo(db);
    memRepo.store({ title: "User is a dev", body: "senior", memoryType: "fact", scope: "global" });
    pitRepo.store("/proj", "FTS5 bug", "ranking issue");
    const output = processSessionHook(memRepo, pitRepo, sessRepo, DEFAULT_CONFIG);
    expect(output).toContain("User is a dev");
    expect(output).toContain("FTS5 bug");
  });

  it("creates a session budget", () => {
    const sessRepo = new SessionsRepo(db);
    processSessionHook(new MemoriesRepo(db), new PitfallsRepo(db), sessRepo, DEFAULT_CONFIG);
    const session = sessRepo.getOrCreate(DEFAULT_CONFIG.budget);
    expect(session.spent).toBeGreaterThan(0); // debited for injection
  });
});
```

- [ ] **Step 2: Implement hooks as testable functions + CLI wrappers**

```typescript
// src/hooks/search-context.ts
import { MemoriesRepo } from "../db/memories.js";
import { SessionsRepo } from "../db/sessions.js";
import { searchFileMemories } from "../lib/file-memory.js";
import { classifyPrompt } from "../lib/classify.js";
import { estimateTokens } from "../lib/budget.js";
import type { Config } from "../lib/config.js";

const STOP_WORDS = new Set([
  "the","is","at","in","on","to","for","and","or","an","a","of","it",
  "want","make","how","can","need","this","that","let","do","be",
  "o","a","os","as","um","de","do","da","em","no","na","por","para","com","que","e","se","não","mais",
]);

function extractKeywords(prompt: string): string[] {
  return prompt.toLowerCase().match(/\w+/g)
    ?.filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 5) ?? [];
}

const TIER_LIMITS = { trivial: 0, standard: 3, complex: 5 };

export function processSearchHook(prompt: string, memRepo: MemoriesRepo, sessRepo: SessionsRepo, config: Config): string {
  if (!prompt) return "";

  const tier = config.hooks.trivialSkip ? classifyPrompt(prompt, config) : "standard";
  let maxResults = TIER_LIMITS[tier];
  if (maxResults === 0) return "";

  const session = sessRepo.getOrCreate(config.budget);
  const remaining = session.budget - session.spent;

  if (remaining < session.floor) {
    maxResults = 1;
  }

  if (tier === "complex") {
    sessRepo.refill(session.id, config.budget.refill);
  }

  const keywords = extractKeywords(prompt);
  if (keywords.length < 2) return "";

  const query = keywords.join(" ");
  const dbResults = memRepo.search(query, { limit: maxResults });
  const fileResults = searchFileMemories(query).slice(0, Math.min(2, maxResults));

  const lines: string[] = [];
  for (const r of dbResults) {
    lines.push(`[db] ${r.title}: ${(r.body ?? "").slice(0, 120)}`);
  }
  for (const r of fileResults) {
    lines.push(`[file] ${r.title}: ${(r.body ?? "").slice(0, 120)}`);
  }

  if (!lines.length) return "";

  const output = "Memory context found:\n" + lines.map(l => `  - ${l}`).join("\n");
  const tokens = estimateTokens(output);
  sessRepo.debit(session.id, tokens);

  return output;
}

// CLI entry point (for bin script)
export function main(): void {
  try {
    let raw = "";
    try { raw = require("node:fs").readFileSync(0, "utf-8"); } catch { /* stdin empty */ }
    const data = raw.trim() ? JSON.parse(raw) : {};
    const prompt = data.prompt ?? "";
    if (!prompt) process.exit(0);

    const { createDatabase } = require("../db/database.js");
    const { MemoriesRepo } = require("../db/memories.js");
    const { SessionsRepo } = require("../db/sessions.js");
    const { loadConfig } = require("../lib/config.js");
    const { getDefaultDbPath, getDefaultConfigPath } = require("../lib/config.js");

    const config = loadConfig(getDefaultConfigPath());
    const db = createDatabase(config.database.path || getDefaultDbPath());
    const memRepo = new MemoriesRepo(db);
    const sessRepo = new SessionsRepo(db);

    const output = processSearchHook(prompt, memRepo, sessRepo, config);
    if (output) process.stdout.write(output + "\n");

    db.close();
  } catch {
    // Hooks MUST fail silently
    process.exit(0);
  }
}
```

```typescript
// src/hooks/session-context.ts
import { MemoriesRepo } from "../db/memories.js";
import { PitfallsRepo } from "../db/pitfalls.js";
import { SessionsRepo } from "../db/sessions.js";
import { estimateTokens } from "../lib/budget.js";
import type { Config } from "../lib/config.js";

export function processSessionHook(memRepo: MemoriesRepo, pitRepo: PitfallsRepo, sessRepo: SessionsRepo, config: Config): string {
  const session = sessRepo.getOrCreate(config.budget);

  const memories = memRepo.list({ limit: config.hooks.sessionStartMemories });
  const pitfalls = pitRepo.list("", config.hooks.sessionStartPitfalls);

  const lines: string[] = [];
  if (memories.length) {
    lines.push("Recent memories:");
    for (const m of memories) lines.push(`  - [${m.memory_type}] ${m.title}`);
  }
  if (pitfalls.length) {
    lines.push("Active pitfalls:");
    for (const p of pitfalls) lines.push(`  - (x${p.occurrence_count}) ${p.title}`);
  }

  const output = lines.join("\n");
  if (output) {
    sessRepo.debit(session.id, estimateTokens(output));
  }

  return output;
}

export function main(): void {
  try {
    try { require("node:fs").readFileSync(0, "utf-8"); } catch { /* consume stdin */ }

    const { createDatabase } = require("../db/database.js");
    const { MemoriesRepo } = require("../db/memories.js");
    const { PitfallsRepo } = require("../db/pitfalls.js");
    const { SessionsRepo } = require("../db/sessions.js");
    const { loadConfig, getDefaultDbPath, getDefaultConfigPath } = require("../lib/config.js");

    const config = loadConfig(getDefaultConfigPath());
    const db = createDatabase(config.database.path || getDefaultDbPath());

    const output = processSessionHook(new MemoriesRepo(db), new PitfallsRepo(db), new SessionsRepo(db), config);
    if (output) process.stdout.write(output + "\n");

    db.close();
  } catch {
    process.exit(0);
  }
}
```

- [ ] **Step 3: Run all tests — verify PASS**

```bash
npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add hooks — smart skip, budget-aware search-context + session-context"
```

---

### Task 10: MCP Server Entry Point

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Implement MCP server wiring**

This wires all tool handlers to the MCP SDK. No dedicated test — integration tested via the tools tests + manual smoke test.

```typescript
// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDatabase } from "./db/database.js";
import { MemoriesRepo } from "./db/memories.js";
import { DecisionsRepo } from "./db/decisions.js";
import { PitfallsRepo } from "./db/pitfalls.js";
import { SessionsRepo } from "./db/sessions.js";
import { loadConfig } from "./lib/config.js";
import { createLogger, logLevelFromEnv } from "./lib/logger.js";
import { handleMemoryStore } from "./tools/memory-store.js";
import { handleMemorySearch } from "./tools/memory-search.js";
import { handleMemoryGet } from "./tools/memory-get.js";
import { handleMemoryList } from "./tools/memory-list.js";
import { handleMemoryDelete } from "./tools/memory-delete.js";
import { handleDecisionsLog } from "./tools/decisions-log.js";
import { handlePitfallsLog } from "./tools/pitfalls-log.js";
import { getDefaultConfigPath, getDefaultDbPath } from "./lib/config.js";

const log = createLogger(logLevelFromEnv());
const config = loadConfig(getDefaultConfigPath());
const db = createDatabase(config.database.path || getDefaultDbPath());
const memRepo = new MemoriesRepo(db);
const decRepo = new DecisionsRepo(db);
const pitRepo = new PitfallsRepo(db);
const sessRepo = new SessionsRepo(db);

// Initial prune
const pruned = memRepo.pruneStale(config.pruning.maxAgeDays, config.pruning.minImportance);
if (pruned > 0) log.info(`Pruned ${pruned} stale memories`);

// Pruning interval
if (config.pruning.enabled) {
  setInterval(() => {
    try {
      const n = memRepo.pruneStale(config.pruning.maxAgeDays, config.pruning.minImportance);
      if (n > 0) log.info(`Pruned ${n} stale memories`);
    } catch (e) { log.warn(`Pruning error: ${e}`); }
  }, config.pruning.intervalHours * 3600_000);
}

// Graceful shutdown
function shutdown() { try { db.close(); } catch {} process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const server = new McpServer({ name: "memento-mcp", version: "1.0.0" });

server.tool("memory_store",
  "Store a memory. Types: fact, decision, preference, pattern, architecture, pitfall. Scope: project or global. Pin to protect from pruning. Use supersedes_id to replace an existing memory.",
  {
    title: z.string(), content: z.string(), memory_type: z.string().default("fact"),
    scope: z.string().default("project"), project_path: z.string().default(""),
    tags: z.array(z.string()).default([]), importance: z.number().default(0.5),
    supersedes_id: z.string().default(""), pin: z.boolean().default(false),
  },
  async (params) => ({ content: [{ type: "text", text: await handleMemoryStore(memRepo, params) }] })
);

server.tool("memory_search",
  "Search memories using full-text search. detail='index': titles + scores only (~30 tokens/result). detail='full': titles + body preview (~120 tokens/result). Use memory_get(id) for complete body.",
  {
    query: z.string(), project_path: z.string().default(""),
    memory_type: z.string().default(""), limit: z.number().default(10),
    detail: z.enum(["index", "full"]).default("full"),
    include_file_memories: z.boolean().default(true),
  },
  async (params) => ({ content: [{ type: "text", text: await handleMemorySearch(memRepo, config, params) }] })
);

server.tool("memory_get",
  "Retrieve full content of a specific memory by ID. Use after memory_search(detail='index') to get complete body.",
  { memory_id: z.string() },
  async (params) => ({ content: [{ type: "text", text: await handleMemoryGet(memRepo, params) }] })
);

server.tool("memory_list",
  "List memories with optional filters. No search query needed.",
  {
    project_path: z.string().default(""), memory_type: z.string().default(""),
    scope: z.string().default(""), pinned_only: z.boolean().default(false),
    limit: z.number().default(20), detail: z.enum(["index", "full"]).default("full"),
    include_file_memories: z.boolean().default(false),
  },
  async (params) => ({ content: [{ type: "text", text: await handleMemoryList(memRepo, config, params) }] })
);

server.tool("memory_delete",
  "Soft-delete a memory by ID. Only works for SQLite memories (not file-based).",
  { memory_id: z.string() },
  async (params) => ({ content: [{ type: "text", text: await handleMemoryDelete(memRepo, params) }] })
);

server.tool("decisions_log",
  "Log, list, or search architectural decisions. action: 'store' (title+body), 'list', 'search' (query). Categories: general, architecture, tooling, convention, performance.",
  {
    action: z.string(), project_path: z.string(),
    title: z.string().default(""), body: z.string().default(""),
    category: z.string().default("general"), importance: z.number().default(0.7),
    supersedes_id: z.string().default(""), query: z.string().default(""),
    limit: z.number().default(10),
  },
  async (params) => ({ content: [{ type: "text", text: await handleDecisionsLog(decRepo, params) }] })
);

server.tool("pitfalls_log",
  "Track recurring problems. action: 'store' (title+body, auto-increments on duplicate), 'list' (unresolved by default), 'resolve' (pitfall_id).",
  {
    action: z.string(), project_path: z.string(),
    title: z.string().default(""), body: z.string().default(""),
    importance: z.number().default(0.6), limit: z.number().default(10),
    include_resolved: z.boolean().default(false), pitfall_id: z.string().default(""),
  },
  async (params) => ({ content: [{ type: "text", text: await handlePitfallsLog(pitRepo, params) }] })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("memento-mcp server started");
}

main().catch((e) => { log.error(`Fatal: ${e}`); process.exit(1); });
```

Note: `getDefaultConfigPath()` and `getDefaultDbPath()` need to be added to `config.ts`:

```typescript
// Add to src/lib/config.ts
import { join } from "node:path";
import { homedir, platform } from "node:os";

export function getDefaultDataDir(): string {
  const p = platform();
  if (p === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "memento-mcp");
  if (p === "darwin") return join(homedir(), "Library", "Application Support", "memento-mcp");
  return join(homedir(), ".local", "share", "memento-mcp");
}

export function getDefaultConfigPath(): string {
  const p = platform();
  if (p === "win32") return join(getDefaultDataDir(), "config.toml");
  if (p === "darwin") return join(getDefaultDataDir(), "config.toml");
  return join(homedir(), ".config", "memento-mcp", "config.toml");
}

export function getDefaultDbPath(): string {
  return join(getDefaultDataDir(), "memento.sqlite");
}
```

- [ ] **Step 2: Verify build compiles**

```bash
npx tsup src/index.ts --format esm --dts --clean
```
Expected: builds to `dist/` without errors.

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: wire MCP server entry point with all 7 tools + platform paths + pruning"
```

---

### Task 11: CLI + Installer

**Files:**
- Create: `src/cli/main.ts`
- Create: `src/cli/install.ts`

- [ ] **Step 1: Implement CLI main**

```typescript
// src/cli/main.ts
#!/usr/bin/env node
import { argv } from "node:process";

const command = argv[2];

if (command === "install") {
  const { runInstaller } = await import("./install.js");
  await runInstaller();
} else if (command === "uninstall") {
  const { runUninstaller } = await import("./install.js");
  await runUninstaller();
} else if (command === "--version" || command === "-v") {
  console.log("memento-mcp v1.0.0");
} else {
  // Default: run MCP server
  await import("../index.js");
}
```

- [ ] **Step 2: Implement installer (core logic)**

```typescript
// src/cli/install.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { getDefaultConfigPath, getDefaultDataDir, getDefaultDbPath } from "../lib/config.js";

function detectClient(): "claude-code" | "cursor" | "manual" {
  if (existsSync(join(homedir(), ".claude", "settings.json"))) return "claude-code";
  if (existsSync(join(homedir(), ".cursor", "mcp.json"))) return "cursor";
  return "manual";
}

function isGloballyInstalled(): boolean {
  try { execSync("memento-mcp --version", { stdio: "pipe" }); return true; } catch { return false; }
}

function atomicJsonWrite(path: string, data: any): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  const { renameSync } = require("node:fs");
  renameSync(tmp, path);
}

function registerMcpServer(client: "claude-code" | "cursor"): void {
  const configPath = client === "claude-code"
    ? join(homedir(), ".claude", "settings.json")
    : join(homedir(), ".cursor", "mcp.json");

  let config: any = {};
  try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch { /* new file */ }

  if (client === "claude-code") {
    config.mcpServers = config.mcpServers ?? {};
    config.mcpServers["memento-mcp"] = { command: "memento-mcp", args: [], type: "stdio" };
  } else {
    config.mcpServers = config.mcpServers ?? {};
    config.mcpServers["memento-mcp"] = { command: "memento-mcp", args: [] };
  }

  atomicJsonWrite(configPath, config);
  console.log(`  ✓ MCP server registered in ${configPath}`);
}

function registerHooks(): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings: any = {};
  try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { /* new */ }

  settings.hooks = settings.hooks ?? {};

  // SessionStart hook
  settings.hooks.SessionStart = settings.hooks.SessionStart ?? [];
  const sessionHookExists = settings.hooks.SessionStart.some((h: any) =>
    h.hooks?.some((hh: any) => hh.command?.includes("memento-hook-session"))
  );
  if (!sessionHookExists) {
    settings.hooks.SessionStart.push({
      hooks: [{ type: "command", command: "memento-hook-session", timeout: 5 }]
    });
  }

  // UserPromptSubmit hook
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit ?? [];
  const searchHookExists = settings.hooks.UserPromptSubmit.some((h: any) =>
    h.hooks?.some((hh: any) => hh.command?.includes("memento-hook-search"))
  );
  if (!searchHookExists) {
    settings.hooks.UserPromptSubmit.push({
      hooks: [{ type: "command", command: "memento-hook-search", timeout: 5 }]
    });
  }

  atomicJsonWrite(settingsPath, settings);
  console.log("  ✓ Hooks registered (SessionStart + UserPromptSubmit)");
}

function createDefaultConfig(): void {
  const configPath = getDefaultConfigPath();
  if (existsSync(configPath)) {
    console.log(`  ✓ Config already exists: ${configPath}`);
    return;
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `# Memento MCP Configuration
# Env vars override: MEMENTO_BUDGET, MEMENTO_FLOOR, etc.

[budget]
total = 8000
floor = 500
refill = 200
session_timeout = 1800

[search]
default_detail = "full"
max_results = 10
body_preview_chars = 200

[hooks]
trivial_skip = true
session_start_memories = 5
session_start_pitfalls = 5
custom_trivial_patterns = []

[pruning]
enabled = true
max_age_days = 60
min_importance = 0.3
interval_hours = 24

[database]
path = ""
`);
  try { chmodSync(configPath, 0o600); } catch { /* Windows doesn't support chmod */ }
  console.log(`  ✓ Config created: ${configPath}`);
}

function checkMigration(): void {
  const oldDb = join(homedir(), ".local", "share", "claude-memory", "context.sqlite");
  if (existsSync(oldDb)) {
    const newDb = getDefaultDbPath();
    if (!existsSync(newDb)) {
      console.log(`\n  Found existing claude-memory database: ${oldDb}`);
      console.log("  Copying to new location...");
      mkdirSync(dirname(newDb), { recursive: true });
      copyFileSync(oldDb, newDb);
      console.log(`  ✓ Migrated to: ${newDb}`);
    }
  }
}

export async function runInstaller(): Promise<void> {
  console.log("\n  memento-mcp installer\n");

  // Check global install
  if (!isGloballyInstalled()) {
    console.log("  ⚠ memento-mcp is not installed globally. Hooks require a global install.");
    console.log("  Run: npm install -g memento-mcp");
    console.log("  Then: memento-mcp install\n");
    process.exit(1);
  }

  // Create data dir
  mkdirSync(getDefaultDataDir(), { recursive: true });
  console.log(`  ✓ Data directory: ${getDefaultDataDir()}`);

  // Check migration
  checkMigration();

  // Config
  createDefaultConfig();

  // Detect client
  const client = detectClient();
  console.log(`  ✓ Detected client: ${client}`);

  if (client === "manual") {
    console.log("\n  Manual setup required. Add to your MCP client config:");
    console.log('  { "command": "memento-mcp", "args": [], "type": "stdio" }');
  } else {
    registerMcpServer(client);
    if (client === "claude-code") registerHooks();
  }

  // Verify DB
  try {
    const { createDatabase } = await import("../db/database.js");
    const db = createDatabase(getDefaultDbPath());
    db.close();
    console.log(`  ✓ Database verified: ${getDefaultDbPath()}`);
  } catch (e) {
    console.log(`  ✗ Database error: ${e}`);
  }

  console.log("\n  ✓ Installation complete!\n");
}

export async function runUninstaller(): Promise<void> {
  console.log("\n  memento-mcp uninstaller\n");

  // Remove MCP server from Claude Code settings
  const settingsPath = join(homedir(), ".claude", "settings.json");
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (settings.mcpServers?.["memento-mcp"]) {
      delete settings.mcpServers["memento-mcp"];
      console.log("  ✓ MCP server entry removed");
    }
    // Remove hooks
    for (const hookType of ["SessionStart", "UserPromptSubmit"]) {
      if (settings.hooks?.[hookType]) {
        settings.hooks[hookType] = settings.hooks[hookType].filter((h: any) =>
          !h.hooks?.some((hh: any) => hh.command?.includes("memento-hook"))
        );
      }
    }
    atomicJsonWrite(settingsPath, settings);
    console.log("  ✓ Hooks removed");
  } catch { /* no settings file */ }

  console.log("  ✓ Data and config preserved. Remove manually if desired:");
  console.log(`    Data: ${getDefaultDataDir()}`);
  console.log(`    Config: ${getDefaultConfigPath()}`);
  console.log("\n  ✓ Uninstall complete!\n");
}
```

- [ ] **Step 3: Verify full build**

```bash
npm run build
```
Expected: all entry points compile to `dist/`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add CLI (main + installer) with client detection, migration, hook registration"
```

---

### Task 12: Full Build Verification + README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 2: Run full build**

```bash
npm run build
```
Expected: `dist/` contains `cli/main.js`, `hooks/search-context.js`, `hooks/session-context.js`, `index.js`.

- [ ] **Step 3: Smoke test MCP server locally**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js
```
Expected: JSON response listing 7 tools.

- [ ] **Step 4: Write README.md**

README should cover: what it is, install, features, comparison with claude-mem, configuration, development, license. See spec for content guidance.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: add README, verify build + tests pass, smoke test MCP server"
```

---

## Execution Order Summary

| Task | What | Tests |
|------|------|-------|
| 1 | Project scaffolding | — |
| 2 | Logger + Config | 2 test files |
| 3 | Decay + Classify + Budget + Formatter | 4 test files |
| 4 | Database — connection + migrations | 1 test file |
| 5 | Memories CRUD + FTS5 | 1 test file |
| 6 | Decisions + Pitfalls + Sessions | 3 test files |
| 7 | File memory reader | 1 test file |
| 8 | MCP tool handlers | 2 test files |
| 9 | Hooks (smart skip + budget) | 2 test files |
| 10 | MCP server entry point | build verification |
| 11 | CLI + Installer | build verification |
| 12 | Full verification + README | smoke test |

**Total: 12 tasks, 16 test files, ~1400 LOC implementation + ~800 LOC tests.**
