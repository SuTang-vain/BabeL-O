# BabeL-O Go TUI

This is the production TUI client for BabeL-O Nexus. It connects to Nexus via
the public WebSocket/HTTP APIs and renders a Bubble Tea shell with a transcript,
status header, multi-line input, permission panel, layered event output, session
operations, and read-only overlays for inbox, agents, tasks, activity, tools
audit, models, and context.

The `bbl go` wrapper can auto-start a local Nexus service when the target
localhost URL is not healthy. The Go binary itself remains a client only:
Nexus owns runtime, context, tools, permissions, storage, and session state.

## Scope

- Connect to `GET /v1/stream`.
- Submit one prompt from the bottom input line.
- Render assistant, thinking, tool, permission, usage, result and error events
  with stable labels.
- Merge streaming assistant/thinking deltas into the current transcript line.
- Handle `permission_request` with approve/reject keyboard actions and a visible
  permission panel.
- Fetch shared runtime config through Nexus HTTP APIs.
- Background `?since=<version>` polling on `/v1/runtime/config` (default
  30000ms; configure with `--poll-interval-ms=0` to disable).
- Switch active config profiles through `POST /v1/runtime/config/select`.
- Surface structured Nexus error codes (tombstoned_profile,
  unknown_profile, not_supported, missing_profile) as human hints
  rather than raw `{error: ...}` payloads.
- Render profile tombstones in `/profile` output with stable
  lexicographic ordering and a `[tombstoned] deletedAt=<ts>` marker.
- Keep all provider, context, tool, permission and session ownership in Nexus.

## Source Layout

- `cmd/go-tui/`: executable entrypoint, flag parsing, environment handoff and
  process exit handling.
- `internal/tui/`: Bubble Tea model, event rendering, overlays, Nexus client
  helpers and white-box tests for the internal state machine.
- `bin/`: local build output from `make dev` / `make build`; ignored by git.
- Root files (`go.mod`, `go.sum`, `Makefile`, `README.md`) keep module,
  dependency and build metadata outside the runtime package.

## Run

Run the client through the BabeL-O CLI:

```bash
cd /Users/tangyaoyue/DEV/BABEL/BabeL-O
npm run cli -- go --url http://127.0.0.1:3000 --cwd /Users/tangyaoyue/DEV/BABEL/BabeL-O
```

The `bbl go` entry prefers a prebuilt `clients/go-tui/bin/go-tui` binary when it
is present and falls back to `go run ./cmd/go-tui` from this directory. Before launching the
TUI it probes `GET /health`; if the target URL is local and unhealthy, it starts
a managed Nexus child process, waits for health, then shuts that child down when
the Go TUI exits.

Useful wrapper options:

```bash
# Connect only; do not auto-start Nexus:
npm run cli -- go --no-start-nexus --url http://127.0.0.1:3000

# Forward Go TUI config polling:
npm run cli -- go --poll-interval-ms 0

# Tool allowlist for an auto-started local Nexus. Defaults to env
# NEXUS_ALLOWED_TOOLS, or "*" when unset. Permission prompts still apply.
npm run cli -- go --allowed-tools Read,Grep,Glob,Bash
```

You can still start Nexus yourself and let `bbl go` reuse it:

```bash
cd /Users/tangyaoyue/DEV/BABEL/BabeL-O
NEXUS_ALLOWED_TOOLS='*' npm run start
```

You can also run the client directly:

```bash
cd /Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui
go run ./cmd/go-tui --url http://127.0.0.1:3000 --cwd /Users/tangyaoyue/DEV/BABEL/BabeL-O
# Disable background /v1/runtime/config polling:
go run ./cmd/go-tui --url http://127.0.0.1:3000 --cwd /Users/tangyaoyue/DEV/BABEL/BabeL-O --poll-interval-ms=0
# Faster polling for live config sync demos:
go run ./cmd/go-tui --url http://127.0.0.1:3000 --cwd /Users/tangyaoyue/DEV/BABEL/BabeL-O --poll-interval-ms=2000
```

Keys:

- `enter`: submit the current input.
- `/`: open the fuzzy slash-command palette; continue typing to filter.
- `?`: open the local help overlay when the input is empty.
- `ctrl+c`: open the quit confirmation dialog (`y` / `enter` quits, `n` / `esc` cancels).
- `ctrl+o` / `ctrl+t` / `ctrl+g`: open tools, tasks, and agents directly.
- `ctrl+q`: direct quit through the `/quit` shortcut.
- `q`: quit when idle and the input is empty.
- `a` / `y`: approve a pending permission request.
- `r` / `n`: reject a pending permission request.

UI features:

- Right-side transcript scrollbar with compact layout behavior for small terminals.
- Underlined button hotkeys in footer and dialog hints.
- RenderContext-backed help, permission, model-pick, and quit dialogs.
- Fuzzy slash-command filtering with highlighted matched command names.
- Stable-prefix streaming markdown rendering for assistant/thinking output.
- Mouse drag selection with item-local highlight rendering and OSC 52 copy feedback when `--mouse` is enabled.

Local commands:

- `/config`: refresh shared Nexus runtime config and profile state
  (also re-arms the next background poll).
- `/profile` or `/profiles`: list shared Nexus profiles (active marker
  `*` and a dedicated `tombstones (N):` block with `deletedAt` per entry).
- `/profile <name>`: select an existing profile through Nexus. A
  tombstoned profile returns a friendly hint pointing at
  `bbl config profile restore <name>`; unknown profiles get a similar
  pointer at `bbl config profile add` and `bbl config profile use`.

Tombstone UX:

- A profile that has been `bbl config profile delete`d stays visible in
  the `/profile` listing with `[tombstoned] deletedAt=<ts>` and is
  refused by `/profile <name>` (HTTP 400 `tombstoned_profile`); the Go
  TUI translates that into "profile is tombstoned; restore via
  `bbl config profile restore <name>`" instead of a raw JSON error.
- Restoration itself stays CLI-only (per the rewrite plan): the Go
  TUI never writes to the local BabelOConfig file.

These commands are handled by the Go TUI client itself and are not submitted as
agent prompts. The Go TUI does not read BabeL-O config files directly.
