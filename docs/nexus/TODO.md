# BabeL-O / Nexus 总控规划

## 口径

BabeL-O 是以 Nexus 服务端为核心（Nexus-first）的通用泛化 AI 智能体（Generalized Agent）。总控规划只回答三个问题：

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
| **P0** | **真实会话回归守门** | [active/TODO_runtime.md](./active/TODO_runtime.md) | 暂无打开的 P0 功能项；一旦出现“最新用户指令被旧上下文带偏、短追问触发旧工具链、provider 协议污染 assistant 文本、测试污染真实 provider 配置”等真实回归，先补最小 regression corpus，再修 runtime/config/adapter/TUI。 |
| **P2 / Watch** | **工具粒度 / Evidence-grounded Reading 治理** | [reference/tool-granularity-and-evidence-governance-plan.md](./reference/tool-granularity-and-evidence-governance-plan.md), [active/TODO_runtime.md](./active/TODO_runtime.md) | Tool Discovery / Targeted Reading 第一阶段已归档；`ListDir` 已作为 bounded directory inventory 工具落地并与 `Glob` / `Grep` / `Read` 明确分工；`session_122f07b9-8ed5-4b2a-a949-e0de0b9fcb91` 暴露的 Grep fallback parity/no-result diagnostics（含 optional bundled ripgrep 优先路径）、Bash timeout/SIGTERM recoverable failure 与 Bash-as-file-discovery guidance 均已收口；剩余仅保留 Source Coverage Ledger / Strong Claim Guard 轻量诊断评估和 tool result evidence hint watch，仍不新增与 `Grep` 重叠的 `Search`，不新增 `define_subagent` / `invoke_subagent`。 |
| **P2** | **后续迁入、可选执行后端与性能治理** | [active/TODO_runtime.md](./active/TODO_runtime.md), [active/TODO_cleanup.md](./active/TODO_cleanup.md), [active/TODO_performance.md](./active/TODO_performance.md) | 主动历史 P1、mocked provider retry policy benchmark、AgentLoop-inclusive 并发 smoke Phase 1-4、本地 benchmark history、TS/Go runner 对比、context ceiling/runtime metrics 诊断对齐与 provider/agent loop runtime metrics 可观测性已收口；Go 只作为可选 `RemoteToolRunner` 执行后端进入 P2，不替代 TypeScript Nexus/Context/AgentScheduler；后续仍保留 BabeL-X 未来迁入门禁。 |
| **P3** | **长期语义记忆 / EverCore Integration** | [active/TODO_runtime.md](./active/TODO_runtime.md), `/Users/tangyaoyue/DEV/EverOS/docs/babel-o-evercore-integration-plan.md` | 远期计划；当前不实现。等 P1 Context Manager / AgentScheduler 与 P2 context foundation 稳定后，再从可选 REST Spike 开始，不用 EverCore 替代 SQLite/compact/session memory/working set。 |
| **Watch** | **真实会话 Context Blocking Recovery 守门** | [active/TODO_runtime.md](./active/TODO_runtime.md), [active/TODO_performance.md](./active/TODO_performance.md) | 基于 `session_1e2299be-b988-49ea-8819-587de8258172` 的核心恢复路径已收口：provider-loop reactive compact、adaptive Read strategy / live Read aggregate budget、embedded metrics side-table 持久化与 retryable failed session 恢复状态表达已落地；后续只在真实 drift 复现时按 regression-first 重新开项。 |
| **Watch** | **真实会话 AgentLoop 稳定性守门** | [active/TODO_agents.md](./active/TODO_agents.md), [active/TODO_runtime.md](./active/TODO_runtime.md) | child transcript、失败子 Agent rerun、worktree recovery 已收口；后续只在真实 provider/真实任务暴露稳定失败样本时按 regression-first 修复。 |

## 后续推进顺序

