/**
 * K2: Flatten tool_response (object) to string.
 * N2 narrowing: string → as-is, null/undefined → "", object → per-tool extractor, other → String()
 */
export function stringifyToolResponse(toolResponse: unknown): string {
  // N2: if string, use as-is
  if (typeof toolResponse === "string") {
    return toolResponse;
  }

  // N2: null or undefined → empty string
  if (toolResponse === null || toolResponse === undefined) {
    return "";
  }

  // N2: if object, apply per-tool extractor
  if (typeof toolResponse === "object") {
    const obj = toolResponse as Record<string, unknown>;

    // Bash: stdout, stderr, interrupted, isImage
    if ("stdout" in obj || "stderr" in obj) {
      const parts: string[] = [];
      if (obj.stdout) parts.push(String(obj.stdout));
      if (obj.stderr) parts.push(String(obj.stderr));
      return parts.join("\n");
    }

    // Read: content or output
    if ("content" in obj) {
      return String(obj.content);
    }
    if ("output" in obj) {
      return String(obj.output);
    }

    // Grep: output or matches
    if ("output" in obj) {
      return String(obj.output);
    }
    if ("matches" in obj) {
      const matches = obj.matches;
      if (Array.isArray(matches)) {
        return matches.map(m => String(m)).join("\n");
      }
      return String(matches);
    }

    // Edit: oldString and newString
    if ("oldString" in obj && "newString" in obj) {
      return `${String(obj.oldString)}\n${String(obj.newString)}`;
    }

    // Fallback: JSON.stringify
    return JSON.stringify(obj);
  }

  // N2: other types → String()
  return String(toolResponse);
}

/**
 * G2: Redact secrets from text before storing.
 * Patterns:
 * - api_key=, password=, secret=, token= (case-insensitive, values to next whitespace/newline)
 * - AWS_*, AZURE_*, GCP_*, GITHUB_*, STRIPE_*, OPENAI_*, ANTHROPIC_* env-style assignments
 * - PEM private key blocks (-----BEGIN ... PRIVATE KEY-----...-----END ... PRIVATE KEY-----)
 */
export function scrubSecrets(text: string): string {
  if (!text) return text;

  let result = text;

  // Pattern 1: api_key=, password=, secret=, token= (case-insensitive)
  result = result.replace(/\b(?:api_key|password|secret|token)\s*=\s*[^\s\n]+/gi, "[REDACTED]");

  // Pattern 2: AWS_*, AZURE_*, GCP_*, GITHUB_*, STRIPE_*, OPENAI_*, ANTHROPIC_* env-style
  result = result.replace(/\b(?:AWS_|AZURE_|GCP_|GITHUB_|STRIPE_|OPENAI_|ANTHROPIC_)[A-Z_]*\s*=\s*[^\s\n]+/g, "[REDACTED]");

  // Pattern 3: PEM private key blocks
  result = result.replace(/-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi, "[REDACTED PRIVATE KEY]");
  result = result.replace(/-----BEGIN\s+EC\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+EC\s+PRIVATE\s+KEY-----/gi, "[REDACTED PRIVATE KEY]");
  result = result.replace(/-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+OPENSSH\s+PRIVATE\s+KEY-----/gi, "[REDACTED PRIVATE KEY]");
  result = result.replace(/-----BEGIN\s+PGP\s+PRIVATE\s+KEY\s+BLOCK-----[\s\S]*?-----END\s+PGP\s+PRIVATE\s+KEY\s+BLOCK-----/gi, "[REDACTED PRIVATE KEY]");

  return result;
}

/**
 * Extract fingerprints from text for utility signal detection.
 * Returns:
 * - File paths (with common extensions)
 * - PascalCase identifiers (>=4 chars)
 * - camelCase identifiers (>=5 chars, top 10 longest)
 */
export function extractFingerprints(text: string): string[] {
  if (!text) return [];
  const fps = new Set<string>();

  // File paths (with common extensions) - order matters: tsx before ts, jsx before js, yaml before yml
  const paths = text.match(/[\w./\\-]+\.(?:tsx|ts|jsx|js|py|php|rs|go|java|vue|css|scss|json|toml|yaml|yml|md)/g);
  if (paths) paths.forEach(p => fps.add(p));

  // Class/type names (PascalCase >=4 chars)
  const pascals = text.match(/\b[A-Z][a-zA-Z0-9]{3,}\b/g);
  if (pascals) pascals.forEach(p => fps.add(p));

  // Function/method names (camelCase or snake_case, >= 5 chars starting lower)
  const idents = text.match(/\b[a-z][a-zA-Z0-9_]{4,}\b/g);
  if (idents) {
    // De-dupe and take top 10 longest (avoid match noise on common words)
    const uniq = [...new Set(idents)].sort((a, b) => b.length - a.length).slice(0, 10);
    uniq.forEach(i => fps.add(i));
  }

  return [...fps];
}
