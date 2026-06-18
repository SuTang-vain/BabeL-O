# BabeL-O Go Runner Plan

> State: Partially Landed
> Date: 2026-06-04
> Scope: Go-based remote tool runner / execution worker for BabeL-O.
> Status: Phase B read-only tools, safety defaults, Phase C restricted Bash, and Phase D worktree-aware Write/Edit backend implemented.
> Relationship: This complements `context-and-subagent-upgrade-plan.md`. It does not replace the TypeScript Nexus runtime, Context Manager, AgentScheduler, provider loop, or CLI.
> Governance: Indexed by [go-client-distribution-governance-index.md](../reference/go-client-distribution-governance-index.md). This document owns optional approved-tool execution mechanics, not Go TUI or runtime orchestration.

## 1. Executive Summary

BabeL-O should not be rewritten in Go. The TypeScript runtime remains the correct owner of context assembly, provider integration, model-visible tools, permission policy, session events, AgentScheduler, and CLI/TUI interaction.

Go is most valuable as an execution substrate:

- remote tool runner
- process manager
- sandbox worker
- timeout/cancel handler
- stdout/stderr budget enforcer
- optional worktree execution backend
- future multi-agent execution worker

The recommended integration point is after the first AgentScheduler semantics are stable:

```text
Phase 0: Agent core types             -> no Go in main path
Phase 1: Explore Agent MVP            -> no Go in main path
Phase 2: ContextForker                -> define protocol requirements
Phase 3: Agent API/CLI + persistent jobs -> introduce Go RemoteRunner as optional backend
Phase 4: Review/Test Agent            -> expand Go Bash/process control
Phase 5: Implement Agent + worktree   -> use Go for sandbox/worktree execution
```

The key rule is:

```text
TypeScript decides what to do.
Go safely executes what TypeScript has already approved.
```

## 2. Architectural Position

### 2.1 Current BabeL-O ownership

BabeL-O TypeScript should continue to own:

- Nexus API server
- session lifecycle
- event storage
- context assembly
- compact/recovery
- provider registry
- model/tool loop
- permission policy
- tool risk classification
- AgentScheduler
- AgentJob state
- CLI/TUI interaction
- audit logging

### 2.2 Go Runner ownership

Go Runner should own only execution mechanics:

- HTTP/JSON runner protocol
- tool execute/cancel endpoints
- process spawning
- process group cancellation
- command timeout
- stdout/stderr capture
- output truncation
- cwd enforcement
- allowed-path enforcement defense-in-depth
- environment filtering
- execution metrics
- optional sandbox backend

### 2.3 Boundary diagram

```text
BabeL-O TypeScript Nexus
  ├─ LLMCodingRuntime
  ├─ RuntimeToolLoop
  ├─ Permission / hooks / audit
  ├─ ToolExecutor
  │   └─ RemoteToolRunner HTTP client
  │       └─ Go Runner
  │           ├─ ListDir/Glob/Grep/Read/Bash execution
  │           ├─ timeout/cancel/process group kill
  │           ├─ output budget
  │           └─ sandbox/path enforcement
  └─ Event storage remains in Nexus
```

The Go Runner must not:

- call LLM providers
- assemble context
- create or own sessions
- decide permissions
- write permission audit
- schedule child agents
- perform model fallback
- silently execute unapproved tools

## 3. Relationship to Existing Remote Runner Protocol

BabeL-O already has a `RemoteToolRunner` protocol concept. Go Runner should implement that protocol instead of introducing a competing agent or tool transport.

Existing logical endpoints:

```text
GET  /v1/remote-runner/capabilities
POST /v1/remote-runner/execute
POST /v1/remote-runner/cancel
```

Go Runner should be a compatible implementation of this API.

### 3.1 Protocol versioning

The TypeScript protocol currently uses a protocol version constant. Go Runner should treat protocol version as mandatory.

Request with unsupported version should return:

```json
{
  "kind": "error",
  "code": "REMOTE_RUNNER_PROTOCOL_MISMATCH",
  "message": "Unsupported remote runner protocol version."
}
```

### 3.2 Capability endpoint

Current default response shape:

