# BabeL-O 上下文管理优化规划

> Status: Phase 0 + Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 + Phase 6A + Phase 6B + Phase 7 已落地 — 基于 BabeL-2 上下文管理机制复盘与 BabeL-O 真实 session `session_661479db-6327-46f2-a793-7b88e0431174` 的“模型自报上下文 91%”样本，推进 runtime-owned context facts、Go TUI footer 可见性、模型不得自估 context 百分比约束、microcompact 事实事件、compact boundary 协议化、provider context-limit recoverable retry、post-compact grounding guard、dirty workspace guard、context bucket/top-items/grounding suggestions 可视化、sub-agent context fork provenance 与后续 context foundation 提升。
> Priority: P1 Watch — 不推翻现有 `ContextManager` / `ContextForker` / compact / token estimator / provider recovery；优先把上下文用量、裁剪、compact、恢复和 UI 可见性从“隐式能力”提升为 runtime-owned、event-grounded、可复盘协议。
> Related: [context-and-subagent-upgrade-plan.md](./context-and-subagent-upgrade-plan.md), [task-adaptive-recoverable-timeout-plan.md](./task-adaptive-recoverable-timeout-plan.md), [tool-granularity-and-evidence-governance-plan.md](./tool-granularity-and-evidence-governance-plan.md)

---

## 1. 背景

最近两条真实观察暴露了 BabeL-O 上下文管理的下一层问题：

1. **模型自报 context 百分比不可信**
   - session: `session_661479db-6327-46f2-a793-7b88e0431174`
   - 用户请求：对 `/Users/tangyaoyue/DEV/BABEL/BabeL-2` 与 BabeL-O 的 `AgentLoop`、`Provider Registry`、`Tool 风险分类` 做更深源码级对比。
   - agent 在读取 3 个目录、13 个文件后输出：

     ```text
     已掌握三个核心模块的完整实现细节及跨模块的衔接逻辑。上下文已 91%，停止深读并直接产出对比分析。
     ```

   - 但 session 内没有任何 `context_warning` / `context_blocking` / `context_compact` runtime 事件。
   - usage 事件显示 input tokens 增长为 `8776 -> 22691 -> 42612 -> 53415 -> 63721`。
   - MiniMax M2.7 / M3 在 BabeL-O registry 里声明 `contextWindow=200000`，cache-aware policy 的 large-context ceiling 也不应落到 `~70k`。
   - 因此 `91%` 是模型自我估计或叙事包装，不是 runtime 事实。

2. **BabeL-2 的上下文管理是多层 pipeline，而不是单纯 compact**
   - `/Users/tangyaoyue/DEV/BABEL/BabeL-2` 中，上下文管理横跨：`context.ts`、`query.ts`、`QueryEngine.ts`、`services/compact/*`、`utils/context.ts`、`utils/messages.ts`、`utils/tokens.ts`、`components/TokenWarning.tsx` 等。
   - 核心模式是：

     ```text
     static context cache
       -> compact boundary slice
       -> tool result budget
       -> snip compact
       -> microcompact
       -> context collapse
       -> autocompact
       -> API call
       -> prompt-too-long reactive recovery
       -> compact boundary persistence / resume
       -> TokenWarning / ContextVisualization UI
     ```

BabeL-O 已经有不少上下文能力：`ContextManager`、`contextAssembler`、token estimator、compact boundary、retained segment verification、microcompaction/snipping、provider recovery、`/context` diagnostics、cache-aware compact policy、context ceiling metrics 等。问题不是“没有上下文系统”，而是：**这些能力还没有形成一条足够硬的 runtime-owned context protocol**。

本规划目标是把 BabeL-O 上下文管理提升到更高水准：

- context 百分比必须由 runtime 计算和事件化，不允许模型凭感觉自报；
- compact 不只是摘要，而是可恢复协议；
- tool result 应先微压缩，再 full compact；
- provider prompt-too-long 不应直接 fatal，而应触发 reactive recovery；
- Go TUI / CLI 应能显示 context 状态来源、阈值、当前 token 与后续动作。

---

## 2. BabeL-O 当前问题

### 2.1 模型自报 context 状态缺少事实约束

当前模型可以直接在 assistant 文本中写：

```text
上下文已 91%
```

但这个数字可能没有对应 runtime 事件、没有 `tokenEstimate`、没有 `maxTokens`、没有 `policySource`。这会造成：

- 用户无法判断是否真的接近 context 上限；
- agent 可能用“context 不够”为提前收口找理由；
- 真正 `context_warning` / `context_blocking` 出现时信任度下降；
- TUI transcript 混淆了“runtime 事实”和“模型主观判断”。

