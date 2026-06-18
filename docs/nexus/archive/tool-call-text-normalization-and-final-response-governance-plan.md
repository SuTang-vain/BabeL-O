# Tool-call Text Normalization and Final-response Governance Plan

> Superseded by [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md). Keep this file for one cleanup cycle as detailed regression context; do not use it as the current runtime tool-loop source of truth.
>
> Status: Proposed, regression-backed by `session_ee116547-6545-4f70-bc7c-b1b287387cda` on 2026-06-17.
> Priority: P1 because it can produce user-visible fake tool calls and false completion.
> Scope: provider text-stream normalization, DSML / pseudo tool-call detection, final-response-only mode, runtime-owned tool execution boundaries.
> Related plans: [tool-governance-reference-integration.md](./tool-governance-reference-integration.md), [tool-granularity-and-evidence-governance-plan.md](./tool-granularity-and-evidence-governance-plan.md), [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md), [intent-guidance-and-prompt-governance-optimization-plan.md](../proposals/intent-guidance-and-prompt-governance-optimization-plan.md).

## 1. Background

Real session `session_ee116547-6545-4f70-bc7c-b1b287387cda` ended successfully from the runtime's perspective, but the final user-visible result was raw DSML text:

```text
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="Grep">
...
</｜｜DSML｜｜tool_calls>
```

The last invocation metadata showed:

```text
loopCount=22
maxLoops=25
finalResponseOnlyMode=true
visibleToolCount=0
```

So tools were intentionally hidden, but the provider still emitted tool-call-shaped text. The existing runtime guard suppresses known text encodings such as `<tool_call>`, `<invoke name=`, `<minimax:tool_call>`, `"tool_calls"`, and `call_tool `, but it did not recognize the full-width DSML dialect.

This is a runtime governance issue, not a Go TUI rendering issue. Clients may render events, but Nexus/runtime must decide whether text is executable, suppressed, or ordinary assistant output.

## 2. Problem Statement

There are two distinct classes of text-shaped tool call:

1. **Normalizable text tool calls while tools are visible**: provider emits a known, parseable text protocol even though native provider tool calls were available.
2. **Forbidden tool-call text while tools are hidden**: provider emits tool markup during `respond_only`, `tools_hidden`, or `final_response_only`.

The current implementation partially handles class 2 for MiniMax-like XML-ish formats, but misses DSML. It does not define a generic dialect registry or an explicit policy matrix.

## 3. Goals

- Prevent raw tool-call markup from being shown as a successful final answer.
- Keep runtime ownership: text tool calls can only become real tool calls through runtime/parser policy.
- Never execute text-encoded tools when tools are intentionally hidden.
- Preserve provider protocol safety and existing permission / task scope gates.
- Make the behavior observable through error events, metrics, and regression tests.

## 4. Non-goals

- Do not let clients or Go TUI parse DSML into tool calls.
- Do not execute DSML by string eval or by bypassing provider tool schemas.
- Do not add a new broad `Search` tool to compensate for failed `Grep`.
- Do not remove `finalResponseOnlyMode`.
- Do not silently rewrite all XML-like assistant text. Only registered dialects may be interpreted.

## 5. Policy Matrix

| Runtime state | Text dialect recognized | Action |
| --- | --- | --- |
| Tools visible | Strictly parseable registered dialect | Normalize to `RuntimeProviderToolCall`; execute through normal tool loop |
| Tools visible | Unknown tool-shaped text | Suppress and retry once, or return diagnostic if unsafe |
| `respond_only` | Any tool-shaped text | Suppress; emit `TOOL_CALL_TEXT_LEAK_SUPPRESSED`; retry natural-language answer |
| `tools_hidden` | Any tool-shaped text | Suppress; emit `TOOL_CALL_TEXT_LEAK_SUPPRESSED`; retry natural-language answer |
| `final_response_only` | Any tool-shaped text | Suppress; emit `TOOL_CALL_TEXT_LEAK_SUPPRESSED`; retry final answer without tools |

## 6. Dialect Registry

Add a small internal registry for text-tool dialects:

```ts
type TextToolDialect = {
  id: string
  detect(text: string): boolean
  parse?(text: string): ParsedTextToolCall[]
  redactPreview(text: string): string
  executableWhenToolsVisible: boolean
}
```

Initial dialects:

- `minimax_xml`: existing `<minimax:tool_call>` and bracket-wrapped variant.
- `generic_xml_tool_call`: existing `<tool_call><invoke name=...>`.
- `json_tool_calls_text`: existing `"tool_calls"` / `"function_call"` markers, suppress-only unless fully structured provider deltas are present.
- `dsml_fullwidth_tool_calls`: full-width DSML markers:
  - `<｜｜DSML｜｜tool_calls>`
  - `<｜｜DSML｜｜invoke name="...">`
  - `<｜｜DSML｜｜parameter ...>`

DSML should initially be suppress-only in hidden-tool modes. Executable normalization can be a later phase after strict parser tests exist.

## 7. Phases

### Phase A: DSML leak suppression

Status: proposed.

Implementation:

- Extend `detectToolCallTextLeak()` to detect DSML markers.
- Redact DSML parameter bodies in preview, especially command-like or content-like parameters.
- Add regression where final-response-only emits DSML and runtime retries once with a natural-language answer.

Acceptance:

- No `assistant_delta` or `result.message` includes raw DSML after suppression.
- `error.code = TOOL_CALL_TEXT_LEAK_SUPPRESSED`.
- `details.pattern` identifies the DSML marker.
- `execution_metrics.toolCallTextLeakSuppressedCount = 1`.

### Phase B: Text dialect registry

Status: proposed.

Implementation:

- Replace hardcoded pattern list with registry-backed detection.
- Keep all existing MiniMax regressions green.
- Expose dialect id in `details.dialect`.

Acceptance:

- Existing `<tool_call>` and MiniMax tests keep passing.
- DSML is covered by table-driven tests.
- Unknown tool-shaped text remains suppress-only.

### Phase C: Visible-tools normalization spike

Status: proposed, gated by regression.

Implementation:

- Parse a narrow DSML subset into `RuntimeProviderToolCall`.
- Require valid known tool name and JSON-schema-compatible parameter mapping.
- If parse fails, emit recoverable tool-input diagnostic, not raw assistant text.

Acceptance:

- When tools are visible, DSML `Grep` can become a normal tool call.
- Permission, scope boundary, and tool policy events are identical to native provider tool calls.
- When tools are hidden, the same DSML is never executed.

### Phase D: Provider capability metadata

Status: future.

Track providers/models that often emit text-tool dialects. Diagnostics should show whether a provider produced native tool calls or required text normalization. This is observability only; it must not change execution safety defaults.

## 8. Regression Set

Minimum tests:

- final-response-only + DSML text leak is suppressed and retried.
- respond-only + DSML text leak is suppressed and retried.
- tools visible + DSML remains suppress-only until Phase C is explicitly implemented.
- DSML preview redaction does not leak command/content parameter bodies.
- Existing MiniMax text-tool normalization tests remain unchanged.

## 9. Operational Guidance

If a session ends with raw DSML in `result.message`, treat it as a runtime leak, not as a completed tool execution. Inspect invocation metadata for `visibleToolCount` and `finalResponseOnlyMode` before blaming the client. If tools were hidden, the correct recovery is a fresh user turn or a runtime retry, not client-side execution of the text.