```json
{
  "protocolVersion": "2026-06-04.babel-o.remote-runner.v1",
  "id": "go-remote-runner",
  "capabilities": {
    "tools": ["ListDir", "Glob", "Grep", "Read"],
    "readOnly": true,
    "bashEnabled": false,
    "writeEnabled": false,
    "maxConcurrentTools": 4,
    "maxOutputBytes": 200000,
    "defaultDeadlineMs": 120000,
    "maxDeadlineMs": 600000
  }
}
```

With `GO_RUNNER_ENABLE_BASH=1`, capabilities include `Bash`, `readOnly` becomes false, and `bashEnabled` becomes true.

Capabilities should remain conservative:

```text
Phase A: Noop only
Phase B: ListDir, Glob, Grep, Read
Phase C: restricted Bash
Phase D: Write/Edit only if implement-agent isolation is ready
```

## 4. Recommended Repository Layout

Preferred location inside BabeL-O:

```text
runners/go-runner/
  go.mod
  go.sum
  cmd/go-runner/main.go
  internal/protocol/types.go
  internal/protocol/http.go
  internal/runner/server.go
  internal/runner/registry.go
  internal/tools/readonly.go
  internal/tools/bash.go
  internal/tools/writable.go
  internal/process/manager.go
  internal/process/output.go
  internal/process/cancel.go
  internal/safety/paths.go
  internal/safety/env.go
  internal/safety/commands.go
  internal/metrics/metrics.go
  internal/testutil/fixtures.go
```

Alternative standalone repo:

```text
babel-o-go-runner/
```

Recommendation: start inside `runners/go-runner/` so protocol and integration tests can evolve with BabeL-O.

## 5. Go Runner Phases

## Phase A: Protocol Compatibility Spike

Current status: implemented in `runners/go-runner/`.

### Goal

Implement a minimal Go HTTP server compatible with the BabeL-O remote runner protocol.

### Scope

- `GET /v1/remote-runner/capabilities`
- `POST /v1/remote-runner/execute`
- `POST /v1/remote-runner/cancel`
- protocol version validation
- request id tracking
- basic cancellation map
- structured result/error response

### Tools

Current Phase A implements `Noop` only. `ListDir` / `Glob` / `Grep` / `Read` begin in Phase B.

### Acceptance criteria

- BabeL-O `HttpRemoteToolRunner` can query capabilities.
- BabeL-O can dispatch a simple tool request.
- Unsupported protocol version returns structured error.
- Unknown tool returns structured unsupported-tool error.
- Cancel request for active request is accepted.

### Non-goals

- No Bash yet.
- No Write/Edit.
- No sandbox.
- No agent scheduling.
- No provider loop.

## Phase B: ListDir/Glob/Grep/Read Execution

Current status: implemented in `runners/go-runner/internal/tools/`.

### Goal

Support read-only Explore Agent execution.

### Tools

```text
ListDir
Glob
Grep
Read
```

### Read behavior

Implemented behavior:

- resolves path relative to `cwd`
- enforces `allowedPaths`
- rejects workspace escape and symlink escape
- supports offset/limit and auto/preview/full modes
- enforces max output bytes
- returns shaped string output compatible with BabeL-O expectations

### Grep behavior

Implemented behavior:

- pure Go file walking + regexp matching
- enforces path boundary
- truncates large match sets
- skips dependency/build directories by default
- supports context cancel/timeout during scans

### Glob behavior

Implemented behavior:

- uses Go `filepath.WalkDir` plus glob matcher
- enforces cwd/allowed path boundary
- returns stable sorted paths
- limits result count
- skips dependency/build directories by default
- avoids following symlinks outside workspace

### Acceptance criteria

- `HttpRemoteToolRunner` can execute ListDir/Glob/Grep/Read against Go Runner.
- Cancellation/timeout interrupts read-only execution.
- Large output is truncated consistently.
- Workspace escape and symlink escape are rejected.
- Results map to existing BabeL-O `tool_completed` behavior through TypeScript Nexus.
- Explore Agent remote wiring remains a later Nexus configuration/integration step.

## Safety Defaults: Implemented

Current Go Runner defaults are intentionally conservative:

