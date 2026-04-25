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

  // Issue #12 — Pattern 4: database / cache / mail env-var prefixes
  it("pattern 4 positive: scrubs DB_PASSWORD assignment", () => {
    const input = "DB_PASSWORD=correct-horse-battery-staple";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("correct-horse-battery-staple");
  });

  it("pattern 4 positive: scrubs DATABASE_URL assignment", () => {
    const input = "DATABASE_URL=postgres://u:p@host/db";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("postgres://u:p@host/db");
  });

  it("pattern 4 positive: scrubs REDIS_PASSWORD assignment", () => {
    const input = "REDIS_PASSWORD=super_secret_redis";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("super_secret_redis");
  });

  it("pattern 4 positive: scrubs SMTP_PASSWORD assignment", () => {
    const input = "SMTP_PASSWORD=mailpass123";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("mailpass123");
  });

  it("pattern 4 positive: scrubs MONGO_URI assignment", () => {
    const input = "MONGO_URI=mongodb://user:pass@localhost/db";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("mongodb://user:pass@localhost/db");
  });

  it("pattern 4 negative: does not scrub normal DB variable name without assignment", () => {
    // Plain word without assignment should not trigger pattern 4
    const input = "The DB_NAME is my_database";
    const result = scrubSecrets(input);
    // Should not redact DB_NAME since it's followed by ' is' not '='
    expect(result).toBe(input);
  });

  // Issue #12 — Pattern 5: [A-Z_]+_URL env-var
  it("pattern 5 positive: scrubs REDIS_URL with embedded creds", () => {
    const input = "REDIS_URL=redis://localhost:6379";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("redis://localhost:6379");
  });

  it("pattern 5 negative: plain URL text without env-var prefix is not scrubbed by p5", () => {
    // A URL not preceded by ENV_VAR= should not be scrubbed by pattern 5 alone
    const input = "Visit https://example.com for docs";
    const result = scrubSecrets(input);
    // Pattern 5 requires VAR_URL= format — plain URL without embedded creds passes through
    expect(result).toBe(input);
  });

  // Issue #12 — Pattern 6: URL with embedded credentials
  it("pattern 6 positive: redacts user:pass in URL, keeps host visible", () => {
    const input = "https://user:secret@example.com/path";
    const result = scrubSecrets(input);
    expect(result).toContain("://[REDACTED]@example.com/path");
    expect(result).not.toContain("user:secret");
  });

  it("pattern 6 positive: redacts postgres URL creds", () => {
    const input = "postgres://admin:hunter2@db.internal:5432/mydb";
    const result = scrubSecrets(input);
    expect(result).toContain("://[REDACTED]@db.internal:5432/mydb");
    expect(result).not.toContain("hunter2");
  });

  it("pattern 6 negative: URL without credentials is not modified", () => {
    const input = "https://example.com/api/v1/data";
    const result = scrubSecrets(input);
    expect(result).toBe(input);
  });

  // Issue #12 — Pattern 7: Bearer / Authorization tokens
  it("pattern 7 positive: scrubs Bearer token (16+ chars)", () => {
    const input = "Bearer abcdef1234567890ABCDEF1234567890";
    const result = scrubSecrets(input);
    expect(result).toContain("Bearer [REDACTED]");
    expect(result).not.toContain("abcdef1234567890ABCDEF1234567890");
  });

  it("pattern 7 positive: case-insensitive bearer prefix", () => {
    const input = "bearer abcdef1234567890ABCDEF1234567890";
    const result = scrubSecrets(input);
    expect(result).toContain("Bearer [REDACTED]");
    expect(result).not.toContain("abcdef1234567890ABCDEF1234567890");
  });

  it("pattern 7 positive: scrubs Authorization header", () => {
    const input = "Authorization: Bearer abcdef1234567890ABCDEF1234567890";
    const result = scrubSecrets(input);
    expect(result).toContain("Authorization: [REDACTED]");
    expect(result).not.toContain("abcdef1234567890ABCDEF1234567890");
  });

  it("pattern 7 negative: short bearer value (<16 chars) is not scrubbed", () => {
    const input = "bearer short123";
    const result = scrubSecrets(input);
    expect(result).toBe(input);
  });

  // Issue #12 — Pattern 8: GitHub PATs
  it("pattern 8 positive: scrubs classic GitHub PAT (ghp_)", () => {
    const input = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB");
  });

  it("pattern 8 positive: scrubs GitHub oauth token (gho_)", () => {
    const input = "TOKEN=gho_abcdefghijklmnopqrstuvwxyz0123456789AB";
    // Pattern 1 would catch token= first, but in isolation:
    const input2 = "header: gho_abcdefghijklmnopqrstuvwxyz0123456789AB";
    const result = scrubSecrets(input2);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("gho_abcdefghijklmnopqrstuvwxyz0123456789AB");
  });

  it("pattern 8 positive: scrubs GitHub server token (ghs_)", () => {
    const input = "ghs_abcdefghijklmnopqrstuvwxyz0123456789AB";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
  });

  it("pattern 8 negative: short gh_ token (<36 chars after prefix) is not matched", () => {
    const input = "ghp_shorttoken12345";
    const result = scrubSecrets(input);
    // Less than 36 chars after prefix — should NOT be scrubbed by p8
    expect(result).toBe(input);
  });

  // Issue #12 — Pattern 9: JWT shape
  it("pattern 9 positive: scrubs JWT token (eyJ prefix)", () => {
    const input = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.signaturepart12345";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("pattern 9 positive: scrubs realistic JWT in Authorization context", () => {
    const input = "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIiwiaWF0IjoxNjE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("pattern 9 negative: short eyJ-prefixed string with short segments is not scrubbed", () => {
    // Each segment must be 10+ chars — short segments should not match
    const input = "eyJshort.eyJx.sig";
    const result = scrubSecrets(input);
    // Segments are too short (<10 chars each) — should not match p9
    expect(result).toBe(input);
  });

  // Edge cases
  it("scrubSecrets('') returns ''", () => {
    expect(scrubSecrets("")).toBe("");
  });

  it("scrubSecrets(null as any) returns null", () => {
    expect(scrubSecrets(null as any)).toBe(null);
  });

  it("pattern 4 and 5 don't double-redact DATABASE_URL", () => {
    // DATABASE_URL matches pattern 4 first — pattern 5 shouldn't cause a second pass issue
    const input = "DATABASE_URL=postgres://u:p@host/db";
    const result = scrubSecrets(input);
    // Should produce exactly one [REDACTED], not double-nested
    expect(result).toBe("[REDACTED]");
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
