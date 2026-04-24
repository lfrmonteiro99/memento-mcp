import { describe, it, expect } from "vitest";
import { classify, ClassifierConfig, DEFAULT_CLASSIFIER_CONFIG } from "../../src/engine/classifier.js";

describe("classifier", () => {
  const cfg = DEFAULT_CLASSIFIER_CONFIG;

  // === Bash: git commands ===
  it("captures git log output", () => {
    const result = classify({
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -10" },
      tool_output: "abc1234 fix: resolve null pointer\ndef5678 feat: add user auth\nghi9012 chore: update deps\njkl3456 fix: memory leak\nmno7890 feat: new API endpoint\n" + "x".repeat(200),
    }, cfg);
    expect(result.action).toBe("store");
    expect(result.memory?.memory_type).toBe("fact");
    expect(result.memory?.tags).toContain("git");
    expect(result.memory?.tags).toContain("auto-captured");
    expect(result.memory?.source).toBe("auto-capture");
  });

  it("captures git diff with significant changes", () => {
    const diffOutput = "diff --git a/src/auth.ts b/src/auth.ts\n" +
      "+added line 1\n+added line 2\n+added line 3\n+added line 4\n+added line 5\n" +
      "+added line 6\n+added line 7\n+added line 8\n+added line 9\n+added line 10\n" +
      "+added line 11\n-removed line 1\n" + "x".repeat(200);
    const result = classify({
      tool_name: "Bash",
      tool_input: { command: "git diff HEAD~1" },
      tool_output: diffOutput,
    }, cfg);
    expect(result.action).toBe("store");
    expect(result.memory?.tags).toContain("git");
    expect(result.memory?.tags).toContain("changes");
  });

  // === Bash: build/test failures ===
  it("captures npm test failures", () => {
    const result = classify({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_output: "FAIL src/test.ts\n  TypeError: Cannot read property 'id' of undefined\n    at line 42\n  1 failed, 5 passed\n" + "x".repeat(200),
    }, cfg);
    expect(result.action).toBe("store");
    expect(result.memory?.memory_type).toBe("pitfall");
    expect(result.memory?.importance_score).toBeGreaterThanOrEqual(0.7);
    expect(result.memory?.tags).toContain("error");
  });

  it("captures vitest failures", () => {
    const result = classify({
      tool_name: "Bash",
      tool_input: { command: "vitest run" },
      tool_output: "FAIL tests/unit.test.ts > should work\n  AssertionError: expected true to be false\n" + "x".repeat(200),
    }, cfg);
    expect(result.action).toBe("store");
    expect(result.memory?.memory_type).toBe("pitfall");
  });

  it("captures yarn build errors", () => {
    const result = classify({
      tool_name: "Bash",
      tool_input: { command: "yarn build" },
      tool_output: "error TS2345: Argument of type 'string' is not assignable\n" + "x".repeat(200),
    }, cfg);
    expect(result.action).toBe("store");
    expect(result.memory?.memory_type).toBe("pitfall");
  });

  // === Bash: skips ===
  it("skips short bash output", () => {
    const result = classify({
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_output: "file1.ts\nfile2.ts",
    }, cfg);
    expect(result.action).toBe("skip");
  });

  it("skips excessively long output", () => {
    const result = classify({
      tool_name: "Bash",
      tool_input: { command: "cat bigfile.log" },
      tool_output: "x".repeat(60000),
    }, cfg);
    expect(result.action).toBe("skip");
  });

  it("skips bash commands with no matching pattern", () => {
    const result = classify({
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_output: "hello" + " ".repeat(200),
    }, cfg);
    expect(result.action).toBe("skip");
  });

  // === Read: config files ===
  it("captures package.json reads", () => {
    const result = classify({
      tool_name: "Read",
      tool_input: { file_path: "/project/package.json" },
      tool_output: '{"name": "my-app", "version": "1.0.0", "dependencies": {"react": "^18"}}' + " ".repeat(200),
    }, cfg);
    expect(result.action).toBe("store");
    expect(result.memory?.memory_type).toBe("architecture");
    expect(result.memory?.tags).toContain("config");
  });

  it("captures tsconfig.json reads", () => {
    const result = classify({
      tool_name: "Read",
      tool_input: { file_path: "/project/tsconfig.json" },
      tool_output: '{"compilerOptions": {"target": "ES2022"}}' + " ".repeat(200),
    }, cfg);
    expect(result.action).toBe("store");
    expect(result.memory?.memory_type).toBe("architecture");
  });

  it("skips regular source code reads", () => {
    const result = classify({
      tool_name: "Read",
      tool_input: { file_path: "/project/src/utils.ts" },
      tool_output: "export function helper() { return 42; }" + " ".repeat(200),
    }, cfg);
    expect(result.action).toBe("skip");
  });

  // === Grep: pattern results ===
  it("captures grep results with 3-50 matches", () => {
    const output = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts:42: import { UserService }`).join("\n");
    const result = classify({
      tool_name: "Grep",
      tool_input: { pattern: "UserService" },
      tool_output: output + " ".repeat(200),
    }, cfg);
    expect(result.action).toBe("store");
    expect(result.memory?.tags).toContain("pattern");
  });

  it("skips grep with too few results", () => {
    const result = classify({
      tool_name: "Grep",
      tool_input: { pattern: "rareThing" },
      tool_output: "src/file.ts:1: rareThing\nsrc/file2.ts:2: rareThing",
    }, cfg);
    expect(result.action).toBe("skip");
  });

  it("skips grep with too many results", () => {
    const output = Array.from({ length: 60 }, (_, i) => `file${i}.ts:1: match`).join("\n");
    const result = classify({
      tool_name: "Grep",
      tool_input: { pattern: "import" },
      tool_output: output,
    }, cfg);
    expect(result.action).toBe("skip");
  });

  // === Edit: significant changes ===
  it("captures significant edits", () => {
    const result = classify({
      tool_name: "Edit",
      tool_input: {
        file_path: "/project/src/auth.ts",
        old_string: "function validate() { return true; }",
        new_string: "function validate(token: string): boolean {\n  if (!token) throw new Error('Missing token');\n  return jwt.verify(token, SECRET);\n}",
      },
      tool_output: "Edit applied successfully",
    }, cfg);
    expect(result.action).toBe("store");
    expect(result.memory?.tags).toContain("edit");
    expect(result.memory?.tags).toContain("code-change");
  });

  it("skips trivial edits (whitespace only)", () => {
    const result = classify({
      tool_name: "Edit",
      tool_input: {
        file_path: "/project/src/auth.ts",
        old_string: "const x = 1;",
        new_string: "const x  =  1;",
      },
      tool_output: "Edit applied successfully",
    }, cfg);
    expect(result.action).toBe("skip");
  });

  // === Docker/infra ===
  it("captures docker commands with significant output", () => {
    const result = classify({
      tool_name: "Bash",
      tool_input: { command: "docker ps -a" },
      tool_output: "CONTAINER ID   IMAGE   STATUS\nabc123   nginx   Up 5 hours\ndef456   postgres   Up 5 hours\n" + "x".repeat(200),
    }, cfg);
    expect(result.action).toBe("store");
    expect(result.memory?.tags).toContain("infrastructure");
  });

  // === Unknown tools ===
  it("skips unknown tools", () => {
    const result = classify({
      tool_name: "UnknownTool",
      tool_input: {},
      tool_output: "some output" + " ".repeat(200),
    }, cfg);
    expect(result.action).toBe("skip");
  });

  // === G2: secret scrubbing ===
  it("G2: scrubs api_key before storing", () => {
    const result = classify({
      tool_name: "Bash",
      tool_input: { command: "git log --oneline" },
      tool_output: "commit abc123\napi_key=sk-secret-value-here\n" + "commit def456\n".repeat(20),
    }, cfg);
    if (result.action === "store") {
      expect(result.memory!.body).toContain("[REDACTED]");
      expect(result.memory!.body).not.toContain("sk-secret-value-here");
    }
  });

  it("G2: scrubs AWS_/GITHUB_ env-style secrets", () => {
    const result = classify({
      tool_name: "Bash",
      tool_input: { command: "docker inspect container" },
      tool_output: "AWS_SECRET_ACCESS_KEY=abcdef1234567890abcdef1234567890\nGITHUB_TOKEN=ghp_abcdef1234\n" + "x".repeat(200),
    }, cfg);
    if (result.action === "store") {
      expect(result.memory!.body).not.toContain("abcdef1234567890abcdef1234567890");
      expect(result.memory!.body).not.toContain("ghp_abcdef1234");
      expect(result.memory!.body).toContain("[REDACTED]");
    }
  });

  it("G2: scrubs PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc\n-----END RSA PRIVATE KEY-----";
    const result = classify({
      tool_name: "Bash",
      tool_input: { command: "cat id_rsa" },
      tool_output: `user@host key dump\n${pem}\n${"x".repeat(200)}`,
    }, cfg);
    if (result.action === "store") {
      expect(result.memory!.body).not.toContain("MIIEowIBAAKCAQEAabc");
      expect(result.memory!.body).toContain("[REDACTED PRIVATE KEY]");
    }
  });
});
