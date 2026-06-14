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

## Why BabeL-O?

Most coding agents are stuck in one shape: a Node process, a heavy Electron, a cloud round-trip, or a one-shot chat. BabeL-O splits the problem along the line that actually hurts:

- **Run many sessions in parallel across worktrees — without losing state.** The Nexus daemon holds the durable runtime; clients can disconnect, reconnect, and switch machines. Tasks do not die when your TUI does. _Technical counterpart: process-per-session model + Nexus `bbl serve` / embedded mode + `/sessions tree` / `/inbox`._
- **A 10 MB native Go TUI, no Node on the wire.** `bbl go` is a Bubble Tea client that talks to Nexus over HTTP/WS; drop it into a container, a remote box, or a slow SSH without dragging Node with it. _Technical counterpart: `clients/go-tui` Go module, single static binary, `--check` health gate before connect._
- **A real agent loop, not a demo.** Context compaction, evidence routing, permission gates, sub-agent collaboration, recover from timeouts without losing your place. _Technical counterpart: `src/runtime/cacheAwareCompactPolicy.ts`, `src/runtime/runtimePipeline.ts`, `src/permissions/`, `src/nexus/everCoreRuntimeManager.ts`._

---

## What Is BabeL-O?

BabeL-O is a terminal-first AI agent for real coding work. The interactive client stays light and responsive, while Nexus keeps the durable runtime state: sessions, tools, permissions, context, memory, and execution traces.

The production interactive entrypoint is the Go TUI:

```bash
bbl go
```

It connects to Nexus, can auto-start a local Nexus service for you, and gives you a polished terminal workspace for chatting, running tools, switching sessions, inspecting context, approving permissions, and coordinating work across sessions.

---

## Quick Start (5 minutes)

> **Prerequisite:** Node.js ≥ 22 (`node --version`). macOS, Linux, or Windows via WSL.

```bash
# 1. Install
npm i -g babel-o

# 2. Verify
bbl --version

# 3. Pick a provider + model
bbl init                          # interactive wizard, or:
bbl init --non-interactive --provider anthropic --model claude-3-5-sonnet-latest

# 4. Chat
bbl go                            # Production Go TUI, ~10 MB binary, default
# (legacy) bbl chat               # Frozen TypeScript TUI; remove in v0.5.0

# 5. Try it
> explain this repo's entry point
```

Inside the TUI:

| Input | Action |
| :--- | :--- |
| `/` | Open the slash-command palette |
| `/session` | Open the session operations panel |
| `/context` | Inspect current context budget and diagnostics |
| `/tools` or `Ctrl+O` | Open the tools panel |
| `/model` or `Ctrl+L` | Open model/profile selection |
| `/memory` | Inspect memory status, search memory hints, review candidates |
| `Ctrl+D` | Open the top status panel |
| `Shift+Enter` | Insert a newline in the input box |
| `Ctrl+C` | Open the quit confirmation dialog |
| `Esc` | Close the active panel/dialog |

---

## Try these prompts

Copy-paste any of these to see BabeL-O's differentiators in action:

- `> in /tmp/demo, scaffold a Python project, run pytest, commit to a new branch` — exercises Bash + Edit + Git in one turn.
- `> launch 3 worktrees in parallel, each fixing one P0 item from TODO.md, then merge them back` — exercises the worktree + sub-agent + session tree.
- `> start a long migration task with bbl run, kill the connection, reconnect, and confirm the task resumed` — exercises the Nexus daemon durability.
- `> turn on MemoryOS in the background, run 5 sessions, then ask "what did we decide about the auth model last week?"` — exercises the long-term memory bootstrap and recall.

---

## Highlights

