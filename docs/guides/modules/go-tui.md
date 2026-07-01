# Go TUI

> Module reference · stable public contract · see linked governance docs for deep architecture

[简体中文](go-tui.zh-CN.md)

## Role

The Go TUI (`bbl go`) is the production interactive client for BabeL-O Nexus. It
is a standalone Go binary built with Bubble Tea that connects to Nexus via the
public HTTP and WebSocket APIs. Nexus owns execution, context, permissions,
storage, and session state; the Go TUI owns terminal layout, keyboard routing,
transcript rendering, overlays, local input state, permission UI, and local slash
commands. Since v0.3.7 it has been the sole production TUI (the TypeScript
`bbl chat` was removed).

A companion binary `bbl loop` provides a multi-session pane client that
visualises multiple Nexus sessions simultaneously, but it remains a client — it
must not schedule work independently or become a second AgentScheduler.

The `bbl go` CLI wrapper can auto-start a local Nexus process when the target
URL is unhealthy. The Go binary itself remains a client only and does not read
BabeL-O config files directly.

## Public contract

- **WebSocket `GET /v1/stream`** — the core execution stream. The Go TUI submits
  a prompt as a JSON payload and receives typed events (assistant, thinking, tool,
  permission, usage, result, error). Permission decisions are returned via the
  same WebSocket channel. Streaming deltas are merged into the current transcript
  line with stable-prefix rendering.

- **HTTP `GET /v1/runtime/config`** — background polling for shared Nexus runtime
  config changes (default 30000 ms interval; `--poll-interval-ms=0` disables).
  Also supports `?since=<version>` for incremental updates.

- **HTTP `POST /v1/runtime/config/select`** — switch active config profile or
  default model from the TUI.

- **HTTP `GET /v1/sessions/:id/...`** — session-scoped endpoints for inbox,
  agents, tasks, context analysis, and manual compact.

- **HTTP `GET /v1/tools/audit`** — global tool registry snapshot rendered in the
  tools audit overlay.

- **HTTP `GET /v1/skills`, `GET /v1/skills/:id`, `POST /v1/skills/validate`** —
  skill listing, detail, and validation from the TUI.

- **Local slash commands** (`/config`, `/profile`, `/profiles`, `/context`,
  `/compact`, `/status`, `/tools`, `/tasks`, `/agents`, `/inbox`, `/skills`,
  `/model`, `/memory`) — handled by the Go TUI client itself; never submitted as
  agent prompts.

- **Permission panel** — renders `permission_request` events with approve/reject
  keyboard actions. Per-turn tool allowlists via `--allow-tools` (Phase D of the
  permission policy governance plan).

- **Version compatibility** — `GET /v1/runtime/version` checked at startup for
  server/client contract alignment.

## Allowed dependencies

The Go TUI is a standalone Go module (`github.com/sutang-vain/babel-o/clients/go-tui`)
with no TypeScript import dependency on the Nexus source tree. Its dependencies
are Go libraries for terminal rendering:

- **Bubble Tea v2** (`charm.land/bubbletea/v2`) — application framework, event
  loop, rendering.
- **Lip Gloss v2** (`charm.land/lipgloss/v2`) — style definitions.
- **Bubbles v2** (`charm.land/bubbles/v2`) — reusable widget components
  (spinner, textarea, viewport).
- **Gorilla WebSocket** (`github.com/gorilla/websocket`) — WebSocket transport
  to Nexus `/v1/stream`.
- **Ultraviolet** (`github.com/charmbracelet/ultraviolet`) — syntax highlighting
  for transcript code blocks.

The TypeScript `deps:audit` layer-direction gates do not apply to Go code. The
architectural boundary is behavioural: the Go TUI must not own runtime truth.
It must not scrape SQLite, parse provider or tool internals, or duplicate runtime
logic inside the client. All runtime-owned state (sessions, events, tools,
providers, permissions, storage, agent orchestration) is accessed exclusively
through Nexus API endpoints.

## Extension points

- **Add a new overlay** — create a file in `internal/tui/` following the existing
  overlay pattern (e.g. `overlay_activity.go`, `overlay_tools.go`) and wire it
  into the model's update/view cycle.

- **Add a local slash command** — extend the command router in `internal/tui/tui.go`;
  keep it stateless and read-only from the TUI perspective (write commands go
  through Nexus API calls).

- **Improve transcript rendering** — the render pipeline
  (`renderTranscript` / `formatLine` / `renderInlineMarkdown`) lives in
  `internal/tui/tui.go`. Any rendering improvement must not change event
  semantics.

- **Add a Nexus API consumer** — create a helper in `internal/tui/api.go`
  following the `nexusJSON` / `nexusRawJSON` pattern. Keep timeouts bounded
  (default 10 s) and errors surfaced through the existing friendly-error
  pipeline.

- **Extend the permission panel** — the panel lives in
  `internal/tui/permission_dialog.go` and `internal/tui/permission.go`.
  Permission policy itself remains runtime-owned.

## Related governance

- [Go client & distribution governance index](../../nexus/reference/go-client-distribution-governance-index.md) —
  reader entry point for Go TUI, `bbl loop`, Go Runner, and distribution governance.
- [Distribution strategy plan](../../nexus/reference/distribution-strategy-plan.md) —
  release-channel strategy, portable packages, future Go launcher.
- [Go TUI session observability governance plan](../../nexus/proposals/go-tui-session-observability-governance-plan.md) —
  session inspectability, embedded Nexus persistence, session-id mapping.
- [Go TUI markdown rendering optimization plan](../../nexus/proposals/go-tui-markdown-rendering-optimization-plan.md) —
  transcript markdown and code-block rendering roadmap.
- [Go TUI history ledger](../../nexus/history/go-tui-history.md) —
  closed implementation context, permission panel evolution, regression records.