- binds to `127.0.0.1` by default
- refuses non-loopback `GO_RUNNER_HOST` unless `GO_RUNNER_ALLOW_NON_LOCAL_BIND=1`
- exposes read-only capabilities diagnostics
- keeps Bash, Write, and Edit disabled
- enforces server-owned max concurrent tools, max output bytes, default deadline, and max deadline
- returns `REMOTE_RUNNER_CAPACITY_EXCEEDED` with HTTP 429 when the concurrency gate is exhausted
- does not accept provider keys or arbitrary env forwarding in the protocol

## Phase C: Restricted Bash

Current status: implemented behind explicit `GO_RUNNER_ENABLE_BASH=1`.

### Goal

Support Review/Test Agent use cases while keeping command approval, risk classification, hooks, and audit in TypeScript Nexus.

### Bash use cases

Allowed examples after TypeScript Nexus approval:

```text
npm test
npm run typecheck
npm run lint
git status --short
git diff
git log --oneline -n 20
```

Go Runner does not decide whether a command is allowed. That decision belongs to Nexus. Go Runner applies execution-layer defense in depth after approval.

### Implemented process management

- starts `/bin/sh -c <command>` with the specified cwd
- sets a Unix process group
- kills the process group on cancel/timeout
- captures stdout/stderr separately
- enforces stdout/stderr byte budgets
- returns exit code
- returns signal if killed
- returns elapsed time
- supports server-clamped deadlines

### Bash response shape

The response should preserve structured details for TypeScript error normalization:

```json
{
  "kind": "result",
  "success": false,
  "output": {
    "exitCode": 1,
    "stdout": "...",
    "stderr": "...",
    "durationMs": 1234
  },
  "truncated": true,
  "originalBytes": 450000
}
```

### Acceptance criteria

Implemented and covered by Go tests / gated TypeScript smoke:

- timeout maps to `REQUEST_TIMEOUT`
- cancel maps to `REQUEST_CANCELLED`
- process group is killed, not only the shell parent
- output is truncated without unbounded memory use
- stderr/stdout are preserved independently
- provider API keys are not forwarded through the Bash environment

## Future: Metrics and Observability

### Goal

Expose execution metrics to help Nexus diagnose remote execution behavior.

### Metrics to return per execution

```text
durationMs
stdoutBytes
stderrBytes
truncated
originalBytes
exitCode
signal
cancelled
timedOut
toolName
cwd
```

### Optional endpoint

```text
GET /v1/remote-runner/status
```

Response:

```json
{
  "id": "go-remote-runner",
  "protocolVersion": "2026-06-04.babel-o.remote-runner.v1",
  "uptimeMs": 123456,
  "activeRequests": 2,
  "completedRequests": 120,
  "cancelledRequests": 3,
  "timedOutRequests": 1
}
```

This endpoint is optional and should not replace the required capabilities endpoint.

## Phase D: Worktree-aware Write/Edit Execution

Current status: implemented behind explicit `GO_RUNNER_ENABLE_WRITE=1` and Nexus `executionEnvironment: remote` wiring.

### Goal

Support implement/worktree execution without moving worktree authority into Go Runner.

### Implemented behavior

- Go Runner can receive `cwd` pointing at a Nexus-created worktree.
- Nexus narrows isolated task `allowedPaths` to the worktree path before executor/critic steps run.
- `RuntimeAgentStep` preserves remote runner, execution environment, cwd, and allowed paths through structured-output repair retries.
- `bbl optimize --execution-environment remote` can opt into remote tool execution while defaulting to local execution.
- Go Runner exposes `Write` / `Edit` only when `GO_RUNNER_ENABLE_WRITE=1` is set.
- `Write` creates parent directories inside allowed roots and rejects traversal or symlink-parent escape.
- `Edit` requires a unique `oldString`, rejects missing/duplicate matches as recoverable tool failures, and uses the same writable path boundary checks.

### Acceptance criteria

Implemented and covered by Go tests, TypeScript focused regressions, and gated Go smoke:

- Go Runner works with BabeL-O worktree-style `cwd` / `allowedPaths` isolation.
- Child/isolated agent steps do not receive the parent workspace as an allowed write root.
- Write/Edit remain disabled by default and are absent from default capabilities.
- `GO_RUNNER_ENABLE_WRITE=1` exposes Write/Edit capabilities and HTTP execution paths.
- Workspace escape, symlink file escape, and symlink parent escape are rejected.

