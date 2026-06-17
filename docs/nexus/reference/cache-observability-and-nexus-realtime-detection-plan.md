# Cache Observability and Nexus Realtime Detection Plan

> 状态：v1 草案（2026-06-17）
> 范围：把现有 Prompt Cache / prefix cache 观测接入 Nexus realtime health；同时为 Code Index Cache、Tool Cache、Reasoning Cache 建立明确的 unavailable 口径，避免伪造命中率。
> 相关：[`context-management-optimization-plan.md`](./context-management-optimization-plan.md), [`behavior-monitor.md`](./behavior-monitor.md), [`go-tui-loop-multipane-plan.md`](./go-tui-loop-multipane-plan.md)

---

## 1. 背景

BabeL-O 已经有一部分 cache 相关 telemetry：

- provider usage delta 暴露 `cacheCreationInputTokens` / `cacheReadInputTokens`；
- `execution_metrics` 事件保存 `cacheReadRatio`；
- `NexusMetrics` 在 `/v1/runtime/metrics` 和 `/v1/runtime/status` 汇总 token/cache 数据；
- prefix cache diagnostics 暴露 immutable prefix ratio、fingerprint、volatile-content-last；
- cache-aware compact policy 会读取 cache reuse 指标来调整 compact 策略。

这些能力足以观测 **Prompt Cache** 的一部分真实效果，但还没有形成统一的 cache health 协议，也没有和 Nexus realtime detection / `bbl loop` health 结合。

用户提出的目标值：

| 维度 | 目标命中率 |
| --- | ---: |
| Prompt Cache | 85% |
| Code Index Cache | 90% |
| Tool Cache | 50% |
| Reasoning Cache | 10% |

当前源码核对结论：

| 维度 | 当前可评估性 | 说明 |
| --- | --- | --- |
| Prompt Cache | 可部分评估 | provider 返回 cache read/create tokens 时，可计算 `cacheReadRatio`。 |
| Code Index Cache | 不可评估 | 尚无 code index cache 子系统或 hit/miss 事件。 |
| Tool Cache | 不可评估 | 有 tool call count / duration，但无 tool result cache hit/miss。 |
| Reasoning Cache | 不可评估 | 有 reasoning token / replay 相关观测，但无 reasoning cache hit/miss。 |

本规划目标不是立即补齐所有 cache 类型，而是先建立**诚实的观测协议**：能算的算，不能算的标 `unavailable`，并把低于目标的真实指标接入 Nexus 实时健康视图。

---

## 2. 设计原则

### 2.1 Runtime/Nexus owns truth

Cache hit rate 是 runtime/provider/storage 事实，不能由 Go TUI、CLI 或模型叙事自行推导。

- Runtime 负责产出 per-turn `execution_metrics`。
- Storage 负责持久化可复盘指标。
- Nexus 负责滚动窗口聚合、阈值评估和 realtime projection。
- Client 只渲染 `cacheHealth` / `signals` / `status`。

### 2.2 不把 unavailable 伪装成 0%

0% 表示“有样本，且确实未命中”；`unavailable` 表示“没有对应观测口径”。

这点对 Code Index / Tool / Reasoning Cache 尤其重要。否则 UI 上的 0% 会误导用户以为系统实现了这些 cache，只是表现很差。

### 2.3 Prompt Cache 分清两类指标

| 指标 | 含义 | 是否等同 hit rate |
| --- | --- | --- |
| `cacheReadRatio` | cached read tokens / total prompt-side tokens | 接近 token-weighted hit rate |
| `prefixCacheImmutableRatio` | system prompt 中稳定 prefix 的字符比例 | 不是命中率，只是可缓存性/稳定性指标 |
| `prefixCacheFingerprint` | cacheable prefix 的稳定 fingerprint | 不是命中率，用于 drift/debug |

实时评估的 Prompt Cache 主指标使用 `cacheReadRatio`。prefix cache diagnostics 作为解释字段，不参与目标值判定。

### 2.4 低 cache hit 不应覆盖高优先级运行状态

`blocked`、`drift`、`waiting_permission`、scope boundary、timeout/context grounding 仍是 pane health 的更高优先级事实。

Cache health 应先作为 `signals` / `attention` 字段出现；只有在明确设计新的 status priority 后，才允许影响 pane `status`。

---

## 3. 现有接入点

### 3.1 Runtime event

`execution_metrics` 已包含：

- `inputTokens`
- `outputTokens`
- `cacheCreationInputTokens`
- `cacheReadInputTokens`
- `cacheReadRatio`
- `cachePreservationMode`
- `prefixCacheImmutableRatio`
- `prefixCacheVolatileContentLast`
- `prefixCacheFingerprint`

