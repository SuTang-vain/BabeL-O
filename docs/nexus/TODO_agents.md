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
- [x] AgentLoop 支持受控 subTasks 委派第一版，Executor/Optimizer 可拆分实质子任务，父任务等待子任务完成后再收口。
- [x] `bbl optimize` 已暴露 subAgents 参数：`--enable-subagents`、`--max-sub-agent-depth`、`--max-sub-tasks-per-task`。
- [x] Agent role 工具策略已接入 provider 可见工具过滤，Planner 只暴露只读工具，避免模型看到不可用工具后触发 denied。
- [x] `bbl optimize` 非 dry-run 前已接入 Planner human-in-the-loop 第一版，支持确认、编辑任务标题/描述、拒绝计划。
- [x] CLI Task Status Board 已展示父任务 blocked、子任务层级、parentTaskId 和 delegatedSubTaskIds。

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

- [x] 渐进实现 AgentTool 语义：不迁移 BabeL-X `AgentTool.tsx`，先让 Executor 能创建 sub-task，由 TaskQueue 调度。
- [x] Executor output schema 增加 `subTasks` 字段，支持 title/description/requiresIsolation。
- [x] `runAgentLoop()` 增加 `enableSubAgents`、`maxSubAgentDepth` 与 `maxSubTasksPerTask`，防止无限递归和过量派生。
- [x] 父任务委派后转为 blocked，子任务完成后自动回到 pending，由 Executor 汇总收口。
- [x] `bbl optimize --dry-run --enable-subagents` 真实 provider smoke 已验证可读取目标目录并产出结构化计划。
- [x] 支持 human-in-the-loop 第一版：Planner 产出任务列表后可等待用户确认/编辑/拒绝，拒绝会取消 TaskSession 并记录 terminal reason。
- [x] 支持 subTasks 可视化第一版：CLI 事件渲染会显示父任务 blocked、子任务缩进层级、parent/delegated 元信息。
- [x] 支持 worktree 隔离第一版：带 `requiresIsolation` metadata 的任务会在 Git worktree 中执行，审核通过后 commit 并 cherry-pick 回主工作区，完成后清理临时 worktree。
- [x] 支持跨 session task 委派并实现动态子 Agent。
- [x] 解决嵌套隔离 Worktree 合并及 cherry-pick 范围回传，实现冲突文件精确提取与错误诊断，完成子代理嵌套隔离测试。
- [ ] 非隔离 in-place optimizer 的 Git 操作继续加固：避免 `git add .` 纳入无关未跟踪文件，避免 `git reset --hard` / `git clean -fd` 删除用户手动创建但未纳入本次任务的文件。
- [ ] 将 worktree isolation 设为 optimizer/sub-agent 的默认推荐执行路径；in-place 模式需要显式 opt-in 或用户确认。
- [ ] AgentLoop 增加低成本执行模式：支持 `--no-critic` 或 role 配置关闭 Critic，减少简单任务的多角色 LLM 往返成本。
- [ ] 定义外部 SDK task API。
- [ ] 定义 dashboard session/task query API。
- [ ] 支持远程取消和恢复.
- [ ] 将 tool trace、critic reason、usage 变成可查询 data assets.

## 验证命令

- [x] `npm test` 中包含的 `test/agent-loop.test.ts`
- [x] `npm test` 中包含的 `test/optimizer-safety.test.ts`
- [x] subTasks 委派、父任务恢复与 maxSubAgentDepth 防递归测试已纳入 `test/agent-loop.test.ts`
- [x] `bbl optimize --dry-run --enable-subagents --target <tmpdir>` 真实 provider Planner smoke 已通过.
- [x] Planner review approve/edit/reject 测试已纳入 `test/agent-loop.test.ts`。
- [x] subTasks 层级渲染测试已纳入 `test/tui-renderer.test.ts`。
- [x] worktree 生命周期与冲突提取测试已纳入 `test/worktree.test.ts`，AgentLoop 隔离执行以及子代理嵌套隔离合并测试已纳入 `test/agent-loop.test.ts`。
- [ ] 非 dry-run 的真实 provider AgentLoop smoke。

## 参考文件

- `src/shared/session.ts`
- `src/shared/task.ts`
- `src/tools/builtin/task.ts`
- `src/nexus/app.ts`