### Non-goals

- Go Runner does not create, merge, reject, preserve, or delete worktrees.
- Go Runner does not decide write permissions, risk classification, hooks, audit, review, or merge policy.
- Go Runner does not compute provider context, call providers, schedule agents, or own sessions.
- Write/Edit result payloads remain minimal; changed-file summaries continue to belong to Nexus/worktree review flow.

## 6. Protocol Types

### 6.1 Execute request

Go type sketch:

```go
type ExecuteRequest struct {
    ProtocolVersion   string          `json:"protocolVersion"`
    SessionID         string          `json:"sessionId"`
    RequestID         string          `json:"requestId,omitempty"`
    ToolUseID         string          `json:"toolUseId,omitempty"`
    ToolName          string          `json:"toolName"`
    ToolInput         json.RawMessage `json:"toolInput"`
    Cwd               string          `json:"cwd"`
    AllowedPaths      []string        `json:"allowedPaths,omitempty"`
    MaxOutputBytes    int64           `json:"maxOutputBytes"`
    BashMaxBufferBytes int64          `json:"bashMaxBufferBytes"`
    DeadlineMs        int64           `json:"deadlineMs,omitempty"`
}
```

### 6.2 Cancel request

```go
type CancelRequest struct {
    SessionID string `json:"sessionId"`
    RequestID string `json:"requestId,omitempty"`
    ToolUseID string `json:"toolUseId,omitempty"`
}
```

### 6.3 Result

```go
type RunnerResult struct {
    Kind          string      `json:"kind"`
    Success       bool        `json:"success,omitempty"`
    Output        any         `json:"output,omitempty"`
    Truncated     bool        `json:"truncated,omitempty"`
    OriginalBytes int64       `json:"originalBytes,omitempty"`
    Code          string      `json:"code,omitempty"`
    Message       string      `json:"message,omitempty"`
    Details       any         `json:"details,omitempty"`
}
```

Use `kind: "result"` for successful protocol execution, even when the tool command itself returns a non-zero exit code. Use `kind: "error"` for protocol/runner failures.

## 7. Request Identity and Cancellation

### 7.1 Request key

The TypeScript side keys cancellation by:

```text
sessionId:requestId:toolUseId
```

Go Runner should use the same identity rule.

### 7.2 Active request registry

```go
type ActiveRequest struct {
    Key       string
    Cancel    context.CancelFunc
    StartedAt time.Time
    ToolName  string
}
```

Use a mutex-protected map:

```go
map[string]*ActiveRequest
```

### 7.3 Cancellation behavior

On cancel:

- find active request
- call cancel func
- kill process group if Bash process exists
- return `{ "ok": true }` even if request is already completed

Cancel should be best-effort and idempotent.

## 8. Path Safety

### 8.1 Required checks

For every path-based tool:

1. resolve against `cwd`
2. clean path
3. evaluate symlinks where appropriate
4. verify resolved path is inside one of `allowedPaths` or inside `cwd` if allowedPaths is empty
5. reject traversal escape
6. reject invalid absolute path if outside boundary

### 8.2 Error shape

Use structured runner error for path boundary failures:

```json
{
  "kind": "error",
  "code": "WORKSPACE_PATH_DENIED",
  "message": "Requested path is outside the allowed workspace.",
  "details": {
    "requestedPath": "../secret.txt",
    "cwd": "/repo",
    "resolvedPath": "/secret.txt"
  }
}
```

TypeScript Nexus may further normalize this into existing workspace path error output.

### 8.3 Symlink policy

Default:

- do not follow symlinks outside allowed roots
- treat symlink escape as denied
- return clear error details

## 9. Environment Safety

### 9.1 Environment input

The current protocol does not need to send full env by default. Go Runner should start with a minimal inherited environment or explicit allowlist.

Recommended default allowlist:

```text
PATH
HOME only if required
SHELL only if required
TMPDIR
LANG
LC_ALL
```

Avoid forwarding provider API keys to runner unless a future tool explicitly needs them. Normal tool execution should not need LLM credentials.

