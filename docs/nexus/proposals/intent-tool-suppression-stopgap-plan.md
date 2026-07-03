# Intent Tool Suppression Stopgap Plan

> State: Draft
> Track: Runtime / Intent Classification / Tool Suppression
> Priority: P1
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [intent-guidance-and-prompt-governance-optimization-plan.md](../reference/intent-guidance-and-prompt-governance-optimization-plan.md), `src/runtime/intentGuidance.ts`, `src/runtime/pipeline/providerTurn.ts`, `test/`
> Governance: Scoped PR-sized stopgap for [intent-guidance-and-prompt-governance-optimization-plan.md](../reference/intent-guidance-and-prompt-governance-optimization-plan.md); that Active Plan remains the canonical owner of intent guidance regressions. This proposal must not introduce accident-specific hardcoded prompts or weaken over-tooling protection.
> Related: [context-cwd-drift-and-recall-governance-plan.md](../reference/context-cwd-drift-and-recall-governance-plan.md)
> 2026-07-01 implementation — Fix A + Fix B landed in commit `5b8bf53` on branch `fix/intent-tool-suppression-stopgap`. TDD: 4 new tests in `test/runtime-llm.test.ts` (3 red before, all green after); full `runtime-llm.test.ts` 83/83 pass; full deterministic suite 0 fail. Deviation from draft: bare `有` kept (see Fix A notes). Graduation (fold into the intent-guidance Active Plan + move to `archive/`) pending review.

## Goal

Stop the runtime from suppressing tool calls the model actually emitted, when the only reason for suppression is a pre-turn prediction of `requiresTools=false` that the model's own tool-call behavior has already contradicted. Two deterministic, low-risk guards land the remaining slice of the canonical Active Plan and add one new guard it does not yet name:

- **Fix A (Mode A):** `isPureMemoryCapabilityQuestion()` returns `false` when the prompt also carries an action verb (`分析 / 测试 / 执行 / 验证 / 解释 / 核对 / …`). Lands the action-cue negation the Active Plan's Phase A calls for but the current predicate does not yet implement.
- **Fix B (Mode B):** `normalizeGuidancePolicy()` forces `requiresTools=true` when `intent='continue'` and `actionHint='normal'`. The `continue + normal + requiresTools=false` combination is self-contradictory and is the shape of ~70% of observed suppressions. New guard, not in the Active Plan.

Both guards are deterministic and unit-testable. Neither injects a prompt. Neither forces a tool call — `requiresTools=true` only removes suppression; a model that genuinely needs no tools simply emits none and the turn completes.

## Relationship to the Canonical Active Plan

[intent-guidance-and-prompt-governance-optimization-plan.md](../reference/intent-guidance-and-prompt-governance-optimization-plan.md) (State: Active Plan) already owns this regression class. It tracks P0-1/P0-2/P0-3 (predicate over-breadth, normalize hard-override, suppression hard-suppress) with source-verified reproductions `session_b7f64aa1` and `session_9b1c212c`. This proposal does **not** duplicate that plan. It:

1. Lands the unimplemented slice of Phase A (action-verb negation inside `isPureMemoryCapabilityQuestion`).
2. Adds one new deterministic guard (Fix B) that the Active Plan's Phase B/C ordering does not by itself produce.
3. Records a new reproduction (`session_eafe6bfc`, 2026-07-01) of the same class.
4. Explicitly defers the structural fix (first-tool-call passthrough in `providerTurn.ts`) to a separate proposal.

On graduation, this proposal folds into the Active Plan as a completed Phase A slice plus a new "continue+normal guard" phase; it does not remain a standalone reference.

## Reproduction

`session_eafe6bfc-dfb9-473c-8619-b93637491bed` (2026-07-01, this investigation):

- First interaction: model attempts `Glob` → `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` ("respond-only user intent: Glob"). The request was a code-grounded analysis the model had decided to back with a tool call.
- Latest interaction: model attempts `Read` → same suppression ("respond-only user intent: Read"). The intake classifier's `reason` read "Pure analytical discussion, no tool-backed verification requested." — a semantic misread: the analysis target was source code, so the analysis itself was tool-backed. The classifier also returned `intent=continue, actionHint=normal`, which contradicts `requiresTools=false`.
- User cancelled before the retry budget exhausted (`REQUEST_CANCELLED`); the session ended `failed`.

Same class already source-verified in the Active Plan:

- `session_b7f64aa1` Turn 4/5: `Read` suppressed for "解释一下这部分" / a current-state verification question.
- `session_9b1c212c` Turn 3: `Grep` suppressed for "这个不就是源码吗…" source-confirmation question.

## Root Cause (source-verified)

### Mode A — heuristic override (~25% of the 2026-07-01 sample)

`normalizeGuidancePolicy()` at `src/runtime/intentGuidance.ts:625-632` force-resets any prompt matching `isPureMemoryCapabilityQuestion()` to `{intent:'status', actionHint:'respond_only', requiresTools:false}`, even when the intake model returned `requiresTools=true`. `isPureMemoryCapabilityQuestion()` (`src/runtime/intentGuidance.ts:697-705`) matches on `能否|能不能|可以|可否|是否|有没有|有|具备|支持` followed by `写入|保存|记忆|长期记忆` with **no action-verb negation** (and the bare `有` alternation is over-broad). A prompt like "能否分析记忆功能的设计" therefore matches the capability-question regex and is forced respond-only, ignoring the `分析` action verb. The Active Plan's Phase A action-cue design is not yet implemented inside this predicate.

### Mode B — model under-classification, trusted over actual tool calls (~70%)

The intake model returns `requiresTools=false` for code-grounded analysis / continuation / explanation requests (e.g. `intent=continue, actionHint=normal, requiresTools=false`). No heuristic catches the contradiction. `shouldSuppressToolsForIntent()` (`src/runtime/intentGuidance.ts:219-225`) returns `true` on `!requiresTools`, and `providerTurn.ts:163-230` then suppresses the tool calls the model actually emitted, incrementing `suppressedToolRetryCount` (line 228) and nudging a retry. The retry only opens tools after the budget exhausts; users cancel first. The runtime trusts the pre-turn prediction over the model's own tool-call behavior — the latter is the ground-truth signal that tools are needed.

The `continue + normal + requiresTools=false` combination is self-contradictory: the fallback default for `continue` is `requiresTools=true` (`src/runtime/intentGuidance.ts:385-397`), and the intake prompt itself instructs that verify/run/check/test/inspect/modify keep `requiresTools=true` (line 422). The only path to this combination is model under-classification.

## Non-goals

- **No structural suppression reform.** Changing `providerTurn.ts:163` to pass through the first tool call (the "direction 2" structural fix) is the root cure but touches over-tooling protection. It is deferred to a separate proposal; see "Out of scope".
- **No accident-specific prompts.** No session id, no incident verbatim sentence, no provider-specific hidden instruction. Guards are cue-based predicates plus one deterministic normalization rule.
- **No forced tool use.** `requiresTools=true` removes suppression only.
- **No change to over-tooling protection** (`TOOL_LOOP_FINAL_RESPONSE_ONLY`, max-token recovery, tool-loop budgets, retry counters).

## Stopgap Fix A — action-verb negation in `isPureMemoryCapabilityQuestion`

Add an early `return false` when the text carries an action verb, reusing the action-cue family already defined for `isCurrentStateVerificationRequest()` (`src/runtime/intentGuidance.ts:719-720`):

```ts
export function isPureMemoryCapabilityQuestion(text: string): boolean {
  if (isMemoryAvailabilityCheckRequest(text) || isExplicitMemorySavePrompt(text)) return false
  const normalized = text.trim().toLowerCase()
  // Action verbs indicate tool-backed work, not a pure yes/no capability question.
  // Aligns with isCurrentStateVerificationRequest hasActionCue and the intake
  // prompt guidance (analyze/test/verify/run/check/inspect -> requiresTools=true).
  if (hasActionVerbCue(normalized, text)) return false
  return (
    /\b(can you|could you|are you able to|do you have)\b.*\b(memory|remember|long[- ]term memory)\b/iu.test(normalized) ||
    /\b(memory|remember|long[- ]term memory)\b.*\b(available|enabled|write|save)\b/iu.test(normalized) ||
    /\b(is .*memory.*available|is .*long[- ]term memory.*available)\b/iu.test(normalized) ||
    /(能否|能不能|可以|可否|是否|有没有|具备|支持).*(写入|保存|记忆|长期记忆)/u.test(text) ||
    /(记忆|长期记忆).*(能否|能不能|可以|可否|是否|有没有|具备|支持|可用|启用)/u.test(text)
  )
}
```