### 2.2 上下文事件与 UI 仍不够强绑定

BabeL-O 已有 context warning / compact / runtime metrics，但 UI 和模型行为之间的协议还不够硬：

- footer / transcript 未强制区分 runtime-owned context event 与 assistant narration；
- assistant prompt 没有明确禁止自估 context 百分比；
- `/context` diagnostics 与长任务实时状态未完全统一；
- context 使用率、compact 阈值、blocking 阈值、provider context window、effective ceiling、env cap、cache-aware ceiling 等数字对用户仍不够透明。

### 2.3 compact boundary 还应升级为更完整的恢复协议

BabeL-O 已有 compact boundary 和 retained segment，但下一步应进一步明确：

- boundary 是模型请求切片控制点；
- boundary 是 session resume/prune 控制点；
- boundary 是 context diagnostics 的事实锚点；
- boundary 应记录 pre/post token、trigger、preserved tail event、summary event、dropped item reason；
- boundary 之前的消息如何在 transcript 中保留、如何在 provider prompt 中剔除，应可解释。

### 2.4 tool result 膨胀仍应优先用 microcompact 解决

真实源码分析 session 经常读取大量文件、grep 输出、测试输出。仅靠 full compact 会把“可机械压缩的旧工具结果”交给模型总结，成本高且不稳定。

应优先处理：

- 旧 `Read` / `Grep` / `ListDir` / `Bash` 输出；
- 大型 test output；
- 重复读取同一文件的过期片段；
- 工具结果正文与工具元数据分离：保留 tool name/input/success/summary/hash/path/range，替换大块 output。

### 2.5 provider prompt-too-long 需要 reactive recovery

当前目标不应只是“提前估算别超”。估算一定会漂移，provider 也可能因真实 tokenizer、图片、工具 schema、cache edits、system prompt 变化而拒绝请求。

因此需要两层：

```text
proactive: context_warning / microcompact / autocompact / blocking
reactive: provider prompt-too-long -> compact/collapse/retry
```

---

## 3. BabeL-2 机制复盘（作为参考，不照搬代码）

> 注意：BabeL-O 不应照搬 BabeL-2 的文件结构、产品复杂度或泄漏源码实现。本节只抽象机制。

### 3.1 静态上下文缓存

BabeL-2 的 `context.ts` 把上下文拆成：

- `systemContext`：git status snapshot、cache breaker 等；
- `userContext`：CLAUDE.md / memory files / current date 等。

两者会话内 memoize，避免每轮重复 I/O。

BabeL-O 对应已有：

- `systemPromptBuilder`；
- project memory / AGENTS.md；
- git context；
- user intent guidance。

可借鉴点：静态上下文要明确分层、缓存、可诊断，并标注 cacheable / volatile。

### 3.2 模型调用前的上下文处理 pipeline

BabeL-2 `query.ts` 在 API call 前按固定顺序处理：

```text
getMessagesAfterCompactBoundary
  -> applyToolResultBudget
  -> snipCompactIfNeeded
  -> microcompact
  -> contextCollapse.applyCollapsesIfNeeded
  -> autocompact
  -> callModel
```

可借鉴点：BabeL-O 应把现有上下文能力整理成明确 pipeline，而不是让各模块分散触发。

### 3.3 token/window 阈值是 runtime 计算

BabeL-2 使用：

- 默认 `MODEL_CONTEXT_WINDOW_DEFAULT = 200000`；
- 1M model / beta / capability / env override；
- `effectiveContextWindow = contextWindow - reserved output tokens`；
- autocompact threshold = effective window - buffer；
- warning / error / blocking 都来自 runtime 计算。

可借鉴点：BabeL-O 的 `percentUsed`、`effectiveContextCeiling`、`policySource`、`warningThresholdTokens`、`compactThresholdTokens`、`blockingLimitTokens` 必须成为唯一事实源。

### 3.4 microcompact 先清旧工具结果

BabeL-2 的 microcompact 只处理部分工具结果，把旧正文替换成占位符，同时保留工具调用结构。

可借鉴点：BabeL-O 应先裁掉机械膨胀内容，再让 LLM 做语义 compact。

### 3.5 compact boundary 是 transcript/resume 协议

BabeL-2 compact 成功后会写 boundary，后续请求只取 boundary 后消息；QueryEngine 在写 boundary 前 flush preserved tail，避免 resume 时找不到 pre-compact tail。

可借鉴点：BabeL-O 的 SQLite event log 天然适合把 compact boundary 升级为强事件协议。

### 3.6 reactive compact 处理 provider 拒绝

