# BabeL-O / Nexus 总控规划

## 口径

BabeL-O 是 BabeL-X 的 Nexus-first 重写版本。总控规划只回答三个问题：

1. 当前最应该做什么。
2. 各主线现在处于什么状态。
3. 细节应该去哪个专项文档维护。

完成事实、验证命令和真实会话复盘写入 [WORK_LOG.md](./WORK_LOG.md)。专项实现细节写入对应 `TODO_*.md`。本文件不再堆叠长篇历史记录。

```text
Nexus owns execution.
CLI owns interaction.
Tools and coding workflows stay first-class.
Legacy complexity is not imported by default.
```

## 当前优先级

| 优先级 | 任务 | 主文档 | 收口标准 |
| --- | --- | --- | --- |
| **P0** | **指令跟随性 / 上下文稳定 / provider 协议兼容** | [TODO_runtime.md](./TODO_runtime.md) | 多路径比较、短纠错、取消/超时后追问已纳入 P0 regression corpus 并由可审计 intake 事件判定；**Pivot Guard 第二版已由 `user_intake_guidance` 事件管线替代硬截断/regex 主分类**，短问候/状态/暂停不再丢弃旧上下文；pause/greeting/status intake 会被硬归一化为 `respond_only` + `requiresTools=false`；真实 session_321c48be replay 已覆盖 malformed greeting 与 cancel 后 pause；session_3ba2d788 replay 已覆盖长会话 tail loading、latestPrompt 优先级、intake explicitPaths 去信任与 MiniMax respond_only 工具硬拦截；`/context` 已展示 intent、tool suppression 与 recovery boundary 诊断；runtime 已新增 final-response-only 硬约束；provider error / empty response / context limit / max loops / max-output exhausted 等终态错误已纳入 recovery boundary，并输出失败 result；provider recovery 已带非静默 `fallbackPolicy`，禁止自动切换模型；`/v1/runtime/status` 与 `/status` 已展示 provider/model/auth/capability 与 provider smoke dry-run 诊断；`/v1/runtime/provider-smoke` 已提供 dry-run readiness 检查且不执行用户任务；`/v1/runtime/provider-smoke/live` 与 `/smoke live` 已提供显式 simple-text/tool-call live smoke，固定 prompt/固定 synthetic tool、不执行工具、不创建 session、不写 event、不自动切换模型；provider 协议 regression corpus 已覆盖 MiniMax 前后文本/未闭合 text tool_call、Anthropic malformed `input_json_delta`、OpenAI malformed 与并发 multi-tool arguments；MiniMax text-encoded tool_call 已归一为 Nexus tool invocation；DeepSeek `reasoning_content` 暂不处理。 |
| P1 | 子 Agent lifecycle / transcript / permission inheritance | [TODO_agents.md](./TODO_agents.md) | 子 Agent 已有正式 metadata、独立 child session transcript 引用、父队列任务摘要引用、permission inheritance 审计事件、父 session close 级联取消 smoke、单个 child cancel 结构化失败传播、session-scope approval 可配置继承 audit、远程 cancel/resume API、provider-backed 非 dry-run deterministic AgentLoop smoke，以及 `bbl optimize --provider-smoke-live` live/manual 入口与安全回归；下一步执行真实 provider live/manual smoke 或进入 SDK/dashboard task API。 |
| P1 | Provider role defaults 与 fallback 执行策略 | [TODO_provider_registry.md](./TODO_provider_registry.md), [TODO_runtime.md](./TODO_runtime.md) | 未配置 roles 时能按 planner/executor/critic 推荐合适模型；fallbackPolicy 事件详情已可解释且禁止静默切换，后续补显式用户确认后的执行入口。 |
| P1 | TUI 编程工作流与视觉 smoke | [TODO_tui.md](./TODO_tui.md) | slash palette、permission panel 真实键盘路径、compact 工具渲染、boxed input prompt、无外框 welcome header、启动 session banner 精简、长输入刷新清理、read/edit/diff/Grep/Glob/task create 编程流和 resume session 已有回归覆盖；下一步补 ask coding question、task update/status 入口，以及唯一输入框和 agent running 视觉 smoke。 |
| P1 | 安全加固：classifier 路径限制 + worktree 并发锁 | [TODO_runtime.md](./TODO_runtime.md) | cat 命令已限制 workspace 路径且 `$VAR`/`${VAR}` 展开进入人工 review；worktree create/merge-back/cherry-pick/remove/prune 与 optimizer stash/commit/rollback 已接入 per-cwd Git 互斥锁，并有并发 merge-back 回归。 |
| P2 | 性能、故障注入与 CI/build hardening | [TODO_performance.md](./TODO_performance.md), [TODO_cleanup.md](./TODO_cleanup.md) | 1000+ sessions/events 压测、storageBridge 故障注入、retry benchmark、生产 build/lint/CI 基线落地。 |

