# Soft Error Retry Continuity Governance Plan

> State: Draft
> Track: Runtime / Continuity / Soft Errors
> Priority: P1
> Source of truth: [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md), [intent-guidance-and-prompt-governance-optimization-plan.md](../reference/intent-guidance-and-prompt-governance-optimization-plan.md), `src/nexus/executionStreamLoop.ts`, `src/nexus/executionPreparation.ts`, `src/runtime/intentGuidance.ts`, `src/runtime/pipeline/providerTurn.ts`, `src/runtime/LLMCodingRuntime.ts`, `test/`
> Governance: Promotes the "soft signal" class (soft timeout, intent suppression, soft tool denial) from hard-error presentation to a recoverable continuity path. Composes with — and does not weaken — the over-tooling protection in [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md) (Phase D `final_check` already landed one soft-denial pattern; this plan generalizes it). Must not raise `maxLoops`, must not remove intent suppression, must not bypass permission/scope/risk gates.
> Related: [intent-tool-suppression-stopgap-plan.md](./intent-tool-suppression-stopgap-plan.md), [provider-unavailable-auto-retry-governance-plan.md](./provider-unavailable-auto-retry-governance-plan.md)
> 2026-07-03 implementation — Slice 1 (B1 + B2-lightweight + B3) plus a Slice 3 C1-subset landed on branch `fix/soft-error-retry-continuity`. B1: `self_diagnosis_request` exemption in `shouldSuppressToolsForIntent`. B2-lightweight + C1-subset: `severity: 'soft'` on all three soft-denial events (`TOOL_CALL_SUPPRESSED_BY_USER_INTENT`, `TOOL_DENIED_FINAL_CHECK`, `TOOL_LOOP_FINAL_RESPONSE_ONLY`); event `type` stays `"error"`, full type change deferred to C2. B3: suppression nudge rewritten so the model knows the retry will pass through. **Slice 2 (A1/A2/A3) and the Slice 3 remainder (C2/C3/C4) deferred to separate PRs** — see Rollout for the timeout-refactor and A3-revert rationale. TDD red first; full suite 1269/0; typecheck clean; `docs:check` 0; `format:check` 0.

## Purpose

A growing class of runtime signals are *soft* — the task is still recoverable and the model could finish with one bounded nudge — but they are emitted as `type: "error"` events with `retryable: false` or terminal outcomes. From the user's seat these look identical to real failures, so the user cancels, and a session that was 95% done ends `failed`. This plan defines the soft-error class, separates it from terminal errors, and gives each soft signal a bounded retry/finish path instead of a hard cut.

## Reproduction

`session_2db242ff-478b-4a14-9235-ca61eeeb1d9b` (2026-07-03, this investigation). Three error events in sequence; the session ended `cancelled`:

| seq | code | details (abridged) |
| --- | --- | --- |
| 924 | `REQUEST_TIMEOUT` | `policy:"soft"`, `softTimeoutMs:180000`, `watchdogTimeoutMs:240000`, `maxSoftTimeoutExtensions:0`, `softCycleEvents:1`, `retryable:false`, `source:"nexus_stream_abort_race"` |
| 1024 | `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` | `intent:"correction"`, `actionHint:"respond_only"`, `requiresTools:false`, `intentCategory:"self_diagnosis_request"`, `suppressionReason:"intent:correction:respond_only"`, `attemptedTools:["Grep"]`, `latestUserText:"但是你软超时的话应该主动发起继续任务才对呀"` |
| 1028 | `REQUEST_CANCELLED` | `source:"nexus_stream_abort_race"` — user cancelled |

Trace:

1. **seq 920–924**: the model is mid-stream generating an EverOS embedding diagnostic report (already ~95% complete; last delta ends "代码注释明确警…"). At 180s the soft timeout fires. `buildAbortEventIfNeeded` ([executionStreamLoop.ts:148-172](../../src/nexus/executionStreamLoop.ts)) sees `timeoutSignal.aborted` and emits `REQUEST_TIMEOUT` with `source: "nexus_stream_abort_race"`; `result.success=false`. The model was finishing a text answer, not failing.
2. **seq 927**: user re-engages ("查看并分析你为什么报错了"); the model explains it was a soft-timeout truncation, not a runtime error.
3. **seq 1010**: user follows up "但是你软超时的话应该主动发起继续任务才对呀" — a correction asking the runtime to auto-continue after soft timeout.
4. **seq 1021–1024**: the model begins answering and attempts `Grep` (to cite the `TODO_runtime.md` rule it is referencing). The intake classifier labels the turn `intent=correction / actionHint=respond_only / requiresTools=false / intentCategory=self_diagnosis_request`. `shouldSuppressToolsForIntent` ([intentGuidance.ts:219-224](../../src/runtime/intentGuidance.ts)) returns `true`; `providerTurn.ts:206-272` emits `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` as `type: "error"` (outcome is actually `continue` + nudge).
5. **seq 1028**: the user, seeing a second `error` event, cancels. Session ends `cancelled`.

The user's own `last_user_input` — "软超时的话应该主动发起继续任务才对呀" — is the requirement statement for this plan.

## Root Cause (source-verified)

### RC-1 — Soft timeout is a hard abort, not a finish window

`buildAbortEventIfNeeded` ([executionStreamLoop.ts:148-172](../../src/nexus/executionStreamLoop.ts)) runs in the `Promise.race(stream, abort)` finally path. When `timeoutSignal.aborted` it emits `REQUEST_TIMEOUT` (`source: "nexus_stream_abort_race"`) and the route treats it as terminal. This bypasses the runtime-layer soft-extension mechanism entirely. The `details` payload (`policy/softTimeoutMs/maxSoftTimeoutExtensions/softCycleEvents`) is assembled separately in [executionEventProcessing.ts:99-108](../../src/nexus/executionEventProcessing.ts) and is informational only — it does not gate a retry.

The config side *intends* soft to be extensible: [executionPreparation.ts:143](../../src/nexus/executionPreparation.ts) sets `maxSoftTimeoutExtensions = policy === 'soft' ? (body.maxSoftTimeoutExtensions ?? 1) : 0`. Yet seq 924 recorded `maxSoftTimeoutExtensions: 0` under `policy: "soft"` — the caller passed `0` (or a non-`soft` policy path computed it), so no extension was ever possible. Combined with `retryable: false`, a model that was streaming a finishable answer gets cut off with no recovery entry point.

### RC-2 — Intent suppression is a false positive that renders as an error

`shouldSuppressToolsForIntent` ([intentGuidance.ts:219-224](../../src/runtime/intentGuidance.ts)) suppresses when `!requiresTools || actionHint === 'respond_only'`, with narrow exemptions (`isCurrentStateVerificationRequest`, `isPureMemoryCapabilityQuestion`, `intent === 'status'`). A `self_diagnosis_request` turn — where the model is diagnosing the runtime itself and genuinely needs a read-only tool to cite a rule — is not exempted. seq 1024 hit exactly this: `intentCategory: "self_diagnosis_request"` yet suppression fired because `requiresTools=false`.

Worse, the suppression outcome is `continue` + nudge ([providerTurn.ts:244-272](../../src/runtime/pipeline/providerTurn.ts)) — the turn is *not* over, and a second attempt falls through to `tool_calls` at [providerTurn.ts:344](../../src/runtime/pipeline/providerTurn.ts) (the retry budget is `MAX_SUPPRESSED_TOOL_RETRIES = 1`, [LLMCodingRuntime.ts:614](../../src/runtime/LLMCodingRuntime.ts)). But the event is emitted as `type: "error"`, so the UI and the user read it as a failure. The user cancelled before the model could retry.

### RC-3 — Soft signals have no shared severity; every soft denial is an `error`

