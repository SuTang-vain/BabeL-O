# Tool Loop Budget and Finalization Governance Plan

> Status: Proposed, regression-backed by `session_ee116547-6545-4f70-bc7c-b1b287387cda` on 2026-06-17.
> Priority: P1 for long-running coding sessions; P0 only if max-loop pressure causes data loss or unsafe execution.
> Scope: `LLMCodingRuntime` provider loop budget, final-response-only transition, tool-call convergence, timeout interplay, and user-visible continuation semantics.
> Related plans: [task-adaptive-recoverable-timeout-plan.md](./task-adaptive-recoverable-timeout-plan.md), [context-management-optimization-plan.md](./context-management-optimization-plan.md), [session-finalization-and-evidence-governance-plan.md](./session-finalization-and-evidence-governance-plan.md), [tool-call-text-normalization-and-final-response-governance-plan.md](./tool-call-text-normalization-and-final-response-governance-plan.md).

## 1. Background

`LLMCodingRuntime` currently uses a fixed provider-loop budget:

```text
maxLoops = 25
finalResponseOnlyMode when maxLoops - loopCount <= 3
```

The loop count is provider invocation count, not simply tool count. One provider turn may contain multiple tool calls. In the sample session, a long-running task reached `loopCount=22/25`, causing tools to be hidden (`visibleToolCount=0`) and the execution state to enter `must_respond`. The provider still wanted one more `Grep`, emitted it as DSML text, and the runtime considered the turn successful because no structured tool call was present.

This shows the fixed budget is useful but too coarse. Removing it would create runaway loops; keeping it rigid creates premature finalization.

## 2. Problem Statement

The current loop limit conflates several different concerns:

- preventing infinite tool loops,
- forcing synthesis after enough evidence has been gathered,
- protecting timeout and token budgets,
- recovering from provider indecision,
- avoiding tool-call-shaped final answers.

A single `maxLoops=25` cannot express all of these. The system needs an adaptive finalization policy with observable reasons.

## 3. Goals

- Keep an upper bound on provider/tool loops.
- Make finalization adaptive to task type, timeout budget, context pressure, and evidence state.
- Give the model one controlled opportunity for a bounded final check when useful.
- Keep clients out of runtime truth. Go TUI may render loop budget diagnostics but must not recalculate them.
- Make "continue task" start with a fresh budget when appropriate.

## 4. Non-goals

- Do not remove loop limits entirely.
- Do not let the model decide its own budget.
- Do not allow final checks to bypass permissions, scope boundary confirmation, or tool risk policy.
- Do not turn every long task into an unlimited background agent.

## 5. Budget Model

Replace the single implicit rule with explicit budget dimensions:

```ts
type ToolLoopBudget = {
  maxProviderLoops: number
  finalizationReserveLoops: number
  maxStructuredToolCalls?: number
  maxConsecutiveToolOnlyTurns?: number
  allowOneFinalBoundedCheck: boolean
  reason: 'default' | 'long_task' | 'trusted_session' | 'timeout_pressure' | 'context_pressure' | 'provider_looping'
}
```

Default policy can remain equivalent to today:

```text
maxProviderLoops=25
finalizationReserveLoops=3
```

But long-running coding tasks may receive a larger budget only when the runtime can justify it.

## 6. Adaptive Signals

### Increase budget cautiously

Possible positive signals:

- latest user turn explicitly says "continue task" or names an implementation plan,
- current turn has write/build/test intent,
- context usage is far below warning threshold,
- timeout policy has extension capacity,
- recent tool calls are productive and bounded,
- no repeated same-tool/same-input loop is detected.

### Decrease or force synthesis

Negative signals:

- near-timeout warning fired,
- context is near compact/blocking threshold,
- repeated read of same file range,
- repeated locator calls with low novelty,
- same failure class repeated,
- provider keeps emitting tool calls after final-response-only instruction.

## 7. Finalization States

Introduce explicit states instead of only hiding tools:

| State | Tool visibility | Model instruction |
| --- | --- | --- |
| `gathering` | visible | Continue bounded evidence gathering |
| `synthesize` | visible | Prefer answer; tools only if critical |
| `final_check` | visible but narrowed | At most one bounded read/search/test check |
| `must_respond` | hidden | Answer now, no tools |

Current behavior jumps from `synthesize` to `must_respond`. The missing state is `final_check`.

## 8. Final Check Policy

When entering the reserve window, runtime may allow one final bounded check if all are true:

- latest provider attempted a read-only locator or source-understanding tool,
- the requested tool is `Read`, `Grep`, `Glob`, or `ListDir`,
- target path is in task scope,
- no permission or scope boundary is pending,
- timeout remaining is sufficient for the tool timeout,
- the same input has not already failed.

If accepted, emit a provider-visible runtime message:

```text
Runtime final check granted: run at most one bounded read-only check, then answer.
```

If denied, emit:

```text
Runtime final check denied: answer from existing evidence. Reason: <reason>.
```

## 9. User Continuation Semantics

"Continue task" should not always resume inside the old exhausted loop budget. If the previous request ended with:

- `MAX_LOOPS_EXCEEDED`,
- `TOOL_LOOP_FINAL_RESPONSE_ONLY`,
- `TOOL_CALL_TEXT_LEAK_SUPPRESSED`,
- near-timeout success with raw tool-call-shaped result,

then the next user turn should be treated as a fresh execution budget while preserving recent evidence and failure diagnostics.

This does not mean erasing history. It means the loop counter is per execution request, while context carries the relevant trace.

## 10. Phases

### Phase A: Diagnostics only

Status: proposed.

- Add loop budget fields to invocation diagnostics and execution metrics.
- Emit explicit state: `gathering | synthesize | final_check | must_respond`.
- Record finalization reason.

Acceptance:

- Session events explain why tools were hidden.
- `/context` or loop health can display finalization state without recomputing it.

### Phase B: Configurable budget

Status: proposed.

- Add internal runtime options or config for `maxProviderLoops` and `finalizationReserveLoops`.
- Keep defaults unchanged.
- Add test coverage for default parity.

Acceptance:

- Existing max-loop regressions keep passing.
- Tests can set a small budget deterministically.

### Phase C: One bounded final check

Status: proposed.

- Implement `final_check` state for read-only tools.
- Ensure permissions and task scope still gate execution.

Acceptance:

- In a regression matching the sample, a final `Grep` can run if it is bounded and in scope.
- After the final check, the next provider call is `must_respond`.

### Phase D: Adaptive policy

Status: future.

- Use task intent, timeout pressure, context pressure, and tool novelty to choose budget profile.
- Add telemetry to compare default vs adaptive behavior.

## 11. Regression Set

- Default `maxLoops=25` behavior remains unchanged until Phase C.
- Final-response-only still hides tools in `must_respond`.
- `final_check` allows only one read-only bounded tool call.
- Write/Bash/Task tools are not allowed by final check.
- Repeated failed same-input final checks are denied.
- "Continue task" after max-loop pressure starts a fresh execution budget but keeps recent error diagnostics.

## 12. Operational Guidance

Do not cancel loop limits to fix long tasks. Increase or adapt the budget only with diagnostics. If the model repeatedly reaches `must_respond` while still requesting tools, treat it as a convergence failure and inspect tool novelty, task scope, and timeout pressure before raising limits.
