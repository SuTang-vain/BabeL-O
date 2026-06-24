# BabeL-O Nexus 文档库

`docs/nexus` 是 BabeL-O 当前唯一权威文档中心。旧的根目录规划、审计、调优和 walkthrough 文档已经合并到这里；后续不要在 `docs/` 根目录新增长期规划文档。

文档库现在按生命周期分层：

- `active/`: 当前实现 TODO。
- `reference/`: 长期架构参考、索引和指南。
- `proposals/`: Draft / Partially Landed 计划。
- `history/`: Closed / Watch-only 实现历史账本。
- `decisions/`: ADR 风格治理决策。
- `archive/`: 过时或被 canonical 文档取代的历史源。
- `../releases/`: 版本发布说明。

BabeL-O 是以 Nexus 服务端为核心（Nexus-first）的通用泛化 AI 智能体（Generalized Agent）。目标不是复制 BabeL-X 的历史复杂度，而是保留已验证的编程能力、长会话能力、CLI 交互体验和多 Agent 协作能力，并让 Nexus 成为真正的执行核心。

## 核心原则

```text
Nexus owns execution.
CLI owns interaction.
Tools and coding workflows stay first-class.
Legacy complexity is not imported by default.
```

## 架构分层

```text
src/nexus      Fastify API, WebSocket streaming, request/session orchestration, AgentLoop
src/runtime    Local/LLM runtime, context assembly, compact, provider recovery
src/tools      Built-in tools, MCP tool wrapping, risk classification, path safety
src/storage    Memory/SQLite storage, tool traces, metrics, permission audits
src/providers  Provider registry, adapters, retry, model capability routing
src/cli        Commander commands, chat/run TUI, renderers, slash commands
src/shared     Events, sessions, tasks, errors, IDs and shared schemas
```

## 文档入口

### 根文档

| 文档 | 口径 |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 面向外部的 BabeL-O 架构说明：Client、Nexus、Runtime、Framework abstractions、Harness、Observability 与 Loop 的真实代码边界。 |
| [TODO.md](./TODO.md) | 总控规划、阶段状态、当前优先级和阻塞项。 |
| [DONE.md](./DONE.md) | 已完成能力索引，把 TODO 中的 `[x]` 历史移出待办清单。 |
| [WORK_LOG.md](./WORK_LOG.md) | 事实性工作记录、验证命令和重要决策。 |

### Active TODO

| 文档 | 口径 |
| --- | --- |
| [active/TODO_runtime.md](./active/TODO_runtime.md) | Nexus Runtime、API、storage、context、安全边界、MCP、skills。 |
| [active/TODO_agents.md](./active/TODO_agents.md) | TaskSession、TaskQueue、Planner/Executor/Critic、sub-agent、worktree。 |
| [active/TODO_provider_registry.md](./active/TODO_provider_registry.md) | Provider/model registry、角色路由、模型能力矩阵。 |
| [active/TODO_tui.md](./active/TODO_tui.md) | `bbl chat`、slash palette、权限交互、输入框、状态渲染。 |
| [active/TODO_performance.md](./active/TODO_performance.md) | 性能、benchmark、日志、指标、storage 查询优化。 |
| [active/TODO_cleanup.md](./active/TODO_cleanup.md) | 依赖治理、架构边界、历史复杂度隔离、发布工程化。 |

### Reference / Proposals / History / Decisions

