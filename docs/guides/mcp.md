# MCP (Model Context Protocol)

[简体中文](mcp.zh-CN.md)

BabeL-O can use external tools via the Model Context Protocol (MCP). MCP servers are spawned as child processes over stdio and speak JSON-RPC 2.0. Every remote tool they advertise becomes a first-class BabeL-O tool, gated by the same permission and risk system as builtin tools.

## What is supported

BabeL-O implements **`tools/list` and `tools/call` only**. The following MCP capabilities are **not** implemented:

- **Resources** (`resources/list`, `resources/read`) -- not supported.
- **Prompts** (`prompts/list`, `prompts/get`) -- not supported.
- **Roots** (`roots/list`) -- not supported.

If a real integration requires resources or prompts, they must go through the same runtime-owned scope handling and permission flow as native tools, not become a bypass of the builtin `Read` tool or the project-root gate.

## How MCP tools appear

Every remote tool is registered as a `ToolDefinition` with the name format:

```
mcp:<serverName>:<originalToolName>
```

For example, a tool called `read-file` from a server named `filesystem` becomes `mcp:filesystem:read-file`.

Each MCP tool carries:

- `source.type: 'mcp'` -- so the runtime and permission system distinguish it from builtin tools.
- A `risk` level (`read`, `write`, `execute`, or `task`) configured per-server.
- The same `requiresApproval` / `suggestedAllowRule` fields as builtin tools.
- An `mcpServerAllowed` gate -- tools absent from the server's `allowedTools` list are registered but will reject execution with an error message.

## Permission and risk model

MCP tools obey the **same risk classification, approval flow, and path-safety rules** as builtin tools:

| Risk | Behavior |
| --- | --- |
| `read` | Allowed by default. |
| `write` | Requires user approval (or a matching allow rule). |
| `execute` | Requires user approval (or a matching allow rule). |
| `task` | Requires approval, enrolled in the task budget. |

The per-server `toolRisk` map lets you override the default (`read`) per tool name. This is configured in the server entry (see below).

## Configuring MCP servers

### 1. Enable the MCP feature gate

MCP is disabled by default. Set the environment variable before starting BabeL-O:

```bash
export BABEL_O_ENABLE_MCP=1
bbl go
```

Without this variable, MCP servers are not spawned and no MCP tools are registered.

### 2. Write the server configuration

MCP server definitions are read from JSON files in one of two locations (project overrides user):

| Location | Scope |
| --- | --- |
| `~/.babel-o/mcp.json` | User-wide (applies to all projects) |
| `<project-root>/.babel-o/mcp.json` | Project-local (overrides user config) |

Each file has a `servers` map. Every server entry requires a `command`, and optionally `args`, `env`, `cwd`, `allowedTools`, and `toolRisk`.

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "allowedTools": ["read-file", "list-directory", "search-files"],
      "toolRisk": {
        "read-file": "read",
        "list-directory": "read",
        "search-files": "read"
      }
    },
    "github": {
      "command": "node",
      "args": ["path/to/github-mcp-server/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      },
      "allowedTools": ["*"],
      "toolRisk": {
        "list-issues": "read",
        "create-issue": "write",
        "merge-pr": "execute"
      }
    }
  }
}
```

#### Server entry fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `command` | string | yes | The executable to spawn. |
| `args` | string[] | no | Arguments passed to the command. |
| `env` | object | no | Extra environment variables merged into `process.env`. |
| `cwd` | string | no | Working directory for the child process. |
| `allowedTools` | string[] | no | Allowlist of tool names. `["*"]` allows all. Tools not listed are registered but reject execution. |
| `toolRisk` | object | no | Per-tool risk override. Keys are tool names; values are `"read"`, `"write"`, `"execute"`, or `"task"`. |

### 3. Start a session

```bash
export BABEL_O_ENABLE_MCP=1
bbl go
```

On startup, BabeL-O spawns every configured MCP server, calls `tools/list`, and registers each returned tool. If a server is slow or unresponsive, it blocks registration for that server only (lazy/parallel spawn is tracked as a planned improvement).

## Debugging

Set `BABEL_O_MCP_DEBUG=1` to forward MCP server stderr to the terminal:

```bash
export BABEL_O_MCP_DEBUG=1
export BABEL_O_ENABLE_MCP=1
bbl go
```

## Limitations

- **Eager spawn on startup**: Every configured server is spawned during tool registry construction. A slow server delays startup. This is tracked in the project's MCP hygiene plan (Phase 4 -- lazy/parallel registration).
- **No resource/prompt/root support**: See "What is supported" above.
- **No `bbl config` integration**: MCP is gated solely by `BABEL_O_ENABLE_MCP` and configured through JSON files. There is no `bbl config` subcommand for MCP today.
- **EverCore/MemoryOS MCP tools** (controlled by `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS` or `bbl memory enable-mcp`) are a separate feature for MemoryOS integrations and are not covered in this guide.
