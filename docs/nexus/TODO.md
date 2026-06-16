# BabeL-O / Nexus 总控规划

## 口径

BabeL-O 是以 Nexus 服务端为核心（Nexus-first）的通用泛化 AI 智能体。总控 TODO 只保留当前仍会影响开发排序的打开项；已完成能力索引移入 [DONE.md](./DONE.md)，事实流水与验证命令写入 [WORK_LOG.md](./WORK_LOG.md)。

```text
Nexus owns execution.
CLI owns interaction.
Tools and coding workflows stay first-class.
Legacy complexity is not imported by default.
```

维护原则：

- 本文件回答“当前最应该做什么”，不承载历史长账。
- 具体任务写入对应 [active/](./active/) 专项 TODO。
- 长期设计、边界和非目标写入 [reference/](./reference/)。
- Watch / Closed 项只在下表保留短索引；完整完成事实见 [DONE.md](./DONE.md)。

## 当前打开优先级

| 优先级 | 任务 | 主文档 | 当前判断 / 收口标准 |
| --- | --- | --- | --- |
| **P0** | **产品 / UX 30 天改造** | [active/TODO_product_30day.md](./active/TODO_product_30day.md) | 当前最清晰的用户面改造主线。只动 README/docs/安装链路/错误文案/凭证管理/examples/社区入口，不动 Nexus runtime / provider / agent loop。收口标准是每周都有可验收产物，而不是继续扩大工程内核范围。 |
| **P0 Watch** | **Go TUI Session 可观测性 / Embedded Nexus 持久化** | [active/TODO_runtime.md](./active/TODO_runtime.md), [reference/go-tui-session-observability-governance-plan.md](./reference/go-tui-session-observability-governance-plan.md) | Phase 0 `bbl inspect-session` 已收口；Phase 1/2/3 仍是“部分落地”。优先补 `bbl go --check` storage 诊断、clientSessionId server metadata、embedded restart inspect e2e、startup log / transcript persistence hint。 |
| **P1** | **`bbl loop` 多 session pane TUI** | [reference/go-tui-loop-multipane-plan.md](./reference/go-tui-loop-multipane-plan.md), [active/TODO_tui.md](./active/TODO_tui.md) | 本地已有 26 个 develop 提交支撑 Phase 0-5c'，属于真实推进主线。下一步应集中在 chrome/status/sidebar、真实 Nexus streaming、PTY smoke 与文档状态同步；不得让 `bbl loop` 拥有 runtime truth。 |
| **P1** | **文档库治理 / 规划口径收敛** | [README.md](./README.md), [reference/README.md](./reference/README.md), [DONE.md](./DONE.md) | `docs/nexus` 已分为 active / reference / archive / releases。后续新增草案默认进 reference；总控 TODO 不再堆 Watch/Closed 长段；完成事实先入 WORK_LOG，再入 DONE。 |
| **P2 Plan** | **Tool Surface Expansion / Native vs MCP 共存** | [reference/tool-surface-expansion-and-native-mcp-coexistence-plan.md](./reference/tool-surface-expansion-and-native-mcp-coexistence-plan.md), [reference/tool-governance-reference-integration.md](./reference/tool-governance-reference-integration.md) | 目前是 Plan only。源码尚未实现 `AskUserQuestion`、`TaskGet/List/Update`、`MCPTool`、`SkillShow`、`EnterPlanMode` 等入口。必须保持真实 regression 驱动，不能把计划写成已落地能力。 |
| **P2 Draft** | **Behavior Monitor / Long-Running Context Assembly** | [reference/behavior-monitor.md](./reference/behavior-monitor.md), [reference/long-running-context-assembly.md](./reference/long-running-context-assembly.md) | 方向合理但跨度大。建议先做最小切片：Behavior trace collector + CLI review；Nexus-owned working set persistence/resume。暂不新增 live hint 注入、context.search 工具族或新的长期记忆事实源。 |
| **P2 Watch** | **后续迁入、可选执行后端与性能治理** | [active/TODO_runtime.md](./active/TODO_runtime.md), [active/TODO_cleanup.md](./active/TODO_cleanup.md), [active/TODO_performance.md](./active/TODO_performance.md), [reference/go-runner-plan.md](./reference/go-runner-plan.md) | Go Runner 只作为 optional `RemoteToolRunner` 执行后端；BabeL-X 后续迁入必须先定义 Nexus-owned interface，再写 adapter，最后迁移实现。默认 Node/TS 开发流不能依赖 Go。 |

## Watch / Closed 短索引

这些事项已经完成或转为真实回归守门，完整事实不再放在总控 TODO 中，见 [DONE.md](./DONE.md)：

