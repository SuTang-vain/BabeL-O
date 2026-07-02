# Intent Tool Suppression Structural Passthrough Plan (Direction 2)

> State: Draft
> Track: Runtime / Intent Classification / Tool Suppression / Over-tooling
> Priority: P1
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [intent-guidance-and-prompt-governance-optimization-plan.md](../reference/intent-guidance-and-prompt-governance-optimization-plan.md), [intent-tool-suppression-stopgap-plan.md](./intent-tool-suppression-stopgap-plan.md), `src/runtime/pipeline/providerTurn.ts`, `src/runtime/LLMCodingRuntime.ts`, `src/runtime/intentGuidance.ts`, `test/`
> Governance: Structural (direction 2) root-cure for the intent tool-suppression bug. Defers to [intent-guidance-and-prompt-governance-optimization-plan.md](../reference/intent-guidance-and-prompt-governance-optimization-plan.md) (Active Plan) as canonical owner; supersedes the narrow guard in [intent-tool-suppression-stopgap-plan.md](./intent-tool-suppression-stopgap-plan.md) (Fix B). Must not weaken `finalResponseOnlyMode` over-tooling protection.
> Related: [context-cwd-drift-and-recall-governance-plan.md](../reference/context-cwd-drift-and-recall-governance-plan.md)

## Goal

