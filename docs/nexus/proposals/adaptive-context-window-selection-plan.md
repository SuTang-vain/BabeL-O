# Adaptive Context Window Selection Plan

> State: Draft
> Track: Runtime / Context
> Priority: P0 — real-session regression: every prompt re-trims the event window to a fixed 4-turn cap regardless of actual context headroom, silently dropping ~125k tokens of prior thinking / tool results on an 852k-context model at 3% usage
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../WORK_LOG.md](../WORK_LOG.md), `src/runtime/contextAssembler.ts`, `src/runtime/cacheAwareCompactPolicy.ts`, `src/runtime/tokenEstimator.ts`, `src/runtime/pipeline/contextRefresh.ts`, `src/runtime/compact.ts`, `test/context-assembler.test.ts`
> Governance: Indexed by [README.md](./README.md). Canonical owner of "when the per-assembly event-window selection trims history". The threshold-gated full compact (`compact_boundary`) stays owned by [../reference/context-governance-index.md](../reference/context-governance-index.md) + `src/runtime/compact.ts`; cache-aware threshold policy stays in [../reference/cache-observability-and-nexus-realtime-detection-plan.md](../reference/cache-observability-and-nexus-realtime-detection-plan.md); three-tier context model (Working Set / Recent / On-Demand) stays in [../reference/long-running-context-assembly.md](../reference/long-running-context-assembly.md); PR review level for this change is `review-high-risk` per [../reference/development-process-stability-governance-plan.md](../reference/development-process-stability-governance-plan.md) §6.1.
> Related: [../reference/long-running-context-assembly.md](../reference/long-running-context-assembly.md), [../reference/cache-observability-and-nexus-realtime-detection-plan.md](../reference/cache-observability-and-nexus-realtime-detection-plan.md), [../reference/context-governance-index.md](../reference/context-governance-index.md), [../reference/development-process-stability-governance-plan.md](../reference/development-process-stability-governance-plan.md)

## Purpose

There are two independent "compression" paths in the runtime. This plan governs the second one — the **per-assembly event-window selection** that runs on every `assembleContext` call — and the bug that it trims history to a fixed 4-turn window regardless of how much context headroom remains. The first path (the threshold-gated full `compactSession` that emits `compact_boundary`) is correctly threshold-gated at 90%/93% and is **out of scope**; this plan must not touch it.

## Current State

Source-verified facts:

- **`selectRecentEvents` enforces a fixed turn cap, not a headroom-aware cap.** `src/runtime/contextAssembler.ts:661-697` walks backwards from the last user message and breaks once `keptTurns + 1 > maxTurns`. `maxTurns` comes from `budget.recentTurnLimit`.
- **`recentTurnLimit` is a coarse model-size proxy, not a usage proxy.** `src/runtime/contextAssembler.ts:198`: `recentTurnLimit: maxTokens >= 100_000 ? 4 : 2`. So a 852k-context model gets `4`, a 8k model gets `2`. The value is computed once in `allocateBudget` from `modelContextWindow` only — it never sees `tokenEstimate` or `percentUsed`.
- **The selection runs on every `assembleContext` with no percent gate.** `src/runtime/contextAssembler.ts:228` `selectRecentEvents(compactAwareEvents, budget)` is unconditional. At 3% usage it still cuts to 4 turns. At 89% it also cuts to 4 turns. The cut is not a recovery measure; it is the default.
- **`selectOmittedEvents` + `summarizeSessionEvents` then one-line-summarize everything outside the window.** `src/runtime/contextAssembler.ts:233-241`. The dropped turns are reduced to a short `summarizeSessionEvents` string, losing tool results, thinking deltas, and assistant output detail.
- **`microcompact` and `snip` also run unconditionally with fixed char thresholds.** `src/runtime/contextAssembler.ts:193-196` sets `snipToolOutputChars` / `microcompactToolOutputChars` from `maxChars * 0.08` etc., and `:242-248` runs them every assembly. These are a secondary loss but smaller than the turn-cap loss.
- **The threshold-gated full compact is correctly NOT firing.** `getAutoCompactDecision` (`src/runtime/compact.ts:222-252`) gates on `percentUsed >= compactThresholdPercent` (default 90%, cache-preserving 93%). Verified against `session_cd42cb65` below: zero `compact_boundary` events, peak usage 18%.

## Problem Statement

Real-session evidence — `session_cd42cb65-bc34-4a49-9923-8d43cb4f5fe4` (2026-06-22, `deepseek/deepseek-v4-pro`, 852,000-token ceiling, cwd `/Users/tangyaoyue`):

- 11 user turns, 20,540 events. Zero `compact_boundary` / `compact_failure` / `context_blocking` events for the entire session (the threshold gate worked).
- Peak context usage was **18%** (149,905 / 852,000 tokens) at turn 8 end (`07:43:42`).
- At the start of turn 9 (`07:44:51`, `initial_refresh`) the token estimate dropped back to **3% (25,472 tokens)** — a loss of ~125k tokens of prior thinking, tool results, and assistant output.
- This 18% → 3% drop repeated at the start of **every** turn. Each `initial_refresh` returned to ~25k / 3%, because `selectRecentEvents` re-trimmed to 4 turns regardless of the 82% headroom available.