### 9.2 Future env extension

If needed later:

```json
{
  "env": {
    "FOO": "bar"
  },
  "envPolicy": "replace" | "merge-allowlist"
}
```

Do not add this before a real need appears.

## 10. Bash Execution Design

### 10.1 Process group

On Unix-like systems:

- start command in a new process group
- cancel kills the whole group
- timeout kills the whole group

On Windows, use a job object or equivalent later. Initial macOS/Linux support is acceptable if documented.

### 10.2 Shell selection

Initial implementation:

```text
/bin/sh -c <command>
```

Future options:

- explicit shell from request
- shell allowlist
- no-shell exec mode for structured commands

Recommendation: keep shell behavior aligned with existing TypeScript Bash tool contract.

### 10.3 Output capture

Use streaming readers with byte budgets. Do not call `CombinedOutput()` for long commands because it can buffer unbounded output.

Track:

```text
stdout bytes captured
stdout original bytes
stderr bytes captured
stderr original bytes
truncated flag
```

### 10.4 Timeout

If `deadlineMs` is present, compute context deadline from it. Also enforce a local max timeout config.

Config:

```text
GO_RUNNER_MAX_TOOL_TIMEOUT_MS=600000
GO_RUNNER_DEFAULT_TOOL_TIMEOUT_MS=120000
```

## 11. Configuration

### 11.1 Go Runner environment variables

```text
GO_RUNNER_HOST=127.0.0.1
GO_RUNNER_PORT=3897
GO_RUNNER_ID=go-remote-runner
GO_RUNNER_ENABLE_BASH=0
GO_RUNNER_ENABLE_WRITE=0
GO_RUNNER_MAX_CONCURRENT_TOOLS=4
GO_RUNNER_MAX_OUTPUT_BYTES=200000
GO_RUNNER_BASH_MAX_BUFFER_BYTES=1000000
GO_RUNNER_DEFAULT_DEADLINE_MS=120000
GO_RUNNER_MAX_DEADLINE_MS=600000
GO_RUNNER_ALLOW_NON_LOCAL_BIND=0
```

Defaults are safe:

- host: `127.0.0.1`
- non-loopback host requires `GO_RUNNER_ALLOW_NON_LOCAL_BIND=1`
- Bash disabled
- Write/Edit disabled
- concurrency capped at 16 even if env requests more
- output capped at 1,000,000 bytes even if env requests more
- deadline capped at 600,000 ms even if env requests more

### 11.2 BabeL-O Nexus configuration

Current TypeScript-side env:

```text
NEXUS_REMOTE_RUNNER_URL=http://127.0.0.1:3897
NEXUS_REMOTE_RUNNER_REQUIRED=0
```

Current behavior:

- unset URL keeps Go Runner disabled and local TypeScript tools available
- configured URL queries `/v1/remote-runner/capabilities` before use
- protocol mismatch or capabilities failure is surfaced in `GET /v1/runtime/status`
- `NEXUS_REMOTE_RUNNER_REQUIRED=1` fails fast when URL/capabilities/protocol validation fails
- status redacts credentials/query values from the configured URL
- service mode and embedded mode both use the same config path

## 12. Security Model

### 12.1 Authority split

TypeScript Nexus is authoritative for:

- user permission
- tool policy
- risk classification
- hook decisions
- audit log
- session lifecycle
- allowed tools
- allowed paths passed to runner

Go Runner is authoritative only for:

- local process cancellation
- local path enforcement defense-in-depth
- output budget enforcement
- resource cleanup

### 12.2 Defense-in-depth checks

Even though Nexus approves the request, Go Runner should still reject:

- path escape
- unsupported tool
- invalid protocol version
- malformed input
- disabled Bash
- disabled Write/Edit
- missing cwd
- cwd outside configured allowed roots if roots are configured

### 12.3 Secrets

Go Runner should not receive provider API keys. If environment forwarding is added later, it must be explicit allowlist-based.

### 12.4 Network exposure

Default bind address must be local only:

```text
127.0.0.1
```

If exposing beyond localhost, require an authentication mechanism. Do not add unauthenticated remote network execution.

Future auth options:

- static bearer token
- Unix socket filesystem permissions
- mTLS for remote machines