BabeL-2 不只 proactive compact，还在 API prompt-too-long / media too large 后尝试 recovery compact + retry。

可借鉴点：BabeL-O provider adapter / runtime pipeline 应把 context-limit provider error 转成 recoverable context recovery path。

### 3.7 UI 负责 context 状态，不让模型自报

BabeL-2 有 `TokenWarning` / `ContextVisualization` / `ContextSuggestions`。context 状态由 runtime/UI 显示，而不是 assistant 随口说。

可借鉴点：Go TUI footer、transcript、`/context`、runtime events 应统一呈现 context 状态。

---

## 4. 目标原则

1. **Runtime owns context truth.**
   - 上下文百分比、token estimate、context ceiling、compact threshold、blocking limit 必须来自 runtime event/diagnostics。
   - Assistant 不得自估百分比；如果引用，必须引用最近 runtime event。

2. **Context pipeline must be staged and observable.**
   - 每次 provider call 前，ContextManager 应能解释：收集了什么、压缩了什么、丢弃了什么、为什么。

3. **Microcompact before semantic compact.**
   - 先处理大工具输出、重复工具结果、过期文件片段，再调用 LLM 做语义摘要。

4. **Compact boundary is a protocol, not a comment.**
   - boundary 应参与 prompt slicing、resume、diagnostics、UI、regression。

5. **Provider context errors are recoverable when possible.**
   - prompt-too-long 应触发 compact/collapse/retry，而不是直接 fatal。

6. **UI separates facts from narration.**
   - footer/status/diagnostics 展示 runtime facts；assistant 文本只负责解释/行动建议。

7. **No legacy complexity import by default.**
   - 不复制 BabeL-2 的全部 context collapse / snip / cached microcompact 复杂实现；只按 BabeL-O 当前真实 drift 渐进落地。

---

## 5. 目标架构

```text
Nexus Runtime
  └─ ContextManager
      ├─ CollectSources
      │   ├─ system prompt sections
      │   ├─ project memory / AGENTS.md
      │   ├─ git/workspace context
      │   ├─ session events
      │   ├─ tool traces
      │   ├─ compact summaries
      │   ├─ child/session channel context
      │   └─ long-term memory hints
      │
      ├─ BuildContextItems
      │   └─ { id, kind, source, text, cacheable, volatile, estimatedTokens, priority, metadata }
      │
      ├─ ApplyMechanicalReduction
      │   ├─ tool result budget
      │   ├─ stale Read/Grep/Bash output replacement
      │   ├─ duplicate file segment suppression
      │   └─ attachment / large blob placeholder
      │
      ├─ SelectWithinBudget
      │   ├─ effectiveContextCeiling
      │   ├─ reservedOutputTokens
      │   ├─ providerSafetyBufferTokens
      │   ├─ warning / compact / blocking thresholds
      │   └─ droppedReason diagnostics
      │
      ├─ CompactOrRecover
      │   ├─ microcompact
      │   ├─ semantic compact
      │   ├─ compact boundary event
      │   └─ provider context-limit recovery retry
      │
      ├─ RenderForProvider
      │   ├─ cacheable stable prefix
      │   ├─ volatile suffix
      │   ├─ user/runtime messages
      │   └─ tool schemas
      │
      └─ EmitContextEvents
          ├─ context_usage
          ├─ context_warning
          ├─ context_microcompact
          ├─ context_compact_boundary
          ├─ context_blocking
          └─ context_recovery_attempted
```

---

## 6. 事件与协议建议

### 6.1 `context_usage`（新增或增强）

每次 provider call 前或 usage 更新时 emit，用作唯一事实源。

```ts
context_usage {
  type: 'context_usage'
  requestId?: string
  modelId: string
  providerId: string
  tokenEstimate: number
  maxTokens: number
  percentUsed: number
  effectiveContextCeiling: number
  modelContextWindow: number
  reservedOutputTokens: number
  providerSafetyBufferTokens: number
  policySource: 'legacy' | 'large_context' | 'env_cap' | 'provider_error_conservative'
  warningThresholdTokens: number
  compactThresholdTokens: number
  blockingLimitTokens: number
  cachePreservationMode?: boolean
  longContextUtilizationMode?: boolean
  source: 'pre_provider_call' | 'post_usage' | 'after_compact' | 'after_microcompact'
}
```

要求：

- Go TUI footer 只使用该事件或现有 runtime metrics 派生值；
- assistant prompt 明确：不能自估 context 百分比，只能引用最近 `context_usage` / `context_warning`。

### 6.2 `context_microcompact`

记录机械压缩动作。

