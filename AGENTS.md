# BabeL-O — Agent Guide

Nexus-first generalized AI agent runtime. CLI (`bbl`) talks to a headless Fastify
daemon (`Nexus`) over REST + WebSocket. Runtimes are pluggable (`LocalCodingRuntime`
for deterministic, `LLMCodingRuntime` for any LLM adapter). Go TUI client is the
production interface; TypeScript TUI is the developer playground.

> **Design rules:**
> 1. *Nexus owns execution. CLI owns interaction.* Never leak runtime concerns
>    into the CLI module — the dependency-boundary audit (`npm run deps:audit`)
>    will fail the build.
> 2. *Runtime owns task scope, tool risk, and evidence validation.* The runtime
>    is the only place that may classify a tool as a scope-boundary crossing
>    (`src/runtime/taskScope.ts`); clients and CLIs may only render the event.
> 3. *Long-term memory is volatile context, never a fact source.* EverCore writes
>    are permission-gated; auto-search is cue-driven; failures are non-fatal and
>    never replace SQLite / compact / session memory / working set.

---

## 1. Essential Commands

| Task | Command |
| --- | --- |
| Install deps (locked) | `npm ci` |
| Run source CLI in dev | `npm run cli -- chat dev` |
| Start embedded Nexus daemon | `npm run start` |
| Build TS → `dist/` | `npm run build` |
| Build standalone SEA binary | `npm run build:binary` |
| Build + smoke test | `npm run build:smoke` |
| Run full test suite | `npm test` |
| Typecheck only | `npm run typecheck` |
| Format check (no auto-fix) | `npm run format:check` |
| Lint = typecheck + format + deps audit | `npm run lint` |
| Coverage report | `npm run coverage` |
| Performance benchmark | `npm run benchmark` |
| Provider smoke (offline dry run) | `npm run test:providers:smoke` |
| MCP official smoke | `npm run test:mcp:official` |
| Memory provider tests | `NODE_ENV=test tsx --test test/memory-provider.test.ts` |
| Go runner tests | `cd runners/go-runner && go test ./...` |
| Go TUI tests | `cd clients/go-tui && go test ./...` |
| Go TUI build (dev) | `cd clients/go-tui && make dev` |
| Go TUI build (release) | `cd clients/go-tui && make build` |
| Install latest release binary | `curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh \| bash` |
| Install specific version | `... \| BBL_VERSION=vX.Y.Z bash` |

**Runtime requirements:** Node.js >= 22 (ESM + native `node:sqlite`), Go 1.23
for the TUI/runner. Docker is optional for sandboxed shell execution.

**Test isolation:** the canonical `npm test` script forces
`BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json` and `NODE_ENV=test`. Do not
rely on the user's real `~/.babel-o/config.json` from any test.

---

## 2. Architecture

```
┌──────────────────┐   HTTP / WS    ┌────────────────────────┐
│ CLI  src/cli/    │ ─────────────► │ Nexus  src/nexus/      │
│  - program.ts    │                │  - server.ts (Fastify) │
│  - renderEvents  │                │  - app.ts (routes)     │
│  - NexusClient   │                │  - createRuntime.ts    │
│  - embedded.ts   │                │  - agentLoop.ts        │
│  - commands/*    │                │  - agents/* (spawn)    │
└──────────────────┘                │  - storageBridge.ts    │
                                    └───────────┬────────────┘
                                                │ uses
            ┌───────────────────────────────────┴────────────────────────────┐
            ▼                                                                    ▼
   ┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐ ┌──────────────┐
   │ Runtime Layer      │   │ Core Services      │   │ LLM Adapters       │ │ Storage      │
   │  src/runtime/      │   │  - tools/builtin   │   │  src/providers/    │ │ SqliteStorage│
   │  - LLMCoding       │   │  - mcp/* (stdio)   │   │  Anthropic/OpenAI/ │ │ MemoryStorage│
   │  - LocalCoding     │   │  - skills/ (md)    │   │  Local adapters    │ └──────────────┘
   │  - taskScope.ts    │   │  - hooks.ts        │   │  registry.ts       │
   │  - contextMgr      │   │  - everCoreMcpTools│   │                    │
   │  - compactors/     │   └────────────────────┘   └────────────────────┘
   │  - providerRecovery│
   └────────────────────┘
```

