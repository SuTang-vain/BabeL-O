# Tool-Pair Message Ordering Plan (Phase 5)

> State: Draft
> Track: Context
> Priority: P0
> Source of truth: TODO_runtime, source files, real-session fixture
> Related: `adaptive-context-window-selection-plan.md`, `context-search-algorithm-robustness-plan.md`

## Purpose

Guarantee that `mapEventsToMessages` emits a message sequence whose
`assistant(tool_use) ↔ user(tool_result)` pairs are **contiguous**: every
`tool_use` is followed, with no other `user` or `assistant` messages in
between, by a `user` message containing exactly the matching
`tool_result` blocks. This is the minimum condition required by both the
Anthropic Messages API and OpenAI Chat Completions, and it is also the
strict condition enforced by `MiniMax` (provider id `minimax`,
endpoint `https://api.minimaxi.com/anthropic`).

The plan exists to close a real-session regression observed in
`session_6ce63133-fecb-4c03-adf2-349f38074c98` (6 turns, 4 PROVIDER_ERROR
400s back-to-back in turns 3-6).

## Current State

Implemented (in `src/runtime/eventsTranslator.ts`):

- `mapEventsToMessages` walks the event stream and produces
  `ModelMessage[]` for the next provider call.
- Tool pairing is *set-correct* (every `tool_use` has a matching
  `tool_result` somewhere later in the array) but **not order-correct**:
  runtime-injected events such as `scope_boundary_detected`,
  `scope_boundary_confirmed`, `task_scope_declared`,
  `context_grounding_required`, `context_grounding_confirmed`,
  `workspace_dirty_detected`, `near_timeout_warning`,
  `timeout_budget_exceeded`, and `timeout_extension_granted` are
  pushed as standalone `user` messages in event order, between an
  `assistant(tool_use=[…])` and the `tool_result` blocks that close it.
- `AnthropicAdapter.validateAnthropicToolMessageSequence` only checks
  for orphan and duplicate `tool_result` blocks; it does **not** check
  contiguity. The validator passes locally; the **provider** rejects
  at request time.

Evidence:

- `session_6ce63133-fecb-4c03-adf2-349f38074c98` — 4 consecutive 400s:
  - seq 192 / 232 — `minimax`: `tool call result does not follow tool call (2013)`
  - seq 248 / 264 — `deepseek/deepseek-v4-pro`: `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)`
- `Phase 1-4` (`fix/adaptive-context-window-selection`) only relaxes
  selection caps under headroom; it does **not** fix this messages
  bug. percentUsed in this session is 7-9% throughout, so headroom
  was already active and the messages bug is the only remaining cause.

## Problem Statement

When a single assistant turn fans out N tools in parallel and one of
them is suspended for an out-of-band user interaction (scope
boundary → permission_request → permission_response →
scope_boundary_confirmed) the tool pair ends up split across
multiple `user` messages:

```
assistant  [tool_use A, B, C, D]
user       [tool_result A, B, C]                 ← pair-incomplete
user       "Runtime scope boundary detected …"  ← runtime-injected
user       "Runtime scope boundary confirmed …" ← runtime-injected
user       [tool_result D]                       ← D closed late
```

OpenAI Chat Completions and the Anthropic Messages API both forbid
this layout: a `tool_use` block must be closed by a `user` message
whose `tool_result` blocks address every `tool_use_id` from the
previous assistant message, with no other message in between. The
local validator in `AnthropicAdapter` is laxer than the wire
protocol. Some providers (`minimax`, `deepseek-v4-pro`) enforce
strict contiguity and reject the whole request with HTTP 400, even
though the offending pair belongs to an earlier turn that already
returned `success: true`.

Real session regression summary:

| Turn | Tool pair that fails on replay | Provider | Error code | Local validator |
| ---- | ------------------------------ | -------- | ---------- | --------------- |
| 3 loop 2 | `a0f0a18b` (Glob, scope-boundary suspended in turn 2) | minimax | 2013 | passes |
| 3 loop 2 (replay) | same | minimax | 2013 | passes |
| 4 loop 1 | same pair replayed from turn 2 | minimax | 2013 | passes |
| 4 loop 1 (replay) | same | minimax | 2013 | passes |
| 5 loop 1 | same pair | deepseek | insufficient tool messages | passes |
| 6 loop 1 | same pair | deepseek | insufficient tool messages | passes |

All four rejections trace back to the **single** misordered pair from
turn 2 (`call_019eeec4a8687d83a0f0a18b` Glob on
`/Users/tangyaoyue/DEV/Baidu`). The fix is purely local: produce
contiguous pairs in `mapEventsToMessages`.

## Goals

- **Contiguous pairs**: every `assistant(tool_use=[…])` is followed
  by exactly one `user(tool_result=[…])` whose blocks address every
  id in the assistant message.
