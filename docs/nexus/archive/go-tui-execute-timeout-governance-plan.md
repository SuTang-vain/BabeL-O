# Go TUI Execute-Timeout / REQUEST_TIMEOUT 治理规划

> Status: Phase A + B + C + D + E 全部已落地（治理收口）
> Priority: 真实会话 regression 驱动；最小诊断 + 修复方案已落定，后续按 regression-first 推进
> 真实样本: `session_...053000`（Go TUI WebSocket 会话，sessionId 末段 053000 来自 `session_go_<unixnano>` 命名）

---

## 1. 背景

最新一次 `bbl go`（Go TUI）真实会话在执行过程中被 Nexus 标记为失败，错误码 `REQUEST_TIMEOUT`、错误消息 `This operation was aborted`。从 Go TUI 的事件日志可以观察到以下顺序：

```text
tool >    Read running  ... program.ts
tool ok   Read done success=true
tool >    Read running  ... README.md
tool ok   Read done (file unchanged)
hook >    InvocationDiagnosticsHook PreInvocation started
hook ok   InvocationDiagnosticsHook PreInvocation Provider invocation started.
usage    input=0 output=0 cacheRead=0
hook >    InvocationDiagnosticsHook PostInvocation started
hook ok   InvocationDiagnosticsHook PostInvocation Provider invocation completed.
error     REQUEST_TIMEOUT This operation was aborted
```

会话已经进入 provider invocation prelude，但 `usage=0/0/0` 表明模型侧没有任何 token 回来；随后 runtime 产出 `REQUEST_TIMEOUT`。本会话是 Go TUI 在长会话、多轮工具调用、上下文逐步累积的典型场景。

---

## 2. 根因

### 2.1 Nexus 默认 30 秒 execute timeout

`src/nexus/app.ts:468`：

```ts
const executeTimeoutMs = options.executeTimeoutMs ?? 30_000
```

`src/nexus/app.ts:932-934`（HTTP 与 WebSocket 共用 `prepareExecution`）：

```ts
const abortController = new AbortController()
const timeoutController = new AbortController()
const timeout = setTimeout(() => { timeoutController.abort(); abortController.abort() }, body.timeoutMs ?? executeTimeoutMs)
```

超时触发时，`timeoutController` 与 `abortController` 同时 abort。`timeoutController.signal` 作为 `timeoutSignal` 传给 `runtime.executeStream()`（HTTP `app.ts:1049`、WebSocket `app.ts:2041`）。

### 2.2 runtime 正确分类为 REQUEST_TIMEOUT

`src/runtime/LLMCodingRuntime.ts:681-684`：

```ts
const isTimeout = options.timeoutSignal?.aborted
const isCancelled = !isTimeout && (options.signal?.aborted || err.message?.includes('Abort') || err.name === 'AbortError')
const errorCode = isTimeout ? 'REQUEST_TIMEOUT' : isCancelled ? 'REQUEST_CANCELLED' : (err.code || 'PROVIDER_ERROR')
```

`fetch(signal: options.signal)`（AnthropicAdapter `src/providers/adapters/AnthropicAdapter.ts:400`、OpenAIAdapter `src/providers/adapters/OpenAIAdapter.ts:159`）在 abort 时抛出 `AbortError` / "This operation was aborted"。`isTimeout` 因 `timeoutSignal.aborted === true` 命中，`errorCode = 'REQUEST_TIMEOUT'`。runtime 分类本身没有 bug。

### 2.3 Go TUI 不覆盖 `timeoutMs`

`clients/go-tui/internal/tui/tui.go:5167-5171`：

```go
err = conn.WriteJSON(map[string]any{
    "prompt":    prompt,
    "cwd":       cfg.Cwd,
    "sessionId": sessionID,
})
```

Go TUI 的 WebSocket 请求只发 `{prompt, cwd, sessionId}`，没有 `timeoutMs` 字段。schema（`src/nexus/app.ts:51`）允许 `timeoutMs` 上限 300_000（5 分钟），Go TUI 完全有能力自己声明一个比 30s 更合理的预算。

### 2.4 为什么长会话容易踩中

30s 是整轮 `executeStream()` 的总预算，覆盖：

- 上下文拼装 + cache-aware compact
- provider stream 启动 + 首字节 + 整段流式
- 工具执行 + 工具结果回填
- 下一轮 prelude

