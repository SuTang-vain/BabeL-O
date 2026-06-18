# Recoverable Tool Error and Session Continuity Governance Plan

> Superseded by [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md). Keep this file for one cleanup cycle as detailed regression context; do not use it as the current runtime tool-loop source of truth.
>
> Status: Phase A/B implemented on 2026-06-17; Phase C lightweight repair hints and tool-level structured recoverable failures implemented for the current built-in tool surface; Phase D remains proposed.
> Priority: P1 because terminalized tool errors make the agent appear to forget the active task.
> Scope: tool executor error taxonomy, provider-visible recovery messages, `TOOL_ERROR` handling, session replay continuity, and recovery boundary selection.
> Related plans: [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md), [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md), [tool-granularity-and-evidence-governance-plan.md](./tool-granularity-and-evidence-governance-plan.md), [tool-loop-budget-and-finalization-governance-plan.md](./tool-loop-budget-and-finalization-governance-plan.md).

## 1. Background

In `session_ee116547-6545-4f70-bc7c-b1b287387cda`, the provider attempted:

```json
{
  "name": "Grep",
  "input": {
    "pattern": "- \\[ \\]",
    "path": "/Users/tangyaoyue/DEV/BABEL/BabeL-O/docs/nexus/active/TODO_tui.md",
    "maxMatches": 30
  }
}
```

The built-in `Grep` tool called ripgrep without a `--` separator before the pattern. Because the pattern began with `-`, ripgrep interpreted it as a flag and failed:

```text
rg: unrecognized flag -
```

The runtime emitted:

```text
error code=TOOL_ERROR
execute_summary outcome=error
```

The user-visible effect was not just the failed grep. After the tool failure, the next agent turn appeared to lose the task thread. The model did not receive a normal `tool_result is_error=true` containing the failed input and repair hint, so it could not naturally correct the call.

## 2. Problem Statement

Current handling distinguishes:

- schema/input failures: recoverable `tool_completed success=false`, provider sees `tool_result is_error=true`;
- workspace path failures: recoverable `tool_completed success=false`;
- generic thrown tool errors: terminal `error code=TOOL_ERROR`.

The last class is too broad. Many thrown errors are ordinary recoverable execution failures:

- command-line argument issue,
- missing binary,
- invalid regex,
- file temporarily unavailable,
- nonzero command where a tool should return structured failure,
- remote runner recoverable failure.

Terminalizing these errors cuts the provider feedback loop and makes the next turn depend on lossy history selection.

## 3. Goals

- Convert recoverable tool execution failures into provider-visible `tool_result is_error=true`.
- Keep truly fatal failures terminal.
- Preserve auditability through `tool_completed success=false`, hook events, and optional diagnostics.
- Make the latest failure visible in subsequent turns through recovery boundaries or session summaries.
- Provide tool-specific repair hints when possible.

## 4. Non-goals

- Do not hide real runtime crashes.
- Do not retry tools automatically without model or user involvement.
- Do not bypass permission, task scope, or path safety.
- Do not make every failure successful. `success=false` must remain explicit.
- Do not rely on long-term memory to remember tool failures.

## 5. Error Taxonomy

### Recoverable tool result

Return `kind: 'result', success: false` when the tool process/function ran but failed in a way the model can repair:

```ts
{
  code: 'TOOL_EXECUTION_FAILED',
  toolName,
  message,
  repairHint,
  input,
  details
}
```

Examples:

- ripgrep `code=2` for invalid CLI argument or regex,
- JavaScript `RegExp` compile failure,
- `ENOENT` for optional helper binary when fallback exists or user can choose another path,
- remote runner structured failure,
- tool-level validation that happens after schema parsing.

### Terminal runtime error

Keep terminal `error` for:

- user cancellation,
- request timeout / hard watchdog,
- context blocking,
- provider transport failure,
- permission registry corruption,
- uncaught invariant violation,
- storage corruption,
- repeated recovery failure.

## 6. Provider-visible Repair Contract

Whenever a recoverable tool failure happens, the next provider message should contain:

```text
Tool <name> failed with recoverable error.
Input: <bounded redacted input>
Error: <bounded message>
Repair hint: <tool-specific hint>
Return a corrected tool call or answer from existing evidence.
```

This should be carried as a `tool_result` content block with `isError=true`, paired with the original `tool_use` id. That keeps provider replay protocol-safe and lets the model correct itself in the same execution loop.

## 7. Grep-specific Fix

The sample exposes a concrete `Grep` bug:

```text
rg -n --max-count 31 - \[ \] path
```

should be:

```text
rg -n --max-count 31 -- - \[ \] path
```

`Grep` should add `--` before the pattern. A regression must cover a pattern beginning with `-`, especially Markdown checkbox search:

