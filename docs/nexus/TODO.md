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
- [README.md](./README.md): Nexus 文档入口、架构分层、历史文档合并口径。
- [WORK_LOG.md](./WORK_LOG.md): 时间线工作记录，只记录事实和验证。
- [TODO_tool_result_budget.md](./TODO_tool_result_budget.md): 工具结果持久化与消息级预算规划（P0，来自 session_e9fa6e3a 实战分析）。

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
| P0 Context-Aware Runtime | 已完成 | [TODO_runtime.md](./TODO_runtime.md) | ContextBudget、snipCompactor、项目记忆、规则摘要、长会话 benchmark、显式路径 CWD 跟随、输入退化 focus 锚定、Glob path 参数已落地。 |
| P0 MCP-Ready Extensions | 已完成第一版 | [TODO_runtime.md](./TODO_runtime.md) | stdio-only MCP client、显式 allowedTools 白名单、tools audit 来源展示和 3 个官方 MCP server smoke 已落地。 |
| P1 Knowledge-First Skills | 已完成 | [TODO_runtime.md](./TODO_runtime.md) | 按 `RECOMMENDATIONS.md` 实现 built-in/user/project 三级 inline Skills，支持动态匹配和 system prompt 注入。 |
| P2 Smart Permissions | 已完成 | [TODO_runtime.md](./TODO_runtime.md) | 按 `RECOMMENDATIONS.md` 实现轻量规则分类器，read-only 自动放行，Bash 白名单/黑名单。 |
| P2 Execution Environments | Docker 沙箱已实现，remote runner 待设计 | [TODO_runtime.md](./TODO_runtime.md) | `docker` 执行环境已完整实现：容器按需创建（挂载 workspace）、通过 `docker exec` 执行命令、Session 关闭自动 `docker rm -f`；支持 `--network none` 隔离和 CPU/Memory 资源限制配置；无 Docker 时优雅报错。remote runner protocol 仍待设计。 |
| P2 Observability / Metrics | 指标与日志核心已完成，压测待补 | [TODO_performance.md](./TODO_performance.md) | 已记录并保存执行指标（provider 响应耗时、TTFT、工具轮回、输入/输出字数等）到 SQLite 库与 metrics 路由中；最小结构化 logger 支持 `NEXUS_LOG_LEVEL=silent`；1000+ sessions 压测待补。 |
| P2 Model Capability Routing | 核心已收口，默认推荐待补 | [TODO_provider_registry.md](./TODO_provider_registry.md) | ProfileConfig roles、request model > env model > role model > profile/default 的优先级、toolCalling=false 前置拦截、structured-output role gate 已落地；未配置 roles 时的默认模型推荐策略仍待补。 |
| P0 Safety / Stability Hardening | 已完成 | [TODO_runtime.md](./TODO_runtime.md) | PendingPermissionRegistry TTL、storageBridge 重试队列与 JSONL WAL、WAL 批量写入/fsync 策略、Bash HMAC probe、Bash/TaskQueue/TaskSession 生命周期清理、session close 级联清理，以及 `new Function` 动态 import 清除已落地。 |
| P0 调优推进（System Prompt / Provider / 工具容错） | 已完成 | — | 分段式 systemPromptBuilder（7 静态段 + 动态段）、工具 prompt()、defaultMaxTokens 按模型族设值、withRetry() 重试、eval 移除、分段 prompt caching、TOOL_NOT_FOUND 容错、Max Output Recovery、messageNormalizer、120s 超时保护；microcompactEvents 按轮次边界截断旧 assistant/tool 上下文；deepseek-v4-pro defaultMaxTokens 提升至 16384。 |
| P0 LLM 语义摘要升级 | 已完成 | — | `compactSummary.ts` 新建：LLM 生成 9 段结构化摘要（用户意图/技术概念/文件代码/错误修复/问题解决/用户消息/待完成任务/当前工作/下一步）替代纯统计拼接；`queryModelText()` 流式文本收集器；`formatCompactSummary()` 解析 `<analysis>/<summary>` 块；LLM 失败自动 fallback 统计摘要；summary 预算 2K→4K tokens；`compact-summary.test.ts` 已纳入 `npm test`；全量测试 239/239 通过。 |
| P0 AGENT.md + Git 状态注入 | 已完成 | — | `agentMdLoader.ts` 新建：向上遍历目录发现并加载 AGENTS.md 和 `.babel-o/AGENTS.md`，去重，8K 字符上限；`gitContext.ts` 新建：分支/状态/最近 5 提交收集，execFile 安全执行，非 git 仓库优雅降级；`contextAssembler.ts` 并行加载三个上下文源并传入 `buildSystemPromptSections`。 |
| P0 BabeL-X 对齐 + 防重复 + contextAssembler 重构 | 已完成 | — | 移除 BabeL-X 不存在的 per-section system prompt 截断；增加 BabeL-X 风格 memory 双限截断（200 行 + 25KB）；recovery boundary 对齐取消/超时恢复；`protectToolPairs()` 工具对完整性；`eventIdentity()` 稳定标识；system prompt 防重复指令；全量测试 241/243 通过（2 pre-existing ConfigManager 泄漏）。 |
| P0 长会话可靠性（session_d61f22d0 实战驱动） | 已完成 | — | 基于 7 轮实战会话分析：auto-compact 默认开启；stop_reason 暴露（FinishDelta）+ max_tokens 截断恢复（最多 3 次续写重试）；工具结果 per-turn 预算截断（maxChars*30%）；三层 Context Warning 梯度（WARNING 70% → COMPACT 85% → BLOCKING ~99%）；全量测试 242/244 通过。 |