- **Production Go TUI**: `bbl go` is the default daily interactive client, with a Bubble Tea interface, multi-line input, slash-command panels, permission dialogs, context inspection, and responsive transcript rendering.
- **Persistent Nexus Sessions**: Work continues across restarts with session history, tool traces, usage telemetry, compacted context, and inspectable session metadata.
- **Session Switching and Conversation Flow**: The `/session` panel supports creating, selecting, switching, and copying session IDs without leaving the TUI.
- **SessionChannel Collaboration**: Typed side-channel messages let sessions exchange findings, handoffs, review requests, decisions, and memory candidates without treating those messages as direct user instructions.
- **Context and Memory Awareness**: `/context` shows budget, compaction, memory, recovery, and working-set diagnostics so long conversations stay understandable.
- **Long-term Memory (MemoryOS)**: Optional local long-term memory powered by a managed sidecar. Bootstrap is opt-in (first `bbl go` startup may auto-trigger it via `BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1`) and the TUI footer shows a one-line `[m: ready]` / `[m: failed ⚠ …]` indicator instead of silently failing.
- **Permission-First Tooling**: Sensitive tools such as Bash, Write, Edit, and MCP tools go through visible approval flows with session-level trust options and audit logs.
- **MCP and Built-in Tools**: Read, Grep, ListDir, Bash, WebSearch, and configured MCP servers are exposed as risk-classified tools.
- **Model and Profile Control**: Switch model/provider profiles from the TUI while Nexus keeps shared runtime configuration consistent.
- **Runtime Stability Fixes**: Session replay, context compaction, evidence routing, timeout recovery, and install self-checks are hardened so long-running Go TUI sessions recover more predictably.

---

## Long-term Memory (MemoryOS)

MemoryOS is the optional local long-term memory service. It runs a managed sidecar on loopback, indexes the sessions you approve, and lets the model recall them later. It is **opt-in, off by default, and never replaces workspace evidence** — it is a hint layer, not a source of truth.

Quick tour:

```bash
bbl memory status                 # see whether MemoryOS is set up
bbl memory setup --yes            # one-shot bootstrap (clone + build, in background)
bbl memory opt-out                # disable the first-run prompt permanently
bbl memory enable-tools           # let the model save notes (default is read-only hints)
bbl memory doctor                 # diagnose memory readiness
```

The model never sees MemoryOS write tools by default. If you want the model to remember things explicitly, run `bbl memory enable-tools` first. The setting is persisted in `~/.babel-o/everos-bootstrap.json` (env vars still win).

See [FAQ → Q4](docs/nexus/FAQ.md) for the full onboarding flow and [MemoryOS Zero-Friction Startup Plan](docs/nexus/reference/everos-zero-friction-memory-startup-optimization-plan.md) for the design.

---

## Install

### Recommended: `npm i -g babel-o`

The single recommended path. Works on macOS, Linux, and Windows (via WSL). Requires Node.js ≥ 22.

```bash
npm i -g babel-o
bbl --version
```

### Alternative: portable release package

If you want a Node-free install (e.g. into a container without Node), use the lightweight portable package. It contains the Go TUI binary and the Nexus CLI/runtime, and uses your system Node only when the optional Node-fallback path is engaged.

