# Runtime Tool Loop Governance Plan

> State: Active Plan
> Track: Runtime / Tools
> Priority: P1 for long-running coding sessions; P0 only if loop pressure causes data loss or unsafe execution
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/runtime/`, `src/tools/`, `test/runtime-llm.test.ts`, `test/tool-recoverability.test.ts`
> Governance: Canonical runtime tool-loop entry point, cross-linked from [tool-governance-plan.md](./tool-governance-plan.md) and [context-governance-index.md](./context-governance-index.md).
> Related: [tool-governance-plan.md](./tool-governance-plan.md), [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md), [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md), archived source documents in [../archive/](../archive/)

## Purpose

This document is the canonical reference for runtime tool-loop continuity. It consolidates the previous runtime tool-loop governance set:

- [recoverable-tool-error-and-session-continuity-governance-plan.md](../archive/recoverable-tool-error-and-session-continuity-governance-plan.md)
- [tool-call-text-normalization-and-final-response-governance-plan.md](../archive/tool-call-text-normalization-and-final-response-governance-plan.md)
- [tool-loop-budget-and-finalization-governance-plan.md](../archive/tool-loop-budget-and-finalization-governance-plan.md)

These plans all describe the same user-visible failure class: the agent is still working, but the runtime either terminalizes a recoverable tool error, accepts tool-call-shaped text as a final answer, or exhausts loop budget before a controlled final check.

## Current State

Implemented pieces:

- `Grep` handles dash-leading patterns through the ripgrep `--` separator.
- Generic recoverable tool execution failures can be returned to the provider as `tool_result is_error=true` instead of terminal `TOOL_ERROR`.
- Built-in tools have lightweight structured repair hints for common recoverable failures.
- Runtime already has final-response-only and respond-only suppression paths for known tool-call-shaped text dialects.
- Phase D (landed): a first-class `final_check` state allows exactly one bounded read-only check (Read/Grep/Glob/ListDir) before `must_respond`; write/execute/task tools are denied with `TOOL_DENIED_FINAL_CHECK`. `must_respond` remains the backstop (`TOOL_LOOP_FINAL_RESPONSE_ONLY`) once the one check is used or budget is exhausted.
- Phase C (partially landed): loop-budget state is surfaced in the model-visible execution state block (iteration count, context %, phase, finalization reason), and `findRepeatedToolInputs` surfaces the top repeated tool input as a concrete nudge (e.g. `Bash npx tsx --test test/mcp.test.ts ×3 — reuse the latest result`) at phase ≥ synthesize.

Open pieces:

- DSML / full-width pseudo tool-call text needs a formal dialect entry and regression coverage.
- Phase C remainder: the loop budget is still implicit (`maxLoops=25`, reserve `3`) rather than a first-class typed `ToolLoopBudget` struct with a `reason` field; the pragmatic surfacing covers the user-visible failure but not the full typed contract.
- Phase D remainder: per-tool "bounded" enforcement (Read line ranges, target-path-in-scope checks, "the same input has not already failed") is intentionally deferred — the first version gates on the read-only whitelist + a single `final_check` turn only (see Non-goals).

## Problem Statement

Runtime tool-loop failure has three connected forms:

1. **Recoverable tool failure becomes terminal**: the provider does not receive a paired tool result and cannot correct the call.
2. **Tool-call-shaped text leaks into final answer**: the provider emits XML/DSML/pseudo tool syntax while tools are hidden, and the user sees fake tool execution text.
3. **Fixed loop budget forces premature finalization**: the runtime hides tools before the model has completed a bounded final evidence check.

All three break continuity. The user experience is similar: the agent appears to forget the active task, falsely finish, or stop one step before useful completion.

## Goals

- Keep ordinary tool execution failures provider-visible and recoverable.
- Suppress tool-call-shaped text when tools are hidden.
- Normalize text tool calls only through explicit runtime-owned dialect policy.
- Keep loop limits, but make finalization reasons observable.
- Add a controlled `final_check` path for one bounded read-only check when safe.
- Preserve permission, task scope, context, timeout, and provider replay guarantees.

## Non-goals

- Do not remove loop limits.
- Do not let clients parse or execute pseudo tool-call text.
- Do not automatically retry tools without model or user involvement.
- Do not bypass permission, task scope, risk, or path safety.
- Do not make long-running tasks unlimited background agents.

## Runtime Continuity Model

The runtime should treat a provider turn as one of these states:

| State | Tool visibility | Runtime contract |
| --- | --- | --- |
| `gathering` | visible | Normal bounded tool use. |
| `synthesize` | visible | Prefer answer; tools only if critical. |
| `final_check` | narrowed | At most one bounded read-only check, then answer. |
| `must_respond` | hidden | No tools; answer from existing evidence. |

Tool-call-shaped text is only executable in states where tools are visible and the dialect parser explicitly allows execution. In `must_respond`, `respond_only`, or hidden-tool modes, text-shaped tool calls must be suppressed and retried as natural language.

## Recoverable Tool Failures

Return `tool_completed success=false` and provider-visible `tool_result is_error=true` for repairable failures:

- invalid grep pattern or command argument;
- missing file or path drift;
- ambiguous edit target;
- parent path is not a directory;
- optional helper unavailable when the model can choose another path;
- remote runner structured failure;
- nonzero tool output that should be represented as a tool result.

Keep terminal runtime errors for:

- user cancellation;
- hard request timeout / watchdog;
- context blocking after failed recovery;
- provider transport failure;
- storage corruption or invariant violation;
- repeated recovery failure that cannot be paired to a provider tool call.

## Text Tool-call Policy

Runtime owns all text-tool interpretation. Clients must render events, not parse tool calls.

| Runtime condition | Recognized text dialect | Action |
| --- | --- | --- |
| Tools visible | Strictly parseable executable dialect | Normalize into a normal runtime tool call and apply all gates. |
| Tools visible | Unknown or unsafe tool-shaped text | Suppress and retry once, or return diagnostic. |
| Respond-only | Any tool-shaped text | Suppress and retry natural-language answer. |
| Tools hidden | Any tool-shaped text | Suppress and retry natural-language answer. |
| Final-response-only | Any tool-shaped text | Suppress and retry final answer without tools. |

Initial dialect registry:

- `minimax_xml`
- `generic_xml_tool_call`
- `json_tool_calls_text`
- `dsml_fullwidth_tool_calls`

DSML starts as suppress-only until strict parser tests prove it can be safely normalized while tools are visible.

## Loop Budget And Finalization

Keep a hard upper bound, but expose the budget state:

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

Default behavior can remain compatible with today:

```text
maxProviderLoops=25
finalizationReserveLoops=3
```

The improvement is not to make the limit larger by default. The improvement is to make the runtime state explicit and allow one safe final check when the model is one bounded read-only operation away from answering.

## Final Check Policy

Grant `final_check` only when all conditions are true:

- the requested tool is `Read`, `Grep`, `Glob`, or `ListDir`;
- the tool call is bounded;
- target paths are inside task scope or already confirmed;
- no permission or scope boundary is pending;
- timeout and context budgets can safely absorb the call;
- the same input has not already failed;
- after the check, the next provider turn is `must_respond`.

Never grant `final_check` for `Write`, `Edit`, `Bash`, `TaskCreate`, `SkillSave`, MCP write tools, or Agent lifecycle tools.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase A | Partially Landed | Recoverable tool result path and structured repair hints. | Recoverable tool failures are provider-visible and paired to the original tool call. |
| Phase B | Active Plan | DSML and text-tool dialect registry. | Hidden-tool DSML is suppressed and retried; visible-tools DSML remains suppress-only until strict parser tests exist. |
| Phase C | Partially Landed | Loop budget diagnostics. | Invocation diagnostics and execution metrics expose loop state and finalization reason. (Iteration/phase/reason surfaced in execution state block; top repeated-tool input nudge wired via `findRepeatedToolInputs`. Typed `ToolLoopBudget` struct + `reason` field remain open.) |
| Phase D | Landed | One bounded `final_check`. | One read-only in-scope check can run before `must_respond`; write/execute/task tools are denied with `TOOL_DENIED_FINAL_CHECK`. Per-tool bounded enforcement deferred (Non-goal). |
| Phase E | Watch | Adaptive budget profiles. | Any expanded budget is justified by task intent, context pressure, timeout pressure, and tool novelty telemetry. |

## Verification

Minimum regression set:

- dash-leading `Grep` pattern returns a normal result or recoverable failure, not terminal `TOOL_ERROR`;
- generic thrown tool errors become provider-visible `tool_result is_error=true`;
- missing file, invalid input, ambiguous edit, and invalid glob remain recoverable;
- final-response-only plus DSML text is suppressed and retried;
- respond-only plus pseudo tool-call text is suppressed and retried;
- `final_check` allows only one read-only bounded tool call;
- `final_check` cannot execute write, edit, bash, task, skill-save, MCP write, or agent lifecycle tools;
- "continue task" after loop pressure starts a fresh execution budget while retaining recent failure diagnostics.

## Archived Source Documents

The following documents are superseded by this plan and now live in `archive/` for historical detail:

- [recoverable-tool-error-and-session-continuity-governance-plan.md](../archive/recoverable-tool-error-and-session-continuity-governance-plan.md)
- [tool-call-text-normalization-and-final-response-governance-plan.md](../archive/tool-call-text-normalization-and-final-response-governance-plan.md)
- [tool-loop-budget-and-finalization-governance-plan.md](../archive/tool-loop-budget-and-finalization-governance-plan.md)

## 中文概述

### 背景

这组问题表面上是三个文档：工具错误可恢复、伪工具调用文本泄漏、工具循环预算。但用户体验上其实是同一个问题：agent 还在任务链路里，却因为 runtime 边界不够清晰而突然失败、假装完成或过早停止。

### 核心做法

本文件把三条治理线合成一个 runtime tool-loop 连续性模型：普通工具失败要变成模型可见的 recoverable tool result；隐藏工具阶段的伪工具调用文本必须 suppress + retry；循环预算要显式化，并在安全条件下允许一次 bounded final check。

### 当前状态

Recoverable tool failure 的基础能力已部分落地；Phase D（`final_check` 一次有界只读检查）已落地，Phase C（loop budget diagnostics）已部分落地（执行状态块暴露迭代/阶段/原因 + 重复工具输入 nudge）。剩余打开项：DSML dialect registry、Phase C 的 typed `ToolLoopBudget` 结构、Phase D 的 per-tool bounded 强制。

### 下一步

优先补 DSML suppress regression，再视长任务 telemetry 决定是否补 typed budget 结构与 per-tool bounded 强制。不要通过简单提高 `maxLoops` 来掩盖长任务问题。