**Data flow** for a single user turn:

1. `src/cli/program.ts` parses `bbl <cmd>` (Commander). Each command lives in
   `src/cli/commands/*.ts` and is registered via `registerXCommand(program)`.
2. `chat` / `run` calls `runSessionFlow(prompt, cwd, url, rl, abortCtrl)`
   (`src/cli/runSessionFlow.ts`) which either hits a remote Nexus via
   `NexusClient` or spawns an in-process `EmbeddedNexusClient`
   (`src/cli/embedded.ts`).
3. `createDefaultNexusRuntime` (`src/nexus/createRuntime.ts`) wires the tool
   registry, optional MCP servers, optional EverCore sidecar, agent scheduler,
   storage (defaults to `~/.babel-o/db.sqlite`, falls back to memory under
   `NODE_ENV === 'test'`), and a `LocalCodingRuntime` or `LLMCodingRuntime`
   depending on `settings.providerId`.
4. `LLMCodingRuntime` (`src/runtime/LLMCodingRuntime.ts`) yields a
   `task_scope_declared` event **before** the first LLM call so the provider
   sees the current task root. Each tool call then runs through
   `executeProviderToolCall` (`src/runtime/runtimeToolLoop.ts`) which:
   - extracts tool target paths / roots,
   - classifies any scope-boundary crossing via `classifyToolScopeBoundary()`,
   - runs the scope-boundary permission flow *before* the normal
     `write` / `execute` permission gate,
   - dispatches the tool, persists `permission_audit`, and yields
     `scope_boundary_confirmed` on approval.
5. The runtime streams `NexusEvent`s (`src/shared/events.ts` — Zod schemas
   versioned as `2026-05-21.babel-o.v1`).
6. CLI renders events via `src/cli/renderEvents.ts` (Chalk, no React/Ink).

**Tool risk model:** `read < write < execute < task`. Tools declare static
`risk`; `Bash` overrides per-input via `riskForInput` (read-only subcommands
downgrade to `read`) **and** `bashClassifier.ts` further auto-allows
read-only subcommands under the standard policy. `permissionMode: 'strict'`
hard-denies non-allowlisted tools; `'soft-deny'` lets them reach
`permission_request` so the Go TUI can prompt the user (Phase B of
`docs/nexus/reference/go-tui-permission-policy-governance-plan.md`).

**Task scope model:** every turn emits a `task_scope_declared` event whose
`primaryRoot` is the cwd (or the user-confirmed primary). Tool calls whose
target path resolves outside
`primaryRoot | explicitRoots | confirmedExternalRoots` are flagged
`scope_boundary_detected` and routed through a scope-aware permission request
that carries `scopeRisk` / `targetRoot` / `taskPrimaryRoot` / `scopeReason`.
Approved external roots are remembered for the lifetime of the turn
(`scope_boundary_confirmed` → `confirmedExternalRoots` re-derive). The
classifier and bash tokenizer live in `src/runtime/taskScope.ts`; no client
or CLI is allowed to re-derive scope.

---

## 3. Directory Map