`TOOL_CALL_SUPPRESSED_BY_USER_INTENT` (RC-2), `TOOL_DENIED_FINAL_CHECK` (Phase D, [providerTurn.ts:148-181](../../src/runtime/pipeline/providerTurn.ts)), `TOOL_LOOP_FINAL_RESPONSE_ONLY` ([providerTurn.ts:186-205](../../src/runtime/pipeline/providerTurn.ts)), and soft `REQUEST_TIMEOUT` (RC-1) are all `type: "error"`. They share a shape — *the runtime refused/aborted something but the task can still continue* — but there is no `severity` field to distinguish them from terminal errors (`REQUEST_CANCELLED`, hard watchdog, context corrupt, provider transport failure). The UI cannot tell "task still going, model was nudged" from "task failed", so every soft signal reads as a crash.

## Soft Error Class (definition)

A runtime signal is **soft** iff the task is still recoverable and the model could finish with a bounded nudge or one retry. It is **terminal** iff the session cannot continue without user/replay intervention.

| Soft (recoverable) | Terminal (failure) |
| --- | --- |
| Soft `REQUEST_TIMEOUT` (model still streaming, `softCycleEvents ≥ 1`) | Hard watchdog timeout (`watchdogTimeoutMs` exceeded) |
| `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` (continue + nudge) | `REQUEST_CANCELLED` (user cancel) |
| `TOOL_DENIED_FINAL_CHECK` (Phase D soft denial) | Context corrupt / invariant violation |
| `TOOL_LOOP_FINAL_RESPONSE_ONLY` (must_respond backstop) | Provider transport failure |
| Recoverable tool execution failure (`tool_result is_error=true`) | Storage corruption |

The contract: **soft signals do not end the task and do not render as `type: "error"` to the user.** They emit a soft event + a bounded nudge; only budget exhaustion or a terminal condition produces an `error`.

## Non-goals

- **No raise to `maxLoops=25`.** Continuity comes from finish/retry paths, not a larger budget (per [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md)).
- **No removal of intent suppression.** Over-tooling protection stays; this plan only (a) adds a `self_diagnosis_request` exemption and (b) changes how suppression *renders*, not whether it can fire.
- **No forced tool use.** Soft retry nudges the model; it does not inject tool calls.
- **No bypass of permission / task-scope / risk / path-safety gates.** Soft denial of a Write in `final_check` still denies the Write.
- **No accident-specific prompts.** No session id, no verbatim user sentence in code. Guards are category-based predicates.
- **No Phase E adaptive budgets.** Budget sizing is separate; this plan is about *what happens at a soft signal*, not how large the budget is.

## Fix A — Soft timeout finish window (RC-1)

### A1. Finish nudge before abort

When the soft-timeout signal fires and `softCycleEvents ≥ 1` (the model was actively streaming), the runtime emits a `timeout_extension_granted`-style user-side nudge — "Soft timeout reached. Finish your current answer in one or two sentences; do not start a new tool." — and grants one short finish window (default `softTimeoutExtensionMs`, capped at 30s for the finish path). Only if the finish window also expires does the route emit terminal `REQUEST_TIMEOUT`.

Landing site: the soft-timeout handling path that feeds `buildAbortEventIfNeeded` ([executionStreamLoop.ts:148](../../src/nexus/executionStreamLoop.ts)); the finish nudge is emitted by the runtime loop, not the nexus abort race.

### A2. `retryable: true` for soft timeout

Soft `REQUEST_TIMEOUT` details change `retryable: false` → `true`. This lets "continue task" resume seamlessly — the direct answer to the user's `last_user_input`. The hard watchdog path keeps `retryable: false`.

### A3. Enforce `maxSoftTimeoutExtensions ≥ 1` under `policy: "soft"`

[executionPreparation.ts:143](../../src/nexus/executionPreparation.ts) already defaults to `?? 1`, but seq 924 recorded `0`. Add a guard: `policy === "soft"` ⇒ `Math.max(1, maxSoftTimeoutExtensions)`, and log when the caller passed `0` so the override path is visible. A `soft` policy with zero extensions is self-contradictory.

