# Provider Unavailable Auto Retry Governance Plan

> State: Partially Landed
> Track: Provider / Runtime Reliability
> Priority: P1 — real BabeL-O session `session_356b8f40-3963-4011-ac45-9bec150ee039` hit repeated MiniMax 500 `provider_unavailable` errors that were already classified as retryable but still surfaced as terminal failures.
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../active/TODO_performance.md](../active/TODO_performance.md), [./provider-recovery-and-model-catalog-governance-plan.md](./provider-recovery-and-model-catalog-governance-plan.md), `src/runtime/providerRecovery.ts`, `src/runtime/executeProviderRecoveryDecision.ts`, `src/runtime/LLMCodingRuntime.ts`, `src/providers/retry.ts`, `src/providers/adapters/AnthropicAdapter.ts`, `src/providers/adapters/OpenAIAdapter.ts`
> Governance: Indexed by [README.md](./README.md). This proposal owns same-provider automatic retry for transient provider availability failures. It does not authorize silent provider/model switching; that boundary remains governed by [../reference/prompt-model-governance-index.md](../reference/prompt-model-governance-index.md) and [./provider-recovery-and-model-catalog-governance-plan.md](./provider-recovery-and-model-catalog-governance-plan.md).

## Purpose

BabeL-O already classifies provider-side 5xx failures as retryable
`provider_unavailable`, but runtime recovery only auto-handles
`context_window`. Real sessions therefore still fail visibly on transient
provider availability errors, even when retrying the same model would be safe.

This plan adds a bounded, visible same-provider retry policy:

- maximum retry attempts: `10`;
- delay between attempts: `30s`;
- target failures: `provider_unavailable` and `rate_limit` only;
- target action: retry the same provider and same model;
- no silent provider/model/profile switching.

The goal is not to hide real provider instability forever. The goal is to make
transient upstream errors recover automatically while leaving an audit trail and
an honest terminal failure when the retry budget is exhausted.

## Evidence

Real session evidence from local SQLite:

- Session: `session_356b8f40-3963-4011-ac45-9bec150ee039`
- Project cwd: `/Users/tangyaoyue/DEV/BABEL/BabeL-O`
- Provider/model: `minimax` / `minimax/MiniMax-M3`
- Error sample:
  - UTC: `2026-07-02T07:43:03.365Z`
  - Beijing time: `2026-07-02 15:43:03`
  - HTTP status: `500`
  - Raw message: `type=api_error unknown error, 999 (1000)`
  - Request id: `0695498774bd1185436107ba7f49078b`
  - Classified kind: `provider_unavailable`
  - `retryable: true`
  - fallback policy: `retry_same_model`

Supporting facts:

- The same session had five same-shaped MiniMax 500 errors between
  `2026-07-02 15:11:02` and `2026-07-02 15:43:03` Beijing time.
- The failing turn was not near context limit:
  `Context usage 29% (267135/920000 tokens)`.
- The failure was not a provider protocol rejection. Prior protocol bugs showed
  HTTP 400 with messages such as `tool call result does not follow tool call`.
- The same session later had many successful MiniMax calls, proving provider
  credentials, model id, and request construction were not permanently broken.

## Current State

Implemented today:

- `src/runtime/providerRecovery.ts` classifies:
  - HTTP `429` as `rate_limit`, `retryable: true`;
  - HTTP `>=500` as `provider_unavailable`, `retryable: true`;
  - provider protocol errors as non-retryable.
- `buildProviderFallbackPolicy()` maps both `rate_limit` and
  `provider_unavailable` to `retry_same_model`.
- `src/providers/retry.ts` provides low-level `withRetry()` with default
  `maxRetries=2`, exponential backoff, and retryable statuses
  `[429, 500, 502, 503, 529]`.
- `AnthropicAdapter` and `OpenAIAdapter` use `withRetry()` for the initial HTTP
  response.
- `executeProviderRecoveryDecision()` only performs automatic recovery for
  `context_window`; all non-context recoveries rethrow.

Gaps:

- HTTP `504` is classified as retryable at runtime but not included in the
  low-level adapter retry status list.
- Streaming provider failures that happen after the initial response are not
  retried by `withRetry()`.
