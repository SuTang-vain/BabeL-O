# BabeL-O / Nexus 总控规划

## 项目愿景

BabeL-O 是 BabeL-X 的 Nexus-first 重写版本。它以 Nexus 为执行核心，以轻量但高效的 CLI 作为主要交互入口，保留 BabeL-X 的编程能力：读写代码、搜索代码库、运行命令、管理任务、处理权限、多轮上下文和后续多 Agent 协作。

核心原则：

```text
Nexus owns execution.
CLI owns interaction.
Tools and coding workflows stay first-class.
Legacy complexity is not imported by default.
```

## 文档拆分

本文件只保留总控索引、阶段状态、当前优先级和阻塞项。细节规划按主线拆分：

- [TODO_runtime.md](./TODO_runtime.md): Nexus Runtime、Fastify API、WebSocket、sessions、storage、安全边界。
- [TODO_agents.md](./TODO_agents.md): TaskSession、TaskQueue、AgentLoop、Planner/Executor/Critic、Human-in-the-loop。
- [TODO_provider_registry.md](./TODO_provider_registry.md): Provider/Model Registry、多厂商 adapter、模型能力矩阵。
- [TODO_tui.md](./TODO_tui.md): CLI 交互、`bbl chat`、slash command、权限确认、编程体验。
- [TODO_cleanup.md](./TODO_cleanup.md): 与 BabeL-X 遗留复杂度隔离、依赖治理、命名和兼容策略。
- [TODO_performance.md](./TODO_performance.md): 启动速度、streaming、工具执行、storage、CLI 响应速度。
- [TODO_cli.md](./TODO_cli.md): CLI 主题兼容导航页，不作为主规划源。
- [../RECOMMENDATIONS.md](../RECOMMENDATIONS.md): 基于 BabeL-X 审计和横向 CLI 对比形成的能力迁移建议总纲。
- [WORK_LOG.md](./WORK_LOG.md): 时间线工作记录，只记录事实和验证。

## 阶段状态

| 阶段 | 状态 | 主文档 | 说明 |
| --- | --- | --- | --- |
| P0 Clean Skeleton | 已完成第一版 | [TODO_runtime.md](./TODO_runtime.md) | Fastify API、runtime facade、MemoryStorage、基础工具、CLI embedded/service smoke 已落地。 |
| P0 CLI Interaction Baseline | 已完成第一版 | [TODO_tui.md](./TODO_tui.md) | `run`、`chat`、`nexus start/status`、`sessions list/show` 已可用；交互仍是 readline 级别。 |
| P1 Real Provider Runtime | 已完成第一版 | [TODO_provider_registry.md](./TODO_provider_registry.md) | Anthropic/OpenAI adapter、LLMCodingRuntime 与 ConfigManager 已接入；usage 与 provider error 已归一；provider options schema、真实 provider smoke 和 structured output 验证仍按 provider 子 TODO 跟进。 |
| P1 Durable Storage | 已完成 | [TODO_runtime.md](./TODO_runtime.md) | SQLite storage、session/event/task/tool_traces 持久化，以及游标分页与 restart test 已落地。 |
| P1 Service-Safe Permissions | 已完成 | [TODO_runtime.md](./TODO_runtime.md) | 限制非 localhost 强制开启 API 鉴权，支持 HTTP/WS 安全握手阻断与 CLI 凭证传输，安全保护规则全面覆盖并运行测试。 |
| P1 Coding Workflow Parity | 已完成第一版 | [TODO_tui.md](./TODO_tui.md) | 支持 slash command、history 检索、行级 Diff、文件补全、历史重试。 |
| P2 Agents / Task Orchestration | 已完成第一版 | [TODO_agents.md](./TODO_agents.md) | 实现了 TaskSession/TaskQueue 管理，Planner->Executor/Optimizer->Critic 协作闭环，及 `bbl optimize` 自优化机制。 |
| P2 Performance Hardening | 进行中 | [TODO_performance.md](./TODO_performance.md) | benchmark、startup trace、tool output limit、stream backpressure、分页和并发闸门已建立；大量 session/event 压测、chat 首响、Grep/Glob result limit、O(n) 审计和 SQLite 索引审计待收口。 |
| P0 Context-Aware Runtime | 已完成第一版 | [TODO_runtime.md](./TODO_runtime.md) | ContextBudget、snipCompactor、项目记忆、规则摘要和长会话 benchmark 已落地。 |
| P0 MCP-Ready Extensions | 已完成第一版 | [TODO_runtime.md](./TODO_runtime.md) | stdio-only MCP client、显式 allowedTools 白名单、tools audit 来源展示和 3 个官方 MCP server smoke 已落地。 |
| P1 Knowledge-First Skills | 待开始 | [TODO_runtime.md](./TODO_runtime.md) | 按 `RECOMMENDATIONS.md` 实现 built-in/user/project 三级 inline Skills，不迁移 BabeL-X 的 React SkillTool。 |
| P2 Smart Permissions | 待开始 | [TODO_runtime.md](./TODO_runtime.md) | 按 `RECOMMENDATIONS.md` 实现轻量规则分类器，read-only 自动放行，Bash 白名单/黑名单。 |

