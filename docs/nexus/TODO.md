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
| P2 Performance Hardening | 核心已收口，压测待补 | [TODO_performance.md](./TODO_performance.md) | Grep/Glob limits、Sqlite N+1 联合查询优化、tool_traces 复合索引自动升级和 CLI 模块动态懒加载已落地；大量 session/event 压测、chat 首响 benchmark、retry benchmark 和结构化 logger 仍待补。 |
| P0 Context-Aware Runtime | 已完成第一版 | [TODO_runtime.md](./TODO_runtime.md) | ContextBudget、snipCompactor、项目记忆、规则摘要和长会话 benchmark 已落地。 |
| P0 MCP-Ready Extensions | 已完成第一版 | [TODO_runtime.md](./TODO_runtime.md) | stdio-only MCP client、显式 allowedTools 白名单、tools audit 来源展示和 3 个官方 MCP server smoke 已落地。 |
| P1 Knowledge-First Skills | 已完成 | [TODO_runtime.md](./TODO_runtime.md) | 按 `RECOMMENDATIONS.md` 实现 built-in/user/project 三级 inline Skills，支持动态匹配和 system prompt 注入。 |
| P2 Smart Permissions | 已完成 | [TODO_runtime.md](./TODO_runtime.md) | 按 `RECOMMENDATIONS.md` 实现轻量规则分类器，read-only 自动放行，Bash 白名单/黑名单。 |
| P2 Execution Environments | local-only 校验已完成，docker/remote 设计待补 | [TODO_runtime.md](./TODO_runtime.md) | 已定义 executionEnvironment 并校验限制支持（仅限 local，对 docker/remote 提示 not implemented）；Docker workspace mount、资源限制和 remote runner protocol 仍待正式设计。 |
| P2 Observability / Metrics | 指标核心已完成，日志/压测待补 | [TODO_performance.md](./TODO_performance.md) | 已记录并保存执行指标（provider 响应耗时、TTFT、工具轮回、输入/输出字数等）到 SQLite 库与 metrics 路由中；结构化 logger 和 1000+ sessions 压测待补。 |
| P2 Model Capability Routing | 核心已收口，默认推荐待补 | [TODO_provider_registry.md](./TODO_provider_registry.md) | ProfileConfig roles、request model > env model > role model > profile/default 的优先级、toolCalling=false 前置拦截、structured-output role gate 已落地；未配置 roles 时的默认模型推荐策略仍待补。 |
| P0 Safety / Stability Hardening | 已完成第一版 | [TODO_runtime.md](./TODO_runtime.md) | PendingPermissionRegistry TTL、storageBridge 重试队列、Bash HMAC probe、Bash/TaskQueue/TaskSession 生命周期清理，以及 `new Function` 动态 import 清除已落地；durable WAL 和 session close 级联清理可后续增强。 |

## 当前优先级

1. **P3 Agents / Sub-Task Orchestration (子任务委派)**: 设计并支持 Executor 能够派发 `subTasks` 序列，并在 `runAgentLoop()` 级限制最大嵌套深度防止无限循环。
2. **P2/P3 Provider Registry 完善**: 补齐 request model 优先级、structured output role gate，并验证推理模型纯文本角色路由。
3. **P3 Human-in-the-Loop 审批强化**: Planner 输出后暂停等待用户确认任务列表，Executor 执行前支持摘要预览。
4. **P2 Reliability Enhancement**: 如需跨进程崩溃恢复，为 storageBridge 增加 durable WAL；如需更细生命周期，补 session close event 并触发 Bash/Task/Permission 级联清理。

## 当前阻塞项

- 暂无。

## 最近完成

- 完成 P2 Model Capability Routing 收口 (v0.51)：`ConfigManager.resolveSettings()` 支持 `{ model, role, provider }` 显式解析，形成 request model > env model > role model > profile model > defaultModel 的优先级，并修正 provider 前缀模型被 profile provider/env provider 错配的问题；HTTP 与 WS 路由统一使用该解析口径；Agent Step Runner 在执行前对 tool role 检查 `toolCalling`，对 structured-output role 检查 `jsonOutput`，不满足能力声明时前置拒绝且不调用 runtime。已验证 `npm run typecheck` 和 Provider/Agent/Runtime 目标测试 42/42 通过。