## 13. Integration with AgentScheduler

### 13.1 Explore Agent

First integration target:

```text
AgentSpawn(explore)
  -> TypeScript child runtime
  -> allowed tools: ListDir/Glob/Grep/Read
  -> executionEnvironment: remote
  -> Go Runner executes read-only tools
  -> AgentResult returned to parent
```

### 13.2 Review/Test Agent

Second target:

```text
AgentSpawn(review/test)
  -> restricted Bash approved by Nexus
  -> Go Runner manages process group / timeout / output
  -> structured testsRun / findings result
```

### 13.3 Implement Agent

Later target:

```text
AgentSpawn(implement)
  -> worktree isolation
  -> Go Runner executes inside worktree
  -> changed files summarized
  -> parent reviews merge
```

Do not let Go Runner directly merge worktree changes.

## 14. Testing Plan

### 14.1 Go unit tests

Current tests cover:

```text
request key construction
structured error result shape
capabilities response
ListDir/Glob/Grep/Read execute
Write/Edit execute when explicitly enabled
protocol version validation
unsupported tool error
path safety
symlink escape and symlink-parent write escape
output truncation
context cancel/timeout
restricted Bash timeout/cancel/process group behavior
```

### 14.2 Go integration tests

Current Phase A/B handler tests start the Go HTTP server and cover:

```text
GET /v1/remote-runner/capabilities
POST /v1/remote-runner/execute Read
POST /v1/remote-runner/execute Grep
POST /v1/remote-runner/execute Glob
protocol mismatch
unsupported tool
workspace escape
symlink escape
output truncation
```

Future phases should add:

```text
POST /v1/remote-runner/execute Bash timeout
POST /v1/remote-runner/cancel against active Bash/process work
```

### 14.3 BabeL-O TypeScript integration tests

Add tests in BabeL-O after Go runner is stable:

```text
test/remote-runner-go-smoke.test.ts
test/agent-scheduler-go-runner.test.ts
```

These should be optional unless Go is available in CI.

Use an env gate:

```text
BABEL_O_RUN_GO_RUNNER_SMOKE=1
```

### 14.4 CI strategy

Initial:

- Go runner tests run only in Go runner subtree.
- BabeL-O default `npm test` does not require Go binary.

Later:

- CI matrix includes Go runner build/test.
- Optional integration smoke starts Go runner binary.

## 15. Packaging Plan

### 15.1 Development

Run manually:

```bash
go run ./runners/go-runner/cmd/go-runner
```

Nexus:

```bash
NEXUS_REMOTE_RUNNER_URL=http://127.0.0.1:3897 npm run start
```

### 15.2 Build

```bash
go build -o dist/bin/babel-o-go-runner ./runners/go-runner/cmd/go-runner
```

### 15.3 Distribution

Options:

1. ship optional prebuilt binaries
2. build from source in development only
3. publish as separate release artifact
4. use npm optional package per platform later

Recommended first step: build-from-source only, no npm packaging complexity.

## 16. Observability

### 16.1 Logs

Use structured JSON logs or simple line logs with:

```text
timestamp
level
requestKey
toolName
durationMs
success
errorCode
```

Avoid logging full tool input if it may contain sensitive paths or command contents. Prefer redacted summaries.

### 16.2 Metrics returned to Nexus

Go Runner should include details in result where useful, but TypeScript Nexus remains the source of runtime metrics.

### 16.3 Debug mode

Config:

```text
GO_RUNNER_DEBUG=1
```

Debug should still avoid leaking secrets.

## 17. Failure Modes

### 17.1 Runner unavailable

TypeScript behavior:

- if remote runner optional: fall back to local execution when allowed
- if required: fail fast with clear startup/runtime error

### 17.2 Runner crash during tool execution

TypeScript should map to:

```text
REMOTE_RUNNER_ERROR
```

The session should remain recoverable.

### 17.3 Cancel lost race

Cancel after completion should return ok. TypeScript should not treat missing active request as fatal.

### 17.4 Output overrun

Go Runner must not allocate unbounded memory. It should capture up to configured max, count original bytes, and return truncated result.

### 17.5 Path denied

Return structured error with requested/resolved/cwd details.