## 当前优先级

1. **P1 Knowledge-First**: 实现纯文本 inline Skills 三级目录和关键词注入，先不支持 fork/AgentTool 模式。
2. **P1 收口**: 补齐 provider options schema、真实 provider smoke、model/profile switching 和 task/Todo status panel。
3. **P2 Performance**: 补齐大量数据压测、chat 首响 benchmark、Grep/Glob result limit、route handler O(n) 审计与 SQLite 索引审计。

## 当前阻塞项

- 暂无。

## 最近完成

- 实现工具自动完成快捷别名映射与 `/model` 配置向导：在 `completer` 中对 `/read` -> `read ` 等快捷别名提供翻译映射，保留常规控制命令；为 CLI 交互控件引入了 `wasRaw` 状态备份还原与 Esc 键取消逻辑；实现带 Provider -> API Key（允许留空保留） -> Base URL（支持 `-` 清除） -> Model ID 选取流的 `/model` 配置向导。在 `program.ts` 中增设 `isMain()` 防污染校验并补充 `test/completer.test.ts` 全量测试。

- 实现 Provider 错误与 Token 消耗（Usage）归一化：新增 `ProviderError` 错误类型用于封装 HTTP status 和错误体；在 `events.ts` 中注册 `UsageEventSchema` 记录输入、输出及缓存 Tokens 消耗；在 `AnthropicAdapter` 与 `OpenAIAdapter` 中开启统计并随流提取 yield，在 `LLMCodingRuntime` 中捕获转化并保存至数据库。扩增了 `test/adapters.test.ts` 以完整校验。

- 实现行级 LCS Diff 对比渲染器与命令历史检索：新增 `src/cli/diffLcs.ts` 实现最长公共子序列（LCS）对比算法并在 `diff.ts` 中重构 `Edit` 结果输出为红绿 unified diff 格式；在 `program.ts` 中新增 `/history`、`/history <keyword>` 以及 `/history !<idx>` 支持查看、搜索与快捷运行历史命令。添加了完整的单元测试 `test/diff.test.ts`。

- 实现本地及远程多轮会话恢复支持：在 `bbl chat` 周期内维持单一 `sessionId` 并支持 `--session <id>` 参数恢复会话，开启时拉取渲染以往历史记录；在本地 SQLite 模式下追加 `user_message` 事件与 session 动态状态更新。在 `test/runtime.test.ts` 中新增集成测试用例。

- 实现 SQLite 工具执行轨迹存储与复合游分页：建立 `tool_traces` 独立表并创建 `(session_id, started_at)` 索引；在 MemoryStorage 和 SqliteStorage 的 `appendEvent` 中自动拦截 `tool_started` / `tool_completed` 记录并更新轨迹状态，自动计算耗时；设计并实现 Composite Cursor (`${startedAt}|${toolUseId}`) 游标分页，确保同一时间戳下并发工具执行分页的绝对稳定性；提供 GET `/v1/sessions/:sessionId/tool-traces` 接口，支持 limit、order 和 cursor 分页查询，编写完备的集成测试，串行压测 100% 通过。

