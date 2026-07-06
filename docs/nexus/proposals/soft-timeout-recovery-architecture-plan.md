# Soft Timeout Recovery Architecture Plan

> State: Draft
> Track: Runtime / Timeout / Architecture
> Priority: P2 — soft-error-retry runtime core has landed; this is the structural follow-up that evaluates whether the remaining hard-abort gap is worth an architecture change.
> Source of truth: [soft-error-retry-continuity-governance-plan.md](./soft-error-retry-continuity-governance-plan.md) (RC-1, Fix A deferred), [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md), `src/nexus/executionStreamLoop.ts`, `src/nexus/executionPreparation.ts`, `src/nexus/executionTimeoutEvents.ts`, `src/nexus/executeStreamRoute.ts`, `test/execute-stream-watchdog.test.ts`, `test/runtime.test.ts`
> Governance: Architectural evaluation — does not implement. Defines options A/B/C/D + a recommendation for a future decision on whether soft-timeout can be made directly recoverable without overturning the single-source watchdog.
> Related: [intent-tool-suppression-stopgap-plan.md](../archive/intent-tool-suppression-stopgap-plan.md)

## Purpose

[soft-error-retry-continuity-governance-plan.md](./soft-error-retry-continuity-governance-plan.md) RC-1 identified that **soft-timeout cannot self-abort** — termination is always the single hard watchdog. seq 924's soft `REQUEST_TIMEOUT` is therefore terminal (`retryable:false`), and the user must manually say "继续" (C4 makes this graceful, but not automatic). This proposal evaluates whether soft-timeout can be made *directly* recoverable, and what the architecture cost of doing so is. It records the four realistic options and recommends a path so that a future implementer does not have to re-derive the constraints.

## Current State (landed, context for this proposal)