## 当前优先级

### Docs Canonicalization

`docs/nexus` 是当前唯一权威文档目录。旧的根目录文档已经合并为以下口径：

- 架构原则、分层边界和 Nexus-first 约束进入 [README.md](./README.md)。
- BabeL-X 迁移建议进入本文件的“BabeL-X 精华设计迁移结论”以及各主线 TODO。
- 调优规划、provider 加固、system prompt、工具容错和上下文能力结论进入 [TODO_runtime.md](./TODO_runtime.md)、[TODO_provider_registry.md](./TODO_provider_registry.md)、[CONTEXT_GAP_ANALYSIS.md](./CONTEXT_GAP_ANALYSIS.md) 和 [WORK_LOG.md](./WORK_LOG.md)。
- 一次性 implementation/task/walkthrough 记录只保留在 [WORK_LOG.md](./WORK_LOG.md) 的事实时间线中。

后续新增文档必须放入 `docs/nexus`，并在 [README.md](./README.md) 中登记入口。

### P0 长会话可靠性优化（来自 session_d61f22d0 实战分析）

基于真实会话 `session_d61f22d0-9016-45f7-bc86-2b36a1114189` 的深度分析，发现 5 个问题：

| # | 问题 | 严重度 | 状态 |
|---|------|--------|------|
| 1 | Context 膨胀：auto-compact 默认关闭 | 🔴 P0 | ✅ 已修复 |
| 2 | 模型重复工作：无摘要保护下重复读取相同文件 | 🔴 P0 | ✅ 已修复 |
| 3 | REQUEST_CANCELLED 恢复边界 | 🟡 P1 | ✅ 已修复 |
| 4 | 模型用 Bash cat 代替 Read 工具 | 🟡 P1 | ✅ 已修复 |
| 5 | Token 估算 CJK 系数偏保守 | 🟢 P2 | 可接受 |

**问题 1 详情**：`BABEL_O_AUTO_COMPACT` 环境变量默认未设置 → `isAutoCompactEnabled()` 返回 `false` → 只有 reactive compact（blocking limit 85%）在溢出时触发。deepseek-v4-pro 128K context window，427K chars ≈ 107K tokens 在 80% 阈值附近波动，从未稳定超过 blocking limit。每轮工具输出膨胀上下文，`selectRecentEvents` 又砍旧事件，模型不断丢失早期上下文但从不产生摘要。

**问题 2 详情**：问题 1 的直接后果——没有 compact 摘要，模型只能看到最近 N 个事件，无法知道更早轮次已读过哪些文件。System prompt 缺少"不要重复已完成工作"的强约束。

**问题 4 详情**：`getToolUsageSection()` 已有"用 Read 代替 cat"指令，但位置靠后、权重不够，模型仍频繁违反。

#### 优化计划（全部已完成）