- 完成 P1 Service-Safe Permissions 鉴权与安全绑定收尾：实现默认绑定 127.0.0.1，且在绑定非 localhost 时强校验 NEXUS_API_KEY，阻断未授权的 HTTP 与 WebSocket 握手请求。同时，更新了 CLI 客户端及 WS 会话自动附加 Key 的逻辑，并编写了完备的安全测试用例。
- 实现高风险工具安全确认与交互式提权流程第一版：引入 `PendingPermissionRegistry` 单例，拦截高风险工具（Write, Edit, Bash）并在 executeStream 中以 Promise 阻塞；在 Fastify 提供 `/v1/sessions/:id/approve` 和 `/deny` HTTP 提权端点与 `/v1/sessions/:id/input` 处理流程；在 WebSocket 监听 `permission_response` 完成控制流交互。持久化 permission audit、断线恢复和远程部署默认鉴权仍列为后续工作。
  - 优化并清理了 tsx 并发多进程下的 ESM 加载路径冲突，移除了不稳定的 `safety.ts` 与 `PendingPermissionRegistry.ts` 并合并至 `session.ts`，添加了专门的 `test/permission-flow.test.ts`，进行了 10 轮压力测试循环，测试全绿通过。
- 完成 P1 级 Runtime / Security / Storage 的整体重写升级，包括补全 request context (`requestId`，`model`，`budget`)，统一核心标准错误码，提供 `GET /v1/schema/events` 返回 Zod schema 的 JSON schema，用 `PRAGMA user_version` 实现 SQLite 数据库迁移（v2 新增 `permission_audits`），实施真实路径 Symlink 边界防护、Workspace Allowlist 白名单、默认拒绝高危工具 policy，以及 permission audits 持久化审计追踪。修复了全量 50 个单元与集成测试。

- 开启并完成多智能体协作与自优化：包含 Planner -> Executor/Optimizer -> Critic 协作闭环，引入 `bbl optimize` 命令行，内建基于 Git 的自动 Stash 保护、执行/审查失败回滚与成功提交机制，并解决了任务重试时的所有调度死锁问题。
- 实现 Optimizer 安全沙箱机制：针对 `optimizer` 角色在运行时限制敏感文件写入（package.json, tsconfig.json, bin/*, .env* 等）及高危 Bash 命令执行（rm -rf, sudo, npm publish, git push 等）。
- 接入厂商模型适配器：实现 ModelAdapter、AnthropicAdapter（支持提示词缓存、thinking 思考预算）与 OpenAIAdapter，集成至全局工厂。
- 实现安全配置文件管理器 ConfigManager (`~/.babel-o/config.json`)，支持 0o600 权限保障凭证安全。
- 实现 LLM 运行时驱动 LLMCodingRuntime，管理工具执行循环与未完成/遭拒工具调用中断恢复机制。
- CLI 主程序注册 `config` 与 `models` 命令，支持模型元数据 inspect 和 credentials 写入。
- 新增集成测试套件 `test/runtime-llm.test.ts`，全面覆盖配置加载与 LLM 运行机制。

- 在 `/Users/tangyaoyue/develop/BabeL-O` 建立 clean rewrite 项目。
- 新增 Fastify Nexus API：`/health`、`/v1/runtime/status`、`/v1/execute`、`/v1/stream`、sessions/tasks 基础接口。
- 新增 Commander CLI：`run`、`chat`、`nexus start/status`、`sessions list/show`。
- 新增 runtime facade 与 `LocalCodingRuntime`。
- 新增基础工具：Read、Write、Edit、Bash、Grep、Glob、TaskCreate。
- 新增 `MemoryStorage`、共享 event/session/task 类型、架构文档和测试。
- 已验证：`npm run typecheck`、`npm test`、embedded CLI、service mode smoke 均通过。
- 新增 SQLite storage，支持 session/event/task 持久化。
- 新增 session input/cancel endpoint 与 task patch/claim/complete endpoint。
- 新增 CLI `sessions resume`、`sessions cancel` 和 `nexus start --storage-path`。
- 新增工具风险分类、`NEXUS_ALLOWED_TOOLS`、`/v1/tools/audit`、`bbl tools audit` 和 denied tool event。

## 维护规则

- 总控 `TODO.md` 不写长细节。
- 主线任务只写在对应子 TODO 中。
- 完成事实追加到 [WORK_LOG.md](./WORK_LOG.md)。
- 如果某项状态无法用命令或代码文件验证，不能标为完成。
