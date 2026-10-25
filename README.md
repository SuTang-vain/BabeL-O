# BabeL-O

<p align="center">
  <img src="docs/assets/babel-o-logo.png" alt="BabeL-O logo" width="132" />
  <img src="docs/assets/kezhongke_logo_3d.png" alt="KezhongKe logo" width="132" />
</p>

<p align="center">
  <strong>Your terminal workspace for durable coding sessions, native TUI workflows, and tool-aware agents.</strong><br />
  Technical support provided by KezhongKe (壳中客).
</p>

<p align="center">
  <a href="https://github.com/SuTang-vain/BabeL-O/releases"><img src="https://img.shields.io/github/v/release/SuTang-vain/BabeL-O" alt="Latest release" /></a>
  <a href="https://github.com/SuTang-vain/BabeL-O/actions/workflows/ci.yml"><img src="https://github.com/SuTang-vain/BabeL-O/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/contributions-welcome-brightgreen" alt="Contributions welcome" /></a>
  <a href="https://github.com/SuTang-vain/BabeL-O/discussions"><img src="https://img.shields.io/badge/discussions-open-blue" alt="GitHub Discussions" /></a>
</p>

<p align="center">
  <img src="docs/assets/product.png" alt="BabeL-O v0.5.0 Go TUI screenshot" width="860" />
</p>

[简体中文 README](README.zh-CN.md)

## What Is BabeL-O?

BabeL-O is an AI coding agent that lives in your terminal.

It gives you a native Go TUI for day-to-day work, a Nexus runtime that keeps
sessions alive, and a permission-first tool system for reading, editing,
running commands, searching the web, and coordinating work across sessions.

Start the production TUI with:

```bash
bbl go
```

Use it for repo exploration, edits, tests, long migrations, model switching,
context inspection, and session-to-session handoffs without turning your
terminal into a fragile one-shot chat.

## Why BabeL-O?

- **Multiple parallel sessions across worktrees** — Work on isolated workspaces
  simultaneously. The background daemon holds state, so your client can disconnect
  and reconnect without losing tasks.
  *(Technical: worktree isolation + session persistence + WebSocket reconnect)*

- **Small standalone Go TUI client** — `bbl go` is a native Go TUI binary (~14MB).
  The Nexus daemon still needs Node.js 22+ and native SQLite, so the client can
  stay thin while sessions remain durable.
  *(Technical: Go Bubble Tea TUI + Node 22+ daemon with native SQLite)*

- **Completes long tasks for real** — Context compaction, tool loop boundaries,
  permission governance, and sub-agent coordination — not a demo-level toy.
  *(Technical: LLMCodingRuntime + TaskSession + AgentLoop + scope governance)*

- **Permission-first tools** — Bash, Write, Edit, MCP tools, and memory writes
  stay visible. Approve once, approve for a session, or reject with feedback.

- **Inspectable context** — `/context` shows budget, compaction, memory,
  recovery, working set, and long-context diagnostics instead of hiding the
  agent's state.

- **Session collaboration** — `/session`, `/inbox`, and SessionChannel let
  sessions exchange findings, handoffs, decisions, and review requests without
  treating those messages as secret instructions.

### Compaction and context (v0.5.0)

v0.5.0 fixes compaction correctness by default: it reads the newest event
window, keeps the current instruction, separates state and summary budgets, and
records a message-based ledger. The default strategy is still `stock` — 90/70
thresholds, a prose summary, the system boundary, and no retrieval.

Adaptive compaction, deterministic digest, faithful digest, cache-aware
thresholds, and retrieval pointers are available as opt-in experiments. They
are not enabled by default, their cost benefits have not been established, and
retrieval is not recommended for production. Use `/context` to inspect the
current budget, compaction state, memory, and working set.

---

## Quick Start (5 minutes)

> ⚠️ **Requires Node.js >= 22.** If your Node is older, upgrade first.
> For source builds and platform details, see [INSTALLATION.md](docs/INSTALLATION.md).

```bash
# Install the current release
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | \
  BBL_VERSION=v0.5.0 bash

# First-time provider setup (interactive)
bbl config init

# Or configure non-interactively
bbl config add anthropic "$ANTHROPIC_API_KEY"
bbl config use anthropic/claude-sonnet-4-6

# Launch the terminal UI
bbl go
```

