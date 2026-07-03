# Adaptive Context Window Selection Plan

> State: Closed Reference
> Track: Runtime / Context
> Priority: P0 — real-session regression: every prompt re-trimmed the event window and tool results via fixed caps regardless of actual context headroom, silently dropping prior thinking / tool results on an 852k-context model at single-digit usage. Phase 0/1/2 closed 2026-06-22.
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../WORK_LOG.md](../WORK_LOG.md), `src/runtime/contextAssembler.ts`, `src/runtime/cacheAwareCompactPolicy.ts`, `src/runtime/tokenEstimator.ts`, `src/runtime/pipeline/contextRefresh.ts`, `src/runtime/compact.ts`, `src/runtime/compactors/microCompact.ts`, `src/runtime/compactors/snipCompactor.ts`, `test/context-assembler.test.ts`, `scripts/repro-adaptive-context-window-260622.mjs`, `scripts/repro-adaptive-context-phase2-260622.mjs`
> Governance: Indexed by [README.md](./README.md). Canonical owner of "when the per-assembly event-window selection and tool-result compaction trims history". The threshold-gated full compact (`compact_boundary`) stays owned by [context-governance-index.md](./context-governance-index.md) + `src/runtime/compact.ts`; cache-aware threshold policy stays in [cache-observability-and-nexus-realtime-detection-plan.md](./cache-observability-and-nexus-realtime-detection-plan.md); three-tier context model (Working Set / Recent / On-Demand) stays in [long-running-context-assembly.md](./long-running-context-assembly.md); PR review level for this change is `review-high-risk` per [development-process-stability-governance-plan.md](./development-process-stability-governance-plan.md) §6.1.
> Related: [long-running-context-assembly.md](./long-running-context-assembly.md), [cache-observability-and-nexus-realtime-detection-plan.md](./cache-observability-and-nexus-realtime-detection-plan.md), [context-governance-index.md](./context-governance-index.md), [development-process-stability-governance-plan.md](./development-process-stability-governance-plan.md)

## Purpose

There are two independent "compression" paths in the runtime. This plan governs the second one — the **per-assembly event-window selection** that runs on every `assembleContext` call — and the bug that it trims history to a fixed 4-turn window regardless of how much context headroom remains. The first path (the threshold-gated full `compactSession` that emits `compact_boundary`) is correctly threshold-gated at 90%/93% and is **out of scope**; this plan must not touch it.

## Current State

Source-verified facts:

- **`selectRecentEvents` enforces a fixed turn cap AND a fixed event cap, neither headroom-aware.** `src/runtime/contextAssembler.ts:661-697` walks backwards from the last user message and breaks when `keptTurns + 1 > maxTurns` OR when `candidateLen > maxEvents && keptTurns > 0`. `maxTurns` = `budget.recentTurnLimit`; `maxEvents` = `budget.recentEventLimit`.
- **`recentTurnLimit` is a coarse model-size proxy, not a usage proxy.** `src/runtime/contextAssembler.ts:198`: `recentTurnLimit: maxTokens >= 100_000 ? 4 : 2`. So a 852k-context model gets `4`, a 8k model gets `2`. The value is computed once in `allocateBudget` from `modelContextWindow` only — it never sees `tokenEstimate` or `percentUsed`.
- **`recentEventLimit` interacts with turn size to make the effective window smaller than `recentTurnLimit`.** `src/runtime/contextAssembler.ts:197`: `recentEventLimit: Math.max(20, Math.min(300, Math.floor(maxTokens / 400)))` → 300 for any model ≥ 120k. On a session where one turn spans >300 events (common: thinking_delta + assistant_delta + tool calls), the `candidateLen > maxEvents && keptTurns > 0` break fires on the second-to-last turn, so only the **last** turn is kept — not 4. Verified by the Phase 0 repro: `session_cd42cb65` retains 1 of 11 turns.
- **The selection runs on every `assembleContext` with no percent gate.** `src/runtime/contextAssembler.ts:228` `selectRecentEvents(compactAwareEvents, budget)` is unconditional. At 3% usage it still cuts to ≤4 turns. At 89% it also cuts to ≤4 turns. The cut is not a recovery measure; it is the default.
- **`selectOmittedEvents` + `summarizeSessionEvents` then one-line-summarize everything outside the window.** `src/runtime/contextAssembler.ts:233-241`. The dropped turns are reduced to a short `summarizeSessionEvents` string, losing tool results, thinking deltas, and assistant output detail.
- **`microcompact` and `snip` also run unconditionally with fixed char thresholds.** `src/runtime/contextAssembler.ts:193-196` sets `snipToolOutputChars` / `microcompactToolOutputChars` from `maxChars * 0.08` etc., and `:242-248` runs them every assembly. These are a secondary loss but smaller than the turn-cap loss.
- **The threshold-gated full compact is correctly NOT firing.** `getAutoCompactDecision` (`src/runtime/compact.ts:222-252`) gates on `percentUsed >= compactThresholdPercent` (default 90%, cache-preserving 93%). Verified against `session_cd42cb65` below: zero `compact_boundary` events, peak usage 18%.

