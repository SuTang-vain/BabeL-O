# TODO Agents / TaskSession

## 目标

在 Nexus core 上保持可恢复、可观察、可审计的多 Agent 编程工作流。本文只记录 TaskSession、TaskQueue、AgentLoop、Planner/Executor/Critic、sub-agent、worktree 与 optimizer 仍未收口的开发项。已完成能力移入 [DONE.md](../DONE.md)，事实流水写入 [WORK_LOG.md](../WORK_LOG.md)。

## 当前状态

- TaskSession、TaskQueue、Planner/Executor/Critic、Optimizer、`bbl optimize`、Planner HITL、受控 sub-agent、跨 session 子 Agent、worktree isolation、in-place Git hardening、session assets query API 与 AgentScheduler API/CLI 管理层均已落地。
- `bbl optimize --provider-smoke-live` 入口已通过 mocked provider 安全回归与 MiniMax-M3 真实 provider live/manual smoke；role diagnostics、timeout abort、partial session diagnostics、Optimizer error/last-tool preview、`agent_loop_timeout` 分类、Zod v4 role JSON Schema 转换、MiniMax text-tool / stream finish 处理与非 git 临时 workspace 保护均已落地。
- Dashboard/SDK 只读 assets snapshot、task mutation API、外部 cancel 级联、fail/retry 依赖传播、approve/reject pending-review 边界、active/terminal session 与 worktree task 写操作 smoke 均已落地。
- 自动模型选择、默认 role model 推荐与显式 fallback 执行入口已无限期 delay。
- AgentLoop structured output repair 已落地：Planner 空计划触发更小任务列表 repair，Executor/Optimizer 保留 raw output 修复结构化结果，Critic 修复失败时 conservative reject / needs-human-review。
- Review/Test Agent profiles、AgentScheduler governance、独立 `agent_job_event` schema 与 persistent AgentJob storage 已收口：`review` / `test` 默认复用 `task-focused` fork，允许 `Read/Grep/Glob` 与受限 Bash check-only 命令，不开放编辑权限；scheduler 已具备 max concurrent agents、max depth、timeout 与 job/status diagnostics；AgentJob 生命周期事件已升级为独立 top-level Nexus event，job 状态已支持 Memory/SQLite 持久化、重启后 list/wait/cancel 可见。AgentLoop 维护性拆分第一片也已收口。后续再评估 Implement/worktree。

## P2 Worktree / Git Hardening

非隔离 in-place optimizer 默认谨慎已收口：Git workspace 中的 optimizer in-place task 需要 `--allow-in-place-optimizer` / `BABEL_O_ALLOW_IN_PLACE_OPTIMIZER=1` 或 per-task confirmation，worktree 创建失败不再静默 fallback 到 in-place；task 前后与 resolution 后会记录 Git status snapshot。底线保持：不使用 `git add .`、不使用 `git reset --hard`、不使用 `git clean -fd`。

## P1 Model-visible AgentScheduler / Explore Agent

> 统一规划见 [context-and-subagent-upgrade-plan.md](../reference/context-and-subagent-upgrade-plan.md)。现有 `runAgentLoop` sub-agent 能力继续保留；新增模型可见 agent jobs 必须作为独立 `AgentScheduler` 层落地，不能混入 `RemoteToolRunner`。

Agent core types 与基础 profiles 已收口：`src/nexus/agents/types.ts` 定义 `AgentJob`、`AgentResult`、`AgentProfile`、`ContextForkMode` 与 scheduler 接口占位，`AgentProfiles.ts` 已启用 `explore`、`review`、`test` profiles；`explore` 仅允许 `Read/Grep/Glob`，`review` / `test` 允许 `Read/Grep/Glob` 与受限 Bash check-only 命令。

In-memory `AgentJobRegistry` 已收口：`src/nexus/agents/AgentJobRegistry.ts` 覆盖 queued/running/waiting_permission/completed/failed/cancelled 状态转换、list/filter、wait timeout、cancel、defensive clone 与 transcript reference-only contract；`test/agent-job-registry.test.ts` 已纳入默认 `npm test`。

Read-only Explore Agent MVP 已收口：`ExploreAgentScheduler` 作为独立 AgentScheduler 层创建 child session/job、执行 read-only child runtime、归一 structured `AgentResult`，`ContextForker.ts` 提供 minimal fork，`AgentTools.ts` 提供 `AgentSpawn`、`AgentWait`、`AgentList`、`AgentCancel`；默认仅允许 `Read/Grep/Glob`，Agent tools 需 `enableAgentTools` / `BABEL_O_ENABLE_AGENT_TOOLS=1` 显式开启，不改变既有 `runAgentLoop()`。

AgentScheduler API / CLI 管理层已收口：`createDefaultNexusRuntime()` 创建共享 `ExploreAgentScheduler`，`createNexusApp()` 暴露 `/v1/agents` spawn/list/get/wait/cancel/transcript 与 `/v1/sessions/:sessionId/agents`，`bbl agents` 提供 spawn/list/show/wait/cancel/transcript/session 管理命令，transcript 默认仍按需查询。

Review/Test Agent profiles 已收口：`review` / `test` 复用 `task-focused` ContextForker，child runtime role 分别为 `review` / `test`，默认不允许 Edit/Write；Bash 只允许 `npm run typecheck`、`npm run format:check`、`npm run deps:audit` 与 focused `npx tsx --test ...`，支持隔离的 `BABEL_O_CONFIG_FILE=/tmp/...` 前缀。