```
src/
├── nexus/                  Fastify daemon, agent loop, sub-agents, scheduler
│   ├── server.ts           Entry: validates env, builds app, calls listen()
│   ├── app.ts              createNexusApp: registers REST + WS routes
│   ├── createRuntime.ts    Wires tools + storage + runtime + scheduler
│   ├── agentLoop.ts        Streaming agent loop, tool scheduling, hooks
│   ├── agentLoopSubAgents.ts / Worktree.ts / Benchmark.ts / Smoke.ts / Roles.ts
│   ├── runtimeAgentStep.ts Per-step LLM call / tool dispatch
│   ├── agents/             Sub-agent system (AgentScheduler, AgentTools, etc.)
│   ├── storageBridge.ts    SQLite + WAL JSONL append log
│   ├── sessionLifecycle.ts / sessionAssets.ts / taskSession.ts / taskQueue.ts
│   ├── worktree.ts         Worktree-isolated sub-agent execution
│   └── everCoreConfig.ts   Optional EverCore sidecar integration
├── runtime/                LLMCodingRuntime, LocalCodingRuntime, governance
│   ├── LLMCodingRuntime.ts        Main streaming runtime (yields task_scope_declared)
│   ├── LocalCodingRuntime.ts      Deterministic runtime for replay / tests
│   ├── runtimeToolLoop.ts         Per-tool dispatch + scope boundary permission flow
│   ├── runtimePipeline.ts         Provider call / message shaping primitives
│   ├── taskScope.ts               **Task scope derivation + tool scope boundary classifier**
│   ├── systemPromptBuilder.ts     System prompt assembly (extractAbsolutePaths)
│   ├── contextAssembler.ts        Builds the prompt payload each turn (memory capability block)
│   ├── contextManager.ts / contextAnalysis.ts / contextNarrationDiagnostics.ts
│   ├── compact.ts + compactPostRestore.ts + compactSummary.ts
│   ├── compactors/                Token-budget-driven history compaction strategies
│   ├── cacheAwareCompactPolicy.ts / prefixCache.ts
│   ├── memoryProvider.ts          MemoryProvider + shouldAutoSearchMemory() heuristic
│   ├── memoryCandidateGovernance.ts / sessionMemoryLite.ts
│   ├── workingSet.ts / toolResultBudget.ts / safetyCheck.ts
│   ├── providerRecovery.ts        Fallback chain across providers
│   ├── runtimeDiagnostics.ts / agentMdLoader.ts / perRequestPolicy.ts
│   ├── classifier.ts              Tool risk classification
│   ├── tokenEstimator.ts          Token budget estimation
│   ├── toolExecutor.ts            Safe tool dispatch (timeout, recoverable failures)
│   ├── sessionSummary.ts          Session-end summarization
│   └── hooks.ts                   UserPromptSubmit / PreToolUse / ... event bus
├── cli/
│   ├── program.ts          Commander bootstrap (registers all commands)
│   ├── NexusClient.ts      HTTP + WS client to remote Nexus
│   ├── embedded.ts         In-process NexusClient (no network)
│   ├── renderEvents.ts     Streams NexusEvent → terminal output
│   ├── runSessionFlow.ts   Shared between `bbl run` and `bbl chat`
│   ├── contextView.ts      `/context` formatter
│   ├── commands/           chat, run, nexus, sessions, tools, config, agents,
│   │                       models, optimize, go, inspectSession, help
│   ├── inboxOverlay.ts     /inbox SessionChannel UI
│   ├── channelSend.ts      /channel send preview-then-confirm flow
│   └── collaborateOverlay.ts /collaborate unified hub
├── tools/
│   ├── Tool.ts              Tool interface
│   ├── registry.ts          Tool registry
│   ├── output.ts            Tool output shaping
│   ├── everCoreMcpTools.ts  memory_search / memory_save_note / memory_flush_session
│   └── builtin/             read, write, edit, bash (with classifier), glob,
│                            grep, listDir, list_dir, task, pathDrift, pathSafety
├── providers/              adapters/ (Anthropic, OpenAI, Local, sse util),
│                           registry.ts (providerRegistry + modelRegistry)
├── mcp/                    JSON-RPC stdio MCP client + adapter → tool registry
├── skills/                 Built-in `.md` skill files (frontmatter-driven)
│   └── built-in/           coding, debugging, git, optimization, testing
├── storage/                Storage interface, MemoryStorage, SqliteStorage
│                           (uses Node 22+ native `node:sqlite`)
├── shared/                 Cross-cutting: events, config, session, sessionChannel,
│                           toolTrace, agentJob, errors, id, logger, version,
│                           task, bashDiscoveryGuidance
└── types/                  Ambient TS declarations

clients/go-tui/             Go TUI client (Bubble Tea). Production release target.
runners/go-runner/          Optional Go tool runner (remote bash/file tools).
scripts/                    Build, install, audit, benchmark, smoke scripts.
test/                       80+ test files, all using `tsx --test`.
```

**Configuration precedence** (per the storage-path comments in
`src/nexus/createRuntime.ts`):
1. Explicit CLI arg / function arg
2. `BABEL_O_CONFIG_DIR` env
3. `BABEL_O_CONFIG_FILE` env
4. `~/.babel-o/config.json` (default)

---

## 4. Task Scope & Evidence Governance (P0 guardrail)