## Problem Statement

Real-session evidence — `session_cd42cb65-bc34-4a49-9923-8d43cb4f5fe4` (2026-06-22, `deepseek/deepseek-v4-pro`, 852,000-token ceiling, cwd `/Users/tangyaoyue`):

- 11 user turns, 20,540 events. Zero `compact_boundary` / `compact_failure` / `context_blocking` events for the entire session (the threshold gate worked).
- Peak context usage was **18%** (149,905 / 852,000 tokens) at turn 8 end (`07:43:42`).
- At the start of turn 9 (`07:44:51`, `initial_refresh`) the token estimate dropped back to **3% (25,472 tokens)** — a loss of ~125k tokens of prior thinking, tool results, and assistant output.
- This 18% → 3% drop repeated at the start of **every** turn. Each `initial_refresh` returned to ~25k / 3%, because `selectRecentEvents` re-trimmed the window regardless of the 82% headroom available.
- **Phase 0 repro (`scripts/repro-adaptive-context-window-260622.mjs`) against the real event stream:** `selectRecentEvents` retains **1 of 11** user turns (not the nominal 4) because `recentEventLimit=300` trips before a second turn fits. The selected window is ~2% of the 852k ceiling; the runtime reported ~3% throughout. So the fixed caps discard 10 turns of history at single-digit usage.

The user-visible symptom — "context is compressed on every prompt instead of only at 80%/90%" — is this per-assembly fixed window, **not** the threshold-gated compact. The compact gate is healthy; the selection gate does not exist.

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

### Core change: headroom-aware window selection in `selectRecentEvents`

Pass the current context window state into `selectRecentEvents` so it can decide whether to enforce the turn cap AND the event cap. Both caps must relax at low usage — the Phase 0 repro showed `recentEventLimit=300` is the binding constraint (it trips before a second turn fits, yielding 1-of-11 turns retained), so relaxing only `recentTurnLimit` would not fix the regression.

```text
// Pseudo — actual impl stays in contextAssembler.ts
function selectRecentEvents(events, budget, windowState?):
  if windowState is undefined OR windowState.percentUsed < warningThresholdPercent:
    # Low usage: preserve all turns. Both caps relax:
    #   - maxTurns -> effectively unlimited (all user turns)
    #   - maxEvents -> raised to a high safety ceiling (e.g. 10x recentEventLimit)
    #     so a multi-hundred-event turn does not trip the second-turn break.
    # Recovery-boundary slice still applies.
    return sliceFromRecoveryBoundary(events) bounded by raisedMaxEvents
  else:
    # At/above warning: fall back to the existing turn+event cap logic so
    # the window shrinks as usage climbs toward compact.
    return existingTurnCapSelection(events, budget)
```