Then try: **"Explain this repository's main entry point"**

See [Common Commands](#common-commands) for more usage examples.

## Installation

### Recommended: release installer

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | \
  BBL_VERSION=v0.5.0 bash
bbl go
```

Requirements: macOS or Linux, Node.js >= 22. The installer bundles the matching
Go TUI binary and runs a post-install self-check.

> For source builds and platform details, see
> [INSTALLATION.md](docs/INSTALLATION.md).

---

## TUI Keybindings

| Input | Action |
| :--- | :--- |
| `/` | Open the command palette |
| `/model` or `Ctrl+L` | Configure provider, API key, base URL, and model |
| `/session` | Create, select, switch, or copy session IDs |
| `/context` | Inspect context budget and diagnostics |
| `/tools` or `Ctrl+O` | Open the tool panel |
| `/memory` | Inspect MemoryOS status and memory candidates |
| `Ctrl+D` | Open the top status panel |
| `Shift+Enter` | Insert a newline |
| `Esc` | Close the active panel |
| `Ctrl+C` | Open the quit dialog |

## Try It

```text
explain this repository and point me to the entry points
```

```text
read the failing test output, patch the bug, and rerun the smallest useful test
```

```text
create a new session for release notes, then summarize the current changes
```

```text
inspect the current context budget and tell me whether we should compact
```

## Common Commands

```bash
bbl go                            # production Go TUI
bbl run "summarize this repo"     # one-shot prompt, no TUI
bbl doctor                        # local readiness checks
bbl go --check --no-start-nexus   # install and TUI readiness check
bbl nexus status                  # Nexus health
bbl sessions list                 # persisted sessions
bbl inspect-session <sessionId>  # session events and traces
bbl memory status                 # MemoryOS status
bbl tools audit                   # tool and permission audit
bbl config list                   # active configuration
```

## MemoryOS

MemoryOS is optional local long-term memory. It runs as a managed loopback
sidecar, indexes approved session knowledge, and returns memory hints when they
are useful.

It is opt-in, local-first, and never replaces workspace evidence. Memory hits
are hints; files and tool results remain the source of truth.

```bash
bbl memory status
bbl memory setup --yes
bbl memory enable-tools
bbl memory doctor
```

## Configuration

BabeL-O stores local configuration in `~/.babel-o/config.json`.

Supported providers include `anthropic`, `openai`, `deepseek`, `moonshot`,
`ollama`, `zhipu`, `minimax`, and `local`, plus custom OpenAI-compatible
providers.

Useful checks:

```bash
bbl config list
bbl doctor
bbl go --check
```

## Safety Model

BabeL-O is built around explicit boundaries:

- Workspace path checks protect against traversal and symlink escapes.
- Risky tools require visible permission decisions.
- Tool inputs, outputs, approvals, denials, and usage events are persisted.
- SessionChannel messages are collaboration context, not hidden commands.
- MemoryOS results are hints, not authoritative workspace facts.
- Nexus is the runtime source of truth; the TUI is the interaction layer.

## Architecture

For a deeper public overview of how the CLI, Go TUI, Nexus daemon, runtime,
tools, agents, memory, storage, and observability layers fit together, see
[BabeL-O Architecture](docs/guides/ARCHITECTURE.md).

## Release Notes

The current release is **v0.5.0** (2026-10-25). It fixes compaction correctness
by default and adds opt-in compaction experiments; the stock defaults are
unchanged. See [v0.5.0 release notes](docs/releases/v0.5.0.md) for flags and
known limitations.

The legacy `bbl chat` TypeScript TUI was removed in v0.3.7. `bbl go` is the
production interactive entrypoint; `bbl run` remains available for one-shot
automation.

## Documentation

- [Changelog](CHANGELOG.md)
- [Release notes](docs/releases/README.md)
- [FAQ](docs/guides/FAQ.md)
- [Go TUI client guide](clients/go-tui/README.md)
- [Distribution guide](docs/guides/distribution-guide.md)
- [Nexus planning notes](docs/nexus/README.md)

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
