# Provider Stream Silent-Hang Abort Propagation Plan

> State: Draft
> Track: Runtime / Providers / Nexus
> Priority: P0 — a silent provider stream permanently hangs the runtime even though the hard watchdog already exists and fires
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../WORK_LOG.md](../WORK_LOG.md), `src/nexus/executionPreparation.ts`, `src/nexus/executeStreamRoute.ts`, `src/nexus/executeHttpRoute.ts`, `src/runtime/pipeline/providerTurn.ts`, `src/runtime/LLMCodingRuntime.ts`, `src/providers/adapters/OpenAIAdapter.ts`, `src/providers/adapters/sse.ts`, `src/runtime/toolExecutor.ts`, `src/nexus/metrics.ts`
> Governance: Indexed by [README.md](../README.md). Canonical owner of "the provider stream consumer must actively respond to abort". Soft-recoverable-timeout semantics stay in [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md); coupling gates stay in [layer-direction-audit-enforcement-plan.md](../reference/layer-direction-audit-enforcement-plan.md); stale-`executing`-session reaping stays in [daemon-graceful-shutdown-and-orphan-reaper-plan.md](./daemon-graceful-shutdown-and-orphan-reaper-plan.md).
> Related: [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md), [layer-direction-audit-enforcement-plan.md](../reference/layer-direction-audit-enforcement-plan.md), [daemon-graceful-shutdown-and-orphan-reaper-plan.md](./daemon-graceful-shutdown-and-orphan-reaper-plan.md)

## Purpose

The hard watchdog that fires when a provider stream goes silent already exists in `prepareExecution` (`executionPreparation.ts:220-224`), shared by both the HTTP and WebSocket execute routes. It sets `watchdog.fired = true` and calls `abortController.abort()` at `watchdogTimeoutMs`. Yet real sessions still hang for hours. This plan governs the gap between "the watchdog fires" and "the runtime actually stops": the provider stream consumer checks `signal.aborted` only passively, on each arriving delta, so a stream that emits nothing forever never reaches the check.

## Current State

Source-verified facts:

- **The watchdog already exists and is shared.** `executionPreparation.ts:220-224` registers `setTimeout(() => { watchdog.fired = true; timeoutController.abort(); abortController.abort() }, timeoutDecision.watchdogTimeoutMs)` as `prepared.timeout`. The HTTP route (`executeHttpRoute.ts:95`) uses it and clears it in `finally` (`:138-141`). The WebSocket route (`executeStreamRoute.ts:158` `const timeout = prepared.timeout`) also uses it and clears it in `finally` (`:240-244`). For soft policy, `watchdogTimeoutMs = Math.max(legacyTimeoutMs * 3, legacyTimeoutMs + 300_000)` (`executionPreparation.ts:137`).
- **A redundant second watchdog was added on the WS route on 2026-06-21.** `executeStreamRoute.ts:189-209` registers a second `setTimeout` at the same `watchdogTimeoutMs` that additionally `sendJson(socket, { type:'error', code:'REQUEST_TIMEOUT', details:{ kind:'watchdog', ... } })` directly. It calls the same `abortController.abort()`. It does NOT abort `timeoutController` (asymmetric with `prepared.timeout`). Both timers fire at the same instant.
- **The provider stream consumer only passively checks abort.** `providerTurn.ts:346-349`: `for await (const delta of options.stream) { if (options.signal?.aborted) throw new Error('Aborted') }`. The check is inside the loop body — it runs only when `options.stream` yields a new delta. A silent stream never yields, so `stream.next()` blocks forever and the check is never reached.
- **The adapter passes the signal to `fetch` but never actively cancels the body.** `OpenAIAdapter.ts:156-161` calls `fetch(url, { signal: options?.signal })`. The SSE reader `sse.ts:61-73` (`readerToAsyncIterable`) loops `await reader.read()` with no abort listener. Relying on undici to reject a blocked `reader.read()` on a half-open/silent SSE connection is the failure mode.
- **The tool-execution path already has the correct active-listener pattern.** `toolExecutor.ts:67-68` and `:153` register `options.signal?.addEventListener('abort', onParentAbort)` that actively rejects the in-flight tool promise. The provider-stream path has no equivalent.
- **The runtime does classify abort correctly downstream.** `LLMCodingRuntime.ts:1040-1041` maps `timeoutSignal.aborted` → timeout and `signal.aborted` / AbortError → cancelled. So once the stream actually throws, recovery is already wired — the missing piece is making it throw.
- **Observability for the hung state landed 2026-06-21 but is undeployed.** `metrics.ts:295-302` makes `snapshot()` call `recordStreamActiveAge(now)` so `/v1/runtime/status` reflects a growing `stream.activeAgeMs` even with zero stream events.

