# Task-adaptive Recoverable Timeout 规划

> Status: Phase 0 + Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 + Phase 6 已落地 — 收口（真实样本回归 + 协议拆分 + runtime 可恢复 `timeout_budget_exceeded` 事件 + 自动 extension cycle + Go TUI 软超时状态可见化 / 看门狗友好消息 + hard watchdog `details.kind='watchdog'` 标记与清理回归 + DONE/跨文档同步）
> Priority: Watch / Closed — DONE 索引见 [DONE.md](../DONE.md) "Task-adaptive Recoverable Timeout 已落地" 行；旧 [go-tui-tool-permission-timeout-optimization-plan.md](../archive/go-tui-tool-permission-timeout-optimization-plan.md) 已加 "降噪 vs fatal timeout 语义" 范围拆分提示
> 真实样本: `session_791b10ce-0d41-409d-b2de-1e5d14eb19b3`（2026-06-11；用户请求“查看当前项目分析潜在的bug”；41 tools，最后一个 Bash 未完成；顶层 180s timeout 终止 workflow）

---

## 1. 背景

最新真实 session 复盘结果：

| 指标 | 结果 |
|---|---:|
| session id | `session_791b10ce-0d41-409d-b2de-1e5d14eb19b3` |
| cwd | `/Users/tangyaoyue/DEV/BABEL/BabeL-O` |
| user prompt | `查看当前项目分析潜在的bug` |
| event count | 276 |
| tool calls | 41 |
| tool_completed | 40 |
| permission_request / response | 16 / 16 |
| error | `REQUEST_TIMEOUT` / `Execution timed out while running Bash.` |
| execute summary | `timeoutMs=180000`, `executeDurationMs=180002`, `nearTimeout=true`, `outcome=timeout` |

最后未完成工具：

```text
Bash: awk 'NR>=1 && NR<=200' src/shared/events.ts | grep -n "z.object\|z.literal\|export const" | head -40
input timeoutMs: 5000
started_at: 2026-06-11T14:28:55.520Z
completed_at: null
```

这个失败不是 provider 500、不是权限拒绝、也不是工具本身已经耗尽 5s。真正问题是：Nexus 顶层 `/v1/execute` request 在第 180 秒触发 fixed cutoff，导致仍在推进的 workflow 被直接 abort，最后一个刚获批的 Bash 没机会返回 recoverable `tool_completed(false)`。

同类问题在此前 `go-tui-tool-permission-timeout-optimization-plan.md` 已出现过一次：`session_dcf7e34e-bc59-41e4-b802-e4d03d32b48d` 中 19 tools 全成功、10 次 Bash approval 全 approved，最终仍因 180s request timeout 标 failed。旧规划已经收口了“工具选择 / Bash read-only classifier / approval 降噪 / near timeout warning”等局部优化；本规划解决更底层的产品语义：**普通 timeout 不应该是杀死整个 workflow 的控制流**。

---

## 2. 当前实现与问题

### 2.1 当前顶层 timeout 是 hard request abort

`src/nexus/app.ts:1001-1004`：

```ts
const abortController = new AbortController()
const timeoutController = new AbortController()
const timeout = setTimeout(() => { timeoutController.abort(); abortController.abort() }, body.timeoutMs ?? executeTimeoutMs)
```

`abortController.signal` 和 `timeoutController.signal` 被传入 `runtime.executeStream()`：

```ts
signal: abortController.signal,
timeoutSignal: timeoutController.signal,
```

这意味着 `body.timeoutMs` 不只是“模型当前任务的建议预算”，而是整个 runtime provider/tool loop 的硬中断。

### 2.2 事件层已经有 near-timeout，但只能警告，不能恢复

`src/shared/events.ts:145-164` 已有：

- `execute_summary`：记录 `timeoutMs`、`executeDurationMs`、`nearTimeout`、`outcome`
- `near_timeout_warning`：记录 `timeoutMs`、`elapsedMs`、`thresholdRatio`、`partialSummary`