- 完成 P0 Safety / Stability Hardening 第一版 (v0.50)：为 `PendingPermissionRegistry` 增加 30 分钟 TTL、后台 sweeper、超时自动 deny 和测试控制入口；将 `storageBridge` 从 fire-and-forget 改为带 3 次重试、延迟调度、永久失败计数和 stats 暴露的内存队列；为 Bash CWD、TaskQueue、TaskSession 模块级 Map 增加 TTL/prune API 与后台 sweeper；Bash 状态探测从固定标记改为每次执行随机 nonce + HMAC + timingSafeEqual 验证，阻断用户输出伪造 marker 污染 CWD；移除 CLI/测试中 `new Function("return import('ws')")` 的动态 import 方式并补充本地 `ws` 类型声明。已验证 `npm run typecheck` 和 P0 关键测试组 43/43 通过。

- 完成 P2 Model Capability Routing 第一版 — 声明式角色路由与底线拦截 (v0.49)：在 `ProfileConfig` 与 Zod Schema 中新增可选 `roles` 字段，支持用户为 planner/executor/critic/optimizer 独立指定模型；`resolveSettings(role?)` 扩展为 env > roles[role] > profile.model/defaultModel；在 Nexus `POST /v1/execute` 与 WS `/v1/stream` 路由中对注册表已知的 `toolCalling: false` 模型实施前置 400 拦截；Agent 步骤运行器 `runtimeAgentStep.ts` 在执行前调用 `resolveSettings(role)` 解析角色模型并传入 executeStream，对需要工具执行的步骤预检能力；修正 `deepseek/deepseek-reasoner` 的 `toolCalling` 为 `false`（符合 R1 实际 API 行为）。request model 优先级与 structured output role gate 仍按 provider 子 TODO 跟进。

- 完成 P3/P4 架构工程化重构与 Bash 超时修复 (v0.47-v0.48)：彻底拆分了原臃肿庞大的 `program.ts`（>2100行）至按功能划分的 `src/cli/commands/` 目录，并将输入交互与补全解耦至独立的 `ui.ts` 与 `completer.ts`，同时全面消除 `src/cli` 和 `src/nexus` 中残留的 `as any`，确保 strict 编译 0 警告；修复了 Bash 工具的执行超时容错率，将最大超时由 30秒 放大到 300秒，并把缺省默认超时提高到 60秒，降低网络/安装命令的超时报错概率。

- 实现 P2 多执行环境参数校验与可观测执行指标落地 (v0.46)：在 /v1/execute 和 /v1/stream 的 Zod schema 中定义并验证 executionEnvironment 字段，仅允许 local 环境并对 docker/remote 拦截抛出 NOT_IMPLEMENTED 501 状态错误；系统设计了 SQLite metrics 数据库迁移 (user_version = 4)；运行时自动搜集、计算并随 stream 结束派发 execution_metrics 事件（含 TTFT、LLM query 时间、工具耗时与 Delta 统计、输入输出字数），存入 SQLite 中并同步更新暴露至 /v1/runtime/metrics 指标快照。Docker/remote 的实际 runner 设计与实现仍未开始。


- 实现 P2 智能权限分类与自动审计 (v0.45)：对 Read、Grep、Glob 等只读工具以及 ls、pwd、git status 等安全命令执行自动审批，跳过 TUI 询问与阻塞注册，同时在 SQLite 数据库中记录批准决策和规则匹配原因审计日志；对危险及非白名单的命令如 rm -rf 等进行安全拦截和用户提示。新增 classifier 单元测试和 permission flow 自动批准及弹窗集成测试，用例通过率达 100%。

- 实现 P2 性能优化硬化与硬边界核心项 (v0.44)：对 Grep 与 Glob 搜索结果在行级及数组列表级设定硬限额及截断 warning 说明以保护 LLM 上下文；消除 listSessions 获取 events 时的 N+1 数据库多次查询为 LEFT JOIN 单次查询；将 tool_traces 索引重构为复合索引并实现数据库迁移升级 (v3)；对 CLI 顶层依赖执行动态 import 懒加载，实现快速冷启动。大量 session/event 压测与 chat 首响 benchmark 仍待补。

- 实现 TUI 会话输入框双横线分割栏与全宽度对齐支持 (v0.43)：使用 ANSI `\x1b[2A` 光标回移技术在输入框上下两端各渲染长横线，移除 Math.min(..., 72) 使分割线和 slashPalette 补全菜单线条随终端实际列宽自适应百分百拉满；修复 slashPalette 清屏事件导致底线擦除消失的问题。

- 实现三级 inline Skills 动态加载与匹配注入：新增 `loader.ts` 和 `matcher.ts` 支持 built-in、user 和 project 目录叠加，根据 query 触发词与优先级选取至多 3 个 inline skills，格式化为 `Active Developer Skills` 注入 LLM system prompt。编写了 `test/skills.test.ts` 完整验证 overlays 及匹配规则，全部 93 个测试用例通过。

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