- Session Replay & Evidence Governance：partial Read、line/byte range、intent target、same-ms tool replay mismatch 已收口。
- Current-turn Session Finalization：旧 result/error 污染已收口。
- Task-adaptive Recoverable Timeout：soft deadline + hard watchdog + Go TUI 可见化已收口。
- Go TUI Permission Policy / Bash hard-deny：read-only classifier、soft-deny policy、mock regression、`--allow-tools` 已收口。
- Go TUI `/model` 模型持久化：`POST /v1/runtime/config/select {model}` 与 Step 4 state machine 已收口。
- SessionChannel + Inbox / scoped memory / governed memory candidate：MVP 与 TUI 可见化已收口，后续只按真实 drift 重开。
- EverCore Phase A-G 与 L1-L6：默认关闭、volatile / non-authoritative、managed sidecar/cache/UI/actions/answer governance 已收口。
- Context Blocking Recovery / Cache-aware Compact / Token Estimator：核心恢复路径与诊断已收口，后续按真实 drift 补 fixture。
- AgentLoop / AgentScheduler / Worktree recovery：child transcript、rerun、worktree conflict recovery 与 governance storage 已收口；write-capable child agent 仍未启用。

## 主线状态

| 主线 | 当前状态 | 下一步 |
| --- | --- | --- |
| Runtime / Context | Context compact、token estimator、provider recovery、DeepSeek reasoning replay、hooks、SessionChannel、scoped memory、EverCore、Task-adaptive timeout、Context Blocking Recovery 核心路径均处于可验证状态。 | 不开泛化重写；真实 drift 先补最小 regression。Behavior Monitor 与 Long-Running Context Assembly 只能从小切片进入。 |
| Agents / Optimize | AgentLoop、sub-agent、worktree、provider smoke、AgentScheduler API/CLI、review/test profiles、child transcript、rerun、worktree recovery 已落地。 | 暂不启用 write-capable child agent；未来必须先完成 worktree-isolated child execution + parent diff review。 |
| Provider / Models | Registry、adapters、role routing、capability gates、diagnostics、MiniMax/DeepSeek 兼容、models inspect 已落地。 | 自动模型选择、默认 role model 推荐和 silent fallback 继续延后；只补真实 provider regression。 |
| CLI / TUI | `bbl chat`、`bbl go`、slash/tool palette、permission panel、boxed input、PTY baseline、Inbox/Agents/Memory overlays、Go TUI stable opt-in 均已落地；`bbl loop` 正在推进。 | Go TUI 进入稳定维护；`bbl loop` 按 reference plan 推进，但只做前端编排与渲染。 |
| Performance / Storage | SQLite、tool traces、metrics、storageBridge WAL、benchmark、runtime metrics、Go Runner 对比 benchmark 已落地。 | 保持 CI/build/benchmark 守门；Go Runner 扩展必须显式 env gate。 |
| Cleanup / Build | `docs/nexus` 为唯一长期文档中心；依赖边界、build smoke、format/lint/coverage、BabeL-X compatibility strategy 已完成。 | 继续守住迁入门禁与文档分层，不再把历史完成项堆进 TODO。 |

## 文档索引

| 文档 | 维护内容 |
| --- | --- |
| [README.md](./README.md) | `docs/nexus` 入口、架构分层、历史文档合并口径。 |
| [DONE.md](./DONE.md) | 已完成能力索引与 Watch / Closed 降噪承接。 |
| [WORK_LOG.md](./WORK_LOG.md) | 事实性工作记录、验证命令和重要决策。 |
| [active/TODO_runtime.md](./active/TODO_runtime.md) | Runtime、Nexus API、storage、security、context、compact、MCP、skills、permissions。 |
| [active/TODO_agents.md](./active/TODO_agents.md) | TaskSession、TaskQueue、AgentLoop、Planner/Executor/Critic、sub-agent、worktree。 |
| [active/TODO_tui.md](./active/TODO_tui.md) | `bbl chat`、`bbl go`、`bbl loop`、输入框、overlay、permission panel、PTY smoke。 |
| [active/TODO_product_30day.md](./active/TODO_product_30day.md) | 产品 / UX 30 天改造。 |
| [active/TODO_performance.md](./active/TODO_performance.md) | benchmark、metrics、storage/API 性能、故障注入、并发治理。 |
| [active/TODO_cleanup.md](./active/TODO_cleanup.md) | 依赖治理、BabeL-X 迁入规则、build/CI/lint/coverage。 |
| [reference/README.md](./reference/README.md) | 长期设计、边界、Plan-only 草案和治理参考索引。 |

## 维护规则

- 新任务必须写入对应 `active/` 专项 TODO；本文件只保留路线板和跨主线优先级。
- 完成事实先追加到 [WORK_LOG.md](./WORK_LOG.md)，再把完成能力索引移动到 [DONE.md](./DONE.md)。
- TODO 中原则上只保留未收口项；已完成事项写入 [DONE.md](./DONE.md) 或在本文件 Watch 短索引中一行带过。
- 状态标为完成前，必须能对应到代码、测试、文档或明确验证命令。
- 若一个任务跨多个主线，只在总控保留一行优先级，细节由一个主文档承接，其他文档只做链接。