The user-visible symptom — "context is compressed on every prompt instead of only at 80%/90%" — is this per-assembly fixed turn cap, **not** the threshold-gated compact. The compact gate is healthy; the selection gate does not exist.

The compounding design error: `recentTurnLimit` was sized for small-context models (8k–32k) where 4 turns can fill the window. On a 852k model, 4 turns is ~25k tokens = 3% of the ceiling, so 97% of the paid-for context is voluntarily abandoned every turn.

## Goals

- `selectRecentEvents` preserves full history when context usage is low; it only trims to the turn cap as usage approaches the warning threshold.
- A long-context model at <70% usage no longer drops prior turns on each new prompt (the `session_cd42cb65` 18%→3% drop disappears).
- The threshold-gated full `compact` path (`compact_boundary`) is unchanged — this plan does not alter when a compact fires.
- The three-tier model (Working Set pinned / Recent / On-Demand) ownership is preserved; this plan only changes how "Recent" is sized per assembly, not the tier boundaries.
- All changes covered by deterministic unit tests + a real-session replay assertion against `session_cd42cb65`.

## Non-goals

- Do not change `compactSession` / `compact_boundary` / `getAutoCompactDecision` thresholds (90% / 93%). The gate is correct.
- Do not change `cacheAwareCompactPolicy` threshold math. Cache-preserving / long-context ceiling logic is out of scope.
- Do not introduce a new orchestrator or storage schema. The fix is inside `contextAssembler.ts` selection + `allocateBudget` budgeting.
- Do not change `contextRecent` / `contextSearch` / `contextSummarize` on-demand tools (separate lane, recently fixed in [context-search-algorithm-robustness-plan.md](../reference/context-search-algorithm-robustness-plan.md)).
- Do not change the 6 `refreshRuntimeContextState` hot-path call sites beyond passing the new budget field if needed.
- Do not touch `microcompact` / `snip` char thresholds in Phase 1 — they are a secondary loss; gate them only if Phase 1 leaves real loss (Phase 2, watch).

## Design

### Core change: headroom-aware turn selection in `selectRecentEvents`

Pass the current context window state into `selectRecentEvents` so it can decide whether to enforce the turn cap.

```text
// Pseudo — actual impl stays in contextAssembler.ts
function selectRecentEvents(events, budget, windowState?):
  if windowState is undefined OR windowState.percentUsed < warningThresholdPercent:
    # Low usage: preserve all turns (still subject to maxEvents safety cap
    # and the recovery-boundary slice). No turn-cap trimming.
    return sliceFromRecoveryBoundary(events) bounded by maxEvents
  else:
    # At/above warning: fall back to the existing turn-cap logic so the
    # window shrinks as usage climbs toward compact.
    return existingTurnCapSelection(events, budget)
```

- **Gate = warning threshold, not compact threshold.** Use `windowState.isWarning` (70% / 80% cache-preserving) as the trim-on switch. Below warning → full history. Above warning → existing 4-turn cap. This means trimming only starts when the runtime is already signaling "getting full," and the full compact at 90% is still the hard reset.
- **`windowState` is already computed** in `buildRuntimeContextRefreshState` (`src/runtime/pipeline/contextRefresh.ts:298`) — but it is computed *after* `assembleContext` returns. The fix requires computing a pre-selection estimate (or passing a cheap prior estimate) into `assembleContext`. Options:
  - **Option A (preferred):** compute a cheap token estimate from the event slice before `selectRecentEvents` and pass `percentUsed` via the budget or a new `ContextAssemblerOptions` field. The estimate need not be exact — it only gates a binary "trim or not."
  - **Option B:** thread the *previous* turn's `contextWindowState` (already cached on the runtime) into `assembleContext` as `priorWindowState`. Cheaper (no re-estimate) but one turn stale.
  - Phase 1 picks Option A for correctness; Option B is the fallback if the pre-estimate proves too costly on the hot path.

### Budget: make `recentTurnLimit` a ceiling, not a constant

`allocateBudget` (`src/runtime/contextAssembler.ts:179-200`) keeps `recentTurnLimit` as the **maximum** turns to retain when trimming is active. It is no longer the always-on value. Naming stays for back-compat; semantics shift from "always 4" to "at most 4 when trimming."

### What stays fixed