长会话中上下文逐步堆积、DeepSeek reasoning replay、`Read`/`ListDir` 工具累积，单轮耗时很容易超 30s。这不是 provider 慢，而是 30s 预算对长会话偏紧。

---

## 3. 问题定义

### 3.1 Go TUI 长会话 REQUEST_TIMEOUT

定义：Go TUI 通过 WebSocket 发起 turn 请求时，未覆盖 `timeoutMs`，掉到 Nexus 默认 30s 预算；多轮 / 长上下文 / 多工具 turn 容易在 provider streaming 或 tool 阶段被 timeout 切掉，runtime 正确归类为 `REQUEST_TIMEOUT`，但用户体验是"会话突然失败、没有 token 回来"。

### 3.2 Abort → 错误码分类的潜在混用

主路径（`LLMCodingRuntime.ts:681`）区分 `timeoutSignal` 与 `signal`，分类正确。但还有两处 watch 点：

- `src/nexus/runtimeAgentStep.ts:298`：
  ```ts
  const errorCode = options.signal?.aborted ? 'REQUEST_TIMEOUT' : 'RUNTIME_AGENT_STEP_ERROR'
  ```
  把任何 `options.signal` abort 都标成 `REQUEST_TIMEOUT`，分不清用户取消与真超时。仅在 `optimize` CLI 与 `agentLoopSmoke` 使用，不影响主 Nexus 路径，但会污染后续 telemetry。
- `src/cli/runSessionFlow.ts:247-254`：
  ```ts
  const timeoutController = new AbortController()
  // ...
  timeoutSignal: timeoutController.signal,
  ```
  `timeoutController` 从未被任何 `setTimeout` 武装，CLI 路径下 `timeoutSignal` 实际是死信号，CLI 不会触发 `REQUEST_TIMEOUT` 分类。

### 3.3 与现有治理的关系

| 现有治理 | 已解决 | 仍缺口 |
| --- | --- | --- |
| Go TUI stable opt-in alternative | `bbl go` 已通过 Phase 9 promotion gate，与 Nexus / `/v1/stream` WebSocket 链路稳定。 | 未给 WebSocket 请求加 per-request `timeoutMs`，长会话会撞 30s 默认值。 |
| Runtime / Nexus timeout 分类 | `LLMCodingRuntime.ts:681-684` 正确区分 timeout / cancel。 | `runtimeAgentStep.ts:298` 与 `runSessionFlow.ts:247` 两处 watch 点未收口。 |
| SessionChannel TUI 关系可见化 | Go TUI 作为消费侧入口已对齐侧 channel 边界。 | 与本问题无关，不引入跨 session 静默副作用。 |

---

## 4. 目标行为

1. Go TUI 在 WebSocket 请求中声明合理的 `timeoutMs`，覆盖 Nexus 默认 30s。
2. `timeoutMs` 选取应基于真实长会话 turn 耗时经验值，不与 Nexus 服务端默认硬绑定。
3. 主 Nexus 路径下 `REQUEST_TIMEOUT` 仅由 `timeoutSignal` abort 触发，`REQUEST_CANCELLED` 仅由用户主动 `signal` abort 触发，二者不再混用。
4. CLI 路径下 `timeoutSignal` 若继续保留死信号，必须明确不参与错误码分类，或被武装。
5. Go TUI 端能将 `REQUEST_TIMEOUT` 与 `REQUEST_CANCELLED` 区分展示给用户，便于判断"是 turn 太长被切"还是"用户主动取消"。

---

## 5. 非目标

- 不调整 Nexus 服务端 `executeTimeoutMs` 默认值，避免影响 TypeScript `bbl chat`、HTTP API、其它 TUI 客户端。
- 不把 `timeoutMs` 写入 Go TUI 与 Nexus 之间的协议硬约束；保留服务端 `body.timeoutMs` 可选语义。
- 不修改 `LLMCodingRuntime` 主路径的 timeout / cancel 分类逻辑（已正确）。
- 不让 Go TUI 自行实现 provider 调用或工具执行；超时尚由 Nexus 决策。
- 不启用 auto model selection、role model 默认推荐、provider fallback。
- 不引入 durable permission backend 或 resumable execution。
- 不新增与 `Grep` 重叠的 `Search`，不新增 `define_subagent` / `invoke_subagent`。
- 不在本切片中实现完整的"自动重试 / 自动降级 turn"流程；只暴露正确的错误码与诊断。

