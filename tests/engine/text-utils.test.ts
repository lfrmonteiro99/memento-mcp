import { describe, it, expect } from "vitest";
import { scrubSecrets, stringifyToolResponse, extractFingerprints } from "../../src/engine/text-utils.js";

describe("scrubSecrets (G2)", () => {
  it("scrubs api_key assignments", () => {
    const input = "api_key=sk-secret-value-here";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-secret-value-here");
  });

  it("scrubs password assignments", () => {
    const input = "password=mySecurePass123";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("mySecurePass123");
  });

  it("scrubs secret assignments", () => {
    const input = "secret=top-secret-data";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("top-secret-data");
  });

  it("scrubs token assignments", () => {
    const input = "token=ghp_1234567890abcdef";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("ghp_1234567890abcdef");
  });

  it("scrubs AWS env-style secrets", () => {
    const input = "AWS_SECRET_ACCESS_KEY=abcdef1234567890abcdef1234567890";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("abcdef1234567890abcdef1234567890");
  });

  it("scrubs GITHUB_ env-style secrets", () => {
    const input = "GITHUB_TOKEN=ghp_abcdef1234";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("ghp_abcdef1234");
  });

  it("scrubs AZURE_ env-style secrets", () => {
    const input = "AZURE_API_KEY=secretazurekey";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("secretazurekey");
  });

  it("scrubs GCP_ env-style secrets", () => {
    const input = "GCP_SERVICE_ACCOUNT_KEY=gcpkey123";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("gcpkey123");
  });

  it("scrubs STRIPE_ env-style secrets", () => {
    const input = "STRIPE_API_KEY=sk_live_abcdef";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk_live_abcdef");
  });

  it("scrubs OPENAI_ env-style secrets", () => {
    const input = "OPENAI_API_KEY=sk-proj-abc123";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-proj-abc123");
  });

  it("scrubs ANTHROPIC_ env-style secrets", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-v1-abc123";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-ant-v1-abc123");
  });

  it("scrubs PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc\n-----END RSA PRIVATE KEY-----";
    const result = scrubSecrets(pem);
    expect(result).toContain("[REDACTED PRIVATE KEY]");
    expect(result).not.toContain("MIIEowIBAAKCAQEAabc");
  });

  it("scrubs EC PRIVATE KEY blocks", () => {
    const pem = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIIGlVmK3c1Q7n+8xyz\n-----END EC PRIVATE KEY-----";
    const result = scrubSecrets(pem);
    expect(result).toContain("[REDACTED PRIVATE KEY]");
    expect(result).not.toContain("MHcCAQEEIIGlVmK3c1Q7n+8xyz");
  });

  it("scrubs OPENSSH PRIVATE KEY blocks", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----";
    const result = scrubSecrets(pem);
    expect(result).toContain("[REDACTED PRIVATE KEY]");
    expect(result).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU");
  });

  it("scrubs PGP PRIVATE KEY BLOCK", () => {
    const pgp = "-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v1\nlQEVBFm7yvEBDAC\n-----END PGP PRIVATE KEY BLOCK-----";
    const result = scrubSecrets(pgp);
    expect(result).toContain("[REDACTED PRIVATE KEY]");
    expect(result).not.toContain("lQEVBFm7yvEBDAC");
  });

  it("redaction is idempotent", () => {
    const input = "api_key=sk-secret";
    const redacted1 = scrubSecrets(input);
    const redacted2 = scrubSecrets(redacted1);
    expect(redacted1).toBe(redacted2);
  });

  it("leaves non-secret content unchanged", () => {
    const input = "This is normal text with no secrets here";
    const result = scrubSecrets(input);
    expect(result).toBe(input);
  });
});