1. ~~**P0 Auto-Compact 默认开启**~~: ✅ `isAutoCompactEnabled()` 未设置时默认 `true`
2. ~~**P0 System Prompt 防重复指令强化**~~: ✅ "不重复"规则 + 工具偏好强制引导
3. ~~**P1 工具选择引导增强**~~: ✅ Bash 需权限审批 vs Read 自动放行
4. ~~**P0 stop_reason 暴露 + max_tokens 截断恢复**~~: ✅ `FinishDelta` 类型 + 续写重试
5. ~~**P1 工具结果 per-turn 预算截断**~~: ✅ `maxChars * 30%` 限制 + `TURN_BUDGET_EXCEEDED`
6. ~~**P1 三层 Context Warning 梯度**~~: ✅ WARNING(70%) → COMPACT(85%) → BLOCKING(~99%)

### P0 上下文能力补齐（首要主线，来自 CONTEXT_GAP_ANALYSIS.md）

当前目标：优先把 BabeL-O 的长会话、连续任务和 compact 恢复能力补齐到接近 BabeL-X 的可用水位。当前代码已完成 persisted compact boundary、`retainedEvents` tail、retained segment hash/anchor 校验、recovery boundary、显式路径锚定、auto-compact benchmark、中文保守 token estimator、provider call 前 blocking limit、`/context` 诊断、`analyzeContext()` API、轻量 Post-Compact State Rebuild、microcompact 按轮次边界截断、两层 snip 策略、system prompt 分段硬截断、compact capability reminder、LLM 结构化语义摘要（9 段 prompt + `<analysis>/<summary>` 解析 + 统计 fallback）、AGENT.md 自动发现与注入、Git 状态上下文收集（分支/status/log）、opt-in Session Memory Lite 和 context regression corpus、stop_reason 暴露 + max_tokens 截断恢复、工具结果 per-turn 预算截断、三层 Context Warning 梯度（WARNING/COMPACT/BLOCKING）；整体能力约为 BabeL-X 的 96%-98%。下一步按阻塞程度推进：

