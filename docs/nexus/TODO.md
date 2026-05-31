# BabeL-O / Nexus 总控规划

## 口径

BabeL-O 是 BabeL-X 的 Nexus-first 重写版本。总控规划只回答三个问题：

1. 当前最应该做什么。
2. 各主线现在处于什么状态。
3. 细节应该去哪个专项文档维护。

当前文件只维护未收口优先级。已完成能力移入 [DONE.md](./DONE.md)，事实流水与验证命令写入 [WORK_LOG.md](./WORK_LOG.md)。

```text
Nexus owns execution.
CLI owns interaction.
Tools and coding workflows stay first-class.
Legacy complexity is not imported by default.
```

## 当前优先级

| 优先级 | 任务 | 主文档 | 收口标准 |
| --- | --- | --- | --- |
| **P0** | **真实会话指令跟随回归守门** | [TODO_runtime.md](./TODO_runtime.md) | 暂无打开的 P0 功能项；一旦出现“最新用户指令被旧上下文带偏、工具错误后忘记上下文、短追问触发旧工具链、provider 协议污染 assistant 文本”等真实回归，先补最小 regression corpus，再修 runtime/adapter/TUI。 |
| **P1** | **手动真实 provider live/manual AgentLoop smoke** | [TODO_agents.md](./TODO_agents.md) | 运行 `bbl optimize --provider-smoke-live --model <provider/model>`，记录真实 provider 的 structured output、role routing、Read-only 工具调用、critic 完成情况、fallbackPolicy 和临时 workspace 清理结果。 |
| **P1** | **外部 SDK task mutation API** | [TODO_agents.md](./TODO_agents.md), [TODO_runtime.md](./TODO_runtime.md) | 在已完成 session assets query API 之后，提供稳定 task create/update/cancel/retry/approve/reject 写接口；写操作必须保留审计事件、权限边界和子 Agent 状态一致性。 |
| **P1** | **Provider role defaults 与显式 fallback 执行入口** | [TODO_provider_registry.md](./TODO_provider_registry.md), [TODO_runtime.md](./TODO_runtime.md) | 未配置 roles 时按 Planner/Executor/Critic/Optimizer 能力推荐模型；provider recovery 只能生成用户可确认的行动计划，执行切换模型/provider/profile 前必须显式确认，保持 `allowSilentModelSwitch=false`。 |
| **P1** | **TUI 编程闭环与视觉 smoke 收口** | [TODO_tui.md](./TODO_tui.md) | 补 ask coding question about files、task update/status、run sub-agent/AgentLoop、唯一输入框截图/smoke、agent running indicator smoke；MCP tool/resource display 可作为同轮或下一轮补齐。 |
| **P2** | **Build / lint / CI / performance hardening** | [TODO_cleanup.md](./TODO_cleanup.md), [TODO_performance.md](./TODO_performance.md) | 生产 build、lint/format、CI、coverage report、1000+ sessions/events 压测、storageBridge 故障注入、AgentLoop 成本 benchmark、并发测试治理。 |

## 后续推进顺序

1. **真实 provider live/manual AgentLoop smoke**：优先验证已经落地的 `--provider-smoke-live` 在真实模型上的稳定性。
2. **SDK task mutation API**：把 dashboard/session assets 的只读能力补成可控写接口。
3. **Provider defaults + fallback execution**：先推荐/计划，再由用户确认执行，禁止静默切换。
4. **TUI 剩余 smoke**：补 ask coding、task update/status、sub-agent/AgentLoop、唯一输入框和 agent running 视觉回归。
5. **工程化门禁**：build/lint/CI/coverage/performance/故障注入。

## 主线状态

| 主线 | 当前状态 | 下一步 |
| --- | --- | --- |
| Runtime / Context | 指令跟随、context compact、token estimator、provider recovery、DeepSeek reasoning replay、hooks 最小内核已进入可验证状态。 | 继续守 P0 regression corpus；推进 fallback 执行入口、Session Memory Lite 后台化、Architecture Boundary。 |
| Agents / Optimize | AgentLoop、sub-agent、worktree、provider smoke 入口、session assets query API 已落地。 | 手动真实 provider live/manual smoke；补外部 SDK task mutation API。 |
| Provider / Models | Registry、adapters、role routing、capability gates、diagnostics、smoke、MiniMax/DeepSeek 协议兼容已落地。 | 默认 role model 推荐、fallback 执行入口、Moonshot/Ollama seed、models inspect 细节补齐。 |
| CLI / TUI | slash/tool palette、permission panel、boxed input、paste placeholder、层级渲染、PTY 基线已落地。 | ask coding question、task update/status、AgentLoop/sub-agent、唯一输入框和 agent running 视觉 smoke、MCP tool/resource display。 |
| Performance / Storage | SQLite、tool traces、metrics、storageBridge WAL、benchmark、session assets 已落地。 | 1000+ sessions/events 压测、storageBridge 故障注入、AgentLoop 成本 benchmark、并发测试治理。 |
| Cleanup / Build | `docs/nexus` 为唯一长期文档中心；runtime 去重和结构化 logger 已完成。 | 生产 build、lint/format、CI、coverage、依赖边界。 |

## 文档索引

| 文档 | 维护内容 |
| --- | --- |
| [README.md](./README.md) | `docs/nexus` 入口、架构分层、历史文档合并口径。 |
| [TODO_runtime.md](./TODO_runtime.md) | Runtime、Nexus API、storage、security、context、compact、MCP、skills、permissions 的未收口项。 |
| [TODO_agents.md](./TODO_agents.md) | TaskSession、TaskQueue、AgentLoop、Planner/Executor/Critic、sub-agent、worktree 的未收口项。 |
| [TODO_provider_registry.md](./TODO_provider_registry.md) | Provider registry、adapter、role routing、model capability matrix 的未收口项。 |
| [TODO_tui.md](./TODO_tui.md) | `bbl chat`、输入框、slash/tool palette、permission panel、事件渲染的未收口项。 |
| [TODO_performance.md](./TODO_performance.md) | benchmark、metrics、storage/API 性能、故障注入、并发治理。 |
| [TODO_cleanup.md](./TODO_cleanup.md) | 依赖治理、BabeL-X 迁入规则、build/CI/lint/coverage。 |
| [TODO_cli.md](./TODO_cli.md) | CLI 主题兼容导航页，不作为主规划源。 |
| [TODO_tool_result_budget.md](./TODO_tool_result_budget.md) | 已完成的工具结果持久化与消息级预算历史设计。 |
| [DONE.md](./DONE.md) | 已完成能力索引与守住底线。 |
| [WORK_LOG.md](./WORK_LOG.md) | 事实性工作记录、验证命令和重要决策。 |

## 维护规则

- 新任务必须写入对应专项 TODO；本文件只保留路线板和跨主线优先级。
- 完成事实先追加到 [WORK_LOG.md](./WORK_LOG.md)，再把完成能力索引移动到 [DONE.md](./DONE.md)。
- TODO 中原则上只保留 `[ ]` 未收口项；少量 `[x]` 只允许作为同一小节的上下文锚点。
- 状态标为完成前，必须能对应到代码、测试、文档或明确验证命令。
- 若一个任务跨多个主线，只在总控保留一行优先级，细节由一个主文档承接，其他文档只做链接。
