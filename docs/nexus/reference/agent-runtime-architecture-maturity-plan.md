# Agent Runtime Architecture Maturity Plan

> State: Active Plan
> Track: Agent Runtime / Observability / Eval / Durability
> Priority: P1
> Source of truth: [../../guides/ARCHITECTURE.md](../../guides/ARCHITECTURE.md), [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../active/TODO_performance.md](../active/TODO_performance.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/nexus/`, `src/runtime/`, `src/storage/`
> Governance: Indexed by [agent-session-skill-governance-index.md](./agent-session-skill-governance-index.md). This document owns agent runtime maturity gaps; it must not move execution truth out of Nexus/runtime.
> Related: [context-governance-index.md](./context-governance-index.md), [evidence-governance-index.md](./evidence-governance-index.md), [memory-governance-plan.md](./memory-governance-plan.md)

## 1. Background

BabeL-O already has the core layering expected from a modern agent runtime:

- Client owns interaction.
- Nexus owns orchestration and session state.
- Runtime owns model/tool execution, permissions, task scope, and evidence validation.
- Harness wires tools, MCP, agents, memory, storage, and policy.
- Observability exists through Nexus events, runtime metrics, tool traces, behavior traces, and benchmarks.

The comparison against LangGraph, Deep Agents, OpenAI Agents SDK, Anthropic agent engineering guidance, and MCP leads to this assessment:

```text
The architecture direction is strong; runtime-owned governance is a core advantage.
Trace, eval, durable resume, memory quality, and MCP context primitives are the next maturity gaps.
```

This plan does not require an immediate large rewrite. The goal is to split the maturity gaps into small, verifiable evolution layers.

## 2. Non-goals

- Do not rewrite BabeL-O into a LangGraph, OpenAI Agents SDK, or LangChain project.
- Do not enable cloud telemetry upload by default.
- Do not make LangSmith a hard dependency.
- Do not replace workspace evidence, session events, tool results, or SQLite with external memory hits.
- Do not let Go TUI or `bbl loop` own runtime truth.
- Do not enable write-capable child agents before real demand and eval evidence justify it.

## 3. Target Architecture Increments

### 3.1 Agent Trace Schema

Add a unified agent trace vocabulary so one run can be reconstructed as a trajectory:

```text
run
  -> provider invocation span
  -> stream deltas / usage
  -> tool call span
  -> permission decision span
  -> scope boundary span
  -> memory retrieval span
  -> compact / recovery span
  -> sub-agent handoff span
  -> final result
```

v1 requirements:

- Derive trace data from existing `NexusEvent`, `execution_metrics`, `toolTrace`, and `permission_audit` records instead of introducing a second source of truth.
- Make the trace schema exportable as JSONL.
- Keep trace IDs and span IDs stable enough to rebuild from session replay.
- Do not require OpenTelemetry or LangSmith compatibility in v1, but keep field names exporter-friendly.

Acceptance:

- `bbl inspect-session` can output a machine-readable trace for a session.
- At minimum, cover provider invocation, tool call, permission, scope boundary, and runtime result spans.
- Unit tests cover event-to-trace ordering, parent-child spans, and degraded behavior when events are missing.

**Status (2026-06-17): v1 收口.** `src/runtime/agentTrace.ts` ships a pure `projectAgentTrace(events: NexusEvent[])` projector (no storage, no clock, no second source of truth — toolTrace / execution_metrics side tables are already event projections, so the event stream is sufficient). Span kinds: `run` / `provider_invocation` / `tool_call` / `permission_decision` / `scope_boundary` / `compact_recovery` / `memory_update` / `sub_agent_handoff` / `final_result`. Parent-child: `permission_decision` and `scope_boundary` parent to the matching `tool_call` via `toolUseId`; all others parent to `run`. Span IDs are deterministic (content-derived) so a replayed stream reproduces identical IDs. Degraded paths emit human-readable warnings (no `session_started`, no terminal event, stream deltas without `execution_metrics`, orphan `tool_started`/`permission_request`). `bbl inspect-session <id> --trace` emits JSONL (header + one span per line); `--trace --json` emits a single blob. Coverage: `test/agent-trace.test.ts` (19 unit tests) + `test/inspect-session.test.ts` (3 `exportSessionTrace` integration tests). `memory_retrieval` spans are deferred to §3.5 (only `session_memory_updated` events exist today).

### 3.2 Trajectory Eval Harness

Add an eval harness for agent trajectories, not only function outputs or final text.

v1 fixture structure:

```text
evals/
  coding/
    task-id/
      prompt.md
      workspace/
      expected.json
      checks.ts
```

v1 check types:

- task success: whether files were modified correctly and tests pass;
- tool discipline: whether the run searched/listed/read before editing or writing;
- permission discipline: whether write/execute produced approval or an auto-approve reason;
- scope discipline: whether the run escaped the task primary root;
- context discipline: whether it triggered unnecessary broad reads or repeated large-file reads;
- memory discipline: whether it treated a memory hint as a fact source.

Acceptance:

- `npm run eval:agent` or an equivalent script can run the minimal fixture set.
- At least 10 small coding trajectory fixtures exist.
- Eval output includes success, cost, tool count, permission count, scope warnings, and trace path.

**Status (2026-06-17): v1 收口.** v1 is **offline + deterministic**: each fixture is a recorded event stream (the trajectory under test) projected to an `AgentTrace` via `projectAgentTrace`, with no provider key and no live workspace. The plan's literal `prompt.md` / `workspace/` / `expected.json` / `checks.ts` structure is a v1.1 live-workspace mode that depends on the durable-resume/replay machinery from §3.3; v1 uses a more maintainable single-`evals/coding/<id>.ts` module format (compact `ev.*` event builder + `defineFixture`) documented in `evals/README.md`.

- `src/eval/trajectoryEval.ts` — 6 builtin checks (`task_success` `skip` in v1; `tool_discipline` / `permission_discipline` / `scope_discipline` / `context_discipline` / `memory_discipline` as pure trace assertions) + `runFixture` / `runAll`.
- `src/eval/fixtureBuilder.ts` — compact event builder + `defineFixture`.
- `scripts/eval-agent.ts` + `npm run eval:agent` (`--json` for machine-readable). Per-fixture output: verdict, per-check severity, `satisfied`, metrics (cost `inputTokens`/`outputTokens`/`cacheReadTokens`, `toolCount`, `permissionCount`, `scopeWarnings`, `spanCount`), projector warnings.
- **Self-validating**: each fixture declares `expectChecks` (check → expected severity); the harness asserts actual matches. A fixture's `verdict` is `pass` iff every asserted check matched. The eval exits non-zero if any fixture misclassifies — so the fixtures prove the check suite discriminates known-good vs known-bad trajectories.
- 10 fixtures under `evals/coding/` cover all 6 disciplines (read-before-edit pass/fail, permission approved/repeated-deny, scope contained/escape, context repeated-reads/truncated, memory caution warn, compact-recovery good).
- `test/eval-agent.test.ts` — 19 unit tests pin every check's pass/warn/fail/skip path + `runFixture` self-validation + `runAll` report shape + `computeMetrics`.
- Deferred to v1.1: `task_success` with live workspace (needs §3.3); full `memory_discipline` auto-decide (needs §3.5 retrieval spans — v1 warns when memory events are present).

### 3.3 Durable Run Checkpoint / Resume

Session/event persistence already exists, but in-flight continuation remains mostly process-local. The next step is to define resumable execution semantics instead of only persisting pending permissions to SQLite.

v1 only defines checkpoint boundaries:

- before provider invocation,
- after provider invocation finished,
- before tool execution,
- waiting for permission,
- after tool result persisted,
- before final result.

v1 does not need to resume from the middle of a provider token stream, but it must report an explicit state at resumable boundaries:

- resume possible,
- retry from provider turn,
- waiting for permission,
- terminal failed with recoverable state,
- cannot resume because continuation snapshot is missing.

Acceptance:

- Session metadata or task state can express `waiting_permission`, `retryable_tool_result`, and `retryable_provider_turn`.
- Pending permission is no longer described as durable unless a tool-call snapshot and continuation state exist.
- After restart, `inspect-session` can explain where the run stopped, whether it can resume, and what should happen next.

**Status (2026-06-18): v1 收口.** v1 ships a pure projector (`deriveResumableState` in `src/runtime/runCheckpoint.ts`) that maps `(session phase, terminal reason, ordered event stream, pending permission, hasContinuationSnapshot)` to one of the five §3.3 states, plus the human-readable diagnostic. The runtime still does not persist an in-process continuation snapshot — that is intentional, because writing only the pending-permission entry to SQLite would create "looks durable, actually unrecoverable" false persistence. The `pendingPermission` vector stays honest: even without a continuation snapshot, a `permission_request` with no matching `permission_response` is the one resume vector that survives restart (audit + pending entry), and the CLI's default `hasContinuationSnapshot: false` keeps the durability claim conservative.

- `src/runtime/runCheckpoint.ts` — 6 boundaries, 5 states, `deriveResumableState({ session, events, pendingPermissionToolUseId, hasContinuationSnapshot })`. `hasContinuationSnapshot` defaults to `false`; v1 callers (CLI inspection) never upgrade it.
- `src/cli/commands/inspectSession.ts` — `exportSessionResumeState` + `exportSessionResumeStateDirect` + `formatResumeState`. Read-only `DatabaseSync` access; same `readOrderedEvents` helper as the trace path. `session_go_<unixnano>` reverse-resolved via the client log.
- `bbl inspect-session <id> --resume` — short-circuits like `--trace`. Default: human-readable block (`▶ <state>`, `boundary`, `reason`, `warnings`, honest `next` hint, gray "no continuation snapshot" note). `--resume --json` emits the raw `DerivedResumableState`. Exit 1 when the session is absent.
- Coverage: `test/run-checkpoint.test.ts` (18 unit tests on the projector) + `test/inspect-session-resume.test.ts` (7 integration tests on `formatResumeState` rendering + `exportSessionResumeState` CLI wiring — covers the 5 distinct `next:` hints, warnings block, no-DB / unknown-session / known-session paths).
- Deferred to v1.1+ (real demand required): persisting a durable continuation snapshot, resuming from the middle of a provider token stream, and exposing `retryable_provider_turn` / `retryable_tool_result` as session metadata writes (today they are derived, not stored).

### 3.4 MCP Context Primitives

Current MCP support is mainly tool wrapping. Future work may add MCP resources, prompts, roots, and elicitation when real integrations need them, but scope must remain runtime-owned.

v1 goals:

- If `ListMcpResources` / `ReadMcpResource` land, they must align with task-scope and evidence-scope protocols.
- MCP resources must not bypass `Read`, evidence grounding, or permission flow.
- MCP roots must not override the Nexus primary root; they can only become explicit roots or confirmed external roots.

Acceptance:

- MCP resource reads trigger scope diagnostics at the same level as file reads.
- Go TUI only renders MCP source information; it does not infer MCP scope.

### 3.5 Memory Quality Metrics

MemoryOS/EverCore currently has the right authority boundary, but it needs quality metrics to prove that hints are useful and not overconfident.

v1 metrics:

- auto-search triggered / skipped reason distribution;
- hit count / injected chars / truncation rate;
- memory-derived answer revalidation rate;
- stale or contradicted memory count;
- user-denied memory save rate;
- memory write approval rate;
- memory hint used in final answer count.

Acceptance:

- `/v1/runtime/memory/status` or `/context` diagnostics can show a recent-window memory quality summary.
- The eval harness can assert that memory hints are not treated as workspace facts.

**Status (2026-06-18): v1 partial — 4 of 7 metrics shipped; 3 deferred to v1.1.** v1 ships the four metrics that are derivable from already-persisted signals:

- `auto-search triggered / skipped reason distribution` — projected from the new `memory_retrieval` event stream (`MemoryRetrievalEventSchema` in `src/shared/events.ts`).
- `hit count / injected chars / truncation rate` — same event stream.
- `memory write approval rate` and `user-denied memory save rate` — in-process `memoryApprovalCounters` on `createNexusApp`, incremented by `/v1/runtime/memory/save-note`.

The other three metrics (`memory-derived answer revalidation rate`, `stale / contradicted memory count`, `memory hint used in final answer count`) need model-side or write-side signals that do not exist yet; deferred to v1.1.

Key artifacts:

- `src/shared/events.ts` `MemoryRetrievalEventSchema` — new event kind. Carries the full `MemoryProviderDiagnostics` shape so the trace projector and the dashboard can use the same source of truth.
- `src/runtime/agentTrace.ts` — new `memory_retrieval` span kind. Projects each `memory_retrieval` event (including auto-search *skips*) so the trajectory export and the eval harness can reason about every memory consultation. Parent to `run`.
- `src/runtime/contextAssembler.ts` — new `onMemoryRetrieval` option. Fire-and-forget hook fired once per `memoryProvider.retrieve()`; never throws into the hot path. Backward compatible: when omitted, no event is emitted.
- `src/runtime/memoryMetrics.ts` — pure `computeMemoryQualityMetrics(events, options)` projector. Stable shape (every reason slot is present even when count is 0) for dashboard rendering. Mirrors `projectAgentTrace` / `deriveResumableState`.
- `src/nexus/app.ts` — `GET /v1/runtime/memory/status` now surfaces a `quality` block: 4 raw metric counts + 5 derived rates (truncation, retrieval hit, auto-search trigger, search latency, save approval). Recent window is "all retrievals this Nexus has seen across all sessions" — process-lifetime, consistent with v1's "dashboard signal, not audit history" contract. **Hot path emission landed in v1.1** (2026-06-18): `LLMCodingRuntime` carries a closure-style `emitMemoryRetrieval` method that fires after every `refreshRuntimeContextState` retrieve call (6 hot-path entry points — initial refresh / after-tool / after-permission / after-compact / after-sub-agent / resume step 2). The hook persists a `memory_retrieval` NexusEvent via `storage.appendEvent` with errors swallowed to `process.stderr` so a hook failure can never break the hot path. Smoke-verified against sqlite: `executeStream()` → 1 retrieve() → 1 persisted event with full schema. The new `memoryApprovalCounters` (`approved` / `denied` / `pendingReview`) live in `createNexusApp` closure and reset on Nexus restart.
- `src/eval/trajectoryEval.ts` `checkMemoryDiscipline` — upgraded from warn-only (v1 of §3.2) to auto-decide: `pass` when revalidated with `Read` / `Grep` / `Glob` after the first retrieval-with-hits, `warn` on a single hit without revalidation, `fail` on multiple hits without revalidation. Matches §3.5 acceptance #2.
- `evals/coding/memory-hint-skipped-pass.ts` / `memory-hint-revalidated-pass.ts` / `memory-hint-no-revalidation-fail.ts` — three new self-validating fixtures replacing the old `memory-hint-caution-warn.ts`.
- `test/memory-metrics.test.ts` (10 unit tests) + `test/eval-agent.test.ts` (4 new memory_discipline tests) + `test/assemble-context-memory-hook.test.ts` (3 hook contract tests) pin the projector, check behaviour, and pin the fire-and-forget hook contract. `npm run eval:agent` is 12/12 self-validating.

v1.1 follow-ups remaining (real demand required): the three deferred metrics (model-side revalidation, stale / contradicted, hint-used-in-answer), and replace the in-process approval counters with durable per-session audit rows.

### 3.6 Loop Taxonomy

Standardize loop naming across documentation and code comments:

| Name | Meaning |
| --- | --- |
| runtime loop | provider/tool loop inside `LLMCodingRuntime` |
| tool loop | a single provider-requested tool call lifecycle |
| agent loop | planner/executor/critic/optimizer task loop |
| interaction loop | Go TUI / `bbl loop` UI event loop |

Acceptance:

- `docs/guides/ARCHITECTURE.md`, `TODO.md`, and `active/TODO_*` use the same terminology set.
- New loop documents must state whether they own runtime truth; the default is no.

## 4. Priorities

| Priority | Item | Owner document |
| --- | --- | --- |
| P1 | Agent Trace Schema | `active/TODO_performance.md` |
| P1 | Trajectory Eval Harness | `active/TODO_performance.md` |
| P1 | Durable Run Checkpoint / Resume | `active/TODO_runtime.md` |
| P2 | Memory Quality Metrics | `active/TODO_runtime.md`, memory reference docs |
| P2 | MCP Context Primitives | `active/TODO_runtime.md`, tool/MCP reference docs |
| P2 | Loop Taxonomy Cleanup | `ARCHITECTURE.md`, `TODO.md`, TUI/loop reference docs |

## 5. Implementation Order

1. ✅ Define trace projection from existing events. → `src/runtime/agentTrace.ts` `projectAgentTrace`.
2. ✅ Add CLI/debug export for a session trace. → `bbl inspect-session <id> --trace`.
3. ✅ Build a small trajectory eval harness using exported traces. → `src/eval/trajectoryEval.ts` + `evals/coding/` + `npm run eval:agent`.
4. ✅ Define resumable execution states and checkpoint boundaries. → `src/runtime/runCheckpoint.ts` `deriveResumableState` + `bbl inspect-session <id> --resume`.
5. ✅ Land the four v1 Memory Quality Metrics + v1.1 hot-path emission. → `src/runtime/memoryMetrics.ts` + `MemoryRetrievalEventSchema` + `agentTrace` `memory_retrieval` span + `/v1/runtime/memory/status` `quality` block + `trajectoryEval` `memory_discipline` auto-decide + `LLMCodingRuntime.emitMemoryRetrieval` closure wired to all 6 hot-path refresh sites (smoke-verified against sqlite). Remaining v1.1 work: the 3 deferred model-/write-side metrics, durable approval audit rows.
6. Extend MCP context primitives only after a real resource-use regression or integration need.

## 6. Success Criteria

BabeL-O can claim production-grade agent runtime maturity when:

- every run has a reconstructable trace,
- core coding behaviors have trajectory eval coverage,
- interrupted sessions report exact resumability state,
- memory quality is visible and testable,
- MCP context is scope-governed,
- all loop layers are named consistently and only Nexus/runtime own execution truth.

## 中文概述

### 背景

本规划把 BabeL-O 与现代 agent runtime 对照后发现的缺口收敛成可执行路线：trace、eval、durable resume、MCP context primitive、memory quality 和 loop taxonomy。

### 边界

它不要求引入 LangGraph / OpenAI Agents SDK / LangSmith 作为强依赖，也不让 Go TUI、`bbl loop` 或 memory 层拥有 runtime truth。所有 trace 和 resume 判断都应从 Nexus event、storage、tool trace 和 runtime metric 派生。

### 当前状态

架构方向已经具备现代 agent runtime 的核心分层；真正缺口是生产级可复盘性、可评测性和中断恢复语义。Agent Trace Schema v1 已于 2026-06-17 收口（`src/runtime/agentTrace.ts` 纯投影 + `bbl inspect-session --trace` 导出 + 22 个测试）。Trajectory Eval Harness v1 已于 2026-06-17 收口（`src/eval/trajectoryEval.ts` 6 个 builtin check + 10 个 `evals/coding/` fixture + `npm run eval:agent` + 19 测试；离线 / 自验证）。Durable Run Checkpoint / Resume v1 已于 2026-06-18 收口（`src/runtime/runCheckpoint.ts` 6 boundary / 5 state 纯投影 + `bbl inspect-session <id> --resume` CLI + 18 unit + 7 integration 测试；v1 显式不持久化 in-process continuation snapshot，因此默认 `hasContinuationSnapshot: false` 保持诚实）。Memory Quality Metrics v1 已于 2026-06-18 部分收口（4 / 7 metric：`autoSearchReasonDistribution` / `hitCount+injectedChars+truncationRate` / `saveApprovalRate` / `userDeniedRate`；`memory_retrieval` NexusEvent + `agentTrace` `memory_retrieval` span + `computeMemoryQualityMetrics` 纯投影 + `/v1/runtime/memory/status` `quality` block 暴露 + `trajectoryEval` `memory_discipline` 从 warn-only 升级为 auto-decide + 3 新 fixture；v1.1 hot-path 发射已于同日收口（`LLMCodingRuntime.emitMemoryRetrieval` closure 接入全部 6 个 refresh 站点 + sqlite 端到端 smoke 通过）；剩余 3 metric 需 model-side / write-side 信号推迟到后续）。当前主线 §3.1 / §3.2 / §3.3 全部收口，§3.5 部分收口；下一项是 §3.4 MCP Context Primitives（需真实 MCP resource regression 触发再推进）。
