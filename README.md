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
  <a href="https://www.npmjs.com/package/babel-o"><img src="https://img.shields.io/npm/v/babel-o" alt="npm version" /></a>
  <a href="https://github.com/SuTang-vain/BabeL-O/actions/workflows/ci.yml"><img src="https://github.com/SuTang-vain/BabeL-O/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/contributions-welcome-brightgreen" alt="Contributions welcome" /></a>
  <a href="https://github.com/SuTang-vain/BabeL-O/discussions"><img src="https://img.shields.io/badge/discussions-open-blue" alt="GitHub Discussions" /></a>
</p>

<p align="center">
  <img src="docs/assets/product.png" alt="BabeL-O Go TUI screenshot" width="860" />
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

- **Native terminal interface:** `bbl go` is the official interactive client,
  built with Bubble Tea and tuned for multi-line input, slash panels, mouse
  selection, permission dialogs, and long transcripts.
- **Durable sessions:** Nexus keeps session state, tool traces, context,
  approvals, and runtime metadata outside the TUI process. You can reconnect,
  inspect, and continue.
- **Permission-first tools:** Bash, Write, Edit, MCP tools, and memory writes
  stay visible. Approve once, approve for a session, or reject with feedback.
- **Context you can inspect:** `/context` shows budget, compaction, memory,
  recovery, working set, and long-context diagnostics instead of hiding the
  agent's state.
- **Session collaboration:** `/session`, `/inbox`, and SessionChannel let
  sessions exchange findings, handoffs, decisions, and review requests without
  treating those messages as secret instructions.
- **Model and memory control:** Switch model/provider profiles from the TUI,
  and optionally enable MemoryOS for local long-term recall.

## Installation

### Recommended: release installer

The installer downloads the lightweight release package for your platform,
installs a small `bbl` launcher, bundles the matching Go TUI binary, and runs a
post-install self-check.

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | bash
bbl go
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | BBL_VERSION=v0.3.8 bash
```

Requirements: macOS or Linux, Node.js >= 22 on `PATH`.

### npm

Useful for Node developers and source-based installs:

```bash
npm install -g babel-o
bbl go
```

The release installer is preferred for most users because it includes the
prebuilt Go TUI for your platform.

### From source

```bash
git clone https://github.com/SuTang-vain/BabeL-O.git
cd BabeL-O
npm ci
npm test
npm run build
npm link
cd clients/go-tui && make build
bbl go
```

## First Run

```bash
bbl init
bbl go
```

`bbl init` walks through provider and model setup. You can also configure
providers directly:

```bash
bbl config add anthropic "$ANTHROPIC_API_KEY"
bbl config use anthropic/claude-3-5-sonnet
```

Inside the TUI:

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
bbl init                          # provider and model wizard
bbl doctor                        # local readiness checks
bbl go --check --no-start-nexus   # install and TUI readiness check
bbl nexus status                  # Nexus health
bbl sessions list                 # persisted sessions
bbl sessions inspect <sessionId>  # session events and traces
bbl memory status                 # MemoryOS status
bbl tools audit                   # tool and permission audit
bbl config show                   # active configuration
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
`ollama`, `zhipu`, `minimax`, and `local`.

Useful checks:

```bash
bbl config show
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
[BabeL-O Architecture](docs/nexus/ARCHITECTURE.md).

## Release Notes

As of v0.3.7, the old `bbl chat` TypeScript TUI has been removed from the
release package. The official interactive entrypoint is `bbl go`; `bbl run`
remains available for one-shot automation.

This keeps the install smaller, removes duplicated terminal UI logic, and puts
future interaction work into the native Go TUI.

## Documentation

- [Changelog](CHANGELOG.md)
- [Release notes](docs/releases/README.md)
- [FAQ](docs/nexus/FAQ.md)
- [Go TUI client guide](clients/go-tui/README.md)
- [Distribution guide](docs/nexus/reference/distribution-guide.md)
- [Nexus planning notes](docs/nexus/README.md)

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
