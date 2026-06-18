# Cache Observability and Nexus Realtime Detection Plan

> State: Active Plan
> Track: Context Cache / Runtime Observability / Realtime Detection
> Priority: P2 (Phases A–D 收口 2026-06-17; Phase E long-term Watch)
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../active/TODO_performance.md](../active/TODO_performance.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/runtime/`, `src/providers/`, `src/storage/`
> Governance: Indexed by [context-governance-index.md](./context-governance-index.md). This document owns cache observability planning; unavailable cache families must stay explicitly unavailable.

**Status (2026-06-17)**: upgraded from Draft to Active Plan. **Phase A, Phase B, Phase C, and Phase D are all 收口** — see `WORK_LOG.md` 2026-06-17 entries and the per-phase subsections (§5.1, §5.2, §5.3, §5.4) for implementation details. Phase A (`cacheHealth.ts` pure functions + `/v1/runtime/metrics` enrichment). Phase B (per-session aggregation path — reused the existing `events` slice already fetched by `/v1/runtime/loop/health`; no `getExecutionMetrics(sessionId)` call needed). Phase C (eventized `cache_health` event — `CacheHealthEventSchema` + `CacheHealthEventDedup` + `maybeBuildCacheHealthEventFromExecutionMetrics` wired into both HTTP and WebSocket event yield points). Phase D (Behavior Monitor `prompt-cache-miss-wave` detector — `detectPromptCacheMissWave` reads `execution_metrics.cacheReadRatio` per session; `BehaviorTrigger` union extended; wired into `BehaviorMonitor.detectAll()`). **Phase E (future real caches) remains the only open phase** and is long-term Watch.

---

## 1. Background

BabeL-O already has some cache-related telemetry:

- provider usage deltas expose `cacheCreationInputTokens` / `cacheReadInputTokens`;
- `execution_metrics` events store `cacheReadRatio`;
- `NexusMetrics` aggregates token/cache data in `/v1/runtime/metrics` and `/v1/runtime/status`;
- prefix cache diagnostics expose immutable prefix ratio, fingerprint, and volatile-content-last;
- cache-aware compact policy reads cache reuse metrics to adjust compact strategy.

These capabilities are enough to observe part of real **Prompt Cache** behavior, but there is no unified cache-health protocol yet and no integration with Nexus realtime detection / `bbl loop` health.

User-proposed targets:

| Dimension | Target hit rate |
| --- | ---: |
| Prompt Cache | 85% |
| Code Index Cache | 90% |
| Tool Cache | 50% |
| Reasoning Cache | 10% |

Current source-audit conclusion:

| Dimension | Current evaluability | Notes |
| --- | --- | --- |
| Prompt Cache | Partially evaluable | When provider returns cache read/create tokens, `cacheReadRatio` can be computed. |
| Code Index Cache | Not evaluable | No code index cache subsystem or hit/miss events yet. |
| Tool Cache | Not evaluable | Tool call count / duration exists, but no tool result cache hit/miss exists. |
| Reasoning Cache | Not evaluable | Reasoning token / replay observations exist, but no reasoning cache hit/miss exists. |

This plan does not try to implement every cache type immediately. It first establishes an **honest observability protocol**: calculate what can be calculated, mark what cannot as `unavailable`, and feed real below-target metrics into Nexus realtime health.

---

## 2. Design Principles

### 2.1 Runtime/Nexus owns truth

Cache hit rate is a runtime/provider/storage fact. Go TUI, CLI, or model narrative must not infer it locally.

- Runtime produces per-turn `execution_metrics`.
- Storage persists replayable metrics.
- Nexus owns rolling-window aggregation, threshold evaluation, and realtime projection.
- Clients only render `cacheHealth` / `signals` / `status`.

### 2.2 Do Not Pretend Unavailable Is 0%

0% means “there are samples and they really missed”; `unavailable` means “there is no corresponding observation contract.”

This is especially important for Code Index / Tool / Reasoning Cache. Showing 0% would mislead users into thinking those caches exist but perform poorly.

### 2.3 Separate Prompt Cache Metrics

| Metric | Meaning | Equivalent to hit rate? |
| --- | --- | --- |
| `cacheReadRatio` | cached read tokens / total prompt-side tokens | Close to token-weighted hit rate |
| `prefixCacheImmutableRatio` | stable prefix character ratio in system prompt | Not hit rate; only cacheability/stability indicator |
| `prefixCacheFingerprint` | stable fingerprint of cacheable prefix | Not hit rate; used for drift/debug |

Realtime Prompt Cache evaluation uses `cacheReadRatio` as the main metric. Prefix cache diagnostics are explanatory fields and do not participate in target evaluation.

### 2.4 Low Cache Hit Must Not Override Higher-priority Runtime State

`blocked`, `drift`, `waiting_permission`, scope boundary, timeout, and context grounding remain higher-priority pane-health facts.

Cache health should first appear as `signals` / `attention`; it may affect pane `status` only after a new status priority is explicitly designed.

---

## 3. Existing Integration Points

### 3.1 Runtime event

`execution_metrics` already contains:

- `inputTokens`
- `outputTokens`
- `cacheCreationInputTokens`
- `cacheReadInputTokens`
- `cacheReadRatio`
- `cachePreservationMode`
- `prefixCacheImmutableRatio`
- `prefixCacheVolatileContentLast`
- `prefixCacheFingerprint`

The current event schema lives in `src/shared/events.ts`.

### 3.2 Runtime Aggregation

`NexusMetrics.recordTokenUsage()` and `NexusMetrics.snapshot()` already aggregate:

```ts
tokenUsage: {
  inputTokens,
  outputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
  cacheReadRatio,
}
```

`contextPolicy.prefixCache` already aggregates:

```ts
prefixCache: {
  immutableRatioAvg,
  sampleCount,
  volatileContentLastRatio,
  latestFingerprint,
}
```

### 3.3 Storage Replay

`execution_metrics` already enters SQLite / Memory storage, and `getExecutionMetrics(sessionId)` returns the latest metrics for a session.

This means realtime detection can support:

- in-process cumulative view: quickly show cumulative state inside the current Nexus process;
- session replay view: re-aggregate from recent session events / metrics;
- pane-local view: derive from a recent event slice for one session in `/v1/runtime/loop/health`.

### 3.4 Realtime Surfaces

Existing reusable surfaces:

| Surface | Current responsibility | Cache integration |
| --- | --- | --- |
| `/v1/runtime/metrics` | Process-level runtime metrics | Add `cacheHealth` aggregation |
| `/v1/runtime/status` | Runtime status polled by Go TUI / clients | Add `cacheHealth.summary` |
| `/v1/runtime/loop/health` | bbl loop pane health | Add `cacheHealth` / `signals` per pane |
| `/v1/sessions/:id/wait` | Per-pane event long poll | Can carry future `cache_health` event |
| Behavior trace | Cross-session anomaly trajectory | Can write trace when low hit rate crosses a window threshold |

---

## 4. Target Model

### 4.1 CacheHealth schema

Suggested new internal type:

```ts
type CacheDimension = 'prompt' | 'code_index' | 'tool' | 'reasoning'

type CacheHealthStatus =
  | 'ok'
  | 'warning'
  | 'critical'
  | 'unavailable'

type CacheHealthDimension = {
  dimension: CacheDimension
  targetRatio: number
  observedRatio?: number
  sampleCount: number
  status: CacheHealthStatus
  reason?: string
  source: 'provider_usage' | 'execution_metrics' | 'not_implemented'
}

type CacheHealthSnapshot = {
  type: 'cache_health'
  schemaVersion: '2026-06-17.cache-health.v1'
  window: {
    kind: 'process' | 'session' | 'pane'
    sessionId?: string
    lastN?: number
  }
  dimensions: CacheHealthDimension[]
  summary: {
    status: CacheHealthStatus
    belowTarget: string[]
    unavailable: string[]
  }
}
```

### 4.2 Default Targets

Default targets:

```ts
const DEFAULT_CACHE_HEALTH_TARGETS = {
  prompt: 0.85,
  code_index: 0.90,
  tool: 0.50,
  reasoning: 0.10,
}
```

Env/config overrides can be added later, but v1 does not need a configuration surface first.

### 4.3 Prompt Cache Evaluation

Prompt Cache observability decision:

```text
provider has cache token samples
  => observedRatio = cacheReadInputTokens /
     (inputTokens + cacheCreationInputTokens + cacheReadInputTokens)

no provider cache token fields but provider/model known not reporting
  => unavailable

has samples and observedRatio < target
  => warning or critical
```

Suggested thresholds:

| Condition | Status |
| --- | --- |
| sampleCount = 0 | `unavailable` |
| observedRatio >= target | `ok` |
| observedRatio >= target * 0.75 | `warning` |
| observedRatio < target * 0.75 | `critical` |

v1 may output only `ok/warning/unavailable` first to avoid noisy critical states.

### 4.4 Unavailable Dimensions

Before hit/miss events exist:

```text
Code Index Cache => unavailable(reason='code_index_cache_not_implemented')
Tool Cache       => unavailable(reason='tool_result_cache_not_implemented')
Reasoning Cache  => unavailable(reason='reasoning_cache_not_reported')
```

These three dimensions must show targets but must not show 0%.

---

## 5. Nexus Realtime Detection Integration

### 5.1 Phase A — Metrics-only cacheHealth

Goal: add `cacheHealth` only to `/v1/runtime/metrics` and `/v1/runtime/status` without adding new events.

Implementation suggestion:

1. Add `src/nexus/cacheHealth.ts`:
   - `buildCacheHealthFromRuntimeMetrics(snapshot)`
   - `buildCacheHealthFromEvents(events, options)`
   - `evaluateCacheDimension(...)`
2. `buildRuntimeMetricsSnapshot()` calls the cache health builder.
3. `/v1/runtime/status` automatically carries `metrics.cacheHealth`.
4. Add regressions:
   - provider cache read ratio 0.90 => prompt ok；
   - provider cache read ratio 0.40 => prompt warning；
   - no cache token samples => prompt unavailable；
   - code/tool/reasoning remain unavailable.

Acceptance:

- `GET /v1/runtime/metrics` shows all four dimensions;
- only Prompt Cache has a real observed ratio;
- existing `tokenUsage` shape is unchanged.

### 5.2 Phase B — Loop Health Pane Projection

**Status (2026-06-17)**: ✅ Phase B 收口.

Implementation landed:

1. `/v1/runtime/loop/health` already fetches per-session `events: NexusEvent[]` slices with `query.lastN` window — reused for cache health projection (no extra storage call).
2. `buildCacheHealthFromEvents(events, { sessionId, lastN, kind: 'pane' })` constructed per-pane.
3. Pane payload now carries sibling `cacheHealth: CacheHealthSnapshot` field; primary `status` is unchanged.

Implementation suggestion (original, kept for reference):

```ts
cacheHealth: CacheHealthSnapshot
signals: [
  {
    type: 'cache_low_prompt_hit_rate',
    severity: 'warning',
    message: 'Prompt Cache below target: 62% < 85%',
  }
]
```

4. Go TUI only renders attention badges and does not calculate hit rate locally.

Acceptance:

- `blocked/drift/waiting/done` states are not overridden by cache warning;
- prompt cache below target is visible in pane;
- unavailable dimensions do not produce warnings.

Validation (`test/cache-health.test.ts` T18 + T19):
- Wide `NexusEvent[]` slice with mixed event types is accepted; internal filter counts only `execution_metrics` events in `sampleCount`.
- `kind: 'pane'` propagates to `CacheHealthSnapshot.window.kind`.
- Status priority: `cacheHealth.status` is independent of pane `status`; route handler keeps them as siblings.

Phase C note: the `signals` array shape (above) is deferred to Phase C; Phase B only attaches the structured `cacheHealth` snapshot.

### 5.3 Phase C — Eventized Cache Health

**Status (2026-06-17)**: ✅ Phase C 收口.

Implementation landed:

- `src/shared/events.ts` adds `CacheHealthEventSchema` (discriminated union by `type: 'cache_health'`). Schema includes `sessionId` / `requestId` / `cacheHealth` / `trigger`.
- `src/nexus/cacheHealth.ts` adds:
  - `buildCacheHealthEvent({ sessionId, cwd, requestId, cacheHealth, trigger, now })`: returns `undefined` when `summary.status === 'ok'`, else returns the structured event.
  - `CacheHealthEventDedup` class: per-session FIFO set, 256-entry cap, `shouldEmit(sessionId, requestId)` API.
  - Module-level singleton `globalCacheHealthDedup` (mirrors `defaultContextBroadcaster` pattern). HTTP and WebSocket paths share the same dedup state.
  - `maybeBuildCacheHealthEventFromExecutionMetrics(event, cwd)`: aggregates token usage from the `execution_metrics` event, builds the snapshot, applies dedup, returns event or `undefined`.
- `src/nexus/app.ts` wires `maybeEmitCacheHealthEvent` into both the HTTP `/v1/execute` and WebSocket `/v1/stream` event yield points. The returned event is appended to `events` and persisted via `storage.appendEvent`; the WebSocket path also forwards via `sendJson`.

Goal: optionally generate a `cache_health` event after each turn for `/v1/sessions/:id/wait` and transcript use.

Suggested new event:

```ts
{
  type: 'cache_health',
  sessionId,
  requestId,
  cacheHealth: CacheHealthSnapshot,
}
```

Constraints:

- Generate only after execution_metrics;
- v1 may generate only when status != ok;
- event schema must be stable to avoid fragmented client parsing.

Acceptance:

- per-pane wait can receive cache health warning;
- session replay can reconstruct cache health;
- do not emit duplicate identical warnings for the same requestId.

Validation (`test/cache-health.test.ts` T20-T28):
- `buildCacheHealthEvent` returns `undefined` for `ok` status, structured event for `warning` / `critical`.
- Dedup: same `(sessionId, requestId)` returns `false`; different `requestId` or `sessionId` returns `true`.
- Dedup caps at 256 entries per session.
- `maybeBuildCacheHealthEventFromExecutionMetrics` short-circuits on non-`execution_metrics` events.
- `ok` status execution_metrics does not emit even on first call.

### 5.4 Phase D — Behavior Monitor Bridge

**Status (2026-06-17)**: ✅ Phase D 收口.

The ingestion wiring blocker documented in the original plan note below was resolved earlier the same day (see `WORK_LOG.md` 2026-06-17 "BehaviorMonitor ingest wiring 收口"). With that prerequisite satisfied, the detector is now implemented and wired into `BehaviorMonitor.detectAll()`.

Implementation landed:

- `src/runtime/behaviorTrace.ts`: `BehaviorTrigger` union extended with `'prompt-cache-miss-wave'`.
- `src/nexus/behaviorMonitor.ts`:
  - New `DEFAULT_PROMPT_CACHE_MISS_WAVE_MIN_SESSIONS = 3` + `DEFAULT_PROMPT_CACHE_MISS_WAVE_TARGET_RATIO = 0.85` constants.
  - New `CrossSessionPromptCacheMissWave` type joined to the `CrossSessionTrigger` union (carries `sessionIds`, `observedRatios: Record<sessionId, ratio>`, `targetRatio`, `windowMs`, `occurrenceCount`).
  - `BehaviorMonitorOptions` extended with `promptCacheMissWaveMinSessions` + `promptCacheMissWaveTargetRatio`; constructor + `this.opts` default to the constants; `detectAll()` now runs the new detector.
  - `detectPromptCacheMissWave(sessions, options)`: per session, picks the **latest** `execution_metrics.cacheReadRatio` inside the windowMs; sessions below `targetRatio` land in `observedRatios`; returns a single trigger if `observedRatios.size >= minSessions`.
  - `crossSessionToAnomaly` handles the new case → `errorCode: 'PROMPT_CACHE_MISS_WAVE'`, message includes the session count, target, and the lowest observed ratios sorted ascending.
  - `runBehaviorMonitor` pattern selector extended to a 4-way branch so `HintCandidate.pattern` is always defined.

Validation (`test/behavior-monitor.test.ts` Phase D suite, 8 tests):
- fires when ≥ 3 sessions below target in window;
- does not fire with only 2 sessions below target;
- ignores sessions with ratio ≥ target;
- fires via `BehaviorMonitor.detectAll()` when ingested events have low ratios;
- `detectAll()` does not fire when all ratios are ok;
- custom `targetRatio` honored via options;
- ignores sessions with no `execution_metrics` events;
- prefers the latest `execution_metrics` per session (re-evaluates when a newer ok follows an old low, and vice versa).

Goal: when multiple sessions show low Prompt Cache hit rate in a short window, write behavior trace and optionally trigger a live hint.

New detector:

```text
prompt-cache-miss-wave:
  N sessions have prompt observedRatio below the target threshold within rollingWindowMs
```

Defaults (now implemented as module constants):

- minSessions: 3
- window: 5min (reuses `DEFAULT_ROLLING_WINDOW_MS`)
- target: 0.85
- hint cooldown: reuse BehaviorMonitor 5min (`DEFAULT_HINT_COOLDOWN_MS`)

Output:

- anomaly source='nexus' in `behavior-trace.jsonl` with `errorCode: 'PROMPT_CACHE_MISS_WAVE'`;
- `pendingHints` in `/v1/runtime/loop/health` continues to be reused (via `applyBehaviorHint`).

Note (historical, resolved): the original plan flagged that `BehaviorMonitor` ingest wiring needed to be completed before Phase D could ship. That wiring is now in place (2026-06-17), so the detector receives real `execution_metrics` events via `behaviorMonitor.ingest()` at the HTTP `/v1/execute` and WebSocket `/v1/stream` event yield points.

### 5.5 Phase E — Future Real Caches

Connect hit/miss only when these caches are actually implemented later:

| Dimension | Minimum required facts |
| --- | --- |
| Code Index Cache | index lookup request, hit/miss, index key, invalidated reason |
| Tool Cache | cacheable tool identity, input hash, hit/miss, ttl, risk-safe invalidation |
| Reasoning Cache | provider-reported reasoning cache tokens or explicit internal reasoning reuse event |

Keep them `unavailable` until those facts exist.

---

## 6. UI / TUI Rendering

### 6.1 Runtime status

Suggested `/v1/runtime/status` summary:

```text
cache: prompt 78% / target 85%; code_index unavailable; tool unavailable; reasoning unavailable
```

### 6.2 bbl loop Sidebar

Suggested pane attention display:

```text
cache: prompt below target
```

Do not cram too many ratios into the main pane title; put detailed ratios in overlay or status details.

### 6.3 Transcript Event

If Phase C lands, render as:

```text
cache ! prompt 62% < 85%
```

Unobservable dimensions should not enter transcript, to avoid noise.

---

## 7. Tests

Suggested test layers:

| Test | Coverage |
| --- | --- |
| `test/cache-health.test.ts` | Pure functions: target, ratio, unavailable, summary |
| `test/runtime.test.ts` | runtime metrics/status contains cacheHealth after `execution_metrics` |
| `test/runtime-loop.test.ts` | loop health pane carries cacheHealth without overriding original status |
| `test/behavior-monitor.test.ts` | Phase D prompt-cache-miss-wave detector |
| Go TUI loop tests | cache attention rendering, no local ratio inference |

---

## 8. Non-goals

- Do not implement Code Index Cache / Tool Cache / Reasoning Cache in v1.
- Do not treat prefix cache immutable ratio as hit rate.
- Do not let Go TUI / CLI calculate cache hit rate.
- Do not let low cache hit override higher-priority runtime states such as permission/scope/timeout.
- Do not show 0% for unavailable dimensions.
- Do not introduce an LLM to judge cache health.

---

## 9. Recommended Next Slice

Minimal shippable slice:

1. Add pure functions in `src/nexus/cacheHealth.ts`.
2. Add process-level `cacheHealth` to `/v1/runtime/metrics`.
3. Add pane-level `cacheHealth` to `/v1/runtime/loop/health`.
4. Write TS regressions confirming Prompt Cache is evaluable and the other three dimensions are unavailable.
5. Go TUI only renders read-only state and does not change its state machine.

This path brings the 85% Prompt Cache target into Nexus realtime detection fastest while keeping honest semantics for the other three dimensions.

## 10. BabeL-2 Pattern Analysis (Reference Only)

BabeL-2 has implemented several cache observability patterns that are worth understanding before implementation, but **none of them are copied directly** per `context-management-optimization-plan.md` §11 (no imported complexity). The goal is to extract the formula and telemetry shape, then re-home them into BabeL-O's single-module, `unavailable`-aware, REST-first architecture.

### 10.1 Three different `cacheReadRatio` formulas in BabeL-2

| File | Formula | Use case |
| --- | --- | --- |
| `utils/forkedAgent.ts:647-654` | `cache_read / (input + cache_creation + cache_read)` | Forked agent telemetry events (token-weighted hit rate) |
| `utils/telemetry/perfettoTracing.ts:516-522` | `cacheReadTokens / promptTokens * 100` | Perfetto trace export (input-only denominator) |
| `utils/stats.ts:333-336` (raw accumulation) | Tracks `cacheReadInputTokens` / `cacheCreationInputTokens` separately, no ratio | Daily token stats |

**Lesson**: the two ratio formulas differ in their denominator. BabeL-2 itself uses two different definitions in different code paths, which can confuse operators. BabeL-O must pick one and document it.

**BabeL-O choice** (`src/nexus/metrics.ts:344-351`): the forkedAgent formula — `cacheReadInputTokens / (inputTokens + cacheCreationInputTokens + cacheReadInputTokens)`. This is the **token-weighted hit rate** that is most honest about whether cache is saving real prompt cost. The plan §4.3 already specifies this formula. No change.

### 10.2 Compact-time cache telemetry (BabeL-2 `compact.ts:670-680`)

BabeL-2's compact path records these fields per compact call:

```ts
compactionInputTokens
compactionOutputTokens
compactionCacheReadTokens          // cache read by THIS compact call
compactionCacheCreationTokens      // cache created by THIS compact call
compactionTotalTokens              // input + cache_creation + cache_read + output
promptCacheSharingEnabled
```

**Lesson**: compact itself is a cache event. A large `compactionCacheCreationTokens` value after a compact indicates the boundary broke the cached prefix (i.e., the new summary invalidated the upstream cache). BabeL-O's `context_compact_boundary` event exists but does not currently surface `cacheCreation` delta. This is a Phase C candidate, not Phase A.

**BabeL-O scope**: defer to Phase C. Phase A only reads existing `cacheReadRatio` / `cacheReadInputTokens` / `cacheCreationInputTokens` from `execution_metrics` and `/v1/runtime/metrics` aggregation. Compact-time delta is out of scope.

### 10.3 Perfetto tracing format (BabeL-2 `perfettoTracing.ts:521`)

BabeL-2 emits `cache_hit_rate_pct` as `Math.round((cacheReadTokens / promptTokens) * 10000) / 100` — a fixed-precision percentage string.

**BabeL-O choice**: keep `observedRatio` as a `0..1` float in the structured `CacheHealthDimension` (plan §4.1), and let the UI layer apply its own precision when rendering. This avoids encoding presentation choices in the data layer.

### 10.4 What to NOT copy from BabeL-2

| BabeL-2 pattern | Why we don't copy |
| --- | --- |
| Multiple files (`stats.ts` / `forkedAgent.ts` / `compact.ts` / `perfettoTracing.ts`) implementing the same concept | Single module: `src/nexus/cacheHealth.ts` |
| `unavailable` not distinguished from `0%` | `CacheHealthStatus = 'ok' \| 'warning' \| 'critical' \| 'unavailable'` (plan §4.1) |
| Stats.tsx-style 89k-token UI rendering cache | REST API + Go TUI badge only (plan §6) |
| Compaction logic mixed with cache telemetry | Boundary: cacheHealth reads `execution_metrics`, does not touch compact internals |
| Daily / monthly aggregation in `stats.ts` | Out of scope; sessions are ephemeral in BabeL-O |
| Telemetry sent to Statsig as events | BabeL-O does not forward cache telemetry to external analytics |

### 10.5 Summary of design decisions for Phase A

| Decision | Source | Implication |
| --- | --- | --- |
| Use forkedAgent formula for `cacheReadRatio` | `src/nexus/metrics.ts:344-351` already uses it | No formula change in Phase A |
| Keep `observedRatio` as `0..1` float, not pre-rendered percentage | BabeL-2 lesson §10.3 | UI layer formats |
| Phase A reads only `execution_metrics` + `NexusMetrics.snapshot()` | Avoid compact internals | Simple, testable, no runtime coupling |
| `code_index` / `tool` / `reasoning` stay `unavailable` | Plan §4.4 + BabeL-2 lesson §10.4 | No fabricated 0% rates |
| Single `cacheHealth.ts` module, no fragmentation | BabeL-2 lesson §10.4 | Easy to test, no fan-out |

## 中文概述

### 背景

上下文缓存和实时检测容易被文档写成“已经可观测”，但很多 provider 的 cache hit/miss 并没有稳定事实源。

### 边界

本文只规划可审计的 cache health 与 realtime detection，不允许伪造不存在的 cache family 或把估算值当成真实 provider 指标。

### 当前状态

2026-06-17 升级为 Active Plan。Phase A（`cacheHealth.ts` 纯函数 + `/v1/runtime/metrics` 增 `cacheHealth` 字段）独立可落地，0 上游依赖。Phase D（Behavior Monitor bridge）前置条件已就位（`behaviorMonitor.ingest` 在 `app.ts` 2 个 yield 点已接线）。Phase B 需先确认 `getExecutionMetrics(sessionId)` storage 接口；Phase C/E 待 A/B 落地。