---

## 6. 分阶段修复方案

### Phase A: Go TUI per-request `timeoutMs`

状态：已实现。

落地点：

- `clients/go-tui/internal/tui/tui.go:25-34` `Config` 新增 `ExecuteTimeoutMs int` 字段。
- `clients/go-tui/internal/tui/tui.go` 新增 `buildExecuteRequest(cfg Config, sessionID, prompt string) map[string]any` helper，仅在 `cfg.ExecuteTimeoutMs > 0` 时附加 `timeoutMs` 字段；`cfg.ExecuteTimeoutMs == 0` 时沿用 Nexus 默认 30s。
- `clients/go-tui/internal/tui/tui.go` `runStream()` 改为 `conn.WriteJSON(buildExecuteRequest(cfg, sessionID, prompt))`。
- `clients/go-tui/cmd/go-tui/main.go` 在 `parseFlags()` 末尾按以下优先级应用 `cfg.ExecuteTimeoutMs`：(1) 命令行 `--execute-timeout-ms` flag；(2) 环境变量 `BABEL_O_GO_TUI_TIMEOUT_MS`；(3) 默认 180_000（3 分钟长会话 turn 经验值）。范围 [1000, 300000] 与 Nexus schema 对齐。`--execute-timeout-ms` flag 与 `BABEL_O_GO_TUI_TIMEOUT_MS` env 是可选 override；任一缺失时回落到硬编码 180_000。
- `clients/go-tui/internal/tui/tui.go` `formatNexusEvent` "error" case 与 `friendlyNexusError` 同步识别 `REQUEST_TIMEOUT`（含 `timeoutMs` 元信息）与 `REQUEST_CANCELLED`，分别提示"turn 超过 Nexus execute timeout"与"turn 已取消"，不再让用户看到裸 `REQUEST_TIMEOUT This operation was aborted`。
- `clients/go-tui/internal/tui/tui_test.go` 新增 `TestBuildExecuteRequestIncludesTimeoutMsWhenPositive`、`TestBuildExecuteRequestOmitsTimeoutMsWhenZero`、`TestFriendlyNexusErrorProducesHumanHints` 新增两类用例、`TestFormatNexusEventErrorUsesFriendlyHintForRequestTimeout`、`TestFormatNexusEventErrorUsesFriendlyHintForRequestTimeoutWithTimeoutMs`、`TestFormatNexusEventErrorUsesFriendlyHintForRequestCancelled`、`TestFormatNexusEventErrorFallsBackToRawWhenUnknown`。

收口标准：

- Go TUI WebSocket 请求在 payload 中包含 `timeoutMs`。
- 长会话 regression（mock provider 慢响应 + Go TUI WebSocket smoke）能完整跑完 turn，不再因 30s 默认值被切。
- Go TUI 对 `REQUEST_TIMEOUT` 与 `REQUEST_CANCELLED` 提示文案有区分。

### Phase B: Nexus 服务端可观察性增强

状态：已实现。

落地点：

- `src/shared/events.ts` 新增 `ExecuteSummaryEventSchema`（type=`execute_summary`）+ 加入 `NexusEvent` discriminated union：携带 `sessionId` / `requestId` / `timeoutMs` / `executeDurationMs` / `nearTimeout` / `outcome` (`success` | `error` | `cancelled` | `timeout`)。**不影响现有事件 schema**，纯加法变更。
- `src/nexus/app.ts` 新增 helper：
  - `executeTimeoutNear(durationMs, timeoutMs, ratio=0.8)`：判断是否接近 timeout 预算。
  - `executeSummaryOutcome(resultEvent, errorEvent, timedOutByAbort)`：归类执行结果到 `success` / `error` / `cancelled` / `timeout`。
  - `buildExecuteSummaryEvent({...})`：构造符合 schema 的 summary event。