Notes:

- `hasActionVerbCue` reuses the same `执行|运行|跑一下|跑|测试|测一下|实测|验证|检查|查看|查一下|确认|诊断|解释|说明|分析|核对` cue set as `isCurrentStateVerificationRequest`, extracted as a shared helper so the two predicates cannot drift.
- Keep the bare `有` in the capability-question alternation. The draft suggested dropping it, but TDD showed "你有长期记忆吗？" (a legitimate pure-capability question) relies on `有` + `记忆`; dropping it regresses that case. The action-verb negation alone fixes Mode A — "能否分析记忆功能" returns `false` because `分析` fires the negation, while `有` + `记忆` without an action verb stays `true`.
- Pure capability questions without action verbs ("你能够使用长期记忆吗", "你有长期记忆吗") still return `true` and stay respond-only — unchanged.

## Stopgap Fix B — `continue + normal` forces `requiresTools=true`

Add one rule at the end of `normalizeGuidancePolicy()` (`src/runtime/intentGuidance.ts:600-655`), before the final `return guidance`:

```ts
// continue + normal is self-contradictory with requiresTools=false: the
// fallback default for continue is requiresTools=true, and the only way to
// reach this combo is model under-classification. Force tools visible —
// requiresTools=true does not force a tool call, it only removes suppression.
if (guidance.intent === 'continue' && guidance.actionHint === 'normal') {
  return { ...guidance, requiresTools: true }
}
```

Placement is after every explicit override (explicit save, availability check, current-state verification, pure memory capability, pause, greeting, status-without-tools), so it only fires on passthrough — i.e. the under-classified model output that is Mode B.

### Why this is safe

`requiresTools=true` is not "force a tool call". The runtime only uses `requiresTools` to decide whether to *suppress* tool calls the model already emitted. With `requiresTools=true`, suppression is off; a model that genuinely needs no tools emits none and the turn ends normally via the `turn.toolCalls.length === 0` terminal path (`providerTurn.ts:233-298`). The guard therefore only ever *removes* a wrong suppression, never *adds* tool use. The only behavior change is: code-grounded analysis/continuation/explanation requests stop losing their first turn to a suppression-retry cycle.

### What it does not fix

Mode A's heuristic override is handled by Fix A. Greeting/pause/status-without-tools stay respond-only (their `actionHint` is `respond_only`, not `normal`, so the guard does not fire). Pure capability questions stay respond-only (Fix A returns `true`, normalize sets `respond_only`).

## Regression Test Plan

Targets: `test/runtime-llm.test.ts`, `test/runtime.test.ts` (current homes of intent-guidance unit tests); add a focused `test/intent-guidance-stopgap.test.ts` if the cases do not fit.

### Fix A cases

```text
isPureMemoryCapabilityQuestion('能否分析记忆功能的设计') === false
isPureMemoryCapabilityQuestion('请解释一下记忆模块的实现') === false
isPureMemoryCapabilityQuestion('你能够使用长期记忆吗') === true    // unchanged: no action verb
isPureMemoryCapabilityQuestion('长期记忆是否可用') === true        // unchanged: no action verb
```

### Fix B cases (normalization)

```text
normalizeGuidancePolicy({ intent:'continue', actionHint:'normal', requiresTools:false, ... })
  -> requiresTools === true
normalizeGuidancePolicy({ intent:'continue', actionHint:'prioritize_latest', requiresTools:false, ... })
  -> requiresTools === false   // guard does not fire; prioritize_latest is not 'normal'
normalizeGuidancePolicy({ intent:'status', actionHint:'normal', requiresTools:false, ... })
  -> actionHint === 'respond_only'  // status-without-tools path unchanged
normalizeGuidancePolicy({ intent:'pause', ... }) -> requiresTools === false  // unchanged
```

### Suppression / runtime cases

```text
shouldSuppressToolsForIntent(continue+normal+requiresTools=false) === false   // after Fix B
// Runtime: model emits Read on a continue+normal turn -> tool_calls outcome, no TOOL_CALL_SUPPRESSED_BY_USER_INTENT
// Regression fixture: session_eafe6bfc Glob-then-Read pattern + session_b7f64aa1 Turn 5 "解释一下" pattern
```

### Negative guard (over-tooling protection intact)