Go Runner 不是 AgentScheduler 的前置条件，也不能承接调度职责。Explore Agent remote execution smoke 已验证 scheduler-level `executionEnvironment: remote`（service/embedded 可用 `NEXUS_AGENT_EXECUTION_ENVIRONMENT=remote` 显式 opt in）可通过 Go Runner 执行 read-only `Read/Grep/Glob`，且不把 Go Runner 或 execution environment 作为 `AgentSpawn` 的模型可见输入。

AgentScheduler governance 已收口：`ExploreAgentScheduler` 现在限制 max concurrent agents、max depth，并在 job/child session/parent event/tool output 中暴露 maxRuntimeMs、timeoutAt、depth、active/max concurrent diagnostics；超时 job 会以 `AGENT_JOB_TIMEOUT` failed 状态收口，不再混同手动 cancel。

AgentJob 生命周期事件 schema 已决策并收口：新增 top-level `agent_job_event`，覆盖 queued/started/completed/failed/cancelled，并携带 jobId、childSessionId、agentType、contextForkMode、status、governance、result/error；`task_session_event` 保留给 AgentLoop/TaskSession 旧事件使用。

Persistent AgentJob storage 已按最小范围收口：`NexusStorage` / Memory / SQLite 支持 save/get/list AgentJob，`ExploreAgentScheduler` 启动后可 hydrate persisted jobs，重启后 `/v1/agents` list/get/wait/cancel 可见既有 job 状态；非当前进程 running 的非终态 job 只暴露状态，不自动恢复执行。

Implement profile 评估已收口：当前不启用 `implement` AgentScheduler profile，不向模型可见 child agent 开放 Edit/Write，也不把 `ExploreAgentScheduler` 小改成写 capable scheduler。未来实现前必须先落地 Nexus-owned worktree lifecycle、child cwd/allowedPaths 收窄、changed files/diff 摘要、parent review、merge/reject/recovery flow、merge conflict preserved worktree 处理，以及独立写安全策略；`runAgentLoop()` 现有 optimizer/worktree flow 继续作为写 capable orchestration 的 source of truth。

## P2 Sub-agent Tooling / Role Assistance

Agent role capability diagnostics 已收口：Planner/Executor/Critic/Optimizer runtime role step、`agent_loop_role_step_metrics` 与 AgentLoop live smoke per-role diagnostics 已展示当前 provider/model、context window、default max tokens、tool/json/structured/streaming、role suitability、missing capabilities 与人工切换提示；capability mismatch 会以 `AGENT_ROLE_CAPABILITY_MISMATCH` 诊断收口，且不会触发 runtime/provider 调用、自动模型选择、fallback execution 或 silent switch。

`runAgentLoop` ↔ AgentScheduler bridge 评估与只读状态视图已收口：当前不迁移执行路径，不让 AgentScheduler 承接 Planner/Executor/Critic/Optimizer task orchestration。`runAgentLoop()` 继续拥有 optimize/task workflow、subTasks、retry/critic、worktree isolation/merge/recovery、permission inheritance 与 `task_session_event` lifecycle；AgentScheduler 继续拥有模型可见 Explore/Review/Test jobs、ContextForker、AgentJob governance、persistent AgentJob storage 与 `agent_job_event` lifecycle。CLI `/agents` 已以只读方式聚合 AgentJob 与 AgentLoop sub-agent lifecycle 展示状态，不做 execution bridge、不重写 AgentLoop、不改变权限或模型切换行为。

## P2 AgentLoop Maintainability

AgentLoop helper 拆分已继续收口：`src/nexus/agentLoopSubAgents.ts` 承载 sub-agent session id、lifecycle metadata、permission inheritance、parent reference、task orchestration context、subtask normalization 与 session summary 等纯 helper；`src/nexus/agentLoopWorktree.ts` 承载 optimizer Git stash/commit/rollback、Git status snapshot 与 in-place optimizer approval helper。`runAgentLoop()` 主状态机、executor/critic/retry step、worktree recovery、structured output repair 与 benchmark 路径保持不重写。

后续只在维护压力继续出现时再按需评估 `agentLoopTaskOrchestration.ts` 或等价模块；保留 `runAgentLoop()` 主流程在原文件，暂不拆 executor/critic/retry step。每次拆分必须覆盖 `test/agent-loop.test.ts`、`test/worktree.test.ts`、`test/agent-loop-benchmark.test.ts` 与 `npm run typecheck`。

## 验证命令

历史验证覆盖：`npm test` 中的 AgentLoop、optimizer safety、worktree、sub-agent lifecycle、session assets mocked smoke；`bbl optimize --provider-smoke-live --model minimax/MiniMax-M3 --timeout-ms 120000` 手动真实 provider smoke；SDK task mutation API smoke；以及 `npm run benchmark` 中的 mocked AgentLoop cost benchmark。AgentScheduler 已补 `test/agent-profiles.test.ts`、`test/agent-job-registry.test.ts`、`test/context-forker.test.ts`、`test/agent-scheduler.test.ts`、`test/agent-tools.test.ts`、`test/agent-tools-runtime.test.ts`、`test/agent-api.test.ts` 与 `test/agents-command.test.ts` 并纳入默认 `npm test`。Go Runner 相关 Agent smoke 必须显式 gated，不进入默认无 Go 环境的 `npm test`。

## 参考文件

- `src/nexus/agentLoop.ts`
- `src/nexus/runtimeAgentStep.ts`
- `src/nexus/taskQueue.ts`
- `src/nexus/taskSession.ts`
- `src/nexus/sessionAssets.ts`
- `src/cli/commands/optimize.ts`
- `test/agent-loop.test.ts`
- `test/worktree.test.ts`
