// src/lib/import-claude-md.ts — deterministic parser for CLAUDE.md → typed ImportSection[]
// No LLM calls; no new npm dependencies.

export interface ImportSection {
  title: string;
  body: string;
  inferredType: string;   // "fact" | "decision" | "pattern" | "architecture" | "pitfall" | "preference"
  inferredTags: string[];
}

export interface ImportResult {
  sections: ImportSection[];
  skipped: Array<{ reason: string; preview: string }>;
}

const TYPE_HINTS: Array<[RegExp, string]> = [
  [/\b(decision|chose|choose|chosen|decided|adr)\b/i, "decision"],
  [/\b(architecture|adr|design|system)\b/i, "architecture"],
  [/\b(pitfall|gotcha|bug|trap|never|don't|avoid)\b/i, "pitfall"],
  [/\b(pattern|convention|always|prefer|use the)\b/i, "pattern"],
  [/\b(preference|like to|prefer|style)\b/i, "preference"],
];

const TAG_PATTERNS: RegExp[] = [
  /\b(area:[a-z][a-z0-9-]*)\b/gi,
  /\b(env:[a-z][a-z0-9-]*)\b/gi,
  /\*\*([A-Z][A-Za-z0-9_-]{4,})\*\*/g,   // bolded proper nouns (5+ chars) become tags
];

/**
 * Split the file content into raw blocks.
 * If the file has any `## ` headings, split on those headings.
 * Otherwise split on blank lines (paragraph blocks).
 */
export function splitIntoBlocks(content: string): string[] {
  if (/^##\s/m.test(content)) {
    const parts = content.split(/^(?=##\s)/m);
    return parts.map(p => p.trim()).filter(p => p.length > 0);
  }
  return content.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * Parse a CLAUDE.md string into ImportResult.
 *
 * Skip rules:
 *   - empty section (no body AND no heading)
 *   - body < 20 chars without a heading
 *   - body that is solely a fenced code block (starts with ``` and ends with ```)
 *
 * Type inference: checked in TYPE_HINTS order; first match wins; falls back to defaultType.
 * Tags: extracted from area:/env: patterns and **BoldedProperNouns** (5+ chars) in body.
 *   Bold tokens inside heading text are intentionally excluded.
 */
export function parseClaudeMd(content: string, defaultType: string): ImportResult {
  const sections: ImportSection[] = [];
  const skipped: Array<{ reason: string; preview: string }> = [];

  const blocks = splitIntoBlocks(content);

  for (const block of blocks) {
    // Extract heading line (first heading if any)
    const headingMatch = block.match(/^#{1,6}\s+(.+)$/m);
    const titleLine = headingMatch?.[1]?.trim();

    // Body = block minus the heading line
    const body = block.replace(/^#{1,6}\s+.+\n?/m, "").trim();

    // Skip: empty (no body at all, with or without a heading)
    if (!body) {
      skipped.push({ reason: "empty", preview: block.slice(0, 60) });
      continue;
    }

    // Skip: body too short without a heading
    if (body.length < 20 && !titleLine) {
      skipped.push({ reason: "too short", preview: body });
      continue;
    }

    // Skip: code-fence-only body
    if (/^```/.test(body) && body.endsWith("```")) {
      skipped.push({ reason: "code fence only", preview: body.slice(0, 60) });
      continue;
    }

    // Title fallback: first sentence or first line up to 80 chars
    let title: string;
    if (titleLine) {
      title = titleLine;
    } else {
      const sentenceSplit = body.split(/[.!?]\s/);
      title = sentenceSplit[0].slice(0, 80);
    }

    // Infer type from title + body
    let inferredType = defaultType;
    for (const [re, t] of TYPE_HINTS) {
      // Reset lastIndex (global regex safety)
      re.lastIndex = 0;
      if (re.test(title) || (re.lastIndex = 0, re.test(body))) {
        inferredType = t;
        break;
      }
    }

    // Extract tags only from body (not from heading)
    const tags = new Set<string>();
    for (const pattern of TAG_PATTERNS) {
      // Clone the regex to avoid lastIndex state mutation across calls
      const re = new RegExp(pattern.source, pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        tags.add(m[1].toLowerCase());
      }
    }

    sections.push({ title, body, inferredType, inferredTags: [...tags] });
  }

  return { sections, skipped };
}
