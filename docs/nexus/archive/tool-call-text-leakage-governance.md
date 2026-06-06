# Non-standard Tool-call Text Leakage Governance Plan

> Date: 2026-06-05
> Scope: provider adapters, runtime tool loop, intent guidance, diagnostics, tests.
> Status: Phases A-C implemented; Phase D remains future corpus expansion.

## 1. Executive Summary

BabeL-O must treat non-standard tool-call text leakage as a cross-provider runtime safety issue, not as a single MiniMax formatting bug.

The concrete sample was MiniMax-M3 streaming a bracket-wrapped pseudo tool call during a `respond_only` turn:

```text
]<]minimax[>[<tool_call>
]<]minimax[>[<invoke name="Bash">]<]minimax[>[<command>cat package.json | head -80; ...</command>]
```

That sample exposed a general problem:

```text
A model can emit tool-call intent as ordinary assistant text when the runtime expects a final answer.
```

The product-level solution is two-layered:

1. Provider adapters strictly normalize known provider-specific text-encoded tool-call formats into standard tool-use deltas.
2. Runtime-level generic guards suppress unknown or disallowed tool-shaped text when tools are hidden, suppressed, or no longer allowed.

The runtime must never execute unknown textual tool-call syntax. Unknown tool-shaped text can be suppressed, diagnosed, or retried as a final-answer-only turn, but it must not be promoted into a real tool invocation.

## 2. Problem Statement

### 2.1 What happened

In session `session_93052ea7-8346-40a9-8175-db941312778c`, the latest user message was a clarification question:

```text
你的意思是可以直接在项目github仓库中搭建网站以进行文档说明？
```

The intake layer classified it as:

```json
{
  "actionHint": "respond_only",
  "requiresTools": false
}
```

The provider then streamed pseudo tool-call text. No real tool execution happened:

```text
toolCallCount=0
no tool_started
no tool_completed
no permission_request
no tool_denied
```

However, the pseudo tool call leaked into `assistant_delta` and `result.message`, which made the UI look like the agent tried to call Bash.

### 2.2 Why this matters

Even when no tool is executed, leaked pseudo tool calls are harmful because they:

- confuse the user about whether a dangerous command ran;
- pollute session history and future context;
- can be replayed into later provider calls;
- weaken the mental model of the permission boundary;
- obscure whether the failure is provider behavior, parser behavior, or runtime policy behavior.

### 2.3 Generalized issue

This is not only a MiniMax issue. MiniMax provided the concrete sample, but any model/provider can emit tool-like text, such as:

```text
<tool_call>...</tool_call>
<invoke name="Bash">...</invoke>
<minimax:tool_call>...</minimax:tool_call>
{"tool_calls":[...]}
{"function_call":{...}}
CALL_TOOL Bash {...}
```

BabeL-O needs generic governance for tool-intent leakage in assistant text.

## 3. Definitions

### 3.1 Standard tool call

A standard tool call is a provider adapter output represented as structured stream deltas:

```ts
type: 'tool_use_start'
type: 'tool_use_delta'
type: 'tool_use_end'
type: 'finish', reason: 'tool_use'
```

Only standard tool calls may enter the runtime tool loop.

### 3.2 Text-encoded tool call

A text-encoded tool call is provider text that encodes a tool invocation in a known provider-specific syntax.

Example:

```xml
<minimax:tool_call>
<invoke name="Read">
<parameter name="path">README.md</parameter>
</invoke>
</minimax:tool_call>
```

Known text-encoded formats may be normalized by a provider-specific strict parser.

### 3.3 Tool-shaped text

Tool-shaped text is assistant text that resembles a tool call but is not known-valid provider syntax, appears in a disallowed phase, or cannot be strictly parsed.

Tool-shaped text must never be executed.

### 3.4 Tool-call text leakage

Tool-call text leakage occurs when tool-shaped text reaches user-visible `assistant_delta` or final `result.message` in a context where it should have been normalized, suppressed, or diagnosed.

## 4. Safety Principles

### 4.1 Never execute unknown text syntax

Unknown tool-shaped text must not be promoted into a real tool invocation.

Correct behavior:

```text
unknown tool-shaped text -> suppress / diagnose / retry final answer
```

Incorrect behavior:

```text
unknown tool-shaped text -> execute tool
```

### 4.2 Provider-specific parsing must be strict

Provider adapters may normalize only provider-specific formats that are:

- known;
- complete;
- unambiguous;
- covered by tests;
- mapped into the standard tool-use delta stream.

Malformed or incomplete known syntax should remain non-executable and be handled by runtime leakage guards if it appears in a disallowed phase.

### 4.3 Runtime generic guards are suppression-only

Generic runtime guards may detect suspicious tool-shaped text, but they must not infer tool name, input, command, file path, or JSON arguments for execution.

### 4.4 Intent and phase matter

The same textual pattern has different handling depending on runtime state:

| Runtime state | Handling |
|---|---|
| Normal tool-enabled turn, known provider syntax | Adapter may normalize to standard tool_use. |
| Normal tool-enabled turn, unknown syntax | Do not execute; surface as text only if safe, otherwise diagnose. |
| `respond_only` / tools hidden | Suppress tool-shaped text and retry final answer or return safe diagnostic. |
| final-response-only after tool loop | Suppress tool-shaped text and record final-response-only violation. |
| after max tool loop / final answer required | Suppress; do not start a new tool loop. |

## 5. Target Architecture

```text
Provider stream
  -> provider adapter strict parser
    -> standard StreamDelta[]
      -> runtime tool loop
        -> intent / policy / permission gates
          -> tool executor

Provider stream
  -> text delta not parsed as standard tool_use
    -> runtime text leakage guard
      -> suppress / diagnose / retry final answer
      -> never execute
```

## 6. Provider Adapter Layer

### 6.1 Responsibility

Provider adapters own provider-specific normalization.

Examples:

- MiniMax text-encoded XML tool calls.
- Anthropic-compatible providers that emit special text wrappers.
- OpenAI-compatible providers with malformed-but-recoverable structured deltas.

### 6.2 MiniMax parser hardening

Current MiniMax parsing recognizes:

```xml
<minimax:tool_call>
<invoke name="Bash">
<parameter name="command">pwd</parameter>
</invoke>
</minimax:tool_call>
```

It should additionally recognize the observed bracket-wrapped format after strict normalization:

```text
]<]minimax[>[<tool_call>
]<]minimax[>[<invoke name="Bash">]<]minimax[>[<command>pwd</command>]
]<]minimax[>[</invoke>
]<]minimax[>[</tool_call>
```

Normalization should be explicit:

```text
strip exact MiniMax stream marker: ]<]minimax[>[
then parse a complete <tool_call>...</tool_call> block
```

Do not globally remove arbitrary bracket-like strings. Only strip the exact wrapper in MiniMax adapter code.

### 6.3 Supported MiniMax argument shapes

The parser may support both shapes when inside a known complete MiniMax tool-call envelope:

```xml
<parameter name="command">pwd</parameter>
```

and:

```xml
<command>pwd</command>
<timeoutMs>10000</timeoutMs>
```

The second shape must only be accepted inside a known complete MiniMax tool-call envelope.

### 6.4 Adapter output invariant

If a provider adapter recognizes a text-encoded tool call, it must output only structured tool-use deltas for that tool call. Raw XML/wrapper text must not also be streamed as assistant text.

## 7. Runtime Generic Leakage Guard

### 7.1 Responsibility

Runtime guards protect final user-visible text from tool-intent leakage across all providers.

They are provider-agnostic and suppression-only.

### 7.2 Guard activation conditions

The generic guard should activate when any of these is true:

- user-intent guidance says `respond_only`;
- `requiresTools=false`;
- tools are hidden from provider request;
- final-response-only mode is active;
- runtime has already completed allowed tool loops and expects a final answer;
- provider recovery requested a no-tools retry;
- max tool loop boundary has been reached.

### 7.3 Suspicious text patterns

The guard should detect conservative tool-shaped markers, such as:

```text
<tool_call
</tool_call>
<invoke name=
</invoke>
<minimax:tool_call
</minimax:tool_call>
"tool_calls"
"function_call"
```