- Runtime classification says `retryable: true`, but no runtime retry action
  occurs for `provider_unavailable` / `rate_limit`.
- The user sees a terminal `PROVIDER_ERROR` even when retrying the same model is
  the intended policy.
- There is no event that says "BabeL-O is retrying the provider call after a
  transient upstream failure."

## Goals

- Retry transient provider availability failures automatically on the same
  provider/model.
- Apply the requested policy: `10` retries with `30s` between retry attempts.
- Emit explicit retry lifecycle events so CLI, Go TUI, logs, metrics, and
  future session graph views can show what happened.
- Preserve no-silent-switching: retries never change provider, model, profile,
  base URL, credentials, or tool visibility.
- Keep protocol, auth, billing, context window, and output-limit recovery
  separate.
- Make retry exhaustion terminal and clear.

## Non-goals

- Do not silently switch provider/model/profile.
- Do not retry non-idempotent tool execution.
- Do not retry provider protocol errors (`400`, tool-call replay mismatch,
  reasoning/tool result shape errors).
- Do not retry auth/billing/quota failures (`401`, `402`, `403`).
- Do not retry context-window errors here; existing compact-then-retry recovery
  remains the owner.
- Do not hide a persistent provider outage beyond the configured retry budget.

## Policy

### Default policy

```ts
providerUnavailableAutoRetry: {
  enabled: true,
  maxRetries: 10,
  delayMs: 30_000,
  retryableKinds: ['provider_unavailable', 'rate_limit'],
  retryableStatuses: [429, 500, 502, 503, 504, 529],
  sameProviderOnly: true,
  sameModelOnly: true,
}
```

Interpretation:

- `maxRetries=10` means at most 10 additional attempts after the first failed
  provider turn.
- `delayMs=30_000` is fixed delay by default, not exponential. Fixed delay
  matches the user-visible policy and makes UI countdown predictable.
- Worst-case wait before terminal exhaustion is about 5 minutes plus provider
  request time.
- A successful retry continues the same runtime turn; the user should not need
  to resend the prompt.

### Retryable failures

Retry only when `classifyProviderRecovery(error)` returns one of:

- `provider_unavailable`;
- `rate_limit`.

The status set should include:

- `429`;
- `500`;
- `502`;
- `503`;
- `504`;
- `529`.

Provider-specific textual evidence can refine classification later, but Phase 0
uses the existing classifier plus `504` adapter coverage.

### Non-retryable failures

Never retry:

- `provider_protocol`;
- `auth_or_billing`;
- `context_window` in this path;
- `max_output_tokens`;
- `unknown`;
- user cancellation / abort;
- permission denial;
- tool execution failure.

### Safe retry boundary

Automatic provider-turn retry is allowed only before any side-effectful tool
execution from the failed provider attempt has been accepted into runtime state.

Allowed:

- failure before any assistant delta;
- failure after text/thinking/usage deltas but before tool execution;
- failure after the provider returned no committed tool result.

Blocked:

- a tool call from the failed attempt already executed and produced a
  `tool_completed`;
- the runtime is waiting on a permission request;
- a write/execute tool side effect already happened;
- the session was cancelled or timed out.

Rationale: provider calls are safe to replay; tool side effects are not.

## Runtime Design

### Event contract

Add runtime events:

```ts
provider_retry_scheduled {
  sessionId: string
  providerId: string
  modelId: string
  requestId?: string
  originalRequestId?: string
  recoveryKind: 'provider_unavailable' | 'rate_limit'
  httpStatus?: number
  attempt: number
  maxRetries: number
  delayMs: number
  nextAttemptAt: string
  sameProvider: true
  sameModel: true
  message: string
}

provider_retry_started {
  sessionId: string
  providerId: string
  modelId: string
  recoveryKind: 'provider_unavailable' | 'rate_limit'
  attempt: number
  maxRetries: number
}

provider_retry_succeeded {
  sessionId: string
  providerId: string
  modelId: string
  recoveryKind: 'provider_unavailable' | 'rate_limit'
  attempt: number
  maxRetries: number
  recoveredAfterMs: number
}

provider_retry_exhausted {
  sessionId: string
  providerId: string
  modelId: string
  recoveryKind: 'provider_unavailable' | 'rate_limit'
  attempts: number
  maxRetries: number
  finalErrorCode: string
  message: string
}
```