`src/nexus/app.ts:1089-1127` 已有 near-timeout watcher：到 `EXECUTE_TIMEOUT_NEAR_RATIO` 时，如果有 partial evidence，会 append `near_timeout_warning`。

问题：warning 之后仍然由顶层 `setTimeout` abort 整个 flow；模型不能看到 warning 后自主决定“收口 / 请求延长 / 缩小范围 / 继续”。

### 2.3 Go TUI 已有 adaptive timeout，但仍是固定 cutoff

`clients/go-tui/internal/tui/tui.go:8462-8484`：

```go
DefaultGoTuiExecuteTimeoutMs     = 180_000
longContextGoTuiExecuteTimeoutMs = 300_000
```

`resolveGoTuiTimeout()` 对长上下文 prompt 或 usage > 100k tokens 会把 timeout 从 180s 提到 300s。这是有价值的，但仍然是“提前选一个固定硬截止点”。

### 2.4 Bash tool timeout 已可恢复，但顶层 request timeout 不可恢复

`src/tools/builtin/bash.ts` 中普通 command timeout / SIGTERM 已按 `COMMAND_TIMEOUT` recoverable failure 返回 `tool_completed(success=false)`。这说明 tool-level timeout 的方向已经正确。

但顶层 request timeout 仍直接把 session 标 failed，并中断 runtime loop。样本 `session_791b10ce...` 正是最后一个 Bash 已启动、permission 已 approve，却被 request timeout 截断。

---

## 3. 设计原则

1. **Timeout 是模型可见事件，不是默认终止控制流。** 普通 deadline 到达时，应产出结构化事件，让模型基于任务状态决定下一步。
2. **预算由模型/客户端按任务形态选择。** 简单问答、小 grep、测试、构建、深度审计、长上下文分析应有不同建议预算；默认值只是 fallback。
3. **系统仍保留 hard watchdog。** Hard watchdog 只用于防止进程泄漏、无限挂起、资源失控、连接消失后无人消费；不是产品层主要 timeout 行为。
4. **部分成果优先保存。** 到达 soft deadline 时，已有 assistant deltas、tool traces、near-timeout summary、partial result 都必须可复盘。
5. **恢复动作显式化。** 可选动作包括：continue with extension、summarize now、retry last tool with larger timeout、narrow scope、cancel。
6. **HTTP 与 WebSocket 语义分开。** HTTP 可以返回阶段性 envelope；WebSocket 应继续流事件。Go TUI 是主要受益方，优先保证 WS workflow 不因普通 timeout 断流。

---

## 4. 目标行为

1. Go TUI 发起长任务时，`timeoutMs` 不再表示“到点 kill runtime”，而是 soft deadline / budget hint。
2. 到达 soft deadline：Nexus append `timeout_budget_exceeded`（或扩展 `near_timeout_warning`）事件，runtime loop继续；模型下一轮可看到该事件并决定是否继续、收口或请求延长。
3. 普通 tool timeout：继续沿用 recoverable `tool_completed(success=false)`；不提升为 session fatal。
4. 顶层 `execute_summary.outcome` 新增或映射出 `soft_timeout_continued` / `watchdog_timeout` 语义，避免所有 timeout 都叫 `REQUEST_TIMEOUT`。
5. Go TUI 展示 soft timeout 为 status / warning 行，不把 input mode 卡死，不关闭 session。
6. Hard watchdog 触发时才产生 fatal `REQUEST_TIMEOUT` / `WATCHDOG_TIMEOUT`，并明确 message：这是系统保护，不是模型预算。

---

## 5. 非目标

- 不无限执行。必须保留 hard watchdog、用户 cancel、server shutdown cleanup、active execution registry cleanup。
- 不让模型绕过用户权限审批。timeout extension 不等价于自动 approve 工具。
- 不把所有 Bash timeout 自动重试；retry 必须由模型选择或用户触发。
- 不把 Go TUI 的 `--execute-timeout-ms` 简单提高到很大作为根治。
- 不在本切片中实现 durable resumable execution / process restart continuation；这属于更大的 resumable execution 规划。
- 不删除现有 `near_timeout_warning`；优先兼容扩展，避免破坏旧客户端。

