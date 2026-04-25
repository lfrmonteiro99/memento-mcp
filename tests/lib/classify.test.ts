// tests/lib/classify.test.ts
import { describe, it, expect } from "vitest";
import { classifyPrompt } from "../../src/lib/classify.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { ENGLISH_PROFILE, PORTUGUESE_PROFILE } from "../../src/lib/profiles.js";

const cfg = DEFAULT_CONFIG;

describe("classifyPrompt", () => {
  it.each(["ok", "sim", "yes", "no", "bora", "done", "lgtm", "k"])
    ('classifies "%s" as trivial', (prompt) => {
      expect(classifyPrompt(prompt, cfg, ENGLISH_PROFILE)).toBe("trivial");
    });

  it("classifies short prompts (<8 chars) as trivial", () => {
    expect(classifyPrompt("hi", cfg, ENGLISH_PROFILE)).toBe("trivial");
    expect(classifyPrompt("sup?", cfg, ENGLISH_PROFILE)).toBe("trivial");
  });

  it("strips trailing punctuation before matching", () => {
    expect(classifyPrompt("ok!!", cfg, ENGLISH_PROFILE)).toBe("trivial");
    expect(classifyPrompt("yes.", cfg, ENGLISH_PROFILE)).toBe("trivial");
  });

  it("classifies prompts with code blocks as complex", () => {
    expect(classifyPrompt("fix this:\n```\nconst x = 1;\n```", cfg, ENGLISH_PROFILE)).toBe("complex");
  });

  it("classifies prompts with file paths as complex", () => {
    expect(classifyPrompt("check /home/user/file.ts", cfg, ENGLISH_PROFILE)).toBe("complex");
  });

  it("classifies slash commands as complex", () => {
    expect(classifyPrompt("/commit", cfg, ENGLISH_PROFILE)).toBe("complex");
  });

  it("classifies long prompts (>150 chars) as complex", () => {
    expect(classifyPrompt("a".repeat(151), cfg, ENGLISH_PROFILE)).toBe("complex");
  });

  it("does NOT classify 'yes/no' as complex (/ between words, not a path)", () => {
    expect(classifyPrompt("is it yes/no?", cfg, ENGLISH_PROFILE)).toBe("standard");
  });

  it("classifies normal questions as standard", () => {
    expect(classifyPrompt("what does this function do?", cfg, ENGLISH_PROFILE)).toBe("standard");
    expect(classifyPrompt("fix the auth bug in login.ts", cfg, ENGLISH_PROFILE)).toBe("standard");
  });

  it("merges custom trivial patterns from config", () => {
    const custom = { ...cfg, hooks: { ...cfg.hooks, customTrivialPatterns: ["roger", "ack"] } };
    expect(classifyPrompt("roger", custom, ENGLISH_PROFILE)).toBe("trivial");
    expect(classifyPrompt("ack", custom, ENGLISH_PROFILE)).toBe("trivial");
  });

  it("Portuguese trivial prompts classify as trivial under portuguese profile but standard under english", () => {
    // Portuguese trivials match the profile patterns
    expect(classifyPrompt("obrigado", cfg, PORTUGUESE_PROFILE)).toBe("trivial");
    expect(classifyPrompt("tudo bem", cfg, PORTUGUESE_PROFILE)).toBe("trivial");
    // These same prompts should be standard under english (no pattern match, >8 chars when counted)
    expect(classifyPrompt("obrigado", cfg, ENGLISH_PROFILE)).toBe("standard");
    expect(classifyPrompt("tudo bem", cfg, ENGLISH_PROFILE)).toBe("standard");
  });
});
