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
| **P0** | **真实会话回归守门** | [active/TODO_runtime.md](./active/TODO_runtime.md), [reference/session-finalization-and-evidence-governance-plan.md](./reference/session-finalization-and-evidence-governance-plan.md) | 暂无打开的 P0 功能项；`session_9d985c5c-7c89-41b8-9d5e-cc672e412f00` 暴露的 current-turn finalization 污染已补最小 regression 并修复，当前轮无 terminal event 时不会复用旧 `result` / `error`。后续真实回归仍先补最小 corpus，再修 runtime/config/adapter/TUI。 |
| **P2 / Watch** | **工具粒度 / Evidence-grounded Reading 与 Path Drift 治理** | [reference/tool-granularity-and-evidence-governance-plan.md](./reference/tool-granularity-and-evidence-governance-plan.md), [reference/workspace-path-drift-governance-plan.md](./reference/workspace-path-drift-governance-plan.md), [active/TODO_runtime.md](./active/TODO_runtime.md) | Tool Discovery / Targeted Reading 第一阶段已归档；`ListDir` 已作为 bounded directory inventory 工具落地并与 `Glob` / `Grep` / `Read` 明确分工；`session_122f07b9-8ed5-4b2a-a949-e0de0b9fcb91` 暴露的 Grep fallback parity/no-result diagnostics、Bash timeout/SIGTERM recoverable failure 与 Bash-as-file-discovery guidance 均已收口；`session_1cf5362d-b33f-467f-b07e-f97356652662` 暴露的 workspace path drift 已补最小 `PATH_DRIFT_SUSPECTED` diagnostic；`session_303c7221-8cc3-4251-9436-4215244120e4` 暴露的 Grep `pathMatches` boolean-string 误用已补 `INVALID_GREP_PATH_MATCHES_GLOB` diagnostic；仍不新增与 `Grep` 重叠的 `Search`，不新增路径搜索工具，不新增 `define_subagent` / `invoke_subagent`。 |
| **P2** | **后续迁入、可选执行后端与性能治理** | [active/TODO_runtime.md](./active/TODO_runtime.md), [active/TODO_cleanup.md](./active/TODO_cleanup.md), [active/TODO_performance.md](./active/TODO_performance.md) | 主动历史 P1、mocked provider retry policy benchmark、AgentLoop-inclusive 并发 smoke Phase 1-4、本地 benchmark history、TS/Go runner 对比、context ceiling/runtime metrics 诊断对齐与 provider/agent loop runtime metrics 可观测性已收口；Go 只作为可选 `RemoteToolRunner` 执行后端进入 P2，不替代 TypeScript Nexus/Context/AgentScheduler；后续仍保留 BabeL-X 未来迁入门禁。 |
| **P3** | **长期语义记忆 / EverCore Integration** | [active/TODO_runtime.md](./active/TODO_runtime.md), `/Users/tangyaoyue/DEV/EverOS/babel-o-evercore-integration-plan.md` | Phase A REST Spike、Phase B Internal MemoryProvider、Phase C Context Budget / Diagnostics、Phase D Optional MCP Tools 与 Phase E Embedded / Managed EverCore Spike 已收口：`BABEL_O_EVERCORE_MODE=managed` 可让 BabeL-O/Nexus 管理本地 loopback EverCore sidecar，用户仍只启动 BabeL-O；长期记忆仍通过 `MemoryProvider` / EverCore client / optional MCP tools 访问，不替代 SQLite/compact/session memory/working set，默认关闭且失败不影响 BabeL-O。 |
| **P2 / P3** | **Session Channel + Scoped Memory** | [active/TODO_runtime.md](./active/TODO_runtime.md), [reference/session-to-session-memory-channel-plan.md](./reference/session-to-session-memory-channel-plan.md) | `SessionChannel` + `SessionMessage` + Inbox MVP 已落地，CLI/TUI 已提供 unread inbox / ack / handoff 可见入口：`bbl sessions inbox/ack` 与 `bbl chat` `/inbox` / `/inbox ack`；跨 session 消息仍只是 collaboration context，不做 raw transcript sharing、不实现完整 dreaming、不把消息当成用户直接指令；Layer 2 Project memory 不按 sessionId 隔离；`projectId=default` 诊断、opt-in cwd/git-root 派生 namespace、EverCore project-scoped MemoryProvider diagnostics、user/channel scoped memory budget diagnostics、AgentScheduler parent-child channel 与 API→Inbox→Context 可行性回归均已落地，后续只保留 governed auto-memory 评估。 |
| **Watch** | **真实会话 Context Blocking Recovery 守门** | [active/TODO_runtime.md](./active/TODO_runtime.md), [active/TODO_performance.md](./active/TODO_performance.md) | 基于 `session_1e2299be-b988-49ea-8819-587de8258172` 的核心恢复路径已收口：provider-loop reactive compact、adaptive Read strategy / live Read aggregate budget、embedded metrics side-table 持久化与 retryable failed session 恢复状态表达已落地；后续只在真实 drift 复现时按 regression-first 重新开项。 |
| **Watch** | **真实会话 AgentLoop 稳定性守门** | [active/TODO_agents.md](./active/TODO_agents.md), [active/TODO_runtime.md](./active/TODO_runtime.md) | child transcript、失败子 Agent rerun、worktree recovery 已收口；后续只在真实 provider/真实任务暴露稳定失败样本时按 regression-first 修复。 |

## 后续推进顺序