| 文档 | 口径 |
| --- | --- |
| [reference/README.md](./reference/README.md) | 长期架构参考总索引，只保留 Active Plan、Index 和 Guide。 |
| [proposals/README.md](./proposals/README.md) | Draft / Partially Landed 计划索引。 |
| [history/README.md](./history/README.md) | Closed / Watch-only 实现历史账本。 |
| [decisions/README.md](./decisions/README.md) | ADR 风格治理决策索引。 |
| [reference/agent-session-skill-governance-index.md](./reference/agent-session-skill-governance-index.md) | Agent / Session / Skill 治理入口，统一 agent runtime maturity、typed session collaboration、TUI 关系可见化和 skill product loop 边界。 |
| [context-and-agent-history.md](./history/context-and-agent-history.md) | 上下文规范化、ContextForker 与模型可见 AgentScheduler 架构参考。 |
| [reference/context-governance-index.md](./reference/context-governance-index.md) | Context 治理入口，统一 Context Manager、compact、working set、behavior trace、cache observability、memory 与 tool-loop recovery 的主从关系。 |
| [reference/evidence-governance-index.md](./reference/evidence-governance-index.md) | Evidence 治理入口，统一 replay safety、Read coverage、task scope、path drift、finalization 与 timeout evidence boundary。 |
| [reference/prompt-model-governance-index.md](./reference/prompt-model-governance-index.md) | Prompt / Model 治理入口，统一 prompt contract、Turn Policy、intent policy、model metadata、context-window facts 与 no-silent-switching 边界。 |
| [reference/go-client-distribution-governance-index.md](./reference/go-client-distribution-governance-index.md) | Go client / Distribution 治理入口，统一 Go TUI、`bbl loop`、Go Runner、portable package、launcher 与 release-channel 边界。 |
| [reference/tool-governance-plan.md](./reference/tool-governance-plan.md) | 工具治理 canonical 入口：工具分类、证据语义、native/MCP 共存、新工具准入与可恢复失败边界。 |
| [reference/runtime-tool-loop-governance-plan.md](./reference/runtime-tool-loop-governance-plan.md) | Runtime tool-loop 连续性治理：可恢复工具错误、伪工具调用文本、loop budget 和 bounded final check。 |
| [reference/memory-governance-plan.md](./reference/memory-governance-plan.md) | Memory 治理 canonical 入口：长期记忆非权威边界、EverCore/EverOS lifecycle、启动 UX 与 opt-in 写入。 |
| [reference/long-running-context-assembly.md](./reference/long-running-context-assembly.md) | 长任务上下文组装 Active Plan：Nexus-owned working set、resume pack、context assembly REST/CLI/WS、R0-R7 全部收口。 |
| [evidence-and-runtime-history.md](./history/evidence-and-runtime-history.md) | Workspace path drift、连续路径失败恢复与最终回答证据降级治理。 |
| [evidence-and-runtime-history.md](./history/evidence-and-runtime-history.md) | Current-turn session finalization 污染修复与 evidence-scope drift 轻量治理样本。 |
| [context-and-agent-history.md](./history/context-and-agent-history.md) | Session-to-Session typed channel、Scoped Memory 与 Inbox 架构参考。 |
| [session-channel-tui-relationship-visibility-plan.md](./proposals/session-channel-tui-relationship-visibility-plan.md) | SessionChannel TUI 关系可见化分层规划：状态栏、badge、tree、activity overlay 与 debug graph。 |
| [behavior-monitor.md](./reference/behavior-monitor.md) | 行为监控草案；规划 behavior trace、跨 session drift/loop monitor 与用户意图跟随诊断，不替代现有事实源。 |
| *long-running-context-assembly.md (graduated 2026-06-21)* | *迁到 [reference/long-running-context-assembly.md](./reference/long-running-context-assembly.md) (R0-R7 全部收口,升 Active Plan)。* |
| [go-runner-plan.md](./proposals/go-runner-plan.md) | 可选 Go `RemoteToolRunner` 执行后端参考；Go 只负责已批准工具的执行 mechanics，不替代 TypeScript Nexus 主体。 |
| [go-tui-history.md](./history/go-tui-history.md) | `bbl go` / Go TUI 长期实验重写规划；Go 只负责终端交互、布局、键盘路由和事件渲染，不替代 Nexus/runtime/context/AgentScheduler。 |
| [go-tui-history.md](./history/go-tui-history.md) | Go TUI `--mouse` 文本选区高亮与剪贴板复制优化记录；已用窄范围 ultraviolet cell-buffer highlight 收口“实际选中但视觉未高亮/不覆盖”的问题。 |

### Archive