- **Gate = warning threshold, not compact threshold.** Use `windowState.isWarning` (70% / 80% cache-preserving) as the trim-on switch. Below warning → full history. Above warning → existing caps. Trimming only starts when the runtime is already signaling "getting full," and the full compact at 90% is still the hard reset.
- **Both caps relax at low usage.** `recentTurnLimit` becomes "at most N when trimming"; `recentEventLimit` becomes "at most M when trimming," with a raised low-usage ceiling so a fat turn does not collapse the window to 1 turn. The low-usage ceiling is still bounded (pathological 50k-event sessions still get capped) but far above 300.
- **`windowState` is already computed** in `buildRuntimeContextRefreshState` (`src/runtime/pipeline/contextRefresh.ts:298`) — but it is computed *after* `assembleContext` returns. The fix requires computing a pre-selection estimate (or passing a cheap prior estimate) into `assembleContext`. Options:
  - **Option A (preferred):** compute a cheap token estimate from the event slice before `selectRecentEvents` and pass `percentUsed` via the budget or a new `ContextAssemblerOptions` field. The estimate need not be exact — it only gates a binary "trim or not."
  - **Option B:** thread the *previous* turn's `contextWindowState` (already cached on the runtime) into `assembleContext` as `priorWindowState`. Cheaper (no re-estimate) but one turn stale.
  - Phase 1 picks Option A for correctness; Option B is the fallback if the pre-estimate proves too costly on the hot path.

### Budget: make `recentTurnLimit` and `recentEventLimit` ceilings, not constants

`allocateBudget` (`src/runtime/contextAssembler.ts:179-200`) keeps `recentTurnLimit` and `recentEventLimit` as the **maximum** values when trimming is active. They are no longer the always-on values. Naming stays for back-compat; semantics shift from "always 4 turns / 300 events" to "at most 4 turns / 300 events when trimming; unlimited turns / raised event ceiling when headroom is available."

### What stays fixed

- `recentEventLimit` (the event-count safety cap, `maxTokens / 400`) stays as a hard ceiling regardless of usage — it prevents a pathological 50k-event session from loading everything even at low percent.
- `protectToolPairs`, `selectOmittedEvents`, `summarizeSessionEvents` pipelines stay. They just receive more events when usage is low (good — more detail retained) and fewer when usage is high (unchanged from today).
- `compact_boundary` / `compact_failure` event shape and triggers unchanged.

### Phase 2: headroom-gated `microcompact` / `snip`

Phase 1 closed the turn-retention gap, but real-session `session_75d74b74` showed the user-visible "compressed every prompt" symptom persists. Root cause traced to `microcompact` (`src/runtime/compactors/microCompact.ts`) and `snip` (`src/runtime/compactors/snipCompactor.ts`), which run unconditionally on every `assembleContext` with fixed char thresholds (`microcompactToolOutputChars` = 4,000, `snipToolOutputChars` = up to 20,000). At 3–22% usage they still shrink every tool_result above 4,000 chars into a summary, discarding the raw Read / ListDir / Bash / Glob output the model needs to ground later turns.

The fix reuses the SAME headroom signal Phase 1 threads into `assembleContext` (the pre-selection token estimate + `readSelectionHeadroomWarningPercent`). When headroom is available:

- `microcompactToolOutputChars` and `microcompactInternalTextChars` are raised (or skipped) so tool_results above 4,000 chars are preserved verbatim. Raising is preferred over skipping so the dedup path (repeated identical tool_results) still collapses true duplicates — only the size-based summarization relaxes.
- `snipToolOutputChars` and `snipPriorTurnToolOutputChars` are raised similarly so the turn-boundary snipper does not pre-emptively truncate older tool outputs.

At/above the warning threshold, the existing fixed thresholds apply unchanged. Back-compat: the headroom signal is the same optional field Phase 1 added; when absent (callers that do not compute a pre-selection estimate), legacy thresholds apply.