---

## 6. 分阶段推进

### Phase 0：真实样本与语义回归

状态：已落地（2026-06-12）

落地点：

- 扩展 `test/go-tui-tool-permission-timeout-regression.test.ts`。
- 新增 synthetic fixture 固化 `session_791b10ce-0d41-409d-b2de-1e5d14eb19b3` 的核心形状：
  - 180s 顶层 cutoff 发生时仍有 1 个 tool 未完成。
  - `permission_response` 已批准最后 tool。
  - `execute_summary.outcome=timeout`。
  - session failed，但 assistant 已有多段 partial analysis。
  - 最后一个 Bash 没有返回 recoverable `tool_completed(success=false)`，证明失败来自 request-level fatal cutoff 而非 tool-level timeout。
- 保留原 `session_dcf7e34e-bc59-41e4-b802-e4d03d32b48d` regression，继续守住“工具全成功 + 权限全批准 + request timeout fatal”的旧样本。

验证命令：

```bash
NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/go-tui-tool-permission-timeout-regression.test.ts
```

结果：2/2 pass。

收口标准：当前失败链路已被最小 fixture 表达；后续 Phase 1+ 实现不能再把普通 soft deadline 误判为 fatal session failure。

### Phase 1：协议语义拆分（soft deadline vs hard watchdog）

状态：已落地（2026-06-12）

落地点：

- `src/nexus/app.ts` `executeSchema` 增加 optional `timeoutPolicy: 'fatal' | 'soft'`、`softTimeoutMs`、`watchdogTimeoutMs`。
- 新增 `ExecuteTimeoutDecision` / `resolveExecuteTimeoutDecision()`：旧客户端默认 `fatal`，Go TUI 可传 `soft`；soft policy 下 `timeoutMs`/`softTimeoutMs` 作为 soft budget，实际 abort 使用 `watchdogTimeoutMs`。
- HTTP `/v1/execute` 与 WebSocket `/v1/stream` 共享 `prepareExecution()` 的 timeout decision。
- `clients/go-tui/internal/tui/tui.go` `buildExecuteRequestWithTimeout()` 在发送 `timeoutMs` 时同时发送 `timeoutPolicy='soft'` 与 `softTimeoutMs=<timeoutMs>`，让 Go TUI 先 opt-in soft policy。
- 旧 HTTP 客户端不传新字段仍保持 fatal back-compat。

验证命令：

```bash
NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/runtime.test.ts --test-name-pattern "soft timeout policy|per-request timeoutMs|partial result"
cd clients/go-tui && go test ./internal/tui -run 'TestBuildExecuteRequest.*Timeout|TestResolveGoTuiTimeout|TestBuildExecuteRequestRaisesLongContextTimeout|TestBuildExecuteRequestKeepsPolicyAndTimeoutIndependent'
```

结果：runtime focused 117/117 pass；Go TUI timeout payload tests pass。

收口标准：schema 已兼容旧客户端；Go TUI 可显式请求 soft timeout；server 内部已拆出 soft budget 与 hard watchdog decision。真正的 runtime-visible soft timeout event 留 Phase 2。

### Phase 2：Runtime 可恢复事件

状态：已落地（2026-06-12）

落地点：

- `src/shared/events.ts` 新增 `TimeoutBudgetExceededEventSchema` 并加入 `NexusEventSchema` 联合类型。
- `src/nexus/app.ts` 新增 `buildTimeoutBudgetExceededEvent()` / `maybeAppendTimeoutBudgetExceeded()` / `startSoftTimeoutWatcher()`：到点只 append event，不 abort 任何 `AbortController`，并通过 `buildPartialTimeoutSummary()` 同步当前 partial evidence。
- HTTP `/v1/execute` 与 WebSocket `/v1/stream` 仅在 `timeoutDecision.policy === 'soft'` 时启动 soft watcher；fatal back-compat 客户端不会收到新事件。
- `clients/go-tui/internal/tui/tui.go` 在 `eventTypeLabel()` / `formatNexusEvent()` 新增 `timeout_budget_exceeded` 渲染（含 `policy=soft` 与 `suggestedActions` 列表），落到 transcript 默认 `appendLine` 通道。
- 事件 schema：

  ```ts
  timeout_budget_exceeded {
    type: 'timeout_budget_exceeded'
    requestId?: string
    timeoutMs: number
    elapsedMs: number
    policy: 'soft'
    partialSummary?: string
    suggestedActions?: ('continue' | 'summarize' | 'narrow_scope' | 'retry_last_tool')[]
    message: string
  }
  ```