## 后续推进顺序

1. **P1 手动执行真实 provider live/manual AgentLoop smoke**：入口已落地为 `bbl optimize --provider-smoke-live`；下一步用真实 provider 跑固定临时 workspace / 固定 Read-only 任务并记录结果。
2. **P1 SDK / dashboard-facing session/task query API**：把 session、task、child sessions、tool trace、critic reason、usage 暴露为稳定可查询 data assets。
3. **P1 Provider role defaults 与显式 fallback 执行入口**：未配置 roles 时按 Planner/Executor/Critic/Optimizer 能力推荐模型；fallback 只在用户显式确认后执行，禁止 silent model switch。
4. **P1 TUI 编程工作流补齐**：补 ask coding question、task status/update 入口、agent running / 唯一输入框视觉 smoke。
5. **P2 build / lint / CI baseline**：生产 build、lint/format、CI、coverage report，固化当前 typecheck/test/smoke 门禁。

## 主线状态

| 主线 | 当前状态 | 下一步 |
| --- | --- | --- |
| Runtime / Context | 工具结果持久化与消息级预算已完成；execution state 注入（iteration/phase/files/budget）已实现；跨 turn 文件读取缓存（mtime 检查）已实现；compaction 后文件内容恢复已实现；workspace 限制改为 opt-in；工具循环接近上限时已进入 final-response-only 硬约束；session_321c48be 真实漂移已进入 replay regression；session_3ba2d788 latest user/intake 错位与 respond_only 工具穿透已修复并进入 replay regression；`/context` 可观测 intent/tool suppression/recovery boundary。 | 深化 P0 regression corpus 与真实会话 replay；DeepSeek `reasoning_content` replay 暂不处理。 |
| Agents / Optimize | Planner/Executor/Critic、subTasks、worktree isolation 已落地；TaskQueue 依赖失败传播已修复；structured-output repair 日志和 zodToJsonSchemaShape 已修复；子 Agent lifecycle metadata、transcriptPath 引用、permission inheritance 审计事件、父 session close 级联取消 smoke、单个 child cancel 结构化失败传播、session-scope approval 可配置继承 audit、远程 cancel/resume API、provider-backed 非 dry-run deterministic AgentLoop smoke 和 `bbl optimize --provider-smoke-live` 入口已落地。 | 手动执行真实 provider live/manual AgentLoop smoke，再补 SDK/dashboard session/task query API。 |
| Provider / Models | Anthropic/OpenAI-compatible adapter、usage/error 归一、retry、role routing、tool/structured capability gate 已落地；MiniMax text-encoded tool_call 已归一；provider 协议 regression corpus 已覆盖标准/partial/malformed/multi-tool 关键形态；provider recovery 已返回非静默 fallbackPolicy；runtime status/CLI status 已展示 provider/model/auth/capability 与 smoke dry-run 诊断；provider smoke dry-run 与显式 simple-text/tool-call live smoke 入口已落地。 | 默认 role model 推荐、显式 fallback 执行入口、DeepSeek thinking/reasoning replay 兼容、Moonshot/Ollama seed。 |
| CLI / TUI | slash/tool palette、多级权限面板、agent running 状态、事件层级渲染、context warning 展示、固定输入框、boxed input prompt、无外框 welcome header、启动 session banner 精简、长输入刷新清理、原生滚动、工具状态精简与原地完成更新、`/status` provider smoke dry-run 与 `/smoke` 入口已完成第一版；最小 PTY smoke 已覆盖 slash palette、permission panel 真实键盘路径、compact 工具渲染、input placeholder、read/edit/diff/Grep/Glob/task create 编程流和 resume session。 | ask coding question smoke、task update/status 入口、唯一输入框/agent running 视觉 smoke、MCP tool/resource display、worktree/multi-agent status polish。 |
| Performance / Storage | SQLite 持久化、tool traces、metrics、结构化 logger、storageBridge WAL、核心 benchmark 已落地。 | 1000+ sessions/events 压测、storageBridge 故障注入、AgentLoop 成本 benchmark、并发测试治理。 |
| Cleanup / Build | `docs/nexus` 已成为唯一文档中心；runtime 去重完成（toolExecutor.ts、app.ts prepareExecution、Git helpers 统一）；空 catch 块已修复。 | 在 P1 live smoke/API/role defaults/TUI 收口后，落地生产 build、lint/format、CI、coverage report。 |

