# Go Runner

> Module reference · stable public contract · see linked governance docs for deep architecture

[简体中文](go-runner.zh-CN.md)

## Role

Go Runner is an optional `RemoteToolRunner` execution backend implemented in Go. It
executes already-approved tool calls on behalf of TypeScript Nexus — it does **not**
replace the Nexus execution host, context manager, permission policy, agent scheduler,
provider loop, or CLI. The runner is gated behind environment flags and is entirely
absent from the default user path.

The division of authority is:

- **TypeScript Nexus** decides which tool is allowed, which session owns the call,
  which permissions apply, and how results are stored and replayed.
- **Go Runner** safely executes what Nexus has already approved: process spawning,
  timeout/cancel, output budget enforcement, path-safety defense-in-depth, and
  structured result metrics.

## Public contract

- **Protocol version** `2026-06-04.babel-o.remote-runner.v1` — every execute request
  carries a mandatory protocol version; mismatched requests are rejected with a
  structured `REMOTE_RUNNER_PROTOCOL_MISMATCH` error.
- **`GET /v1/remote-runner/capabilities`** — returns the runner identity, the set of
  enabled tools, read-only status, and server-owned limits (concurrency, output bytes,
  deadlines). Bash and Write/Edit capabilities are absent unless explicitly enabled.
- **`POST /v1/remote-runner/execute`** — accepts a tool name, tool input (JSON),
  session / request / tool-use identity, `cwd`, `allowedPaths`, and execution bounds.
  Returns a structured `RunnerResult` with metric metadata (duration, truncation,
  exit code, signal, cancellation / timeout flags).
- **`POST /v1/remote-runner/cancel`** — best-effort, idempotent cancellation keyed by
  `sessionId:requestId:toolUseId`. Kills the process group for active Bash requests.
- **Tool surface** — the runner exposes `ListDir`, `Glob`, `Grep`, `Read` by default.
  `Bash` is enabled via `GO_RUNNER_ENABLE_BASH=1`; `Write` and `Edit` via
  `GO_RUNNER_ENABLE_WRITE=1`. Every tool execution is validated against the
  capability set before processing.
- **Safety defaults** — binds to `127.0.0.1:3897`; refuses non-loopback binding
  without `GO_RUNNER_ALLOW_NON_LOCAL_BIND=1`; enforces server-side hard caps
  on concurrency (max 16), output bytes (max 1,000,000), and deadline (max 600,000 ms).
- **Nexus-side gating** — the TypeScript `HttpRemoteToolRunner` connects via
  `NEXUS_REMOTE_RUNNER_URL` when configured. `NEXUS_REMOTE_RUNNER_REQUIRED=0`
  (default) makes the runner optional; `NEXUS_REMOTE_RUNNER_REQUIRED=1` fails
  fast if the runner is unreachable or capability-incompatible.

## Allowed dependencies

Go Runner is a standalone Go module (`github.com/babel-o/go-runner`, Go 1.22)
with zero external runtime dependencies. The TypeScript `deps:audit` layer-direction
gates do not apply — the boundary is architectural, not build-tool-enforced:

- Go Runner depends on the Nexus `RemoteToolRunner` protocol contract (HTTP/JSON
  request schema, response shape, error codes, protocol version).
- Go Runner must **not** import TypeScript runtime packages, call LLM providers,
  read or write Nexus storage, or assemble session context.
- The Nexus side must **not** delegate execution authority, permission decisions,
  session ownership, or storage truth to the Go Runner.
- Environment variables with provider credentials (`BABEL_O_PROVIDER_*`) are
  filtered out of the Bash execution environment by an explicit allowlist
  (`PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL` only).

## Extension points

- **Add a new tool** — implement the tool function in `internal/tools/`, register it in
  the `Execute` dispatch switch and the `SupportedTools` / `IsSupportedTool` helpers,
  then add handler-level tests in `internal/runner/server_test.go`.
- **Add an HTTP route** — add a handler method on `Server` and register it in the
  `Handler()` mux in `internal/runner/server.go`.
- **Change safety limits** — adjust the `ServerOptions` defaults or the hard caps
  (`hardMaxConcurrentTools`, `hardMaxOutputBytes`, `hardMaxDeadlineMs`) in
  `internal/runner/server.go`. The corresponding env-var bindings live in
  `cmd/go-runner/main.go`.
- **Wire a new execution environment** — the protocol already carries `cwd`,
  `allowedPaths`, `maxOutputBytes`, `BashMaxBufferBytes`, and `deadlineMs`. Extend the
  `ExecuteRequest` struct in `internal/protocol/types.go` for new fields.

## Related governance

- [Go client and distribution governance index](../../nexus/reference/go-client-distribution-governance-index.md) — ownership map and governance rules distinguishing Go TUI, Go Runner, and distribution.
- [Go Runner plan](../../nexus/proposals/go-runner-plan.md) — architectural position, phased rollout (read-only tools, restricted Bash, worktree Write/Edit), security model.
- [Distribution strategy plan](../../nexus/reference/distribution-strategy-plan.md) — release-channel strategy and the long-term Go launcher direction.
- [Tool governance plan](../../nexus/reference/tool-governance-plan.md) — canonical tool-classification and evidence-semantics reference (Go Runner executes approved tool types; Tool Governance owns which tools exist and what class they belong to).
- [Runtime tool-loop governance](../../nexus/reference/runtime-tool-loop-governance-plan.md) — tool-loop continuity and bounded final checks in the Nexus runtime layer that dispatches to the remote runner.
