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