- `src/nexus/app.ts` HTTP `/v1/execute` finalize 路径：`finalizeExecutionSession` 之后追加 `execute_summary` 事件到 events 数组、持久化、并在 `execute_result` envelope 顶层加 `timeoutMs` / `executeDurationMs` / `nearTimeout` / `outcome` 四个字段。
- `src/nexus/app.ts` WebSocket `/v1/stream` finalize 路径：stream 结束后、`finalizeExecutionSession` 之后、metrics record 之前，emit 一个 `execute_summary` 事件到 socket 并持久化。
- `clients/go-tui/internal/tui/tui.go` `formatExecuteSummary(event)` helper：渲染 `outcome=success near-timeout dur=150000ms/180000ms (83%)` 这种带预算比例的人类可读行。
- `clients/go-tui/internal/tui/tui.go` `formatNexusEvent` 增加 `case "execute_summary":` 分支走 `formatExecuteSummary`。
- `clients/go-tui/internal/tui/tui_test.go` 新增 `TestFormatNexusEventRendersExecuteSummaryWithBudgetRatio` / `TestFormatNexusEventRendersExecuteSummaryNearTimeout` / `TestFormatNexusEventRendersExecuteSummaryWithoutTimeoutMs`。
- `test/runtime.test.ts` 已有的 `execute reads a workspace file and records session events` 扩展为同时断言 HTTP envelope 四个新字段、`execute_summary` 事件在 events 数组与 session events 中均存在。
- `test/runtime.test.ts` 已有的 `execute timeout aborts long-running tools and records metrics` 扩展为同时断言 `body.outcome === 'timeout'`、`body.timeoutMs === 50`、`body.nearTimeout === true`、summary 事件 outcome 也为 `timeout`。

收口标准：

- 事件 metadata 含 `executeDurationMs` 与 `nearTimeout` 字段。✓
- 不影响 `error.code` 分类。✓（runtime 错误事件 schema 与分类路径未动；summary 是新增的伴生事件）

### Phase C: 真实会话 regression fixture

状态：已实现。

落地点：

- `test/runtime.test.ts` 新增 `execute honours per-request timeoutMs from Go TUI WebSocket payload` 测试：服务端 `executeTimeoutMs=30_000`（宽松默认），请求体里带 `timeoutMs: 200`，真实 `Bash` 工具跑 `sleep 1`（1s > 200ms）。验证：
  - `body.success === false`
  - `body.events` 含 `type=error, code=REQUEST_TIMEOUT` 事件
  - `body.timeoutMs === 200`（per-request 胜出，覆盖 server 默认 30_000）
  - `body.outcome === 'timeout'`
  - `body.events` 里能找到 `type=execute_summary`，且 `summary.timeoutMs === 200`、`summary.outcome === 'timeout'`、`summary.nearTimeout === true`
- `clients/go-tui/internal/tui/tui.go` `runStream()` 不再在 `error` 事件上 break：Nexus 在 `result`/`error` 之后会 emit `execute_summary` 携带 timeout / outcome metadata，Go TUI 必须继续读到 connection 自然关闭。原 break 行为会让 `execute_summary` 事件丢失。
- `clients/go-tui/internal/tui/tui_test.go` 新增 `fakeNexusWSHandler(t, events)` 辅助函数：起一个 httptest.WebSocket 服务端，捕获 Go TUI 第一个 inbound JSON frame（请求 payload），然后写回脚本化的 Nexus event 序列。
- `clients/go-tui/internal/tui/tui_test.go` 新增 `TestRunStreamRendersRequestTimeoutAsFriendlyHint`：用 `ExecuteTimeoutMs=5000` 调用 `runStream`；服务端 emit `session_started` → `error(REQUEST_TIMEOUT)` → `execute_summary{outcome=timeout, nearTimeout=true, dur=6000ms/timeoutMs=5000}`。验证：
  1. Go TUI 实际向 Nexus 发送的请求 payload 包含 `timeoutMs: 5000`（端到端验证 Phase A 的 helper 落到了 wire 上）
  2. 三个事件全部流过 `runStream` 到达 consumer channel
  3. `formatNexusEvent(error)` 渲染为"exceeded Nexus execute timeout"友好文案，**不**含裸 `REQUEST_TIMEOUT ` 前缀
  4. `formatNexusEvent(execute_summary)` 渲染为"outcome=timeout near-timeout dur=6000ms/5000ms (120%)"带预算比例
