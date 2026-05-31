# BabeL-O Nexus 文档库

`docs/nexus` 是 BabeL-O 当前唯一权威文档中心。旧的根目录规划、审计、调优和 walkthrough 文档已经合并到这里；后续不要在 `docs/` 根目录新增长期规划文档。

BabeL-O 是 BabeL-X 的 Nexus-first 重写版本。目标不是复制 BabeL-X 的历史复杂度，而是保留已验证的编程能力、长会话能力、CLI 交互体验和多 Agent 协作能力，并让 Nexus 成为真正的执行核心。

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

| 文档 | 口径 |
| --- | --- |
| [TODO.md](./TODO.md) | 总控规划、阶段状态、当前优先级和阻塞项。 |
| [DONE.md](./DONE.md) | 已完成能力索引，把 TODO 中的 `[x]` 历史移出待办清单。 |
| [TODO_runtime.md](./TODO_runtime.md) | Nexus Runtime、API、storage、context、安全边界、MCP、skills。 |
| [TODO_agents.md](./TODO_agents.md) | TaskSession、TaskQueue、Planner/Executor/Critic、sub-agent、worktree。 |
| [TODO_provider_registry.md](./TODO_provider_registry.md) | Provider/model registry、角色路由、模型能力矩阵。 |
| [TODO_tui.md](./TODO_tui.md) | `bbl chat`、slash palette、权限交互、输入框、状态渲染。 |
| [TODO_performance.md](./TODO_performance.md) | 性能、benchmark、日志、指标、storage 查询优化。 |
| [TODO_cleanup.md](./TODO_cleanup.md) | 依赖治理、架构边界、历史复杂度隔离、发布工程化。 |
| [TODO_cli.md](./TODO_cli.md) | CLI 兼容导航页，不作为主规划源。 |
| [TODO_tool_result_budget.md](./TODO_tool_result_budget.md) | 已完成的工具结果持久化与消息级预算历史设计。 |
| [CONTEXT_GAP_ANALYSIS.md](./CONTEXT_GAP_ANALYSIS.md) | BabeL-O 与 BabeL-X 上下文能力差距历史分析。 |
| [WORK_LOG.md](./WORK_LOG.md) | 事实性工作记录、验证命令和重要决策。 |

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

- `ARCHITECTURE.md` 的架构原则合并到本 README。
- `PLAN.md`、`RECOMMENDATIONS.md`、`BabeL-O_优化建议_v1.0.md` 的可执行结论合并到 `TODO.md` 与各主线 TODO。
- `BabeL-O_vs_BabeL-X_深度分析_v1.0.md` 和 `BabeL-O_调优规划_v1.0.md` 的上下文、prompt、provider、工具容错结论已经体现在 `CONTEXT_GAP_ANALYSIS.md`、`TODO_runtime.md`、`TODO_provider_registry.md` 和 `WORK_LOG.md`。
- `BabeL-O_Session_d61f22d0_问题分析.md` 的真实会话结论已经进入 `TODO.md` 与 `WORK_LOG.md`。
- `implementation_plan.md`、`task.md`、`walkthrough.md` 属于一次性实施记录，已由 `WORK_LOG.md` 承接。

## 维护规则

- `docs/nexus` 是唯一长期文档目录；`docs/` 根目录不再保留规划、审计、调优或 walkthrough 文档。
- 总控 `TODO.md` 只维护阶段、优先级、阻塞项和跨主线结论。
- 每条主线只在对应子 TODO 中维护细节，避免同一事项多处写不同状态。
- `WORK_LOG.md` 只追加事实、验证命令和重要决策，不承载长期规划。
- `DONE.md` 承接已完成能力索引；TODO 中原则上只保留未收口项。
- 任何“已完成”状态必须能对应到代码、文档或命令验证。