```ts
context_microcompact {
  type: 'context_microcompact'
  trigger: 'pre_provider_call' | 'tool_result_budget' | 'manual' | 'reactive_recovery'
  preTokens: number
  postTokens: number
  tokensSaved: number
  compactedItems: Array<{
    itemId: string
    kind: 'tool_result' | 'file_segment' | 'attachment' | 'duplicate_read'
    source: string
    replacement: 'placeholder' | 'summary' | 'hash_only'
  }>
}
```

### 6.3 `context_compact_boundary`

把 compact boundary 升级为强事件。

```ts
context_compact_boundary {
  type: 'context_compact_boundary'
  boundaryId: string
  trigger: 'manual' | 'auto' | 'reactive_provider_limit' | 'session_resume' | 'child_context_fork'
  preTokens: number
  postTokens: number
  messagesSummarized: number
  preservedTailEventId?: string
  summaryEventId?: string
  droppedItemCount: number
  retainedItemCount: number
  droppedReasons?: Record<string, number>
  userVisibleSummary?: string
}
```

### 6.4 `context_recovery_attempted`

Provider prompt-too-long 后尝试恢复。

```ts
context_recovery_attempted {
  type: 'context_recovery_attempted'
  requestId?: string
  providerErrorCode: string
  strategy: 'microcompact_retry' | 'semantic_compact_retry' | 'reduce_tool_schema_retry' | 'fallback_model_retry'
  attempt: number
  maxAttempts: number
  preTokens: number
  postTokens?: number
  retryable: boolean
  message: string
}
```

---

## 7. 模型行为约束

在 system prompt / runtime guidance 中增加明确约束：

```text
Context usage numbers are runtime facts. Do not estimate or invent context percentages.
Only mention context percentage, token estimate, max tokens, warning threshold, compact threshold,
or blocking state when a recent runtime context_usage/context_warning/context_blocking event provides it.
If no such event exists, say "上下文状态未由 runtime 报告" instead of guessing.
```

中文口径：

```text
上下文百分比是 runtime 事实，不是模型主观估算。除非最近事件中明确提供 percentUsed/tokenEstimate/maxTokens，
否则不要写“上下文已 X%”。如果需要解释停止深读，应说明证据已足够、时间/任务范围需要收口，而不是伪造 context 数字。
```

对 `session_661479db...` 这类场景，理想输出应是：

```text
已读 AgentLoop / Provider Registry / Tool 风险分类的关键文件，证据已足够支撑第一版源码级对比。
我先产出结构化分析；如需继续，可以再深入 compact/recovery 或 provider adapter 细节。
```

而不是：

```text
上下文已 91%，停止深读。
```

---

## 8. 分阶段路线

### Phase 0：真实样本回归与诊断口径

状态：已落地（2026-06-12）。

目标：固化 `session_661479db-6327-46f2-a793-7b88e0431174` 的问题形状。

落地点：

- 新增 `src/runtime/contextNarrationDiagnostics.ts`：提供 `findUngroundedAssistantContextPercentages()` 纯函数，扫描 assistant text 中 `上下文已 \d+%` / `context ... \d+%` 这类 context 百分比自报。
- `test/context-regression.test.ts` 新增两个 regression：
  - synthetic `session_661479db-6327-46f2-a793-7b88e0431174` 形状：usage token 约 63k、无 `context_warning` / `context_blocking` runtime event、assistant 文本出现 `上下文已 91%`，诊断为 `MODEL_CONTEXT_PERCENT_UNGROUNDED`。
  - 若最近 runtime `context_warning` 明确报告 `percentUsed=91`，assistant 引用 91% 不报错。

收口标准：

- 测试能区分 runtime context warning 与 assistant 自报。
- 不禁止模型谈“证据足够所以收口”，只禁止伪造 context 百分比。

### Phase 1：Runtime-owned `context_usage` 事件与 Go TUI footer 对齐

状态：已落地（2026-06-12）。

目标：让 context 使用率有唯一事实源。

落地点：

