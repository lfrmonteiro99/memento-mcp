// tests/tools/tool-descriptions.test.ts
//
// TDQS guard rails (Glama Tool Definition Quality Score).
// We boot the actual MCP server, list its tools, and assert that every tool
// definition meets the bar across the six TDQS dimensions:
//   • Purpose Clarity         — description present and substantive
//   • Usage Guidelines        — description hints at *when* to use the tool
//   • Behavioral Transparency — annotations are populated (read-only/destructive/idempotent/openWorld)
//   • Parameter Semantics     — every input parameter has its own description
//   • Conciseness & Structure — descriptions stay under a sane upper bound
//   • Contextual Completeness — naming conventions are consistent across the surface
//
// These tests are deliberately schema-level (they introspect the MCP listTools
// response) so they protect every future tool addition automatically.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Tool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { description?: string; type?: string | string[] }>;
    required?: string[];
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

const distEntry = join(process.cwd(), "dist/index.js");
let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let dbPath = "";
let tools: Tool[] = [];

beforeAll(async () => {
  const buildResult = spawnSync(
    "./node_modules/.bin/tsup",
    [
      "src/index.ts",
      "src/cli/main.ts",
      "src/hooks/search-context.ts",
      "src/hooks/session-context.ts",
      "src/hooks/auto-capture-bin.ts",
      "src/hooks/session-summarize-bin.ts",
      "--format", "esm", "--dts", "--clean",
    ],
    { cwd: process.cwd(), encoding: "utf-8", timeout: 120_000 },
  );
  if (buildResult.status !== 0) {
    throw new Error(`Build prerequisite failed.\nstderr: ${buildResult.stderr}\nstdout: ${buildResult.stdout}`);
  }
  if (!existsSync(distEntry)) {
    throw new Error(`Built MCP server missing at ${distEntry}`);
  }

  const fakeHome = join(tmpdir(), `mcp-tdqs-home-${process.pid}-${randomUUID()}`);
  dbPath = fakeHome;

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry],
    env: { ...process.env, HOME: fakeHome, APPDATA: fakeHome },
  });
  client = new Client({ name: "tdqs-test-client", version: "0.0.0" });
  await client.connect(transport);

  const list = await client.listTools();
  tools = list.tools as unknown as Tool[];
}, 180_000);

afterAll(async () => {
  try { await client?.close(); } catch { /* ignore */ }
  try { await transport?.close(); } catch { /* ignore */ }
  if (dbPath) rmSync(dbPath, { recursive: true, force: true });
});

describe("TDQS — Purpose Clarity", () => {
  it("every tool has a non-empty description of at least 60 chars", () => {
    for (const t of tools) {
      expect(t.description, `${t.name}: missing description`).toBeTruthy();
      expect(t.description!.length, `${t.name}: description too short`).toBeGreaterThanOrEqual(60);
    }
  });

  it("every tool has a human-friendly title annotation", () => {
    for (const t of tools) {
      const title = t.annotations?.title ?? t.title;
      expect(title, `${t.name}: missing title`).toBeTruthy();
      expect(title!.length, `${t.name}: title too short`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("TDQS — Usage Guidelines", () => {
  // A description that mentions when/why/use/prefer/instead is signalling guidance,
  // not just a restatement of the name.
  const GUIDANCE_HINTS = ["use", "when", "prefer", "instead", "workflow", "before", "after"];

  it("every tool description hints at when/how to use it", () => {
    for (const t of tools) {
      const lower = (t.description ?? "").toLowerCase();
      const hit = GUIDANCE_HINTS.some(h => lower.includes(h));
      expect(hit, `${t.name}: description lacks usage guidance keywords (${GUIDANCE_HINTS.join("/")})`).toBe(true);
    }
  });
});

describe("TDQS — Behavioral Transparency", () => {
  it("every tool declares annotations", () => {
    for (const t of tools) {
      expect(t.annotations, `${t.name}: missing annotations object`).toBeDefined();
    }
  });

  it("every tool declares all four behavioral hints (readOnly/destructive/idempotent/openWorld)", () => {
    for (const t of tools) {
      const a = t.annotations!;
      expect(typeof a.readOnlyHint, `${t.name}: missing readOnlyHint`).toBe("boolean");
      expect(typeof a.destructiveHint, `${t.name}: missing destructiveHint`).toBe("boolean");
      expect(typeof a.idempotentHint, `${t.name}: missing idempotentHint`).toBe("boolean");
      expect(typeof a.openWorldHint, `${t.name}: missing openWorldHint`).toBe("boolean");
    }
  });

  it("read-only tools are not also marked destructive", () => {
    for (const t of tools) {
      const a = t.annotations!;
      if (a.readOnlyHint === true) {
        expect(a.destructiveHint, `${t.name}: readOnly + destructive is contradictory`).toBe(false);
      }
    }
  });
});

describe("TDQS — Parameter Semantics", () => {
  it("every input parameter has its own description", () => {
    for (const t of tools) {
      const props = t.inputSchema?.properties ?? {};
      for (const [param, schema] of Object.entries(props)) {
        expect(schema.description, `${t.name}.${param}: missing parameter description`).toBeTruthy();
        expect(schema.description!.length, `${t.name}.${param}: description too short`).toBeGreaterThanOrEqual(10);
      }
    }
  });
});

describe("TDQS — Conciseness & Structure", () => {
  it("descriptions stay under 4 KB (room for guidance, not novellas)", () => {
    for (const t of tools) {
      expect(t.description!.length, `${t.name}: description too long`).toBeLessThan(4_000);
    }
  });
});

describe("TDQS — Server Coherence", () => {
  it("tool names are unique", () => {
    const names = tools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("tool names use snake_case (no camelCase, no spaces)", () => {
    for (const t of tools) {
      expect(t.name, `${t.name}: must match ^[a-z][a-z0-9_]*$`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("memory_* tools all share the memory_ prefix (naming consistency)", () => {
    const memoryTools = tools.filter(t => t.name.startsWith("memory_"));
    expect(memoryTools.length).toBeGreaterThan(10);
  });
});