## Problem Statement

Real-session evidence:

- `session_3c3ec27c-0cd9-4cf0-a953-86298c002801` (2026-06-21, `deepseek/deepseek-v4-pro`, soft policy). Turn 8 prompt: "分析是否要单独创建一个git分支来单独修复开发这一部分". The turn emitted 155 `thinking_delta` events (08:57:28–08:57:30), one `usage` (outputTokens=396, all thinking — zero `assistant_delta`, zero tool calls), then soft `timeout_budget_exceeded` + `timeout_extension_granted` at 09:00:17 (`timeoutMs=180000`, extension 1/1). After that: **zero events for ~8 hours**, session still `phase='executing'` at 17:00 when the server was killed.
- `session_ffd44ccf-7f3b-4597-9844-a077f41a8967` (2026-06-20, same model, same silent-after-thinking pattern) is the originating sample cited in the 2026-06-21 WORK_LOG.

With `legacyTimeoutMs = 180000` (soft), `watchdogTimeoutMs = Math.max(540000, 480000) = 540000ms = 9min`. The watchdog should have fired at ~09:06:17 (08:57:17 + 540s). Two hypotheses for the 8-hour hang:

- **H1 (strong):** `prepared.timeout` fired at 09:06, called `abortController.abort()`, but the abort did not interrupt the blocked `for await (const delta of options.stream)` in `providerTurn.ts:346` because (a) the passive `signal.aborted` check at `:347` never ran (no delta arrived), and (b) undici did not reject the blocked `reader.read()` on the silent SSE connection. The runtime stayed stuck; no further events were ever emitted.
- **H2 (rejected by elimination):** `prepared.timeout` did not fire. Rejected because the `clearTimeout(timeout)` that would cancel it lives in the route `finally` (`executeStreamRoute.ts:242`), which only runs after `runExecutionStreamLoop` returns — and the loop provably never returned (8h of zero events). So the timer was not cleared and must have fired. (Note: `prepared.timeout` has no `logger.warn`, so its firing leaves no log trace — consistent with H1.)

H1 wins by elimination. The root cause is not a missing watchdog; it is **abort-signal propagation**: the provider stream consumer does not actively respond to abort, so `abortController.abort()` does not unblock a silent stream.

## Goals

- When the hard watchdog aborts the controller, a silent provider stream consumer unblocks within milliseconds — not hours. The abort must actively break the stream, not passively wait for the next delta.
- One canonical hard watchdog for both HTTP and WebSocket routes, with observability (a log line + the `details.kind='watchdog'` error event reaching the client via the existing settlement/forward path, not a route-local second timer).
- A hung stream is observable via `/v1/runtime/status` (`stream.activeAgeMs`) without needing to query SQLite.

## Non-goals

- Do not change soft-policy semantics — soft never aborts; the watchdog is the safety net. Owned by [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md).
- Do not change `watchdogTimeoutMs` defaults or the `executeSchema` body fields.
- Do not reap stale `executing` sessions on restart — owned by [daemon-graceful-shutdown-and-orphan-reaper-plan.md](./daemon-graceful-shutdown-and-orphan-reaper-plan.md). This plan makes a hung stream terminate itself; that plan cleans up the rows a crash leaves behind.
- Do not touch `toolExecutor.ts` — its active-listener pattern is already correct and is the model to copy, not the target to change.

## Design

### Phase 1 — Active abort propagation on the provider stream path

Mirror the `toolExecutor.ts:67-68` pattern on the provider stream path. Preferred (coupling-cleanest) location: the adapter, so the fix lives where the `Response`/`ReadableStream` is owned.

In `OpenAIAdapter.ts`, immediately after `const response = await withRetry(...)` resolves, register:

```ts
options?.signal?.addEventListener('abort', () => {
  void response.body?.cancel(new Error('Aborted')).catch(() => {})
}, { once: true })
```

`response.body.cancel()` errors the locked reader, so `reader.read()` in `readerToAsyncIterable` (`sse.ts:66`) rejects, which throws out of `parseSSE`'s `for await`, which throws out of `OpenAIAdapter.queryStream`'s `for await`, which propagates to `providerTurn.ts:346` `for await (const delta of options.stream)` → caught by `LLMCodingRuntime.ts:847` → classified at `:1040-1041`. The existing recovery path handles the rest.