- `src/shared/events.ts` 新增 `ContextUsageEventSchema` 并纳入 `NexusEventSchema`：事件携带 `requestId`、`providerId`、`modelId`、`tokenEstimate`、`maxTokens`、`percentUsed`、warning/compact/blocking thresholds、context policy fields、cache/long-context mode 与 `source`。
- `src/runtime/runtimePipeline.ts` 新增 `buildContextUsageEvent()`，复用 `ContextWindowState` + `CacheAwareCompactPolicy` 生成 runtime-owned context facts。
- `src/runtime/LLMCodingRuntime.ts` 在初始 context refresh、provider loop pre-call、compact 后 refresh 处 emit `context_usage`，让 UI/模型有事实事件可引用。
- `src/cli/renderEvents.ts` 将 `context_usage` 作为状态事实更新 footer context bar；expanded transcript 可渲染 `context usage: X%`。
- `clients/go-tui/internal/tui/tui.go` 新增 `contextUsageSnapshot`，消费 `context_usage` 更新 footer：`ctx 36% 64000/180000 warn=126000 compact=162000`；同时 `formatNexusEvent()` 支持 context_usage 测试渲染。
- `/context` 命令已经使用 runtime context diagnostics / cache economics；本 Phase 先让 streaming footer 与 provider-call runtime facts 对齐，后续 Phase 6 再做 overlay bucket/top items/suggestions 增强。

收口标准：

- 模型不再需要自己估 context；UI 可直接看到 runtime 数字。
- context window / effective ceiling / env cap / provider safety buffer 的差异可诊断。

### Phase 2：System prompt 约束模型不得自估 context 百分比

状态：已落地（2026-06-12）。

目标：切断 `上下文已 91%` 这类 ungrounded narration。

落地点：

- `src/runtime/systemPromptBuilder.ts` 新增 cacheable `context_facts` section，明确：
  - context usage numbers are runtime facts；
  - 不得 estimate / invent / narrate context percentages；
  - 只有最近 runtime `context_usage` / `context_warning` / `context_blocking` 事件提供数字时，才能提及 context 百分比、token estimate、max tokens、warning/compact/blocking threshold；
  - 没有 runtime event 时，不要写 `context is X% used` 或 `上下文已 X%`，应说明真实收口理由（证据已足够、先综合当前发现等）。
- `test/system-prompt-builder.test.ts` 更新静态 section 数量与顺序，并新增 `context_facts prohibits ungrounded context percentages` regression。
- Phase 0 的 `src/runtime/contextNarrationDiagnostics.ts` / `test/context-regression.test.ts` 继续作为 post-hoc diagnostic 守门：synthetic session 中模型自报百分比会被诊断，runtime-grounded 引用不误报。

收口标准：

- focused prompt test 锁定规则存在。
- synthetic session 中模型自报百分比被 diagnostic 捕获。

### Phase 3：Microcompact / Tool Result Budget 升级

状态：已落地（2026-06-12）。

目标：把机械膨胀内容先裁掉，减少 full compact 压力。

落地点：

- 复用既有 `src/runtime/compactors/microCompact.ts` / `contextAssembler` 的 provider-facing microcompact 机制：旧 `tool_completed` 大输出或重复工具结果会在上下文组装阶段被替换，但 SQLite 原始 tool trace / event log 仍保留事实来源。
- `src/shared/events.ts` 新增 `ContextMicrocompactEventSchema` 并纳入 `NexusEventSchema`：事件携带 `trigger`、`compactedEventCount`、`deduplicatedToolResultCount`、`bytesBefore`、`bytesAfter`、`bytesSaved`、`estimatedTokensSaved` 与 message。
- `src/runtime/runtimePipeline.ts` 新增 `buildContextMicrocompactEvent()`：从 `MicrocompactMetrics` 生成 runtime-owned microcompact fact；空压缩时返回 `undefined`，避免噪音事件。
- `src/runtime/LLMCodingRuntime.ts` 在 initial context refresh 与 compact 后 refresh 处，当 `assembledContext.microcompactMetrics` 显示确有节省时 emit `context_microcompact`。
- `src/cli/renderEvents.ts` 与 `clients/go-tui/internal/tui/tui.go` 增加 context_microcompact 渲染：展示 saved tokens、compacted event count、deduplicated count。
- `test/runtime.test.ts` 补 builder regression；Go TUI `tui_test.go` 补 `formatNexusEvent(context_microcompact)` regression。

收口标准：

- 大量 Read/Grep/Bash 历史不会把 provider prompt 推到 compact threshold。
- `/context` 既有 diagnostics 已能看到 microcompact savings；streaming transcript/Go TUI 现在也能看到 `context_microcompact` 事实事件。

### Phase 4：Compact Boundary 事件协议

状态：已落地（2026-06-12）。

目标：让 compact boundary 成为 SQLite event log 中的恢复锚点。

落地点：