The pre-selection estimate is computed once in `assembleContext` (Phase 1 already does this) and passed to `microcompactEventsWithMetrics` / `snipEventsWithTurnBoundary` via the budget or an explicit headroom arg. No new estimate pass.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 0 | Closed 2026-06-22 | This plan, indexed in `proposals/README.md`, with a reproduction script that loads `session_cd42cb65` and asserts the current `selectRecentEvents` drops 10 of 11 turns at ~3% usage (1 turn retained, not the nominal 4, because `recentEventLimit=300` trips first). | Reproduction script committed (`scripts/repro-adaptive-context-window-260622.mjs`); `npm run docs:check` passes; REPRO PASS confirmed. |
| Phase 1 | Closed 2026-06-22 | Headroom-aware `selectRecentEvents` (gate on `percentUsed < warningThreshold`); relax BOTH `recentTurnLimit` and `recentEventLimit` at low usage (turn cap → Infinity, event cap → Infinity — the token estimate is the real budget signal); thread a pre-selection token estimate into `assembleContext` via `mapEventsToMessages` + `estimateContextTokens` (Option A); env-overridable `BABEL_O_SELECTION_HEADROOM_WARNING_PERCENT`; 6 unit tests for low-usage-full-retention, fat-turn retention, high-usage-trim, back-compat, and recovery-boundary interaction. | Reproduction script shows all 11 user turns retained at ~3% usage on `session_cd42cb65` (was 1 of 11); `context-assembler` tests green (62/62, two legacy fixtures gated via env to keep exercising the trim path); compact/context/runtime regression cluster 335/335 green; `npm test` / `typecheck` / `deps:audit` / `docs:check` green. |
| Phase 2 | Closed 2026-06-22 | Gate `microcompact` / `snip` char thresholds on the same headroom signal, so low-usage assemblies stop pre-emptively shrinking tool outputs. **Promoted from Watch after real-session evidence**: `session_75d74b74` (5 turns, 7,974 events, 852k deepseek-v4-pro) — `selectRecentEvents` retains all 5 turns (Phase 1 works), but `microcompact` unconditionally dropped 39,866 tokens / 159,462 bytes across 18 tool_results >4,000 chars at 3–22% usage. Fix: at headroom, `microcompactToolOutputChars` / `snipToolOutputChars` → Infinity (size-based trimming skipped, dedup still fires); legacy thresholds apply at/above warning. | Reproduction script (`scripts/repro-adaptive-context-phase2-260622.mjs`) shows 7 large tool_results preserved at 22% usage (legacy preserved 0); 5 unit tests for headroom-preserves-large, legacy-trims, dedup-still-fires, snip-headroom, snip-legacy; `context-assembler` 67/67; regression cluster 347/347; `typecheck` / `deps:audit` / `docs:check` green. |
| Phase 3 | Closed 2026-06-22 | Graduate this proposal to `reference/` as `Active Plan` once Phase 1 + Phase 2 are closed against real sessions; summarize implementation into `DONE.md` / `WORK_LOG.md`. | Document lifecycle move verified by `npm run docs:check` (failureCount 0); `reference/README.md` updated; `proposals/README.md` carries the graduation note; implementation recorded in `DONE.md` + `WORK_LOG.md`. |
| Phase 4 | Closed 2026-06-22 | Relax the `recovery-boundary` slice in `selectRecentEvents` under headroom. Real-session evidence: `session_8d6fc33d` (7 turns, 852k deepseek-v4-pro) — a `REQUEST_CANCELLED` at seq 4751 (turn 3 cancelled, turn 4 "继续任务") caused `selectRecentEvents` to slice off everything before the recovery boundary, dropping turns 1–3 (~215k tokens of deep analysis) from turn 4 onward even at 2–5% usage. Fix: when `hasHeadroom`, skip the recovery-boundary slice; `protectToolPairs` still pairs tool_started/tool_completed. Legacy slice applies at/above warning. | Reproduction script (`scripts/repro-adaptive-context-phase4-260622.mjs`) shows turns 4–7 retain all prior history across REQUEST_CANCELLED (legacy retained 1/4–4/7; Phase 4 retains 4/4–7/7); 2 unit tests for headroom-keeps-across-recovery and legacy-still-slices; `context-assembler` 68/68; regression cluster 348/348; `typecheck` / `deps:audit` / `docs:check` green. |

## Verification

Before closing Phase 1:

- **Reproduction script** (`scripts/repro-adaptive-context-window-260622.mjs`): loads the real `session_cd42cb65` events, runs the new `selectRecentEvents` with the pre-selection estimate, and asserts that at ~3% usage the selected window includes all 11 user turns (was 1 of 11). Primary regression gate.
- **Unit tests** in `test/context-assembler.test.ts`:
  - low usage (< warning%) → all user turns retained (no turn-cap trim);
  - low usage (< warning%) with a fat turn (>300 events) → second-to-last turn still retained (the `recentEventLimit` break no longer trips early);
  - high usage (>= warning%) → existing turn+event cap behavior preserved;
  - `recentEventLimit` raised ceiling still enforced at low usage (pathological 50k-event session still capped);
  - recovery-boundary slice still applied at low usage;
  - `protectToolPairs` still pairs tool_started/tool_completed across the larger low-usage window.
- **No regression in compact path**: `compactSession` tests remain green; `getAutoCompactDecision` threshold logic unchanged.
- **Full gate**: `npm test`, `npm run typecheck`, `npm run format:check`, `npm run deps:audit`, `npm run docs:check`, `npm run build:smoke`.
- **Hot-path parity**: the 6 `refreshRuntimeContextState` call sites compile and behave unchanged except for the larger low-usage window.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); detailed history to [../WORK_LOG.md](../WORK_LOG.md).
- This document keeps only the durable selection-vs-compact boundary, the headroom-gate design, and the regression context. It does not override TODO / DONE / WORK_LOG.
- On close, this document stays in `reference/` as the durable boundary. Implementation facts moved to `DONE.md` / `WORK_LOG.md`; the `proposals/README.md` graduation note points here.

## 中文概述

### 背景

真实 session `session_cd42cb65`（852k 上下文的 deepseek-v4-pro，11 轮）里，每个新 prompt 一开始 token 估计就从 18%（~150k）暴跌回 3%（~25k），前 10 轮的思考/工具结果/assistant 输出全丢。用户感觉"每次 prompt 都在压缩，没到 80%/90% 就丢细节"。但全量 `compact_boundary` 一次都没触发（阈值门控是对的）——真正丢细节的是**每次 `assembleContext` 都跑的固定窗口裁剪**（`selectRecentEvents` + `recentTurnLimit=4` + `recentEventLimit=300`），它不看当前 context 用量，3% 也裁、90% 也裁。Phase 0 复现显示实际只保留 **1/11 轮**（不是名义上的 4 轮），因为 `recentEventLimit=300` 在第二个 turn 装下之前就触发了 break。

### 核心做法

让 `selectRecentEvents` 变成**余量感知**：当 `percentUsed < warning 阈值`（70%/80%）时保留全部 user-turn 历史，**同时放宽** `recentTurnLimit` 和 `recentEventLimit`（低用量时 turn 无上限、event 上限大幅抬高但仍防 50k 事件病态 session），只在到达 warning 阈值后才回退现有的 turn+event 裁剪。`recentTurnLimit` / `recentEventLimit` 从"恒定值"变成"裁剪激活时的上限"。需要把一个廉价的 pre-selection token 估算（或上一轮 `contextWindowState`）透传进 `assembleContext` 作为门控信号。`compact_boundary` / `cacheAwareCompactPolicy` 阈值一律不动。

### 当前状态

Active Plan，Phase 0/1/2/3 全部 Closed（2026-06-22）。分支 `fix/adaptive-context-window-selection` 从 `origin/develop` 切出。

- **Phase 1**（`selectRecentEvents` 余量感知）：`session_cd42cb65` 从 1/11 轮保留 → 11/11。
- **Phase 2**（`microcompact`/`snip` headroom 门控）：`session_75d74b74` 从 0 个大 tool_result 保留 → 7 个（22% 用量），microcompact tokensSaved 从 39,866（全量 size-trim）→ 14,127（仅 dedup）。
- **Phase 3**（本毕业）：提案从 `proposals/` 移入 `reference/`，实现证据落入 `DONE.md` + `WORK_LOG.md`。

两条真实丢上下文路径已闭合：整轮丢弃（Phase 1）+ tool_result 细节缩水（Phase 2）。`compact_boundary` / `cacheAwareCompactPolicy` 阈值全程未动。

### 下一步

无。本计划已收口，长期架构边界由本文档承载，实现事实由 `DONE.md` / `WORK_LOG.md` 承载。未来若发现新的丢上下文路径，另开提案。
