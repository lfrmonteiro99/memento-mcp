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

### About hooks across clients

The four `memento-hook-*` binaries (`memento-hook-session`, `memento-hook-search`, `memento-hook-capture`, `memento-hook-summarize`) were written for Claude Code's stdin payload shape. Practical compatibility with other clients today:

- **Claude Code** — first-class, fully tested.
- **Codex 0.114.0+** — payload is very close (shared fields like `session_id`, `cwd`, `hook_event_name`); the binaries should work directly.
- **Cursor 1.7+**, **Gemini CLI 0.26.0+**, **Cline 3.36.0+** — payload shapes differ; the binaries will receive JSON they don't fully understand. Inject pre-rendered context anyway, or write a small wrapper script that adapts the input. Treat the configs below as a starting point.

For clients without hooks (Aider, older Codex/Cursor versions, niche clients), use the rule-file fallback shown at the end of this file.

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

### Codex (0.114.0+)

Codex uses `~/.codex/config.toml` for the MCP server entry. Hooks are an opt-in feature flag.

MCP server:

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

Hooks (Codex 0.114.0, March 2026, or newer). First enable the experimental engine in `~/.codex/config.toml`:

```toml
[features]
codex_hooks = true
```

Then add `~/.codex/hooks.json` (or `<repo>/.codex/hooks.json` for project-scoped):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "memento-hook-session" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "memento-hook-search" }] }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "memento-hook-capture", "timeout": 30 }]
      }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "memento-hook-summarize", "timeout": 30 }] }
    ]
  }
}
```

Codex calls `Stop` instead of `SessionEnd` and uses `Bash`-style matchers similar to Claude Code. Codex hook docs: <https://developers.openai.com/codex/hooks>.

For Codex versions older than 0.114.0, use the rule-file fallback at the end.

### Cursor (1.7+)

Cursor uses `~/.cursor/mcp.json` for the MCP server and `.cursor/hooks.json` (or `~/.cursor/hooks.json`) for hooks.

MCP server (`~/.cursor/mcp.json`):

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

Hooks (Cursor 1.7, October 2025, or newer; still flagged beta in 2026). Project-scoped at `.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      { "command": "memento-hook-search" }
    ],
    "afterFileEdit": [
      { "command": "memento-hook-capture" }
    ],
    "stop": [
      { "command": "memento-hook-summarize" }
    ]
  }
}
```

Notes:

- Cursor has no `SessionStart` event. The closest substitute is running `memento-hook-session` once on the first `beforeSubmitPrompt` (your wrapper script can short-circuit on subsequent calls), or invoke it manually with `memory_search(query="pinned")`.
- Cursor's payload differs from Claude Code's — `memento-hook-capture` may need a small wrapper to translate `afterFileEdit` input (file path + diff) into something the binary expects. See <https://cursor.com/docs/hooks>.

### Gemini CLI (0.26.0+)

Gemini CLI uses `~/.gemini/settings.json` for both the MCP server and hooks. Hooks are default-enabled since 0.26.0 (28 January 2026).

```json
{
  "mcpServers": {
    "memento-mcp": {
      "command": "memento-mcp",
      "args": []
    }
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "memento-hook-session", "name": "MementoSessionStart", "timeout": 5000 }
        ]
      }
    ],
    "BeforeAgent": [
      {
        "hooks": [
          { "type": "command", "command": "memento-hook-search", "name": "MementoSearch", "timeout": 5000 }
        ]
      }
    ],
    "AfterTool": [
      {
        "matcher": "run_shell_command|read_file|edit",
        "hooks": [
          { "type": "command", "command": "memento-hook-capture", "name": "MementoCapture", "timeout": 5000 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "memento-hook-summarize", "name": "MementoSummarize", "timeout": 10000 }
        ]
      }
    ]
  }
}
```

Notes:

- Gemini CLI requires hook scripts to print only valid JSON to stdout (logs go to stderr). The current `memento-hook-*` binaries print injection text directly, so they will likely need a wrapper that re-emits the output inside `{"systemMessage": "..."}` until a Gemini-native mode lands.
- Manage hooks at runtime with `/hooks` inside the CLI. Reference: <https://geminicli.com/docs/hooks/reference/>.

### Cline (3.36.0+)

Cline uses VS Code settings for the MCP server, and discovers hooks by **filename** in `.clinerules/hooks/` (project) or `~/Documents/Cline/Hooks/` (global).

Register the MCP server through the Cline UI (`Settings → MCP Servers → Add`) with command `memento-mcp` and no args, or edit your VS Code `settings.json` accordingly.

For hooks, create one executable file per event you want to wire up. On macOS/Linux they are extensionless executables; on Windows they must be `.ps1` scripts.

```bash
mkdir -p .clinerules/hooks
cat > .clinerules/hooks/UserPromptSubmit <<'EOF'
#!/bin/bash
# Cline pipes JSON on stdin and expects JSON on stdout.
INPUT=$(cat)
INJECTED=$(echo "$INPUT" | memento-hook-search 2>/dev/null || true)
jq -n --arg ctx "$INJECTED" '{cancel:false, contextModification:$ctx, errorMessage:""}'
EOF
chmod +x .clinerules/hooks/UserPromptSubmit
```

Wire similar files for `TaskStart` (→ `memento-hook-session`), `PostToolUse` (→ `memento-hook-capture`), and `TaskComplete` (→ `memento-hook-summarize`). The wrapper above is required because Cline's input/output schema (`taskId`, `workspaceRoots`, `cancel`, `contextModification`) does not match Claude Code's. Reference: <https://docs.cline.bot/customization/hooks>.

Supported Cline events: `TaskStart`, `TaskResume`, `TaskCancel`, `TaskComplete`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact` (since 3.36.0; expanded in 3.38.3).