当前事件 schema 位于 `src/shared/events.ts`。

### 3.2 Runtime aggregation

`NexusMetrics.recordTokenUsage()` 和 `NexusMetrics.snapshot()` 已汇总：

```ts
tokenUsage: {
  inputTokens,
  outputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
  cacheReadRatio,
}
```

`contextPolicy.prefixCache` 已汇总：

```ts
prefixCache: {
  immutableRatioAvg,
  sampleCount,
  volatileContentLastRatio,
  latestFingerprint,
}
```

### 3.3 Storage replay

`execution_metrics` 已进入 SQLite / Memory storage，`getExecutionMetrics(sessionId)` 返回 session 最新指标。

这意味着 realtime detection 可以同时支持：

- in-process cumulative view：快速展示当前 Nexus 进程内累计状态；
- session replay view：从最近 session events / metrics 重新聚合；
- pane-local view：`/v1/runtime/loop/health` 针对某个 session 的 recent event slice 派生。

### 3.4 Realtime surfaces

现有可复用 surface：

| Surface | 当前职责 | Cache 接入方式 |
| --- | --- | --- |
| `/v1/runtime/metrics` | 进程级 runtime metrics | 增加 `cacheHealth` 聚合 |
| `/v1/runtime/status` | Go TUI / client 轮询的 runtime 状态 | 增加 `cacheHealth.summary` |
| `/v1/runtime/loop/health` | bbl loop pane health | 每个 pane 增加 `cacheHealth` / `signals` |
| `/v1/sessions/:id/wait` | per-pane event long poll | 可传递未来新增的 `cache_health` event |
| Behavior trace | 跨 session 异常轨迹 | 低命中率达到窗口阈值时可写 trace |

---

## 4. Target Model

### 4.1 CacheHealth schema

建议新增内部类型：

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

### 4.2 Default targets

默认目标值：

```ts
const DEFAULT_CACHE_HEALTH_TARGETS = {
  prompt: 0.85,
  code_index: 0.90,
  tool: 0.50,
  reasoning: 0.10,
}
```

后续可加 env/config override，但 v1 不需要先做配置面。

### 4.3 Prompt Cache evaluation

Prompt Cache 的可观测判断：

```text
provider has cache token samples
  => observedRatio = cacheReadInputTokens /
     (inputTokens + cacheCreationInputTokens + cacheReadInputTokens)

no provider cache token fields but provider/model known not reporting
  => unavailable

has samples and observedRatio < target
  => warning or critical
```

建议阈值：

| 条件 | 状态 |
| --- | --- |
| sampleCount = 0 | `unavailable` |
| observedRatio >= target | `ok` |
| observedRatio >= target * 0.75 | `warning` |
| observedRatio < target * 0.75 | `critical` |

v1 可以先只输出 `ok/warning/unavailable`，避免 noisy critical。

### 4.4 Unavailable dimensions

在没有 hit/miss 事件前：

```text
Code Index Cache => unavailable(reason='code_index_cache_not_implemented')
Tool Cache       => unavailable(reason='tool_result_cache_not_implemented')
Reasoning Cache  => unavailable(reason='reasoning_cache_not_reported')
```

这三个维度必须显示目标值，但不得显示 0%。

---

## 5. Nexus Realtime Detection Integration

### 5.1 Phase A — metrics-only cacheHealth

目标：不新增事件，只在 `/v1/runtime/metrics` 和 `/v1/runtime/status` 中增加 `cacheHealth`。

实现建议：

1. 新增 `src/nexus/cacheHealth.ts`：
   - `buildCacheHealthFromRuntimeMetrics(snapshot)`
   - `buildCacheHealthFromEvents(events, options)`
   - `evaluateCacheDimension(...)`
2. `buildRuntimeMetricsSnapshot()` 调用 cache health builder。
3. `/v1/runtime/status` 自动携带 `metrics.cacheHealth`。
4. 添加 regression：
   - provider cache read ratio 0.90 => prompt ok；
   - provider cache read ratio 0.40 => prompt warning；
   - no cache token samples => prompt unavailable；
   - code/tool/reasoning 三项 unavailable。

验收：

- `GET /v1/runtime/metrics` 能看到四个维度；
- 只有 Prompt Cache 有真实 observed ratio；
- 不改变现有 `tokenUsage` shape。

### 5.2 Phase B — loop health pane projection

目标：让 `bbl loop` 能在每个 pane 上看到 cache health，但不改变 pane 主状态优先级。

实现建议：