- `src/shared/events.ts` 标准化 `context_compact_boundary` event，并把 `compact_boundary` 补充为可携带 `preTokens` / `postTokens` / `estimatedTokensSaved` 的协议锚点。
- `src/runtime/compact.ts` 在 compact 成功时同时构建并持久化 `compact_boundary` 与 runtime-owned `context_compact_boundary`，记录 trigger、pre/post token estimate、summary chars、snipped tool result、messages/dropped/retained counts、retained segment hash、preserved tail event、user-visible summary。
- `src/runtime/LLMCodingRuntime.ts` 在 auto compact 与 provider-loop reactive compact 路径同时 yield `compact_boundary` 与 `context_compact_boundary`，让 streaming UI 和后续 context refresh 都能看到同一恢复锚点。
- Context assembly 继续从最后 `compact_boundary` 的 retained segment + boundary 后事件重建 provider-facing context；新增 `context_compact_boundary` 作为事实/诊断事件，不替代原始 `compact_boundary`，保持向后兼容。
- `/v1/sessions/:sessionId/compact` 返回 `contextEvent`；`src/cli/renderEvents.ts`、Go TUI `formatNexusEvent()` / transcript consumption 渲染 `context_compact_boundary`。
- `bbl inspect-session` 读取 SQLite event_json 并展示 compact boundary protocol details：pre/post tokens、saved tokens、retained/tail/summary 等恢复锚点。
- `test/runtime.test.ts`、`test/inspect-session.test.ts`、`clients/go-tui/internal/tui/tui_test.go` 覆盖 builder/API persistence/inspect/Go TUI formatting。

收口标准：

- compact 后 resume 不加载完整 pre-compact prompt。
- boundary 可复盘、可解释、可测试。

### Phase 5：Provider context-limit Reactive Recovery

状态：已落地（2026-06-12）。

目标：provider prompt-too-long 不直接 fatal。

落地点：

- `src/shared/events.ts` 新增 `context_recovery_attempted` runtime fact event：记录 provider error code、strategy、attempt/maxAttempts、pre/post tokens、retryable 与 message。
- `src/runtime/providerRecovery.ts` 扩展 context-limit 分类：OpenAI/Anthropic 既有 `context_length_exceeded` / `prompt_too_long` 外，覆盖 MiniMax/DeepSeek/Zhipu 常见 `context_length`、`context too long`、`tokens exceed context size limit`、`code=1301` 等文案。
- `src/runtime/runtimePipeline.ts` 新增 `buildContextRecoveryAttemptedEvent()`；`buildRuntimeContextBlockingEventsForLoop()` 支持自定义终态 message，恢复耗尽时能说明已尝试策略和剩余动作。
- `src/runtime/LLMCodingRuntime.ts` 在 provider invocation catch 中识别 `ProviderRecoveryDetails.kind === 'context_window'` 后进入一次有界 reactive recovery：

  ```text
  provider context error
    -> context_recovery_attempted(strategy=semantic_compact_retry)
    -> compactSession(trigger=reactive)
    -> context_compact_boundary
    -> refresh context + context_usage(after_compact)
    -> retry provider call
    -> final context_blocking if provider still rejects
  ```

- `src/cli/renderEvents.ts` 和 Go TUI `formatNexusEvent()` / transcript consumption 渲染 `context_recovery_attempted`，让操作员能看到 provider 拒绝后的恢复动作。
- `test/provider-recovery.test.ts` 补 provider-specific context-limit classifier regression；`test/runtime.test.ts` 补 synthetic provider prompt-too-long 成功恢复和恢复耗尽后 `context_blocking` 两条 runtime 回归；Go TUI 补 recovery event formatter regression。

收口标准：

- prompt-too-long synthetic provider error 能触发 compact/retry。
- recovery 失败时 error message 说明已尝试的策略和剩余动作。

### Phase 6：Post-Compact Grounding + Context Visualization / Suggestions 升级

目标：让操作员能理解上下文压力来源，并避免 compact 后模型直接从摘要下事实结论。

本轮新增设计约束：compact summary 只能作为“索引/恢复线索”，不能作为代码事实、测试状态或工作区状态的最终证据。compact 后如果要对真实文件、实现状态、测试结果、git diff 或任务完成度下结论，runtime/assistant 必须先重新确认对应事实来源；如果工作区存在 dirty changes，应优先查看变动范围再继续推理。

#### Phase 6A：Post-Compact Grounding Guard

状态：已落地（2026-06-12）。

落地点：

- compact / context recovery 后写入 `context_grounding_required`，标记当前 session 存在 `summary-derived` 风险状态，直到相关事实被重新 grounding。
- compact 后若 assembled git context 显示 dirty workspace，写入 `workspace_dirty_detected`，暴露 changed file count / changed files / inspect status-diff 建议。
- runtime 工具循环在成功的事实来源工具后写入 `context_grounding_confirmed`：
  - `Read` -> `file_read`，确认 `file_facts` / `implementation_status`；
  - `Grep` / `Glob` / `ListDir` / source-search Bash -> `search_result`；
  - `Bash git status` -> `git_status`，确认 `git_status` / `implementation_status` 并关闭 dirty workspace guard；
  - `Bash git diff` -> `git_diff`；
  - `Bash` test commands -> `test_output`；
  - agent/event inspection -> `event_log`。