- `clients/go-tui/internal/tui/tui_test.go` 新增 `TestRunStreamRendersRequestCancelledDistinctFromTimeout`：服务端 emit `session_started` → `error(REQUEST_CANCELLED)` → `execute_summary{outcome=cancelled}`。验证：
  1. `formatNexusEvent(error)` 渲染为"turn was cancelled"，**不**复用 timeout 提示
  2. `formatNexusEvent(execute_summary)` 渲染 `outcome=cancelled`
  3. 两条错误码对应的文案明确区分（不混用 timeout 与 cancel 提示）

收口标准：

- focused regression 覆盖 per-request `timeoutMs` + mock provider 慢响应 + execute_summary 元数据三段链路。✓
- Go TUI 与 Nexus 端测试都通过。✓（`go test ./...` 全过；`npm test` 706/706 pass）

### Phase D: `runtimeAgentStep.ts:298` 分类收口

状态：已实现。

落地点：

- `src/nexus/runtimeAgentStep.ts:28-29` `RuntimeAgentStepOptions` 新增 `timeoutSignal?: AbortSignal` 选项，与 `signal` 平行存在。
- `src/nexus/runtimeAgentStep.ts:229` 修正 `runtimeForRole.executeStream` 调用的 `timeoutSignal` 字段——之前错误写成 `timeoutSignal: options.signal`（把 signal 重复当成 timeoutSignal 用），改为 `timeoutSignal: options.timeoutSignal`。
- `src/nexus/runtimeAgentStep.ts:298-313` 重写错误分类：与 `LLMCodingRuntime.ts:681-684` 对齐——
  - `isTimeout = options.timeoutSignal?.aborted` → `REQUEST_TIMEOUT`
  - `isCancelled = !isTimeout && (options.signal?.aborted || err.name === 'AbortError' || errorMessage.includes('Abort'))` → `REQUEST_CANCELLED`
  - 其余 → `RUNTIME_AGENT_STEP_ERROR`
  - `timeoutSignal` 优先级高于 `signal`：当两者都 abort 时，分类为 `REQUEST_TIMEOUT`（与 Nexus HTTP / WebSocket 路径口径一致）
- `src/nexus/agentLoopSmoke.ts:130-134` 引入 `timeoutController = new AbortController()` 与 `abortController` 分离。
- `src/nexus/agentLoopSmoke.ts:142-149` `createRuntimeAgentStepRunner` 调用补 `timeoutSignal: timeoutController.signal`。
- `src/nexus/agentLoopSmoke.ts:153-160` setTimeout 回调同时 `abort()` 两个 controller：timeoutController 触发 `REQUEST_TIMEOUT` 分类，abortController 撕掉 in-flight provider call。
- `test/agent-loop.test.ts` 新增 3 个 focused 测试：
  - `runtime agent step classifies user-initiated signal abort as REQUEST_CANCELLED`：仅 `signal` abort，验证 `errorCode === 'REQUEST_CANCELLED'` 而非旧的 `REQUEST_TIMEOUT` 误分类。
  - `runtime agent step classifies timeoutSignal abort as REQUEST_TIMEOUT`：仅 `timeoutSignal` abort，验证 `errorCode === 'REQUEST_TIMEOUT'`。
  - `runtime agent step timeoutSignal wins over concurrent signal abort`：两个都 abort，验证 `errorCode === 'REQUEST_TIMEOUT'`（timeoutSignal 优先）。

收口标准：

- `optimize` CLI 与 `agentLoopSmoke` 的 focused 测试中，用户主动取消不再被标为 `REQUEST_TIMEOUT`。✓
- 不影响主 Nexus 路径行为。✓（`LLMCodingRuntime` 主路径在 Phase A 已对齐；`runtimeAgentStep` 仅被 `optimize` CLI 与 `agentLoopSmoke` 调用）

### Phase E: CLI `timeoutController` 死信号治理

状态：已实现（推荐方案 3：保留死信号 + 注释化）。

落地点：

- `src/cli/runSessionFlow.ts:247-258` 在 `const timeoutController = new AbortController()` 之前增加 9 行注释：
  - 明确说明 CLI 是 per-process one-shot runner，用户已有 Ctrl-C 通道
  - 解释为什么不在 CLI 路径上叠 timeout 预算：避免把 user-initiated cancel 误标为 REQUEST_TIMEOUT
  - 引用本文档 Phase E + 引用 Nexus HTTP / WebSocket 路径的差异
