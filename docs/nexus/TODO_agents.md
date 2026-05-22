# TODO Agents / TaskSession

## 目标

在 Nexus core 上建立可恢复、可观察、可审计的多 Agent 编程工作流。短期目标是 TaskSession/TaskQueue 稳定；中期目标是 Planner/Executor/Critic；长期目标是 AetheL / SDK / dashboard 可以可靠编排任务。

## 当前状态

- [x] `SessionSnapshot` 已存在。
- [x] `NexusTask` 已存在。
- [x] `TaskCreate` 工具已存在。
- [x] `/v1/sessions/:sessionId/tasks` 可列出任务。
- [x] `/v1/sessions/:sessionId/tasks` 可创建任务。
- [x] 已实现 TaskQueue。
- [x] 已实现 AgentLoop。
- [x] 已实现 Planner/Executor/Critic 以及 Optimizer 自优化角色。

## P1 TaskSession

- [x] 扩展 Session phase：`planning`、`executing`、`waiting_permission`、`waiting_user`、`reviewing`、`completed`、`failed`、`cancelled`。
- [x] 为 session 增加 `parentSessionId`。
- [x] 为 session 增加 `currentTaskId`。
- [x] 为 session 增加 `terminalReason`。
- [x] 为 session 增加 `pendingInput`。
- [x] 为 session 增加 `lastUserInput`。
- [x] 建立 session event append-only 语义。
- [x] 增加 `POST /v1/sessions/:id/input`。
- [x] 增加 session resume smoke。

## P1 TaskQueue

- [x] 引入 `queueId`。
- [x] task 支持 `dependsOn`。
- [x] task 支持 `blocks`。
- [x] task 支持 `ownerAgentId`。
- [x] task 支持 `retryCount`。
- [x] task 支持 `review`。
- [x] task 支持 `metadata`。
- [x] 实现 claim。
- [x] 实现 complete。
- [x] 实现 fail/requeue。
- [x] 实现 queue settled 判断。

## P2 Agent Roles

- [x] 定义 `AgentRoleDefinition`。
- [x] 定义 Planner schema。
- [x] 定义 Executor schema。
- [x] 定义 Critic schema。
- [x] 实现 mockable `runAgentLoop()`。
- [x] Planner 生成 TaskQueue。
- [x] Executor claim/complete task。
- [x] Critic review task result。
- [x] Critic rejected 时创建 fix task。
- [x] 支持 `reviewMode=none|critic`。

## P2 Runtime Integration

- [x] AgentLoop 使用真实 provider runtime。
- [x] role model preference 接入 provider registry。
- [x] role 输出使用 structured output。
- [x] 解析失败时保存 raw output。
- [x] AgentLoop events 写入 session events。
- [x] CLI 可触发 `sessions resume --run-agent-loop` (或 cli 中已集成 optimize 执行)。

## P3 AetheL / SDK / Dashboard

- [ ] 定义外部 SDK task API。
- [ ] 定义 dashboard session/task query API。
- [ ] 支持 human-in-the-loop。
- [ ] 支持远程取消和恢复。
- [ ] 将 tool trace、critic reason、usage 变成可查询 data assets。

## 验证命令

- [x] `npm test` 中包含的 `test/agent-loop.test.ts`
- [x] `npm test` 中包含的 `test/optimizer-safety.test.ts`
- [ ] 真实 provider 下的 AgentLoop smoke (通过 bbl optimize 手动验证)

## 参考文件

- `src/shared/session.ts`
- `src/shared/task.ts`
- `src/tools/builtin/task.ts`
- `src/nexus/app.ts`
