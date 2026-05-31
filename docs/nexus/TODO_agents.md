# TODO Agents / TaskSession

## 目标

在 Nexus core 上保持可恢复、可观察、可审计的多 Agent 编程工作流。本文只记录 TaskSession、TaskQueue、AgentLoop、Planner/Executor/Critic、sub-agent、worktree 与 optimizer 仍未收口的开发项。已完成能力移入 [DONE.md](./DONE.md)，事实流水写入 [WORK_LOG.md](./WORK_LOG.md)。

## 当前状态

- TaskSession、TaskQueue、Planner/Executor/Critic、Optimizer、`bbl optimize`、Planner HITL、受控 sub-agent、跨 session 子 Agent、worktree isolation、in-place Git hardening、session assets query API 均已落地。
- `bbl optimize --provider-smoke-live` 入口已存在，并已通过 mocked provider 安全回归；当前缺口是手动运行真实 provider，验证 structured output、role routing 与工具调用稳定性。
- Dashboard/SDK 只读 assets snapshot 已落地；下一步需要把 task 写操作稳定成外部可用 mutation API。

## P1 Real Provider Live / Manual Smoke

- [ ] 手动执行真实 provider live/manual AgentLoop smoke。
  - 推荐命令：`bbl optimize --provider-smoke-live --model <provider/model>`。
  - 记录 provider/model/profile、Planner structured output、role routing、Read-only 工具调用、Critic 结果、fallback policy、临时 workspace 清理结果。
  - 若失败，必须把失败分到具体类别：`schema_mismatch`、`no_structured_json`、`EMPTY_PROVIDER_RESPONSE`、tool denied、tool failed、role capability gate、provider protocol error。
  - 将真实失败样本固化到 deterministic regression fixture 后，再修 adapter、role prompt、structured-output repair 或 model routing。
- [ ] 给 live/manual smoke 增加可选诊断输出。
  - 输出每个 role 的模型、工具白名单、structured parse source、repair/retry 次数、token/耗时、失败摘要。
  - 默认隐藏 API key、baseUrl credential、完整 provider raw body；需要 debug 时只写入本地安全日志。

## P1 SDK Task Mutation API

- [ ] 定义外部 SDK task mutation API。
  - 覆盖 create、update title/description/status/metadata、cancel、retry、approve/reject、claim/complete/fail 的最小稳定写接口。
  - 每个 mutation 必须写入 session event audit，包含 actor、source、previous state、next state、reason、taskId、parentTaskId。
  - 幂等 mutation 需要 request id 或 revision guard，避免 dashboard/SDK 重试导致重复子任务或重复 cancel。
- [ ] 将 mutation API 与现有 TaskQueue/TaskSession 生命周期合并。
  - 外部 cancel 需要级联 child sessions 和 blocked parent task。
  - retry/fail 需要复用依赖失败传播语义，避免 settled 判断与外部写入竞态。
  - approve/reject 不能绕过 Planner HITL 与 permission audit。
- [ ] 补 SDK/dashboard 写操作 smoke。
  - MemoryStorage 与 SqliteStorage 都要覆盖。
  - 覆盖 active session、completed session、cancelled session、child session、worktree task、failed dependency。

## P2 AgentLoop Robustness

- [ ] 将真实 provider smoke 中暴露的 structured output 失败转化为 role-specific repair 策略。
  - Planner：空 JSON 或任务过大时优先重问更小任务列表。
  - Executor/Optimizer：缺 `status/result/summary` 时保留 raw output 并请求同模型修复一次。
  - Critic：无法结构化时允许降级为 conservative reject 或 explicit needs-human-review。
- [ ] AgentLoop 成本与失败率 benchmark。
  - 记录 Planner/Executor/Critic/SubAgent 调用次数、tokens、耗时、失败类型。
  - 用数据决定 Critic/sub-agent 默认开启策略，而不是凭体验判断。
- [ ] 子 Agent transcript 查询与恢复 UX。
  - 当前 metadata/transcriptPath 已具备；还需要 CLI/API 提供稳定查看 child transcript 摘要、展开详情、重新运行失败子任务的入口。

## P2 Worktree / Git Hardening

- [ ] 冲突人工恢复策略。
  - 当 isolated worktree merge-back/cherry-pick 冲突时，产出明确恢复步骤、冲突文件列表、父/子 commit、临时 worktree 路径。
  - 提供继续、放弃、保留 worktree 的后续入口；默认不删除用户可能需要排查的冲突现场。
- [ ] 非隔离 in-place optimizer 继续默认谨慎。
  - 保持不使用 `git add .`、不使用 `git reset --hard`、不使用 `git clean -fd` 的底线。
  - 若必须 in-place，要求显式确认或配置 opt-in，并记录 Git status before/after。

## 验证命令

- [x] `npm test` 中的 AgentLoop、optimizer safety、worktree、sub-agent lifecycle、session assets mocked smoke。
- [ ] `bbl optimize --provider-smoke-live --model <provider/model>` 手动真实 provider smoke。
- [ ] SDK task mutation API smoke：MemoryStorage + SqliteStorage。
- [ ] AgentLoop cost benchmark。

## 参考文件

- `src/nexus/agentLoop.ts`
- `src/nexus/runtimeAgentStep.ts`
- `src/nexus/taskQueue.ts`
- `src/nexus/taskSession.ts`
- `src/nexus/sessionAssets.ts`
- `src/cli/commands/optimize.ts`
- `test/agent-loop.test.ts`
- `test/worktree.test.ts`