### Why safe

The finish window is bounded (≤30s) and only triggers when the model is already streaming (`softCycleEvents ≥ 1`). It cannot extend a stuck turn; the hard watchdog (`watchdogTimeoutMs`) is unchanged and still terminates. `retryable: true` only affects whether "continue" resumes — it does not auto-retry.

## Fix B — Intent suppression: fix the false positive + soften the render (RC-2, RC-3)

### B1. `self_diagnosis_request` exemption

In `shouldSuppressToolsForIntent` ([intentGuidance.ts:219-224](../../src/runtime/intentGuidance.ts)), add an exemption isomorphic to the existing `isCurrentStateVerificationRequest` one (line 221):

```ts
export function shouldSuppressToolsForIntent(guidance: UserIntentGuidance): boolean {
  const normalized = normalizeGuidancePolicy(guidance)
  if (isCurrentStateVerificationRequest(normalized.latestUserText)) return false
  if (isPureMemoryCapabilityQuestion(normalized.latestUserText)) return true
  if (normalized.intent === 'status') return false
  // self-diagnosis turns (model diagnosing the runtime/itself) need read-only
  // tools to cite rules/state; suppressing them is a false positive.
  if (getIntentCategory(normalized) === 'self_diagnosis_request') return false
  return !normalized.requiresTools || normalized.actionHint === 'respond_only'
}
```

seq 1024 had `intentCategory: "self_diagnosis_request"`; this single line un-suppresses that class. It does not affect greeting/pause/status/capability paths.

### B2. Soften the suppression event

`TOOL_CALL_SUPPRESSED_BY_USER_INTENT` is `continue` + nudge, not a failure. Change its event `type` from `"error"` to a new `"tool_call_suppressed"` event (or `"info"` with `subtype: "tool_call_suppressed"`) — see Fix C1 for the shared severity field. The UI renders it as "runtime nudged the model", not "error". The message and `details` stay.

### B3. Nudge: tell the model the retry will pass

The current nudge ([providerTurn.ts:265-268](../../src/runtime/pipeline/providerTurn.ts)) says "if you genuinely need a tool, call it now" — but does not say the retry is guaranteed to pass. Rewrite to: "Your `Grep` was suppressed once because the turn was classified respond-only. If you genuinely need to inspect a file to answer, retry that read-only tool now — the runtime will let it through." The model is more likely to retry (and the second call does fall through at [providerTurn.ts:344](../../src/runtime/pipeline/providerTurn.ts)).

### Why safe

B1 only *removes* a wrong suppression for `self_diagnosis_request`; it never forces a tool. B2 changes rendering, not behavior — the outcome is still `continue`. B3 is a string change. Over-tooling protection (`TOOL_LOOP_FINAL_RESPONSE_ONLY`, retry budgets) is untouched.

## Fix C — Unified soft/terminal severity framework (RC-3, system-level)

### C1. `severity` field on runtime signals

Add `severity: "terminal" | "soft"` to every runtime error/signal event. Soft: the five rows in the Soft Error Class table above. Terminal: the five terminal rows. Existing event consumers that branch on `type === "error"` keep working; new consumers can branch on `severity`.

### C2. Soft signals stop emitting `type: "error"`

Soft signals emit `type: "info"` (or a dedicated `tool_call_suppressed` / `soft_timeout` type) + `severity: "soft"`. Only terminal conditions emit `type: "error"`. This is the single change that stops the user from reading a soft nudge as a crash — the root cause of seq 1028's cancel.

Applies uniformly: `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` (B2), `TOOL_DENIED_FINAL_CHECK`, `TOOL_LOOP_FINAL_RESPONSE_ONLY`, soft `REQUEST_TIMEOUT`. The Phase D `final_check` soft-denial pattern already *behaves* softly (continue + nudge); this aligns its *rendering*.