- `LLMCodingRuntime` 在每次 compact/context recovery 后清空 `Read` cache，避免 grounding confirmation 由“File unchanged since last read”旧缓存 stub 触发；post-compact 文件事实确认必须来自真实工具读取结果。
- `mapEventsToMessages()` 会把 required / confirmed / dirty guard 映射回 provider-visible runtime guidance，下一轮模型能同时看到“需要确认”和“已确认”的闭环事实。
- `analyzeContext` 的 visualization grounding 状态机读取 `context_grounding_confirmed`：最近 required 后有确认则从 `summary-derived` 回到 `source-confirmed`；dirty guard 只有在最近 `git_status` confirmation 后关闭。
- `sessionSummary` 忽略 grounding/dirty/confirmed 事件，避免 runtime guard 反过来污染 compact summary。
- CLI 与 Go TUI transcript 渲染 `context_grounding_required` / `context_grounding_confirmed` / `workspace_dirty_detected`，让 UI 和日志区分“摘要线索”“已重新确认事实”和“工作区仍需查看”。
- system prompt / runtime guidance 明确：compact summary 不得被表述为源码事实；需要事实结论时先读取真实文件、diff、测试输出或 event log。

收口标准：

- compact 后 agent 不会仅凭 summary 断言“文件 X 已实现 Y / 测试已通过 / 工作区无变动”。
- dirty workspace 存在时，继续总结或推进前能先暴露变动范围，并由 git status/diff confirmation 显式关闭。
- grounding guard 不强制全量重读，只要求对即将使用的事实做最小必要确认；确认必须来自真实工具结果而非旧缓存。

#### Phase 6B：Context Visualization / Suggestions

状态：已落地（2026-06-12）。

落地点：

- `/v1/sessions/:sessionId/context` 的 `diagnostics.visualization` 输出结构化 context 可视化数据：
  - `buckets`：按 kind 分桶估算 token：system/memory/git/events/tool_results/compact_summary/session_channel/skills；
  - `topItems`：展示 top N 最大 context items 与来源；
  - `nextThreshold`：展示下一个 warning/compact/blocking 阈值、剩余 token 和百分比；
  - `grounding`：展示 source-confirmed / summary-derived / dirty-workspace 状态、变动文件数与建议动作；
  - `suggestions`：给出 continue / compact / narrow scope / split task / inspect largest items / inspect changed files / re-read referenced files 等操作建议。
- Go TUI `/context` overlay 消费这些稳定字段并展示 token buckets、top context items、next threshold、grounding state 和 context suggestions。
- 顶层 `diagnostic.signals` / `recommendations` 同步 grounding_required / workspace_dirty 信号，避免 overlay 与 summary 行给出不一致建议。

收口标准：

- 用户看到的不只是百分比，而是“为什么高、该怎么降、哪些结论还需要重新确认”。
- focused regression 覆盖 `analyzeContext` 的 visualization 字段和 Go TUI overlay 渲染。

### Phase 7：Context-aware agent/sub-agent fork 强化

状态：已落地（2026-06-12）。

目标：让 AgentScheduler / child sessions 使用同一 context foundation。

落地点：

- `ContextForker` 输出 context budget diagnostics：
  - `inheritedItems` / `excludedItems`：可审计继承与排除项；
  - `parentSummary`：parent session、event count、latest user、compact summaries、child agent results、failures、tool traces；
  - `toolTraceReferences`：只保留 tool_use_id/name/timestamp/success/input/output preview，不继承大 tool output body；
  - `childWorkingSet`：child-specific working set path/source/touches/isDir；
  - `provenance`：把 fork mode、included/omitted、working set、parent summary、tool trace refs 组合成可回传结构。
- `ExploreAgentScheduler` 将 fork diagnostics 写入 child session metadata，并在 child `AgentResult.contextProvenance` 回传相同 context provenance。
- parent 侧 `agent_job_event.result` 和 parent-child channel message metadata 可以看到 child 使用了哪些 context 来源。
- Explore/Review/Test agents 仍按 fork mode 获取最小必要 prompt，不继承无关长 transcript；metadata/provenance 负责审计，不把 raw parent transcript 塞给 child。

收口标准：