Apply the symmetric fix to `AnthropicAdapter.ts` (same `response.body.cancel()` pattern after its `fetch`).

### Phase 2 — Single-source watchdog + observability

Remove the redundant `watchdogTimer` at `executeStreamRoute.ts:189-209`. `prepared.timeout` (`executionPreparation.ts:220`) is the canonical watchdog for both routes. To recover the observability the redundant timer added (which `prepared.timeout` lacks):

- Add a single `logger.warn('hard watchdog fired ...')` inside the `prepared.timeout` callback so the firing is visible in logs for both routes.
- Verify the WS path delivers the `details.kind='watchdog'` REQUEST_TIMEOUT to the client through the existing settlement/forward path (`settleExecutionSession` + `forwardProcessedRuntimeEvent`) — the HTTP path already produces this error via settlement. If the WS path has a gap, fix the settlement/forward path, not by re-adding a second timer.

Net result: one watchdog, one log line, one error-delivery path, for both transports.

### Phase 3 — Stale-session observability

`metrics.ts:295-302` (activeAgeMs sampling in `snapshot()`) is already written. Land it behind the same deployment as Phases 1–2. Optional follow-up: a `BehaviorMonitor` detector that flags `activeAgeMs > threshold` as an anomaly. Coupling constraint: the detector must read via the existing `behaviorMonitor.ingest()` push from nexus (nexus → runtime, permitted), NOT by importing `NexusMetrics` from runtime (which would be a blocked `runtime → nexus` reverse edge).

## Coupling & Cohesion Requirements

Per [layer-direction-audit-enforcement-plan.md](../reference/layer-direction-audit-enforcement-plan.md) and the canonical-shape invariants in [module-coupling-decoupling-and-re-aggregation-plan.md](../reference/module-coupling-decoupling-and-re-aggregation-plan.md):

| Phase | Files touched | New cross-layer edge? | Gate impact |
| --- | --- | --- | --- |
| Phase 1 | `providers/adapters/OpenAIAdapter.ts`, `providers/adapters/AnthropicAdapter.ts` | None — stays in `providers/`; uses only standard `AbortSignal` + `ReadableStream.cancel()` APIs, no runtime import | `runtime → providers` canonical-shape invariant (type-only / registry-only) preserved; `audit-layer-direction` and `architecture-boundary.test.ts` unaffected |
| Phase 2 | `nexus/executeStreamRoute.ts` (remove timer), `nexus/executionPreparation.ts` (add log line), possibly `nexus/executionFinalization.ts` (settlement gap) | None — stays in `nexus/` | `coupling:audit:gate` (`runtime → nexus`, `nexus → cli`) unaffected |
| Phase 3 | `nexus/metrics.ts` (already written), optional `runtime/behaviorMonitor.ts` | None if detector uses the `ingest()` push pattern; a detector importing `NexusMetrics` would be a blocked `runtime → nexus` edge and must be avoided | Must not add a `runtime → nexus` import — verify with `npm run coupling:audit:gate` |

Cohesion note: the watchdog belongs in ONE place (`prepareExecution`, the shared prepare step), not duplicated per route. The redundant WS timer is a cohesion defect this plan removes. Error-event delivery belongs in the settlement/forward path, not in a route-local timer.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Draft | Active abort propagation: `response.body.cancel()` on `signal abort` in `OpenAIAdapter.ts` + `AnthropicAdapter.ts` | A reproduction with a silent provider stream (mock adapter that yields N deltas then never yields again) unblocks within ~50ms of `abortController.abort()`, classifying the run as timed-out. Focused regression test in `test/runtime-llm.test.ts` or a new `test/provider-stream-abort-propagation.test.ts`. |
| Phase 2 | Draft | Remove redundant WS `watchdogTimer`; add `logger.warn` to `prepared.timeout`; verify WS error-event delivery via settlement | `executeStreamRoute.ts` has one watchdog path (the shared `prepared.timeout`); HTTP and WS both log + deliver `details.kind='watchdog'` REQUEST_TIMEOUT identically; `npm run coupling:audit:gate` green; existing `runtime.test.ts:6087` HTTP watchdog regression still green. |
| Phase 3 | Draft | Deploy `metrics.snapshot()` activeAgeMs (already written); optional BehaviorMonitor `activeAgeMs` anomaly detector via `ingest()` | `/v1/runtime/status` shows growing `stream.activeAgeMs` during a hung stream and 0 after it terminates; detector (if added) emits an anomaly without importing `NexusMetrics` from runtime. |

## Verification

