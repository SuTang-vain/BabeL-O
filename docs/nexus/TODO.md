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
| P2/P3 Agents / Task Orchestration | 已完成 P3 HITL 与子任务可视化第一版 | [TODO_agents.md](./TODO_agents.md) | 实现了 TaskSession/TaskQueue 管理，Planner->Executor/Optimizer->Critic 协作闭环，`bbl optimize` 自优化机制、受控 subTasks 委派、Planner 审批和 CLI 子任务状态展示。 |
| P2 Performance Hardening | 核心已收口，压测待补 | [TODO_performance.md](./TODO_performance.md) | Grep/Glob limits、Sqlite N+1 联合查询优化、tool_traces 复合索引自动升级、CLI 模块动态懒加载和结构化 logger 已落地；大量 session/event 压测、chat 首响 benchmark 与 retry benchmark 仍待补。 |
| P0 Context-Aware Runtime | 已完成第一版 | [TODO_runtime.md](./TODO_runtime.md) | ContextBudget、snipCompactor、项目记忆、规则摘要和长会话 benchmark 已落地。 |
| P0 MCP-Ready Extensions | 已完成第一版 | [TODO_runtime.md](./TODO_runtime.md) | stdio-only MCP client、显式 allowedTools 白名单、tools audit 来源展示和 3 个官方 MCP server smoke 已落地。 |
| P1 Knowledge-First Skills | 已完成 | [TODO_runtime.md](./TODO_runtime.md) | 按 `RECOMMENDATIONS.md` 实现 built-in/user/project 三级 inline Skills，支持动态匹配和 system prompt 注入。 |
| P2 Smart Permissions | 已完成 | [TODO_runtime.md](./TODO_runtime.md) | 按 `RECOMMENDATIONS.md` 实现轻量规则分类器，read-only 自动放行，Bash 白名单/黑名单。 |
| P2 Execution Environments | Docker 沙箱已实现，remote runner 待设计 | [TODO_runtime.md](./TODO_runtime.md) | `docker` 执行环境已完整实现：容器按需创建（挂载 workspace）、通过 `docker exec` 执行命令、Session 关闭自动 `docker rm -f`；支持 `--network none` 隔离和 CPU/Memory 资源限制配置；无 Docker 时优雅报错。remote runner protocol 仍待设计。 |
| P2 Observability / Metrics | 指标与日志核心已完成，压测待补 | [TODO_performance.md](./TODO_performance.md) | 已记录并保存执行指标（provider 响应耗时、TTFT、工具轮回、输入/输出字数等）到 SQLite 库与 metrics 路由中；最小结构化 logger 支持 `NEXUS_LOG_LEVEL=silent`；1000+ sessions 压测待补。 |
| P2 Model Capability Routing | 核心已收口，默认推荐待补 | [TODO_provider_registry.md](./TODO_provider_registry.md) | ProfileConfig roles、request model > env model > role model > profile/default 的优先级、toolCalling=false 前置拦截、structured-output role gate 已落地；未配置 roles 时的默认模型推荐策略仍待补。 |
| P0 Safety / Stability Hardening | 已完成 | [TODO_runtime.md](./TODO_runtime.md) | PendingPermissionRegistry TTL、storageBridge 重试队列与 JSONL WAL、WAL 批量写入/fsync 策略、Bash HMAC probe、Bash/TaskQueue/TaskSession 生命周期清理、session close 级联清理，以及 `new Function` 动态 import 清除已落地。 |

## 当前优先级

1. **P1 Safety Hardening**: 收紧 Bash 自动审批白名单、为 MCP tool 接入远端 inputSchema 运行时校验，并把 Optimizer safety 从硬编码黑名单升级为策略配置。
2. **P3 Non-dry-run Provider Smoke**: 用小目录跑真实 `bbl optimize --enable-subagents` 非 dry-run 流程，验证 Planner 审批、子任务委派、父任务回收、worktree 隔离和 Git 保护链路。
3. **P3 Worktree / Git Hardening**: 在已完成的嵌套隔离、cherry-pick 范围合并和冲突文件检测诊断基础上，补充真实 provider smoke、冲突人工恢复策略，并加固非隔离 in-place Git 操作。
4. **P2 Architecture Boundary**: 明确 embedded local 与 Nexus-only 的产品口径，减少 CLI 直接操作 Storage 的路径。
5. **P2/P3 Provider Registry 完善**: 补齐未配置 roles 时的默认推荐策略，并验证推理模型纯文本角色路由。
6. **P2 Reliability / Performance Enhancement**: 继续完善大量 session/event API 响应压测、chat 首响 benchmark、retry policy benchmark、测试并发化和 storageBridge 故障注入。

## 当前阻塞项

- 暂无。

## 最近完成