验证命令：

```bash
NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/runtime.test.ts --test-name-pattern "soft timeout policy|timeout_budget_exceeded|fatal timeout policy"
cd clients/go-tui && go test ./internal/tui -run 'TestFormatNexusEventTimeoutBudgetExceeded|TestBuildExecuteRequest.*Timeout|TestResolveGoTuiTimeout'
npx tsc --noEmit
```

结果：runtime focused 119/119 pass；Go TUI focused tests pass；tsc clean。

收口标准：soft timeout 到达后 session 不自动 failed，事件可持久化、可被 Go TUI 渲染、并随后续 provider call 一起进入模型上下文。模型预算决策与扩展请求留 Phase 3。

### Phase 3：模型预算决策与扩展请求

状态：已落地（2026-06-12）

落地点：

- `src/shared/events.ts` 新增 `TimeoutExtensionGrantedEventSchema` 并加入 `NexusEventSchema` 联合类型；事件携带 `extensionCount`、`maxExtensions`、`additionalMs`、`totalSoftBudgetMs`、`elapsedMs`、`policy='soft'`、`reason='auto-first-budget-exhausted' | 'auto-followup-budget-exhausted'`、`message`。
- `src/nexus/app.ts` `executeSchema` 新增 optional `maxSoftTimeoutExtensions`（默认 soft policy 下 1，fatal policy 下 0）与 `softTimeoutExtensionMs`（默认 = `softTimeoutMs`，上限 300_000ms），通过 `ExecuteTimeoutDecision` 一并下传。
- Phase 2 的 `startSoftTimeoutWatcher()` 已重构为 `scheduleSoftTimeoutCycle()`：每个 cycle 触发后先 append `timeout_budget_exceeded`，若 `extensionCount < maxExtensions` 立即 append `timeout_extension_granted` 并以 `additionalMs` 重新调度下一 cycle；fatal 客户端 `maxSoftTimeoutExtensions` 仍为 0，行为退化为单次 budget event。HTTP `/v1/execute` 与 WS `/v1/stream` 的 finally 改用 `softTimeoutCycle?.cancel()` 拆除。
- Hard watchdog 仍由独立 timer 持有 abort；extension cycle 永远不调 abortController。
- Go TUI `eventTypeLabel()` / `formatNexusEvent()` 新增 `timeout_extension_granted` 渲染（`extension N/M`、`+Xms`、`total=Yms`、`reason`、message），默认 transcript `appendLine` 通道接住。
- 当前 cycle 的 idempotency 改为按 `currentBudgetMs` 去重，避免不同 cycle 的 budget event 被误判为重复。

事件 schema：

```ts
timeout_extension_granted {
  type: 'timeout_extension_granted'
  requestId?: string
  extensionCount: number               // 1-indexed, this granted extension
  maxExtensions: number                // configured cap
  additionalMs: number                 // delta added by this extension
  totalSoftBudgetMs: number            // new running soft budget
  elapsedMs: number
  policy: 'soft'
  reason: 'auto-first-budget-exhausted' | 'auto-followup-budget-exhausted'
  message: string
}
```

验证命令：

```bash
NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/runtime.test.ts --test-name-pattern "soft timeout policy|timeout_budget_exceeded|fatal timeout policy|auto-grants one extension|stops granting extensions"
cd clients/go-tui && go test ./internal/tui -run 'TestFormatNexusEventTimeoutBudgetExceeded|TestFormatNexusEventTimeoutExtensionGranted|TestBuildExecuteRequest.*Timeout|TestResolveGoTuiTimeout'
npx tsc --noEmit
```