Real session `session_ef76f50a-…` exposed an evidence-scope drift: the user
asked for the state of `BabeL-O` / `babel-o memory`, the agent then read
sibling repos `BabeL-2` / `BabeL-X` and used that as report evidence. Path
safety alone was not enough — the reads were read-only and the paths existed.

The fix landed as `src/runtime/taskScope.ts` + three new events
(`task_scope_declared` / `scope_boundary_detected` / `scope_boundary_confirmed`)
and lives entirely inside the runtime. See
`docs/nexus/reference/task-scope-and-evidence-scope-governance-plan.md` for the
phase-by-phase plan; Phase 0–3 foundation is landed as of 2026-06-13.

### 4.1 `task_scope_declared` (per turn)
Emitted by `LLMCodingRuntime` immediately after the intake event and before the
first LLM call. Derived from:
- `cwd` (and its git root, when available)
- explicit path tokens in the user prompt
- `confirmedExternalRoots` carried over from prior `scope_boundary_confirmed`
  events in the same turn
- session metadata / user-confirmed primary

Fields: `primaryRoot`, `explicitRoots`, `confirmedExternalRoots`,
`inferredCandidateRoots`, `mode: 'single_root' | 'multi_root' | 'cross_project'`,
`source: 'cwd' | 'prompt_paths' | 'user_confirmation' | 'session_metadata'`.

`mapEventsToMessages()` translates it into a `user` message that names the
primary root and any confirmed externals so the provider sees the current
task scope.

### 4.2 `scope_boundary_detected` (per tool call)
Emitted by `executeProviderToolCall` *before* the normal `write`/`execute`
permission gate. The classifier (`classifyToolScopeBoundary` in
`src/runtime/taskScope.ts`) handles:
- `Read` / `Grep` / `Glob` / `ListDir` / `list_dir` via fixed schema keys
  (`path`, `pattern`).
- `Bash` via `extractBashTargetPaths()` which tokenizes and recognizes
  `cd <path>`, `git -C <path>`, `find`, `ls`, `cat`, `head`, `tail`,
  `rg`, `grep`.

`boundaryKind` is one of
`parent_scan | sibling_repo | external_absolute_path |
historical_session_path | memory_hit_path | global_cache_path`. The default
`action` for sibling repos / parent scans is `require_confirmation`; the
default for known-in-scope paths is `warn` (logged but not gated).

### 4.3 `scope_boundary_confirmed` (per approval)
Emitted when the user (or a policy hook) approves a scope-boundary permission
request. The `confirmationScope` is derived from the permission `decision.scope`
(`'session'` or `'rule'` → session-scoped, otherwise `once`).
`LLMCodingRuntime` re-derives the task scope on every `scope_boundary_confirmed`,
folding the new `targetRoot` into `confirmedExternalRoots` so the **same
external root** does not re-trigger the gate within the same turn.

### 4.4 Scope-aware permission request
When a boundary is detected, `runtimeToolLoop.ts` runs
`requestScopeBoundaryPermission()` which:
1. yields `scope_boundary_detected`,
2. registers a `PendingPermission`,
3. yields a `permission_request` enriched with `scopeRisk` / `targetRoot` /
   `taskPrimaryRoot` / `scopeReason`,
