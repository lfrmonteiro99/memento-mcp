// tests/integration/profile-search.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { DEFAULT_CONFIG, loadConfig } from "../../src/lib/config.js";
import { processSearchHook } from "../../src/hooks/search-context.js";
import { PORTUGUESE_PROFILE, ENGLISH_PROFILE } from "../../src/lib/profiles.js";

describe("profile-aware search hook integration", () => {
  let db: Database.Database;
  let memRepo: MemoriesRepo;
  let sessRepo: SessionsRepo;
  const dbPath = ":memory:";

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    sessRepo = new SessionsRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it("Portuguese profile extracts keywords without Portuguese stop-words", () => {
    // Store a Portuguese memory
    const projId = memRepo.ensureProject("/test");
    memRepo.store({
      title: "Como configurar o sistema",
      body: "Este é um guia sobre como configurar e manter o sistema. O processo é simples.",
      memory_type: "guide",
      scope: "project",
      project_id: projId,
      tags: [],
      importance_score: 0.5,
    });

    // Create a Portuguese config with portuguese profile
    const config = {
      ...DEFAULT_CONFIG,
      profile: { ...DEFAULT_CONFIG.profile, id: "portuguese" },
    };

    // Run search hook with Portuguese query
    const result = processSearchHook(
      db,
      "como configurar",
      memRepo,
      sessRepo,
      config
    );

    // Should find the memory (keywords extracted without Portuguese stop-words)
    expect(result).toContain("configurar");
    expect(result.length).toBeGreaterThan(0);
  });

  it("English profile uses English stop-words, misses Portuguese queries", () => {
    // Store a Portuguese memory
    const projId = memRepo.ensureProject("/test");
    memRepo.store({
      title: "Como configurar o sistema",
      body: "Este é um guia sobre como configurar e manter o sistema",
      memory_type: "guide",
      scope: "project",
      project_id: projId,
      tags: [],
      importance_score: 0.5,
    });

    // Create config with English profile
    const config = {
      ...DEFAULT_CONFIG,
      profile: { ...DEFAULT_CONFIG.profile, id: "english" },
    };

    // Run search with Portuguese words that are not in memory index
    // (English stop-words are used, so keywords might be different)
    const result = processSearchHook(
      db,
      "oi tudo bem",
      memRepo,
      sessRepo,
      config
    );

    // Short Portuguese greetings may not match because they're under minWordLength
    // or not relevant to the English-indexed memory
    expect(result.length).toBe(0);
  });

  it("respects MEMENTO_PROFILE env var in resolveProfile", async () => {
    process.env.MEMENTO_PROFILE = "portuguese";

    const config = {
      ...DEFAULT_CONFIG,
      profile: { ...DEFAULT_CONFIG.profile, id: "english" },
    };

    // Import and test the resolveProfile function
    const { resolveProfile } = await import("../../src/lib/profiles.js");
    const profile = resolveProfile(config);

    expect(profile.id).toBe("portuguese");
    expect(profile.stopWords.has("o")).toBe(true);
    expect(profile.stopWords.has("the")).toBe(false);

    delete process.env.MEMENTO_PROFILE;
  });
});