| 文档 | 口径 |
| --- | --- |
| [archive/TODO_cli.md](./archive/TODO_cli.md) | 已废弃的 CLI 兼容导航页；主索引由 README 承接。 |
| [archive/TODO_tool_result_budget.md](./archive/TODO_tool_result_budget.md) | 已完成的工具结果持久化与消息级预算历史设计。 |
| [archive/intake-classifier-upgrade-plan.md](./archive/intake-classifier-upgrade-plan.md) | 已完成的 Intake Classifier Phase 1-4 历史规划。 |
| [archive/tool-call-text-leakage-governance.md](./archive/tool-call-text-leakage-governance.md) | 已完成 Phase A-C 的 Tool-call Text Leakage 治理设计；后续 corpus watch 由 Runtime TODO 承接。 |
| [archive/phase-9-promotion-decision.md](./archive/phase-9-promotion-decision.md) | 已收口的 Go TUI Phase 9 stable-alternative 提升决策记录。 |
| [archive/go-tui-v1-ui-upgrade.md](./archive/go-tui-v1-ui-upgrade.md) | 已完成的 Go TUI v1 UI/UX 升级规划与实施记录。 |
| [archive/README.md](./archive/README.md) | 归档文档索引；包含已被 canonical reference 取代的工具、runtime tool-loop 与 memory 历史源文档。 |

## 当前实现状态

- Nexus API、WebSocket stream、embedded/service CLI 已可运行。
- SQLite 与 Memory storage 均支持 session/event/task/tool trace 等核心数据。
- LLM Runtime 已接入 provider registry、工具循环、usage/provider error 归一、retry、message normalizer 和 max output recovery。
- 内置工具、MCP stdio 工具包装、risk gate、permission classifier、workspace path safety 和 Bash HMAC CWD probe 已落地。
- 上下文体系已具备 token estimator、blocking limit、manual/auto compact、retained segment 校验、LLM 结构化摘要、AGENTS.md/Git 状态注入、`/context` 诊断和回归样本。
- Agent 体系已具备 Planner/Executor/Critic、`bbl optimize`、Planner HITL、受控 sub-agent 委派、跨 session 子代理、worktree isolation 和 Git 保护链路。
- CLI/TUI 已具备 welcome、事件分层渲染、slash palette、模型向导、权限交互、agent running 状态和基础键盘路由。

## 历史文档合并口径

根目录旧文档已按以下规则合并：

- 旧根目录 `ARCHITECTURE.md` 的架构原则已合并到本 README；当前对外架构说明见
  [ARCHITECTURE.md](./ARCHITECTURE.md)。
- `PLAN.md`、`RECOMMENDATIONS.md`、`BabeL-O_优化建议_v1.0.md` 的可执行结论合并到 `TODO.md` 与各主线 TODO。
- `BabeL-O_vs_BabeL-X_深度分析_v1.0.md` 和 `BabeL-O_调优规划_v1.0.md` 的上下文、prompt、provider、工具容错结论已经体现在 `reference/context-and-subagent-upgrade-plan.md`、`active/TODO_runtime.md`、`active/TODO_provider_registry.md` 和 `WORK_LOG.md`。
- `BabeL-O_Session_d61f22d0_问题分析.md` 的真实会话结论已经进入 `TODO.md` 与 `WORK_LOG.md`。
- `implementation_plan.md`、`task.md`、`walkthrough.md` 属于一次性实施记录，已由 `WORK_LOG.md` 承接。

## 维护规则

- `docs/nexus` 是唯一长期文档目录；`docs/` 根目录不再保留规划、审计、调优或 walkthrough 文档。
- 总控 `TODO.md` 只维护阶段、优先级、阻塞项和跨主线结论。
- `active/` 只放仍会影响近期优先级的 TODO；`reference/` 放长期架构参考、索引和指南；`proposals/` 放草案和半落地计划；`history/` 放已收口实现历史；`decisions/` 放 ADR；`archive/` 放过时或被 canonical 文档取代的历史源。
- 每条主线只在对应 active TODO 中维护细节，避免同一事项多处写不同状态。
- `WORK_LOG.md` 只追加事实、验证命令和重要决策，不承载长期规划。
- `DONE.md` 承接已完成能力索引；TODO 中原则上只保留未收口项。
- 任何“已完成”状态必须能对应到代码、文档或命令验证。
- 新增 `reference/` 文档正文优先英文，末尾保留 `中文概述`；Draft / Partially Landed 必须先进入 `proposals/`，Closed 项必须合并到 `history/` 或 `DONE.md`。