`provider_retry_scheduled` is the key UI event. Go TUI can show a countdown
instead of looking frozen. CLI can print a compact line.

### Execution shape

1. Provider turn throws.
2. `executeProviderRecoveryDecision()` fires `PostInvocation` hooks, as today.
3. `classifyProviderRecovery(error)` returns a retryable kind.
4. If retry budget remains and safe retry boundary passes:
   - emit `provider_retry_scheduled` before waiting, so UI countdown can start
     immediately;
   - wait `30s`, unless the runtime abort signal fires;
   - emit `provider_retry_started` only after the wait completes;
   - return a new recovery result such as `{ kind: 'retry' }`.
5. `LLMCodingRuntime` loops back to rebuild/refresh the provider call and
   invokes the same provider/model again.
6. On success:
   - emit `provider_retry_succeeded`;
   - continue normal tool/result flow.
7. On repeated failure:
   - increment retry count;
   - repeat until 10 retries are exhausted.
8. On exhaustion:
   - emit `provider_retry_exhausted`;
   - emit the final `error` / `result` as today, preserving the final provider
     raw message and request id.

### State

Runtime needs per-turn retry state:

```ts
providerAvailabilityRetryCount: number
providerAvailabilityRetryStartedAt?: number
lastProviderAvailabilityFailure?: {
  providerId: string
  modelId: string
  recoveryKind: 'provider_unavailable' | 'rate_limit'
  httpStatus?: number
  requestId?: string
}
```

This state is process-local in Phase 0. Durable resume of a mid-wait retry is a
future feature; if Nexus restarts during the wait, the existing orphan execution
reaper should mark the session interrupted.

### Abort behavior

During the 30s wait:

- user cancellation must abort immediately;
- hard watchdog must abort immediately;
- no retry event should be emitted after abort wins;
- the terminal error should be `REQUEST_CANCELLED` / watchdog timeout, not a
  provider error.

## Adapter Design

### Phase 0 adapter change

Extend `withRetry()` default statuses to include `504`.

Rationale: MiniMax has emitted HTTP 504 `timeout_error 请求处理超时，请稍后重试
(2066)` in real sessions, and runtime already classifies 5xx as retryable.

### Runtime-vs-adapter responsibility

Keep adapter retry short and low-level:

- handles initial HTTP response failures;
- no user-visible event;
- existing max retries remain small.

Runtime retry is user-visible and turn-level:

- handles classified provider recovery failures;
- covers streaming failures after initial response;
- emits retry lifecycle events;
- applies the 10 x 30s policy.

## Configuration

Phase 0/1 hard-code the requested default policy behind env-overridable runtime
constants. Phase 3 adds a saved config surface under `providerAutoRetry`; env
overrides remain higher precedence for operator/test control:

```json
{
  "providerAutoRetry": {
    "enabled": true,
    "maxRetries": 10,
    "delayMs": 30000
  }
}
```

Environment overrides for test/operator use:

- `BABEL_O_PROVIDER_AUTO_RETRY_ENABLED=0|1`
- `BABEL_O_PROVIDER_AUTO_RETRY_MAX_RETRIES=10`
- `BABEL_O_PROVIDER_AUTO_RETRY_DELAY_MS=30000`

Tests must set `delayMs=1` or inject a fake sleeper; do not make tests wait
real time.

Status as of `2026-07-03`: saved config read/write is landed via
`ConfigManager.getProviderAutoRetryConfig()` /
`ConfigManager.setProviderAutoRetryConfig()`. `LLMCodingRuntime` reads saved
config first, then lets the three env vars override it.

### Provider-specific tuning

Status as of `2026-07-03`: MiniMax transient availability signals are explicitly
classified as `provider_unavailable`, including `api_error`, `unknown error,
999 (1000)`, `timeout_error`, `2066`, and Chinese "try again later" timeout
messages. This keeps the real regression path on same-provider retry while
leaving provider protocol/auth/billing failures outside auto retry.

## UX

### Go TUI

When `provider_retry_scheduled` arrives, show a running-state line such as:

```text
provider retry  MiniMax-M3 unavailable; retry 3/10 in 30s
```