describe("stringifyToolResponse (K2)", () => {
  it("handles string tool_response as-is", () => {
    const input = "string output";
    const result = stringifyToolResponse(input);
    expect(result).toBe("string output");
  });

  it("extracts stdout and stderr from Bash response", () => {
    const input = {
      stdout: "success output",
      stderr: "error output",
      interrupted: false,
    };
    const result = stringifyToolResponse(input);
    expect(result).toContain("success output");
    expect(result).toContain("error output");
  });

  it("handles Bash with isImage flag", () => {
    const input = {
      stdout: "image data",
      stderr: "",
      interrupted: false,
      isImage: true,
    };
    const result = stringifyToolResponse(input);
    expect(typeof result).toBe("string");
  });

  it("extracts content from Read response", () => {
    const input = {
      content: "file contents here",
    };
    const result = stringifyToolResponse(input);
    expect(result).toBe("file contents here");
  });

  it("extracts output from Read response (fallback)", () => {
    const input = {
      output: "file output here",
    };
    const result = stringifyToolResponse(input);
    expect(result).toBe("file output here");
  });

  it("extracts output from Grep response", () => {
    const input = {
      output: "file.ts:10: match",
    };
    const result = stringifyToolResponse(input);
    expect(result).toBe("file.ts:10: match");
  });

  it("extracts matches from Grep response (alternative)", () => {
    const input = {
      matches: ["file1.ts:10: match", "file2.ts:20: match"],
    };
    const result = stringifyToolResponse(input);
    expect(typeof result).toBe("string");
    expect(result).toContain("match");
  });

  it("extracts oldString and newString from Edit response", () => {
    const input = {
      oldString: "function foo() {}",
      newString: "function foo(x: number) { return x; }",
    };
    const result = stringifyToolResponse(input);
    expect(result).toContain("foo");
  });

  it("falls back to JSON.stringify for unknown shape", () => {
    const input = {
      unknown_field: "value",
      other: 123,
    };
    const result = stringifyToolResponse(input);
    expect(result).toContain("value");
    expect(result).toContain("123");
  });

  it("handles null as empty string", () => {
    const result = stringifyToolResponse(null);
    expect(result).toBe("");
  });

  it("handles undefined as empty string", () => {
    const result = stringifyToolResponse(undefined);
    expect(result).toBe("");
  });

  it("handles number as string", () => {
    const result = stringifyToolResponse(123);
    expect(result).toBe("123");
  });

  it("handles boolean as string", () => {
    const result = stringifyToolResponse(true);
    expect(result).toBe("true");
  });
});

describe("extractFingerprints", () => {
  it("extracts file paths with extensions", () => {
    const text = "src/components/Button.tsx src/utils/helper.ts";
    const fps = extractFingerprints(text);
    expect(fps).toContain("src/components/Button.tsx");
    expect(fps).toContain("src/utils/helper.ts");
  });

  it("extracts PascalCase identifiers (>=4 chars)", () => {
    const text = "UserService AuthController MyClass";
    const fps = extractFingerprints(text);
    expect(fps).toContain("UserService");
    expect(fps).toContain("AuthController");
    expect(fps).toContain("MyClass");
  });

  it("ignores PascalCase identifiers <4 chars", () => {
    const text = "A B CD ABC";
    const fps = extractFingerprints(text);
    expect(fps.includes("A")).toBe(false);
    expect(fps.includes("B")).toBe(false);
    expect(fps.includes("CD")).toBe(false);
  });

  it("extracts camelCase identifiers (>=5 chars, starting lower)", () => {
    const text = "getUserById verifyToken processData";
    const fps = extractFingerprints(text);
    expect(fps).toContain("getUserById");
    expect(fps).toContain("verifyToken");
    expect(fps).toContain("processData");
  });

  it("ignores camelCase identifiers <5 chars", () => {
    const text = "get is do foo";
    const fps = extractFingerprints(text);
    expect(fps.includes("get")).toBe(false);
    expect(fps.includes("is")).toBe(false);
    expect(fps.includes("do")).toBe(false);
  });

  it("limits camelCase extraction to top 10 longest", () => {
    const words = Array.from({ length: 15 }, (_, i) => `identifier${i}LongName`).join(" ");
    const fps = extractFingerprints(words);
    // Should contain at most 10 camelCase identifiers
    const camelCaseInFps = fps.filter(f => /^[a-z]/.test(f));
    expect(camelCaseInFps.length).toBeLessThanOrEqual(10);
  });

  it("deduplicates fingerprints", () => {
    const text = "UserService UserService getUserById getUserById";
    const fps = extractFingerprints(text);
    const unique = new Set(fps);
    expect(fps.length).toBe(unique.size);
  });

  it("returns empty array for empty/null text", () => {
    expect(extractFingerprints("")).toEqual([]);
    expect(extractFingerprints(null as any)).toEqual([]);
  });

  it("handles mixed content", () => {
    const text = `
      Import UserService from src/services/User.ts
      const token = getAuthToken();
      class ApiHandler implements RequestHandler {}
    `;
    const fps = extractFingerprints(text);
    expect(fps.length).toBeGreaterThan(0);
    expect(typeof fps[0]).toBe("string");
  });

  it("supports various common file extensions", () => {
    const text = "app.ts config.json style.css db.py main.rs handler.go";
    const fps = extractFingerprints(text);
    const files = fps.filter(f => f.includes("."));
    expect(files.length).toBeGreaterThan(0);
  });
});
