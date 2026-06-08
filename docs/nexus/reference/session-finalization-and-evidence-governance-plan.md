# Session Finalization / Evidence Governance 修复优化规划

> Status: P0 current-turn finalization regression 已收口；P2 evidence-scope drift 继续作为轻量治理样本
> Priority: 真实会话 regression-first；session 终态污染已修复，后续只在真实样本继续复现时评估强声明证据覆盖诊断
> 真实样本: `session_9d985c5c-7c89-41b8-9d5e-cc672e412f00`

---

## 1. 背景

`session_9d985c5c-7c89-41b8-9d5e-cc672e412f00` 暴露了两类问题：

1. **P0 current-turn session finalization regression**：第三轮用户请求已经进入 provider invocation prelude，但没有写入当前轮 terminal `result` / `error` / `execution_metrics`；session 最终仍被标记为 `completed`，并继承上一轮 result。
2. **P2 evidence-scope drift**：会话中产生了项目级强声明，但 recorded tool evidence 主要来自 `Read` / `ListDir`，未观察到足以支撑部分全局声明的 `Grep` / `Glob` / `Bash git status` 等证据。

第一类 session state correctness bug 已收口：local embedded flow 不再用旧 terminal event 结算当前轮；第二类只作为 Source Coverage Ledger / Strong Claim Guard 的真实样本，避免一次性引入复杂审计系统。

---

## 2. 真实样本摘要

目标 session 有三轮用户输入：

1. `/Users/tangyaoyue/DEV/BABEL/BabeL-O查看并深度分析这个项目`
2. `抱歉打断你了，继续`
3. `帮我分析这个项目能否开启两个会话，然后两个会话之间能够有一定的聊天信息传输通道？`

持久化状态显示：

- session row 最终为 `phase=completed`。
- session `result` 是第二轮长项目分析结果。
- 第三轮只有启动阶段事件：`user_message`、`session_started`、`user_intake_guidance`、PreInvocation hook、`usage`、一条 `thinking_delta`。
- 第三轮没有 `assistant_delta`、`tool_started`、`tool_completed`、PostInvocation hook、`result`、`error`、`execution_metrics`。

因此第三轮不是成功完成，而是没有被当前终态正确收口；最终 session state 被旧 terminal event 污染。

---

## 3. P0 问题定义：Current-turn Finalization Pollution

### 3.1 定义

同一 session 内多轮执行时，当前轮没有 terminal event，却被 session-finalization 逻辑从历史事件中找到旧 `result` / `error` 并用于保存当前 session phase / result / error。

### 3.2 风险

- 最新用户请求没有回答，但 session 显示为 `completed`。
- session `result` 与最新用户意图不匹配。
- 历史查看、继续会话、恢复状态和后续 compact 都可能基于错误终态。
- 用户会误以为第三轮已经完成，实际只是继承了上一轮输出。

### 3.3 可疑根因

当前 local CLI finalization path 在 `src/cli/runSessionFlow.ts` 的 `finally` 中读取整段 session 最近事件，再用 `resolveFinalSessionOutcome()` 找最新 terminal event。该逻辑没有按当前 request / 当前 turn / 当前 `session_started` boundary 限定事件范围。

现有行为等价于：

```text
current turn has no terminal event
→ scan latest 100 events in the entire session
→ find previous turn result
→ mark session completed with previous result
```

---

## 4. 目标行为

1. 每轮执行必须有独立 finalization boundary。
2. 当前轮 finalization 只能使用当前轮 boundary 之后的 terminal events。
3. 当前轮没有 terminal event 时，不能继承旧 `result` / `error`。
4. 用户取消时标记为 `cancelled`。
5. 非取消但无 terminal event 时标记为 `failed` 或明确的 interrupted state，并写入可诊断错误。
6. 旧 session result 可以作为历史事件保留，但不能作为最新轮成功结果。

建议错误码：

```text
REQUEST_INTERRUPTED_WITHOUT_TERMINAL_EVENT
```

建议错误消息：

```text
The latest request ended without a result or error event. Previous turn results were not reused.
```

---

## 5. 非目标

- 不改变 provider adapter 的 fallback 口径，不允许 silent provider/model switch。
- 不扩大自动模型选择、默认 role model 推荐或 fallback 执行入口。
- 不把普通 tool timeout / recoverable tool failure 升级为 session fatal。
- 不引入 durable permission backend 或 resumable execution。
- 不在本切片中实现完整 Source Coverage Ledger。
- 不新增与 `Grep` 重叠的 `Search`，不新增路径搜索工具。

---

## 6. 分阶段修复方案

### Phase A: 最小 regression fixture

状态：已实现。

构造一个同一 session 多轮事件序列：

1. 第一轮或第二轮存在 terminal `result(success=true)`。
2. 新一轮写入 `user_message` / `session_started` / `user_intake_guidance` / provider prelude。
3. 新一轮没有 `result` / `error` / `execution_metrics`。
4. finalization 运行后不能返回旧轮 `completed`。

