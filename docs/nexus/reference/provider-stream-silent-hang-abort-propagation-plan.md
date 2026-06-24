# Provider Stream Silent-Hang Abort Propagation Plan

> State: Active Plan
> Track: Runtime / Providers / Nexus
> Priority: P0 core (Phase 1–6) closed 2026-06-22. Only P2 Watch remains for the optional BehaviorMonitor `activeAgeMs` anomaly detector. Graduated from `proposals/` to `reference/` on 2026-06-24 per [decisions/0001-documentation-lifecycle.md](../decisions/0001-documentation-lifecycle.md) §Decision.
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/nexus/executionPreparation.ts`, `src/nexus/executeStreamRoute.ts`, `src/nexus/executeHttpRoute.ts`, `src/nexus/executionStreamLoop.ts`, `src/nexus/sessionLifecycle.ts`, `src/runtime/pipeline/providerTurn.ts`, `src/runtime/LLMCodingRuntime.ts`, `src/providers/adapters/OpenAIAdapter.ts`, `src/providers/adapters/sse.ts`, `src/runtime/toolExecutor.ts`, `src/nexus/metrics.ts`, `clients/go-tui/internal/tui/{api.go,stream.go,tui.go}`
> Governance: Indexed by [README.md](./README.md). Canonical owner of "provider/runtime streams must actively respond to abort and must not leave Go TUI in a false running state". Soft-recoverable-timeout semantics stay in [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md); coupling gates stay in [layer-direction-audit-enforcement-plan.md](./layer-direction-audit-enforcement-plan.md); startup stale-`executing`-session recovery is implemented in `sessionLifecycle.ts` and remains cross-linked with [daemon-graceful-shutdown-and-orphan-reaper-plan.md](./daemon-graceful-shutdown-and-orphan-reaper-plan.md).
> Related: [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md), [layer-direction-audit-enforcement-plan.md](./layer-direction-audit-enforcement-plan.md), [daemon-graceful-shutdown-and-orphan-reaper-plan.md](./daemon-graceful-shutdown-and-orphan-reaper-plan.md)

## Purpose

The hard watchdog that fires when a provider stream goes silent already exists in `prepareExecution` (`executionPreparation.ts:220-224`), shared by both the HTTP and WebSocket execute routes. It sets `watchdog.fired = true` and calls `abortController.abort()` at `watchdogTimeoutMs`. Yet real sessions still hang for hours. This plan governs the gap between "the watchdog fires" and "the runtime actually stops": the provider stream consumer checks `signal.aborted` only passively, on each arriving delta, so a stream that emits nothing forever never reaches the check.

2026-06-22 update: the original provider-reader gap is closed, but real Go TUI validation exposed two additional layers that had to be fixed under the same operational symptom (`drafting response` forever): Nexus was able to fire the watchdog while still awaiting a runtime async iterator `.next()` that never settled, and the client could keep showing a running turn after backend transport loss. This document therefore now covers the whole abort-to-visible-terminal chain: provider reader cancellation, Nexus stream-loop abort race, reasoning-only provider-turn settlement, Go TUI backend-loss settlement, and startup recovery for stale `executing` sessions left by an old process.

## Current State / Closure Status

P0 closure summary:

- Phase 1-3 from the original plan landed on 2026-06-21: provider SSE readers actively cancel on abort, the hard watchdog is single-source, and `activeAgeMs` is observable without inheriting idle gaps.
- Phase 4 landed on 2026-06-22: `runExecutionStreamLoop()` no longer trusts `for await` to settle after abort. Each runtime iterator `.next()` is raced against `signal` and `timeoutSignal`; Nexus synthesizes `REQUEST_CANCELLED` / `REQUEST_TIMEOUT` when the authoritative signal wins and calls `iterator.return()` best-effort without waiting.
- Phase 5 landed on 2026-06-22: reasoning-only provider turns with no assistant text and no tool calls terminalize before `PostInvocation` hooks, emitting `EMPTY_PROVIDER_RESPONSE` instead of entering a silent post-provider gap.
- Phase 6 landed on 2026-06-22: Go TUI settles a running turn when runtime-status transport polling proves Nexus became unreachable; Nexus startup marks old `phase='executing'` sessions failed with `NEXUS_RESTARTED_DURING_EXECUTION`.
- The only remaining item is optional: a BehaviorMonitor push detector for `activeAgeMs` anomalies. It is not P0 because `/v1/runtime/status`, Go TUI footer states, terminal error events, and startup stale-session recovery now cover the operational failure path.

Original source-verified facts that drove Phase 1-3:

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
- `session_4872604b-a0c8-4eff-bde2-3c17e08d8c09` and `session_2f196238-40cd-4c5e-aeac-cd242d47d3d9` (2026-06-22) proved the next layer: Nexus logs showed `hard watchdog fired after 240000ms`, but `/v1/runtime/status` still reported active streams and the sessions remained `executing`. The watchdog had fired, but the route was still waiting for the runtime async iterator `.next()` to resolve.
- `session_f4a0a894-1585-4c59-96e2-92f32699bf57` proved that a reasoning-only/no-tool/no-text provider turn could pass through `PostInvocation` and then sit in a silent gap. The user asked to verify Bash, the provider only thought "I'll run a simple bash command", but emitted no Bash tool call and no permission request.
- `session_f300c03c-1216-46f0-87e2-5b04414a9fdf` separated stale deployment from frontend settlement. SQLite still showed `phase='executing'` with no terminal reason, but no Nexus process was listening on port 3000 while the old Go TUI process kept showing `drafting response`. This was backend transport loss plus stale `executing` state, not a Bash permission panel.

With `legacyTimeoutMs = 180000` (soft), `watchdogTimeoutMs = Math.max(540000, 480000) = 540000ms = 9min`. The watchdog should have fired at ~09:06:17 (08:57:17 + 540s). Two hypotheses for the 8-hour hang:

- **H1 (strong):** `prepared.timeout` fired at 09:06, called `abortController.abort()`, but the abort did not interrupt the blocked `for await (const delta of options.stream)` in `providerTurn.ts:346` because (a) the passive `signal.aborted` check at `:347` never ran (no delta arrived), and (b) undici did not reject the blocked `reader.read()` on the silent SSE connection. The runtime stayed stuck; no further events were ever emitted.
- **H2 (rejected by elimination):** `prepared.timeout` did not fire. Rejected because the `clearTimeout(timeout)` that would cancel it lives in the route `finally` (`executeStreamRoute.ts:242`), which only runs after `runExecutionStreamLoop` returns — and the loop provably never returned (8h of zero events). So the timer was not cleared and must have fired. (Note: `prepared.timeout` has no `logger.warn`, so its firing leaves no log trace — consistent with H1.)

H1 wins by elimination. The root cause is not a missing watchdog; it is **abort-signal propagation**: the provider stream consumer does not actively respond to abort, so `abortController.abort()` does not unblock a silent stream.

The 2026-06-22 follow-up sessions refine the root cause into a layered failure model:

1. Provider reader can ignore abort while blocked on SSE `reader.read()` (Phase 1).
2. Runtime async iterator can ignore abort while blocked on `.next()` even after the provider invocation and hard watchdog have fired (Phase 4).
3. Provider turn aggregation can produce reasoning-only/no-tool/no-text output that must be terminal before post-invocation hooks (Phase 5).
4. A UI connected to a dead backend can preserve a false local running state unless transport loss settles the stream (Phase 6).
5. A restarted Nexus must not leave prior-process `executing` sessions as live truth (Phase 6).

## Goals

- When the hard watchdog aborts the controller, a silent provider stream consumer unblocks within milliseconds — not hours. The abort must actively break the stream, not passively wait for the next delta.
- One canonical hard watchdog for both HTTP and WebSocket routes, with observability (a log line + the `details.kind='watchdog'` error event reaching the client via the existing settlement/forward path, not a route-local second timer).
- A hung stream is observable via `/v1/runtime/status` (`stream.activeAgeMs`) without needing to query SQLite.
- A runtime async iterator that does not settle after abort must not keep HTTP/WS execute routes alive.
- A reasoning-only provider turn with no assistant text and no tool calls must become a visible `EMPTY_PROVIDER_RESPONSE`, not a silent retry or post-hook gap.
- Go TUI must not keep displaying `running` / `drafting response` after Nexus transport loss during an active turn.
- Nexus startup must reconcile prior-process `executing` sessions into a terminal failed state with explicit stale-restart metadata.

## Non-goals

- Do not change soft-policy semantics — soft never aborts; the watchdog is the safety net. Owned by [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md).
- Do not change Nexus global `watchdogTimeoutMs` defaults. The Go TUI may send a narrower interactive watchdog explicitly; global API back-compat remains owned by timeout governance.
- Do not build durable continuation snapshots for stale sessions. Startup recovery only terminalizes old `executing` rows honestly; it does not resume a lost in-process continuation.
- Do not touch `toolExecutor.ts` — its active-listener pattern is already correct and is the model to copy, not the target to change.

## Design

### Phase 1 — Active abort propagation on the provider stream path

Mirror the `toolExecutor.ts:67-68` pattern on the provider stream path. The fix lives in `sse.ts` (`parseSSE` + `readerToAsyncIterable`), where the `ReadableStream` reader is owned, threaded through `OpenAIAdapter.ts` / `AnthropicAdapter.ts` via the existing `options?.signal`.

Landed mechanism (differs from the original `response.body.cancel()` sketch — that throws "locked" once a reader is acquired): `parseSSE` accepts an optional `AbortSignal`; when provided it acquires the reader explicitly via `getReader()` so `readerToAsyncIterable` holds the lock and can call `reader.cancel(new Error('Aborted'))` on abort. Only the reader that holds the lock can cancel. `reader.cancel()` errors the pending `reader.read()`, which throws out of `readerToAsyncIterable`'s `for await`, out of `parseSSE`, out of `OpenAIAdapter.queryStream`'s `for await`, and propagates to `providerTurn.ts:346` `for await (const delta of options.stream)` → caught by `LLMCodingRuntime.ts:847` → `classifyProviderRecovery` returns `undefined` for a non-`ProviderError` AbortError → rethrow → classified at `:1040-1041` as `REQUEST_TIMEOUT` (because `timeoutController` was also aborted). Without a signal, `parseSSE` falls back to the stream's native async iterator — back-compat preserved.

Both adapters thread `options?.signal` into `parseSSE(response.body, options?.signal)`. Regression: `test/sse-abort-propagation.test.ts` (4 tests) pins that a silent stream unblocks within ~1s of abort, not hours.

### Phase 2 — Single-source watchdog + observability

Remove the redundant `watchdogTimer` at `executeStreamRoute.ts:189-209`. `prepared.timeout` (`executionPreparation.ts:220`) is the canonical watchdog for both routes. To recover the observability the redundant timer added (which `prepared.timeout` lacks):

- Add a single `logger.warn('hard watchdog fired ...')` inside the `prepared.timeout` callback so the firing is visible in logs for both routes.
- Verify the WS path delivers the `details.kind='watchdog'` REQUEST_TIMEOUT to the client through the existing settlement/forward path (`settleExecutionSession` + `forwardProcessedRuntimeEvent`) — the HTTP path already produces this error via settlement. If the WS path has a gap, fix the settlement/forward path, not by re-adding a second timer.

Net result: one watchdog, one log line, one error-delivery path, for both transports.

### Phase 3 — Stale-session observability

`metrics.ts` `activeAgeMs` sampling in `snapshot()` is already written AND already deployed: `/v1/runtime/status` (`runtimeStatusRouter.ts:57`) returns `metrics: await context.runtimeMetricsSnapshot()`, which spreads `snapshot()` (including `stream.activeAgeMs`) into the response. So a hung stream is observable via status without querying SQLite.

Phase 3 fix (2026-06-21): the delta-accumulation in `recordStreamActiveAge` left `lastStreamActiveSampleMs` pinned at its last poll value when `activeCount` dropped to 0. A NEW stream starting much later would, on its first poll, accumulate the entire idle gap as its own `activeAgeMs` — a false "hung" signal that trains operators to ignore the metric (defeating the observability goal). The fix resets `lastStreamActiveSampleMs = 0` alongside `activeAgeMs = 0` in the `activeCount === 0` branch, so each new stream re-seeds cleanly. Regression: `test/metrics-active-age.test.ts` adds the "new stream after a finish gap does not inherit the idle period" case (mutation-verified: fails without the reset).

Optional follow-up (deferred): a `BehaviorMonitor` detector that flags `activeAgeMs > threshold` as an anomaly. Coupling constraint: the detector must read via the existing `behaviorMonitor.ingest()` push from nexus (nexus → runtime, permitted), NOT by importing `NexusMetrics` from runtime (which would be a blocked `runtime → nexus` reverse edge). Not implemented — `activeAgeMs` is already surfaced to the Go TUI / operator via `/v1/runtime/status`; a push detector is a nice-to-have, not a P0 regression guard.

### Phase 4 — Nexus stream-loop abort race

The 2026-06-22 sessions proved that Phase 1 alone was insufficient. The provider reader can be abort-aware and the hard watchdog can fire, yet `runExecutionStreamLoop()` can still be stuck at the route layer if `runtime.executeStream(...)[Symbol.asyncIterator]().next()` never settles.

Landed mechanism: `src/nexus/executionStreamLoop.ts` now consumes the runtime async iterator explicitly instead of using `for await`. Each `iterator.next()` is raced against `runtimeOptions.timeoutSignal` and `runtimeOptions.signal`.

- If `timeoutSignal.aborted` wins, Nexus synthesizes a canonical `REQUEST_TIMEOUT` event with `details.source='nexus_stream_abort_race'`. Existing event processing decorates it as watchdog details before persistence/forwarding.
- If user cancel / socket close abort wins, Nexus synthesizes `REQUEST_CANCELLED` with the same source marker.
- After an abort wins, Nexus calls `iterator.return()` best-effort and does not await it. The route already has an authoritative terminal event; waiting for a non-responsive generator to clean up would recreate the hang.
- Late rejection from the losing `.next()` promise is swallowed to avoid process-level unhandled rejection noise after the route has settled.

Regression: `test/execution-stream-loop.test.ts` includes a non-responsive runtime that yields `session_started` and then never resolves another `.next()`. Triggering timeout proves `runExecutionStreamLoop()` returns `{ timedOut: true }` and persists `REQUEST_TIMEOUT` with watchdog details.

### Phase 5 — Reasoning-only provider turns settle before PostInvocation

DeepSeek-compatible providers can produce only reasoning/thinking content and then finish the provider turn without assistant text or tool calls. Treating that as an ordinary empty assistant message created two problems: the runtime could retry with a suspicious empty assistant + reasoning payload, or it could pass through `PostInvocation` hooks and leave Go TUI in an unproductive `drafting response` gap.

Landed mechanism:

- `src/runtime/pipeline/providerTurn.ts` treats reasoning-only/no-tool/no-text provider turns as terminal `EMPTY_PROVIDER_RESPONSE` instead of retrying an empty assistant message.
- `src/runtime/LLMCodingRuntime.ts` applies the same guard immediately after provider turn aggregation and before `PostInvocation` hooks. The runtime absorbs metrics, emits `EMPTY_PROVIDER_RESPONSE` with `details.kind='reasoning_only'`, emits failed `result`, emits `execution_metrics`, and returns.
- The runtime does not expose hidden reasoning as final user text; this remains a provider empty-output error.

Regression: `test/runtime-llm.test.ts` now asserts that a thinking-only provider response never reaches `hook_completed(PostInvocation)`. `test/runtime.test.ts` covers the reducer boundary.

### Phase 6 — Client/backend loss and stale executing recovery

After the backend process dies or is replaced, an old Go TUI can still have local state that says "running". Separately, SQLite can retain `phase='executing'` rows from the previous process, which are no longer backed by an in-process continuation. Both states must be made visible and terminal instead of masquerading as a live tool or provider stall.

Landed mechanism:

- `clients/go-tui/internal/tui/api.go` adds `isNexusTransportError()` for transport failures only (`url.Error`, `net.Error`, connection refused/reset, broken pipe, EOF). HTTP status errors are deliberately excluded because a live WebSocket should not be killed by a transient status endpoint failure.
- `clients/go-tui/internal/tui/tui.go` settles a running turn when runtime-status polling sees backend transport loss and the user has not already requested cancel. The TUI appends `Nexus became unreachable while this turn was running: ...`, clears queued work, and runs `finishRunningStream()`.
- `clients/go-tui/internal/tui/stream.go` now sends an explicit interactive watchdog (`timeoutMs + 60s`) and `maxSoftTimeoutExtensions=0` for Go TUI turns. This reduces false "still drafting" time without changing global Nexus API defaults.
- `src/nexus/sessionLifecycle.ts` adds startup settlement for prior-process `executing` sessions. It finalizes them as failed with `NEXUS_RESTARTED_DURING_EXECUTION`, records `metadata.staleExecutionRecovery`, and deliberately leaves `waiting_user` and already-terminal sessions untouched.

Regressions: Go TUI tests cover transport-loss settlement and HTTP-status non-settlement; `test/session-lifecycle-stale-startup.test.ts` covers startup stale-session reconciliation.

## Coupling & Cohesion Requirements

Per [layer-direction-audit-enforcement-plan.md](./layer-direction-audit-enforcement-plan.md) and the canonical-shape invariants in [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md):

| Phase | Files touched | New cross-layer edge? | Gate impact |
| --- | --- | --- | --- |
| Phase 1 | `providers/adapters/OpenAIAdapter.ts`, `providers/adapters/AnthropicAdapter.ts` | None — stays in `providers/`; uses only standard `AbortSignal` + `ReadableStream.cancel()` APIs, no runtime import | `runtime → providers` canonical-shape invariant (type-only / registry-only) preserved; `audit-layer-direction` and `architecture-boundary.test.ts` unaffected |
| Phase 2 | `nexus/executeStreamRoute.ts` (remove timer), `nexus/executionPreparation.ts` (add log line), possibly `nexus/executionFinalization.ts` (settlement gap) | None — stays in `nexus/` | `coupling:audit:gate` (`runtime → nexus`, `nexus → cli`) unaffected |
| Phase 3 | `nexus/metrics.ts` (already written), optional `runtime/behaviorMonitor.ts` | None if detector uses the `ingest()` push pattern; a detector importing `NexusMetrics` would be a blocked `runtime → nexus` edge and must be avoided | Must not add a `runtime → nexus` import — verify with `npm run coupling:audit:gate` |
| Phase 4 | `nexus/executionStreamLoop.ts` | None — stays in shared Nexus execute loop | HTTP/WS execute routes share the same abort-race behavior; no route-local timer or provider import. |
| Phase 5 | `runtime/pipeline/providerTurn.ts`, `runtime/LLMCodingRuntime.ts` | None — stays in runtime/provider-turn boundary | Hidden reasoning remains non-user-visible; terminal error/result/metrics contract stays runtime-owned. |
| Phase 6 | `clients/go-tui/internal/tui/*`, `nexus/sessionLifecycle.ts`, `nexus/server.ts` | Existing allowed direction only: client consumes Nexus status; Nexus updates storage on startup | Go TUI does not infer tool truth; it only settles local UI state on transport loss. Startup recovery does not create resumability claims. |

Cohesion note: the watchdog belongs in ONE place (`prepareExecution`, the shared prepare step), not duplicated per route. The redundant WS timer is a cohesion defect this plan removes. Error-event delivery belongs in the settlement/forward path, not in a route-local timer.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Landed 2026-06-21 | Active abort propagation: `parseSSE` accepts `signal`, `readerToAsyncIterable` calls `reader.cancel()` on abort; `OpenAIAdapter` + `AnthropicAdapter` thread `options?.signal` | `test/sse-abort-propagation.test.ts` (4 tests): a silent stream unblocks within ~1s of abort, not hours. `architecture-boundary.test.ts` canonical-shape invariant green. |
| Phase 2 | Landed 2026-06-21 | Removed redundant WS `watchdogTimer` (`executeStreamRoute.ts:189-209`); added `logger.warn` to `prepared.timeout` (`executionPreparation.ts:220`); WS `details.kind='watchdog'` REQUEST_TIMEOUT delivered via settlement/forward path (`processRuntimeExecutionEvent` → `maybeDecorateWatchdogError` → `forwardProcessedRuntimeEvent`) | `executeStreamRoute.ts` has one watchdog path (the shared `prepared.timeout`); `test/execute-stream-watchdog.test.ts` pins the single-source firing contract; `runtime.test.ts:6087` (soft decorates) + `:6191` (fatal doesn't) still green; `coupling:audit:gate` + `deps:audit` exit 0. |
| Phase 3 | Landed 2026-06-21 | `activeAgeMs` already deployed via `/v1/runtime/status`; fixed the `lastStreamActiveSampleMs` not-reset-on-finish false-positive (new stream after an idle gap no longer inherits the gap as inflated age). Optional BehaviorMonitor `activeAgeMs` detector deferred (would use `ingest()` push) | `/v1/runtime/status` shows growing `stream.activeAgeMs` during a hung stream and 0 after it terminates; `test/metrics-active-age.test.ts` (6 tests) pins the reset, mutation-verified. Detector (if added later) must emit an anomaly without importing `NexusMetrics` from runtime. |
| Phase 4 | Landed 2026-06-22 | `runExecutionStreamLoop()` races each runtime iterator `.next()` against `signal` / `timeoutSignal` and synthesizes terminal timeout/cancel events when abort wins. | `test/execution-stream-loop.test.ts` covers a runtime that never settles after abort; the route still returns `{ timedOut: true }` and persists watchdog `REQUEST_TIMEOUT`. |
| Phase 5 | Landed 2026-06-22 | Reasoning-only/no-text/no-tool provider turns terminalize before `PostInvocation` hooks with `EMPTY_PROVIDER_RESPONSE details.kind='reasoning_only'`. | `test/runtime-llm.test.ts` asserts thinking-only turns never reach `hook_completed(PostInvocation)`; reducer tests keep the lower-level terminal behavior. |
| Phase 6 | Landed 2026-06-22 | Go TUI settles active turns on Nexus transport loss; Go TUI sends explicit interactive watchdog; Nexus startup fails prior-process stale `executing` sessions with `NEXUS_RESTARTED_DURING_EXECUTION`. | Go tests cover backend-loss settlement and HTTP-status non-settlement; `test/session-lifecycle-stale-startup.test.ts` covers stale startup recovery. |
| Optional | Deferred / P2 Watch | BehaviorMonitor `activeAgeMs` anomaly detector through existing `behaviorMonitor.ingest()` push path. | Only reopen with a real observability regression; do not import Nexus metrics from runtime. |

## Verification

- **Phase 1 reproduction (the core regression):** mock `ModelAdapter.queryStream` that yields 5 `thinking_delta` deltas then awaits a never-resolving promise (simulating silent DeepSeek). Drive `/v1/execute` with `timeoutPolicy:'soft'`, `timeoutMs:200`, `watchdogTimeoutMs:600`. Assert the request terminalizes as `timeout` within ~700ms (not 8h), with an error event carrying `details.kind='watchdog'`. This is the test that would have caught `session_3c3ec27c`.
- `npx tsx --test test/runtime.test.ts` (165 pass, including the HTTP watchdog regression at `:6087`) stays green.
- `node_modules/.bin/tsc -p tsconfig.build.json --noEmit` clean.
- `npm run coupling:audit:gate` exit 0 — confirms no new `runtime → nexus` / `nexus → cli` edge from Phase 3.
- `npm run deps:audit` exit 0 — confirms no new layer-direction violation.
- `npx tsx --test test/architecture-boundary.test.ts` (10 pass) — confirms `runtime → providers` canonical-shape invariant holds after Phase 1.
- `npm run docs:check` — `failureCount: 0`.
- Manual: restart the dev server with Phases 1–2, replay the `session_3c3ec27c` turn-8 prompt against `deepseek/deepseek-v4-pro`; confirm the turn terminalizes at ~`watchdogTimeoutMs` instead of hanging.
- 2026-06-22 follow-up verification:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-name-pattern "runtime iterator does not resolve after abort|reasoning-only provider turns|thinking-only provider response|empty provider response" test/execution-stream-loop.test.ts test/runtime.test.ts test/runtime-llm.test.ts`
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/execution-stream-loop.test.ts test/execute-stream-watchdog.test.ts test/execution-event-processing.test.ts`
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/session-lifecycle-stale-startup.test.ts`
  - `cd clients/go-tui && GOCACHE=/private/tmp/babel-o-go-cache go test ./internal/tui -run 'Test(RuntimeStatusFailureSettlesRunningStream|RuntimeStatusHTTPFailureDoesNotSettleRunningStream|StreamPermissionRequestOwnsForegroundView|PermissionRequestOwnsForegroundView|CancelStreamNotifiesLocalStreamAfterHTTPAck|FriendlyNexusRequestError|BuildExecuteRequestEmitsSoftTimeoutPolicy|BuildExecuteRequestRaisesLongContextTimeout|RuntimeAnimationStateFollowsAgentEvent)'`
  - `npm run typecheck`

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md). This plan no longer owns a P0 open implementation slice after Phase 6.
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md) and [../history/evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md).
- This document keeps the durable boundary (provider/runtime streams must actively respond to abort), the phase plan, and the regression context (`session_3c3ec27c`, `session_ffd44ccf`, `session_4872604b`, `session_2f196238`, `session_f4a0a894`, `session_f300c03c`).

## 中文概述

### 背景

hard watchdog 其实早就在 `executionPreparation.ts:220-224` 写好了（HTTP/WS 共享），到 `watchdogTimeoutMs` 会 `abortController.abort()`。但真实 session 仍然卡 8 小时——因为 `providerTurn.ts:346` 的 `for await (const delta of options.stream)` 只在**每个 delta 到达时**被动检查 `signal.aborted`，provider 一旦静默（DeepSeek V4 pro think 完就不再 emit），`stream.next()` 永久 block，检查永远跑不到。`session_3c3ec27c` turn 8（155 个 thinking_delta、0 个 assistant_delta、soft 弹完 extension 后 8 小时 0 event）就是这条路径的实证；`prepared.timeout` 没有 log，所以它静默 fire 了但 abort 没传到阻塞的 stream reader。

### 核心做法

- **Phase 1**：在 adapter（`OpenAIAdapter` / `AnthropicAdapter`）拿到 `response` 后注册 `signal.addEventListener('abort', () => response.body.cancel())`，主动 error 掉 locked reader → `reader.read()` reject → 沿 `parseSSE` → `queryStream` → `providerTurn` 的 `for await` 抛出 → `LLMCodingRuntime:847` catch → `:1040` 分类为 timeout。照搬 `toolExecutor.ts:67` 已有的 active-listener 模式。
- **Phase 2**：删掉 `executeStreamRoute.ts:189-209` 的冗余 `watchdogTimer`（和 `prepared.timeout` 同时刻 fire，是 cohesion 缺陷）；给 `prepared.timeout` 加一行 `logger.warn`；WS 的 `details.kind='watchdog'` 错误事件走 settlement/forward 既有路径，不靠第二个 timer。
- **Phase 3**：`activeAgeMs` 早已通过 `/v1/runtime/status` 暴露（`runtimeStatusRouter` 返回 `metrics.snapshot()`）。修了 `recordStreamActiveAge` 的一个 false-positive：流结束后 `lastStreamActiveSampleMs` 没重置，导致新流启动时会继承空闲期作为虚假 inflated age（操作者会被训练成忽略这个指标）。修复在 `activeCount===0` 时一并重置 sample clock。可选 BehaviorMonitor detector 仍 deferred——若做必须走 `ingest()` push（nexus → runtime 合法），不能从 runtime import `NexusMetrics`（那是被 `coupling:audit:gate` 禁的 `runtime → nexus` 反向边）；`activeAgeMs` 已对 Go TUI/操作者可见，push detector 是 nice-to-have 而非 P0 回归保障。
- **Phase 4**：`runExecutionStreamLoop()` 改为显式驱动 async iterator，并让每次 `.next()` 与 `signal` / `timeoutSignal` race。abort 赢时由 Nexus 外层合成 `REQUEST_TIMEOUT` / `REQUEST_CANCELLED`，不再等待 runtime/provider 内部自然收口。
- **Phase 5**：reasoning-only / thinking-only 但没有正文和工具调用的 provider turn，在 `PostInvocation` hook 前立即变成 `EMPTY_PROVIDER_RESPONSE`。这避免了“模型说要跑 Bash 但没有发工具调用”的空窗被误判为 Bash 权限面板卡住。
- **Phase 6**：Go TUI 在运行中发现 Nexus transport loss 时收敛本地 running 状态；Nexus 启动时把旧进程遗留的 `executing` session 标记为 `NEXUS_RESTARTED_DURING_EXECUTION`，避免旧 session 永久假活。

### 架构耦合约束

三段修复都不引入新跨层边：Phase 1 全在 `providers/adapters/`（只用标准 `AbortSignal` + `ReadableStream.cancel`，不 import runtime），保住 `runtime → providers` 的 type-only/registry-only canonical 形态；Phase 2 全在 `nexus/`；Phase 3 用 push 模式避免 `runtime → nexus`。落地后 `npm run coupling:audit:gate` + `npm run deps:audit` + `architecture-boundary.test.ts` 必须仍绿。

### 当前状态

P0 核心链路已落地（2026-06-21 至 2026-06-22，分支 `fix/provider-stream-abort-propagation`）：Phase 1（`sse.ts` 的 `reader.cancel()` + adapter 透传 signal）+ Phase 2（单一 watchdog）+ Phase 3（`activeAgeMs` 观测修正）+ Phase 4（Nexus iterator abort race）+ Phase 5（reasoning-only 前置终止）+ Phase 6（Go TUI backend-loss settlement + stale executing startup recovery）。仅可选 BehaviorMonitor push detector 仍 deferred / P2 Watch。

### 下一步

可选：BehaviorMonitor `activeAgeMs` anomaly detector（走 `ingest()` push，nexus → runtime 合法；不能从 runtime import `NexusMetrics`）。非 P0——`activeAgeMs` 已通过 `/v1/runtime/status` 对操作者/Go TUI 可见。
