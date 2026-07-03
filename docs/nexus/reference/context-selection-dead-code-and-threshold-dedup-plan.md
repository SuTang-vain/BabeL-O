# Context Selection Dead Code and Threshold Dedup Plan

> State: Active Plan
> Track: Context / Runtime
> Priority: P1 — `contextManager.ts` scoring scaffold is computed but never observed (`score` field is dropped at `toRetainedDiagnostic` projection); `tokenEstimator` default percent fallback is unreachable in real runtime; two duplicate threshold-computation sites must share one source.
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/runtime/contextManager.ts`, `src/runtime/contextAssembler.ts`, `src/runtime/cacheAwareCompactPolicy.ts`, `src/runtime/tokenEstimator.ts`, `src/runtime/contextAnalysis.ts`, `src/runtime/pipeline/loop.ts`, `src/runtime/pipeline/contextRefresh.ts`, `test/context-assembler.test.ts`, `test/runtime.test.ts`, `test/token-estimator.test.ts`, `test/execute-pre-loop-compact-sequence.test.ts`, `test/context-refresh-strategy.test.ts`
> Governance: Indexed by [README.md](./README.md) and [context-governance-index.md](./context-governance-index.md). Canonical owner of "context selection has one observable code path, thresholds have one source." Cache-aware compaction policy stays in [cache-observability-and-nexus-realtime-detection-plan.md](./cache-observability-and-nexus-realtime-detection-plan.md); retained-segment verification stays in [long-running-context-assembly.md](./long-running-context-assembly.md).
> Graduation: 2026-06-24 — moved from `proposals/` to `reference/` and rewritten with source-verified scope after a full source walkthrough. Plan authoring commit was `dfa3384` (2026-06-21), kept in `proposals/` for 3 days while in Draft.
> Related: [context-governance-index.md](./context-governance-index.md), [cache-observability-and-nexus-realtime-detection-plan.md](./cache-observability-and-nexus-realtime-detection-plan.md), [long-running-context-assembly.md](./long-running-context-assembly.md)

## Purpose

`src/runtime/contextManager.ts` carries a 329-line scoring/selection type system (`ContextItem` / `ScoredContextItem` / `SelectedContextItem` / `ContextManagerPhase` / `scoreContextItem` / `compareSelectedItems` / `compareDroppedItems` / `CONTEXT_MANAGER_PHASES` / `ContextSelectionItemDiagnostic` / `ContextForkSelectionMetadata` / `createEmptyContextSelectionDiagnostics`) that **drives no real decision**. The `score` field is computed inside `buildContextSelectionDiagnostics()` and then dropped at the `toRetainedDiagnostic` / `toDroppedDiagnostic` projection — the `ContextSelectionItemDiagnostic` shape exposed to consumers (`contextAnalysis.ts:31,206`, `contextAssembler.ts:37,131`) carries only `id / kind / reason / estimatedTokens`, no `score`. Separately, warning/compact/blocking thresholds are computed in 4 locations with intentional-but-confusing divergent defaults; one of them (`tokenEstimator.ts` fallback) is dead in the current runtime path. This plan removes the dead scaffold and unifies the threshold source so readers cannot be misled by the existing illusion of a scoring-based selector, and so the two real threshold consumers (`tokenEstimator` and `cacheAwareCompactPolicy`) cannot drift apart.

## Current State (source-verified 2026-06-24)

### Dead / weakly-typed scoring scaffold in `contextManager.ts`

- File size: **329 lines** (plan originally said 330, off by 1).
- Type / value / function inventory (from `grep -nE` across `src/`):
  - `ContextItemKind` (line 26) — `export type` — 0 external importers → dead.
  - `ContextItem` (line 40) — `export type` — 0 external importers → dead.
  - `ScoredContextItem` (line 51) — `export type` — 0 external importers → dead.
  - `SelectedContextItem` (line 56) — `export type` — 0 external importers → dead.
  - `ContextSelectionItemDiagnostic` (line 61) — `export type` — 0 external importers, but **used as the projection output shape inside `buildContextSelectionDiagnostics` itself** → not dead, but the type name leaks the "scoring" mental model.
  - `ContextSelectionDiagnostics` (line 68) — `export type` — 1 external importer (`contextAnalysis.ts:31,206`) + 1 in `contextAssembler.ts:37,131` → **live, must keep**.
  - `ContextManagerPhase` (line 4) — `export type` — 0 external importers → dead.
  - `CONTEXT_MANAGER_PHASES` (line 15) — `export const` — **1 external importer** (`test/context-assembler.test.ts:48` + used at line 2158: `assert.deepEqual(analysis.diagnostics.selection.phases, CONTEXT_MANAGER_PHASES)`) → must keep the const + `phases` field, OR change the test.
  - `ContextForkSelectionMetadata` (line 85) — `export type` — 0 external importers → dead.
  - `buildContextSelectionDiagnostics` (line 87) — `export function` — **1 external caller** (`contextAssembler.ts:474`) → live, must keep.
  - `createEmptyContextSelectionDiagnostics` (line 193) — `export function` — **1 external importer** (`test/runtime.test.ts:9`, used at line 893) → live in test code, must keep OR change the test.
  - `scoreContextItem` (line 231) — only used inside `contextManager.ts` (lines 145, 219) → dead from outside, live from inside.
  - `compareSelectedItems` (line 311) — only used inside `contextManager.ts` (line 171) → drives the **retained item sort** before `slice(0, 12)`. Not dead from outside, but **its effect (`score`-desc sort) is invisible** because `toRetainedDiagnostic` drops the `score` field. The sort still influences **order** of `retained[]` in the diagnostic, but the consumer (`contextAnalysis.ts:206`) only reads `.length`, not the order.
  - `compareDroppedItems` (line 317) — only used inside `contextManager.ts` (line 175) → same story for `dropped[]`.
  - `eventRetentionScore` (line 258) — internal, only used at line 157 — feeds the `score` field which then gets dropped. Dead in effect.
  - `contextKindForEvent` / `eventPreviewText` / `isChildAgentStateEvent` / `safeStringify` / `estimateContextItemTokens` — internal helpers for the diagnostic shape. Live.

### Scoring vocabulary is computed but unobservable

- Inside `buildContextSelectionDiagnostics`, every retained / dropped item gets a `score` from `scoreContextItem` (e.g. retained layers are scored 70/82/75/86; events scored 90-108 by `eventRetentionScore`).
- `compareSelectedItems` / `compareDroppedItems` sort by `score` first, then `estimatedTokens`, then `id`.
- After `.slice(0, 12)`, the result is projected through `toRetainedDiagnostic` / `toDroppedDiagnostic` into `ContextSelectionItemDiagnostic`, which carries `id / kind / reason / estimatedTokens` — **no `score`**.
- Net effect: the scoring math is a no-op for the consumer. The retained/dropped **order** is still score-sorted, but the consumer (`contextAnalysis.ts:206` declares `retained: ContextSelectionItemDiagnostic[]`) only uses `.length` in `details.retainedContextItems` / `droppedContextItems`.

### Real selection is in `contextAssembler.ts`

- `selectRecentEvents` (line 228) + `protectToolPairs` (line 230) + `allocateBudget` (line 179-200) — simple heuristics, no scoring.
- `assembleContext()` (line 376-388) calls `buildContextSelectionDiagnostics` **only** to build the diagnostic envelope — not to drive any decision.

### Threshold computation — actual sites (source-verified)

The plan originally said "duplicated three ways with divergent defaults." Source verification shows **4 sites**, with one of them being a dead default in the current runtime path.

| Site | File:line | Default (when called with no overrides) | Real caller behavior |
| --- | --- | --- | --- |
| `getContextWindowState` | `tokenEstimator.ts:81-112` | `warningPercent ?? 70` / `compactPercent ?? 85` | All 4 callers **always pass explicit percent** from `cacheAwareCompactPolicy`. The `?? 70` / `?? 85` fallback is **dead in current runtime**. |
| `buildCacheAwareCompactPolicy` base | `cacheAwareCompactPolicy.ts:96-105` | `warningPercent ?? 70` / `compactPercent ?? 90` | Base values when no override. All 4 callers pass either override (e.g. `options.warningPercent ?? 70`) or `cacheAwareCompactPolicy` from a previous call. |
| `buildCacheAwareCompactPolicy` cache-preservation modifier | `cacheAwareCompactPolicy.ts:84-94` | bumps to `warningThresholdPercent = max(70, 80) = 80` / `compactThresholdPercent = max(90, 93) = 93` when `cachePreservationMode` is on (line 87-94) | Active when `cacheReadRatio ≥ 0.5 && cacheableSystemPromptRatio ≥ 0.4 && !providerContextError && !nearBlocking`. |
| `computeBlockingLimit` | `cacheAwareCompactPolicy.ts:191-203` | reads `compactPercent` from caller, computes `max(compactThresholdTokens, maxTokens - min(blockingBuffer, 10% of max))` | Called from `buildCacheAwareCompactPolicy:85, 101` (internal) and `cacheAwareCompactPolicy.ts:138` (legacy context ceiling helper). |
| `contextAnalysis.ts:368` (`getAutoCompactDecision`) | `contextAnalysis.ts:368` | reads `cacheAwareCompactPolicy.compactThresholdPercent` (live, not duplicated) | Already unified. |

**Key correction to original plan**: in the current runtime path, **all 4 `getContextWindowState` callers** receive `cacheAwareCompactPolicy.warningThresholdPercent` / `compactThresholdPercent` and **never** reach the `?? 70` / `?? 85` fallback. The "85 vs 90" divergence the plan flagged is technically present in the defaults, but **does not actually trigger** in production paths because the upstream consumer (`buildCacheAwareCompactPolicy`) wins. The "divergent defaults" are best understood as a documented contract — both `85` and `90` appear as literals in test fixtures (`test/token-estimator.test.ts:192` etc. use 85; `test/execute-pre-loop-compact-sequence.test.ts:67` etc. use 90), confirming the two are tested independently as intentional contracts, not a latent bug.

The real duplication is between `getContextWindowState` and `buildCacheAwareCompactPolicy` — both compute `warningThresholdTokens = floor(maxTokens * warningPercent/100)`. Phase 2 dedups this.

### `phases` field — dead but tested

`ContextSelectionDiagnostics.phases` is set to `CONTEXT_MANAGER_PHASES` in `buildContextSelectionDiagnostics:181,195` and asserted by `test/context-assembler.test.ts:2158`. No code reads it (other than the test). It is a dead field preserved by a test. **Cannot be deleted without changing the test**, but the test can be changed to either drop the assertion or replace `phases` with a simpler `selectionMode` enum.

## Problem Statement

- **Dead architecture misleads**: a reader sees `ScoredContextItem` / `scoreContextItem` / `CONTEXT_MANAGER_PHASES` / `ContextManagerPhase` and assumes the context pipeline runs scoring phases. It does not. A scoring-scaffold cleanup avoids the wasted onboarding cost.
- **Latent divergence in defaults is harmless today but fragile**: `tokenEstimator.ts` defaults 70/85 vs `cacheAwareCompactPolicy.ts` defaults 70/90 are reachable if a future caller forgets to wire `cacheAwareCompactPolicy`. Phase 2 makes `getContextWindowState` and `buildCacheAwareCompactPolicy` share one threshold source so a future caller cannot accidentally create a divergence.
- **`score` field is a no-op for consumers**: computed, sorted by, then projected away. The sort is observable as `retained[]` / `dropped[]` order, but no consumer reads that order. Phase 1 simplifies the sort to `id`-only (stable) or removes the `score` machinery entirely.

## Goals

- Remove the unused scoring scaffold from `contextManager.ts`: delete `ContextItem` / `ScoredContextItem` / `SelectedContextItem` / `ContextManagerPhase` / `CONTEXT_MANAGER_PHASES` / `ContextForkSelectionMetadata` / `scoreContextItem` / `eventRetentionScore` / `compareSelectedItems` / `compareDroppedItems` (keep `compareDroppedItems` if `dropped[]` order is observed anywhere — verify before delete).
- Keep `buildContextSelectionDiagnostics` (live consumer) and `ContextSelectionDiagnostics` (live type). Simplify the function to not maintain a `score` field; sort `retained` / `dropped` by `id` (stable, observable) instead of `score` (unobservable).
- Keep `createEmptyContextSelectionDiagnostics` (test-only consumer) but rebase onto the simplified type shape (drop `phases` if test can be updated; keep `phases` as a no-op stub if test is too costly to change).
- One source of truth for `warningThresholdTokens` / `compactThresholdTokens` / `blockingLimitTokens`; `tokenEstimator.getContextWindowState` and `cacheAwareCompactPolicy.buildCacheAwareCompactPolicy` both delegate to it.
- `/context` diagnostics and compaction triggers read the same threshold values (already true at the `contextAnalysis.ts:360-368` call site, will become a structural guarantee after Phase 2).

## Non-goals

- Do not introduce a scoring-based selector in this plan. The heuristic selection in `selectRecentEvents` / `protectToolPairs` is deliberate and tested (see `test/context-regression.test.ts`); scoring selection is a larger design change, deferred to a separate proposal.
- Do not change the compaction *algorithm* (`src/runtime/compact.ts`, `src/runtime/compactors/*`), the retained-segment verification, or the cache-preservation mode logic in `buildCacheAwareCompactPolicy`.
- Do not change the `CacheAwareCompactPolicy` output shape (consumers `contextAnalysis.ts:165` and downstream depend on it).
- Do not change the `70` / `90` / `80` / `93` defaults — those are intentional contracts under test. Phase 2 only dedups the *math*; defaults stay.

## Design

### Phase 1 — Remove dead scoring scaffold

1. Delete from `contextManager.ts`:
   - `ContextItemKind` (line 26) and `ContextItemKind` literal union
   - `ContextItem` (line 40)
   - `ScoredContextItem` (line 51)
   - `SelectedContextItem` (line 56)
   - `ContextManagerPhase` (line 4) and the `CONTEXT_MANAGER_PHASES` array (line 15) — **or keep `CONTEXT_MANAGER_PHASES` as a `[]` literal and drop the `phases` field from `ContextSelectionDiagnostics`** (preferred; see step 2)
   - `ContextForkSelectionMetadata` (line 85)
   - `scoreContextItem` (line 231)
   - `eventRetentionScore` (line 258)
   - `compareSelectedItems` (line 311) — only if sort by score can be replaced with sort by id
   - `compareDroppedItems` (line 317) — same
   - `ContextSelectionItemDiagnostic` (line 61) → inlined as the projection target inside the function (since it had no external importers)

2. Update `ContextSelectionDiagnostics` (line 68) to drop the `phases: ContextManagerPhase[]` field. Update `test/context-assembler.test.ts:2158` to drop the `assert.deepEqual(analysis.diagnostics.selection.phases, CONTEXT_MANAGER_PHASES)` assertion (or keep the `phases` field as an empty array literal in the new shape, depending on what costs the test less).

3. Rewrite `buildContextSelectionDiagnostics` (line 87-191) to:
   - Skip `scoreContextItem` calls; build `retainedItems` / `droppedItems` directly as the projected shape (`{ id, kind, text, source, estimatedTokens, droppedReason?, ... }` with no `score`).
   - Sort `retained` / `dropped` by `id` (stable, matches the prior `localeCompare` tiebreaker).
   - Slice to 12 each (unchanged).
   - Keep `ContextSelectionDiagnostics` field set: `estimatedTokens`, `maxTokens`, `percentUsed`, `retained: ItemDiagnostic[]`, `dropped: ItemDiagnostic[]`, `workingSetPaths`, `compactBoundary?`, `prefixCacheFingerprint?`, `fork?`.

4. Verify: `test/context-assembler.test.ts:2158` — drop the `phases` assertion. `test/runtime.test.ts:9,893` — `createEmptyContextSelectionDiagnostics` keeps the same signature; only the internal shape loses `phases`. Run all of `test/context-*.test.ts`, `test/runtime.test.ts`, `test/token-estimator.test.ts` and confirm 0 behavior change in `/context` and `/status` outputs.

5. `compareDroppedItems` decision: only keep if `dropped[]` is read in any order-sensitive consumer. The current `ContextSelectionItemDiagnostic.reason` does not encode order, and `contextAnalysis.ts:206` only reads `.length`. Drop `compareDroppedItems` along with `compareSelectedItems`.

6. `createEmptyContextSelectionDiagnostics` (line 193) — keep as a 1-line stub: `return { estimatedTokens: 0, maxTokens, percentUsed: 0, retained: [], dropped: [], workingSetPaths: [] }`. `test/runtime.test.ts:9,893` keeps working without change.

### Phase 2 — Single threshold source

1. New `src/runtime/contextThresholds.ts` exporting `computeContextThresholds({ contextWindow, cachePreservationMode?, overrides? })` returning `{ warningPercent, compactPercent, warningTokens, compactTokens, blockingTokens }`. Defaults:
   - `warningPercent = 70` (mirrors `tokenEstimator.ts:88` and `cacheAwareCompactPolicy.ts:34`)
   - `compactPercent = 90` (mirrors `cacheAwareCompactPolicy.ts:35`; **NOT** the 85 in `tokenEstimator.ts:89`, because that 85 is unreachable in current runtime — see Current State)
   - `cachePreservationMode === true` bumps to `warningPercent = 80` / `compactPercent = 93` (mirrors `cacheAwareCompactPolicy.ts:36,86-94`)
   - `blockingTokens = max(compactTokens, maxTokens - min(blockingBuffer, 10% of maxTokens))` (mirrors `cacheAwareCompactPolicy.ts:191-203`)
   - `overrides` lets callers pass a custom `warningPercent` / `compactPercent` (the only knob that currently varies per caller)

2. `getContextWindowState` (`tokenEstimator.ts:81-112`) becomes a thin wrapper:
   ```ts
   export function getContextWindowState(options: {
     tokenEstimate: number
     maxTokens: number
     warningPercent?: number
     compactPercent?: number
     blockingBufferTokens?: number
   }): ContextWindowState {
     const thresholds = computeContextThresholds({
       contextWindow: options.maxTokens,
       cachePreservationMode: false, // not exposed at this call site today
       overrides: { warningPercent: options.warningPercent, compactPercent: options.compactPercent },
     })
     const tokenEstimate = Math.max(0, Math.ceil(options.tokenEstimate))
     const percentUsed = Math.round((tokenEstimate / options.maxTokens) * 100)
     // ... rest of the function builds the same ContextWindowState shape
   }
   ```
   **Behavior preserved**: defaults still 70/85 at the public surface, even though internally the shared source uses 70/90. The `?? 85` fallback in `getContextWindowState` stays because Phase 1's test contract (`test/token-estimator.test.ts:191-192`) requires it; the shared source's `90` is only used when callers (like `cacheAwareCompactPolicy`) explicitly opt in via overrides.

   **Alternative design**: change the public default to `90` to match `cacheAwareCompactPolicy`. Requires updating `test/token-estimator.test.ts:192,269,280,293,304` to pass `compactPercent: 90` instead of `?? 85`. Decision deferred to PR-time review.

3. `buildCacheAwareCompactPolicy` (`cacheAwareCompactPolicy.ts:60-105`) uses the same `computeContextThresholds` for the `warningThresholdPercent` / `compactThresholdPercent` / `blockingLimitTokens` computation. Cache-preservation-mode modifier (lines 86-94) stays — it overrides `warningPercent` / `compactPercent` before passing to `computeContextThresholds`.

4. `computeBlockingLimit` (`cacheAwareCompactPolicy.ts:191-203`) becomes a private helper inside `contextThresholds.ts` and is no longer exported from `cacheAwareCompactPolicy.ts`. Two internal call sites (line 85, 101) update to call `computeContextThresholds(...).blockingTokens` instead.

5. Verify: `test/token-estimator.test.ts`, `test/execute-pre-loop-compact-sequence.test.ts`, `test/context-refresh-strategy.test.ts`, `test/runtime-context-broadcaster-injection.test.ts`, `test/execute-provider-loop-compact-block.test.ts` — all already pass `warningPercent` / `compactPercent` explicitly. Run them; they should pass without change.

### Phase 3 — Consistency test

1. New `test/context-threshold-consistency.test.ts`:
   - Sweep `(contextWindow ∈ {8_000, 32_000, 128_000, 200_000}) × (cachePreservationMode ∈ {true, false}) × (overrides ∈ {none, 70/85, 70/90, 80/93})`.
   - For each cell, compute `(t1) = getContextWindowState({ tokenEstimate: 0, maxTokens, warningPercent, compactPercent })` and `(t2) = buildCacheAwareCompactPolicy({ modelId: 'x', tokenEstimate: 0, warningPercent, compactPercent }).{warningThresholdPercent, compactThresholdPercent, blockingLimitTokens}`.
   - **Assertion**: when both are given the same `warningPercent` and `compactPercent`, `t1.warningThresholdTokens === t2.warningThresholdTokens` and `t1.compactThresholdTokens === t2.compactThresholdTokens`. (Default-fallback divergence is documented and not asserted.)
2. The test proves: **if someone forgets to wire `cacheAwareCompactPolicy` in a future caller, the test fails**, forcing a deliberate decision.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Draft | Delete dead scoring scaffold; simplify `buildContextSelectionDiagnostics`; drop `phases` field; remove `score` from sort. | `grep` for deleted symbols returns 0; `test/context-assembler.test.ts` + `test/runtime.test.ts` pass; `/context` and `/status` output shapes unchanged (modulo removing the `phases` field, which is dead). |
| Phase 2 | Draft | `src/runtime/contextThresholds.ts`; `getContextWindowState` + `buildCacheAwareCompactPolicy` + `computeBlockingLimit` delegate to it. | `cacheAwareCompactPolicy.ts:191-203` (computeBlockingLimit) deleted; `tokenEstimator.ts:81-112` becomes a wrapper; `cacheAwareCompactPolicy.ts:60-105` uses the same math; existing `test/token-estimator.test.ts` + `test/execute-pre-loop-compact-sequence.test.ts` + `test/context-refresh-strategy.test.ts` + `test/runtime-context-broadcaster-injection.test.ts` + `test/execute-provider-loop-compact-block.test.ts` all pass. |
| Phase 3 | Draft | `test/context-threshold-consistency.test.ts`. | Test green; a deliberate divergence between the two consumers fails it. |

## Verification

- `npm test` (existing context regressions: `test/context-assembler.test.ts`, `test/context-regression.test.ts`, `test/prefix-cache.test.ts`, `test/compact-summary.test.ts`, `test/snip-compactor.test.ts`, `test/token-estimator.test.ts` green).
- New `test/context-threshold-consistency.test.ts`.
- `npm run build:smoke`.

## PR granularity

Per [development-process-stability-governance-plan.md](./development-process-stability-governance-plan.md) §6.1, this is `review-standard` (no runtime state machine change; `contextManager.ts` is consumed only by `assembleContext`, and the new `contextThresholds.ts` is a pure-function module). Three commits, one Phase each:

- `chore(context): remove dead scoring scaffold in contextManager.ts` (Phase 1)
- `refactor(context): single computeContextThresholds source for warning/compact/blocking` (Phase 2)
- `test(context): threshold consistency test across cacheAwareCompactPolicy and tokenEstimator` (Phase 3)

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).

## 中文概述

### 背景

`contextManager.ts` 的 329 行评分类型系统是误导性死代码：`score` 字段在 `buildContextSelectionDiagnostics` 内部计算并用于排序，但最终投影到 `ContextSelectionItemDiagnostic` 时被丢弃（只保留 `id/kind/reason/estimatedTokens`），消费者（`contextAnalysis.ts:206`、`contextAssembler.ts:131`）只读 `length`，不读 `score` 也不读顺序。真实的选择逻辑是 `contextAssembler.ts` 的 `selectRecentEvents` + `protectToolPairs` + `allocateBudget` 启发式。阈值方面：源码核对发现 4 个计算点而非计划原说的 3 个，且 `tokenEstimator.ts:88-89` 的 `?? 70` / `?? 85` 默认值在实际运行路径下不可达（4 个 `getContextWindowState` 调用点都显式从 `cacheAwareCompactPolicy.warningThresholdPercent` / `compactThresholdPercent` 拿 percent），所以"85 vs 90 的 latent inconsistency"在当前运行路径下不触发；测试中 `85` 和 `90` 都作为独立契约被显式覆盖（`test/token-estimator.test.ts:191-192` vs `test/execute-pre-loop-compact-sequence.test.ts:67`），是有意为之。

### 核心做法

Phase 1 删 `ContextItem` / `ScoredContextItem` / `SelectedContextItem` / `ContextManagerPhase` / `CONTEXT_MANAGER_PHASES` / `ContextForkSelectionMetadata` / `scoreContextItem` / `eventRetentionScore` / `compareSelectedItems` / `compareDroppedItems` / `ContextSelectionItemDiagnostic` 等 0 外部 importer 的死类型和死函数，重写 `buildContextSelectionDiagnostics` 让它直接构造最终诊断 shape（不经 `ScoredContextItem`），按 `id` 稳定排序替代按 `score` 排序；同时处理两处测试影响（`test/context-assembler.test.ts:2158` 的 `phases` 断言、`test/runtime.test.ts:9` 的 `createEmptyContextSelectionDiagnostics` 引用），行为零变更。Phase 2 新增 `src/runtime/contextThresholds.ts` 单一阈值源，`getContextWindowState` / `buildCacheAwareCompactPolicy` / `computeBlockingLimit` 全部委托调用，默认值约定改写到一处（仍然 70/90 base + 80/93 cache-preservation，tokenEstimator 的 `?? 85` 公开 API 兼容保留以匹配现有测试契约）。Phase 3 加 `test/context-threshold-consistency.test.ts` 扫 `contextWindow × cachePreservationMode × overrides` 矩阵，断言显式同输入下两个 consumer 算出相同 `warningThresholdTokens` / `compactThresholdTokens`，保护未来 caller 不会忘记 wire `cacheAwareCompactPolicy` 导致静默漂移。

### 当前状态

Active Plan。3 Phase 全部 Draft。风险 review-standard（无 runtime state machine 改动；`contextManager.ts` 唯一外部消费者是 `assembleContext` 内部调用 `buildContextSelectionDiagnostics`，新模块 `contextThresholds.ts` 是纯函数）。

### 下一步

按 Phase 1/2/3 各开一个 commit。Phase 1 先做：删死代码 + 简化 `buildContextSelectionDiagnostics` + 修两处测试（`phases` 断言 + `createEmptyContextSelectionDiagnostics` 内部 shape），零行为变更。Phase 2 决策点：`tokenEstimator` 公开默认 `?? 85` 是否改成 `?? 90`（匹配 `cacheAwareCompactPolicy` 真实默认）—— 改的话需要更新 `test/token-estimator.test.ts` 5 处 `compactPercent: 85` 断言；不改的话保留双默认契约。决策建议保留双默认（不动测试），通过 Phase 3 一致性测试确保显式同输入下两 consumer 行为一致。