```text
- [ ]
- [x]
```

This specific fix belongs in `Grep`, but the governance issue is broader: thrown tool errors should not automatically become terminal request errors.

## 8. Recovery Boundary Policy

`TOOL_ERROR` is currently not a recovery boundary. That means recent-event selection may keep too much old context and not focus the next turn on the failure.

Recommended path:

1. Stop emitting terminal `TOOL_ERROR` for recoverable execution failures.
2. Introduce `TOOL_EXECUTION_FAILED` as a recoverable `tool_completed success=false` output code.
3. For rare terminal tool infrastructure errors, emit `TOOL_INFRASTRUCTURE_ERROR` and include it in recovery boundary selection.

If backward compatibility requires keeping `TOOL_ERROR`, then add structured details:

```ts
details: {
  recoverable: boolean
  toolName: string
  toolUseId: string
  repairHint?: string
}
```

Only `recoverable=false` should end the execution.

## 9. Phases

### Phase A: Grep pattern separator hotfix

Status: implemented and verified.

- Insert `--` before ripgrep pattern.
- Add test for `pattern: '- \\[ \\]'`.

Acceptance:

- `Grep` can locate unchecked Markdown tasks.
- No `TOOL_ERROR` is emitted for pattern beginning with `-`.

### Phase B: Recoverable generic tool execution failures

Status: implemented and verified.

- Change `executeProviderToolCall()` behavior for `executeToolSafely()` generic errors that are classified recoverable.
- Yield `tool_started` if not already yielded.
- Yield `tool_completed success=false`.
- Return `toolResult isError=true` instead of terminal.

Acceptance:

- Mock tool throw becomes provider-visible tool result.
- Next provider request includes a paired tool result.
- Existing cancellation/timeout terminal tests remain terminal.

### Phase C: Tool-specific repair hints and structured tool failures

Status: implemented for the current built-in tool surface; a formal exported registry remains future work.

Add a lightweight classifier:

```ts
type ToolFailureRepairHint = {
  code: string
  match(toolName: string, error: unknown, input: unknown): boolean
  hint: string
}
```

Initial hints:

- `GREP_PATTERN_STARTS_WITH_DASH`: use `--` before pattern; internal tool should already do this.
- `GREP_INVALID_REGEX`: simplify regex or escape special characters.
- `READ_NOT_FOUND`: verify path with `Glob` or `ListDir`.
- `BASH_COMMAND_NOT_FOUND`: verify dependency or use dedicated tool.

Current implementation note: `executeToolSafely()` now attaches lightweight repair hints for `Grep`, `Read`, `Write`, `Edit`, `Glob`, `Bash`, `TaskCreate`, and generic tools when converting thrown tool errors to `TOOL_EXECUTION_FAILED`.

Built-in tools that previously had unstructured or thrown recoverable paths now return stable `success=false` outputs:

- `Write`: `WRITE_FAILED` for parent path / file-system write failures.
- `Edit`: `EDIT_FILE_NOT_FOUND`, `EDIT_READ_FAILED`, `EDIT_OLD_STRING_NOT_FOUND`, `EDIT_OLD_STRING_NOT_UNIQUE`, `EDIT_WRITE_FAILED`.
- `Glob`: `GLOB_FAILED` for unexpected ripgrep/glob execution failures.
- `TaskCreate`: `TASK_SAVE_FAILED` when task persistence fails.
- `contextSearch` / `contextRecent` / `contextSummarize`: `CONTEXT_*` structured failures.
- `WebSearch`: `WEB_SEARCH_FAILED` for provider/network/search failures.

### Phase D: Recovery boundary and context analysis

Status: proposed.

- Add terminal tool infrastructure errors to recovery boundary.
- Include latest recoverable tool failure in `/context` diagnostics and loop health.
- Session summary should preserve notable recoverable tool failures.

Acceptance:

- After a tool failure, context recommendations say to correct or answer from existing evidence.
- The next turn does not drift back to stale earlier tasks.

## 10. Regression Set

- `Grep` pattern beginning with `-` succeeds.
- Generic thrown recoverable tool error produces `tool_completed success=false`.
- Provider replay includes paired `tool_use` and `tool_result is_error=true`.
- Timeout/cancel still emits terminal request events.
- Recovery boundary selection does not trim away the latest terminal infrastructure error.
- Session summary includes the latest recoverable tool failure code and hint.

## 11. Operational Guidance

When a tool fails, inspect whether there is a paired `tool_completed success=false`. If yes, the model had a chance to recover. If the event stream jumps from `tool_started` to terminal `error`, treat it as a continuity bug unless the error is cancellation, timeout, provider failure, or runtime infrastructure failure.