## 文档索引

| 文档 | 维护内容 |
| --- | --- |
| [README.md](./README.md) | `docs/nexus` 入口、架构分层、历史文档合并口径。 |
| [TODO_runtime.md](./TODO_runtime.md) | Runtime、Nexus API、storage、security、context、compact、MCP、skills、permissions。 |
| [TODO_tool_result_budget.md](./TODO_tool_result_budget.md) | P0 工具结果持久化与消息级预算专项。 |
| [TODO_agents.md](./TODO_agents.md) | TaskSession、TaskQueue、AgentLoop、Planner/Executor/Critic、sub-agent、worktree。 |
| [TODO_provider_registry.md](./TODO_provider_registry.md) | Provider registry、adapter、role routing、model capability matrix。 |
| [TODO_tui.md](./TODO_tui.md) | `bbl chat`、输入框、slash/tool palette、permission panel、事件渲染。 |
| [TODO_performance.md](./TODO_performance.md) | benchmark、metrics、storage/API 性能、故障注入、并发治理。 |
| [TODO_cleanup.md](./TODO_cleanup.md) | 依赖治理、BabeL-X 迁入规则、build/CI/lint/coverage。 |
| [TODO_cli.md](./TODO_cli.md) | CLI 主题兼容导航页，不作为主规划源。 |
| [CONTEXT_GAP_ANALYSIS.md](./CONTEXT_GAP_ANALYSIS.md) | BabeL-O 与 BabeL-X 上下文能力差距分析和历史判断。 |
| [WORK_LOG.md](./WORK_LOG.md) | 事实性工作记录、验证命令和重要决策。 |

## 已完成但仍需守住的底线

- `docs/nexus` 是唯一长期文档目录；根 `docs/` 不再保留规划、审计、调优或 walkthrough 文档。
- Workspace path escape、invalid tool input、Bash non-zero exit、provider empty response 都必须作为可恢复信息回传模型，不能重新退化成全局中断。
- 明确路径、纠错句、短问候/状态追问必须进入 `user_intake_guidance` / User Intake Guidance；短问候/状态/暂停不能触发旧任务工具链，也不能硬丢旧上下文。
- 子 Agent 和 optimizer 默认优先隔离执行；in-place Git 操作必须避免纳入无关未跟踪文件或删除用户手动文件。
- TUI 权限面板的 Esc/Backspace 路径不能误批准。

## 维护规则

- 新任务必须写入对应专项 TODO；本文件只保留路线板和跨主线优先级。
- 完成事实只追加到 [WORK_LOG.md](./WORK_LOG.md)，不要复制到总控 TODO。
- 状态标为完成前，必须能对应到代码、测试、文档或明确验证命令。
- 若一个任务跨多个主线，只在总控保留一行优先级，细节由一个主文档承接，其他文档只做链接。