1. **P0 真实会话 regression 守门**：当前已补 `session_9d985c5c-7c89-41b8-9d5e-cc672e412f00` 的 current-turn finalization 污染回归；当前轮无 terminal event 时不再继承旧 result/error。后续只在真实漂移出现时按 regression-first 修复。
2. **Watch 已收口 P1 主线守门**：Context Manager / AgentScheduler 规范化、Intake Classifier Phase 1-4 与 Context Blocking Recovery 核心恢复路径已收口；后续只在真实 drift 复现时补最小 fixture，不继续扩大历史 P1 scope。
3. **P2 / Watch 工具粒度 / Evidence-grounded Reading 与 Path Drift 治理**：Tool Discovery / Targeted Reading 第一阶段已归档；`ListDir` 已落地为目录 inventory 工具，`Glob` / `Grep` / `Read` 分别限定为 pattern discovery、content locating、source understanding；`session_122f07b9-8ed5-4b2a-a949-e0de0b9fcb91` 暴露的 `Grep` fallback regex/no-result diagnostics、Bash broad file-search timeout recoverable failure 与 Bash-as-file-discovery guidance 已收口；`session_1cf5362d-b33f-467f-b07e-f97356652662` 暴露的 workspace root 混淆已补最小 `PATH_DRIFT_SUSPECTED` diagnostic；`session_303c7221-8cc3-4251-9436-4215244120e4` 暴露的 Grep `pathMatches` boolean-string 误用已补 `INVALID_GREP_PATH_MATCHES_GLOB` diagnostic；不新增重复 `Search`，不新增路径搜索工具，不新增 `define_subagent` / `invoke_subagent`。
4. **P2 后续迁入、可选执行后端、context foundation 与性能治理**：Go Runner 只按 `RemoteToolRunner` 可选后端保留 optional expanded smoke / tests 与 build boundary 守门；provider retry policy benchmark、AgentLoop-inclusive 并发 smoke Phase 1-4、本地 benchmark history、TS/Go runner 对比、context ceiling/runtime metrics 诊断对齐与 provider/agent loop runtime metrics 可观测性已收口，后续仍保留 BabeL-X 未来迁入门禁。
5. **P2 Advanced CLI/TUI 守门**：LSP context mention、file attachment references、image reference metadata 与 opt-in vim mode 已收口；当前无打开功能项，后续只在真实显示回归、PTY smoke drift 或新增交互状态时补专项项。
6. **P2/P3 Session Channel + Scoped Memory**：MVP、CLI/TUI unread inbox / ack 可见化、AgentScheduler parent-child channel、`projectId=default` runtime status 诊断、opt-in cwd/git-root 派生 namespace、EverCore project-scoped MemoryProvider diagnostics、user/channel scoped memory budget diagnostics 与 API→Inbox→Context 可行性回归已落地；后续优先级降为 Phase E governed dreaming 评估；Layer 2 Project memory 不按 sessionId 隔离，改按 project/workspace identity 隔离，仍不做完整 dreaming、raw transcript sharing 或跨 session 直接指令。
7. **P3 长期语义记忆 / EverCore Integration**：Phase A REST Spike、Phase B Internal MemoryProvider、Phase C context budget / diagnostics 与 Phase D Optional MCP Tools 已落地；长期语义记忆只作为 volatile / non-cacheable context hints 或显式 MCP tool result 使用，不把 EverCore 作为 SQLite/session/event/tool trace 事实源；后续只在真实使用暴露 drift 时按 regression-first 补最小项。
8. **真实会话 AgentLoop 稳定性守门**：child transcript、失败子 Agent rerun、worktree recovery 已收口；后续只在真实 provider 或真实任务暴露稳定失败样本时补 regression。

## 主线状态

| 主线 | 当前状态 | 下一步 |
| --- | --- | --- |
| Runtime / Context | 指令跟随、context compact、token estimator、provider recovery、DeepSeek reasoning replay、hooks 最小内核、Cache-aware Compact / 长上下文利用、context ceiling/runtime metrics 诊断对齐、真实会话 Context Blocking Recovery 核心路径、Context Manager / ContextForker / AgentScheduler 基础、pending permission backend 评估、SessionChannel + Inbox MVP 与 CLI/TUI unread inbox/ack 可见化已进入可验证状态；EverCore Phase A/B/C/D 已作为默认关闭、失败不致命、带 context budget diagnostics、project-scoped namespace diagnostics 与可选显式 MCP tools 的外部长期记忆桥接落地。 | 后续只在真实 drift 复现时补最小 regression；SessionChannel 后续只保留 AgentScheduler parent-child channel 可选集成、user/channel scoped MemoryProvider diagnostics 与 governed dreaming 评估；Go Runner 仅作为 P2 `RemoteToolRunner` 可选执行后端登记；EverCore 后续必须保持 volatile context / 非事实源边界；pending permission 继续保持 process-local resolver registry，durable backend 需等 resumable execution 需求明确；provider/model 自动选择与 fallback 执行无限期 delay，需要时再恢复。 |
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
| [reference/workspace-path-drift-governance-plan.md](./reference/workspace-path-drift-governance-plan.md) | Workspace path drift、连续路径失败恢复与最终回答证据降级治理。 |
| [reference/session-finalization-and-evidence-governance-plan.md](./reference/session-finalization-and-evidence-governance-plan.md) | Current-turn session finalization 污染修复与 evidence-scope drift 轻量治理样本。 |
| [reference/session-to-session-memory-channel-plan.md](./reference/session-to-session-memory-channel-plan.md) | Session-to-Session typed channel、Scoped Memory 与 Inbox 架构参考。 |
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
