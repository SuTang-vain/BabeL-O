# Task-adaptive Recoverable Timeout 规划

> Status: 规划中（设计约束已确认；代码未改）
> Priority: P1 — 真实 Go TUI session 已再次撞 180s 顶层 `REQUEST_TIMEOUT`；本规划把普通 timeout 从 fatal request cutoff 改为可恢复事件与模型可控预算
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

状态：未启动

新增 focused regression：

- `test/recoverable-timeout.test.ts` 或扩展 `test/go-tui-tool-permission-timeout-regression.test.ts`
- 固化 `session_791b10ce-0d41-409d-b2de-1e5d14eb19b3` 的核心形状：
  - 180s 顶层 cutoff 发生时仍有 1 个 tool 未完成
  - `permission_response` 已批准最后 tool
  - `execute_summary.outcome=timeout`
  - session failed，但 assistant 已有多段 partial analysis
- 测试输出必须区分：tool timeout / request timeout / watchdog timeout / provider error。

收口标准：当前失败链路被最小 fixture 表达，后续实现不能再把普通 soft deadline 误判为 fatal session failure。

### Phase 1：协议语义拆分（soft deadline vs hard watchdog）

状态：未启动

`/v1/execute` / `/v1/stream` request 增加可选字段（命名待实现时确定）：

```ts
timeoutPolicy?: 'fatal' | 'soft'
softTimeoutMs?: number
watchdogTimeoutMs?: number
```

兼容策略：

- 未传字段的旧 HTTP 客户端保持现状（`timeoutPolicy='fatal'`），避免破坏 `bbl chat` / API 用户预期。
- Go TUI 先 opt-in `timeoutPolicy='soft'`。
- `watchdogTimeoutMs` 默认为 `max(timeoutMs * 3, timeoutMs + 300000)` 或 server config 上限，具体值需实现时评估。
- `timeoutMs` 可继续作为旧字段，但在 soft policy 下解释为 soft budget。

收口标准：schema 兼容旧客户端；Go TUI 可显式请求 soft timeout；server 内部不再只有一个 abort controller。

### Phase 2：Runtime 可恢复事件

状态：未启动

新增或扩展事件：

```ts
timeout_budget_exceeded {
  type: 'timeout_budget_exceeded'
  requestId?: string
  timeoutMs: number
  elapsedMs: number
  policy: 'soft'
  partialSummary?: string
  suggestedActions?: ('continue' | 'summarize' | 'narrow_scope' | 'retry_last_tool')[]
}
```

实现方向：

- soft timer 到点只 append event，不 abort runtime signal。
- event 注入 runtime-visible history，使下一次 provider call 能看到“预算已超，必须决定收口或继续”。
- 如果当前正卡在 tool permission 或 tool execution，event 先持久化并推给客户端；等 tool 返回后继续 loop。
- `execute_summary` 记录 `nearTimeout=true` 或新字段 `softTimeoutExceeded=true`。

收口标准：soft timeout 到达后 session 不自动 failed，事件可持久化、可被 Go TUI 渲染、可进入后续模型上下文。

### Phase 3：模型预算决策与扩展请求

状态：未启动

引入模型可表达的预算动作，最小可先用自然语言 guidance，不急着加工具：

- system prompt 明确：遇到 `timeout_budget_exceeded`，必须选择 summarize / narrow / continue，并解释理由。
- 若选择 continue，runtime 可允许一次自动 extension（例如 +180s），并记录 `timeout_extension_granted` event。
- 若已多次 extension，模型必须收口或请求用户确认。

后续可选新增工具/控制事件：

```text
RequestTimeoutExtension(reason, additionalMs)
```

但这会引入工具边界，需要单独评估；首阶段用 runtime policy + prompt guidance 足够。

收口标准：模型不是被动等死，而是在 soft timeout 后主动收口或继续；extension 有次数/总预算上限。

### Phase 4：Go TUI 展示与交互

状态：未启动

Go TUI 行为：

- `timeout_budget_exceeded` 渲染为 warning/status：`soft timeout reached 180s; workflow continues`。
- footer / header 可显示 `timeout +180s` 或 `budget exceeded` 状态。
- 普通 `REQUEST_TIMEOUT` friendly message 改口径：只有 hard watchdog 才建议“提高 timeout”；soft timeout 只提示“模型正在收口/继续”。
- 可选按键：当 soft timeout 触发后，operator 可 `c` cancel / `e` extend / `s` ask summarize（后续 UX，不进首切片）。

收口标准：Go TUI 不把 soft timeout 显示成 fatal failure；session 继续接收事件。

### Phase 5：Hard watchdog 与清理

状态：未启动

Hard watchdog 保留：

- 用户 cancel 立即 abort。
- WebSocket/HTTP client 断开且无 durable continuation 时，按现有 cleanup 处理。
- watchdog 到达时 abort runtime，并产出 fatal error：`WATCHDOG_TIMEOUT` 或 `REQUEST_TIMEOUT` with `details.kind='watchdog'`。
- active execution registry 必须清理，pending permissions 必须 resolve/cancel。

收口标准：soft timeout 可继续，hard watchdog 能防泄漏，二者在事件、metrics、TUI 文案里可区分。

### Phase 6：DONE 与文档同步

状态：未启动

- 更新 `docs/nexus/DONE.md`：记录事件 schema、Nexus timeout policy、Go TUI opt-in、测试命令。
- 同步 `go-tui-tool-permission-timeout-optimization-plan.md`，说明旧规划解决“降噪”，本规划解决“fatal timeout 语义”。
- 更新 `active/TODO_runtime.md` 和总控 TODO 状态。

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
- `docs/nexus/reference/go-tui-tool-permission-timeout-optimization-plan.md` — 旧规划，已收口“减少权限/工具噪音与 timeout 风险”的局部优化。

---

## 10. 推荐结论

BabeL-O 应把 timeout 拆成两层：

1. **Soft timeout / model budget**：模型可见、可恢复、可扩展、不中断 workflow。
2. **Hard watchdog / system safety**：防泄漏、防无限挂起、可 fatal abort。

这与工具 timeout 已经走向 recoverable `COMMAND_TIMEOUT` 的方向一致。下一步不应继续单纯提高 Go TUI `DefaultGoTuiExecuteTimeoutMs`，而应先让 Go TUI opt-in soft timeout policy，并让 Nexus 在 soft deadline 到达时产出可恢复事件。