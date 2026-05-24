# BabeL-O

> A Nexus-first, agentic AI coding assistant 

BabeL-O is an **agentic coding assistant** that runs as a local service (Nexus) with an interactive CLI. It combines LLM-powered code generation, tool execution, multi-agent coordination, MCP extensibility, and a permission-gated safety model into a single cohesive system.

---

## Table of Contents

- [Architecture](#architecture)
- [Features](#features)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [CLI Commands](#cli-commands)
- [Nexus API](#nexus-api)
- [Configuration](#configuration)
- [Development](#development)
- [Related Documentation](#related-documentation)

---

## Architecture

```
┌──────────────────────────────────────────────┐
│                    CLI                        │
│  ┌─────────┐  ┌───────────┐  ┌───────────┐  │
│  │ program │  │ renderer  │  │ Nexus     │  │
│  │(cmdr)   │  │(diff/TUI) │  │ Client    │  │
│  └────┬────┘  └───────────┘  └─────┬─────┘  │
│       │         HTTP / WS          │         │
├───────┼─────────────────────────────┼─────────┤
│       ▼                             ▼         │
│  ┌──────────────────────────────────────┐    │
│  │           Nexus Server                │    │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  │    │
│  │  │  REST  │  │   WS   │  │ Agent  │  │    │
│  │  │ routes │  │ stream │  │ Loop   │  │    │
│  │  └───┬────┘  └───┬────┘  └───┬────┘  │    │
│  │      │           │           │        │    │
│  │  ┌───┴───────────┴───────────┴────┐   │    │
│  │  │          Runtime                │   │    │
│  │  │  ┌──────────┐ ┌─────────────┐  │   │    │
│  │  │  │  Local   │ │ LLM Coding  │  │   │    │
│  │  │  │(deterministic)│  Runtime │  │   │    │
│  │  │  └──────────┘ └─────────────┘  │   │    │
│  │  └───────────────┬────────────────┘   │    │
│  │                  │                     │    │
│  │  ┌───────────────┼────────────────┐   │    │
│  │  │  Tools ───────┤                │   │    │
│  │  │  Builtin │ MCP│   Providers    │   │    │
│  │  └───────────────┴────────────────┘   │    │
│  │                  │                     │    │
│  │            ┌─────┴─────┐              │    │
│  │            │  Storage  │              │    │
│  │            │(Mem/SQLite)│             │    │
│  │            └───────────┘              │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
```

**Core principle:** Nexus owns execution, sessions, tasks, tools, and permissions. CLI owns interaction.

---

## Features

### Dual Runtime
| Runtime | Description |
|---------|-------------|
| `LocalCodingRuntime` | Deterministic pattern-matching for fast responses without an LLM roundtrip |
| `LLMCodingRuntime` | Full agentic loop: streaming LLM → tool calls → execution → repeat (up to 25 rounds) |

### Built-in Tools (7 total, risk-gated)

| Tool | Risk | Description |
|------|------|-------------|
| `Read` | read | Read files with size limits |
| `Grep` | read | Regex search with pattern matching |
| `Glob` | read | File discovery |
| `Write` | write | Create/overwrite files |
| `Edit` | write | String replacement in files |
| `Bash` | execute | Shell command execution with CWD state tracking + anti-injection |
| `Task` | task | Create task markers |

All file operations are protected by workspace path safety (`pathSafety.ts`) to prevent directory traversal.

### MCP (Model Context Protocol)

Supports **stdio-based MCP servers** via `~/.babel-o/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      "allowedTools": ["read_file", "list_directory"]
    },
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```

MCP tools are dynamically wrapped as native BabeL-O tools with automatic risk classification. Enable with `BABEL_O_ENABLE_MCP=1`.

### Skills System

Three-tier skill directories (priority: project > user > built-in):

```
built-in/  →  src/skills/built-in/         (coding, debugging, testing, git, optimization)
user/      →  ~/.babel-o/skills/
project/   →  .babel-o/skills/
```

Skills are markdown files with YAML front matter containing `id`, `triggers`, and `priority`. Matching skills are automatically injected into the system prompt.

### Permission & Safety

Four-tier risk model for every tool operation:

- **read** — always auto-approved
- **write** — requires user approval (unless classifier auto-approves)
- **execute** — requires user approval with command auditing
- **task** — task lifecycle gated

Features:
- **Permission classifier** (`classifier.ts`) auto-approves known-safe operations
- **Bash state probing** — random nonce + HMAC markers prevent command injection into CWD tracking
- **Optimizer safety rules** — prevent dangerous operations in optimizer role
- **Execution gate** — concurrency limits and timeout enforcement
- Full permission audit trail persisted to storage

### Multi-Agent Coordination

Three-role agent loop (`agentLoop.ts`):

```
Planner → Executor → Critic → (repeat or commit)
```

Supports sandboxed Git stashing and automatic rollback on failure.

### Session & Memory

- **Session persistence** — SQLite or in-memory storage
- **Session summaries** — automatic compaction of long conversations
- **Project memory** — `.babel-o/memory.md` for project-specific context
- **Context assembly** — layered context budget with snip compaction

### CLI / TUI

- Colored welcome banner with session metadata
- Line-based diff rendering (red/green) for `Edit`/`Write` operations
- Readline history with file-based persistence (`~/.babel-o/history`)
- Tab-completion for commands and workspace paths
- Slash commands: `/help`, `/clear`, `/exit`, `/model`, `/status`, `/sessions`
- `SIGINT` (Ctrl-C) cancels current execution without exiting
- Dual rendering modes: plain text or structured event stream

### Provider Adapters

| Adapter | Protocol | Notes |
|---------|----------|-------|
| `AnthropicAdapter` | SSE (Anthropic) | Prompt caching, extended thinking |
| `OpenAIAdapter` | SSE (OpenAI-compatible) | GPT-4o, GPT-4-turbo |
| `LocalAdapter` | Local (no network) | Deterministic responses for testing |

Provider selection via `~/.babel-o/config.json`.

---

## Quick Start

### Prerequisites

- **Node.js >= 22**
- npm

### Install & Run

```bash
# Clone and install
cd BabeL-O
npm install

# Typecheck
npm run typecheck

# Run tests (47 tests)
npm test

# Start Nexus server (API + WebSocket)
npm run start

# In another terminal: interactive chat
npm run cli -- chat

# Or one-shot execution
npm run cli -- run "explain this codebase"

# Install globally
npm link
bbl run "hello world"
bbl chat
```

---

## Project Structure

```
BabeL-O/
├── bin/
│   └── bbl.js                    # CLI entry point (tsx launcher)
├── src/
│   ├── nexus/                    # Fastify Nexus server
│   │   ├── server.ts             # Server entry, env parsing
│   │   ├── app.ts                # Route registration (REST + WS)
│   │   ├── agentLoop.ts          # Planner → Executor → Critic coordination
│   │   ├── agentRoles.ts         # Role definitions
│   │   ├── taskSession.ts        # Task-session binding
│   │   ├── taskQueue.ts          # Concurrent task scheduling
│   │   ├── executionGate.ts      # Concurrency & timeout enforcement
│   │   ├── runtimeAgentStep.ts   # Agent step execution wrapper
│   │   ├── createRuntime.ts      # Runtime factory (tools + MCP + storage)
│   │   ├── storageBridge.ts      # Memory ↔ persistent storage sync
│   │   └── metrics.ts            # Execution metrics collection
│   │
│   ├── runtime/                  # Runtime implementations
│   │   ├── Runtime.ts            # NexusRuntime interface
│   │   ├── LocalCodingRuntime.ts # Deterministic local runtime
│   │   ├── LLMCodingRuntime.ts   # Full LLM agentic loop
│   │   ├── contextAssembler.ts   # Layered context assembly
│   │   ├── classifier.ts         # Permission auto-classifier
│   │   ├── safetyCheck.ts        # Optimizer safety rules
│   │   ├── sessionSummary.ts     # Session compaction/summarization
│   │   ├── memory.ts             # Project memory (.babel-o/memory.md)
│   │   └── compactors/
│   │       └── snipCompactor.ts  # Tool output truncation
│   │
│   ├── tools/                    # Tool definitions & registry
│   │   ├── Tool.ts               # ToolDefinition, ToolContext, ToolRisk
│   │   ├── registry.ts           # Tool registration & discovery
│   │   ├── output.ts             # Output truncation
│   │   └── builtin/
│   │       ├── read.ts           # File reader
│   │       ├── write.ts          # File writer
│   │       ├── edit.ts           # String replacement
│   │       ├── grep.ts           # Regex search
│   │       ├── glob.ts           # File discovery
│   │       ├── bash.ts           # Shell execution + CWD tracking
│   │       ├── task.ts           # Task markers
│   │       └── pathSafety.ts     # Workspace path enforcement
│   │
│   ├── mcp/                      # MCP client
│   │   ├── McpClient.ts          # JSON-RPC 2.0 stdio client
│   │   ├── McpToolAdapter.ts     # MCP tool → BabeL-O tool wrapper
│   │   └── McpRegistry.ts        # Multi-server MCP registry
│   │
│   ├── providers/                # LLM provider adapters
│   │   ├── registry.ts           # Provider registry
│   │   └── adapters/
│   │       ├── ModelAdapter.ts   # Common adapter interface
│   │       ├── AnthropicAdapter.ts
│   │       ├── OpenAIAdapter.ts
│   │       ├── LocalAdapter.ts
│   │       └── sse.ts            # SSE stream parser
│   │
│   ├── cli/                      # Commander CLI
│   │   ├── program.ts            # Command registration
│   │   ├── NexusClient.ts        # HTTP + WS client for Nexus
│   │   ├── runSessionFlow.ts     # One-shot + interactive execution
│   │   ├── renderEvents.ts       # TUI event renderer (dual mode)
│   │   ├── diff.ts               # Code diff rendering
│   │   ├── diffLcs.ts            # LCS diff algorithm
│   │   ├── welcome.ts            # Startup banner
│   │   ├── embedded.ts           # Embedded mode support
│   │   ├── startupTrace.ts       # Startup diagnostic trace
│   │   ├── completer.ts          # Readline tab-completion
│   │   └── commands/
│   │       ├── run.ts            # bbl run
│   │       ├── chat.ts           # bbl chat (interactive loop)
│   │       ├── optimize.ts       # bbl optimize
│   │       ├── nexus.ts          # bbl nexus start/status
│   │       ├── sessions.ts       # bbl sessions list/inspect
│   │       ├── tools.ts          # bbl tools list/audit
│   │       ├── models.ts         # bbl models list
│   │       └── config.ts         # bbl config
│   │
│   ├── storage/                  # Storage layer
│   │   ├── Storage.ts            # NexusStorage interface
│   │   ├── MemoryStorage.ts      # In-memory storage
│   │   └── SqliteStorage.ts      # SQLite-persisted storage
│   │
│   ├── skills/                   # Skills system
│   │   ├── loader.ts             # Skill discovery & parsing
│   │   ├── matcher.ts            # Trigger-based skill matching
│   │   └── built-in/
│   │       ├── coding.md
│   │       ├── debugging.md
│   │       ├── testing.md
│   │       ├── git.md
│   │       └── optimization.md
│   │
│   └── shared/                   # Shared types & utilities
│       ├── events.ts             # NexusEvent types
│       ├── session.ts            # Session model + permissions
│       ├── task.ts               # Task model
│       ├── config.ts             # Config manager (singleton)
│       ├── errors.ts             # Error handling utilities
│       ├── id.ts                 # ID generation
│       └── toolTrace.ts          # Tool execution tracing
│
├── test/                         # Test suite (47 tests)
│   ├── adapters.test.ts
│   ├── agent-loop.test.ts
│   ├── classifier.test.ts
│   ├── completer.test.ts
│   ├── context-assembler.test.ts
│   ├── diff.test.ts
│   ├── mcp.test.ts
│   ├── optimizer-safety.test.ts
│   ├── permission-flow.test.ts
│   ├── providers.test.ts
│   ├── runtime-llm.test.ts
│   ├── runtime.test.ts
│   ├── security.test.ts
│   ├── skills.test.ts
│   ├── tool-trace.test.ts
│   └── tui-renderer.test.ts
│
├── scripts/
│   ├── benchmark-performance-core.ts
│   ├── smoke-mcp-official.ts
│   └── smoke-providers.ts
│
└── docs/
    ├── ARCHITECTURE.md           # Architecture overview
    ├── PLAN.md                   # Technical evolution plan
    ├── walkthrough.md            # Feature walkthrough
    ├── RECOMMENDATIONS.md        # Migration recommendations from BabeL-X
    ├── task.md                   # Task design notes
    ├── implementation_plan.md    # Implementation plan
    └── nexus/                    # Nexus-specific TODO & work logs
```

---

## CLI Commands

```bash
# Interactive chat (web + terminal)
bbl chat

# One-shot prompt execution
bbl run "write a function that..."

# Self-optimization workflow
bbl optimize

# Nexus server management
bbl nexus start          # Start the Nexus API server
bbl nexus status         # Check server health

# Session management
bbl sessions list        # List all sessions
bbl sessions inspect <id> # Inspect a specific session

# Tool auditing
bbl tools list           # List available tools
bbl tools audit          # Full tool audit with risk levels

# Model listing
bbl models list          # List available models

# Configuration
bbl config show          # Show current config
bbl config set <key> <value>  # Update config
```

### Interactive Chat Controls

| Input | Action |
|-------|--------|
| Type a prompt | Send to the runtime for execution |
| `Ctrl-C` | Cancel current execution (does not exit) |
| `/help` | Show available commands |
| `/clear` | Clear the screen |
| `/exit` | Exit the chat session |
| `/model <name>` | Switch the active model |
| `/status` | Show session status |
| `/sessions` | List recent sessions |
| `y` / `n` | Approve or deny permission requests |

---

## Nexus API

The Nexus server exposes REST + WebSocket endpoints:

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/health` | Health check |
| `POST` | `/v1/sessions` | Create a new session |
| `GET` | `/v1/sessions/:id` | Get session details |
| `POST` | `/v1/sessions/:id/input` | Send a user message |
| `POST` | `/v1/sessions/:id/approve` | Approve a pending permission |
| `POST` | `/v1/sessions/:id/deny` | Deny a pending permission |
| `GET` | `/v1/sessions/:id/tool-traces` | Get tool execution traces |
| `POST` | `/v1/tasks` | Create a new task |
| `GET` | `/v1/tasks` | List tasks |
| `GET` | `/v1/runtime/tools` | List available tools |
| `GET` | `/v1/runtime/metrics` | Get runtime metrics |

### WebSocket

```
GET /v1/stream?sessionId=<id>
```

Streams real-time execution events:
- `session_started` / `session_ended`
- `assistant_delta` — streaming text
- `thinking_delta` — streaming thinking/reasoning
- `tool_started` / `tool_completed` — tool execution lifecycle
- `permission_request` / `permission_response` — approval flow
- `error` — execution errors
- `result` — final result
- `execution_metrics` — performance metrics
- `usage` — token usage

---

## Configuration

### Provider & Model Config

Create `~/.babel-o/config.json`:

```json
{
  "providerId": "anthropic",
  "modelId": "claude-sonnet-4-20250514",
  "apiKey": "sk-ant-...",
  "baseUrl": "https://api.anthropic.com"
}
```

Or `BABEL_O_CONFIG_FILE` to use a custom path.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXUS_HOST` | `127.0.0.1` | Nexus server bind address |
| `NEXUS_PORT` | `3000` | Nexus server port |
| `NEXUS_API_KEY` | — | API key for Nexus auth |
| `NEXUS_STORAGE_PATH` | — | SQLite database path (defaults to in-memory) |
| `NEXUS_ALLOWED_TOOLS` | `read,grep,glob,task` | Comma-separated tool allowlist |
| `NEXUS_EXECUTE_TIMEOUT_MS` | — | Max execution timeout (ms) |
| `NEXUS_MAX_CONCURRENT_EXECUTIONS` | `8` | Max concurrent executions |
| `NEXUS_MAX_TOOL_OUTPUT_BYTES` | `200000` | Max tool output bytes |
| `NEXUS_BASH_MAX_BUFFER_BYTES` | `1000000` | Max Bash output buffer |
| `BABEL_O_WORKSPACE` | `cwd` | Workspace root directory |
| `BABEL_O_ENABLE_MCP` | `0` | Enable MCP client (`1` to enable) |
| `BABEL_O_THINKING_BUDGET` | — | Thinking budget tokens (Anthropic) |
| `BABEL_O_CONFIG_FILE` | — | Custom config file path |
| `NEXUS_LOG_LEVEL` | `warn` | Log level: `debug`, `info`, `warn`, `error`, `silent` |
| `BABEL_O_MCP_DEBUG` | `0` | Log MCP server stderr (`1` to enable) |

### MCP Config

Create `~/.babel-o/mcp.json` to configure MCP servers. See [MCP section](#mcp-model-context-protocol) for format details.

### Skills

Place `.md` files with front matter in:
- `~/.babel-o/skills/` (user-level)
- `.babel-o/skills/` (project-level)

Built-in skills are in `src/skills/built-in/`.

### Project Memory

Create `.babel-o/memory.md` in your project root for persistent project-specific context.

---

## Development

### Scripts

```bash
npm run dev              # Start Nexus with hot reload (tsx watch)
npm run start            # Start Nexus server
npm run cli              # Run CLI (tsx)
npm run typecheck        # TypeScript type checking (tsc --noEmit)
npm test                 # Run all tests (47 tests, single concurrency)
npm run benchmark        # Run performance benchmark
npm run test:mcp:official # Smoke test official MCP servers
npm run test:providers:smoke  # Smoke test provider connections
```

### Tech Stack

- **Runtime**: Node.js >= 22, TypeScript 5.9, ESM
- **Server**: Fastify 5 + `@fastify/websocket`
- **CLI**: Commander 14 + Chalk 5 + Node readline
- **Validation**: Zod 4
- **Storage**: SQLite (via `node:sqlite`) or in-memory
- **Build**: tsx (dev), planned tsup migration for production
- **Zero React/Ink dependency** — clean rewrite principle

### Design Principles

1. **Nexus-first**: Execution, tools, storage, and permissions belong to the server; CLI is a thin client.
2. **Clean interfaces**: Storage, runtime, and providers are behind small, swappable interfaces.
3. **No telemetry**: Pure local operation, no cloud service dependencies.
4. **Safety by default**: All tools are risk-gated; MCP tools require explicit allow-listing.
5. **Minimal dependencies**: Only `fastify`, `commander`, `chalk`, and `zod` as runtime deps.

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture overview and layer design |
| [`docs/PLAN.md`](docs/PLAN.md) | Technical evolution plan (5 phases) |
| [`docs/walkthrough.md`](docs/walkthrough.md) | Feature walkthrough with verification results |
| [`docs/RECOMMENDATIONS.md`](docs/RECOMMENDATIONS.md) | Migration recommendations from BabeL-X |
| [`docs/implementation_plan.md`](docs/implementation_plan.md) | Implementation plan |
| [`docs/task.md`](docs/task.md) | Task system design notes |
| [`docs/nexus/README.md`](docs/nexus/README.md) | Nexus sub-project overview |
| [`docs/nexus/TODO.md`](docs/nexus/TODO.md) | Master TODO |
| [`docs/nexus/WORK_LOG.md`](docs/nexus/WORK_LOG.md) | Development work log |

---

## License

See [LICENSE](LICENSE).
