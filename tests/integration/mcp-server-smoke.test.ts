// tests/integration/mcp-server-smoke.test.ts
// Spawns the actual built MCP server (dist/index.js), performs the MCP
// handshake over stdio, lists registered tools, then calls memory_store +
// memory_search end-to-end through the SDK client.
//
// This is the most critical test in the suite: it verifies the package's
// primary entry point works as an MCP server.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("MCP server — protocol smoke test", () => {
  const distEntry = join(process.cwd(), "dist/index.js");
  let dbPath: string;
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  beforeAll(async () => {
    // The MCP server binary is built once by tests/setup/build-once.ts
    // (registered as vitest globalSetup), so we just check the artifact exists.
    if (!existsSync(distEntry)) {
      throw new Error(`Built MCP server missing at ${distEntry} (expected globalSetup to produce it).`);
    }

    // Sandbox HOME so the server resolves its DB/config under a tempdir
    // (config.ts derives data + config paths from homedir()).
    const fakeHome = join(tmpdir(), `mcp-smoke-home-${process.pid}-${randomUUID()}`);
    dbPath = fakeHome; // we'll clean the whole sandbox

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [distEntry],
      env: {
        ...process.env,
        HOME: fakeHome,
        APPDATA: fakeHome,
      },
    });

    client = new Client({ name: "memento-test-client", version: "0.0.0" });
    await client.connect(transport);
  }, 180_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
    rmSync(dbPath, { recursive: true, force: true });
  });

  it("advertises a non-empty tool list including the core memory tools", async () => {
    const list = await client!.listTools();
    const toolNames = list.tools.map(t => t.name);
    expect(toolNames.length).toBeGreaterThan(10);

    // Core surface: every release must keep these.
    for (const required of [
      "memory_store",
      "memory_search",
      "memory_get",
      "memory_list",
      "memory_delete",
      "memory_update",
      "memory_link",
      "memory_unlink",
      "memory_graph",
      "memory_path",
      "memory_pin",
      "memory_timeline",
      "memory_dedup_check",
      "memory_compress",
      "memory_export",
      "memory_import",
      "decisions_log",
      "pitfalls_log",
      "memory_analytics",
    ]) {
      expect(toolNames).toContain(required);
    }
  });

  it("memory_store returns an ID over the MCP wire", async () => {
    const result = await client!.callTool({
      name: "memory_store",
      arguments: {
        title: "MCP smoke memory",
        content: "smoke body via MCP transport",
        memory_type: "fact",
        scope: "global",
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Memory stored with ID:");
  });

  it("memory_search finds the just-stored memory over the MCP wire", async () => {
    const result = await client!.callTool({
      name: "memory_search",
      arguments: { query: "smoke MCP transport", detail: "index" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("MCP smoke memory");
  });

  it("memory_list returns the stored memory", async () => {
    const result = await client!.callTool({
      name: "memory_list",
      arguments: { detail: "index" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("MCP smoke memory");
  });

  it("memory_get returns the just-stored memory by id over the wire", async () => {
    const stored = await client!.callTool({
      name: "memory_store",
      arguments: {
        title: "smoke-get",
        content: "body for memory_get smoke test",
        memory_type: "fact",
        scope: "global",
      },
    });
    const storeText = (stored.content as Array<{ type: string; text: string }>)[0].text;
    const id = storeText.split("ID: ")[1]?.trim().split(/\s/)[0];
    expect(id).toBeDefined();

    const got = await client!.callTool({
      name: "memory_get",
      arguments: { memory_id: id },
    });
    const text = (got.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("smoke-get");
    expect(text).toContain("body for memory_get smoke test");
  });
});
