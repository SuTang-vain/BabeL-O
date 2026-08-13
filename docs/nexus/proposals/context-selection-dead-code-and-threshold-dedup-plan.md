# Context Selection Dead Code and Threshold Deduplication Plan

> State: Draft
> Track: Context / Runtime
> Priority: P1 — dead scoring scaffold misleads readers; duplicated threshold computation with divergent defaults is a latent inconsistency bug
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/runtime/contextManager.ts`, `src/runtime/contextAssembler.ts`, `src/runtime/cacheAwareCompactPolicy.ts`, `src/runtime/tokenEstimator.ts`
> Governance: Indexed by [README.md](../README.md) and [context-governance-index.md](../reference/context-governance-index.md). Canonical owner of "context selection is one code path, thresholds have one source." Cache-aware compaction policy stays in [cache-observability-and-nexus-realtime-detection-plan.md](../reference/cache-observability-and-nexus-realtime-detection-plan.md); retained-segment verification stays in [long-running-context-assembly.md](../reference/long-running-context-assembly.md).
> Related: [context-governance-index.md](../reference/context-governance-index.md), [cache-observability-and-nexus-realtime-detection-plan.md](../reference/cache-observability-and-nexus-realtime-detection-plan.md), [long-running-context-assembly.md](../reference/long-running-context-assembly.md)

## Purpose

`contextManager.ts` carries a 330-line scoring/selection type system (`ContextItem` / `ScoredContextItem` / `SelectedContextItem` / `ContextManagerPhase`) that is **never used to drive any decision** — the real selection is `selectRecentEvents` / `protectToolPairs` in `contextAssembler.ts`. Separately, the warning/compact/blocking threshold is computed in three places with divergent defaults. This plan removes the dead scaffold and unifies the threshold source so the two subsystems reading the same event stream cannot disagree.

## Current State

- `contextManager.ts:40-59` defines `ContextItem` / `ScoredContextItem` / `SelectedContextItem`. `contextManager.ts:4-24` defines `ContextManagerPhase` and a "phases" array describing a pipeline that does not exist — no code iterates these phases.
- `buildContextSelectionDiagnostics()` (`contextManager.ts:87-191`) is called once, from `assembleContext()` (`contextAssembler.ts:376-388`), purely to produce a diagnostic object. `scoreContextItem()` / `compareSelectedItems()` are never called to make a budget decision.
- Real selection: `selectRecentEvents` (`contextAssembler.ts:228`) + `protectToolPairs` (`:230`) — simple heuristics. Real budget allocation: `allocateBudget()` (`contextAssembler.ts:179-200`) — fixed layer budgets, not scoring.
- Threshold computation duplicated three ways with divergent defaults:
  - `tokenEstimator.ts:81-112` `getContextWindowState()` — defaults `warningPercent=70`, `compactPercent=85`.
  - `cacheAwareCompactPolicy.ts:96-105` (inside `buildCacheAwareCompactPolicy`) — defaults `compactPercent=90`.
  - `cacheAwareCompactPolicy.ts:191-203` `computeBlockingLimit()` — different math again.
  - The 85 vs 90 divergence means the token estimator and the cache-aware policy can report different compact states for the same event stream.

## Problem Statement

Dead architecture misleads: a reader assumes the scoring types matter and wastes time, or "completes" the selector without realizing it is disconnected. Divergent thresholds are a latent bug — two diagnostics can disagree about whether the context is in compact state, producing confusing `/context` output and potentially inconsistent compaction triggers.

## Goals

- Remove the unused scoring scaffold (or wire it in — but default to remove, since the heuristic selection is deliberate and tested).
- One source of truth for warning/compact/blocking thresholds; `tokenEstimator` and `cacheAwareCompactPolicy` delegate to it.
- `/context` diagnostics and compaction triggers read the same threshold values.

## Non-goals

- Do not introduce a scoring-based selector in this plan — that is a larger design change; if wanted, it is a separate proposal. This plan only removes dead code and dedups thresholds.
- Do not change the compaction *algorithm* (`compact.ts`, `compactors/*`), the retained-segment verification, or the cache-preservation mode logic.
- Do not change the `CacheAwareCompactPolicy` output shape (consumers depend on it).

## Design

### Phase 1 — Remove dead scoring scaffold

1. Delete `ContextItem` / `ScoredContextItem` / `SelectedContextItem` / `ContextManagerPhase` / the "phases" array / `scoreContextItem` / `compareSelectedItems` from `contextManager.ts`.
2. Keep `buildContextSelectionDiagnostics()` (it is consumed) but simplify it to report what `assembleContext` actually did, without the phantom scoring vocabulary. Rename if helpful (`buildContextSelectionReport`).
3. If any type is re-exported / imported elsewhere, remove those imports. Grep confirms current callers are diagnostic-only.

### Phase 2 — Single threshold source

1. New `src/runtime/contextThresholds.ts` exporting `computeContextThresholds({ contextWindow, cachePreservationMode, overrides? })` returning `{ warningTokens, compactTokens, blockingTokens }`. This is the one source.
2. `cacheAwareCompactPolicy.buildCacheAwareCompactPolicy` calls it; `tokenEstimator.getContextWindowState` calls it; `computeBlockingLimit` delegates to it.
3. Pick one default set (recommend `warning=70`, `compact=85`, `blocking=100`-ish, modulated by `cachePreservationMode` as the policy already does). Document the chosen defaults in one place.

### Phase 3 — Consistency test

1. New `test/context-threshold-consistency.test.ts`: for a sweep of `contextWindow` / `cachePreservationMode` values, assert `tokenEstimator.getContextWindowState` and `cacheAwareCompactPolicy` agree on warning/compact/blocking state.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Draft | Delete dead scoring scaffold; simplify diagnostics. | `grep` for deleted types returns 0; `npm test` green; `/context` output unchanged in shape. |
| Phase 2 | Draft | Single `computeContextThresholds` source; both consumers delegate. | No duplicate threshold math remains; defaults documented once. |
| Phase 3 | Draft | Consistency test. | Test green; a deliberate divergence between the two consumers fails it. |

## Verification

- `npm test` (existing context regressions: `test/context-assembler.test.ts`, `test/context-regression.test.ts`, `test/prefix-cache.test.ts`, `test/compact-summary.test.ts`, `test/snip-compactor.test.ts` green).
- New `test/context-threshold-consistency.test.ts`.
- `npm run build:smoke`.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).

## 中文概述

### 背景

`contextManager.ts` 的 330 行评分类型系统从不参与决策，真实选择走 `contextAssembler` 的启发式；阈值在 `tokenEstimator`（compact=85）和 `cacheAwareCompactPolicy`（compact=90）三处重复且默认值不一致——同一事件流可能被读出不同 compact 状态。

### 核心做法

Phase 1 删死评分脚手架、简化诊断；Phase 2 抽单一 `computeContextThresholds` 让两个消费方委托调用；Phase 3 加一致性测试断言两方对同一输入给出相同 warning/compact/blocking 状态。

### 当前状态

草案。死代码与重复计算都在 runtime 热路径旁，清理风险低、收益是消除误导与潜在不一致 bug。

### 下一步

最小切片：Phase 1 删除未引用的评分类型，先确认无外部引用再删，零行为变更。