### Generic stdio-MCP client (and clients without hooks)

If your client supports stdio MCP servers, use this shape:

```json
{
  "command": "memento-mcp",
  "args": [],
  "type": "stdio"
}
```

If PATH resolution is unreliable in your client, prefer the absolute `node` + `dist/cli/main.js` form shown above for Codex.

### Rule-file fallback (Aider, older versions, anything without hooks)

When the client has no hook system (e.g. Aider, pre-1.7 Cursor, pre-0.114.0 Codex), the only lever is a rule file telling the agent to call the memory tools itself. This is best-effort — the agent must choose to follow the rules — but it is the most portable option.

Drop one of these in your project:

- Codex / generic agent harness → project root `AGENTS.md`
- Cursor pre-1.7 → `.cursorrules` or `.cursor/rules/memento.mdc` (with `alwaysApply: true`)
- Aider → system prompt via `--message-file` or `aider.conf.yml`
- Continue, Roo, etc. → their respective rule/system-prompt mechanism

Template:

```markdown
# Project memory (memento-mcp)

This project uses memento-mcp. Follow these rules every session.

## At the start of a session
Call `memory_search` with the user's first non-trivial prompt and read the
top 5 results. Also call `memory_search(query="pinned", detail="full")` to
load pinned context. Treat returned `pitfall` and `decision` memories as
binding constraints.

## During the session
- Before proposing a non-trivial change, call `memory_search` with keywords
  from the task. Mention any matching `decision` or `pitfall` in your reply.
- After learning something durable (a fix, a convention, a gotcha), call
  `memory_store` with the right `memory_type` (`fact` / `decision` /
  `pitfall` / `pattern` / `architecture` / `preference`) and a `scope` of
  `project` (or `team` if it should sync via git).

## At the end of a session
When the user signals the session is wrapping up, call `memory_store` with
`memory_type="session_summary"` and a concise digest of decisions made,
pitfalls discovered, and follow-ups.
```

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
