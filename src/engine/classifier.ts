import { jaccardSimilarity } from "./similarity.js";
import { scrubSecrets } from "./text-utils.js"; // G2: shared with auto-capture bin + utility-signal detector

export interface ClassifierConfig {
  min_output_length: number;
  max_output_length: number;
  cooldown_seconds: number;
  dedup_similarity_threshold: number;
}

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  min_output_length: 200,
  max_output_length: 50000,
  cooldown_seconds: 30,
  dedup_similarity_threshold: 0.7,
};

export interface ToolResultInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output: string;
}

export interface CaptureDecision {
  action: "store" | "skip" | "merge";
  reason: string;
  memory?: {
    title: string;
    body: string;
    memory_type: string;
    tags: string[];
    importance_score: number;
    source: "auto-capture";
  };
  merge_target_id?: string;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}

function truncateToSentences(text: string, maxLength: number): string {
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  let result = "";
  for (const s of sentences) {
    if (result.length + s.length > maxLength) break;
    result += (result ? " " : "") + s;
  }
  return result || truncate(text, maxLength);
}

function containsErrors(output: string): boolean {
  return /(?:error|FAIL|FAILED|Exception|Traceback|panic|fatal|ERR!)/i.test(output);
}

function extractErrorSummary(output: string): string {
  const lines = output.split("\n");
  const errorLine = lines.find(l => /(?:error|FAIL|Exception|Traceback|panic|fatal)/i.test(l));
  return truncate(errorLine || "unknown error", 80);
}

function extractErrorContext(output: string, maxLength: number): string {
  const lines = output.split("\n");
  const errorIdx = lines.findIndex(l => /(?:error|FAIL|Exception|Traceback|panic|fatal)/i.test(l));
  if (errorIdx === -1) return truncate(output, maxLength);
  const context = lines.slice(Math.max(0, errorIdx - 2), errorIdx + 6).join("\n");
  return truncate(context, maxLength);
}

function countDiffLines(diffOutput: string): number {
  return (diffOutput.match(/^[+-][^+-]/gm) || []).length;
}