Footer state should prefer retry countdown over generic `drafting response`.

Status as of `2026-07-03`: Go TUI transcript/footer visibility is landed. It
renders `provider_retry_scheduled`, `provider_retry_started`,
`provider_retry_succeeded`, and `provider_retry_exhausted` as explicit retry
rows, and the footer shows a live countdown while waiting for the next retry.
One-shot CLI also prints compact retry status lines on stderr.

### CLI

One-shot CLI should print compact retry status lines:

```text
provider retry: minimax/MiniMax-M3 unavailable, retry 1/10 in 30s
```

### Session inspection

`bbl inspect-session` and future session graph should summarize:

- retry count;
- first failure request id;
- final success/exhaustion;
- total time spent waiting.

Status as of `2026-07-03`: `bbl inspect-session` summarizes persisted provider
retry lifecycle events with provider/model, recovery kind, scheduled/started/
succeeded/exhausted counts, first request id, total scheduled delay, recovered
duration, final error code, and last status.

### Runtime metrics

Status as of `2026-07-03`: `/v1/runtime/metrics` and `/v1/runtime/status`
include `providerRetries` aggregated from recent persisted retry events. The
snapshot exposes scheduled/started/succeeded/exhausted counts, attempt totals,
total scheduled delay, recovered duration average, by-provider counts, and
by-recovery-kind counts.

### Cancellation / wait hardening

Status as of `2026-07-03`: `provider_retry_scheduled` is yielded before the
runtime sleeps, so Go TUI and CLI can display the countdown during the wait
instead of after it. The wait is owned by `LLMCodingRuntime` and uses the turn
abort signal; cancellation during the wait produces `REQUEST_CANCELLED`, does
not emit `provider_retry_started`, and does not start the next provider
attempt.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 0 | Closed 2026-07-03 | Admit proposal, add `504` to adapter retry status, define event schemas and runtime policy constants. | `test/retry.test.ts` covers 504; shared event schemas compile; docs registered. |
| Phase 1 | Closed 2026-07-03 | Runtime same-provider retry for `provider_unavailable` / `rate_limit`, fixed 10 x 30s policy, fake sleeper in tests. | Runtime recovery decision schedules same provider/model retry and emits retry lifecycle events; adapter initial 500/504 retries remain short and local. |
| Phase 2 | Closed 2026-07-03 | Retry lifecycle observability in Go TUI, CLI renderer, execution metrics, and inspect-session summary. | Go TUI retry rows/footer countdown, CLI stderr status lines, inspect-session summary, and runtime metrics landed. |
| Phase 3 | Closed 2026-07-03 | Config/env overrides and provider-specific policy tuning. | Env overrides, saved config surface, and MiniMax transient availability classification landed. |
| Phase 4 | Closed 2026-07-03 | Exhaustion and cancellation hardening. | Exhaustion event, streaming scheduled-before-wait behavior, and retry-wait cancellation regression landed. |

## Regression Plan

Focused tests:

- `test/retry.test.ts`
  - `withRetry()` retries HTTP 504 by default.
  - `readProviderAutoRetryPolicy()` applies default, saved config, env
    override, and invalid config fallback precedence.
- `test/provider-recovery.test.ts`
  - 500/504/429 classify to retryable policies.
  - provider protocol / auth / billing remain non-retryable.
  - MiniMax `unknown error, 999 (1000)` and `timeout_error ... (2066)` classify
    as retryable `provider_unavailable`.
- `test/execute-provider-recovery-decision.test.ts`
  - retryable provider error returns retry decision while budget remains.
  - budget exhaustion returns terminal path with `provider_retry_exhausted`.
  - abort during wait cancels without starting the next retry.
- `test/runtime-llm.test.ts`
  - `ConfigManager` saves and reloads provider auto retry config.
  - mock provider fails once with MiniMax-style 500, then succeeds; final
    session succeeds and emits retry scheduled/started/succeeded.
  - mock provider fails 11 total attempts; final session fails after 10
    retries and emits exhausted.
  - tool/protocol errors do not retry.
- Go TUI renderer test:
  - retry scheduled/started/succeeded/exhausted events render status rows.
  - runtime footer distinguishes retry waiting/retrying from generic runtime
    activity.
  - provider retry scheduled events populate a live footer countdown; started
    and terminal retry events clear it.