- **Replay safety**: a session that was originally accepted by the
  provider must continue to be accepted when replayed from any
  later point (this is what was broken in
  `session_6ce63133`).
- **Strict local validator**: tighten
  `validateAnthropicToolMessageSequence` to require contiguity so
  the local check matches the wire-protocol contract and catches
  regressions in unit tests before they ship.
- **Zero semantic loss**: every event currently emitted as a `user`
  message (scope boundary, grounding, scope declared, etc.) must
  still be visible to the model — just *moved* to a position that
  does not split a tool pair.

## Non-goals

- No change to provider-adapter selection logic, retry policy, or
  fallback handling. The fix is in the events → messages
  translation layer.
- No change to which events are recorded; only the order in which
  they are folded into `ModelMessage[]` changes.
- No change to `selectRecentEvents`, the headroom signal, the
  compact policy, or the cache policy. Phase 1-4 work stands.
- No change to Nexus state ownership or to the three-tier
  Working Set / Recent / On-Demand model.
- Not addressing non-tool-pair issues (orphan tool result, missing
  tool_use) — those are separately tracked and out of scope here.

## Design

Single-change scope: refactor `mapEventsToMessages` from
*event-order push* to *pair-anchored buffering*, then tighten the
local validator.

### Translation strategy

The current loop walks events in order and either pushes messages
inline (`user_message`, runtime events) or extends a pending
`tool_result` user message (`tool_completed`). It also resets
`pendingToolResultMsg = null` whenever a runtime event arrives,
which is the precise cause of pair splitting.

The new strategy buffers in three slots per "tool round":

1. `pendingAssistantToolUse` — `ModelMessage | null`. When
   `tool_started` is seen for a tool_use_id that has not yet been
   opened, an `assistant` message with `[tool_use]` block is created
   and remembered. New `tool_use` blocks for the same assistant
   message are appended as long as no `tool_result` has been emitted
   for any id in the message. (Parallel tool calls share one
   assistant message, matching OpenAI semantics.)
2. `pendingToolResult` — `ModelMessage | null`. Created lazily when
   the first `tool_completed` for a buffered tool_use arrives. All
   matching `tool_result` blocks for the buffered assistant
   message are appended here. As soon as the buffered assistant's
   tool_use ids are *all* covered, the pair
   `[assistant, user(tool_result)]` is flushed.
3. `deferredRuntimeUserMessages` — `string[]`. Runtime-injected
   events (scope boundary, grounding, scope declared, etc.) that
   arrive *while a tool round is in flight* are queued, not pushed.
   When the round flushes, the queue is drained *after* the
   `user(tool_result)` message, in original order.

The previous `pendingToolResultMsg` reset is removed: a runtime
event arriving mid-round is buffered, not flushed.

### Flush triggers

The pair `[assistant, user(tool_result)]` is flushed (and any
deferred runtime messages appended after it) when:

- all tool_use ids from the buffered assistant have a matching
  `tool_completed`, **or**
- the next event is `tool_started` for a different assistant
  message, **or**
- the next event is `user_message` (new turn), **or**
- we reach the end of the event stream.

In the `tool_completed` count short of full coverage case (e.g. a
tool was started but interrupted before completion), the existing
synthetic `tool_result` "Tool execution was denied or interrupted."
path is invoked **before** the flush, so the pair closes.

### Validator

`validateAnthropicToolMessageSequence` becomes:

1. Reject orphan `tool_result` (existing).
2. Reject duplicate `tool_result` (existing).
3. Reject any `user` message that contains `tool_result` blocks
   whose matching `tool_use` is not in the *immediately preceding*
   `assistant` message (new).
4. Reject any `assistant(tool_use=[…])` whose tool_use ids are not
   all addressed by the *immediately following* `user` message
   (new). Pure-text `assistant` messages do not require a
   following `user(tool_result)`.

The validator is called from `AnthropicAdapter` and any future
adapter that maps to an Anthropic-Messages-shaped wire format. The
`OpenAIAdapter` is unaffected for now — it does not share the same
validator today — but the fix to `mapEventsToMessages` means
`OpenAIAdapter` also benefits.

### Why not reorder in the adapter?

The wire payload the adapter emits is a serialization of
`ModelMessage[]` produced by the runtime. Reordering in the
adapter would couple protocol concerns to events semantics and
would leave the local validator laxer than the wire contract,
allowing the same regression to resurface. Producing correct
`ModelMessage[]` in one place (the events translator) is the
single-source-of-truth fix.

## Phases