- 子 agent 不因 parent transcript 膨胀提前 compact。
- parent 能看到 child 使用了哪些 context 来源。
- focused regression 覆盖 ContextForker diagnostics 与 Scheduler result provenance。

---

## 9. 验证与回归建议

### Unit tests

- `context_usage` percent 计算：
  - provider 200k；effective ceiling 180k；token 63k -> 不应显示 91%。
- env cap：`BABEL_O_MAX_CONTEXT_TOKENS` / 未来等价 env 能正确改变 ceiling。
- system prompt 包含“不得自估 context 百分比”规则。
- assistant 文本百分比 diagnostic：有/无 runtime event 两种路径。

### Runtime tests

- provider call 前 emit `context_usage`。
- 大 tool result 触发 `context_microcompact`，provider-facing prompt 缩小，SQLite tool trace 原文仍保留。
- compact 成功写 `context_compact_boundary`，后续 assembly 只取 boundary 后内容 + summary。
- synthetic provider prompt-too-long 触发 `context_recovery_attempted` + retry。
- compact / resume 后如果 assistant 要输出文件事实、测试事实或任务完成事实，应触发 grounding required/confirmed 路径，不能只依赖 compact summary。
- dirty workspace 存在时，继续总结当前实现状态前应先暴露 git status / changed files。

### Go TUI tests

- footer 展示 runtime context usage。
- 无 runtime event 时不显示模型自报百分比为事实。
- `/context` overlay 展示 bucket / top items / thresholds / suggestions。
- `/context` overlay 展示 grounding state，并在 dirty workspace / summary-derived 状态下给出 inspect changed files / re-read referenced files 建议。

### Real-session acceptance

- 重放 `session_661479db...` 类源码深读任务：
  - agent 不再说 ungrounded `上下文已 91%`；
  - 若 context 状态需要呈现，由 Go TUI footer 或 `context_usage` transcript 行提供；
  - 深读停止理由改为“证据足够/范围收口/建议下一轮深入”，而不是伪造百分比。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| context events 太多污染 transcript | 中 | context_usage 默认 footer/status 消费，可按阈值或 debug 模式进入 transcript |
| microcompact 替换掉模型后续需要的细节 | 高 | 原始 tool trace 仍在 SQLite；replacement 保留 path/range/hash，可由模型显式 Read 重新取 |
| compact boundary 错误导致 resume 丢上下文 | 高 | boundary 前 flush preserved tail；加 resume regression；保留 pre-compact transcript 只是不进 provider prompt |
| provider context-limit recovery 无限重试 | 高 | maxAttempts + strategy progression + final context_blocking |
| compact 后从 summary 直接下源码/测试结论 | 高 | post-compact grounding guard：summary 只作索引；结论前重读相关文件、diff、测试输出或 event log |
| 每次 compact 后自动全量重读导致 context 反复膨胀 | 中 | 按结论/风险触发最小必要 grounding，不做自动全量 reread |
| 百分比口径过多 | 中 | `context_usage` 成为唯一事实源；UI 和 `/context` 只消费同一结构 |
| 复制 BabeL-2 复杂度 | 中 | 每 phase 只落 BabeL-O 已有能力附近的最小增量，不迁入未需要的 ant-only feature |

---

## 11. 非目标

- 不照搬 BabeL-2 代码、文件结构或产品复杂度。
- 不把 context collapse / cached microcompact / snip compact 一次性全量实现。
- 不把 Go TUI 变成 context owner；Go TUI 只展示 Nexus/runtime 的事实。
- 不让模型自行决定 context ceiling 或 compact threshold。
- 不让 compact 自动丢失 SQLite 原始 tool trace。
- 不把长期记忆/EverCore 当成 session transcript 或 compact boundary 的事实源。
- 不把模型自动选择/role defaults 纳入本规划。

---

## 12. 推荐结论

BabeL-O 下一阶段上下文管理提升不应只是“把 context window 调大”或“更频繁 compact”。真正要提升的是上下文协议质量：

1. **context 百分比 runtime-owned**：杜绝 `上下文已 91%` 这类无事实来源的模型自报。
2. **microcompact-first**：先压机械膨胀的 tool result，再做语义 compact。
3. **compact boundary protocol**：compact 成为可恢复、可复盘、可测试的 event log 协议。
4. **reactive recovery**：provider context-limit 错误先尝试 compact/retry，再失败。
5. **UI facts vs model narration 分离**：Go TUI/CLI 显示事实，assistant 只解释和建议行动。

若按 Phase 0~7 推进，BabeL-O 的上下文管理会从“已有很多能力”升级为“runtime 可证明、UI 可解释、模型不可伪造、失败可恢复”的成熟上下文系统。