结果：runtime focused 5 timeout tests 全 pass（默认 auto-grant 1 次、cap=1 时第二次 cycle 不再 grant、`maxSoftTimeoutExtensions=0` 仍保持 Phase 2 一次性语义、fatal back-compat 仍无新事件）；Go TUI focused tests pass；tsc clean。

收口标准：soft timeout 后模型不再被动等死；runtime 自动 grant 一次 extension，让模型在下一轮 provider call 内能看到 budget_exceeded + extension_granted 一对事件并做出 summarize / narrow / continue / retry 决定；extension 受 `maxSoftTimeoutExtensions` 上限保护，超过后只剩 watchdog；显式 `RequestTimeoutExtension(reason, additionalMs)` 工具留待真实需求出现再做单独评估，避免 [feedback-tool-boundary-granularity](../../.. /memory/feedback-tool-boundary-granularity.md) 提示的“宽边界工具”反模式。

### Phase 4：Go TUI 展示与交互

状态：已落地（2026-06-12）

落地点：

- `clients/go-tui/internal/tui/tui.go` 新增 `softTimeoutSnapshot` 类型与 `model.softTimeoutState` 字段：在 `consumeNexusEvent` 中 `timeout_budget_exceeded` / `timeout_extension_granted` 显式处理，分别记录 `OriginalBudgetMs` / `TotalSoftBudgetMs` / `ExtensionCount` / `MaxExtensions` / `LastElapsedMs` / `BudgetExceededAt`；`result` / `error` 在拼装好友好消息之后再清空快照，避免错过 watchdog 上下文。
- 新增 `formatSoftTimeoutFooter()` 纯函数并接入 `renderFooterSummary()`：未触发时不显示；触发后展示 `soft timeout budget=Xms ext=N/M`，与 `tokens in=… out=…` 同行，操作员在长任务里能一眼看到“软预算已耗尽但工作流仍在跑”。
- 新增 `friendlyNexusErrorWithContext(code, payload, *softTimeoutSnapshot)`：旧 `friendlyNexusError(code, payload)` 委托给它（snapshot=nil）保 back-compat；`REQUEST_TIMEOUT` 若伴随已触发的软周期则改写为 watchdog 收口口径，并明确不建议 raise `--execute-timeout-ms`。
- 新增 `model.formatErrorEventWithSoftContext(event)`：`consumeNexusEvent` 在 `case "result", "error"` 仅对 `error` 走带 snapshot 的友好消息；`result` 维持现状。
- 显式按键扩展（`c` cancel / `e` extend / `s` summarize）继续按文档 "不进首切片" 推迟，留待真实 UX 信号驱动。

验证命令：

```bash
cd clients/go-tui && go test ./internal/tui -run 'TestFormatNexusEventTimeoutBudgetExceeded|TestFormatNexusEventTimeoutExtensionGranted|TestFormatSoftTimeoutFooter|TestFriendlyNexusErrorWithSoftContext|TestConsumeNexusEventTracksSoftTimeoutLifecycle|TestConsumeNexusEventClearsSoftTimeoutStateOnResult'
go vet ./internal/tui/...
cd clients/go-tui && go test ./internal/tui
```

结果：Phase 4 focused 6 tests pass；Go TUI 全量 `go test ./internal/tui` 通过；`go vet` clean。

收口标准：Go TUI 不再把 soft timeout 当 fatal failure 显示；soft 周期触发与扩展状态可见；hard watchdog 触发的 `REQUEST_TIMEOUT` 不再建议直接抬高 `--execute-timeout-ms` 而是引导让模型 summarize / narrow / split。

### Phase 5：Hard watchdog 与清理

状态：已落地（2026-06-12）

落地点：