1. **P0 真实会话 regression 守门**：当前已补 intake 失败时身份/能力短问、上下文记忆短追问 respond-only 回归，以及测试进程禁止写真实 provider config 的配置污染守门；不继续无边界扩展规则，后续只在真实漂移出现时按 regression-first 修复。
2. **Watch 已收口 P1 主线守门**：Context Manager / AgentScheduler 规范化、Intake Classifier Phase 1-4 与 Context Blocking Recovery 核心恢复路径已收口；后续只在真实 drift 复现时补最小 fixture，不继续扩大历史 P1 scope。
3. **P2 / Watch 工具粒度 / Evidence-grounded Reading 治理**：Tool Discovery / Targeted Reading 第一阶段已归档；`ListDir` 已落地为目录 inventory 工具，`Glob` / `Grep` / `Read` 分别限定为 pattern discovery、content locating、source understanding；`session_122f07b9-8ed5-4b2a-a949-e0de0b9fcb91` 暴露的 `Grep` fallback regex/no-result diagnostics、Bash broad file-search timeout recoverable failure 与 Bash-as-file-discovery guidance 已收口；后续只在真实 evidence scope drift 继续出现时评估 Source Coverage Ledger / Strong Claim Guard 或轻量 evidence hint，不新增重复 `Search`，不新增 `define_subagent` / `invoke_subagent`。
4. **P2 后续迁入、可选执行后端、context foundation 与性能治理**：Go Runner 只按 `RemoteToolRunner` 可选后端保留 optional expanded smoke / tests 与 build boundary 守门；provider retry policy benchmark、AgentLoop-inclusive 并发 smoke Phase 1-4、本地 benchmark history、TS/Go runner 对比、context ceiling/runtime metrics 诊断对齐与 provider/agent loop runtime metrics 可观测性已收口，后续仍保留 BabeL-X 未来迁入门禁。
5. **P2 Advanced CLI/TUI 守门**：LSP context mention、file attachment references、image reference metadata 与 opt-in vim mode 已收口；当前无打开功能项，后续只在真实显示回归、PTY smoke drift 或新增交互状态时补专项项。
6. **P3 长期语义记忆 / EverCore Integration**：当前仅作为远期计划登记；不在 P1 Context Manager / AgentScheduler 阶段引入 REST/MCP 实现。待 BabeL-O context foundation 稳定后，再从可选 REST Spike 启动。
7. **真实会话 AgentLoop 稳定性守门**：child transcript、失败子 Agent rerun、worktree recovery 已收口；后续只在真实 provider 或真实任务暴露稳定失败样本时补 regression。

## 主线状态

| 主线 | 当前状态 | 下一步 |
| --- | --- | --- |
| Runtime / Context | 指令跟随、context compact、token estimator、provider recovery、DeepSeek reasoning replay、hooks 最小内核、Cache-aware Compact / 长上下文利用、context ceiling/runtime metrics 诊断对齐、真实会话 Context Blocking Recovery 核心路径、Context Manager / ContextForker / AgentScheduler 基础与 pending permission backend 评估已进入可验证状态；EverCore 仅登记为远期长期语义记忆方向。 | 后续只在真实 drift 复现时补最小 regression；Go Runner 仅作为 P2 `RemoteToolRunner` 可选执行后端登记；pending permission 继续保持 process-local resolver registry，durable backend 需等 resumable execution 需求明确；provider/model 自动选择与 fallback 执行无限期 delay，需要时再恢复。 |
| Agents / Optimize | AgentLoop、sub-agent、worktree、provider smoke 入口、session assets query API、SDK task mutation API、child transcript 查询/CLI retry-task、失败子 Agent rerun UX、worktree 冲突恢复 UX、in-place Git hardening、AgentLoop helper 拆分、structured output repair、mocked AgentLoop benchmark、AgentScheduler API/CLI、review/test profiles、remote execution smoke、governance diagnostics、独立 `agent_job_event` schema、persistent AgentJob storage、`runAgentLoop()`/AgentScheduler bridge 评估与 Implement profile 评估已落地。 | 当前不启用 write-capable child agent；若未来实现，必须先落地 worktree-isolated child execution、parent diff review/merge/reject/recovery flow 与独立写安全策略。 |
| Provider / Models | Registry、adapters、role routing、capability gates、diagnostics、smoke、MiniMax/DeepSeek 协议兼容、runtime model capability diagnostics、models inspect polish 与 Agent role capability diagnostics 已落地。 | 自动模型选择、默认 role model 推荐与显式 fallback 执行入口无限期 delay，需要时再恢复；仅保留真实 provider smoke 暴露的新 adapter regression 样本作为 watch-only 补齐项。 |
| CLI / TUI | slash/tool palette、permission panel、boxed input、paste placeholder、层级渲染、compact/expanded 工具详情、PTY 基线、history search overlay ownership、长路径/CJK/ANSI/resize 视觉宽度、sub-agent running context gauge 回归、`/agents` 只读 multi-agent status view、LSP context mention、file attachment references、image reference metadata 与 opt-in vim mode 已落地。 | 保持 TUI smoke 守门；当前无打开 Advanced CLI/TUI 功能项，后续只在真实显示回归、PTY smoke drift 或 dashboard/agent UX 需要时补专项项。 |
| Performance / Storage | SQLite、tool traces、metrics、storageBridge WAL、benchmark、本地 benchmark history、session assets、mocked AgentLoop 成本/失败率 benchmark、mocked retry policy benchmark、AgentLoop-inclusive 并发 smoke Phase 1-4、TS/Go runner 对比 benchmark、context ceiling/runtime metrics 诊断对齐、provider/agent loop runtime metrics 可观测性、1000+ sessions/events API scale、chat first-response 与 storageBridge fault-injection benchmark 已落地。 | Go Runner 若继续扩展，必须继续保持本地 TS runner 对比、cancel/timeout/output budget 与可选 smoke 指标；BabeL-X 后续迁入门禁保留。 |
| Cleanup / Build | `docs/nexus` 为唯一长期文档中心；runtime 去重、结构化 logger、dependency boundary audit、生产 build/build smoke、check-only lint/format、CI workflow、coverage report 与 BabeL-X compatibility strategy 已完成。 | BabeL-X 后续迁入门禁。 |

