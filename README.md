# BabeL-O

<p align="center">
  <img src="docs/assets/babel-o-logo.png" alt="BabeL-O product logo" width="132" />
  <img src="docs/assets/kezhongke_logo_3d.png" alt="KezhongKe IP brand logo" width="132" />
</p>

<p align="center">
  <strong>Technical support provided by KezhongKe (壳中客).</strong>
</p>

> **A Nexus-first AI coding agent with a fast Go TUI, persistent sessions, tool-aware execution, and cross-session collaboration.**

[简体中文 README](README.zh-CN.md)

---

## What Is BabeL-O?

BabeL-O is a terminal-first AI agent for real coding work. The interactive client stays light and responsive, while Nexus keeps the durable runtime state: sessions, tools, permissions, context, memory, and execution traces.

The production interactive entrypoint is the Go TUI:

```bash
bbl go
```

It connects to Nexus, can auto-start a local Nexus service for you, and gives you a polished terminal workspace for chatting, running tools, switching sessions, inspecting context, approving permissions, and coordinating work across sessions.

<p align="center">
  <img src="docs/assets/product.png" alt="BabeL-O Go TUI product screenshot" width="920" />
</p>

---

## Highlights

- **Production Go TUI**: `bbl go` is the default daily interactive client, with a Bubble Tea interface, multi-line input, slash-command panels, permission dialogs, context inspection, and responsive transcript rendering.
- **Persistent Nexus Sessions**: Work continues across restarts with session history, tool traces, usage telemetry, compacted context, and inspectable session metadata.
- **Session Switching and Conversation Flow**: The `/session` panel supports creating, selecting, switching, and copying session IDs without leaving the TUI.
- **SessionChannel Collaboration**: Typed side-channel messages let sessions exchange findings, handoffs, review requests, decisions, and memory candidates without treating those messages as direct user instructions.
- **Context and Memory Awareness**: `/context` shows budget, compaction, memory, recovery, and working-set diagnostics so long conversations stay understandable.
- **Memory Management Surface**: `/memory` exposes read-only status, bounded memory search, review-only memory candidates, and approval-gated save/flush actions.
- **Permission-First Tooling**: Sensitive tools such as Bash, Write, Edit, and MCP tools go through visible approval flows with session-level trust options and audit logs.
- **MCP and Built-in Tools**: Read, Grep, ListDir, Bash, WebSearch, and configured MCP servers are exposed as risk-classified tools.
- **Model and Profile Control**: Switch model/provider profiles from the TUI while Nexus keeps shared runtime configuration consistent.
- **Runtime Stability Fixes**: Session replay, context compaction, evidence routing, timeout recovery, and install self-checks are hardened so long-running Go TUI sessions recover more predictably.

---

## Install

### Release Installer

On macOS and Linux, the installer detects your platform and installs the lightweight portable release package. The package contains the production Go TUI and the compiled Nexus CLI/runtime, while using your system Node.js instead of a large Node SEA executable.

Prerequisite: Node.js >= 22.

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | bash
bbl go
```

Install a specific release:

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | BBL_VERSION=v0.3.5 bash
bbl go
```

### Manual Release Package

Download the latest `bbl-<platform>.tar.gz` package from [GitHub Releases](https://github.com/SuTang-vain/BabeL-O/releases), or see the [v0.3.5 release notes](docs/releases/v0.3.5.md) for version-specific links.

Extract it, add its `bin/` directory to your `$PATH`, then run:

```bash
bbl go
```

Windows support is currently source-build first while the lightweight release installer targets macOS and Linux.

### Build From Source

Prerequisites:

- Node.js >= 22
- npm
- Go toolchain for local Go TUI development
- Optional Docker for sandboxed shell execution

```bash
git clone https://github.com/SuTang-vain/BabeL-O.git
cd BabeL-O
npm ci
npm test
npm run build
npm link
bbl go
```

Build the lightweight portable package:

```bash
npm run build
cd clients/go-tui && make build && cd ../..
npm run build:portable
```

Build the legacy standalone Node SEA binary:

```bash
npm run build:binary
./dist/bbl go
```

Build the local Go TUI binary used by `bbl go` from a source checkout:

```bash
cd clients/go-tui
make build
cd ../..
bbl go --check
```

---

## Quick Start

```bash
bbl go                           # Start the production Go TUI
bbl go --check                   # Verify Go TUI binary, Nexus health, and compatibility
bbl run "summarize this repo"     # Run a one-shot prompt without opening the TUI
bbl nexus status                 # Check Nexus health
bbl sessions list                # List persisted sessions
bbl sessions inspect <sessionId> # Inspect session details and traces
bbl tools list                   # List available tools
bbl tools audit                  # Review tool audit history
bbl config show                  # Show active configuration
```

Inside the Go TUI:

| Input | Action |
| :--- | :--- |
| `/` | Open the slash-command palette |
| `/session` | Open the session operations panel |
| `/context` | Inspect current context budget and diagnostics |
| `/tools` or `Ctrl+O` | Open the tools panel |
| `/model` or `Ctrl+L` | Open model/profile selection |
| `/memory` | Inspect memory status, search memory hints, and review candidates |
| `Ctrl+D` | Open the top status panel |
| `Shift+Enter` | Insert a newline in the input box |
| `Ctrl+C` | Open the quit confirmation dialog |
| `Esc` | Close the active panel/dialog |

---

## Session Collaboration

BabeL-O treats session-to-session messages as collaboration context, not as hidden prompts. A message can carry a finding, handoff, review request, validation request, hypothesis, decision, blocked state, or memory candidate, but the receiving session must still verify and act explicitly.

Useful commands:

```bash
bbl sessions list
bbl sessions tree
bbl sessions inbox <sessionId>
bbl sessions ack <sessionId> <messageId>
bbl sessions inspect <sessionId>
```

In the Go TUI, use `/session` to create or switch sessions, `/inbox` to inspect cross-session messages, and `/activity` to review recent collaboration events.

---

## Configuration

BabeL-O stores local configuration in `~/.babel-o/config.json`.

Example:

```json
{
  "providerId": "anthropic",
  "modelId": "anthropic/claude-3-5-sonnet",
  "apiKey": "sk-ant-...",
  "baseUrl": "https://api.anthropic.com"
}
```

Supported providers include:

- `anthropic`
- `openai`
- `deepseek`
- `moonshot`
- `ollama`
- `zhipu`
- `minimax`
- `local` for tests and benchmarks

---

## Safety Model

BabeL-O is designed around explicit boundaries:

- Workspace path checks protect file access from traversal and symlink escapes.
- Risky tools require visible permission decisions.
- Tool inputs, outputs, approvals, denials, and usage events are persisted for inspection.
- SessionChannel content is never executed as a direct instruction.
- Nexus remains the source of truth for runtime state, while the TUI focuses on interaction.

---

## Documentation

- [Release notes](docs/releases/README.md)
- [Go TUI client guide](clients/go-tui/README.md)
- [Nexus planning and implementation notes](docs/nexus/README.md)

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
