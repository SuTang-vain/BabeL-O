# Runtime Tool Permission Flow Reference

> State: Active Plan
> Track: Runtime / Tools
> Priority: P1 — duplicated permission flow across two runtimes is a maintenance hazard; a fix to one will not propagate to the other
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/runtime/runtimeToolLoop.ts`, `src/runtime/LocalCodingRuntime.ts`, `src/runtime/LLMCodingRuntime.ts`, `src/runtime/taskScope.ts`, `src/runtime/hooks.ts`
> Governance: Indexed by [README.md](../README.md) and [tool-governance-plan.md](./tool-governance-plan.md). Canonical owner of "the tool-permission flow is one shared function." Risk classification stays in [tool-governance-plan.md](./tool-governance-plan.md); scope-boundary classification stays in [task-scope-and-evidence-scope-governance-plan.md](./task-scope-and-evidence-scope-governance-plan.md); recoverable-denial semantics stay in [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md).
> Related: [tool-governance-plan.md](./tool-governance-plan.md), [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md), [task-scope-and-evidence-scope-governance-plan.md](./task-scope-and-evidence-scope-governance-plan.md), [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md)

## Purpose

The tool-permission gating flow (effective-risk resolution → policy check → PreToolUse hooks → PermissionRequest hooks → `PendingPermissionRegistry` → audit → `permission_request` / `permission_response` events → scope-boundary handling → recoverable denial) is implemented twice, near-identically, in `LocalCodingRuntime` and in the `runtimeToolLoop` used by `LLMCodingRuntime`. This document is the durable reference for extracting it into one shared function so the two runtimes cannot diverge.

## Current State

- `LLMCodingRuntime` and `LocalCodingRuntime` both implement `NexusRuntime.executeStream(): AsyncIterable<NexusEvent>` — the interface seam is clean.
- The permission flow is duplicated:
  - `runtimeToolLoop.ts:420-720` (via `executeProviderToolCall` + `requestScopeBoundaryPermission`) — used by `LLMCodingRuntime`.
  - `LocalCodingRuntime.ts:392-531` — the local runtime's own copy.
  - Both check `effectiveRisk` / `classifyAction()`, run `executeRuntimeHooks('PreToolUse', ...)`, run `executeRuntimeHooks('PermissionRequest', ...)`, handle `firstHookPermissionDecision`, handle `PendingPermissionRegistry`, persist `permission_audit`, yield `permission_request` / `permission_response`.
- Tool-risk resolution is also duplicated: `runtimeToolLoop.ts:65-93` `resolveEffectiveToolRiskWithRule()` mirrors `LocalCodingRuntime.ts:93-109` `effectiveRisk()` (same `tool.riskForInput` try/catch).
- `withToolPolicy()` exists in both classes with near-identical async-iterator handling (`LLMCodingRuntime.ts:183-209`, `LocalCodingRuntime.ts:111-137`).
- `LocalCodingRuntime` already exports `ToolPolicy`, `allowAllTools`, `allowlistedTools` — and `LLMCodingRuntime` imports them (`LLMCodingRuntime.ts:12`). So there is already a one-way dependency from the LLM runtime to the local one; the shared code just has not been extracted.

## Problem Statement

A scope-boundary permission fix (e.g. the `scope_boundary_confirmed` re-derive logic in `runtimeToolLoop.ts:574-603`) lands only on the `LLMCodingRuntime` path. The `LocalCodingRuntime` path is used for deterministic replay / tests and for local-intent execution; a permission-policy bug fixed on one path silently persists on the other. This is exactly the class of divergence that the embedded-path unification ([unify-embedded-cli-path-plan.md](../proposals/unify-embedded-cli-path-plan.md)) is meant to prevent, but it already exists *within* the runtime layer.

## Goals

- One shared `requestToolPermission(...)` (and shared `resolveEffectiveToolRisk` / `withToolPolicy`) used by both runtimes.
- The scope-boundary preflight (`classifyToolScopeBoundary` + `requestScopeBoundaryPermission`) is a composable stage of the shared flow, not a parallel implementation.
- The two runtimes retain their distinct *loop* concerns (LLM provider loop vs. local-intent single-tool execution) but share the *permission* concern.
- No behavior change for existing tests; the extraction is verified by byte-identical event sequences.

## Non-goals

- Do not merge the two runtimes — they legitimately differ (LLM streaming + compaction vs. deterministic single-tool).
- Do not change the `NexusRuntime` interface.
- Do not change the `ToolRisk` union or the permission event schema.
- Do not change hook semantics (`hooks.ts`).

## Design

### Phase 1 — Extract shared risk resolution

1. Move `resolveEffectiveToolRiskWithRule` / `effectiveRisk` to a single `src/runtime/toolRiskResolver.ts`. Both runtimes import it.
2. Move `withToolPolicy` to `src/runtime/toolPolicy.ts` (alongside the already-shared `ToolPolicy` / `allowAllTools` / `allowlistedTools`).
3. Delete the duplicated copies; update imports.

### Phase 2 — Extract shared permission flow

1. New `src/runtime/toolPermissionFlow.ts` exporting `requestToolPermission({ tool, input, ctx, services, hooks, pendingRegistry, scope })` returning an async generator of `NexusEvent` (or a decision object the caller yields). It owns: effective-risk + policy check → PreToolUse hooks → scope-boundary preflight (`classifyToolScopeBoundary` → `requestScopeBoundaryPermission` folded in) → PermissionRequest hooks → pending registry → audit persist → `permission_request` / `permission_response` / `scope_boundary_*` events → recoverable-denial result.
2. `runtimeToolLoop.ts` and `LocalCodingRuntime.ts` both call it. The scope-boundary branch is a parameter/stage, not a second implementation.
3. Preserve the existing `yield*` event ordering exactly.

### Phase 3 — Parity test

1. New `test/tool-permission-flow-parity.test.ts`: drive the same `(tool, input, policy, scope)` fixture through both runtimes and assert the emitted event sequence is identical.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Draft | Shared risk resolver + shared `withToolPolicy`. | Both runtimes import the shared module; duplicated copies deleted; `npm test` green. |
| Phase 2 | Draft | Shared `requestToolPermission` flow incl. scope-boundary stage. | Both runtimes route permission through it; no duplicated permission logic remains; `npm test` green. |
| Phase 3 | Draft | Parity test asserting identical event sequences across runtimes. | Parity test green; a deliberate divergence introduced in one runtime fails the test. |

## Verification

- `npm test` (existing permission / scope-boundary / local-runtime / runtime-llm regressions unchanged).
- New `test/tool-permission-flow-parity.test.ts`.
- `npm run coupling:audit` (no new reverse import introduced by the extraction).
- `npm run build:smoke`.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).
- This document keeps the durable permission-flow boundary and the extraction plan.

## 中文概述

### 背景

权限流（effective-risk → policy → PreToolUse hook → scope-boundary → PermissionRequest hook → pending registry → audit → permission_request/response → 可恢复拒绝）在 `runtimeToolLoop.ts`（LLM 路径）和 `LocalCodingRuntime.ts`（本地路径）里几乎逐行重复；`resolveEffectiveToolRisk` 和 `withToolPolicy` 也重复，且 `LLMCodingRuntime` 已经反向 import `LocalCodingRuntime` 的 `ToolPolicy`。一处权限 bug 修了不会传到另一条路径。

### 核心做法

Phase 1 抽共享 risk resolver + `withToolPolicy`；Phase 2 抽共享 `requestToolPermission`（把 scope-boundary 作为其中一个 stage 而非并行实现）；Phase 3 加 parity 测试断言两条 runtime 事件序列一致。

### 当前状态

Active Plan 草案。`LLMCodingRuntime`→`LocalCodingRuntime` 的依赖已存在，只差把共享代码抽出。

### 下一步

最小切片：Phase 1 抽 `toolRiskResolver.ts` + `toolPolicy.ts`，删重复副本，零行为变更。