Detection should be conservative and scoped to disallowed phases. In normal prose, users and models may discuss tool-call syntax. The guard should not remove code examples from legitimate explanatory answers unless the current runtime phase explicitly disallows tool intent.

### 7.4 Handling modes

Recommended handling order:

1. If the text is in a streaming delta, buffer until enough text is available to decide whether it is tool-shaped leakage.
2. If leakage is detected in a disallowed phase, do not emit the raw delta.
3. Emit a structured diagnostic event.
4. Retry once with a stronger final-answer-only system reminder if retry budget allows.
5. If retry fails or is disabled, return a safe final message explaining that a malformed tool-call-shaped response was suppressed.

### 7.5 Retry prompt requirement

The retry prompt must not include the raw command body if it may contain secrets or destructive commands. Use a redacted diagnostic:

```text
The previous model response attempted to emit tool-call-shaped text while tools are disabled. Answer the user's question directly in natural language. Do not include tool-call markup.
```

## 8. Diagnostics and Events

### 8.1 New diagnostic code

Add a generic diagnostic code:

```text
TOOL_CALL_TEXT_LEAK_SUPPRESSED
```

Use it when raw assistant text is suppressed because it looks like a tool call in a disallowed phase.

Keep existing narrower diagnostics where applicable:

```text
TOOL_CALL_SUPPRESSED_BY_USER_INTENT
TOOL_LOOP_FINAL_RESPONSE_ONLY
```

`TOOL_CALL_TEXT_LEAK_SUPPRESSED` can appear as the lower-level detection reason under those higher-level policy outcomes.

### 8.2 Event shape

Suggested event:

```ts
export type ToolCallTextLeakSuppressedEvent = {
  type: 'error'
  code: 'TOOL_CALL_TEXT_LEAK_SUPPRESSED'
  message: string
  details: {
    providerId?: string
    modelId?: string
    phase: 'respond_only' | 'tools_hidden' | 'final_response_only' | 'max_loop' | 'unknown'
    pattern: string
    redactedPreview: string
    retryAttempted: boolean
    retrySucceeded?: boolean
  }
}
```

Using `error` keeps compatibility with existing diagnostics. A future dedicated event type can be added if leakage analytics become important.

### 8.3 Metrics

Add execution metrics fields or derived diagnostics:

```text
toolCallTextLeakSuppressedCount
finalAnswerRetryCount
toolShapedTextPattern
```

These should be local diagnostics only. Do not add remote telemetry.

## 9. Session Context Hygiene

Suppressed raw tool-shaped text should not be inserted into future context as normal assistant text.

Recommended storage policy:

- Store a redacted diagnostic event.
- Do not store raw command bodies in user-visible result text.
- If raw text is needed for debugging, store only a bounded redacted preview in `details.redactedPreview`.
- Ensure compact summaries do not turn suppressed command bodies into future prompt content.

## 10. Permission Boundary

This governance does not weaken permissions.

All real tool execution still requires:

```text
standard tool_use delta
  -> tool availability check
  -> runtime policy check
  -> permission classifier/check
  -> tool executor
```

Text leakage suppression is before execution. It is not an alternate execution path.

## 11. Test Plan

### 11.1 Adapter tests

Add provider adapter tests for known text-encoded formats.

MiniMax cases:

```text
<minimax:tool_call> with <parameter name="...">
```

```text
]<]minimax[>[<tool_call> with direct child tags
```

Assertions:

- complete known syntax becomes standard tool-use deltas;
- raw wrapper/XML text is not emitted as text;
- incomplete syntax is not converted into tool-use;
- malformed syntax is not executed.

### 11.2 Runtime respond-only tests

Add focused runtime tests:

```text
respond_only + MiniMax bracket-wrapped Bash text
```

Assertions:

- no `tool_started`;
- no raw `<tool_call>` / `<invoke name="Bash">` in `assistant_delta`;
- no raw tool markup in `result.message`;
- diagnostic event exists;
- optional retry produces natural-language final answer.

### 11.3 Final-response-only tests

Cover leakage after a valid tool loop when the runtime is waiting for final answer only.

Assertions:

- additional pseudo tool-call text is suppressed;
- no new tool loop starts;
- final response is natural language or safe fallback;
- event code identifies final-response-only boundary.

### 11.4 Cross-provider tests

Use generic mocked provider streams for:

```text
{"tool_calls":[...]}
{"function_call":{...}}
<tool_call>...</tool_call>
CALL_TOOL Bash {...}
```

Only run these through generic runtime leakage guard in disallowed phases. Do not add broad adapter parsers for unknown formats.

### 11.5 Regression fixture

Create a fixture from session `session_93052ea7-8346-40a9-8175-db941312778c` with raw command redacted or minimized:

```text
]<]minimax[>[<tool_call>
]<]minimax[>[<invoke name="Bash">]<]minimax[>[<command>pwd</command>]
]<]minimax[>[<timeoutMs>10000</timeoutMs>]
]<]minimax[>[</invoke>
]<]minimax[>[</tool_call>
```

Do not include long real repository command bodies unless needed for parser coverage.

## 12. Implementation Phases

### Phase A: MiniMax sample containment — implemented

Deliver:

- MiniMax bracket-wrapper normalization in `AnthropicAdapter`.
- Direct child tag parsing inside known MiniMax tool-call envelope.
- Adapter regression for the observed format.

Acceptance:

- Known complete MiniMax bracket-wrapped calls normalize to standard tool-use deltas.
- Raw bracket wrapper does not reach assistant text.
- Unknown or incomplete syntax is not executed.

### Phase B: Runtime generic suppression guard — implemented

Deliver:

- Tool-shaped text detector for disallowed phases.
- Streaming buffer around final-answer text when tools are hidden/final-only.
- `TOOL_CALL_TEXT_LEAK_SUPPRESSED` diagnostic.
- Optional one-shot final-answer retry.

Acceptance:

- `respond_only` leakage does not appear in `assistant_delta` or `result.message`.
- No real tool call starts from generic detection.
- Existing normal tool-use flow is unchanged.

### Phase C: Context hygiene and diagnostics polish — implemented

Deliver:

- Redacted diagnostic previews.
- Context assembler avoids treating suppressed tool-shaped text as normal assistant content.
- `/context` or runtime diagnostics show leak suppression count/reason.

Acceptance:

- Suppressed command bodies do not pollute future context.
- User-visible diagnostics are clear but do not leak sensitive command text.

### Phase D: Provider corpus expansion

Deliver:

- Cross-provider text leakage regression corpus.
- Provider-specific parser registry only for known formats.
- Documentation in provider adapter tests explaining strict-vs-generic boundary.

Acceptance:

- New provider-specific formats require explicit tests before normalization.
- Generic guard remains suppression-only.

## 13. Non-goals

- Do not execute unknown text-encoded tool calls.
- Do not add broad regex-to-tool execution.
- Do not trust model-emitted JSON/XML as approval metadata.
- Do not bypass existing permission policy.
- Do not disable standard provider-native tool calls.
- Do not make MiniMax-specific behavior leak into all adapters except through the generic suppression guard.
- Do not store full leaked command bodies in compact summaries or future prompt context.

## 14. Recommended First PR

Files likely involved:

```text
src/providers/adapters/AnthropicAdapter.ts
test/adapters.test.ts
src/runtime/LLMCodingRuntime.ts
src/runtime/runtimeToolLoop.ts
test/runtime-llm.test.ts
src/runtime/contextAssembler.ts
src/runtime/contextAnalysis.ts
```

Start with:

1. Add adapter regression for the exact MiniMax bracket-wrapper sample.
2. Extend MiniMax parser with exact wrapper stripping and direct child tag parsing.
3. Add runtime-level respond-only leakage suppression regression.
4. Implement generic suppression-only guard.

## 15. Final Recommendation

Treat MiniMax-M3 as the first regression sample, not as the whole problem.

The long-term invariant should be:

```text
Only standard tool-use deltas can execute tools.
Known provider text formats may become standard tool-use deltas through strict adapter parsers.
Unknown or disallowed tool-shaped text is suppressed and diagnosed, never executed and never leaked as final answer text.
```
