# Recoverable Tool Denial Governance Plan

## Problem

Some runtime guardrails currently end the whole turn with `result(success=false)` as soon as a provider asks for a denied tool. This is safe, but too brittle for conversational agent work: the model often can recover by choosing another tool, asking the user for confirmation, or answering with existing context.

The `TOOL_CALL_NEEDS_USER_CONFIRMATION` flow introduced for ambiguous option input is the model for this governance pass: policy conflicts should become recoverable whenever the user has not explicitly made a final decision.

## Policy

### Recoverable by default

The provider loop should return a failed `tool_result` to the model instead of terminating the turn for:

- Tool policy denial (`Tool denied by Nexus policy`)
- Pre-tool hook denial
- Optimizer safety denial
- Invalid tool input
- Unknown tool names

The event stream should still include `tool_denied` / `tool_completed(success=false)` for UI and audit visibility, but the provider should get a `tool_result` with `isError: true` so it can choose the next step.

### Hard terminal by default

The runtime should keep terminal behavior for:

- Explicit user permission denial after `permission_request`
- Request cancellation (`REQUEST_CANCELLED`)
- Hard watchdog timeout (`REQUEST_TIMEOUT`)
- Context blocking after compact attempts fail
- Max loops exceeded
- Repeated empty / max-token provider failures after recovery attempts are exhausted
- Final-response-only safety loops after repeated violations

These are not mere model mistakes; they represent user intent, infrastructure cutoffs, or loop-safety boundaries.

## UX Contract

When a recoverable denial happens, the model should receive clear guidance:

- What was denied
- Why it was denied
- What alternatives are acceptable
- Whether user confirmation is required

Example:

```text
Tool denied by Nexus policy: Bash.
Choose an allowed read-only tool, ask the user to approve the operation, or answer from existing context.
```

## Implementation Plan

1. Provider runtime first: complete.
   - `executeProviderToolCall` policy / hook / optimizer denial now returns a recoverable `tool_result` with `isError: true`.
   - `permission_response(approved=false)` remains terminal and emits `tool_denied(terminal=true, denialKind='permission')`.

2. Local runtime second: complete within the direct-runtime boundary.
   - Direct local policy / optimizer / hook denials now emit `tool_denied(recoverable=true, denialKind=...)`.
   - Direct local calls still emit a local `result(success=false)` explanation because there is no provider follow-up turn to consume a `tool_result`.
   - HTTP / WebSocket execute envelopes classify turns whose only failure is a recoverable tool denial as non-fatal success/outcome `success`, so clients do not present them as cancelled runtime failures.

3. UI polish: complete.
   - TypeScript CLI history renders recoverable denials as `blocked recoverable` compact tool rows.
   - Go TUI renders recoverable `tool_denied` as `blocked recoverable` and reads the canonical `message` field.
   - Explicit permission denial keeps the red denied/failed flow.

4. Regression tests: complete.
   - Provider policy / hook / optimizer denials return recoverable tool results.
   - Provider disallowed-tool flow lets the model answer after the denial.
   - Local policy / optimizer denials carry `recoverable=true`.
   - User permission denial still emits `result(false)` and `terminal=true`.
   - CLI and Go TUI render recoverable denials distinctly from terminal permission denials.

## Completed Changes

- `ToolDeniedEventSchema` now includes optional `denialKind`, `recoverable`, and `terminal` fields.
- Provider loop recoverable denials:
  - `denialKind='policy'`
  - `denialKind='hook'`
  - `denialKind='optimizer_safety'`
- Direct local runtime recoverable denials use the same event contract.
- Execute finalization treats recoverable-denial-only direct turns as non-fatal.
- UI renderers avoid showing recoverable denials as fatal cancelled turns.

## Verification

Passed:

```bash
npx tsc --noEmit
NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime.test.ts test/optimizer-safety.test.ts test/tui-renderer.test.ts
cd clients/go-tui && go test ./...
```

## Non-goals

- Do not auto-approve tools.
- Do not bypass permission prompts.
- Do not weaken destructive-operation safety.
- Do not remove terminal watchdog / cancellation behavior.
