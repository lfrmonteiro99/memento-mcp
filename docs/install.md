# Installation & client setup

## Prerequisites

- **Node.js** `>=18`
- **npm**
- a **GitHub Personal Access Token** with `read:packages` to install from GitHub Packages
- a supported MCP client such as **Codex**, **Claude Code**, **Cursor**, or another stdio-compatible MCP client

Recommended:

- **Node 20** for development and test runs
- an **Obsidian vault** if you want vault integration (see [Vault integration](vault.md))

If `better-sqlite3` needs compilation on your machine, install the usual native build prerequisites for Node addons.

## Install

The package is published on **GitHub Packages**, not the public npm registry.

### 1. Configure npm for GitHub Packages

```bash
npm config set @lfrmonteiro99:registry https://npm.pkg.github.com
echo "//npm.pkg.github.com/:_authToken=YOUR_PAT_HERE" >> ~/.npmrc
```

Replace `YOUR_PAT_HERE` with a GitHub PAT that has `read:packages`.

### 2. Install globally

```bash
npm install -g @lfrmonteiro99/memento-memory-mcp
```

Global install matters because:

- the executable `memento-mcp` is then available on `PATH`
- Claude Code hooks can call `memento-hook-search`, `memento-hook-session`, `memento-hook-capture`, and `memento-hook-summarize`

### 3. Optional installer

```bash
memento-mcp install
```

The installer detects which clients you have configured and writes the right config block to each. The manual setup below is the stable path if the client-specific `add` flows are not behaving well.

## Manual client setup

Restart the client after editing its config.

### Codex

Codex uses `~/.codex/config.toml`.

Add:

```toml
[mcp_servers.memento-mcp]
command = "memento-mcp"
args = []
```

If `memento-mcp` is not on `PATH`, use an absolute command instead:

```toml
[mcp_servers.memento-mcp]
command = "/home/you/.nvm/versions/node/v20.20.2/bin/node"
args = ["/home/you/.nvm/versions/node/v20.20.2/lib/node_modules/@lfrmonteiro99/memento-memory-mcp/dist/cli/main.js"]
```

### Claude Code

Claude Code uses `~/.claude/settings.json`.

Add the MCP server:

```json
{
  "mcpServers": {
    "memento-mcp": {
      "command": "memento-mcp",
      "args": [],
      "type": "stdio"
    }
  }
}
```

Add hooks for context injection and auto-capture:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "memento-hook-session", "timeout": 5 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "memento-hook-search", "timeout": 5 }] }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Read|Grep|Edit",
        "hooks": [{ "type": "command", "command": "memento-hook-capture", "timeout": 5 }]
      }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "memento-hook-summarize", "timeout": 10 }] }
    ]
  }
}
```

What each hook does:

- `SessionStart` — injects pinned + recent memories and active pitfalls
- `UserPromptSubmit` — injects query-relevant memories (skips trivial prompts)
- `PostToolUse` — captures meaningful tool output as memories with classifier dedup, cooldown, and secret scrubbing
- `SessionEnd` — distills the session into a single `session_summary` memory (deterministic by default; opt-in LLM mode — see [Session summaries](session-summaries.md))

### Cursor

Cursor uses `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "memento-mcp": {
      "command": "memento-mcp",
      "args": []
    }
  }
}
```

### Generic MCP client

If your client supports stdio MCP servers, use this shape:

```json
{
  "command": "memento-mcp",
  "args": [],
  "type": "stdio"
}
```

If PATH resolution is unreliable in your client, prefer the absolute `node` + `dist/cli/main.js` form shown above for Codex.

## Verify installation

After setup:

1. Restart your client
2. Confirm the MCP server appears in the client
3. Call:

```text
memory_store(title="test", content="hello", memory_type="fact", scope="global")
```

4. Then call:

```text
memory_search(query="hello", detail="full")
```

If both work, the MCP server is wired correctly.

## Uninstall

```bash
memento-mcp uninstall
```

This removes the registered MCP entry and Claude Code hooks created by the installer. **Your data and config on disk are kept** — to wipe everything, delete `~/.local/share/memento-mcp/` and `~/.config/memento-mcp/`.