| Phase | Status      | Scope                                                                              | Exit criteria                                                                                          |
| ----- | ----------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 0     | Draft       | Repro script that replays `session_6ce63133` through `mapEventsToMessages` and prints the offending pair + the two non-`tool_result` user messages that split it. | Script exits 0 and prints a deterministic report naming `call_019eeec4a8687d83a0f0a18b` as the offender. |
| 1     | Draft       | Refactor `mapEventsToMessages` to pair-anchored buffering + deferred runtime user message queue. Update `selectRecentEvents`-driven message assembly call sites so the new contract is used everywhere. | Unit tests pass; repro script from Phase 0 now reports the pair as contiguous; `MapEventsToMessagesOptions` API is backward compatible. |
| 2     | Draft       | Tighten `validateAnthropicToolMessageSequence` to enforce contiguity. Add unit tests for: orphan in non-adjacent slot, duplicate, split pair, parallel tools (multiple tool_use in one assistant), multiple sequential rounds. | New tests fail on the unfixed code, pass on the fixed code; existing tests still pass.                  |
| 3     | Draft       | Real-session replay gate: re-run `session_6ce63133` from seq 168 onward and assert (a) no PROVIDER_ERROR 400 from the offending pair, (b) the synthetic `tool_result` path is not triggered for the scope-boundary Glob, (c) the assistant text reply still appears. | Gate script exits 0; all four back-to-back 400s are absent.                                              |
| 4     | Draft       | Move plan from `reference/` to `active/` if any phase reopens; close on green Phase 3. Update `DONE.md` and `WORK_LOG.md` with session id and reproducer hash. | `DONE.md` and `WORK_LOG.md` updated; plan status moved to `Closed Reference`.                          |

## Verification

- **Type & lint**: `pnpm typecheck`, `pnpm deps:audit`,
  `pnpm docs:check` (the docs:check tool may need the new plan
  file added to the reference index; check the existing index for
  the format).
- **Unit tests**: `pnpm test test/eventsTranslator.test.ts` (if
  present) and `pnpm test test/context-assembler.test.ts`. New
  tests in Phase 2 must run on both legacy and Phase 1-4 code
  paths.
- **Repro script**: `scripts/repro-tool-pair-ordering-260622.mjs`
  reads the real DB row, feeds the same event slice to
  `mapEventsToMessages`, and asserts the pair is contiguous. Must
  fail on `origin/develop` and pass on the fixed code.
- **Real-session replay**: an integration smoke that boots the
  runtime with a fixed `session_6ce63133`-style fixture, drives
  the same 4 misordered tool flow, and asserts the next provider
  call returns success on each subsequent turn. (Implemented as a
  scripted loop in the repro, not as a full TUI session.)
- **Regression cluster**: `pnpm test test/regressions` (348
  tests) — must still pass with no flake. Headroom tests
  (Phase 1-4) are not affected.

## Document Ownership

- This plan is owned by the Context track.
- Implementation is owned by `src/runtime/eventsTranslator.ts`
  (translation) and `src/providers/adapters/AnthropicAdapter.ts`
  (validator). No other file is expected to change.
- The repro script lives at
  `scripts/repro-tool-pair-ordering-260622.mjs`.
- After Phase 4 closes, this plan graduates to `Closed Reference`
  and the per-phase summary moves to `DONE.md`. Detailed session
  evidence and per-commit observations stay in `WORK_LOG.md`.

## 中文概述

### 背景

真实 session `session_6ce63133-fecb-4c03-adf2-349f38074c98` 的
turn 3-6 连续 4 次拿到 provider 400,根因不是 headroom
(全程 percentUsed 7-9%, Phase 1-4 一直在生效),而是
`mapEventsToMessages` 在 turn 2 留下的一对未闭合的
`assistant(tool_use) ↔ user(tool_result)`:Glob 因 scope boundary
被用户授权前中断,runtime 在 tool 还在飞的时候注入
`scope_boundary_detected` 和 `scope_boundary_confirmed` 两条
user 消息,把 tool_result 拆到了第三段 user 里。minimax 和
deepseek-v4-pro 都会因为这条错位拒绝整段历史。

### 核心做法

把 `mapEventsToMessages` 从按事件顺序 push 改成 pair-anchored
buffering:在某个 assistant 轮的工具还没全部完成前,中途到达的
runtime 事件(scope boundary、grounding、scope declared 等)
先排队,等该轮 `[assistant(tool_use=[...])] +
[user(tool_result=[...])]` 配齐后再按原序追加在后面;同时
收紧 `validateAnthropicToolMessageSequence` 要求 tool_use 和
tool_result 严格紧邻,使本地校验与线协议一致,能在 unit
test 阶段就抓到回归。

### 当前状态

草案。Phase 0 复现脚本能定位
`call_019eeec4a8687d83a0f0a18b` 为唯一错位对;Phase 1
改实现;Phase 2 收紧校验并补 unit;Phase 3 真 session
replay gate;Phase 4 文档收口。

### 下一步

最小可验证的下一步:落地 Phase 0 复现脚本,确认在
`origin/develop` 上能稳定打印出错位对和两条夹在中间的
runtime user 消息,然后再动 `eventsTranslator.ts`。
