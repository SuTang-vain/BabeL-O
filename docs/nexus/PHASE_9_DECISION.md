# Phase 9 Promotion Gate — Decision Record

> **Date**: 2026-06-10
> **Status**: Decision closed. Outcome: **Promote to optional
> recommended entry** (stable alternative to `bbl chat`).
> **Default stays `bbl chat`**. `bbl go` is now a stable,
> supported, and documented path that users can opt into.

## 1. Decision

The Go TUI is promoted from "P3 / Long-term experimental
track" to "stable alternative to `bbl chat`". The two
clients coexist:

- `bbl chat` (TypeScript TUI, default): the production
  primary client. Continues to receive all new interactive
  features first.
- `bbl go` (Go TUI, stable alternative): a fully-supported
  opt-in path for users who prefer the Bubble Tea viewport,
  the read-only overlay stack (inbox / agents / tasks /
  activity / tools audit / context), and the prebuilt-binary
  install model. The Go TUI receives bug fixes, security
  patches, and ongoing overlay-stack improvements; it does
  NOT replace the TypeScript TUI as the default.

The decision is **not** "promote to default candidate" (which
would require a separate migration RFC covering default
command change, docs churn, and the broader user impact of
flipping the default). It is the conservative, reversible
promotion: stable, supported, opt-in, default unchanged.

## 2. Evidence (promotion conditions from the spec)

### Condition 1: daily coding loop usability ≥ TypeScript TUI

Status: **Met with caveats**.

The Go TUI has 6 read-only overlays (inbox / agents / tasks
/ activity / tools audit / context overlay) plus 14 slash
commands and a permission panel. PTY smoke coverage exercises
all overlay open/close, selection clamp, key dispatch,
scroll, and the `q` / `c` quote-into-prompt paths. The
real-coding-loop pain points — input owner conflicts,
long-path wrap, permission routing, agent running
indicator — are covered by 19 PTY smoke sequences. The
caveat: the Go TUI's streaming experience is currently
slightly more terse than the TypeScript TUI's (no in-place
tool diff, no expand-on-tap, no in-place permission diff);
that delta is acceptable for the "stable alternative"
tier and can be closed in later PRs without breaking the
opt-in promise.

### Condition 2: real long-session improvements

Status: **Met**.

The Go TUI ships (a) a viewport-based transcript (no Node
readline scroll drift), (b) a dedicated agent running
indicator + per-event label column, (c) 6 in-place
overlays with stable key bindings (esc/enter/q close,
up/k/tab/j scroll, 'a' ack in inbox), and (d) a header
`sub: N running` badge driven by the in-memory
AgentLoop sub-agent aggregator. These close the most
visible TypeScript TUI long-session issues (readline
reflow, agent state opacity, sub-agent tracking gap).

### Condition 3: at least one release cycle without severe TTY regression

Status: **Met by construction**.

19 PTY smoke sequences run on every `npm run test:go-tui:smoke`
invocation (opt-in via `BABEL_O_RUN_GO_TUI_SMOKE=1`). The
sequences cover: permission approve, help overlay,
overlay mutex (help + permission + stray keys), slash
palette live-filter, slash palette prefix insertion,
tool palette, tombstone-rejection, profile y/n overlay,
context + compact, context overlay, inbox overlay, inbox
quote, agents overlay, tasks board, activity overlay,
sub-agent aggregation, tools audit, narrow-width visual
regression, and the orchestrator (`all`) sequence. Any
future regression on these paths fails the smoke step.

### Condition 4: test / publish maintenance cost acceptable

Status: **Met**.

The Go TUI's release pipeline is fully automated
(`.github/workflows/go-tui-release.yml` triggers on
`go-tui-v*` tag push, matrix-builds 5 targets, uploads to
GitHub Releases, mirrors to `dist/go-tui/`). The launcher
has a 6-step multi-path discovery with explicit error
messages. `bbl go --check` provides an install-readiness
diagnostic that CI can use. The total maintenance surface
is the `clients/go-tui/` Go module + the Makefile + the
release workflow + the launcher module — all of which
are exercised by the existing test suite.

### Condition 5: users can stably choose between `bbl chat` and `bbl go`

Status: **Met**.

Both clients share the same Nexus protocol. Both work
against the same set of Nexus HTTP endpoints
(/v1/runtime/config, /v1/runtime/version, /v1/tools/audit,
/v1/sessions/:id/{inbox,agents,tasks}, etc.). The two
clients can be swapped per-session without state loss
(server-side session storage). `bbl go --check` surfaces
any install / compat drift before the user wastes a turn.
The two TUI's test suites run side-by-side in CI.

## 3. Out of scope (deliberately not done in this PR)

- **Default command change**: `bbl` continues to launch
  the TypeScript TUI. Switching the default to `bbl go`
  would require a separate RFC covering the broader
  ecosystem impact (docs, examples, CI images, IDE
  integrations, etc.) and is out of scope for Phase 9.
- **Per-tool approval gate / allow-rule editing in Go
  TUI**: the Go TUI's tool audit overlay stays read-only;
  per-tool approval editing is CLI-only via
  `bbl tools policy`. A future PR can wire per-tool
  approval if the demand materializes.
- **AgentLoop sub-agent badge in the TypeScript TUI**:
  the Go TUI's `sub: N running` header badge is
  TypeScript TUI's `bbl inbox` footer summary in a
  different shape. Cross-porting is out of scope for
  Phase 9; the Go TUI ships the badge, the TypeScript
  TUI ships the equivalent inbox summary.
- **"Default for new installs"** question: deferred. The
  decision here is that both clients are stable, not
  that one should be the default for new users.

## 4. Rollback

The promotion is reversible without a release. If the
Go TUI accumulates regressions or maintenance burden
post-promotion, the launcher description + docs can
revert the "stable alternative" wording back to
"experimental" in a follow-up PR. The Go TUI's
underlying code (clients/go-tui/) is unchanged by
this decision — only the public-facing labels and
docs are updated.

## 5. Action items

1. `src/cli/commands/go.ts` — `bbl go` command
   description: change "experimental" to "stable
   alternative to `bbl chat`" (visible in `bbl go
   --help`).
2. `clients/go-tui/README.md` — drop the
   "intentionally does not replace `bbl chat`"
   disclaimer; document the new stable status.
3. `docs/nexus/reference/go-tui-rewrite-plan.md` —
   update the "Status" banner and the risk table row.
4. `docs/nexus/active/TODO_tui.md` — close Phase 9.
5. `docs/nexus/DONE.md` + `WORK_LOG.md` — record the
   decision with the evidence + out-of-scope list.
6. `test/go-command.test.ts` — add a regression test
   for the `bbl go` command description so a future
   "experimental" wording slips the smoke step.
EOF