1. ~~**P1 Microcompact / API Invariant Guard**~~: ✅ 已完成。`microcompactEvents()` 按 `user_message` 轮次边界区分 prior/current turn，旧轮次 `assistant_delta` 截断至 `microcompactInternalTextChars`，旧轮次 `tool_completed` 使用更紧凑的 `snipPriorTurnToolOutputChars`；`protectToolPairs()` 保护工具对完整性；`eventIdentity()` 稳定事件标识。
2. ~~**P1 System Prompt 分层硬截断**~~: ✅ 已完成。`enforceDynamicLayerBudgets()` 按 memory/summary/skills 预算分层裁剪，BabeL-X 对齐（不做 system prompt section 内部截断，只做消息层 microcompact/compact）。
3. ~~**P1 MCP / Skill Delta 重宣布**~~: ✅ 已完成。compact boundary 后通过 `Post-Compact State` + `Compact Capability Reminder` 重新声明 recent tools、active skills、task/hook 状态和必要 tool contract，强调 `tool_use/tool_result` 按 `toolUseId` 配对。
4. ~~**P1 `selectOmittedEvents` 稳定身份**~~: ✅ 已完成。`eventIdentity()` 已实现。
5. ~~**P1 manual compact 重置 auto-compact 熔断计数**~~: ✅ 已完成。`countConsecutiveAutoCompactFailures()` 遇到任意成功 `compact_boundary` 即停止向前累计，manual/reactive compact success 会清掉边界之前的 auto failure。
6. ~~**P0 LLM 语义摘要升级**~~: ✅ 已完成。`compactSummary.ts` 实现 LLM 生成 9 段结构化摘要替代纯统计拼接；`queryModelText()` 流式文本收集器；`formatCompactSummary()` 解析 `<analysis>/<summary>` 块；LLM 失败自动 fallback 统计摘要；summary 预算 2K→4K tokens；`compact-summary.test.ts` 已纳入测试。
7. ~~**P0 AGENT.md + Git 状态注入**~~: ✅ 已完成。`agentMdLoader.ts` 向上遍历目录发现 AGENTS.md；`gitContext.ts` 分支/状态/最近提交收集；并行加载并注入 system prompt。
8. ~~**P0 System Prompt 防重复 + BabeL-X 对齐**~~: ✅ 已完成。移除 BabeL-X 不存在的 per-section system prompt 截断；增加 BabeL-X 风格 memory 双限截断（200 行 + 25KB）；`recovery boundary` 对齐取消/超时事件恢复；`protectToolPairs()` 工具对完整性保护；全量测试 241/243 通过。
9. ~~**P2 Session Memory Lite**~~: ✅ 第一版已完成。compact 成功后在 `BABEL_O_SESSION_MEMORY_LITE=1` 时维护 `.babel-o/session-memory.md`，只允许写入该固定文件；写入后追加 `session_memory_updated` 事件，但不把该文件注入主 context/read cache。后续再接 BabeL-X 风格 Post-Sampling Hook、异步后台 agent 和成本控制。
10. ~~**P2 Preserved Segment / Resume Verification**~~: ✅ 第一版已完成。`compact_boundary.retainedSegment` 记录 retained count、boundary anchor、first/last event identity 和 hash；`contextAssembler` 恢复时校验，异常则回退完整历史并在 `Session Summary` 和 `/context` 中展示 preserved segment warning。
11. ~~**P2 Model Fallback / Max Output Recovery 诊断层**~~: ✅ 第一版已完成。新增 provider recovery 分类：`ESCALATED_MAX_TOKENS`、`ESCALATED_CONTEXT_WINDOW`、`RETRY_PROVIDER_RATE_LIMIT`、`PROVIDER_AUTH_OR_BILLING` 等写入 error `details` 并在 TUI 展示建议。未做自动 fallback model 切换，后续需与 provider role routing 和用户确认策略合并。
12. ~~**P2 Context Regression Corpus**~~: ✅ 第一版已完成。新增 `test/context-regression.test.ts`，固化 workspace escape 后继续、cancel 后继续、provider empty response、invalid tool input/schema failure 等真实漂移样本，防止 compact/summary/context selection 回归。
13. ~~**P1/P2 Short Prompt Pivot + Bash Path Guard**~~: ✅ 已完成。基于 `session_7b928e48` 修复：短问候/状态追问只保留最新用户轮次，不继续旧任务工具链；Bash 命令绝对路径也执行 workspace preflight，越界返回 recoverable `WORKSPACE_PATH_ESCAPE`，避免绕过 Read/Glob 边界。
14. ~~**P1/P2 Bash retained CWD Workspace Switch Guard**~~: ✅ 已完成。基于 `session_b4fd19a4` 修复：同一 session 多项目切换时，Bash retained CWD 不再污染新 workspace；跨 workspace 自动清除旧 shell cwd，路径 preflight 以本轮 `context.cwd` 为准。
15. ~~**P1/P2 Session CWD Persistence + Correction Pivot**~~: ✅ 已完成。基于 `session_e9fa6e3a` 修复：`session_started.cwd` 写回 session snapshot，后续无显式路径纠错句继承上一轮项目 cwd；“让你分析的就是/我说的是/不是 A 是 B”触发 pivot，不继续回放旧项目工具链。
16. **P2/P3 自动 Model Fallback 执行策略**：在诊断层稳定后，设计何时自动切换 fallback model、何时降低 max output、何时要求用户确认，避免 provider 账单/模型行为不可控。
17. **P0 工具结果持久化与消息级预算**：参考 BabeL-X `toolResultStorage.ts`，实现两层预算（单条结果 >50K 持久化到磁盘 + 消息聚合 >200K 替换为预览），消除工具循环中的重复 token 消耗。预计单轮 input token 减少 50-60%。详见 [TODO_tool_result_budget.md](./TODO_tool_result_budget.md)。
18. **P2 Prompt Intent Classifier / Pivot Guard 扩展**：将当前规则型 pivot 识别扩展为可测试的小型意图分类器，覆盖”换项目/换话题/停一下/只回答我/不要继续旧任务”等中文短句，并在 `/context` 中展示 pivot reason。

### 原有主线优先级