### C3. Unified soft retry budget

Each soft signal keeps its own bounded budget (`suppressedToolRetries=1`, `softTimeoutExtensions=1`, `finalCheck=1`). When a budget exhausts, the runtime emits an explicit `soft_budget_exhausted` soft event ("suppression retry budget exhausted; answering from existing evidence") rather than silently escalating to terminal. Escalation to terminal only happens on a true terminal condition (hard watchdog, cancel, context corrupt).

### C4. "Continue task" resumes from the last soft signal

When the user says "continue" / "继续" after a soft signal, the session resumes from the last soft state (preserving soft budgets and the in-flight answer), rather than starting a fresh execution. This is the operational form of the user's requirement. The hard-cancel path (`REQUEST_CANCELLED`) is unchanged — only soft signals become resumable.

### Why safe

C1 is additive (new field). C2 is a rendering change gated on `severity`. C3 makes existing budgets explicit; it does not enlarge them. C4 only affects soft signals; terminal cancels still cancel. No gate, scope, or permission contract changes.

## Regression Test Plan

Targets: `test/runtime.test.ts`, `test/runtime-llm.test.ts`, plus a focused `test/soft-error-continuity.test.ts` if cases do not fit.

### Fix A cases

```text
// A1: soft timeout with softCycleEvents >= 1 emits a finish nudge, not terminal REQUEST_TIMEOUT
// A2: soft REQUEST_TIMEOUT details.retryable === true (hard watchdog stays false)
// A3: buildTimeoutDecision({ policy:'soft', maxSoftTimeoutExtensions:0 }) -> maxSoftTimeoutExtensions === 1
```

### Fix B cases

```text
// B1
shouldSuppressToolsForIntent({ intent:'correction', actionHint:'respond_only',
  requiresTools:false, intentCategory:'self_diagnosis_request', ... }) === false
shouldSuppressToolsForIntent({ intent:'pause', actionHint:'respond_only',
  requiresTools:false, ... }) === true   // unchanged

// B2: TOOL_CALL_SUPPRESSED_BY_USER_INTENT outcome is 'continue' AND event severity === 'soft' (not type:error)

// B3: nudge text contains "retry" / "will let it through"
```

### Fix C cases

```text
// C1: every soft signal event has severity:'soft'; every terminal error has severity:'terminal'
// C2: TOOL_DENIED_FINAL_CHECK + TOOL_LOOP_FINAL_RESPONSE_ONLY render as soft, not type:error
// C3: exhausting suppressedToolRetries emits soft_budget_exhausted, not a terminal error
```

### Non-regression (must stay green)

- `TOOL_LOOP_FINAL_RESPONSE_ONLY` refusal still fires in `must_respond` ([providerTurn.ts:186](../../src/runtime/pipeline/providerTurn.ts)) — only its *rendering* changes to soft.
- `TOOL_DENIED_FINAL_CHECK` still denies Writes in `final_check` ([providerTurn.ts:148](../../src/runtime/pipeline/providerTurn.ts)) — only rendering changes.
- Hard watchdog (`watchdogTimeoutMs`) still terminates with `retryable: false`.
- Intent suppression still fires for greeting / pause / pure capability questions (B1 only exempts `self_diagnosis_request`).
- `MAX_SUPPRESSED_TOOL_RETRIES = 1` unchanged; C3 makes it explicit, does not enlarge it.
- `maxLoops = 25` unchanged.

## Rollout

Three PR-sized slices, smallest-first:

1. **Slice 1 + Slice 3 C1-subset (landed 2026-07-03, PR `fix/soft-error-retry-continuity`):** B1 (`self_diagnosis_request` exemption) + B2-lightweight (`severity: 'soft'` on `TOOL_CALL_SUPPRESSED_BY_USER_INTENT`; `type` unchanged) + B3 (nudge tells the model the retry will pass through) + C1-subset (`severity: 'soft'` also on `TOOL_DENIED_FINAL_CHECK` and `TOOL_LOOP_FINAL_RESPONSE_ONLY`, so all three soft-denial events carry the marker consistently). Fully additive, no schema/type change. Directly unblocks seq 1024.
2. **Slice 2 (deferred to a separate PR):** A1 (finish nudge) + A2 (soft-timeout-only `retryable`) + A3. Deep-tracing the timeout path showed A1/A2 need a timeout refactor (`scheduleSoftTimeoutCycle` and `ExecutionTimeoutControls` do not hold the `timeoutController`), plus NexusEvent/translator work and watchdog-test timing redesign — too large to land safely alongside Slice 1/3. **A3 was implemented then reverted**: forcing `maxSoftTimeoutExtensions ≥ 1` under soft policy breaks Phase 3's intentional `soft + maxSoftTimeoutExtensions:0` capability (`runtime.test.ts:6081` pins "no extension granted when 0"), the proposal's "soft+0 is self-contradictory" claim was wrong, and forcing ≥1 does not fix seq 924 anyway (the 240s watchdog still fires during the extension). A3 needs a different design or should be dropped.
3. **Slice 3 remainder (deferred):** C2 (soft signals stop emitting `type:"error"` — breaking change, needs consumer compatibility window), C3 (`soft_budget_exhausted` — needs a new NexusEvent type), C4 (resume from soft signal — needs session-resume machinery). The C1 `severity` field landed in slice 1 so consumers can already branch on it; the type change (C2) follows once consumers migrate.

Each slice: TDD red → implement → `npm test` + `npm run docs:check` + `npm run typecheck` → real-session spot check replaying `session_2db242ff` prompts.

## Graduation

This plan graduates into [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md) as a new "Soft Error Continuity" phase (alongside Phase D `final_check`), then moves to `archive/` with a one-line index note. It does not remain a standalone reference. Partial graduation: Slice 1 lands the `self_diagnosis_request` exemption into the intent-guidance Active Plan as a completed slice (composing with [intent-tool-suppression-stopgap-plan.md](./intent-tool-suppression-stopgap-plan.md) Fix A/B).

## Risks & Rollback

- **Risk: soft timeout finish window lets a stuck turn run longer.** Mitigation: finish window is bounded (≤30s) and only fires when `softCycleEvents ≥ 1`; hard watchdog unchanged.
- **Risk: B1 `self_diagnosis_request` exemption over-fires, letting tools through on a true respond-only turn.** Mitigation: the category is derived from `problemTarget` ([intentGuidance.ts:563](../../src/runtime/intentGuidance.ts)) — only `agent_failure`/`runtime_replay`/`tool_evidence` qualify; greeting/pause/status do not. Negative test pins this.
- **Risk: C2 rendering change breaks a consumer that keys on `type === "error"`.** Mitigation: C1 adds `severity` first; C2 is gated on `severity === "soft"`; consumers migrate off `type === "error"` before C2 lands. Keep a compatibility window.
- **Risk: C4 resume-from-soft re-runs a tool the user thought was cancelled.** Mitigation: C4 only resumes *soft* signals; `REQUEST_CANCELLED` (terminal) is unchanged. Resume re-enters the loop without re-dispatching completed tools.
- **Rollback:** each slice is independently revertible. Slice 1 is two predicates + one event-type change. Slice 3 is additive (`severity`) then a gated rendering switch.

## Relationship to Existing Plans