- `test/inspect-session.test.ts`
  - persisted retry scheduled/started/succeeded events summarize in
    `providerRetrySummary`.
- `test/runtime.test.ts` / `test/runtime-metrics-router.test.ts`
  - `/v1/runtime/metrics` and `/v1/runtime/status` expose `providerRetries`
    with zero-state and populated-state coverage.
  - runtime streams `provider_retry_scheduled` before the retry delay completes.
  - runtime cancellation during retry wait emits `REQUEST_CANCELLED` without
    `provider_retry_started` or a second provider attempt.

Verification commands:

- `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-provider-auto-retry.json BABEL_O_PROVIDER_AUTO_RETRY_DELAY_MS=1 npx tsx --test --test-concurrency=1 test/retry.test.ts test/provider-recovery.test.ts test/execute-provider-recovery-decision.test.ts test/runtime-llm.test.ts`
- `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-inspect-retry.json npx tsx --test --test-name-pattern "provider retry|inspectSession: tier" test/inspect-session.test.ts`
- `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-provider-retry-metrics.json BABEL_O_PROVIDER_AUTO_RETRY_DELAY_MS=1 npx tsx --test --test-name-pattern "runtime metrics|provider retry" test/runtime.test.ts test/runtime-metrics-router.test.ts`
- `npm run typecheck`
- `npm run format:check`
- `npm run docs:check`
- `cd clients/go-tui && go test ./internal/tui -run 'TestFormatNexusEventProviderRetry|TestRuntimeAnimationStateFollowsAgentEvent'`
- `cd clients/go-tui && go test ./internal/tui -run 'TestFormatProviderRetryCountdown|TestConsumeNexusEventTracksProviderRetryCountdown|TestConsumeNexusEventClearsProviderRetryCountdownOnResult|TestFormatNexusEventProviderRetry|TestRuntimeAnimationStateFollowsAgentEvent'`
- `npm run test:providers:smoke`

## Rollout

1. Land schema + tests with fake sleep.
2. Enable default policy in runtime.
3. Run live MiniMax smoke with a low-risk prompt.
4. Watch `/v1/runtime/metrics` and local session events for retry counts.
5. If repeated provider outage causes too-long waits, expose config override
   before changing defaults.

## Relationship To Existing Provider Recovery Proposal

[provider-recovery-and-model-catalog-governance-plan.md](./provider-recovery-and-model-catalog-governance-plan.md)
is broader: it also covers model-catalog precedence and declared backup provider
fallback. This plan is the narrower real-regression slice for same-provider
automatic retry. It deliberately avoids backup-provider fallback because that
would alter cost, latency, and behavior.

If both plans conflict, this plan controls the same-provider auto-retry policy
for `provider_unavailable` / `rate_limit`; the broader plan continues to own
catalog governance and any future explicit backup-provider design.

## 中文概述

### 背景

真实 session `session_356b8f40-3963-4011-ac45-9bec150ee039` 在 MiniMax 上多次
遇到 HTTP 500：`type=api_error unknown error, 999 (1000)`。BabeL-O 已把它分类
为 `provider_unavailable`、`retryable=true`、`retry_same_model`，但 runtime 目前
只自动恢复 `context_window`，所以这类可重试 provider 错误仍会直接失败。

### 决策

新增同 provider / 同 model 自动 retry：最多 10 次，每次间隔 30 秒。retry 只覆
盖 `provider_unavailable` 和 `rate_limit`，不静默切换 provider/model/profile。

### 边界

只重试 provider call，不重试已经执行过的工具副作用。协议错误、鉴权/余额错误、
context window、max output、用户取消都不走这条 retry。

### 下一步

Phase 0/1 已落地：补 504 adapter retry、事件 schema、runtime retry 决策和 mock
provider 回归。Phase 2 已关闭：Go TUI retry 行与 footer countdown、CLI stderr 状态线、
inspect-session retry 汇总、runtime metrics 均已落地。Phase 3 已补 saved config 与 env
覆盖优先级，并补 MiniMax transient availability 分类。Phase 4 已关闭：
scheduled-before-wait 流式时序、取消映射、无 started/无二次 provider attempt 的回归均
已补齐。