function extractDiffFiles(diffOutput: string): string[] {
  const matches = diffOutput.match(/^diff --git a\/(.+?) b\//gm) || [];
  return matches.map(m => m.replace(/^diff --git a\//, "").replace(/ b\/.*/, ""));
}

function summarizeDiff(diffOutput: string, maxLength: number): string {
  const files = extractDiffFiles(diffOutput);
  const additions = (diffOutput.match(/^\+[^+]/gm) || []).length;
  const deletions = (diffOutput.match(/^-[^-]/gm) || []).length;
  const header = `${files.length} files changed (+${additions}/-${deletions})`;
  return truncate(`${header}\nFiles: ${files.join(", ")}`, maxLength);
}

function extractFilename(path: string): string {
  return path.split("/").pop() || path;
}

function summarizeGrepResults(output: string, maxLength: number): string {
  const lines = output.split("\n").filter(l => l.trim());
  const files = new Set(lines.map(l => l.split(":")[0]).filter(Boolean));
  const header = `${lines.length} matches in ${files.size} files`;
  const sample = lines.slice(0, 5).join("\n");
  return truncate(`${header}\n${sample}`, maxLength);
}

function extractConfigSummary(content: string, maxLength: number): string {
  try {
    const parsed = JSON.parse(content);
    const keys = Object.keys(parsed);
    return truncate(`Keys: ${keys.join(", ")}`, maxLength);
  } catch {
    return truncateToSentences(content, maxLength);
  }
}

/**
 * Renamed from levenshteinRatio per M1 — uses word-overlap (Jaccard) to determine
 * whether an edit is meaningful. Returns similarity in [0, 1].
 */
export function wordOverlapRatio(a: string, b: string): number {
  return jaccardSimilarity(a, b);
}

export function extractBranchName(gitOutput: string): string {
  const match = gitOutput.match(/On branch ([^\s\n]+)/);
  return match ? match[1] : "unknown";
}

/**
 * Issue #12: Scrub secrets from a CaptureDecision's memory title and body.
 * Titles are derived from tool names + extracts and may contain secrets
 * (e.g. a grep pattern that contained a credential, or an infra command).
 */
function scrubDecision(decision: CaptureDecision): CaptureDecision {
  if (!decision.memory) return decision;
  return {
    ...decision,
    memory: {
      ...decision.memory,
      title: scrubSecrets(decision.memory.title),
      body: scrubSecrets(decision.memory.body),
    },
  };
}

export function classify(input: ToolResultInput, config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG): CaptureDecision {
  // G2: always scrub secrets before length/pattern checks. Double-scrubbing (the bin
  // also calls scrubSecrets before invoking classify) is idempotent — the regexes
  // no longer match once "[REDACTED]" is in place.
  const { tool_name, tool_input } = input;
  const tool_output = scrubSecrets(input.tool_output);

  // Edit rules — evaluated before global length filter since Edit's signal is
  // in tool_input (old_string/new_string), not in the short "Edit applied" tool_output.
  if (tool_name === "Edit") {
    const filePath = String(tool_input.file_path || "");
    const oldStr = String(tool_input.old_string || "");
    const newStr = String(tool_input.new_string || "");

    const meaningfulChange = Math.abs(newStr.length - oldStr.length) > 20 ||
      jaccardSimilarity(oldStr, newStr) < 0.8;

    if (!meaningfulChange) {
      return { action: "skip", reason: "trivial edit" };
    }

    return scrubDecision({
      action: "store", reason: "significant code edit",
      memory: {
        title: `Edit: ${extractFilename(filePath)}`,
        body: `Changed in ${filePath}:\n- Removed: ${truncate(oldStr, 150)}\n+ Added: ${truncate(newStr, 150)}`,
        memory_type: "fact",
        tags: ["edit", "code-change", "auto-captured"],
        importance_score: 0.4, source: "auto-capture",
      },
    });
  }

  // Global length filters (applied after Edit which uses input content, not output length)
  if (tool_output.length < config.min_output_length) {
    return { action: "skip", reason: `output too short (${tool_output.length} < ${config.min_output_length})` };
  }
  if (tool_output.length > config.max_output_length) {
    return { action: "skip", reason: `output too long (${tool_output.length} > ${config.max_output_length})` };
  }

  // Bash rules
  if (tool_name === "Bash") {
    const cmd = String(tool_input.command || "");

    if (/git\s+log/.test(cmd) && tool_output.length > 100) {
      return scrubDecision({
        action: "store", reason: "git history context",
        memory: {
          title: `Git log snapshot: current branch`,
          body: truncateToSentences(tool_output, 500),
          memory_type: "fact",
          tags: ["git", "history", "auto-captured"],
          importance_score: 0.3, source: "auto-capture",
        },
      });
    }

    if (/git\s+diff/.test(cmd) && countDiffLines(tool_output) > 10) {
      return scrubDecision({
        action: "store", reason: "significant code changes",
        memory: {
          title: `Code changes: ${extractDiffFiles(tool_output).slice(0, 3).join(", ") || "unknown"}`,
          body: summarizeDiff(tool_output, 600),
          memory_type: "fact",
          tags: ["git", "changes", "auto-captured"],
          importance_score: 0.4, source: "auto-capture",
        },
      });
    }

    if (/(?:npm|yarn|pnpm)\s+(?:test|build|lint)/.test(cmd) ||
        /(?:pytest|phpunit|vitest|jest|cargo\s+test)/.test(cmd)) {
      if (containsErrors(tool_output)) {
        return scrubDecision({
          action: "store", reason: "build/test failure",
          memory: {
            title: `Build/test failure: ${extractErrorSummary(tool_output)}`,
            body: extractErrorContext(tool_output, 500),
            memory_type: "pitfall",
            tags: ["error", "build", "auto-captured"],
            importance_score: 0.7, source: "auto-capture",
          },
        });
      }
    }

    if (/docker|kubectl|terraform/.test(cmd) && tool_output.length > 200) {
      return scrubDecision({
        action: "store", reason: "infrastructure context",
        memory: {
          title: `Infra: ${cmd.substring(0, 80)}`,
          body: truncateToSentences(tool_output, 400),
          memory_type: "fact",
          tags: ["infrastructure", "auto-captured"],
          importance_score: 0.4, source: "auto-capture",
        },
      });
    }

    return { action: "skip", reason: "no matching bash pattern" };
  }

  // Read rules
  if (tool_name === "Read") {
    const path = String(tool_input.file_path || "");
    if (/(?:package\.json|tsconfig|\.env\.example|docker-compose|Makefile|Cargo\.toml|pyproject\.toml|composer\.json)/.test(path)) {
      return scrubDecision({
        action: "store", reason: "project config file",
        memory: {
          title: `Project config: ${extractFilename(path)}`,
          body: extractConfigSummary(tool_output, 400),
          memory_type: "architecture",
          tags: ["config", "project-structure", "auto-captured"],
          importance_score: 0.5, source: "auto-capture",
        },
      });
    }
    return { action: "skip", reason: "source code file - too volatile" };
  }

  // Grep rules
  if (tool_name === "Grep") {
    const pattern = String(tool_input.pattern || "");
    const matchCount = (tool_output.match(/\n/g) || []).length;

    if (matchCount < 3 || matchCount > 50) {
      return { action: "skip", reason: `grep result count ${matchCount} outside useful range` };
    }

    return scrubDecision({
      action: "store", reason: "codebase pattern search",
      memory: {
        title: `Pattern: "${pattern}" (${matchCount} matches)`,
        body: summarizeGrepResults(tool_output, 400),
        memory_type: "fact",
        tags: ["codebase", "pattern", "auto-captured"],
        importance_score: 0.3, source: "auto-capture",
      },
    });
  }

  return { action: "skip", reason: "unsupported tool" };
}
