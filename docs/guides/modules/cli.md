# CLI

> Module reference · stable public contract · see linked governance docs for deep architecture

[简体中文](cli.zh-CN.md)

## Role

The `cli` module (`src/cli/`) owns all `bbl <command>` entries registered on the
Commander framework. It is the user-facing TypeScript interaction layer. Under
the project's first design rule — "Nexus owns execution, CLI owns interaction"
— the CLI is limited to command dispatch, argument parsing, output formatting,
and launching the production Go TUI binary (`bbl go`). Every execution path
delegates to Nexus (via `NexusClient` or embedded composition) or to the Go
TUI binary; the CLI never owns a provider loop, a runtime harness, or a
session truth.

The TypeScript chat TUI (`bbl chat`) was removed in v0.3.7. `bbl go` is the
sole production interactive entry point; the Go TUI binary is discovered via
a multi-path strategy and spawned as a child process. `bbl run` remains the
one-shot non-interactive fallback.

## Public contract

- **`bbl run <prompt>`** — one-shot coding prompt through Nexus (embedded
  composition or remote URL).
- **`bbl go`** — launch the Go TUI binary. Wrapper only: resolves the binary
  path (prebuilt / source / environment override), auto-starts a managed Nexus
  if needed, creates or reuses a session, and spawns the child process.
- **`bbl loop`** — launch the multi-pane bbl-loop driver (Go binary wrapper,
  same discovery strategy as `bbl go`).
- **`bbl nexus start|status`** — manage the local Nexus daemon process.
- **`bbl sessions list|tree|show|events|inbox|ack|children`** — inspect
  persisted Nexus sessions over HTTP.
- **`bbl config import-babel-x|add|list|use|profile...`** — manage provider
  credentials, active profile, default model, and BabeL-X import.
- **`bbl models list|inspect`** — read model capability matrices from the
  provider registry.
- **`bbl agents spawn|list|show`** — manage Nexus agent jobs (Explore agent,
  etc.) over HTTP.
- **`bbl tools audit`** — list registered tools and current allow policy.
- **`bbl optimize`** — run self-optimizing agents against a target file or
  directory.
- **`bbl memory status|setup|opt-out|external|reset|auto`** — manage MemoryOS
  local long-term memory bootstrap lifecycle.
- **`bbl doctor`** — self-check runtime health (provider, keychain, memory, ports).
- **`bbl context working-set|working-set-edit|history|resume|assemble`** —
  inspect context state (working set, behavior trace, resume preview) offline.
- **`bbl inspect-session <id>`** — diagnostic deep-dive into a single session
  (SQLite + client log triage).
- **`bbl __server`** (hidden) — start a Nexus service as a daemon subprocess.
- **`NexusClient`** — HTTP client for Nexus REST + WebSocket APIs (shared
  across commands that operate remotely).
- **`runSessionFlow`** / **`embedded.ts`** — embedded Nexus composition path
  for `bbl run` (imports Nexus directly, bypasses the HTTP server).

## Allowed dependencies

The CLI sits at the top of the project's layer stack. It may import `nexus`,
`runtime`, `providers`, `tools`, and `shared` through an explicit allowlist
enforced by `scripts/audit-layer-direction.js` and the checked-in
`scripts/layer-direction-allowlist.json`. The reverse — any layer importing
`src/cli/` — is **forbidden**.

Derived rules (from the layer-direction audit):

- `nexus` → `cli` — **forbidden** (Nexus must not depend on any interaction
  layer).
- `runtime` → `cli` — **forbidden** (the runtime engine must not depend on the
  interaction layer).
- `cli` → `{nexus,runtime,providers,tools,storage}` — permitted only through
  allowlisted file paths, each with a documented justification.

See
[Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md)
and
[Module coupling governance](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md)
for the full allowlist and coupling heat map.

## Extension points

- **Add a new `bbl <command>`** — create a `registerXxxCommand` function in
  `src/cli/commands/xxx.ts` and import it in `program.ts`. Keep the command
  body thin: delegate execution to Nexus (via `NexusClient`), to the embedded
  composition path (`runSessionFlow`), or to a spawned binary.
- **Change command registration** — `src/cli/program.ts` is the single
  composition root. Command files are independently testable and should not
  share mutable CLI state.
- **Interact with Nexus remotely** — `NexusClient` wraps the REST + WebSocket
  surface. New endpoints should be added as methods on `NexusClient` and
  consumed by command handlers.
- **Diagnostic commands** — `bbl doctor` and `bbl inspect-session` demonstrate
  the pattern for offline health checks that read storage or logs directly
  without a running Nexus.

## Related governance

- [Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md) —
  direction-aware dependency gates, CLI-specific allowlist entries.
- [Module coupling governance](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md) —
  coupling heat map, embedded composition path, CLI singleton inventory.
- [Go client & distribution index](../../nexus/reference/go-client-distribution-governance-index.md) —
  `bbl go` as the production TUI wrapper, Go TUI ownership boundaries.
- [Distribution strategy](../../nexus/reference/distribution-strategy-plan.md) —
  portable package channels, `bbl go --check` install verification.
- [Development process stability](../../nexus/reference/development-process-stability-governance-plan.md) —
  PR review levels for CLI and dependency-boundary changes.