收口标准：

- 测试覆盖当前 bug 的最小重现。
- 当前轮无 terminal event 时，`resolveFinalSessionOutcome()` 或新 helper 返回 failed/interrupted outcome。
- outcome 中不能包含旧轮 result。

### Phase B: Current-turn boundary helper

状态：已实现。

建议新增小型 helper，而不是扩大 `runSessionFlow()` 主流程：

```typescript
type SessionTurnBoundary = {
  requestId: string
  startedAt: string
  sessionStartedEventKey?: number
}

type FinalSessionOutcome = {
  phase: SessionPhase
  result?: string
  error?: string
  code?: string
}
```

候选实现方式：

1. `runSessionFlow()` 创建 `requestId` 后记录当前轮 boundary。
2. 优先按 `requestId` 或当前 `session_started` event key 过滤 events。
3. 只把当前轮 boundary 之后的 `result` / `error` 传给 outcome resolver。
4. 若当前轮没有 terminal event：
   - abort signal aborted → `cancelled`；
   - otherwise → `failed` + `REQUEST_INTERRUPTED_WITHOUT_TERMINAL_EVENT`。

当前实现采用该最小方案：`runSessionFlow()` 在本轮执行中收集 `executeStream()` 产出的 events，finalization 只对这组 current-turn events 做 outcome resolution，并使用当前 `requestId` / `session_started` boundary 保护 helper。

### Phase C: Persisted state diagnostics

状态：已实现最小诊断。

当 current turn 没有 terminal event 时，应在 session error 或 metadata 中保留最小诊断：

```json
{
  "code": "REQUEST_INTERRUPTED_WITHOUT_TERMINAL_EVENT",
  "requestId": "req_...",
  "message": "The latest request ended without a result or error event. Previous turn results were not reused."
}
```

收口标准：

- CLI history / status 不再显示旧 result 作为最新成功结果。
- 用户可看到最新轮未完成，而不是误判为 completed。
- 不污染 provider-visible context。

### Phase D: Runtime terminal path audit

状态：Watch。

第三轮出现了 PreInvocation 和 `usage`，但没有 PostInvocation / terminal event / metrics。P0 修复优先保护 session finalization；随后再评估 runtime/provider path 是否存在未被 catch 的结束路径。

检查点：

- provider stream 中断后是否总能进入 `LLMCodingRuntime` catch path。
- abort / interruption 是否被 UI wrapper 提前吞掉。
- `executeStream()` async iterator 非异常结束但无 result 时是否应补 terminal event。
- execution metrics 是否应在 partial invocation 后保证落库。

---

## 7. P2 Evidence-scope Drift 样本

该 session 同时暴露了强声明证据覆盖不足的样本：

- recorded tool traces 主要为 `Read` 与 `ListDir`。
- 未观察到 `Grep` / `Glob` / `Bash git status`。
- 最终回答出现了部分项目级、全局状态级声明。

这类问题不应阻塞 P0 修复，但适合作为 `Source Coverage Ledger / Strong Claim Guard` 的真实样本。

### 7.1 轻量治理方向

只做 diagnostics / guidance，不做复杂审计系统：

- 当模型试图输出 git 状态、全局文件数量、全项目覆盖结论时，检查是否有对应证据类型。
- `ListDir` 标记为 directory inventory，不代表递归全项目覆盖。
- `Read` 标记为 source understanding，但 partial read 不代表文件整体或项目整体。
- `Grep` / `Glob` 是 locator / pattern coverage 证据，也不能单独支撑语义强声明。

### 7.2 候选诊断

```text
STRONG_CLAIM_WITH_LIMITED_EVIDENCE
```

建议仅作为 watch-only diagnostic，不阻断回答。

---

## 8. 验证命令

实现 P0 修复时建议使用：

```bash
npm run typecheck
npm test -- --runInBand test/runtime.test.ts
npm test -- --runInBand test/cli-run-session-flow.test.ts
npm run format:check
```

注意：只运行 check-only format validation；不要运行 broad auto-formatters。

---

## 9. 收口标准

P0 current-turn finalization 收口必须满足：

- 多轮 session 中，最新轮无 terminal event 不会继承旧 `result`。
- session phase 不会被旧 terminal event 错误标为 `completed`。
- 用户取消、provider interruption、async iterator 非正常结束有清晰状态表达。
- focused regression 覆盖 `session_9d985c5c-7c89-41b8-9d5e-cc672e412f00` 抽象出的最小事件序列。
- TODO 文档更新为已收口前，不移动到 DONE。

P2 evidence governance 收口必须满足：

- 只在真实会话继续暴露 evidence scope drift 时推进。
- 不新增重复工具。
- 不把 diagnostics 变成阻断回答的重型审计系统。
