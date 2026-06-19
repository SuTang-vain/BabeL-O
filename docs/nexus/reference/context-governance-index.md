# Context Governance Index

> State: Index
> Track: Context / Runtime / Agent / Go TUI
> Priority: P1 Watch
> Source of truth: `docs/nexus/TODO.md`, `docs/nexus/active/`, `docs/nexus/DONE.md`, `docs/nexus/WORK_LOG.md`, `src/runtime/contextAssembler.ts`, `src/runtime/contextAnalysis.ts`, `src/nexus/agents/ContextForker.ts`, `src/runtime/workingSetTracker.ts`, `src/runtime/behaviorTrace.ts`
> Related: [context-and-agent-history.md](../history/context-and-agent-history.md), [context-and-agent-history.md](../history/context-and-agent-history.md), [long-running-context-assembly.md](../proposals/long-running-context-assembly.md), [context-cwd-drift-and-recall-governance-plan.md](./context-cwd-drift-and-recall-governance-plan.md), [behavior-monitor.md](../proposals/behavior-monitor.md), [cache-observability-and-nexus-realtime-detection-plan.md](./cache-observability-and-nexus-realtime-detection-plan.md), [memory-governance-plan.md](./memory-governance-plan.md), [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md)

## Purpose

This document is the reader entry point for BabeL-O context governance. It does not replace the detailed context plans and does not create a new implementation queue. Its job is to define ownership between the context-related references, keep terminology stable, and prevent completed runtime facts, watch items, and exploratory cache/memory work from being mixed into one vague "context optimization" bucket.

Current scheduling still belongs to `docs/nexus/TODO.md` and `docs/nexus/active/`. Completed implementation evidence belongs to `docs/nexus/DONE.md` and `docs/nexus/WORK_LOG.md`.

## Ownership Map

| Document | Role | Current reading rule |
| --- | --- | --- |
| [context-and-agent-history.md](../history/context-and-agent-history.md) | Primary architecture reference for Context Manager normalization, ContextForker, AgentScheduler, child context modes, and the write-capable child-agent boundary. | Read this first when changing child-agent context, fork modes, or AgentScheduler semantics. |
| [context-and-agent-history.md](../history/context-and-agent-history.md) | Runtime-owned context facts, token estimation, compact protocol, provider context-limit recovery, post-compact grounding, and UI visibility. | Treat as a closed/runtime guardrail reference; do not reopen completed compact/token-estimator work without a new regression. |
| [long-running-context-assembly.md](../proposals/long-running-context-assembly.md) | Working set, resume, context assembly, REST/CLI/WS interfaces, and Nexus-owned long-running session state. | Treat as a partially landed implementation line. 2026-06-18 source/session audit found primitives and observer skeletons are present, but the runtime `executeStream` hot path does not yet inject persisted Nexus working set as authoritative active context. Follow R0-R7 before claiming zero-loss resume or production cross-session working-set sharing. |
| [context-cwd-drift-and-recall-governance-plan.md](./context-cwd-drift-and-recall-governance-plan.md) | Regression plan for prompt-derived cwd drift, provider usage calibration, and storage-backed session recall tools. | Treat as Active Plan; use it when context drift starts from cwd/path extraction, broad root scans, or failed `contextSearch` / `contextRecent` recall. Phase A + Phase A Follow-up + Phase B + Phase C1 are closed as of 2026-06-18; Phase C2 / D / E / F remain Open. `session_10320709` is the current P0 follow-up for storage propagation and Nexus session-continuity wiring. |
| [behavior-monitor.md](../proposals/behavior-monitor.md) | Behavior trace, cross-session diagnostics, live hints, and Go loop visualization follow-up. | Treat behavior trace as diagnostics and live guidance, not as memory or authoritative task state. |
| [cache-observability-and-nexus-realtime-detection-plan.md](./cache-observability-and-nexus-realtime-detection-plan.md) | Cache health observability and honest unavailable states for cache families without real hit/miss sources. | Treat as Active Plan; never infer hit rates from model narration or missing metrics. |
| [memory-governance-plan.md](./memory-governance-plan.md) | Memory authority, opt-in write boundaries, EverCore/EverOS lifecycle, and project/session memory exposure. | Use it when context assembly touches durable memory or user-visible memory tools. |
| [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md) | Recoverable tool errors, bounded loop finalization, and final-answer guarantees after tool failures. | Use it when context drift is caused by failed tools, loop exhaustion, or missing final responses. |

## Governance Rules

### 1. Runtime owns context facts

Context percentage, token pressure, compact state, retained events, omitted events, and provider context-limit recovery are runtime facts. The assistant may explain these facts only when they are backed by runtime events or diagnostics. Model narration must not invent percentages such as "context is 91%" without a corresponding runtime-owned estimate.

### 2. Context assembly separates authority layers

Context assembly must preserve the difference between:

| Layer | Authority |
| --- | --- |
| System/developer instructions | Highest policy authority. |
| User's latest instruction | Highest task authority for the current turn. |
| Working set | Current task state that should survive long sessions and resume. |
| Recent transcript | Short-term conversational continuity. |
| Tool evidence | Grounded file/system facts with provenance. |
| Compact summary | Recovery aid, not a replacement for retained recent turns. |
| Project/session memory | Hints with explicit scope and freshness. |
| Behavior trace/live hints | Diagnostics, not memory and not task evidence. |

Mixing these layers is the main source of instruction-following drift. The context stack should make each layer visible enough for diagnostics while keeping provider prompts compact.

### 3. Compact is a recovery protocol

