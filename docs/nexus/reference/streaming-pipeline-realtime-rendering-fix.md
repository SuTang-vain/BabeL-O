# Streaming Pipeline Real-Time Rendering Fix

> State: Guide
> Track: Runtime / Go TUI / Streaming
> Priority: Watch
> Source of truth: [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/runtime/LLMCodingRuntime.ts`, `src/providers/adapters/AnthropicAdapter.ts`, `src/providers/adapters/OpenAIAdapter.ts`, `clients/go-tui/internal/tui/anim.go`, `clients/go-tui/internal/tui/chrome.go`, `clients/go-tui/internal/tui/tui.go`, `test/anthropic-chunker.test.ts`, real WS captures from session_ff3a874d-4d25-4e53-b0eb-02744b6bfaa2
> Governance: Operational guide for the streaming pipeline three-layer architecture (Path 0 / Path 1 / Path 2). Use it to bisect new "real-time rendering broken" regressions, not to plan new features. The original fix shipped 2026-06-21 in commits `f75a268` / `19596ae` / `7d8cc1a`.

## Purpose

This document records the three-layer fix that took BabeL-O / Nexus from "agent output dumps at the end of a turn in a single batch" to "operator sees text appear word-by-word in real time" against a real session regression. It is **closed** — the fix shipped in commits `f75a268` / `19596ae` / `7d8cc1a` (2026-06-21). The document exists so future readers do not re-debug the same buffer chain.

Three things had to change before real-time rendering became visible end-to-end. Fixing only one or two never produced visible streaming because each layer relied on the previous one to surface its progress.

## Current State

| Layer | Commit | Status |
| --- | --- | --- |
| Path 0 — runtime drain-into-array buffer | `7d8cc1a` | Closed |
| Path 1 — Anthropic / OpenAI adapter chunker | `19596ae` | Closed |
| Path 2 — Go TUI synthesizing indicator | `f75a268` | Closed |

WS time-trace evidence captured against the real `module-coupling-governance` build (DeepSeek V4 via `openai-compatible` adapter):

| Metric | Before fix | After fix |
| --- | --- | --- |
| First `assistant_delta` | +13064 ms | +7913 ms |
| Last `assistant_delta` | +13150 ms | +11459 ms |
| Stream span | **86 ms** (batch dump) | **3546 ms** (true streaming) |
| Avg gap between chunks | 0 ms | ~14 ms |
| Total chunks | 365 | 260 |

## Problem Statement

Real session `session_ff3a874d-4d25-4e53-b0eb-02744b6bfaa2` captured the user-visible failure: 21 `thinking_delta` frames followed by 1 `assistant_delta` containing the entire answer text. The Go TUI flickered through `agent thinking` → `agent runtime` → `agent writing` and then dumped a complete reply, with no progressive rendering. The user reported "agent 在流式输出时无法直接捕获" / "多个事件 chunk 一起显示而不是真实实时".

WS-level time tracing confirmed the wire was healthy (37 events arrived) but every `assistant_delta` sat in the same 86 ms tail. Three buffer / batching points were chained together, each one masking the next:

1. **Provider** — DeepSeek V4 emits the entire assistant answer as a single large `delta.content` after thinking. The single SSE event hits the adapter as one ~235 char string.
2. **Runtime** — `src/runtime/executeProviderTurn.ts` ran the provider turn generator to completion into an array, then the caller (`LLMCodingRuntime:822`) yielded that array in a tight `for ... yield` loop. Even when the adapter started yielding word-by-word, every individual yield was buffered until the turn finished.
3. **TUI** — Between the last `thinking_delta` and the first `assistant_delta` the chrome animation fell through the default switch branch, producing visible flicker.

## Goals

- Server emits one `assistant_delta` per provider chunk, with timestamps that reflect provider pacing.
- Long single-shot assistant deltas (when a provider batches its own output) are split server-side into multiple smaller `assistant_delta` events at sentence / word boundaries.
- Go TUI shows a stable bridge indicator between thinking and assistant output so the operator does not see the chrome flicker.
- No artificial delay introduced anywhere — the goal is *granularity* and *progressive yielding*, not slower streaming.

## Non-goals

- Do not change wire schema (`assistant_delta`, `thinking_delta`, `tool_started`, ...).
- Do not change observer / context observer routes.
- Do not change provider request / SSE layer (`parseSSE`, retry, headers).
- Do not change runtime hooks, recovery decisions, or compact paths.
- Do not modify provider behavior — adapters keep yielding what providers send; only post-processing changes.

## Design

### Path 0 — Runtime drain-into-array buffer

Before:

```typescript
// src/runtime/executeProviderTurn.ts
while (!result.done) {
  events.push(result.value)         // <-- buffer every yield
  result = await stream.next()
}
return { events, providerTurn: result.value }

// src/runtime/LLMCodingRuntime.ts:822
const { events: providerTurnEvents, providerTurn: providerTurnValue } =
  await executeProviderTurn(providerTurnDriver, {...})
for (const e of providerTurnEvents) yield e   // <-- entire turn at once
```

After:

```typescript
// src/runtime/LLMCodingRuntime.ts:822
const stream = providerTurnDriver.run({...})
let result = await stream.next()
while (!result.done) {
  yield result.value                 // <-- yield as the provider produces
  result = await stream.next()
}
providerTurn = result.value
```

The `executeProviderTurn` helper still exists (no callers) so its surrounding doc references are not broken; cleanup is deferred. The recovery / catch-block downstream is unchanged.

### Path 1 — Adapter chunker

When a provider emits a single large text delta (DeepSeek V4 batches the entire assistant text after thinking), the adapter splits it server-side at boundary priority paragraph > sentence > clause > word. Threshold is 50 chars: smaller deltas pass through verbatim so already-streaming providers are not fragmented. Search window is `[20, remaining.length - 30]` so the cut neither fragments a short prefix nor consumes the tail.

The same generator is duplicated in `AnthropicAdapter.ts` (`chunkTextDelta`) and `OpenAIAdapter.ts` (`chunkOpenAITextDelta`). Duplication is intentional — the two adapter files stay self-contained per [[feedback-tool-boundary-granularity]].

```typescript
function* chunkTextDelta(input: string): Generator<{ type: 'text'; text: string }> {
  if (input.length <= 50) { yield { type: 'text', text: input }; return }
  const boundaries = [
    { re: /\n\n+/g, priority: 0 },
    { re: /[.!?]+\s*/g, priority: 1 },
    { re: /[,;:]+\s*/g, priority: 2 },
    { re: /\s+/g, priority: 3 },
  ]
  let remaining = input
  while (remaining.length > 50) {
    const windowEnd = Math.max(20, remaining.length - 30)
    let chosen = null
    for (const b of boundaries) {
      b.re.lastIndex = 20
      const m = b.re.exec(remaining)
      if (m && m.index >= 20 && m.index <= windowEnd) {
        if (chosen === null || b.priority < chosen.priority ||
            (b.priority === chosen.priority && m.index < chosen.index)) {
          chosen = { priority: b.priority, index: m.index, len: m[0].length }
        }
      }
    }
    const cutAt = chosen?.index ?? 60
    const cutLen = chosen?.len ?? 0
    yield { type: 'text', text: remaining.slice(0, cutAt + cutLen) }
    remaining = remaining.slice(cutAt + cutLen)
  }
  if (remaining.length > 0) yield { type: 'text', text: remaining }
}
```

### Path 2 — Go TUI synthesizing indicator

The chrome animation enum gains one kind:

```go
const (
    runtimeAnimationDefault      runtimeAnimationKind = "default"
    runtimeAnimationThinking     runtimeAnimationKind = "thinking"
    runtimeAnimationSynthesizing runtimeAnimationKind = "synthesizing"  // new
    runtimeAnimationResponding   runtimeAnimationKind = "responding"
    runtimeAnimationTool         runtimeAnimationKind = "tool"
    runtimeAnimationPermission   runtimeAnimationKind = "permission"
)
```

Two latches on the model track turn-local state:

- `pendingSynthesis` — set on `thinking_delta` (only when `assistantSeenInTurn` is false), cleared on `assistant_delta` and `tool_started`.
- `assistantSeenInTurn` — one-shot latch set on the first `assistant_delta`; prevents late `thinking_delta` events from re-arming the bridge.

Both latches are cleared by the `startPrompt` reset path along with `lastEventType`.

Animation lookup priority: `permission_request` → `tool_*` → `assistant_delta` → `thinking_delta` → `default` branch where `pendingSynthesis` decides between `drafting response` and `agent runtime`. Tool / permission events therefore always win over the bridge indicator.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Path 0 | Closed | Replace runtime drain-into-array helper call with inline streaming loop. | WS time trace shows `>1000 ms` stream span vs the original `<100 ms`. |
| Path 1 | Closed | Add quote-priority text-delta chunker to both Anthropic and OpenAI adapters. | Single 200+ char `delta.content` produces multiple WS frames; small deltas pass through verbatim. |
| Path 2 | Closed | Add `runtimeAnimationSynthesizing` enum + `pendingSynthesis` / `assistantSeenInTurn` latches + `drafting response` label in the chrome state machine. | `TestRuntimeAnimationStateFollowsAgentEvent` covers the bridge case; `TestPendingSynthesisFlagCycleTracksThinkingThenAssistant` covers the latch lifecycle. |

## Verification

| Check | Result |
| --- | --- |
| `tsc -p tsconfig.build.json --noEmit` | clean |
| `npm run docs:check` | failureCount 0 |
| `test/anthropic-chunker.test.ts` | 8/8 |
| `cd clients/go-tui && go test ./internal/tui/ ./internal/loop/` | green |
| Cross-spec sweep (`anthropic-chunker` + `bash-classifier` + `bash-deny-classifier-rule` + `runtime` + `security` + `r4-context-observe-runtime-e2e`) | 219/219 |
| Real WS time trace (DeepSeek V4) | first +7913 ms, last +11459 ms, span 3546 ms |

The unrelated pre-existing `runtime-llm.test.ts` failure (`leakError.details.pattern` opening vs closing tag mismatch at line 3011) is **not** caused by these changes; it appears in the same shape against pre-fix builds and is tracked separately.

## Why all three layers were necessary

It is tempting to assume Path 0 alone would have fixed everything. The WS trace is unambiguous on this point:

- With **only Path 1**: the chunker correctly produces multiple smaller `text` deltas, but they all sit in `events[]` until `executeProviderTurn` returns. The TUI sees them as a single rapid burst at end-of-turn.
- With **only Path 2**: the dead-air gap between thinking and assistant text gets a stable label, but the assistant text still arrives as a single huge `assistant_delta` at the end of the turn — the operator sees the indicator briefly then is hit with a full-text dump.
- With **only Path 0**: each provider yield streams immediately, but providers that batch internally still emit a single large `delta.content`. The TUI reassembles it into one big `transcriptItem` and the operator perceives no progress.

Removing any one of the three undoes the visible streaming behavior. Future regressions in any layer should reproduce as "real-time rendering broken" — bisect candidates listed in the **Document Ownership** section below.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) (none — this is closed).
- Completed facts in [../DONE.md](../DONE.md) `Path 0` / `Path 2 + Path 1` entries.
- Detailed factual history in [../WORK_LOG.md](../WORK_LOG.md) under 2026-06-21 entries (`Path 0`, `Path 2 + Path 1`).
- Bisect targets if streaming regresses:
  - Path 0 — `src/runtime/LLMCodingRuntime.ts` provider turn driver loop, around the comment "Stream provider events one-at-a-time".
  - Path 1 — `chunkTextDelta` / `chunkOpenAITextDelta` in the two adapters; threshold and boundary regex.
  - Path 2 — `pendingSynthesis` / `assistantSeenInTurn` set/clear sites in `consumeNexusEvent` and the chrome `runtimeAnimationState` default branch.

## 中文概述

### 背景

真实 session `session_ff3a874d-4d25-4e53-b0eb-02744b6bfaa2` 暴露：21 个 `thinking_delta` 之后跟 1 个完整 `assistant_delta`，Go TUI 在 thinking → 突然 dump 整段答案，看不到逐字写入。WS 抓包显示所有 `assistant_delta` 在 86 ms 同一批次到达，根本不是真实流式。

### 核心做法

三层 buffer 串接，**单独修任何一层都不能让用户看到流式效果**。

- **Path 0**：runtime 不再 drain-into-array。`LLMCodingRuntime` 直接从 `providerTurnDriver.run(...)` 拿 generator，每个 `await stream.next()` 后立即 `yield result.value` 给上层。这是真正解封 streaming 的关键。
- **Path 1**：Anthropic / OpenAI adapter 各自加 `chunkTextDelta` 算法（paragraph > sentence > clause > word 优先级，>50 char 阈值，搜索窗口 `[20, len-30]`，硬切 fallback 60 chars），把 batched delta 拆成多 chunk。两个 adapter 各自独立副本，零跨依赖。
- **Path 2**：Go TUI 加 `runtimeAnimationSynthesizing` enum + `pendingSynthesis` / `assistantSeenInTurn` 双 latch，thinking → assistant 间隙显示 "drafting response" 桥梁动画。

### 当前状态

已收口 (commit `7d8cc1a` / `19596ae` / `f75a268`，2026-06-21)。WS 抓包验证 `before: 86 ms 同批次 → after: 3546 ms 真实流式 ~14 ms 间隔`。`tsc clean` + `docs:check failureCount=0` + 跨 spec 219/219 全过 + 真实 e2e session 验证。

### 下一步

无主动推进项。后续若 streaming 体验回归（任何一层 buffer / batching 重新引入），按本文 `Document Ownership` 列出的 3 个 bisect 目标定位。

`executeProviderTurn.ts` helper 文件无 caller，可在独立 cleanup PR 中删除。