1. `/v1/runtime/loop/health` 对每个 session 读取最近事件切片；
2. 从其中的 `execution_metrics` 构造 pane-level `cacheHealth`；
3. pane payload 增加：

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

4. Go TUI 只渲染 attention badge，不本地计算命中率。

验收：

- `blocked/drift/waiting/done` 状态不被 cache warning 覆盖；
- pane 中可见 prompt cache below target；
- unavailable 维度不产生 warning。

### 5.3 Phase C — eventized cache health

目标：在每轮执行结束时可选生成 `cache_health` 事件，供 `/v1/sessions/:id/wait` 和 transcript 使用。

建议新增事件：

```ts
{
  type: 'cache_health',
  sessionId,
  requestId,
  cacheHealth: CacheHealthSnapshot,
}
```

约束：

- 只在 execution_metrics 后生成；
- v1 可只在 status != ok 时生成；
- event schema 必须稳定，避免 client 解析碎片化。

验收：

- per-pane wait 能收到 cache health warning；
- session replay 可以复盘 cache health；
- 不重复发同一 requestId 的相同 warning。

### 5.4 Phase D — Behavior Monitor bridge

目标：当多个 session 在短窗口内都出现 Prompt Cache 低命中时，写入 behavior trace，并可触发 live hint。

新增 detector：

```text
prompt-cache-miss-wave:
  N 个 session 在 rollingWindowMs 内 prompt observedRatio < 目标阈值
```

建议默认：

- minSessions: 3
- window: 5min
- target: 0.85
- hint cooldown: 沿用 BehaviorMonitor 5min

输出：

- `behavior-trace.jsonl` 中 anomaly source='nexus'
- `/v1/runtime/loop/health` 的 pendingHints 可继续复用

注意：

当前 `BehaviorMonitor` 模块存在，但主 app ingestion 接线仍需核实/补齐。Phase D 必须先完成 event ingest wiring，不能只改 detector。

### 5.5 Phase E — future real caches

当后续真实实现这些缓存时，再接入 hit/miss：

| 维度 | 需要的最小事实 |
| --- | --- |
| Code Index Cache | index lookup request、hit/miss、index key、invalidated reason |
| Tool Cache | cacheable tool identity、input hash、hit/miss、ttl、risk-safe invalidation |
| Reasoning Cache | provider-reported reasoning cache tokens 或明确的 internal reasoning reuse event |

没有这些事实前，继续保持 `unavailable`。

---

## 6. UI / TUI Rendering

### 6.1 Runtime status

建议 `/v1/runtime/status` summary：

```text
cache: prompt 78% / target 85%; code_index unavailable; tool unavailable; reasoning unavailable
```

### 6.2 bbl loop sidebar

建议在 pane attention 中显示：

```text
cache: prompt below target
```

不要在主 pane title 上塞太多比例数字；详细比例放 overlay 或 status details。

### 6.3 Transcript event

如果 Phase C 落地，可渲染成：

```text
cache ! prompt 62% < 85%
```

不可观测项不进入 transcript，避免噪音。

---

## 7. Tests

建议测试分层：

| 测试 | 覆盖 |
| --- | --- |
| `test/cache-health.test.ts` | 纯函数：target、ratio、unavailable、summary |
| `test/runtime.test.ts` | `execution_metrics` 后 runtime metrics/status 包含 cacheHealth |
| `test/runtime-loop.test.ts` | loop health pane 携带 cacheHealth，不覆盖原 status |
| `test/behavior-monitor.test.ts` | Phase D prompt-cache-miss-wave detector |
| Go TUI loop tests | cache attention 渲染，不本地推导 ratio |

---

## 8. Non-goals

- 不在 v1 实现 Code Index Cache / Tool Cache / Reasoning Cache。
- 不把 prefix cache immutable ratio 当成命中率。
- 不让 Go TUI / CLI 计算 cache hit rate。
- 不让低 cache hit 覆盖 permission/scope/timeout 等更高优先级 runtime 状态。
- 不为 unavailable 维度显示 0%。
- 不引入 LLM 来判断 cache health。

---

## 9. Recommended Next Slice

最小可落地切片：

1. 新增 `src/nexus/cacheHealth.ts` 纯函数。
2. `/v1/runtime/metrics` 增加 process-level `cacheHealth`。
3. `/v1/runtime/loop/health` 增加 pane-level `cacheHealth`。
4. 写 TS regression，确认 Prompt Cache 可评估，其余三项 unavailable。
5. Go TUI 只做只读渲染，不改变状态机。

这条路径能最快把 Prompt Cache 的 85% 目标纳入 Nexus 实时检测，同时保持其他三个维度的诚实口径。