- `src/nexus/app.ts` `PreparedExecution` 新增 `watchdog: WatchdogState`；`prepareExecution()` 的 `setTimeout` callback 在 abort 前先 `watchdog.fired = true`，HTTP `/v1/execute` 与 WS `/v1/stream` 的 for-await 循环用新 helper `maybeDecorateWatchdogError()` 在 push/persist/send 之前对 `REQUEST_TIMEOUT` 事件加 `details.kind='watchdog'`、`policy='soft'`、`softTimeoutMs`、`watchdogTimeoutMs`、`maxSoftTimeoutExtensions`、`softCycleEvents`、`retryable=false`。
- 装饰只在 `timeoutDecision.policy === 'soft'` 且 `watchdog.fired === true` 时生效；fatal back-compat 客户端保持原 `REQUEST_TIMEOUT` envelope。
- HTTP `try/finally` 与 WS `try/finally` 的 `clearActiveExecution` / `activeExecutions` 清扫保持现有路径，新回归 `execute soft policy watchdog decorates REQUEST_TIMEOUT ...` 用 `POST /v1/sessions/:sessionId/cancel` 后断言 `activeExecutionCancelled === false`，证明 watchdog 触发后注册表已 clean。
- Go TUI `friendlyNexusErrorWithContext` 新增 `details.kind='watchdog'` 解析路径：即使 `softTimeoutSnapshot` 已被清空（如 result/error 流程边界），只要 server 标记到位也走 watchdog 友好消息，并在文案里带出 `policy=soft`、`watchdog budget=Xms`，并显式拒绝建议提高 `--execute-timeout-ms`。
- 用户 cancel、socket 断开、provider 异常等既有 cleanup 路径未改动；watchdog 装饰严格只针对 `REQUEST_TIMEOUT`，不污染其他错误码或 fatal 路径。

验证命令：

```bash
NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/runtime.test.ts --test-name-pattern "soft policy watchdog decorates|fatal timeout policy never decorates|soft timeout policy|timeout_budget_exceeded|fatal timeout policy never emits|auto-grants one extension|stops granting extensions"
cd clients/go-tui && go test ./internal/tui -run 'TestFriendlyNexusErrorWithSoftContextDistinguishesWatchdog|TestFriendlyNexusErrorWithDetailsKindWatchdog|TestFormatSoftTimeoutFooter|TestFormatNexusEventTimeoutBudgetExceeded|TestFormatNexusEventTimeoutExtensionGranted|TestConsumeNexusEventTracksSoftTimeoutLifecycle|TestConsumeNexusEventClearsSoftTimeoutStateOnResult'
npx tsc --noEmit
```

结果：runtime focused 8 timeout tests 全 pass（含新增 soft policy watchdog 装饰 / 清理回归 + fatal back-compat 未装饰回归）；Go TUI focused 7 tests pass；tsc clean。

收口标准：soft timeout 可继续；hard watchdog 触发时 abort 真正发生、`REQUEST_TIMEOUT` 带可识别 `details.kind='watchdog'`、`activeExecutions` registry 清理、Go TUI 友好消息明确区分软周期 vs watchdog；fatal 客户端语义不变。

### Phase 6：DONE 与文档同步

状态：已落地（2026-06-12）

落地点：