- [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md) (Active Plan): owns the continuity model. Phase D `final_check` landed the first soft-denial pattern (`TOOL_DENIED_FINAL_CHECK`); this plan generalizes soft-denial rendering (C2) and adds the soft-timeout finish path (Fix A). Composes, does not conflict.
- [intent-guidance-and-prompt-governance-optimization-plan.md](../reference/intent-guidance-and-prompt-governance-optimization-plan.md) (Active Plan): owns intent-guidance regressions. B1 lands a `self_diagnosis_request` exemption as a new slice there.
- [intent-tool-suppression-stopgap-plan.md](./intent-tool-suppression-stopgap-plan.md) (Draft): landed Mode A/B stopgaps. B1 is a complementary exemption (different category), not a duplicate. That proposal's "direction 2" (first-call passthrough) remains out of scope here.
- [provider-unavailable-auto-retry-governance-plan.md](./provider-unavailable-auto-retry-governance-plan.md) (Partially Landed): same "soft retry" philosophy for provider failures; this plan extends the philosophy to runtime-side soft signals.

## 中文概述

### 背景

`session_2db242ff` 在 seq 924 触发软超时(`policy:"soft"` 但 `maxSoftTimeoutExtensions:0`、`retryable:false`、`source:"nexus_stream_abort_race"`),模型正在输出诊断报告(已完成 95%)被直接 cut off;seq 1024 模型为回答"软超时应主动继续"想 `Grep` 查证,被 intent 分类器误判为 `correction/respond_only` 而 suppress,且以 `type:"error"` 呈现;seq 1028 用户看到又一次"报错"主动取消。用户的 `last_user_input`「软超时的话应该主动发起继续任务才对呀」就是本计划的诉求。

### 根因

1. **RC-1 软超时即硬 abort**:`executionStreamLoop.ts:148-172` 的 `buildAbortEventIfNeeded` 在 `timeoutSignal.aborted` 时直接发 `REQUEST_TIMEOUT` terminal,绕过 runtime 层 soft extension;`policy:"soft"` 却 `maxSoftTimeoutExtensions:0` 自相矛盾。
2. **RC-2 intent 误判 + 软拒绝渲染成 error**:`shouldSuppressToolsForIntent` 无 `self_diagnosis_request` 豁免;suppression 本是 `continue + nudge`,却发 `type:"error"`,用户误以为失败而取消。
3. **RC-3 软信号无统一 severity**:soft timeout、`TOOL_CALL_SUPPRESSED_BY_USER_INTENT`、`TOOL_DENIED_FINAL_CHECK`、`TOOL_LOOP_FINAL_RESPONSE_ONLY` 都是 `type:"error"`,UI 无法区分"任务还在继续(软)"与"真失败(硬)"。

### 本计划范围

定义**软报错类**(可恢复:soft timeout、intent suppression、软拒绝、recoverable tool error),与**terminal**(硬超时、用户取消、context corrupt、provider transport 失败)分离。三层 fix:

- **Fix A(软超时收尾窗口)**:A1 软超时先发收尾 nudge 而非直接 abort;A2 `retryable:true`;A3 `policy:"soft"` 强制 `maxSoftTimeoutExtensions ≥ 1`。
- **Fix B(suppression 误判 + 软化)**:B1 `self_diagnosis_request` 豁免(直接解 seq 1024);B2 suppression 事件从 `type:"error"` 降级为 soft;B3 nudge 明确告知"重试会被放行"。
- **Fix C(统一软/硬框架)**:C1 所有信号加 `severity: "terminal" | "soft"`;C2 软信号不再发 `type:"error"`;C3 软重试预算耗尽发 `soft_budget_exhausted` 而非静默 terminal;C4 "继续任务"从最近软信号恢复(回应诉求)。

### 不做

不提高 `maxLoops=25`;不移除 intent suppression;不强制调工具;不绕过 permission/scope/risk 门;不注入事故特定提示词;不做 Phase E adaptive budgets。

### 落地

三片 PR:Slice 1 MVP(B1 + A2 + B2/B3,直接解 seq 924/1024)→ Slice 2(A1 + A3)→ Slice 3(C1-C4 框架)。每片 TDD red → 实现 → `npm test` + `docs:check` + `typecheck` → 复放 `session_2db242ff` spot check。毕业后合并进 [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md) 作为新的"Soft Error Continuity" phase,移入 `archive/`。