## 文档索引

| 文档 | 维护内容 |
| --- | --- |
| [README.md](./README.md) | `docs/nexus` 入口、架构分层、历史文档合并口径。 |
| [active/TODO_runtime.md](./active/TODO_runtime.md) | Runtime、Nexus API、storage、security、context、compact、MCP、skills、permissions 的未收口项。 |
| [active/TODO_agents.md](./active/TODO_agents.md) | TaskSession、TaskQueue、AgentLoop、Planner/Executor/Critic、sub-agent、worktree 的未收口项。 |
| [reference/context-and-subagent-upgrade-plan.md](./reference/context-and-subagent-upgrade-plan.md) | Context Manager 规范化、ContextForker、模型可见 AgentScheduler / AgentJob / Agent tools 的架构参考。 |
| [active/TODO_provider_registry.md](./active/TODO_provider_registry.md) | Provider registry、adapter、role routing、model capability matrix 的未收口项。 |
| [active/TODO_tui.md](./active/TODO_tui.md) | `bbl chat`、输入框、slash/tool palette、permission panel、事件渲染的未收口项。 |
| [archive/intake-classifier-upgrade-plan.md](./archive/intake-classifier-upgrade-plan.md) | 已完成的 Intake 分类器升级历史规划。 |
| [reference/tool-granularity-and-evidence-governance-plan.md](./reference/tool-granularity-and-evidence-governance-plan.md) | 工具粒度与 Evidence-grounded Reading 治理：`ListDir` 已落地，不重复新增 Search/subagent 工具，后续观察证据覆盖治理。 |
| [active/TODO_performance.md](./active/TODO_performance.md) | benchmark、metrics、storage/API 性能、故障注入、并发治理。 |
| [active/TODO_cleanup.md](./active/TODO_cleanup.md) | 依赖治理、BabeL-X 迁入规则、build/CI/lint/coverage。 |
| [archive/TODO_cli.md](./archive/TODO_cli.md) | 已归档的 CLI 主题兼容导航页。 |
| [archive/TODO_tool_result_budget.md](./archive/TODO_tool_result_budget.md) | 已完成的工具结果持久化与消息级预算历史设计。 |
| [reference/go-runner-plan.md](./reference/go-runner-plan.md) | 可选 Go `RemoteToolRunner` 执行后端参考；不替代 TypeScript Nexus、Context Manager、AgentScheduler、provider loop 或 CLI/TUI。 |
| [DONE.md](./DONE.md) | 已完成能力索引与守住底线。 |
| [WORK_LOG.md](./WORK_LOG.md) | 事实性工作记录、验证命令和重要决策。 |

## 维护规则

- 新任务必须写入对应 `active/` 专项 TODO；本文件只保留路线板和跨主线优先级。
- 完成事实先追加到 [WORK_LOG.md](./WORK_LOG.md)，再把完成能力索引移动到 [DONE.md](./DONE.md)。
- TODO 中只保留 `[ ]` 未收口项；已完成事项写入 [DONE.md](./DONE.md) 或改为“已收口摘要”，不继续保留完成 checkbox。
- 状态标为完成前，必须能对应到代码、测试、文档或明确验证命令。
- 若一个任务跨多个主线，只在总控保留一行优先级，细节由一个主文档承接，其他文档只做链接。