1. **P3 Role Structured Output Repair / Retry**: 在上下文能力 P0/P1 收口后继续。真实 provider 非 dry-run smoke 已证明 Git/rollback 链路可运行，当前阻塞集中在 Planner/Optimizer structured output 变体和 provider 空响应；AgentLoop 已能显示 `structured` failureType、缺失字段和候选来源，下一步实现 role-level repair prompt、一次自修复重试或更稳定的 role model 路由。
2. **P1 Nexus Hooks 最小内核**: ✅ 已完成第一版。在 Nexus core 中实现了 `PreToolUse`、`PostToolUseFailure`、`PermissionRequest`、`SubagentStart`、`SubagentStop`、`SessionEnd`、`UserPromptSubmit` 生命周期钩子。内置 Hooks 包括：`RecoverInvalidToolInputHook`（工具输入失败重试提示）、`BashFailureSummaryHook`（Bash 失败摘要）、`PermissionExplanationHook`（权限解释）、`SessionCleanupAuditHook`（Session 清理审计）、`SubagentLifecycleHook`（子 Agent 生命周期记录）、`UserPromptAuditHook`（用户提示审计）。后续补 hook 配置、timeout 隔离和更完整审计。
3. **P1 Context Compact UX**: ✅ 核心已完成并进入增强阶段。已实现 `/compact` 命令、`context_warning`、auto-compact threshold（opt-in，默认 90%）、compact failure 熔断、`compact_boundary.retainedEvents`、CLI renderer 展示、手动 compact smoke 和 auto-compact benchmark。后续增强项已提升为上方“上下文能力补齐”首要主线。
4. **P2/P3 Provider Registry 完善**: 补齐未配置 roles 时的默认推荐策略，并验证推理模型纯文本角色路由，让 Planner/Executor/Critic 默认落到更符合 capability 的模型。
5. **P3 Non-dry-run Provider Smoke**: 在 structured-output repair、hooks 和 role model routing 后，用小目录继续跑真实 `bbl optimize --enable-subagents` 非 dry-run 流程，验证 Planner 审批、子任务委派、父任务回收、worktree 隔离和 Git 保护链路。
6. **P2 Agent Lifecycle Visibility**: 参考 BabeL-X AgentTool / BackgroundTask 的状态治理，补齐子 Agent transcript、权限继承、MCP/skill 上下文继承、parent blocked、child running/completed、depth、parentTaskId、delegatedSubTaskIds 的统一事件模型和 CLI 展示。
7. **P2 TUI Interaction Hardening**: 参考 BabeL-X PromptInput 的状态分层，但保持轻量 ANSI/readline；状态机、唯一输入框、slash/tool palette、权限多级 approval 和 agent status 已完成第一版，后续重点补 PTY/screenshot smoke 与键盘路径回归。
8. **P2 Architecture Boundary**: 明确 embedded local 与 Nexus-only 的产品口径，减少 CLI 直接操作 Storage 的路径。
9. **P2 Reliability / Performance Enhancement**: 继续完善大量 session/event API 响应压测、chat 首响 benchmark、retry policy benchmark、测试并发化和 storageBridge 故障注入。
10. **P2 Build / CI Hardening**: 补齐生产 build、lint/format、CI 与 coverage report，避免发布路径继续依赖 tsx。

## BabeL-X 精华设计迁移结论

2026-05-24 横向阅读 `/Users/tangyaoyue/DEV/BABEL/BabeL-X` 后确认：BabeL-X 的可复用价值主要在交互编排和生命周期治理，而不是单个工具实现。BabeL-O 应吸收机制，不吸收重量。

### 应优先吸收