- `docs/nexus/DONE.md` 新增 "Task-adaptive Recoverable Timeout 已落地" 条目：覆盖事件 schema、Nexus timeout policy、Go TUI opt-in、watchdog 装饰、cleanup 回归与验证命令。
- `docs/nexus/archive/go-tui-tool-permission-timeout-optimization-plan.md` 顶部 "范围拆分提示" 明确：旧规划解决“权限/工具噪音 + near-timeout warning + Bash read-only classifier + adaptive Go TUI timeout”这层局部降噪；本规划解决“fatal timeout 语义”。
- `docs/nexus/active/TODO_runtime.md` 的 P1 段落改为 "已收口 P1 Task-adaptive Recoverable Timeout"，附收口要点列表。
- `docs/nexus/TODO.md` 主表格行迁移到 `Watch / Closed`；Runtime / Context 摘要列同步去掉 "P1 打开" 文案；TODO 进度旁注 (#1) 与文档索引 (Plan 行) 都已同步引用 DONE.md 收口。

收口标准：跨文档（plan / runtime TODO / 总控 TODO / DONE / 旧 optimization plan）一致表达 "Task-adaptive Recoverable Timeout Phase 0~6 已落地、转 Watch / Closed"；后续真实样本若再次暴露 fatal-style cutoff drift 才重新开未收口项。

---

## 7. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---:|---:|---|
| 没有 fatal cutoff 导致进程泄漏 | 中 | 高 | hard watchdog 必须保留，且事件语义与 soft timeout 分离 |
| 模型无限申请 extension | 中 | 中 | extension 次数/总预算上限；超过后必须用户确认或 summarize |
| HTTP 客户端等待太久 | 中 | 中 | 旧 HTTP 默认保持 fatal；soft policy 优先给 WebSocket/Go TUI opt-in |
| provider call 本身卡死 | 低 | 高 | provider request 仍可有内部 watchdog；soft timeout 只是不杀整个 workflow 的产品预算 |
| pending permission 跨 timeout 状态不清 | 中 | 中 | timeout event 不自动 approve/deny；hard watchdog 时 cancel pending resolver |
| 事件 schema 破坏旧客户端 | 低 | 中 | 新字段 optional；新 event type 旧客户端可按 unknown event 忽略 |
| 用户以为任务永远不会停 | 中 | 低 | TUI 明确显示 soft timeout、extension 次数、hard watchdog 上限 |

---

## 8. 验证命令

实施后预期 focused tests：

```bash
NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/recoverable-timeout.test.ts
NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/go-tui-tool-permission-timeout-regression.test.ts
```

若改动触达 Go TUI：

```bash
cd clients/go-tui
go test ./...
go vet ./...
```

若改动触达 shared events / Nexus app：

```bash
npx tsc --noEmit
npm test
```

手动验收：

```text
1. 启动 bbl go。
2. 发起长分析任务，设置较短 soft timeout（例如 10s）和较长 watchdog（例如 120s）。
3. 观察 transcript 出现 soft timeout warning，但 session 不 failed。
4. 模型继续输出：收口 / 缩小范围 / 请求继续。
5. hard watchdog 未触发时，不出现 fatal REQUEST_TIMEOUT。
```

---

## 9. 关联文件

- `src/nexus/app.ts:1001-1004` — 当前顶层 timeout 同时 abort `timeoutController` 与 `abortController`。
- `src/nexus/app.ts:1089-1127` — near-timeout warning watcher。
- `src/nexus/app.ts:1160-1209` — `/v1/execute` runtime event loop、near timeout append、timeout partial result 路径。
- `src/shared/events.ts:145-164` — `execute_summary` / `near_timeout_warning` schema。
- `src/tools/builtin/bash.ts:101-134` — Bash command timeout 已是 recoverable `COMMAND_TIMEOUT` 方向。
- `clients/go-tui/internal/tui/tui.go:8462-8484` — Go TUI 当前 adaptive timeout（180s / 300s）。
- `clients/go-tui/internal/tui/tui.go:7521-7535` — Go TUI `execute_summary` 展示。
- `clients/go-tui/internal/tui/tui.go:7575-7576` — Go TUI `near_timeout_warning` 展示。
- `clients/go-tui/internal/tui/tui.go:8206-8211` — Go TUI `REQUEST_TIMEOUT` friendly message。
- `docs/nexus/archive/go-tui-tool-permission-timeout-optimization-plan.md` — 旧规划，已收口“减少权限/工具噪音与 timeout 风险”的局部优化。

---

## 10. 推荐结论

BabeL-O 应把 timeout 拆成两层：

1. **Soft timeout / model budget**：模型可见、可恢复、可扩展、不中断 workflow。
2. **Hard watchdog / system safety**：防泄漏、防无限挂起、可 fatal abort。

这与工具 timeout 已经走向 recoverable `COMMAND_TIMEOUT` 的方向一致。下一步不应继续单纯提高 Go TUI `DefaultGoTuiExecuteTimeoutMs`，而应先让 Go TUI opt-in soft timeout policy，并让 Nexus 在 soft deadline 到达时产出可恢复事件。