- 完成 P0 Recoverable Bash Non-Zero Exit (v0.70)：根据真实会话中 `cd /Users/tangyaoyue/DEV/BABEL/BabeL-X && git remote -v && git log --oneline -20` 失败后 Agent 停止继续的问题核实，根因是 Bash 将“命令正常启动但退出码非 0”升级为全局 `TOOL_ERROR`，provider 收不到工具失败结果。现已将本地/Docker Bash 非零退出改为 `tool_completed success=false`，保留 stdout/stderr/exitCode/message，并映射为 `tool_result is_error=true` 回传模型；超时、maxBuffer、spawn/Docker 环境异常仍按运行时错误处理。已验证 `npm run typecheck` 与 Runtime/LLM 目标测试 52/52 通过。

- 删除过期审计快照 `docs/AUDIT_2026-05-24.md`，并将仍成立的结论同步进 TODO 体系：Bash 自动审批白名单硬化、MCP inputSchema 运行时校验、embedded/Nexus 架构边界、非隔离 Git 操作风险、storageBridge 故障注入、AgentLoop 成本 benchmark、测试并发化，以及 CI/lint/build/coverage 工程化事项。已确认 audit 中“Allow-all policy 测试失败”结论过期，当前相关测试通过。

- 完成 P3 Git Cherry-pick Conflict Diagnostics (v0.66)：实现 Worktree 合并冲突时的结构化错误诊断。当 cherry-pick 失败时，通过 `git diff --name-only --diff-filter=U` 自动提取冲突文件列表，清除残留的 cherry-pick 状态，并将详细的冲突文件信息写入错误事件，供 Critic/Planner/用户查看。在单元测试中制造冲突，断言检验了冲突文件提取的正确性，并将 `optimize-command` 测试集正式接入整体运行脚本。已验证类型检查与全部 155 个测试全绿通过。

- 完成 P0 Provider Error Session Outcome 修复 (v0.65)：根据真实 `session_ba17e426-0e80-4b34-909a-d5893cdd04f0` 日志核实，OpenAI 402 `Insufficient Balance` 发生在最后工具结果回传 provider 后；BabeL-O 已产出 `PROVIDER_ERROR`，但 embedded chat 收尾只读取升序前 100 条事件，导致长会话尾部 error 被早期成功 result 覆盖，session 错标为 `completed`。现已改为读取最新事件窗口，并以最新 terminal event 判断 `completed/failed`。已验证 `npm run typecheck` 与 RunSessionFlow/Runtime 目标测试 53/53 通过。

- 完成 P3 Cross-Session Task Delegation & Dynamic Sub-Agents (v0.64)：在执行阶段为拥有 `parentTaskId` 的任务启动独立的子代理 `runAgentLoop` 会话（拥有独立 queueId 和 parentSessionId），使子任务上下文完全隔离。修复了子 Session 因 tasks 的 metadata 重合而递归匹配自身触发 OOM 的 bug；并将 `commitAndMergeWorktree` 升级为检测范围 Commit 并批量 cherry-pick 合并（通过 `git rev-list --reverse parentHead..worktreeHead`），完美解决嵌套隔离环境下子代理 Commit 丢失的问题。已验证 `npm run typecheck` 与 AgentLoop/Worktree 目标测试 148/148 全绿通过。

- 完成 P3 Worktree Isolation 第一版 (v0.63)：带 `requiresIsolation` metadata 的任务会在 Git worktree 中执行，Executor/Critic 收到隔离后的 `cwd`；审核通过后在 worktree 内 commit，并 cherry-pick 回主工作区，随后清理临时 worktree。AgentLoop 隔离路径已避免 merge 后再次执行主仓库 `gitCommit`，防止误导性 no-op commit 或把主工作区其他改动纳入提交。已验证 `npm run typecheck` 与 Worktree/Agent/Optimize/Runtime/Context 目标测试 52/52 通过；真实 provider 非 dry-run smoke 与冲突恢复仍待补。

- 完成 P0 Context-Aware Runtime 显式路径锚定修复 (v0.62)：根据真实 `session_bff7cbdd-d987-4dbf-8145-549c94aed2dc` 日志核实，最新输入 `/Users/tangyaoyue/DEV/BABEL/BabeL-X横向对比分析这个项目` 已写入数据库，但工具调用仍从 BabeL-O 开始，根因是模型把“这个项目”继承为旧历史项目。现已在 system prompt 中列出当前请求显式绝对路径，并规定显式路径是权威任务目标；横向对比且只有一个显式路径时必须先检查该路径，再用旧项目作基线。路径解析支持中文无空格后缀并避免缺失文件误折叠。已验证 `npm run typecheck` 与 Runtime/Context 目标测试 63/63 通过。