4. runs `PermissionRequest` hooks (so Go TUI's policy engine sees the request),
5. resolves the decision (hook or pending),
6. persists `permission_audit`,
7. yields `permission_response`,
8. on approval yields `scope_boundary_confirmed`.

On denial the tool returns `recoverableDeniedToolResult` and emits
`tool_denied { denialKind: 'permission', recoverable: true }`.

### 4.5 Cross-project explicit prompts
The classifier deliberately **does not** false-positive on prompts that
explicitly ask for cross-project comparison (`对比 / 比较 / 集成 / 迁移 / 借鉴 /
审计 / cross-project / compare / integrate / migrate / audit`). Such prompts
promote the scope to `mode: 'cross_project'` and only warn on path candidates;
they do not require per-tool confirmation. Without explicit confirmation the
agent stays in `single_root` / `multi_root` and gates external reads.

### 4.6 Regressions
- `test/runtime-llm.test.ts` — mock provider self-trigger for `memory_search`
  and `memory_save_note` (also covers scope-boundary tooling path).
- `test/runtime.test.ts` — new turn integration including
  `task_scope_declared` ordering and `scope_boundary_confirmed` re-derive.
- `test/mcp.test.ts` — `EverCore` scope-related paths.
- `test/memory-provider.test.ts` — auto-search cue + skip diagnostics.

---

## 5. Memory Capability Awareness (EverCore Phase G)

Phase A–F have already shipped (REST spike, internal MemoryProvider, context
budget diagnostics, optional MCP tools, embedded / managed EverCore sidecar,
provider-protocol convergence with `EVEROS_LLM__PROTOCOL` auto-bridge). Phase
G is the self-trigger layer; **G1–G5 are landed**, only G6 (live save/recall
validation) remains.

The plan lives in
`docs/nexus/reference/memory-capability-awareness-and-trigger-plan.md`. The
core principle: long-term memory is **volatile context**, not a fact source —
it can never replace SQLite, compact, session memory, or working set.

### 5.1 Provider-visible capability block
`contextAssembler.ts` injects a non-cacheable `Long-Term Memory Capability`
block when `MemoryProvider.enabled === true`. The block tells the model:
- when to use `memory_search` (explicit recall prompts, preference / habit /
  cross-session cues),
- that memory results are background hints only,
- that project facts must be re-verified against workspace evidence,
- that `memory_save_note` is only allowed when the user explicitly asks to
  remember or a governance candidate was approved.

`AssembledContext` / `ContextAnalysisDiagnostics` expose
`memoryCapabilityAvailable` / `longTermMemoryCapabilityAvailable` so
`/context` / API diagnostics can show capability presence.

### 5.2 MCP tool descriptions
`src/tools/everCoreMcpTools.ts` (Phase D) registers
`mcp:evercore:memory_search` (read-only, self-triggered),
`mcp:evercore:memory_save_note` (write risk, permission-gated), and
`mcp:evercore:memory_flush_session` (runtime lifecycle owned). The Phase G
update added trigger policies to the descriptions: search is for explicit
recall, save requires user ask or candidate approval, flush is runtime-owned
and not user-callable.

### 5.3 Review-only memory candidate governance
SessionChannel `memory_candidate` messages now carry review-only governance
metadata (`scope`, `evidence refs`, `confidence`, `staleness/supersession`,
`approval requirement`, blocked / review reasons, `autoWrite=false`). They
show up in the inbox as review-only state and never auto-write.

### 5.4 Runtime auto-search policy (`shouldAutoSearchMemory`)
`src/runtime/memoryProvider.ts` exposes a lightweight heuristic that decides
**before** calling the EverCore client:

| Decision | Reason | Effect |
| --- | --- | --- |
| `aborted` | input signal aborted | skip, log diagnostics |
| `empty_prompt` | trimmed prompt empty | skip, log diagnostics |
| `permission_response` | starts with `approve / deny / yes / no / allow / reject / 同意 / 拒绝 / 批准 / 不批准` | skip |
| `current_workspace_only` | contains `read / open / inspect / edit / write / file / path / workspace` or `读取 / 打开 / 查看 / 修改 / 文件 / 路径 / 当前项目 / 当前代码` | skip |
| `execution_status_only` | contains `test / tests / lint / build / typecheck / format / git status / status / run` or `测试 / 构建 / 编译 / 状态 / 验证` | skip |
| `explicit_memory_cue` | contains `do you remember / remember / prior / previous / last time / my preference / preference / habit / cross-session` or `记得 / 还记得 / 记住过 / 之前 / 上次 / 偏好 / 习惯 / 历史` | **search** |
| `no_memory_cue` | (default) | skip, log diagnostics |

**Default is no search**; only explicit recall / preference / history cues
trigger it. `MemoryProviderDiagnostics` adds `autoSearch: { triggered,
reason, cue? }` and `bbl /context` / the context view render
`auto-search=triggered | skipped:<reason>`.

### 5.5 Mock provider regression
`test/runtime-llm.test.ts` proves the provider loop can self-trigger
`memory_search` and `memory_save_note` using a mock Anthropic SSE helper.
Save emits a `permission_request` before the write; the regression covers the
denied path returning `tool_denied` with no `addAgentMessages` call.

### 5.6 Remaining work
Phase G6 = live save / recall validation against a real EverCore sidecar using
the managed-mode MiniMax Anthropic-compatible adapter. No auto-write of
long-term memory will be enabled until G6 lands.

---

## 6. Go TUI — Production Client Highlights

`clients/go-tui/` (Bubble Tea) is the production release target; TS TUI is
the developer playground. Layout:
- `cmd/go-tui/` — executable entry only
- `internal/tui/` — TUI package + white-box state-machine tests
- `bin/` — local build artifacts (not committed)

### 6.1 Running-state interrupt + queued next prompt
Landed 2026-06-13. While `m.running` is true:

- **Plain `Enter`** while the input has content: stashes the prompt as
  `queuedPrompt` and clears the input. No concurrent second stream is
  started; the queued prompt auto-starts as soon as the current
  `result` / `error` / cancel completion lands.
- **First `Esc` while running**: does *not* error or exit. Opens the
  interruption prompt: a yellow permission-style transcript line
  `What should BabeL-O do instead?` and the input is pre-filled with
  `BabeL-O should `. `m.interruptionPromptActive` becomes true.
  - **`Enter` after editing**: queues the edited text as the next prompt
    *and* cancels the current run.
  - **Second `Esc`**: cancels the current run with no replacement
    instruction.
- **Cancel path**: `cancelStream()` calls Nexus
  `POST /v1/sessions/:sessionId/cancel` first; if that fails it falls back
  to closing the local WebSocket so the UI never wedges. Cancel-induced
  read errors are soft-handled as `current agent run cancelled`.
- **Footer states** (`chrome.go`): hints switch among
  `waiting for Nexus events` → `What should BabeL-O do instead? Enter
  interrupts · Esc cancels` → `interrupt requested — waiting for Nexus to
  stop` → `next prompt queued after current run` → `permission decision
  required` (priority order, scope wins over generic running).
- **New transcript lines** (`transcript.go`):
  - `task_scope_declared` → `scope   ` (muted)
  - `scope_boundary_detected` → `scope ! ` (status)
  - `scope_boundary_confirmed` → `scope ok` (status)

The Go TUI does **not** re-derive task scope itself — it only renders the
events emitted by the runtime (Design rule 2 in the preamble).

### 6.2 Scope-boundary permission dialog
`pendingPermission` carries `scopeRisk` / `targetRoot` / `taskPrimaryRoot` /
`scopeReason` alongside the existing `risk` / `message` / `suggestedRule`
fields. `permissionDialog.View()` and `permissionEditorDialog.View()` render
a `Scope: <risk> outside current task` block plus
`Target:` / `Current:` / `Scope reason:` rows when `scopeRisk` is set. This
applies to MCP tools too — `permission_request.source` is preserved.

### 6.3 Layout / chrome
The `tui.go` split is settled: 10+ files inside `internal/tui/` (api,
stream, chrome, transcript, text, selection, events, context, slash,
permission, overlay_*) with `tui.go` carrying only the model root and
`Update` main state machine. Selection highlight uses
`ultraviolet.ScreenBuffer` cell-level reverse and keeps the last selection
~300ms after release so copy remains visually consistent.

---

## 7. Permissions, Hooks, and Tool Risk

The `pendingPermission` resolver is process-local (`PendingPermissionRegistry`).
A durable backend is deferred until resumable execution is a real requirement.

`src/runtime/hooks.ts` provides the minimal `UserPromptSubmit` / `PreToolUse` /
`PostToolUse` / `PermissionRequest` / `Stop` event bus. The Go TUI's
`PermissionRequest` hook and the TS-side `permissionResponse` flow are the
canonical way for clients to gate risky tools; `permission_audit` is
persisted for every decision via `storage.savePermissionAudit()`.

`bashClassifier.ts` is a pure-function classifier (30+ dangerous patterns)
that auto-allows read-only subcommands under the standard policy, and
`taskScope.ts` adds the scope-boundary classifier on top.

---

## 8. Tests, Coverage, and Build

**Test isolation:** `npm test` forces
`BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json` and `NODE_ENV=test`. Do
not rely on the user's real `~/.babel-o/config.json` from any test. Targeted
runs follow the same pattern with a per-suite config path, e.g.
`NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-g5-runtime-llm.json
npx tsx --test …`.

**Test entry points** (selected):
- `test/runtime-llm.test.ts` — mock Anthropic SSE helper, memory capability
  self-trigger, scope-boundary tooling.
- `test/runtime.test.ts` — new-turn integration, `task_scope_declared`
  ordering, `scope_boundary_confirmed` re-derive.
- `test/memory-provider.test.ts` — `shouldAutoSearchMemory` heuristic.
- `test/mcp.test.ts` — EverCore MCP tool scope paths.
- `test/tui-renderer.test.ts` — `task_scope_declared` /
  `scope_boundary_detected` / `scope_boundary_confirmed` rendering.
- `test/context-assembler.test.ts` — `MemoryProvider | Memory Capability |
  long-term memory` patterns.
- `test/tui-pty-smoke.test.ts` (BABEL_O_RUN_PTY_SMOKE=1), and the
  `go-tui-smoke` / `remote-runner-go-smoke` PTY gates.

**Coverage:** `npm run coverage` runs `scripts/coverage-report.js`. Output
goes to `coverage/` (gitignored).

**Build smoke:** `npm run build:smoke` runs compile + production smoke. The
SEA binary (`npm run build:binary`) is the standalone release artifact.

---

## 9. Reference Material

- `docs/DEVELOPMENT.md` — branch responsibilities, dev-mode workflow.
- `docs/nexus/reference/` — long-form design plans:
  - `task-scope-and-evidence-scope-governance-plan.md` — P0 evidence-scope
    guardrail (Phase 0–3 foundation landed).
  - `memory-capability-awareness-and-trigger-plan.md` — EverCore Phase G
    (G1–G5 landed, G6 = live validation only).
  - `workspace-path-drift-governance-plan.md` — `PATH_DRIFT_SUSPECTED`
    diagnostic.
  - `tool-granularity-and-evidence-governance-plan.md` — tool surface
    discipline (no new `Search`, no new path-search tools, no
    `define_subagent` / `invoke_subagent`).
  - `context-management-optimization-plan.md` — context ceiling / runtime
    metrics diagnostics.
  - `session-finalization-and-evidence-governance-plan.md` — current-turn
    session outcome settlement.
  - `go-tui-permission-policy-governance-plan.md` — Bash hard-deny /
    soft-deny policy, `--allow-tools`.
  - `go-tui-selection-highlight-optimization-plan.md` — `--mouse` highlight.
  - `task-adaptive-recoverable-timeout-plan.md` — soft policy + auto
    extension cycle.
  - `session-to-session-memory-channel-plan.md` and
    `session-channel-tui-relationship-visibility-plan.md` — SessionChannel
    MVP and TUI visibility roadmap.
- `docs/nexus/DONE.md` — completed phase summaries (read first when
  picking up work).
- `docs/nexus/TODO.md` — current open items by priority.
- `docs/nexus/active/` — `TODO_runtime.md`, `TODO_tui.md`,
  `TODO_cleanup.md`, `TODO_performance.md`.
- `docs/nexus/WORK_LOG.md` — dated factual log of recent landed work.
- `docs/releases/` — release notes; new releases append a new file.
- `README.md` / `README.zh-CN.md` — user-facing feature docs.
- `clients/go-tui/README.md` — Go TUI internals.
- The `package.json#files` whitelist defines what `npm publish` ships — keep
  the Go TUI `!clients/go-tui/internal/tui/*_test.go` exclusion line.
- `/Users/tangyaoyue/DEV/EverOS/babel-o-evercore-integration-plan.md` —
  cross-repo long-term memory plan (managed sidecar + protocol bridge).

---

## 10. Quick Sanity Checks

Before pushing a change:

1. `npm run lint` (typecheck + format + dep audit).
2. `npm test` (full suite; long-running).
3. `npm run build:smoke` (compile + run prod smoke).

If you touched any of the following, also smoke-test `bbl chat dev` and
`bbl run "<simple prompt>"` against a scratch directory:

- the embedded Nexus default storage path,
- the permission policy mode,
- SessionChannel routing,
- `taskScope.ts` / scope-boundary classifier / bash target extractor,
- `memoryProvider.shouldAutoSearchMemory()` heuristic or its cue/suppression
  sets,
- `pendingPermission` fields (the Go TUI dialog and the runtime emit/respond
  chain must stay in sync),
- Go TUI interrupt / queued-prompt state machine.