- **Lifecycle Hooks**: BabeL-X 在 `src/utils/hooks.ts` 中围绕 `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`UserPromptSubmit`、`SubagentStart`、`SessionEnd` 建立了统一扩展点。BabeL-O 应做 Nexus-owned 最小内核，用事件和 typed input/output 驱动，而不是复制 shell/plugin/telemetry/React 相关复杂度。
- **Agent Lifecycle Governance**: BabeL-X `AgentTool` / `runAgent` 不是简单拉起子模型，而是包含 agentId、permission mode、allowedTools、MCP 继承、frontmatter hooks、transcript、worktree notice、后台任务登记和 cleanup。BabeL-O 已有 TaskQueue/subAgents/worktree，下一步应补生命周期事件、独立 transcript、权限继承边界和恢复/取消语义。
- **Context Compact and Warning UX**: BabeL-X 的 `autoCompact.ts` / `TokenWarning.tsx` 提供 token 阈值、auto-compact、blocking limit、失败熔断和用户可见提示。BabeL-O 已有 context budget 与恢复边界，应将其产品化为 `/compact`、context warning、compact failure event 和 auto-compact policy。
- **Permission Approval Options**: BabeL-X 的 Bash/File permission dialog 支持一次批准、拒绝、批准并记住、编辑 allow rule、拒绝/批准反馈。BabeL-O 已完成安全分类器和多级权限 UI 第一版，后续应补 rule 编辑、session/project scope、可审计 permission decision reason。
- **Prompt Input State Separation**: BabeL-X PromptInput 把输入缓冲、history、slash typeahead、modal overlay、footer、agent status、background tasks 分层处理。BabeL-O 不迁移 React/Ink，但要继续采用状态机/overlay 方式保证输入框、slash 菜单和 agent 状态互不抢键盘。

### 暂不吸收或禁止直接迁移

- 不迁移 BabeL-X 的 React/Ink TUI 到 runtime core；CLI 交互增强继续走 lightweight renderer。
- 不迁移 analytics、GrowthBook、cloud telemetry、desktop/remote/team/swarm 全量体系。
- 不复制 `src/utils/hooks.ts` 这种巨型文件；按 BabeL-O 的 Nexus event schema 重写最小 Hook executor。
- 不让 CLI UI 状态进入 runtime；runtime 只产出结构化事件，CLI 负责展示。
- 不把 fork subagent 的完整 prompt-cache 优化作为近期目标；先完成 task/sub-agent 生命周期、transcript 和权限继承。

### 推荐落地顺序

1. Nexus Hooks 最小内核：`PreToolUse`、`PostToolUseFailure`、`PermissionRequest`、`SubagentStart`、`SessionEnd`。
2. `/compact` 与 auto-compact warning：先提供手动 compact 和上下文剩余提示，再做自动 compact。
3. 子 Agent lifecycle：独立 transcript、permission inheritance、MCP/skill inheritance、cancel/resume。
4. 权限 approval rule editor：一次/会话/项目级批准，Bash prefix rule 可编辑。
5. TUI 状态分层最终收口：输入框、slash overlay、permission panel、agent running indicator、tool block 独立渲染与键盘路由。

## 当前阻塞项

- 暂无。

## 最近完成

- 完成 P0 长会话可靠性 (v0.92)：基于 session_d61f22d0 实战分析实施 4 项修复。P0-1: `FinishDelta` 类型 + AnthropicAdapter/OpenAIAdapter 暴露 stop_reason（`message_delta.stop_reason` / `choices[0].finish_reason`）。P0-2: max_tokens 截断检测 + 续写重试（最多 3 次）。P1-1: 工具结果 per-turn 预算截断（`maxChars * 30%`，超限后后续工具跳过并返回 `TURN_BUDGET_EXCEEDED`）。P1-2: 三层 Context Warning 梯度（WARNING 70% → COMPACT 85% → BLOCKING ~99%）。同步修正分析文档中 4 处事实性错误。全量测试 242/244 通过。

- 完成 P0 调优推进 (v0.86)：基于调优规划和深度分析文档实现 Phase 1-3 P0 级调优。Phase 1 System Prompt 工程：分段式 `systemPromptBuilder`（7 静态段 + 动态段）、7 个内置工具 `prompt()` 方法、system 预算 500→5000。Phase 2 Provider 加固：`defaultMaxTokens` 按模型族设值替代硬编码 4096、`withRetry()` 指数退避重试、eval 移除替换为 `_parseError` 标记、Anthropic 分段 prompt caching。Phase 3 工具容错：TOOL_NOT_FOUND 从 return 改为 continue、Max Output Recovery 空响应重试、`messageNormalizer` 孤立块修复、120s 超时保护。新建 4 个测试文件共 27 个测试，全量测试 215/217 通过（2 个 pre-existing 失败与本次无关）。

- 完成 P0 Recoverable Workspace Path Escape (v0.87)：根据 `session_97950217-70e2-4609-8e7c-2c1cdcc3da9c` SQLite 日志核实，`Read /Users/tangyaoyue/DEV/BabeL/BabeL-O/package.json` 触发 `TOOL_ERROR: Path escapes workspace` 后工具循环被全局错误中断，用户继续输入后模型丢失当前目标并漂移到其他项目。现已将 workspace escape 归一为 `WORKSPACE_PATH_ESCAPE` 可恢复工具失败，继续保持 workspace 安全边界，但通过 `tool_completed success=false` 与 provider `tool_result isError=true` 回传给模型；同时修正 `resolveInsideWorkspace` 的真实路径/大小写/`..` 前缀目录边界判断。已验证 typecheck 与 Runtime/LLM/Security 目标测试通过。

- 完成 P0 Recoverable Invalid Tool Input (v0.76)：根据最新 `session_0f3f9a49-7558-4174-ac35-27c176bc0083` 日志核实，模型调用 `Write` 时只传 `content` 未传 `path`，`LLMCodingRuntime` 原先将 schema 校验失败升级成全局 `INVALID_TOOL_INPUT` 并终止。现改为 `tool_completed success=false` + provider `tool_result isError=true`，让模型能看到缺失字段并补齐参数重试。已验证 `npm run typecheck` 与 Runtime LLM 目标测试 26/26 通过。

- 完成 P0 Chat Recovery Context Boundary and Cancellation Semantics (v0.75)：根据最新 `session_0b39043f-04a3-49d2-b77e-5d84153d4de7` 日志核实，用户 ESC/超时后的追问已写入 `last_user_input`，但旧长任务工具链仍作为 live context 回放，导致模型继续读旧文件。现已在 context assembler 中增加取消/超时/失败后的恢复边界，新用户输入会作为新的 recent context 起点；runtime 同时区分 `REQUEST_CANCELLED` 与真正的 `REQUEST_TIMEOUT`。已验证 `npm run typecheck` 与 Context/Runtime/RunSession 目标测试 69/69 通过。

- 完成 P3 Agent Structured Output Failure Diagnostics (v0.74)：`RuntimeAgentStepError.summary` 增加 structured-output 诊断对象，可区分 `no_structured_json`、`schema_mismatch`、`provider_error`，并暴露 candidateSources、missingRequiredKeys、schemaErrors 与输出预览；CLI task session 摘要优先展示 `structured=<type>`、`missing=<keys>`、`sources=<candidateSources>`，方便真实 provider smoke 直接定位失败原因。已验证 `npm run typecheck` 与 Agent/TUI/Runtime 目标测试 53/53 通过。

- 完成 P3 Agent Failure Observability and Provider Smoke Diagnostics (v0.73)：Agent step 失败现在携带 role、tool、result、provider error 与最后 tool 输出摘要；CLI 可直接展示 executor/optimizer 失败原因。真实非 dry-run smoke 已定位到 Planner 空 JSON、Optimizer structured output 字段缺失和 provider 空响应；已补 Planner 空计划 fallback 与 Executor 常见字段归一化。已验证 `npm run typecheck` 与 Runtime/Agent/TUI 目标测试 52/52 通过。

- 完成 P3 Worktree / Git Hardening (v0.72)：`commitAndMergeWorktree()` 改为基于 `git status --porcelain=v1 -z` 的显式 pathspec staging，替代宽泛 `git add -A`；in-place optimizer commit 替代 `git add .`，rollback 替代 `git reset --hard && git clean -fd`，避免删除用户未跟踪文件；保留嵌套 worktree commit range 合并能力，确保子 Agent 变更能继续回主工作区。已验证 `npm run typecheck` 与 Worktree/AgentLoop 目标测试 18/18 通过。

- 完成 P1 Safety Hardening 收口 (v0.71)：Bash 自动审批从单条宽松正则改为轻量 shell 词法扫描 + 精确命令白名单，`npm test`、宽松 `npx tsc .*`、`cat /dev/*`、管道/重定向/命令替换等均需人工确认；Optimizer safety 升级为可注入策略配置，新增 lockfile、`git reset --hard`、`git clean -fd` 等保护；MCP tool 运行时按远端 `inputSchema` 校验，失败以可恢复 tool result 返回。已验证 `npm run typecheck`、Classifier/Optimizer/MCP/Permission 目标测试通过。

- 完成 P0 Recoverable Bash Non-Zero Exit (v0.70)：根据真实会话中 `cd /Users/tangyaoyue/DEV/BABEL/BabeL-X && git remote -v && git log --oneline -20` 失败后 Agent 停止继续的问题核实，根因是 Bash 将“命令正常启动但退出码非 0”升级为全局 `TOOL_ERROR`，provider 收不到工具失败结果。现已将本地/Docker Bash 非零退出改为 `tool_completed success=false`，保留 stdout/stderr/exitCode/message，并映射为 `tool_result is_error=true` 回传模型；超时、maxBuffer、spawn/Docker 环境异常仍按运行时错误处理。已验证 `npm run typecheck` 与 Runtime/LLM 目标测试 52/52 通过。

- 删除过期审计快照 `docs/AUDIT_2026-05-24.md`，并将仍成立的结论同步进 TODO 体系：Bash 自动审批白名单硬化、MCP inputSchema 运行时校验、embedded/Nexus 架构边界、非隔离 Git 操作风险、storageBridge 故障注入、AgentLoop 成本 benchmark、测试并发化，以及 CI/lint/build/coverage 工程化事项。已确认 audit 中“Allow-all policy 测试失败”结论过期，当前相关测试通过。

- 完成 P3 Git Cherry-pick Conflict Diagnostics (v0.66)：实现 Worktree 合并冲突时的结构化错误诊断。当 cherry-pick 失败时，通过 `git diff --name-only --diff-filter=U` 自动提取冲突文件列表，清除残留的 cherry-pick 状态，并将详细的冲突文件信息写入错误事件，供 Critic/Planner/用户查看。在单元测试中制造冲突，断言检验了冲突文件提取的正确性，并将 `optimize-command` 测试集正式接入整体运行脚本。已验证类型检查与全部 155 个测试全绿通过。

- 完成 P0 Provider Error Session Outcome 修复 (v0.65)：根据真实 `session_ba17e426-0e80-4b34-909a-d5893cdd04f0` 日志核实，OpenAI 402 `Insufficient Balance` 发生在最后工具结果回传 provider 后；BabeL-O 已产出 `PROVIDER_ERROR`，但 embedded chat 收尾只读取升序前 100 条事件，导致长会话尾部 error 被早期成功 result 覆盖，session 错标为 `completed`。现已改为读取最新事件窗口，并以最新 terminal event 判断 `completed/failed`。已验证 `npm run typecheck` 与 RunSessionFlow/Runtime 目标测试 53/53 通过。

- 完成 P3 Cross-Session Task Delegation & Dynamic Sub-Agents (v0.64)：在执行阶段为拥有 `parentTaskId` 的任务启动独立的子代理 `runAgentLoop` 会话（拥有独立 queueId 和 parentSessionId），使子任务上下文完全隔离。修复了子 Session 因 tasks 的 metadata 重合而递归匹配自身触发 OOM 的 bug；并将 `commitAndMergeWorktree` 升级为检测范围 Commit 并批量 cherry-pick 合并（通过 `git rev-list --reverse parentHead..worktreeHead`），完美解决嵌套隔离环境下子代理 Commit 丢失的问题。已验证 `npm run typecheck` 与 AgentLoop/Worktree 目标测试 148/148 全绿通过。

- 完成 P3 Worktree Isolation 第一版 (v0.63)：带 `requiresIsolation` metadata 的任务会在 Git worktree 中执行，Executor/Critic 收到隔离后的 `cwd`；审核通过后在 worktree 内 commit，并 cherry-pick 回主工作区，随后清理临时 worktree。AgentLoop 隔离路径已避免 merge 后再次执行主仓库 `gitCommit`，防止误导性 no-op commit 或把主工作区其他改动纳入提交。已验证 `npm run typecheck` 与 Worktree/Agent/Optimize/Runtime/Context 目标测试 52/52 通过；真实 provider 非 dry-run smoke 与冲突恢复仍待补。

- 完成 P0 Context-Aware Runtime 上下文锚定硬化 (v0.81)：深度修复 session `session_a1b20033` 中 Agent 无法按指令继续的系统性失效。根因包括 CWD 漂移（session cwd 始终是 `/Users/tangyaoyue`）、Glob `path` 参数被静默忽略、输入退化后上下文丢失、历史 thinking 污染和指令理解偏差。修复措施：`LLMCodingRuntime.executeStream` 新增 `resolveCwdFromPrompt()` 跟随用户输入中的显式绝对路径自动切换 cwd；`glob.ts` 正式支持 `path` 参数并用 `resolveInsideWorkspace` 校验；system prompt 新增 `Current focus project` 块防止输入退化后丢失项目上下文；Guidelines 新增工具意图映射规则（run→Bash、find→Glob/Grep、read→Read）。已验证 `npm run typecheck` 与全量 178/178 测试通过。

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