Root-cure `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` (Mode B) by replacing "suppress-then-nudge" with "first-call passthrough" for task-continuation intents. The stopgap (PR #13, Fix B) only guarded `continue + actionHint=normal`; Mode B cases with `actionHint=prioritize_latest` (and any other task-continuation intent the model under-classifies as `requiresTools=false`) still waste a turn on the suppression-nudge and can fail the session if the user cancels. This proposal eliminates the suppression-nudge for task-continuation intents entirely — the model's own tool call is treated as the ground-truth signal that tools are needed.

Over-tooling protection (`finalResponseOnlyMode` / `TOOL_LOOP_FINAL_RESPONSE_ONLY`) is **unchanged**. Pure-capability-question suppression is **unchanged**.

## Relationship to Prior Work

- [intent-guidance-and-prompt-governance-optimization-plan.md](../reference/intent-guidance-and-prompt-governance-optimization-plan.md) (Active Plan) owns the regression class. Its Phase C/H point at suppression reform but do not specify first-call passthrough.
- [intent-tool-suppression-stopgap-plan.md](./intent-tool-suppression-stopgap-plan.md) (PR #13, merged) landed Fix A (action-verb negation in `isPureMemoryCapabilityQuestion`) + Fix B (`continue+normal` → `requiresTools=true`). Fix A stays (it fixes Mode A's heuristic over-match). Fix B's suppression-prevention role is **superseded** by this proposal — direction 2 makes `shouldSuppressToolsForIntent` return false for all task-continuation intents, so `continue+normal` no longer needs a normalize guard to avoid suppression. Fix B remains as Turn Policy consistency (it keeps `toolMode=enabled` for `continue+normal`) and is harmless to keep.

## Root Cause (source-verified)

The runtime trusts the **pre-turn prediction** `requiresTools=false` over the **model's actual tool-call behavior**:

1. Intake predicts `requiresTools=false` for a code-grounded analysis/continuation/explanation request (Mode B under-classification).
2. `shouldSuppressToolsForIntent()` (`src/runtime/intentGuidance.ts:219-225`) returns `true` via `!requiresTools || actionHint === 'respond_only'`.
3. `suppressToolsForCurrentIntent` is set (`src/runtime/LLMCodingRuntime.ts:622-625`) as long as `suppressedToolRetryCount < MAX_SUPPRESSED_TOOL_RETRIES` (= 1, `src/runtime/LLMCodingRuntime.ts:601`).
4. Tools are hidden from the model (`modelVisibleTools = []`, `src/runtime/pipeline/loop.ts:45`), yet the model still emits a tool call (provider/model-specific — the suppression branch at `src/runtime/pipeline/providerTurn.ts:163` is precisely the safety net for this).
5. `src/runtime/pipeline/providerTurn.ts:163-230` suppresses the emitted tool call, emits `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` (line 206), nudges the model, and increments `suppressedToolRetryCount` (line 228).
6. On the next loop, `suppressToolsForCurrentIntent` flips to `false` (counter = 1, not < 1), tools become visible, and the model's tool calls run.

**Cost:** one wasted nudge turn per Mode B occurrence. `session_eafe6bfc` was cancelled by the user during that nudge turn → session `failed`. The model's tool call (Glob/Read) was the ground-truth signal that tools were needed; the runtime suppressed it anyway because it trusted the pre-turn prediction.

## Current Suppression Flow (source-verified)

`suppressToolsForUserIntent` has **two effects** today:

- **Hide tools:** `modelVisibleTools = finalResponseOnlyMode || suppressToolsForUserIntent ? [] : currentToolsList` (`src/runtime/pipeline/loop.ts:45`, `src/runtime/pipeline/contextRefresh.ts:281`).
- **Suppress emitted calls:** `src/runtime/pipeline/providerTurn.ts:163` — when the model emits tool calls despite `suppressToolsForUserIntent`, suppress + nudge + increment counter.

`shouldSuppressToolsForIntent()` (`src/runtime/intentGuidance.ts:219-225`) returns `true` for:

- `isPureMemoryCapabilityQuestion(text)` — pure capability question (Tier 1).
- `!requiresTools || actionHint === 'respond_only'` for non-status, non-verification intents — this is where Mode B lives (Tier 2).

`finalResponseOnlyMode` (`TOOL_LOOP_FINAL_RESPONSE_ONLY`, `src/runtime/pipeline/providerTurn.ts:142-161`) is a **separate** over-tooling gate: after repeated tool calls, force a final answer. It is independent of intent suppression and stays unchanged.

## Design: Two-Tier Suppression

Split suppression by **intent kind**, not by the model's `requiresTools` boolean:

### Tier 1 — hard suppress (unchanged)

Intents where respond-only is **semantically correct** and tooling would be genuinely unnecessary:

- `isPureMemoryCapabilityQuestion` (pure capability question — "do you have memory").
- `intent === 'pause'`.
- `intent === 'greeting'`.

Behavior unchanged: hide tools + suppress-then-nudge (`MAX_SUPPRESSED_TOOL_RETRIES=1`). The model should not tool for these; if it tries, nudge it to answer directly.

### Tier 2 — first-call passthrough (NEW)

Task-continuation intents where the model's `requiresTools=false` is **suspect** (Mode B):

- `intent ∈ {continue, new_focus, correction}` with `requiresTools=false` or `actionHint=respond_only`.

Behavior: tools stay **visible** (`modelVisibleTools` = full list) and emitted tool calls **pass through** (return `tool_calls` outcome, no `TOOL_CALL_SUPPRESSED_BY_USER_INTENT`). The respond-only prediction is still recorded in the provider-visible Turn Policy as a hint ("prefer direct answer if no tool is needed"), but it does **not** gate tools. The model's tool call is the ground-truth signal that tools are needed.

### Over-tooling (unchanged)

`finalResponseOnlyMode` (`TOOL_LOOP_FINAL_RESPONSE_ONLY`) continues to handle genuine tool loops after repeated calls. This is the hard over-tooling protection; direction 2 does not touch it.

### Why this is safe

- Tier 2 only removes suppression for task-continuation intents — the cases where under-classification is the bug. The model genuinely calling a tool on "continue the analysis" is correct behavior, not over-tooling.
- Pure-capability questions (Tier 1) keep full suppression — the Active Plan's direct-answer goal for "do you have memory" is preserved.
- Greeting/pause (Tier 1) keep suppression — no regression for conversational turns.
- Genuine over-tooling (model loops on tools) is still caught by `finalResponseOnlyMode`.
- The worst case for Tier 2: a genuinely respond-only task-continuation prompt ("ok, continue summarizing") where the model calls one unnecessary tool. Cost: one tool call, then the model proceeds. `finalResponseOnlyMode` catches sustained loops. This is strictly better than the current Mode B cost (suppression-nudge → user cancels → session fails).

## Implementation Surface

The cleanest change is narrowing `shouldSuppressToolsForIntent` to Tier 1 only:

```ts
export function shouldSuppressToolsForIntent(guidance: UserIntentGuidance): boolean {
  const normalized = normalizeGuidancePolicy(guidance)
  if (isCurrentStateVerificationRequest(normalized.latestUserText)) return false
  if (isPureMemoryCapabilityQuestion(normalized.latestUserText)) return true   // Tier 1
  if (normalized.intent === 'pause' || normalized.intent === 'greeting') return true  // Tier 1
  if (normalized.intent === 'status') return false
  // Tier 2: task-continuation intents (continue / new_focus / correction).
  // First-call passthrough — the model's tool call is the ground-truth
  // signal that tools are needed. Over-tooling is handled by
  // finalResponseOnlyMode, not intent suppression.
  return false
}
```

Because `suppressToolsForUserIntent` (derived from this function) drives **both** `modelVisibleTools` (`src/runtime/pipeline/loop.ts:45`) and the `src/runtime/pipeline/providerTurn.ts:163` suppression branch, narrowing it to Tier 1 automatically:

- makes tools visible for Tier 2 (so the model can call them), and
- skips the suppression branch for Tier 2 (so emitted calls pass through).

### Implementation deviation: option-confirmation gate decouple (landed)

> The proposal originally anticipated narrowing `shouldSuppressToolsForIntent` alone. TDD surfaced an unanticipated coupling: the `TOOL_CALL_NEEDS_USER_CONFIRMATION` option-confirmation gate (single-letter input like `"B"`) was nested **inside** the suppression branch at `providerTurn.ts:163`. Narrowing suppression alone would have disabled the gate for Tier 2 option-like inputs — a user typing `"B"` to confirm a prior option (intake: `new_focus + respond_only + requiresTools=false`) would have had the model's tool call run with no confirmation. That broke `test/runtime-llm.test.ts`'s option-clarification test and removed a disambiguation safety net for ambiguous single-letter input (which is not a reliable "tools needed" signal, so Tier 2 passthrough should not apply).

Resolution chosen: **decouple the gate from suppression**. The gate is now an independent branch in `providerTurn.ts` that fires whenever `turn.toolCalls.length > 0 && !confirmedOptionSelection && latestUserText is option-like && retry budget remains`, regardless of `suppressToolsForUserIntent`. It runs after `finalResponseOnlyMode` and before intent suppression. `confirmedOptionSelection` is threaded through `applyProviderOutcome.ts` and passed from `LLMCodingRuntime.ts` (where it was already computed). This preserves the exact current gate behavior for suppressed turns, keeps the gate firing for Tier 2 option-like input, and yields a clean two-tier suppression design (no option carve-out muddying `shouldSuppressToolsForIntent`).

Files changed (as landed):

- `src/runtime/intentGuidance.ts` — `shouldSuppressToolsForIntent` narrowed to Tier 1 (pure-capability + pause + greeting → suppress; status → no; everything else → passthrough).
- `src/runtime/pipeline/providerTurn.ts` — option-confirmation gate extracted from inside the suppression branch into an independent branch (fires regardless of `suppressToolsForUserIntent`); `confirmedOptionSelection?: boolean` added to `reduceProviderTurnOutcome` options (default `false`); suppression branch narrowed to Tier 1 (gate removed from it).
- `src/runtime/applyProviderOutcome.ts` — `confirmedOptionSelection?` added to `ApplyProviderOutcomeInput` and threaded to `reduceProviderTurnOutcome`.
- `src/runtime/LLMCodingRuntime.ts` — passes `confirmedOptionSelection` (already computed at the main-loop scope) to `applyProviderOutcome`. `suppressToolsForCurrentIntent` computation (`:622-625`) unchanged in structure; `MAX_SUPPRESSED_TOOL_RETRIES` retry now only applies to Tier 1.
- `test/runtime-llm.test.ts` — Tier 2 passthrough tests (unit + one runtime integration fixture for the `session_eafe6bfc` class) + Tier 1 non-regression; stopgap `prioritize_latest` assertion flipped to passthrough.
- Diagnostics: `getToolSuppressionReason` (`src/runtime/intentGuidance:231-240`) stays valid for Tier 1; Tier 2 no longer emits a suppression reason (it does not suppress).

## Non-goals

- **Do not touch `finalResponseOnlyMode` / `TOOL_LOOP_FINAL_RESPONSE_ONLY`.** Over-tooling protection is out of scope.
- **Do not change `MAX_SUPPRESSED_TOOL_RETRIES`.** The retry budget stays at 1 (now Tier-1-only).
- **Do not remove Fix A or Fix B** (PR #13). Fix A stays (Mode A heuristic fix). Fix B stays (Turn Policy consistency for `continue+normal`); it becomes lower-value but harmless.
- **Do not change the intake classifier prompt.** Under-classification is addressed structurally (trust the model's tool calls), not by prompt-tuning.
- **Do not remove the pure-capability direct-answer path.** Tier 1 preserves it.

## Regression Test Plan

Targets: `test/runtime-llm.test.ts` (intent tests), `test/runtime.test.ts` (runtime suppression tests).

### Tier 1 non-regression (still suppresses)

```text
// pure capability question — suppress + nudge
shouldSuppressToolsForIntent(pure capability "你有长期记忆吗") === true
// pause / greeting — suppress
shouldSuppressToolsForIntent(pause) === true
shouldSuppressToolsForIntent(greeting) === true
// runtime: model emits Read on pure-capability turn -> TOOL_CALL_SUPPRESSED_BY_USER_INTENT (unchanged)
```

### Tier 2 passthrough (NEW)

```text
// continue + requiresTools=false + model emits tool -> tool_calls outcome, NO suppression
shouldSuppressToolsForIntent(continue + requiresTools=false) === false
shouldSuppressToolsForIntent(continue + actionHint=respond_only) === false
shouldSuppressToolsForIntent(new_focus + requiresTools=false) === false
shouldSuppressToolsForIntent(correction + requiresTools=false) === false
// runtime: model emits Read on continue+requiresTools=false turn -> tool_runs, no TOOL_CALL_SUPPRESSED_BY_USER_INTENT
// Regression fixture: session_eafe6bfc (Glob/Read), session_b7f64aa1 Turn 5 (Read "解释一下"), session_9b1c212c Turn 3 (Grep)
```

### Over-tooling protection intact

```text
// finalResponseOnlyMode + repeated tool calls -> TOOL_LOOP_FINAL_RESPONSE_ONLY (unchanged)
// maxSuppressedToolRetries budget unchanged (Tier-1-only now)
```

### Interaction with Fix B (stopgap)

```text
// continue+normal still has requiresTools=true (Fix B) -> toolMode=enabled (Turn Policy consistent)
// direction 2 makes shouldSuppressToolsForIntent false for continue regardless -> Fix B no longer needed for suppression, but kept for Turn Policy
```

## Rollout

1. Tests first: Tier 2 passthrough tests (red before), Tier 1 non-regression (green throughout). ✅
2. Decouple the option-confirmation gate from the suppression branch (deviation surfaced by TDD — see Implementation Surface). ✅
3. Narrow `shouldSuppressToolsForIntent` to Tier 1. ✅
4. Run `npm test` (deterministic suite) + `npm run docs:check`. ✅ (1254/1254 pass, docs:check 0 failures.)
5. Real-session spot check (minimax/MiniMax-M3, real provider): ✅ Confirmed. A Mode B intake (`new_focus/normal/requiresTools=false`) with the model calling 25 tools (Bash / ListDir / Read / Grep) — all passed through on the first turn, zero `TOOL_CALL_SUPPRESSED_BY_USER_INTENT`, clean success. Before direction 2 the first tool call would have been suppressed + nudged. The exact Mode B + model-tools passthrough is also covered deterministically by the runtime integration test in `test/runtime-llm.test.ts`.

## Graduation

When direction 2 lands with regression coverage, this proposal + the stopgap proposal ([intent-tool-suppression-stopgap-plan.md](./intent-tool-suppression-stopgap-plan.md)) together fold into [intent-guidance-and-prompt-governance-optimization-plan.md](../reference/intent-guidance-and-prompt-governance-optimization-plan.md) as the closed suppression-reform phase, then both move to `archive/`.

## Risks & Rollback

- **Risk: over-tooling on genuinely respond-only task-continuation prompts.** Mitigation: `finalResponseOnlyMode` catches sustained loops; the cost of one unnecessary tool call is lower than the current Mode B cost (session fails). The Turn Policy still records respond-only as a hint.
- **Risk: a true capability question not caught by `isPureMemoryCapabilityQuestion` slips to Tier 2.** Mitigation: `isPureMemoryCapabilityQuestion` coverage (EN + ZH) + Fix A action-verb negation. Edge case; acceptable.
- **Risk: Tier 2 passthrough masks intake classifier under-classification instead of fixing it.** Accepted tradeoff: the model's tool call is a more reliable signal than the intake prediction for task-continuation intents. Intake prompt improvements are tracked separately in the Active Plan (Phase D).
- **Rollback:** revert the `shouldSuppressToolsForIntent` change (one function). Fix B (stopgap) remains as a partial guard. No schema/storage change.

## Out of Scope

- Intake classifier prompt tuning (Active Plan Phase D) — separate.
- `finalResponseOnlyMode` reform — separate.
- Graduating the stopgap proposal — bundled with this one's graduation.

## 中文概述

### 背景

`TOOL_CALL_SUPPRESSED_BY_USER_INTENT`（Mode B）的根因：运行时信任 turn 前预测的 `requiresTools=false`，胜过模型实际发起的工具调用。stopgap（PR #13 Fix B）只守 `continue+normal`，`prioritize_latest` 等任务续作意图的欠分类仍会触发"压制→nudge→重试"——浪费一轮，用户可能在此时取消导致 session 失败（`session_eafe6bfc`）。

### 方案：两层压制

- **Tier 1（硬压制，不变）**：纯能力问句（`isPureMemoryCapabilityQuestion`）+ pause + greeting。这些语义上确实不需要工具，保持 hide-tools + suppress-then-nudge。
- **Tier 2（首调放行，新增）**：任务续作意图（continue / new_focus / correction）+ `requiresTools=false`。工具保持可见，模型发起的工具调用直接放行（`tool_calls` outcome，不压制、不 nudge）。模型的工具调用就是"需要工具"的 ground-truth 信号。Turn Policy 仍记录 respond-only 作为提示，但不门控工具。
- **Over-tooling（不变）**：`finalResponseOnlyMode`（`TOOL_LOOP_FINAL_RESPONSE_ONLY`）继续兜底真正的工具循环。

### 实现

把 `shouldSuppressToolsForIntent` 收窄到 Tier 1（纯能力 + pause + greeting）。由于 `suppressToolsForUserIntent` 同时驱动 `modelVisibleTools`（loop.ts:45）和 providerTurn.ts:163 的压制分支，收窄后 Tier 2 自动：工具可见 + 放行。Fix B（stopgap）保留为 Turn Policy 一致性，不再承担防压制职责。

### 收口

方向 2 落地 + 回归覆盖后，本提案与 stopgap 提案一起折进 intent-guidance Active Plan，移入 `archive/`。