- Download the latest `bbl-<platform>.tar.gz` from [GitHub Releases](https://github.com/SuTang-vain/BabeL-O/releases), or see the [release notes](docs/releases/README.md).
- Extract it, add the `bin/` directory to your `$PATH`, then `bbl go`.
- SHA256 verification is built into the release artifact metadata.

### Alternative: install script

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | bash
bbl go
```

For a specific version: `BBL_VERSION=v0.3.6 bash` before the pipe.

### Build from source

Prerequisites: Node.js ≥ 22, npm, Go toolchain (for the TUI), optionally Docker (for sandboxed shell).

```bash
git clone https://github.com/SuTang-vain/BabeL-O.git
cd BabeL-O
npm ci
npm test
npm run build
npm link
bbl go
```

To build the portable package:

```bash
npm run build
cd clients/go-tui && make build && cd ../..
npm run build:portable
```

---

## Configuration

BabeL-O stores local configuration in `~/.babel-o/config.json`. Use `bbl init` to set this up interactively; do not hand-edit it for the first run.

```json
{
  "providerId": "anthropic",
  "modelId": "anthropic/claude-3-5-sonnet",
  "apiKey": "sk-ant-...",
  "baseUrl": "https://api.anthropic.com"
}
```

Supported providers: `anthropic`, `openai`, `deepseek`, `moonshot`, `ollama`, `zhipu`, `minimax`, `local` (for tests and benchmarks).

Inspect at runtime:

```bash
bbl config show
bbl doctor
bbl memory doctor
```

---

## Session Collaboration

BabeL-O treats session-to-session messages as collaboration context, not as hidden prompts. A message can carry a finding, handoff, review request, validation request, hypothesis, decision, blocked state, or memory candidate, but the receiving session must still verify and act explicitly.

```bash
bbl sessions list
bbl sessions tree
bbl sessions inbox <sessionId>
bbl sessions ack <sessionId> <messageId>
bbl sessions inspect <sessionId>
```

In the TUI, use `/session` to create or switch sessions, `/inbox` to inspect cross-session messages, and `/activity` to review recent collaboration events.

---

## Common commands

```bash
bbl go                            # interactive TUI (Go, production)
bbl chat                          # interactive TUI (TypeScript, **legacy / frozen**)
bbl run "summarize this repo"     # one-shot prompt, no TUI
bbl init                          # first-run provider + model wizard
bbl doctor                        # self-check (provider, keychain, port, memory)
bbl memory status                 # MemoryOS bootstrap + runtime status
bbl memory setup --yes            # bootstrap MemoryOS
bbl nexus status                  # check Nexus health
bbl sessions list                 # list persisted sessions
bbl sessions inspect <sessionId>  # inspect session details and traces
bbl tools list                    # list available tools
bbl tools audit                   # review tool audit history
bbl config show                   # show active configuration
```

---

## Legacy: `bbl chat` (TypeScript TUI)

> **Frozen as of 2026-06. Removal planned for v0.5.0 once Go TUI feature parity is confirmed.**

`bbl chat` is the original TypeScript TUI that drove the v0.1 → v0.3 line. The native Go TUI (`bbl go`, in `clients/go-tui`) is the production interactive entrypoint and has been the recommended path since v0.3.

The legacy command still works, but:

- Every invocation prints a yellow deprecation banner pointing you to `bbl go`.
- New features are not added to the TypeScript TUI. The slash palette, vim mode, paste buffer, and other chat-specific code paths are in maintenance-only mode.
- The `bbl run` one-shot command and the Nexus server (`bbl serve`) keep using the TypeScript runtime and shared `src/cli/` helpers — those are not affected by the freeze.

If you must silence the banner (CI scripts, tests):

```bash
export BABEL_O_SUPPRESS_CHAT_DEPRECATION=1
bbl chat
```

If you have feedback on what is missing from `bbl go` that blocks your migration, file an issue — we will use it to drive the v0.5.0 removal decision.

---

## Safety Model

BabeL-O is designed around explicit boundaries:

- Workspace path checks protect file access from traversal and symlink escapes.
- Risky tools require visible permission decisions.
- Tool inputs, outputs, approvals, denials, and usage events are persisted for inspection.
- SessionChannel content is never executed as a direct instruction.
- MemoryOS results are hints, never authoritative workspace facts.
- Nexus remains the source of truth for runtime state; the TUI focuses on interaction.

---

## Documentation

- [FAQ](docs/nexus/FAQ.md) — common questions about long-term memory, install, configuration
- [Go TUI client guide](clients/go-tui/README.md)
- [Nexus planning and implementation notes](docs/nexus/README.md)
- [Release notes](docs/releases/README.md)
- [MemoryOS First-Run Onboarding Plan](docs/nexus/reference/everos-first-run-onboarding-optimization-plan.md)
- [MemoryOS Zero-Friction Startup Plan](docs/nexus/reference/everos-zero-friction-memory-startup-optimization-plan.md)

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