- **Phase 1 reproduction (the core regression):** mock `ModelAdapter.queryStream` that yields 5 `thinking_delta` deltas then awaits a never-resolving promise (simulating silent DeepSeek). Drive `/v1/execute` with `timeoutPolicy:'soft'`, `timeoutMs:200`, `watchdogTimeoutMs:600`. Assert the request terminalizes as `timeout` within ~700ms (not 8h), with an error event carrying `details.kind='watchdog'`. This is the test that would have caught `session_3c3ec27c`.
- `npx tsx --test test/runtime.test.ts` (165 pass, including the HTTP watchdog regression at `:6087`) stays green.
- `node_modules/.bin/tsc -p tsconfig.build.json --noEmit` clean.
- `npm run coupling:audit:gate` exit 0 — confirms no new `runtime → nexus` / `nexus → cli` edge from Phase 3.
- `npm run deps:audit` exit 0 — confirms no new layer-direction violation.
- `npx tsx --test test/architecture-boundary.test.ts` (10 pass) — confirms `runtime → providers` canonical-shape invariant holds after Phase 1.
- `npm run docs:check` — `failureCount: 0`.
- Manual: restart the dev server with Phases 1–2, replay the `session_3c3ec27c` turn-8 prompt against `deepseek/deepseek-v4-pro`; confirm the turn terminalizes at ~`watchdogTimeoutMs` instead of hanging.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).
- This document keeps only the durable boundary (provider stream consumer must actively respond to abort), the phase plan, and the regression context (session_3c3ec27c / session_ffd44ccf).

## 中文概述

### 背景

hard watchdog 其实早就在 `executionPreparation.ts:220-224` 写好了（HTTP/WS 共享），到 `watchdogTimeoutMs` 会 `abortController.abort()`。但真实 session 仍然卡 8 小时——因为 `providerTurn.ts:346` 的 `for await (const delta of options.stream)` 只在**每个 delta 到达时**被动检查 `signal.aborted`，provider 一旦静默（DeepSeek V4 pro think 完就不再 emit），`stream.next()` 永久 block，检查永远跑不到。`session_3c3ec27c` turn 8（155 个 thinking_delta、0 个 assistant_delta、soft 弹完 extension 后 8 小时 0 event）就是这条路径的实证；`prepared.timeout` 没有 log，所以它静默 fire 了但 abort 没传到阻塞的 stream reader。

### 核心做法

- **Phase 1**：在 adapter（`OpenAIAdapter` / `AnthropicAdapter`）拿到 `response` 后注册 `signal.addEventListener('abort', () => response.body.cancel())`，主动 error 掉 locked reader → `reader.read()` reject → 沿 `parseSSE` → `queryStream` → `providerTurn` 的 `for await` 抛出 → `LLMCodingRuntime:847` catch → `:1040` 分类为 timeout。照搬 `toolExecutor.ts:67` 已有的 active-listener 模式。
- **Phase 2**：删掉 `executeStreamRoute.ts:189-209` 的冗余 `watchdogTimer`（和 `prepared.timeout` 同时刻 fire，是 cohesion 缺陷）；给 `prepared.timeout` 加一行 `logger.warn`；WS 的 `details.kind='watchdog'` 错误事件走 settlement/forward 既有路径，不靠第二个 timer。
- **Phase 3**：部署 `metrics.snapshot()` 的 `activeAgeMs`（已写）；可选 BehaviorMonitor detector 必须走 `ingest()` push（nexus → runtime 合法），不能从 runtime import `NexusMetrics`（那是被 `coupling:audit:gate` 禁的 `runtime → nexus` 反向边）。

### 架构耦合约束

三段修复都不引入新跨层边：Phase 1 全在 `providers/adapters/`（只用标准 `AbortSignal` + `ReadableStream.cancel`，不 import runtime），保住 `runtime → providers` 的 type-only/registry-only canonical 形态；Phase 2 全在 `nexus/`；Phase 3 用 push 模式避免 `runtime → nexus`。落地后 `npm run coupling:audit:gate` + `npm run deps:audit` + `architecture-boundary.test.ts` 必须仍绿。

### 当前状态

草案。需先进 `proposals/`（本文档），Phase 1 落地 + 复现回归通过后毕业到 `reference/` 或合并进 `history/`。

### 下一步

最小可验证切片：Phase 1 的 `response.body.cancel()` + 一个 mock silent-stream 复现测试（yield 5 delta 后永不 yield，断言 ~`watchdogTimeoutMs` 内 terminalize 为 timeout 而非 hang 8h）。这是能直接防住 `session_3c3ec27c` 这类事故的回归。
