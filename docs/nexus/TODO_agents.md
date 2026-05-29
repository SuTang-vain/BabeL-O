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
- [x] 依赖失败传播：`propagateFailures` 级联标记下游任务为 failed，防止死锁 (2026-05-28)。

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
- [x] structured-output repair: `tryParseWithRepair` 添加 logger.debug 日志；`zodToJsonSchemaShape` 对 ZodUnknown/ZodAny/fallback 返回 `{ type: 'object' }` 而非 `{}` (2026-05-28)。

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
- [x] 非隔离 in-place optimizer 的 Git 操作继续加固：避免 `git add .` 纳入无关未跟踪文件，避免 `git reset --hard` / `git clean -fd` 删除用户手动创建但未纳入本次任务的文件。
- [x] 参考 BabeL-X `AgentTool.tsx` / `runAgent.ts` 的生命周期治理，为 BabeL-O 子 Agent 定义正式 `agentId`、`parentAgentId`、`parentTaskId`、`depth`、`agentType`、`status`、`transcriptPath` 元数据。
- [x] 子 Agent 启动时记录 `subagent_started` 事件：包含 parent session、queueId、taskId、depth、cwd/worktreeCwd、role、allowedTools、permissionMode。
- [x] 子 Agent 完成时记录 `subagent_completed` / `subagent_failed` / `subagent_cancelled`：包含摘要、结果事件范围、修改文件、commit hash、失败类型、retry 建议。
- [x] 为跨 session 子 Agent 保存独立 transcript：父 session 只保存摘要和 transcript 引用，避免父上下文被子任务完整工具链撑爆。
- [x] 子 Agent resume：给 parent session 提供可查询子 transcript 路径和最近状态，允许后续命令恢复或查看子 Agent 详细日志。
- [x] 子 Agent cancel：父 session 取消时级联取消未完成子 session；单个子 session 取消时父任务应收到结构化失败结果并可重排/收口。
- [x] 子 Agent permission inheritance：默认继承父 session 的 deny-by-default 和 CLI arg allow rules，但不继承临时 once approval；session-scope approval 是否继承必须可配置并写入 audit。
- [x] 子 Agent MCP inheritance：默认只继承父 runtime 已显式 allowlisted 的 MCP tools；agent-specific MCP server 延后，避免前置引入插件级复杂度。
- [x] 子 Agent skill/context inheritance：继承当前匹配 inline skills 和 explicit path anchors；只读 Explore/Plan 类任务可裁剪 gitStatus/大体积 project memory。
- [x] 子 Agent worktree notice：当子 Agent 在隔离 worktree 内运行时，在 system/additional context 中注入 parent cwd、worktree cwd、路径转换规则、变更隔离说明。
- [x] 子 Agent 输出契约：要求输出 `Scope`、`Result`、`Key files`、`Files changed`、`Issues` 等稳定字段，父 Agent 汇总时优先读取结构化摘要，不扫描完整 transcript。
- [x] 防无限派生加强：除 max depth/max tasks 外，增加同 parentTaskId 重复委派检测、相同 title/description 去重、失败子任务 retry 上限。
- [x] 成本控制：提供 `--no-critic`、`--subagent-model`、`--subagent-max-turns` 或 role 配置，避免简单任务触发过多模型往返。
- [x] 将 worktree isolation 设为 optimizer/sub-agent 的默认推荐执行路径；in-place 模式需要显式 opt-in 或用户确认。
- [x] AgentLoop 增加低成本执行模式：支持 `--no-critic` 或 role 配置关闭 Critic，减少简单任务的多角色 LLM 往返成本。
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
- [x] in-place optimizer Git hardening 测试已纳入 `test/agent-loop.test.ts`，worktree pathspec staging 测试已纳入 `test/worktree.test.ts`。
- [ ] 非 dry-run 的真实 provider AgentLoop smoke。
  - 2026-05-24 已用临时 Git 仓库执行真实 `bbl optimize --enable-subagents` 非 dry-run smoke：Planner/工具调用/rollback 链路运行，但 executor 多轮失败后 TaskQueue settled，临时仓库保持干净。下一步需诊断 executor 失败细节展示与真实 provider 输出稳定性后再标完成。
  - 2026-05-24 复跑诊断后确认：Planner 空 JSON 已可 fallback；当前主要失败类型为 Optimizer/Executor structured output 缺字段，以及 provider 空响应。下一步需做 role structured-output repair/retry 或 role model routing，再继续标完成。
  - 2026-05-24 AgentLoop/CLI 已能展示 structured-output 失败类型、缺失必填字段、候选来源和输出预览；下一步复跑 smoke 时应优先根据 `structured=schema_mismatch` / `structured=no_structured_json` / `EMPTY_PROVIDER_RESPONSE` 分流到 repair/retry 或 role model routing。
- [ ] 子 Agent lifecycle 单元测试：started/completed/failed/cancelled 事件、depth、parentTaskId、transcriptPath、permission inheritance。
- [ ] 子 Agent transcript 压缩测试：父 session 只注入子任务摘要，不把完整子工具链放入 recent context。
- [ ] 子 Agent cancel/resume smoke：父任务 blocked 时取消子 Agent，确认父任务能恢复为 failed/requeued 或终态 cancelled。
- [ ] 子 Agent worktree notice smoke：子 Agent 在 worktree 中正确读取目标文件、提交修改并回传父工作区。

## 参考文件

- `src/shared/session.ts`
- `src/shared/task.ts`
- `src/tools/builtin/task.ts`
- `src/nexus/app.ts`