- 完成 P3 Planner Human-in-the-Loop 与 subTasks 可视化第一版 (v0.59)：`runAgentLoop()` 增加可注入 `reviewPlan` 钩子，Planner 输出后可生成 `planner_review` pending input，支持确认、编辑任务列表或拒绝并取消 TaskSession；`bbl optimize` 非 dry-run 默认在执行前提示用户审阅计划，`--auto-approve`/`--yes` 可跳过。AgentLoop 事件现在记录完整 task payload，委派成功时记录父任务 blocked 和 `subtasks_delegated` 元信息；CLI Task Status Board 展示父任务 blocked、子任务缩进层级、parentTaskId 与 delegatedSubTaskIds。为真实目录目标 smoke 补齐 `Read` 目录恢复性失败、`Glob` 绝对路径归一化和 Planner 自然语言计划兜底解析。已验证 `npm run typecheck`、Agent/TUI/Optimize/Runtime 目标测试 75/75 通过，以及真实 provider dry-run 输出 4 个 Proposed Tasks。

- 完成 P3 `bbl optimize` subAgents CLI 接入与真实 provider dry-run smoke (v0.58)：新增 `--enable-subagents`、`--max-sub-agent-depth`、`--max-sub-tasks-per-task`，并传入 `runAgentLoop()` 的受控委派配置；修复 Commander 对 `--enable-subagents` 的 camelcase 解析差异；dry-run planner 会创建 TaskSession，避免事件记录失败；Agent role 工具策略现在会过滤 provider 可见工具，Planner 只暴露 Read/Grep/Glob，避免模型调用不可用工具后被 denied；Planner JSON 兼容层可吸收 provider 返回的 `goal/tasks[].description/action/file` 形态。真实 smoke 已用临时目录验证 `bbl optimize --dry-run --enable-subagents` 能读取目标并输出结构化计划。已验证 `npm run typecheck` 与 Agent/Runtime/Optimize 目标测试 34/34 通过。

- 完成 P0 Context-Aware Runtime 连续对话修复 (v0.57)：根据真实 `session_fa312235-4377-430f-b7f9-65753bf6e1ad` 日志核实，历史 `thinking_delta` 被作为 `reasoningContent` 回放给 Minimax，且空 provider 响应被标记为成功，导致“架构性能差异”第一次空 `✓ done`、第二次被 `<file_contents>` 等旧隐藏推理污染。已改为：历史 thinking 只保留日志/UI，不再进入 provider 请求；最近上下文按用户轮次选择，避免长回答 delta 切碎语义边界；空响应产出 `EMPTY_PROVIDER_RESPONSE` 失败结果；连续相同用户输入去重。已验证 Runtime/Context 目标测试 27/27 通过。

- 完成 P3 Agent Orchestration 子任务委派第一版 (v0.55)：参考 BabeL-X coordinator/AgentTool 的优秀约束（不委派琐碎任务、不重复委派、子任务结果作为内部信号、必须有深度上限），但不迁移后台 worker/React AgentTool 复杂体系；在 BabeL-O 中先落地同 TaskQueue 的受控 subTasks。`ExecutorOutputSchema` 增加 `subTasks` 字段；`runAgentLoop()` 新增 `enableSubAgents`、`maxSubAgentDepth`、`maxSubTasksPerTask`；父任务委派后转为 blocked 并依赖子任务，子任务完成后父任务自动回到 pending，由 Executor 汇总收口；超过深度限制时拒绝继续派生并直接按当前执行结果完成。已验证 `npm run typecheck` 和 AgentLoop 目标测试 10/10 通过。

- 完成 P2 Model Capability Routing 收口 (v0.51)：`ConfigManager.resolveSettings()` 支持 `{ model, role, provider }` 显式解析，形成 request model > env model > role model > profile model > defaultModel 的优先级，并修正 provider 前缀模型被 profile provider/env provider 错配的问题；HTTP 与 WS 路由统一使用该解析口径；Agent Step Runner 在执行前对 tool role 检查 `toolCalling`，对 structured-output role 检查 `jsonOutput`，不满足能力声明时前置拒绝且不调用 runtime。已验证 `npm run typecheck` 和 Provider/Agent/Runtime 目标测试 42/42 通过。

- 完成 T0 Reliability 完善 (v0.54)：在 v0.53 的 JSONL WAL replay/ack/compact 和 session close 级联清理基础上，补齐 `storageBridge` WAL 批量写入、flush interval 与 fsync 策略配置；`NEXUS_STORAGE_WAL_BATCH_SIZE`、`NEXUS_STORAGE_WAL_FLUSH_INTERVAL_MS`、`NEXUS_STORAGE_WAL_FSYNC` 可在服务端配置。新增 batch flush 和 1000 pending ops replay 测试，已验证 `npm run typecheck` 与 Agent 目标测试 8/8 通过。

- 完成 P0 Safety / Stability Hardening 收口 (v0.53)：在 v0.50 的 PendingPermissionRegistry TTL、storageBridge 重试队列、Bash HMAC probe 和模块级 Map TTL/prune 基础上，为 `storageBridge` 增加 JSONL WAL replay/ack/compact，支持崩溃后恢复未 flush 的 task/session mutation；新增 `POST /v1/sessions/:sessionId/close` 并让 cancel 复用关闭流程，级联清理 Bash CWD、TaskQueue、TaskSession 和 PendingPermission。已验证 `npm run typecheck` 与 Runtime/Agent 目标测试 33/33 通过。

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