## 18. Milestones

### Milestone 1: Go protocol server

Status: delivered in Phase A.

Delivered:

- server starts
- capabilities endpoint
- Noop execute endpoint
- cancel endpoint skeleton with active request registry
- protocol tests
- gated TypeScript compatibility smoke

### Milestone 2: Read-only tools

Status: delivered in Phase B.

Delivered:

- Read
- Grep
- Glob
- path safety
- output budget
- cancellation/timeout for read-only work
- Go unit and handler tests

### Milestone 3: TypeScript compatibility smoke

Status: delivered for Phase A/B gated smoke; AgentScheduler remote wiring remains future work.

Delivered:

- BabeL-O can use Go Runner through `HttpRemoteToolRunner` for ListDir/Glob/Grep/Read
- optional smoke test gated by `BABEL_O_RUN_GO_RUNNER_SMOKE=1`
- docs for local setup

### Milestone 4: Restricted Bash

Deliver:

- Bash process manager
- timeout
- cancel
- stdout/stderr budgets
- exit code/signal details

### Milestone 5: AgentScheduler integration

Deliver:

- Explore Agent can use Go Runner
- AgentWait receives structured result
- cancellation works through parent job

### Milestone 6: Worktree execution

Deliver:

- execution inside child worktree
- path enforcement
- process cleanup
- implement-agent readiness review

## 19. First Implementation Checklist

- [x] Create `runners/go-runner/go.mod`.
- [x] Add `cmd/go-runner/main.go`.
- [x] Add protocol structs.
- [x] Add capabilities handler.
- [x] Add execute handler with protocol validation.
- [x] Add cancel handler with active request registry.
- [x] Implement request key helper.
- [x] Implement path safety helper for Phase B path-based tools.
- [x] Implement `Read` in Phase B.
- [x] Implement `Grep` in Phase B.
- [x] Implement `Glob` in Phase B.
- [x] Implement output truncation helper in Phase B/C.
- [x] Add Go tests for protocol/capabilities/Noop/cancel.
- [x] Add Go tests for ListDir/Glob/Grep/Read/path safety/truncation/cancel-timeout.
- [x] Add doc snippet for local run.
- [x] Add optional BabeL-O smoke gated by env.

## 20. Recommended Initial Defaults

Current Phase B defaults:

```text
Capabilities: ListDir, Glob, Grep, Read
Bind: 127.0.0.1:3897
Bash: disabled
Write/Edit: disabled
Auth: none for localhost-only local runner; required before non-localhost binding
Max output bytes: 200KB default unless Nexus request sets a lower budget
```

Recommended Phase C defaults:

```text
Capabilities: ListDir, Glob, Grep, Read, restricted Bash when explicitly enabled
Max concurrent tools: 4
Default timeout: 120s
Max timeout: 600s
Max output bytes: 200KB
Bash max buffer: 1MB
```

## 21. Final Recommendation

Introduce Go Runner as an optional execution backend, not as a rewrite of BabeL-O.

Best path:

1. Build a Go protocol compatibility spike now if desired.
2. Keep it out of the default path until explicit Nexus remote-runner configuration is enabled.
3. Use it first for read-only ListDir/Glob/Grep/Read execution.
4. Wire Explore Agent remote execution only after Nexus configuration/fallback behavior is stable.
5. Expand it to restricted Bash for Review/Test agents.
6. Use it for worktree/sandbox execution only when Implement Agent safety is ready.

The strategic role of Go is to make BabeL-O execution safer, more cancellable, more portable, and easier to package as a daemon. The strategic role of TypeScript remains the agent brain, context system, provider loop, permission policy, and user-facing orchestration.

## 中文概述

### 背景

Go Runner 的价值是作为更稳的执行底座，处理进程、sandbox、timeout、cancel、stdout/stderr budget 和 worktree-aware 文件操作。

### 边界

TypeScript Nexus 仍决定做什么、是否允许、属于哪个 session、如何持久化结果。Go 只执行已经批准的工具请求。

### 当前状态

Phase B/C/D 已部分落地，因此本文作为 Partially Landed 参考保留。是否提升为默认执行后端，需要继续用真实 smoke、权限、安全和回归测试证明。