- **C4** (#21): "继续" after a soft `REQUEST_TIMEOUT` injects a resume nudge + the truncated in-flight tail ([contextAssembler.ts](../../src/runtime/contextAssembler.ts) `buildResumeFromSoftTerminal`). *Manual* recovery.
- **Slice 2-B** (#18): `buildPartialTimeoutSummary` keeps the in-flight turn tail — the right content for resume.
- **C1** (#17): `severity: 'soft'` on soft denials.
- **single-source watchdog** (intentional, tested): soft-timeout only emits `timeout_budget_exceeded`; termination is always the one watchdog timer in `prepareExecution`.

## Root Cause (RC-1, source-verified)

`buildAbortEventIfNeeded` ([executionStreamLoop.ts:148-172](../../src/nexus/executionStreamLoop.ts)) runs in the `Promise.race(stream, abort)` finally path. When `timeoutSignal.aborted` it emits `REQUEST_TIMEOUT` (`source: "nexus_stream_abort_race"`) and the route treats it as terminal. This bypasses the runtime-layer soft-extension mechanism entirely — the soft cycle only emits events; it has no abort handle.

`startExecutionTimeoutControls` ([executeStreamRoute.ts:183](../../src/nexus/executeStreamRoute.ts)) is constructed **without** the `timeoutController`, so even if the soft cycle wanted to self-abort on extension exhaustion it has no handle to do so. The watchdog timer (registered in `prepareExecution`) is the only thing that holds the abort handle.

seq 924 details: `policy:"soft"`, `softTimeoutMs:180000`, `watchdogTimeoutMs:240000`, `maxSoftTimeoutExtensions:0`, `retryable:false`, `source:"nexus_stream_abort_race"`. The 240s watchdog is only 60s after the 180s soft — even with 1 extension (+180s) the watchdog would fire *during* the extension, so the soft-extension mechanism has no room to express itself before the hard cut.

## Options

### Option A — Overturn single-source watchdog

Thread `timeoutController` into `scheduleSoftTimeoutCycle`; on extension exhaustion the soft cycle self-aborts → `REQUEST_TIMEOUT` with `retryable:true`, `kind:'soft_timeout'`. The watchdog demotes to a hard-cut fallback for runtime hangs, no longer the sole terminator.

- **Pros**: soft-timeout directly recoverable; "继续" resume (C4) can become automatic; aligned with soft-error-retry RC-1 intent.
- **Cons**: overturns an intentional, tested architecture. [execute-stream-watchdog.test.ts:121](../../test/execute-stream-watchdog.test.ts) ("single-source watchdog…aborts both controllers") and [runtime.test.ts:6030](../../test/runtime.test.ts) ("uses watchdog for abort") pin single-source and would both need rewriting. Re-introduces the dual-timer race that single-source was chosen to eliminate.
- **Risk**: **HIGH**.

### Option B — In-architecture reinforcement (already landed)

Keep single-source watchdog unchanged. At watchdog-terminal, mark `retryable:true` (still partial — RC-1 noted `retryable:false`) and preserve partial (Slice 2-B + C4). Soft-timeout stays terminal, but recoverable via manual "继续".

- **Pros**: no architecture change; mostly already in place (C4 + Slice 2-B).
- **Cons**: soft-timeout still terminal; user must manually "继续". C4 makes it graceful, not automatic.
- **Risk**: **LOW** (done).

### Option C — Timeout ratio tuning (config)

Make `watchdogTimeoutMs >> softTimeoutMs + N*extensionMs` so soft extensions have real room before the hard cut. seq 924's 240/180 ratio was caller-set; this option is guidance/per-caller config, not a runtime change.

- **Pros**: no architecture change; lets the soft-extension mechanism actually express itself (today it is starved by the close watchdog).
- **Cons**: does not make soft-timeout self-abort — still terminal at the watchdog, just later. Caller-specific; the runtime cannot enforce a "good" ratio without a policy.
- **Risk**: **LOW** (config/docs).

### Option D — Hybrid: soft-abort-on-exhaust, watchdog as hard fallback

Thread `timeoutController` into the soft cycle (as in A), but the soft cycle self-aborts **only on extension exhaustion**, not on every soft fire. The watchdog stays as the hard-cut fallback for runtime hangs. So:

| Condition | Behavior |
| --- | --- |
| soft fire, extensions remain | emit `timeout_budget_exceeded`, continue (current behavior) |
| extension exhaustion | soft self-aborts → `REQUEST_TIMEOUT` `retryable:true`, `kind:'soft_timeout'` (new) |
| runtime hang (no event cycle) | watchdog hard-cuts → `REQUEST_TIMEOUT` terminal (current behavior, unchanged) |

- **Pros**: soft-timeout recoverable at exhaustion; watchdog still guarantees a hard cut for hangs; single-source semantics preserved for the hang case (the dual-timer surface is narrowed to "soft exhaustion vs hang", not "every soft fire vs watchdog").
- **Cons**: still threads `timeoutController` into the soft cycle (architecture touch — the thing single-source explicitly avoided); [execute-stream-watchdog.test.ts](../../test/execute-stream-watchdog.test.ts) needs a new case for the soft-exhaustion path; a narrow dual-timer surface exists at exhaustion.
- **Risk**: **MEDIUM**.

## Recommendation

**D (hybrid) as the structural target; C (ratio tuning) as the immediate zero-risk mitigation.**

- **C now**: zero-risk, per-caller. Document that `watchdogTimeoutMs` should leave room for `softTimeoutMs + N*extensionMs + buffer` (e.g. watchdog ≥ soft + N·ext + 60s). seq 924's 240/180 violates this. This alone removes the most acute starvation without touching the architecture.
- **D next, if justified by continued soft-timeout pain**: thread `timeoutController` into `scheduleSoftTimeoutCycle`, implement soft-abort-on-exhaust (`retryable:true`, `kind:'soft_timeout'`), update the watchdog tests for the new exhaustion path. D is the smallest change that makes seq 924 directly recoverable (soft-timeout is no longer terminal; "继续" can even auto-resume) while preserving the watchdog's hard-cut guarantee for genuine hangs.
- **A (full overturn) is not justified** while D achieves the user-visible goal — recoverable soft-timeout — with a much narrower change and without rewriting single-source.
- **B is the current state**; acceptable if D's architecture touch is deferred. C4 already makes the manual-resume path graceful.

## Non-goals

- No `maxLoops` raise.
- No removal of the hard-watchdog guarantee — runtime *hangs* (no event cycle) must still hard-cut.
- No standalone finish-window timer that would re-introduce a full second timer (D keeps the finish path inside the soft cycle's existing extension flow).

## Verification (for a future D implementation, not this proposal)

- `soft + 0 extensions` → soft self-abort, `retryable:true`.
- `soft + N extensions`, exhaustion → soft self-abort, `retryable:true`.
- runtime hang (no events) → watchdog terminal (unchanged, `retryable:false`).
- `execute-stream-watchdog.test.ts` updated for the soft-exhaustion path; single-source semantics still hold for the hang case.
- seq 924 replay: soft-timeout → `retryable:true` → "继续" resumes (or runtime auto-continues).

## Rollout (future, if D is pursued)

1. **C (config, now)**: add guidance to execution-preparation docs / a soft assert that `watchdogTimeoutMs > softTimeoutMs + maxSoftTimeoutExtensions*softTimeoutExtensionMs`; caller tuning.
2. **D (hybrid, separate PR)**: thread `timeoutController`; implement soft-abort-on-exhaust; update watchdog tests; TDD red first.

## Risks & Rollback

- **Risk (D): dual-timer race at exhaustion.** Mitigation: exhaustion is a single deterministic transition (extensions hit zero), not a continuous race; the watchdog still hard-cuts if the soft-abort signal is lost.
- **Risk (D): existing watchdog tests break.** Mitigation: the hang path is unchanged; only a new exhaustion case is added. Tests can be additive.
- **Risk (C): callers misconfigure the ratio.** Mitigation: document; do not enforce a hard policy (callers have legitimate reasons for tight ratios on short tasks).
- **Rollback**: C is config/docs (trivial). D is a self-contained branch (timeoutController threading + one new abort path); revertible.

## Relationship to Existing Plans

- [soft-error-retry-continuity-governance-plan.md](./soft-error-retry-continuity-governance-plan.md) — this proposal resolves its RC-1 / deferred Fix A1/A2 with a concrete option set and recommendation.
- [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md) — owns the continuity model; this proposal is architectural-layer input, not a competing plan.

## 中文概述

### 背景

soft-error-retry 的 RC-1 指出:soft-timeout 无法自己 abort——终止永远由单一硬 watchdog 完成。seq 924 的 soft REQUEST_TIMEOUT 因此是 terminal(retryable:false),用户必须手动"继续"(C4 让这变得优雅,但不是自动)。本提案评估:soft-timeout 能否变成**直接可恢复**的,以及这样做的架构代价。

### 根因(已源码验证)

`executionStreamLoop.ts:148-172` 的 `buildAbortEventIfNeeded` 在 `timeoutSignal.aborted` 时直接发 REQUEST_TIMEOUT terminal,绕过 runtime 层的 soft-extension。`startExecutionTimeoutControls`(`executeStreamRoute.ts:183`)构造时**不持有 `timeoutController`**,所以 soft cycle 即使想在 extension 耗尽时自己 abort 也没句柄——只有 watchdog 持有 abort 句柄。seq 924 的 watchdog(240s)只比 soft(180s)多 60s,extension(+180s)期间 watchdog 就 fire,soft-extension 机制没空间表达。

### 四个选项

- **A 推翻 single-source watchdog**:让 soft 自己 abort,watchdog 降级为兜底。高风险——破坏 execute-stream-watchdog.test.ts:121 + runtime.test.ts:6030 守护的有意架构,重新引入双 timer 竞态。
- **B 架构内强化**(已落地):watchdog terminal 时 retryable + partial(C4 + Slice 2-B)。不改架构,但 soft-timeout 仍 terminal,需手动"继续"。
- **C 配比调优**(配置):让 watchdogTimeoutMs >> soft + extensions,给 soft extension 真正空间。零风险,但 soft-timeout 仍 terminal,只是延后。
- **D 混合**:thread timeoutController 进 soft cycle,但 soft **只在 extension 耗尽时**自己 abort(retryable:true),watchdog 仍是 hang 的硬截断兜底。中风险——架构层改动但保留 single-source 对 hang 的语义。

### 推荐

**D 为结构目标,C 为立即可做的零风险缓解**。C(配比文档/软断言)立刻消除 seq 924 的 starvation;D(soft-abort-on-exhaust)是让 seq 924 直接可恢复的最小改动(soft-timeout 不再 terminal,"继续"可自动 resume),同时保留 watchdog 对 hang 的硬截断保证。A(完全推翻)在 D 能达到用户可见目标时不被证明合理。B 是当前状态(C4 已让手动恢复优雅)。

### 不做

不提高 maxLoops;不移除 watchdog 对 hang 的硬截断保证;不引入独立的 finish-window 第二 timer。