```text
// finalResponseOnlyMode + repeated tool calls still -> TOOL_LOOP_FINAL_RESPONSE_ONLY (unchanged)
// maxSuppressedToolRetries budget unchanged; Fix B only prevents the first-turn suppression
```

## Rollout

1. Tests first: Fix A + Fix B cases as failing tests.
2. Implement Fix A (shared `hasActionVerbCue` helper + early return + drop bare `有`).
3. Implement Fix B (one normalize rule).
4. Run `npm test` (deterministic suite) + `npm run docs:check`.
5. Real-session spot check: replay `session_eafe6bfc` / `session_b7f64aa1` user prompts through intake + normalize; confirm no suppression on the code-grounded turns.

## Graduation

When Fix A + Fix B land with regression coverage, this proposal graduates by folding into [intent-guidance-and-prompt-governance-optimization-plan.md](../reference/intent-guidance-and-prompt-governance-optimization-plan.md) as a completed Phase A slice plus a new "continue+normal guard" phase, then moves to `archive/` with a one-line index note. It does not remain a standalone reference.

## Risks & Rollback

- **Risk: a legitimately tool-free `continue + normal` request loses its suppression.** Mitigation: `requiresTools=true` does not force tools; the model simply emits none. Cost is at most one turn that already would have completed without tools. The fallback default already treats `continue` as `requiresTools=true`, so this aligns the model path with the fallback path.
- **Risk: Fix A action-verb list drifts from `isCurrentStateVerificationRequest`.** Mitigation: extract a shared `hasActionVerbCue` helper; single source of truth.
- **Risk: Fix A over-negates, sending a true capability question to tools.** Mitigation: pure capability questions ("你能够使用长期记忆吗") carry no action verb and are unaffected; negative tests pin this.
- **Rollback:** both fixes are single-predicate / single-rule additions; revert is one commit each. No schema, storage, or prompt-architecture change.

## Out of scope — Direction 2 (structural fix)

The "direction 2" fix — change `providerTurn.ts:163` so the *first* tool call on a `requiresTools=false` turn passes through, and suppression only applies after a respond-only nudge is ignored — is the root cure and also fixes Mode A structurally. It is deferred to a separate proposal because it changes the suppression contract and interacts with over-tooling protection (`TOOL_LOOP_FINAL_RESPONSE_ONLY`, retry budgets). That proposal must define: (a) when "first call passthrough" vs "suppress-then-nudge" applies, (b) how it composes with the existing retry counter, (c) regression coverage for the over-tooling path. This stopgap makes direction 2 less urgent but does not replace it.

## 中文概述

### 背景

`session_eafe6bfc` 再次复现 `TOOL_CALL_SUPPRESSED_BY_USER_INTENT`：模型为代码分析发起 `Glob` / `Read`，被运行时按"turn 前预测的 requiresTools=false"压制，重试未耗尽即被用户取消，session 失败。该问题已被 [intent-guidance-and-prompt-governance-optimization-plan.md](../reference/intent-guidance-and-prompt-governance-optimization-plan.md)（Active Plan）以 `session_b7f64aa1` / `session_9b1c212c` 源码级复现登记。

### 本提案范围

只做两个确定性止血，不碰 over-tooling 防护：

1. **Fix A（模式 A，约 25%）**：`isPureMemoryCapabilityQuestion()` 命中动作动词（分析 / 测试 / 执行 / 验证 / 解释 / 核对…）时返回 `false`，落地 Active Plan Phase A 未实现的动作 cue 否定。保留裸 `有`——"你有长期记忆吗" 是合法纯能力问句，去掉会回归。
2. **Fix B（模式 B，约 70%）**：`normalizeGuidancePolicy()` 对 `intent=continue && actionHint=normal` 强制 `requiresTools=true`。该组合本就自相矛盾（fallback 默认 continue 即 requiresTools=true）；`requiresTools=true` 只解除压制、不强制调工具，模型不需要工具时照常不调。

### 不做

方向 2（`providerTurn.ts:163` 首次工具调用放行的结构性修法）是根治，但触及 over-tooling 防护，另起提案评估。本提案不注入事故特定提示词、不改变 retry 预算、不改变 `TOOL_LOOP_FINAL_RESPONSE_ONLY`。

### 收口

Fix A + Fix B 落地并补齐回归后，本提案合并进 Active Plan（Phase A 完成片 + 新增 continue+normal 守卫 phase），随后移入 `archive/`，不作为独立 reference 长期保留。