Compact is not just summary generation. A valid compact boundary needs retained segment metadata, omitted-event identity, summary source, trigger reason, and post-compact restoration behavior. Manual or reactive compact success should reset auto-compact failure pressure because it is a user- or runtime-confirmed recovery point.

### 4. Working set is bounded task state

The working set is the always-available task state for a session or workspace. It should be small, explicit, resumable, and inspectable. It must not become an unbounded replacement for transcript history, project memory, or behavior trace.

### 5. Behavior trace is diagnostics

Behavior trace records what the agent did, where it drifted, and what patterns Nexus detected. It may produce live hints, but it must not silently rewrite user intent, memory, or task scope.

### 6. Cache metrics must be honest

Prompt-cache metrics may be shown only when provider usage exposes cache read/create tokens or an equivalent source exists. Code index, tool, or reasoning cache metrics must be marked `unavailable` until their own hit/miss sources exist. Missing data is not a 0% hit rate.

### 7. Child context forks preserve boundaries

Child agents may receive focused context through ContextForker, but the parent/child boundary must remain explicit. Explore/Review/Test child profiles can be model-visible when enabled. Write-capable child agents stay disabled until worktree-isolated review/merge/reject safety is complete.

## Current State

BabeL-O already has a real context foundation:

- context assembly and system prompt sectioning;
- token/context analysis and context warning/blocking;
- manual/reactive compact and retained-segment verification;
- microcompact/snipping for large tool output;
- provider context-limit recovery;
- working-set tracking and persistence;
- CLI/REST context diagnostics;
- ContextForker and read-only/check-only AgentScheduler profiles;
- behavior trace and Nexus loop health projection;
- prompt-cache diagnostics when provider metrics exist.

The remaining issue is not "add context management from scratch". The remaining issue is keeping these capabilities governed as one protocol so that long sessions, tool failures, child tasks, memory hints, and Go TUI views all agree about what the model is supposed to know.

## Open Items

| Item | Owner document | Status |
| --- | --- | --- |
| Runtime hot-path persisted working-set injection | [long-running-context-assembly.md](../proposals/long-running-context-assembly.md) | Open. R2: normal `LLMCodingRuntime.executeStream()` must load/update/flush `PersistedWorkingSetTracker` and pass `workingSetOverride` to every context refresh. |
| REST `PUT /v1/context/working-set/:sessionId` and `/v1/working-set/observe` shared tracker | [long-running-context-assembly.md](../proposals/long-running-context-assembly.md) | Open. R3: REST PUT currently uses a fresh tracker; e2e must prove PUT -> persisted file -> WS event -> GET same version. |
| WebSocket `/v1/context/observe` with real runtime assembled-context events | [long-running-context-assembly.md](../proposals/long-running-context-assembly.md) | Open. Route and broadcaster exist; R4 must prove a real runtime turn emits a redacted `assembled` frame. |
| CWD drift and session recall regression corpus | [context-cwd-drift-and-recall-governance-plan.md](./context-cwd-drift-and-recall-governance-plan.md) | Active Plan; Phase A + Phase A Follow-up + Phase B + Phase C1 closed; Phase C2 / D / E / F Open. Current real-session regression: `session_10320709` (context tools unavailable despite persisted events, missing continuity events, cwd drift to `~/Library`). |
| Long-term memory section through a MemoryProvider contract | [long-running-context-assembly.md](../proposals/long-running-context-assembly.md), [memory-governance-plan.md](./memory-governance-plan.md) | Deferred until memory governance is stable. |
| Go loop mirror for behavior monitor visualization | [behavior-monitor.md](../proposals/behavior-monitor.md) | Client follow-up. |
| Cache health aggregation for non-prompt cache families | [cache-observability-and-nexus-realtime-detection-plan.md](./cache-observability-and-nexus-realtime-detection-plan.md) | Active Plan; Phase A independently implementable, Phase D unblocked 2026-06-17. |
| Context governance regression corpus | [context-and-agent-history.md](../history/context-and-agent-history.md) | Watch item for drift/session failures. |

## Verification Expectations

Context changes should be verified with the smallest relevant set from:

- `npm run docs:check` for documentation ownership and link health;
- focused context tests covering token estimation, compact, retained segment verification, provider recovery, and working set behavior;
- `/context`, `bbl context working-set`, `bbl context history`, `bbl context resume`, and `bbl context assemble` smoke checks;
- real-session regression samples for workspace escape, cancelled tool continuation, provider empty response, tool schema failure, and prompt-too-long recovery;
- Go TUI/loop checks only when the change affects context visibility, live hints, permission flow, or multi-pane state.

## 中文概述

### 背景

Context 相关文档已经覆盖架构、压缩、长任务、行为追踪、缓存观测和记忆边界。如果继续平铺，会让读者难以判断哪份是主入口、哪份只是实现记录或观察计划。

### 核心做法

本文件不合并所有细节，而是建立 Context 治理索引：明确每份文档负责的边界，并要求 runtime 拥有上下文事实、working set 保持有界、compact 作为恢复协议、behavior trace 只做诊断、cache 指标必须来自真实观测。

### 当前状态

BabeL-O 已具备较完整的 context foundation。当前重点不是从零重写，而是让这些能力在长会话、工具失败、子任务、记忆提示和 Go TUI 展示之间保持一致协议。

### 下一步

优先顺序改为：先收口 storage propagation / cwd continuity（阻塞真实 recall），再把 persisted working set 接入 `executeStream` 热路径，然后做 REST PUT ↔ working-set observe 共享 tracker、真实 runtime `context observe` e2e、resume preview 和 Go TUI 可视化。长期记忆能力继续跟随 Memory governance，避免把记忆、行为诊断和上下文事实混为一体。