- `recentEventLimit` (the event-count safety cap, `maxTokens / 400`) stays as a hard ceiling regardless of usage — it prevents a pathological 50k-event session from loading everything even at low percent.
- `protectToolPairs`, `selectOmittedEvents`, `summarizeSessionEvents` pipelines stay. They just receive more events when usage is low (good — more detail retained) and fewer when usage is high (unchanged from today).
- `compact_boundary` / `compact_failure` event shape and triggers unchanged.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 0 | Draft | This plan, indexed in `proposals/README.md`, with a reproduction script that loads `session_cd42cb65` and asserts the current `selectRecentEvents` drops turns 1–7 at 3% usage. | Reproduction script committed; `npm run docs:check` passes. |
| Phase 1 | Open | Headroom-aware `selectRecentEvents` (gate on `percentUsed < warningThreshold`); thread a pre-selection token estimate into `assembleContext` (Option A); `recentTurnLimit` becomes a ceiling not a constant; unit tests for low-usage-full-retention, high-usage-trim, and recovery-boundary interaction. | Reproduction script shows turns 1–7 retained at 3% usage on `session_cd42cb65`; existing `context-assembler` tests green; `npm test` / `typecheck` / `deps:audit` / `docs:check` green. |
| Phase 2 | Watch | Gate `microcompact` / `snip` char thresholds on the same headroom signal, so low-usage assemblies also stop pre-emptively shrinking tool outputs. Only if Phase 1 leaves a measurable secondary loss on a real session. | A real session shows microcompact/snip still dropping detail at <70% usage after Phase 1, and the gate restores it. |
| Phase 3 | Open | Graduate this proposal to `reference/` as `Active Plan` once Phase 1 is closed against `session_cd42cb65`; summarize implementation into `DONE.md` / `WORK_LOG.md`. | Document lifecycle move verified by `npm run docs:check`; `reference/README.md` updated. |

## Verification

Before closing Phase 1:

- **Reproduction script** (`scripts/repro-adaptive-context-window-260622.mjs`): loads the real `session_cd42cb65` events, runs the new `selectRecentEvents` with the pre-selection estimate, and asserts that at 3% usage the selected window includes user turns 1–7 (not just 4–8). Primary regression gate.
- **Unit tests** in `test/context-assembler.test.ts`:
  - low usage (< warning%) → all user turns retained (no turn-cap trim);
  - high usage (>= warning%) → existing 4-turn cap behavior preserved;
  - `recentEventLimit` hard ceiling still enforced at low usage (pathological event count);
  - recovery-boundary slice still applied at low usage;
  - `protectToolPairs` still pairs tool_started/tool_completed across the larger low-usage window.
- **No regression in compact path**: `compactSession` tests remain green; `getAutoCompactDecision` threshold logic unchanged.
- **Full gate**: `npm test`, `npm run typecheck`, `npm run format:check`, `npm run deps:audit`, `npm run docs:check`, `npm run build:smoke`.
- **Hot-path parity**: the 6 `refreshRuntimeContextState` call sites compile and behave unchanged except for the larger low-usage window.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); detailed history to [../WORK_LOG.md](../WORK_LOG.md).
- This document keeps only the durable selection-vs-compact boundary, the headroom-gate design, and the regression context. It does not override TODO / DONE / WORK_LOG.
- On close, this proposal either graduates to `reference/` (if the boundary is durable) or is summarized into `history/` (if the fix is self-contained). Per `proposals/README.md` lifecycle, it must not remain here indefinitely.

## 中文概述

### 背景

真实 session `session_cd42cb65`（852k 上下文的 deepseek-v4-pro，11 轮）里，每个新 prompt 一开始 token 估计就从 18%（~150k）暴跌回 3%（~25k），前 7 轮的思考/工具结果/assistant 输出全丢。用户感觉"每次 prompt 都在压缩，没到 80%/90% 就丢细节"。但全量 `compact_boundary` 一次都没触发（阈值门控是对的）——真正丢细节的是**每次 `assembleContext` 都跑的固定 4 轮窗口裁剪**（`selectRecentEvents` + `recentTurnLimit=4`），它不看当前 context 用量，3% 也裁、90% 也裁。

### 核心做法

让 `selectRecentEvents` 变成**余量感知**：当 `percentUsed < warning 阈值`（70%/80%）时保留全部 user-turn 历史（仍受 `recentEventLimit` 硬上限和 recovery-boundary 切片约束），只在到达 warning 阈值后才回退到现有的 4 轮裁剪。`recentTurnLimit` 从"恒定 4"变成"裁剪激活时最多 4"。需要把一个廉价的 pre-selection token 估算或上一轮的 `contextWindowState` 透传进 `assembleContext` 作为门控信号。`compact_boundary` / `cacheAwareCompactPolicy` 阈值一律不动。

### 当前状态

Draft。分支 `fix/adaptive-context-window-selection` 已从 `origin/develop` 切出，工作树干净。Phase 1 是最小闭环：余量感知 selectRecentEvents + 透传估算 + recentTurnLimit 语义收敛 + 单测 + 真实 session 重放。Phase 2（microcompact/snip 同步门控）和 Phase 3（毕业到 reference）门控在真实需求。

### 下一步

最小可验证的下一步是 Phase 0：写复现脚本，用 `session_cd42cb65` 跑当前 `selectRecentEvents`，确认 3% 用量时前 7 轮被丢，作为回归基线；随后在 `fix/adaptive-context-window-selection` 分支上推进 Phase 1。