- **未触动**：CLI 路径不引入新超时预算；timeoutController 保持死信号状态；不删除 `timeoutSignal` 选项传递（runtime 已经把它当成可选信号，未触发时无副作用）。

收口标准：

- `runSessionFlow.ts` 内 `timeoutController` 用法有明确注释。✓
- 不引入新超时预算。✓

---

## 整体收口

所有 Phase 已落地：

| Phase | 主题 | 状态 |
| --- | --- | --- |
| A | Go TUI per-request `timeoutMs` 覆盖 Nexus 默认 30s | ✓ |
| B | Nexus `execute_summary` 事件 + HTTP envelope 字段可观察性 | ✓ |
| C | 真实会话 regression fixture（per-request timeoutMs + WebSocket 端到端 + cancel/timeout 文案区分） | ✓ |
| D | `runtimeAgentStep.ts:298` 错误码分类收口（cancel vs timeout 区分） | ✓ |
| E | CLI `timeoutController` 死信号注释化 | ✓ |

后续继续守住：

- `error.code` 分类口径在 runtime / runtimeAgentStep / Nexus 三处一致（`LLMCodingRuntime` 主路径 + `runtimeAgentStep` agentLoopSmoke / optimize 路径 + Nexus finalize）。
- Go TUI 不拥有 Nexus ownership 边界（stable opt-in alternative）。
- SessionChannel / EverCore 边界（不引入跨 session 静默副作用 / 不把 EverCore 作为事实源）。
- `error.code` 分类口径与 `execute_summary.outcome` 一一对应（`REQUEST_TIMEOUT` → `timeout`、`REQUEST_CANCELLED` → `cancelled`、其它 `error` → `error`、`result.success === true` → `success`）。

---

## 7. 验证命令

```bash
# TypeScript 类型检查
npm run typecheck

# 单元 / 集成测试
npm test -- --runInBand test/nexus-execute.test.ts
npm test -- --runInBand test/runtime.test.ts

# Go TUI 单元测试
cd clients/go-tui && go test ./internal/tui/...

# Format check（只跑 check-only，不跑 auto-formatter）
npm run format:check
cd clients/go-tui && gofmt -l .

# 真实 Go TUI 慢 provider regression
BABEL_O_GO_TUI_TIMEOUT_MS=5000 \
  npm run --silent dev -- go --check
```

注意：

- 只跑 check-only format 验证，不跑 broad auto-formatter。
- 真实 regression 必须用 `BABEL_O_CONFIG_FILE` 隔离 config，避免污染 `~/.babel-o/config.json`。
- 不在测试中调用真实 provider / 真实 LLM API；使用 mock provider。

---

## 8. 收口标准

Phase A + Phase C 收口必须满足：

- Go TUI WebSocket 请求 payload 含 `timeoutMs`，不再掉到 30s 默认。
- 长会话 regression fixture 跑通，Go TUI 与 Nexus 两端测试通过。
- `REQUEST_TIMEOUT` 与 `REQUEST_CANCELLED` 提示文案有区分。
- Nexus `executeTimeoutMs` 默认值不动；`bbl chat` / HTTP API 行为不变。

Phase D 收口必须满足：

- `optimize` / `agentLoopSmoke` 路径下，用户主动取消不再被标为 `REQUEST_TIMEOUT`。
- 主 Nexus 路径行为不变。

Phase E 收口必须满足：

- CLI `timeoutController` 死信号有明确注释，不引入新超时预算。

---

## 9. 与其它 reference 文档的关系

- [go-tui-rewrite-plan.md](./go-tui-rewrite-plan.md)：本规划是其下"Go TUI 真实会话守门"的子项，不改变 Go TUI 与 Nexus 的所有权边界。
- [session-finalization-and-evidence-governance-plan.md](./session-finalization-and-evidence-governance-plan.md)：本规划不涉及 session finalization 边界。
- [workspace-path-drift-governance-plan.md](./workspace-path-drift-governance-plan.md)：本规划不涉及工具失败归因。
- [tool-granularity-and-evidence-governance-plan.md](./tool-granularity-and-evidence-governance-plan.md)：本规划不新增工具，不修改现有工具职责。

完成事实按 [../README.md 维护规则](../README.md) 写入 [../DONE.md](../DONE.md)。
