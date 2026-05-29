# TODO Runtime / Nexus

## 目标

Nexus 是 BabeL-O 的执行核心。它负责 API、event stream、runtime orchestration、sessions、tasks、storage、安全边界和服务状态，不依赖 CLI UI 或终端状态。

## P0 已完成摘要

- [x] 建立 `src/nexus/` 服务目录。
- [x] 使用 Fastify 作为 HTTP API 服务。
- [x] 使用 `@fastify/websocket` 暴露 `/v1/stream`。
- [x] 实现 `GET /health`。
- [x] 实现 `GET /v1/runtime/status`。
- [x] 实现 `POST /v1/execute`。
- [x] 实现 `GET /v1/sessions`。
- [x] 实现 `GET /v1/sessions/:sessionId`。
- [x] 实现 `GET /v1/sessions/:sessionId/tasks`。
- [x] 实现 `POST /v1/sessions/:sessionId/tasks`。
- [x] 建立 `Runtime.ts` runtime facade。
- [x] 建立 `LocalCodingRuntime` 作为 deterministic local runtime。
- [x] 建立 `MemoryStorage`。
- [x] 建立 `SqliteStorage`。
- [x] 建立共享 `NexusEvent`、`SessionSnapshot`、`NexusTask` 类型。
- [x] 实现 `POST /v1/sessions/:id/input`。
- [x] 实现 `POST /v1/sessions/:id/cancel`。
- [x] 实现 `PATCH /v1/sessions/:id/tasks/:taskId`。
- [x] 实现 `POST /v1/sessions/:id/tasks/:taskId/claim`。
- [x] 实现 `POST /v1/sessions/:id/tasks/:taskId/complete`。
- [x] `npm run typecheck` 通过。
- [x] `npm test` 通过。
- [x] embedded CLI smoke 通过。
- [x] service mode smoke 通过。

## P1 Runtime Core

- [ ] 将 `LocalCodingRuntime` 改为可组合 runtime pipeline：prompt parser、provider call、tool loop、result aggregator。
- [x] 新增 `LLMCodingRuntime`，实现 provider stream、tool loop、result aggregator 第一版。
- [x] 实现零额外依赖的 Bash 状态探测软拦截（State Probing），使 Bash 工具在同一会话下能够保持工作目录（CWD）。
- [x] 将 Bash 状态探测从固定标记改为每次执行随机 nonce + HMAC + `timingSafeEqual` 验证，避免用户命令伪造 marker 注入 CWD。
- [x] Bash `sessionCwdMap` 增加 lastActiveAt、24 小时默认 TTL、每小时后台 sweeper、`pruneBashSessionState()` 与 `clearBashSessionState()`。
- [x] 实现完整 request context：`requestId`、`sessionId`、`cwd`、`model`、`budget`、`abortSignal`。
- [x] runtime execute options 已传递 `sessionId`、`cwd`、`abortSignal` 与工具输出预算。
- [x] 给 `/v1/execute` 加 timeout。
- [x] 给 `/v1/stream` 加 cancellation / close handling。
- [x] 增加标准 error code：`INVALID_REQUEST`、`SESSION_NOT_FOUND`、`TOOL_DENIED`、`REQUEST_TIMEOUT`、`PROVIDER_ERROR`。
- [x] 工具异常事件保留结构化 `details`，包含 stdout/stderr/code/signal，并对 stdout/stderr 分别按工具输出预算截断。
- [x] Bash 非零退出码作为可恢复失败结果回传模型：`tool_completed success=false` 保留 stdout/stderr/exitCode/message，并在 LLM 请求中映射为 `tool_result is_error=true`，避免 AgentLoop 因可预期命令失败直接中断。
- [x] 增加 `thinking_delta` event。
- [x] 增加 `GET /v1/schema/events`。
- [x] 增加 `GET /v1/tools/audit`。
- [x] 增加 `POST /v1/sessions/:id/cancel`。
- [x] 增加 `PATCH /v1/sessions/:id/tasks/:taskId`。
- [x] 增加 task claim/complete endpoint。

## P0 Context-Aware Runtime

来自已合并的 BabeL-X 迁移结论 Milestone 1。目标是先做低风险、Nexus-owned 的上下文预算和压缩，不迁移 BabeL-X 的重型后台 SessionMemory 子 Agent。

- [x] 新增 `ContextBudget`：按 model context window 分配 system / memory / summary / recent budgets，预留输出余量。
- [x] 新增 `src/runtime/compactors/snipCompactor.ts`：对超长 `tool_completed.output` 做 head/tail 字符级截断，原始 events 继续完整保存在 SQLite。
- [x] 新增 `src/runtime/contextAssembler.ts`：按 System Prompt、Project Memory、Session Summary、Recent Events、Current Turn 分层装配模型上下文。
- [x] 支持 `.babel-o/memory.md` 项目记忆加载，并注入 system prompt。
- [x] 初版只做字符预算和规则摘要；暂不实现 BabeL-X `SessionMemory` 的后台子 Agent 提取。
- [x] Benchmark：长会话上下文输入规模降低 50%+，且最近 3-5 轮完整保留。
- [x] 修复长会话历史截断的 user boundary 选择，避免旧 `hi` 和残缺历史抢占上下文起点，并在 system prompt 中加入 `Context Boundary` 提示，明确最近消息是权威工作历史。
- [x] 修复上下文回放污染：历史 `thinking_delta` 仅作为日志/UI 事件保留，不再以 `reasoningContent` 注入后续 provider 请求；上下文选择改为按最近用户轮次保留，避免长回答的数千条 delta 切碎语义边界。
- [x] 修复 provider 空响应状态：当 provider 返回无文本且无工具调用时，runtime 产出 `EMPTY_PROVIDER_RESPONSE` 失败结果，不再显示空白 `✓ done`。
- [x] 修复 provider error 后 session 终态误判：embedded `bbl chat` 收尾读取最新事件窗口，并以最新 terminal event 判断 `completed/failed`，避免长会话尾部 `PROVIDER_ERROR` 被早期成功 result 覆盖。
- [x] 修复空历史轮次造成的重复相邻用户消息：`mapEventsToMessages()` 会跳过连续相同的 user turn，避免旧空响应日志污染下一轮追问。
- [x] 修复显式路径请求被旧上下文带偏：system prompt 会列出当前请求中的绝对路径，并要求模型将其作为权威任务目标；支持中文无空格后缀路径解析，例如 `/Users/.../BabeL-X横向对比分析这个项目`。
- [x] 修复取消/超时后的长任务上下文恢复：遇到 `REQUEST_CANCELLED`、`REQUEST_TIMEOUT`、`MAX_LOOPS_EXCEEDED`、`PROVIDER_ERROR`、`EMPTY_PROVIDER_RESPONSE` 或失败 result 后，下一条用户输入会形成新的 recent context 边界，旧工具链进入 summary，不再让模型继续旧任务；同时区分用户取消 `REQUEST_CANCELLED` 与真正执行超时 `REQUEST_TIMEOUT`。
- [x] 修复 provider 工具参数校验失败不可恢复：`Write` / `Edit` 等工具缺少必填字段时，`LLMCodingRuntime` 现在返回 `tool_completed success=false` 与 provider `tool_result isError=true`，让模型能补齐参数后继续调用，而不是直接用全局 `INVALID_TOOL_INPUT` 终止 session。
- [x] 修复 workspace path escape 不可恢复：`Read` / `Write` / `Edit` / `Glob` 等路径工具触发 `WORKSPACE_PATH_ESCAPE` 时，运行时现在返回 `tool_completed success=false` 与 provider `tool_result isError=true`，让模型看到“路径不在当前 workspace / 可能大小写或目标项目错误”的结构化结果并继续修正，而不是升级为全局 `TOOL_ERROR` 终止工具循环。
- [x] **CWD 跟随用户输入中的显式绝对路径**：`LLMCodingRuntime.executeStream` 开头新增 `resolveCwdFromPrompt()`，提取 prompt 中的绝对路径，若存在且有效（目录/文件/父目录存在），将 `options.cwd` 切换到该路径；`session_started` 事件同步反映新 cwd。
- [x] **Glob 工具支持 `path` 参数**：`glob.ts` 的 `inputSchema` 增加 `path?: string`，`execute` 中用 `resolveInsideWorkspace` 解析后作为搜索根目录；修复 Agent 传入 `path` 被静默忽略、在错误目录搜索的问题。

## P1 Context Compact UX

参考 BabeL-X `src/services/compact/autoCompact.ts`、`src/components/TokenWarning.tsx` 和 `/compact` 命令体系，但保持 BabeL-O 的轻量 Nexus-first 设计。目标是把现有 context budget、snip compactor、session summary 和恢复边界变成用户可感知、可控制、可调试的长会话能力。

- [x] 新增 `/compact` chat 命令：将当前 session 的旧事件压缩为显式 compact boundary / summary event，并保留最近用户轮次和未完成工具链。
- [x] 定义 compact event schema：记录 `beforeEventCount`、`afterEventCount`、`summaryChars`、`snippedToolResults`、`trigger=manual|auto|reactive`、`modelId`、`budget`。
- [x] `contextAssembler` 支持读取 compact boundary：优先使用最新 compact summary，再叠加 compact 后的 recent events，避免旧 summary 与旧 omitted events 双重计入。
- [x] 增加 context warning 事件：当估算 token/char 用量接近模型窗口时，runtime 产生 `context_warning`，CLI 展示“剩余上下文/建议 compact”。
- [x] 增加 auto-compact threshold：按 model context window 预留输出空间和安全 buffer，超过阈值时自动 compact；默认先关闭或 opt-in，避免早期误压缩。
- [x] 增加 compact failure 熔断：连续 compact 失败达到阈值后停止自动重试，产出可见 warning，避免长会话每轮重复消耗 provider 调用。
- [x] 增加 manual compact smoke：构造包含大量 tool output、thinking_delta、provider error、cancel boundary 的 session，验证 compact 后仍能回答最新用户问题。
- [x] 增加 auto-compact benchmark：在 `scripts/benchmark-performance-core.ts` 中新增 `benchmarkAutoCompact`，验证长会话 compact 后规模下降 >50%（实测 96%+）、最近 2 个用户轮次完整保留、失败/取消后的 recovery boundary 不被 compact 破坏；benchmark 通过持久化后的事件重新 `assembleContext`，避免只验证内存假象。同时补充 `test/context-assembler.test.ts` 单元测试覆盖 auto-compact 规模和 recovery boundary 保留。
- [x] 修复 auto-compact boundary 持久化与恢复：`compactSession` 默认持久化 `compact_boundary`，boundary 内新增 `retainedEvents` 保存最近 tail；`contextAssembler` 读取最新 boundary 时会拼接 `retainedEvents + boundary 后续事件`，重复 compact 也会继承上一次 retained tail，避免会话恢复后最近用户轮次和 recovery boundary 丢失。
- [ ] 暂不迁移 BabeL-X SessionMemory 后台子 Agent；待 hooks、子 Agent transcript 和成本控制稳定后再评估。

### Context Compact 已知缺陷（来自 CONTEXT_GAP_ANALYSIS.md）

以下按严重程度排序，是当前首要开发主线。目标是优先补齐 BabeL-O 与 BabeL-X 的上下文治理差距，支撑长会话、连续任务、自优化和复杂项目开发；已完成项保留在列表中作为口径回溯：

- [x] **P0: auto-compact boundary 持久化与 retained tail 恢复**。已修复早期 benchmark `persist:false` 假阳性：auto/manual compact 默认持久化 boundary，并将最近 tail 写入 `compact_boundary.retainedEvents`；`contextAssembler` 与重复 compact 均会读取 retained tail，确保会话恢复/并发实例读取时最近用户轮次和 recovery boundary 不丢失。
- [x] **P0: Context Token Estimator**。新增 `src/runtime/tokenEstimator.ts`，替换 `LLMCodingRuntime` 中 `JSON.stringify(messages).length / 4` 的粗估。第一版不绑定 Anthropic API，采用 provider-neutral 保守估算：CJK 字符、JSON/tool schema、tool_use/tool_result、thinking/redacted thinking、image/document/server tool block 和 provider tool overhead 均纳入估算。
- [x] **P0: 中文长会话 benchmark**。`scripts/benchmark-performance-core.ts` 已新增 `Chinese context token estimator` 子项，构造中文用户输入、中文 assistant 输出、代码块、JSON tool result、reasoningContent 和 tool schema；当前实测旧 chars/4 估算 `10229` tokens 不触发 warning，新 estimator 估算 `18421` tokens，会进入 warning/blocking 阈值。
- [x] **P0: Context Blocking Limit**。`LLMCodingRuntime` 在 provider call 前计算 `blockingLimit`；超过 warning 阈值发 `context_warning`，超过 blocking limit 时先执行 `trigger=reactive` compact，compact 后仍超限则返回 `CONTEXT_LIMIT_EXCEEDED`、失败 `result` 和 `execution_metrics`，禁止继续调用 provider 等待 `prompt_too_long`。
- [x] **P0: System Prompt 分层硬截断**。`layerBudgets.system/memory/summary/skills` 已用于实际裁剪；`Project Memory`、`Session Summary`、`Active Developer Skills`、focus/path block 会按字符预算保留 head/tail 并插入 truncation marker，`AssembledContext.systemPromptTruncation` 与 `/context` 诊断暴露截断计数。
- [x] **P1: `/context` 诊断命令**。CLI chat 已新增 `/context`，可输出轻量诊断表格：model/window/token、system prompt、project memory、session summary、compact retainedEvents、recent messages、tool schema count、active skills、snipped tool outputs、post-compact state 和建议动作；service 模式调用 Nexus API，embedded 模式复用本地 SQLite 与同一 `analyzeContext()`。
- [x] **P1: Context Analysis API**。新增 `src/runtime/contextAnalysis.ts` 的 `analyzeContext()`，并暴露 `GET /v1/sessions/:sessionId/context`。结果为 JSON 序列化结构，包含 token estimate/window state/sections/compact/postCompactState/recommendations；已纳入 `test/context-assembler.test.ts` 与 `test/runtime.test.ts`。
- [x] **P1: Post-Compact State Rebuild**。`contextAssembler` 已派生轻量 `Post-Compact State` block 并在 compact boundary 存在时注入 system prompt，第一版覆盖最近成功 Read 文件、recent tools、active skills、task/agent status 和 hook results。MCP/tool instructions delta 与更强 preserved segment 校验仍在后续项继续。
- [x] **P1: MCP / Skill Delta 重宣布**。compact boundary 存在时，`Post-Compact State` 与 `Compact Capability Reminder` 会重新声明 recent tools、active skills、task/hook 状态和必要 tool contract，明确 `tool_use/tool_result` 必须按 `toolUseId` 配对，避免 compact 后模型忘记可用能力或误解截断结果。
- [x] **P1: `selectOmittedEvents` 稳定身份**。新增 `eventIdentity()`，优先使用 `eventId`、`toolUseId`，再退化到 `type/sessionId/timestamp/hash`，避免 deep clone/normalize 后 omitted 计算依赖对象引用相等。
- [x] **P1: API Invariant Guard / Microcompact**。`protectToolPairs()` 会在 recent selection 后补齐匹配的 `tool_started/tool_completed`，compact retainedEvents 也复用同一保护；新增 `microcompactEvents()` 优先压缩旧 tool output、thinking_delta 和 assistant_delta，并在输出中明确为 microcompact head/tail，不再用 "denied or interrupted" 掩盖上下文截断。
- [x] **P1: manual compact 重置 auto-compact 熔断计数**。`countConsecutiveAutoCompactFailures()` 遇到任意 `compact_boundary`（manual/reactive/auto）即停止向前累计，manual/reactive compact success 可作为用户主动恢复边界重置旧 auto failure。
- [x] **P2: Session Memory Lite（opt-in 第一版）**。参考 BabeL-X Post-Sampling Hook，但保持 Nexus-first。compact 成功后若设置 `BABEL_O_SESSION_MEMORY_LITE=1`，维护 `.babel-o/session-memory.md`，只允许写入固定路径；追加 `session_memory_updated` 事件用于审计，但不把 memory 文件注入主 read cache/context。后续再做自然停顿触发、后台 lightweight agent、sequential 队列和成本控制。
- [x] **P2: Preserved Segment / Resume Verification（第一版）**。`compact_boundary.retainedSegment` 已记录 retained count、boundary anchor、first/last event identity 和 hash；恢复时验证 retained tail，失败则回退完整历史并输出可见 warning，`/context` 展示 retained check/warn。
- [x] **P2: Model Fallback / Max Output Recovery 诊断层**。新增 provider recovery 分类，识别 `max_output_tokens`、`prompt_too_long/context_length_exceeded`、rate limit、auth/billing 和 5xx；error `details.recoveryReason` 记录 `ESCALATED_MAX_TOKENS` / `ESCALATED_CONTEXT_WINDOW` 等，TUI 展示恢复建议。自动 fallback model 切换仍保留为后续策略项。
- [x] **P2: Context Regression Corpus（第一版）**。新增真实漂移样本：workspace escape 后“继续”、cancel 后“你现在在干什么”、provider empty response、invalid tool input/schema failure，覆盖 context selection 与 message replay 不再带偏。
- [x] **P1/P2: 短问候/状态追问 pivot boundary**。基于 `session_7b928e48`：当最新用户输入是 `你好？`、`还在吗`、`你现在在干什么`、`还记得...` 等短交互时，`selectRecentEvents()` 只保留最新用户轮次，不继续回放旧任务工具链；真实会话回放验证第三轮 `你好？` provider messages 不再包含 Baidu/tool_use。
- [x] **P1/P2: Bash 绝对路径 workspace preflight**。Bash 命令执行前抽取绝对路径并调用 `resolveInsideWorkspace()`；越界时返回 recoverable `WORKSPACE_PATH_ESCAPE` tool result，避免模型通过 Bash 绕过 Read/Glob 的 workspace guard。
- [x] **P1/P2: Bash retained CWD 随 workspace 切换重置**。基于 `session_b4fd19a4`：同一 session 从 Baidu 切到 BabeL-X 后，Bash 的 `sessionCwdMap` 仍可能保留旧 Baidu CWD，导致 workspace guard 基准回退到旧项目。现已限制 retained shell cwd 只能在当前 `context.cwd` workspace 内复用，跨 workspace 自动清除；绝对路径 preflight 始终以本轮 `context.cwd` 为根。
- [x] **P1/P2: Session CWD 持久化与纠错轮继承**。基于 `session_e9fa6e3a`：含显式目录路径的本轮能切到 BabeL-X，但下一轮“让你分析的就是 babel-X 项目”因无绝对路径回退到启动 cwd。现已将 `session_started.cwd` 写回 session snapshot，HTTP/WS/embedded CLI 后续无显式路径输入继承 `session.cwd`；纠错短句触发 pivot，避免旧 BabeL-O/Baidu 工具链继续锚定。
- [x] **P0/P1: Provider fallback policy 第一版（非静默）**。`classifyProviderRecovery()` 对 max-output、context-window、rate-limit/unavailable、auth/billing、provider-protocol 和 unknown 错误返回 `fallbackPolicy`，包含 mode、reason、nextAction、`allowSilentModelSwitch=false`；runtime max-output exhausted 路径复用同一 policy；CLI error rendering 展示 fallback mode 和 silentSwitch=false。当前只做解释与用户确认前置，不自动切换模型。
- [x] **P0/P1: Provider diagnostics / auth mode 展示第一版**。`ConfigManager` 的 `resolveSettings()` 记录 model/apiKey/baseUrl 来源，新增 `getProviderDiagnostics()` 输出 redacted provider/model/auth/capability 状态；`/v1/runtime/status` 返回 provider diagnostics；CLI `/status` 在 service/embedded 模式展示 provider、adapter、authMode/authSource、baseUrlSource、modelSource、context window、max output、tool/json/structured/streaming capability，避免配置问题只能等 provider 请求失败后暴露。
- [x] **P0: Provider smoke dry-run 诊断入口第一版**。新增 `GET /v1/runtime/provider-smoke`，复用 redacted provider diagnostics 做只读 readiness 检查：auth 是否配置、model 是否解析、tool calling / streaming / structured output capability 是否满足请求；返回 `mode=dry_run`、`ready`、checks 与 `allowSilentModelSwitch=false` 的 fallbackPolicy。该入口不创建 session、不写 event、不执行用户 prompt、不自动切换 provider/model/profile。
- [x] **P0: Provider smoke live simple-text 第一版**。新增显式触发的 `POST /v1/runtime/provider-smoke/live`，只发送固定 smoke prompt `BABEL_O_PROVIDER_SMOKE_OK`，用于验证真实 provider/adapter streaming 链路；不执行用户任务、不创建 session、不写 session event、不自动切换 provider/model/profile、不泄露 API key。provider 错误通过 recovery/fallbackPolicy 返回，mocked API 回归断言请求体不包含用户任务内容。
- [x] **P0: Provider smoke CLI/TUI 展示第一版**。`/v1/runtime/status` 现在直接返回 `providerSmoke` dry-run readiness；CLI `/status` 在 embedded/service 模式展示 provider smoke readiness、requirements、checks 与 `allowSilentModelSwitch=false` fallbackPolicy。新增 `/smoke` dry-run 与显式 `/smoke live` 入口：默认只读检查，只有用户明确输入 live 时才触发固定 live smoke。
- [x] **P0: Provider smoke live tool-call 第一版**。`POST /v1/runtime/provider-smoke/live` 支持显式 `mode=tool_call`，使用固定 synthetic tool `provider_smoke_probe` 与固定 `BABEL_O_PROVIDER_SMOKE_OK` probe 参数验证真实 provider/adapter 工具调用协议；只收集 tool_use deltas，不执行工具、不创建 session、不写 event、不自动切换 provider/model/profile、不泄露 API key。CLI 支持 `/smoke live tool-call` 与 `/smoke tool-call`，展示 matchedExpectedTool、toolCallCount 与工具名。
- [x] **P0: Provider 协议 regression corpus 扩展**。在既有 Anthropic 标准 `tool_use`、OpenAI `tool_calls`、MiniMax text-encoded tool_call 覆盖基础上，新增 MiniMax 前后文本夹带工具调用、MiniMax 未闭合 `<minimax:tool_call>`、Anthropic malformed `input_json_delta`、OpenAI malformed function arguments、OpenAI 并发 multi-tool arguments 的 adapter/runtime 回归；确认 raw provider 协议不会作为 `assistant_delta` 渲染，malformed tool input 会作为 recoverable `PARSE_ERROR` tool result 回传模型。
- [x] **P0: MiniMax text-encoded tool_call 协议兼容**。MiniMax 的 Anthropic-compatible 流有时会把工具调用编码成 `<minimax:tool_call><invoke ...>` 文本块，而非标准 Anthropic `content_block.type=tool_use`；`AnthropicAdapter` 现对 `providerId=minimax` 识别该文本协议并归一为标准 `tool_use_start/tool_use_delta/tool_use_end`，避免 raw provider XML 作为 `assistant_delta` 被 TUI 直接展示。adapter 与 runtime 回归覆盖该形态。
- [ ] **P2/P3: Model Fallback 执行入口**。与 provider registry role routing 联动，在用户显式确认后执行降低 max output、切换大上下文模型或切换 provider/profile；避免 silent model switch。
- [x] **P0: Pivot Guard 重建第二版——User Intake Guidance 事件管线**。已从同步 regex 主分类升级为轻量 intake 机制：`LLMCodingRuntime` 在主 provider 请求前先调用模型生成可持久化 `user_intake_guidance` 事件（intent、continuity、contextScope、actionHint、requiresTools、guidance、explicitPaths、source），`contextAssembler` 优先读取该事件并作为 `User Intake Guidance` 高优先级 system block 注入；pause/greeting/status 会被 runtime 硬归一化为 `respond_only` + `requiresTools=false`，即使 intake 模型输出自相矛盾也不会向主 provider 暴露工具。regex 规则保留为 intake 调用失败或诊断离线场景的 fallback，不再作为主路径直接判定。session_321c48be 的 `hi``、cancel 后 `just stop it and waite for me other require` 已用真实时间线 sanitized replay 覆盖；短纠错、多路径比较、cancel/timeout 后状态追问也有回归覆盖，确认不再硬丢旧上下文且不会继续旧工具链。
- [x] **P0: 工具循环 final-response-only 硬约束**。`LLMCodingRuntime` 在接近 `maxLoops` 尾部阶段时不再只靠 Execution State 提醒模型，而是直接隐藏主 provider 请求的 tools；若 provider 仍输出工具调用，runtime 返回 `TOOL_LOOP_FINAL_RESPONSE_ONLY` 可审计错误、拒绝执行新工具，并追加无工具最终回答提示继续合成。`runtime-llm.test.ts` 覆盖模型持续请求 Read 的失控循环，确认最终阶段没有执行新工具且最后成功产出 answer；同时覆盖 `MAX_LOOPS_EXCEEDED` 终态会输出失败 result。
- [x] **P0: 终态错误 recovery boundary 与失败 result**。`selectRecentEvents()` 已将 `PROVIDER_ERROR`、`EMPTY_PROVIDER_RESPONSE`、`CONTEXT_LIMIT_EXCEEDED`、`MAX_LOOPS_EXCEEDED`、`MAX_OUTPUT_TOKENS_EXCEEDED`、`TOOL_LOOP_FINAL_RESPONSE_ONLY` 纳入 recovery boundary，下一轮状态追问不会回放旧工具链；`LLMCodingRuntime` 的 provider error catch、max-loops 与 max-output exhausted 终态都会输出失败 `result`，避免 UI/调用方只能看到 error/metrics 而无法按失败终态恢复。
- [x] **P0: `/context` runtime policy 诊断可观测性**。`analyzeContext()` 现在返回 `runtimePolicy`，明确当前 intent 下 tools 是否可见、tool suppression 原因、最近 recovery boundary code/timestamp/message；CLI `/context` 增加 `User Intent / Runtime Policy` 区块，直接展示 intent/source/action/scope/requiresTools、显式路径、tools visible 和 recovery boundary。测试覆盖 API JSON 与 pause + cancel boundary 诊断。
- [x] **P0: session_3ba2d788 指令跟随回归修复**。真实会话 `session_3ba2d788-6f78-468b-b01d-0a6a10ade46f` 暴露的长会话 latest user/intake 错位与 respond_only 工具穿透已修复：`LLMCodingRuntime` 读取最新 tail 并恢复时间顺序；User Intake Guidance 以本轮 `latestPrompt` 作为最高优先级校验来源；intake 模型输出的 `explicitPaths` 不再被信任，只使用 deterministic extractor；当 `shouldSuppressToolsForIntent()` 为 true 时，runtime 执行层会返回 `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` 并拒绝任何 provider tool call（包括 MiniMax 文本编码工具调用），不得进入 `tool_started`。已补 `runtime-llm.test.ts` 长会话 tail/intake 与 MiniMax respond_only 硬拦截回归，以及 `context-regression.test.ts` 的 session_3ba2d788 sanitized replay。
- [ ] **P2: DeepSeek reasoning replay 兼容（暂缓）**。`OpenAIAdapter` 后续仍需要对 DeepSeek thinking 模式的 `reasoning_content` 做正确续传/降级处理，避免 provider 在后续 turn 报 `The reasoning_content in the thinking mode must be passed back to the API.`；当前按用户要求暂不处理该模型适配项。
- [ ] **P3: `thinking_delta` 策略再评估**。当前完全丢弃 thinking 可防污染，但对部分 provider/model 可能损失规划连续性。评估只保留短摘要、只给同 provider、或只在 Agent role 内部保留的策略。

### P0 Pivot Guard 缺陷专项

> 来源: session_321c48be 实战复盘 + 源码审查
> 核心文件: `src/runtime/contextAssembler.ts:427-515`

#### 1. Pivot 的定义与作用

Pivot 是 `selectRecentEvents()` 中的上下文截断起点策略。当检测到用户意图切换时，从这条新消息开始截取事件窗口，丢弃之前的所有事件。它是"保留最近 N 个 turn"默认策略的覆盖路径。

```
正常路径: 保留最近 N 个 user turn 对应的所有事件
Pivot 路径: 只保留触发 pivot 的这条用户消息及其之后的事件
```

Pivot 被两处调用：
- `contextAssembler.ts:166` — 每次 `assembleContext()` 时决定保留哪些事件
- `compact.ts:61` — `compactSession()` 决定哪些事件被压缩

#### 2. 当前触发条件（4 条路径）

| 路径 | 函数 | 匹配模式 | 设计意图 |
|------|------|---------|---------|
| 闲聊 | `isConversationalPivotPrompt` | `hi/hello/你好/您好/还在吗/你在干什么/还记得...` | 用户打招呼/状态追问时不回放旧工具链 |
| 暂停 | `isPausePivotPrompt` | `stop/pause/wait/等一下/先停/暂停` | 用户想暂停执行时不继续旧任务 |
| 纠错 | `isCorrectionPivotPrompt` | `让你/我说的/不是...而是/actually/i mean` | 用户纠正目标时切换到新上下文 |
| 路径 | `extractAbsolutePaths` | 消息中出现 `/Users/...` 等绝对路径 | 用户切换项目时以新路径为锚点 |

#### 3. 核心缺陷：全有全无、不可逆、无 fallback

```typescript
// contextAssembler.ts:454-460
if (shouldStartFromLatestUserPrompt(latestUser.text)) {
  return trimSelectedWindow(effectiveEvents.slice(latestUserIdx), maxEvents)
}
```

触发 pivot 后，`effectiveEvents.slice(latestUserIdx)` 只保留触发消息及其之后的事件。之前的事件：
- **不进入** `sessionSummary`（只有 `selectOmittedEvents` 返回的事件才生成摘要）
- **不进入** `retainedEvents`（compact 时保留的是 pivot 后的事件）
- **不进入** `PostCompactState`（只从 selected events 派生）
- **完全从 LLM 视野中消失**

等价于一次无摘要的硬截断，没有任何恢复手段。

#### 4. 各触发路径的风险评估

**4.1 闲聊路径 — 高风险**

session_321c48be 已复现：用户在 Baidu 分析中间输入 `hi`` 触发 pivot，丢弃了 Turn 6-7 的 30+ 条工具调用事件，导致模型重新跑 `ls`。

问题分析：
- 正则 `/^(hi|hello|hey|你好|您好)[？?!.。！\s]*$/iu` 只匹配**纯问候**，看起来合理
- 但实际会话中用户说 "hi" 后紧接着会有新需求，不是真正的上下文切换
- 即使用户只是打招呼，不代表要丢弃之前的工作上下文——模型应该记住之前做了什么
- 测试用例 `test/context-assembler.test.ts:1221` 的断言 `assert.deepEqual(context.messages, [{ role: 'user', content: '你好？' }])` 反而**验证了上下文丢失是期望行为**，这表明设计意图本身就是"问候=丢上下文"

**4.2 暂停路径 — 中风险**

session_321c48be 已复现：用户说 "just stop it and waite for me other require" 触发 pivot，但模型仍然做了 25 次工具调用。

问题分析：
- 暂停 pivot 的设计意图正确：用户说"停"时不回放旧工具链
- 但 pivot 只影响上下文选择，**不影响 runtime 的工具循环行为**——模型仍然可以自由发起工具调用
- 这意味着暂停 pivot 只解决了"不要被旧上下文带偏"，没解决"用户说停但模型不停"的指令跟随性问题
- 正则 `/(?:\b(?:wait|waite|hold on|hang on)\b)/u` 包含了 `waite`（拼写错误），但 `waite` 本身不是英语单词，过度匹配

**4.3 纠错路径 — 低风险（设计合理但需微调）**

纠错 pivot 的语义明确：用户说"我说的不是 A 是 B"，应该切换到新目标。这是 4 条路径中唯一有明确意图切换语义的。

问题分析：
- 正则 `/(?:让你|要你|我说的|说的是|分析的就是|看的就是|不是.*是|不是.*而是|actually|i mean)/iu` 中 `不是.*是` 过于宽泛——"这个 bug 不是很难修复"也会匹配
- 但由于纠错场景确实需要 pivot，且误匹配概率相对低，风险可控

**4.4 路径路径 — 高风险**

`extractAbsolutePaths(text).length > 0` 导致任何包含绝对路径的消息都触发 pivot。

session_321c48be 已复现：Turn 4 用户输入 `...rewrite this article.../Users/tangyaoyue/Library/.../工作流抽卡...md`，路径触发 pivot，丢弃了 Turn 1-3 的闲聊上下文。这次影响不大，因为 Turn 1-3 是无工具调用的闲聊。

但更危险的场景：用户在一个长编码会话中说"也帮我看看 `/Users/.../other-project` 里的那个文件"，路径触发 pivot，导致当前项目的全部工具调用结果丢失。

问题分析：
- 路径触发 pivot 的原始意图是解决 `session_e9fa6e3a` 的问题：用户从 Baidu 切到 BabeL-X 后旧上下文带偏
- 但这应该通过"项目切换检测"而非"任何路径"来触发——用户在同一项目中引用路径不应触发 pivot
- `systemPromptBuilder.ts` 的 `buildRequestPathBlock` 已经通过 system prompt 告诉模型"以显式路径为权威目标"，不需要 pivot 来额外截断上下文

#### 5. Pivot 与其他上下文机制的交互缺陷

**5.1 Pivot 旁路了 Recovery Boundary**

```typescript
// contextAssembler.ts:431-442
let recoveryIdx = 0
for (let idx = events.length - 1; idx >= 0; idx--) {
  if (event.type === 'error') {
    if (code === 'REQUEST_CANCELLED' || code === 'EXECUTION_TIMEOUT') {
      recoveryIdx = idx; break
    }
  }
}
const effectiveEvents = recoveryIdx > 0 ? events.slice(recoveryIdx) : events
```

Recovery boundary 从最近的 `REQUEST_CANCELLED`/`EXECUTION_TIMEOUT` 开始截取，确保取消后的下一条输入不被旧任务工具链锚定。

但 pivot 检测发生在 recovery 之后（line 454-460），且 pivot 的截断范围（`effectiveEvents.slice(latestUserIdx)`）可能比 recovery boundary 更激进。如果 recovery boundary 正确设置了起点，pivot 会再次从 recovery boundary 内部截断，可能丢失 recovery boundary 保留的关键上下文。

**5.2 Pivot 旁路了 `recentTurnLimit` 预算**

正常路径下，`selectRecentEvents` 按 `recentTurnLimit`（大窗口 4 turn，小窗口 2 turn）保留最近 N 个 turn。pivot 路径完全跳过这个限制，只保留 pivot 消息之后的事件——可能只有 1 个 turn，也可能很多（如果 pivot 后有大量工具调用）。

**5.3 Pivot 不产出 `omittedEvents` → 不生成摘要**

```typescript
// contextAssembler.ts:168
const omittedEvents = selectOmittedEvents(compactAwareEvents, selectedEvents)
```

`selectOmittedEvents` 基于 `selectedEvents` 计算。如果 pivot 导致 `selectedEvents` 只有 pivot 后的事件，那么 `omittedEvents` 包含 pivot 前的全部事件。这些事件会进入 `summarizeSessionEvents` 生成统计摘要，但**不会进入 LLM 摘要**（`llmSummarizeEvents` 只在 `compactSession` 中调用，不是每次 `assembleContext` 都调用）。

结果：pivot 前的上下文被压缩为一条统计摘要（"Earlier omitted events: N; user messages M"），而不是保留关键的技术细节、文件内容和决策。

#### 6. 修复方案

**Phase 1：止血（消除误触）**

1. 闲聊路径加长度阈值：消息 < 15 chars 且无路径时才触发。超过 15 chars 的问候（如 "hi, can you also check this other thing?"）不触发 pivot
2. 路径路径改为项目切换检测：只有当用户消息中的路径**不在当前 cwd 的 workspace 内**时才触发 pivot。同一项目内引用路径不触发
3. 暂停路径保持，但增加 runtime 侧的配合：pivot 触发 `isPausePivotPrompt` 时，在 system prompt 中注入 "User requested pause. Respond with confirmation only. Do not initiate any tool calls." 的强指令

**Phase 2：结构化（pivot 不再全有全无）**

4. Pivot 后的 omitted events 强制进入 `sessionSummary`：pivot 截断前的事件仍然生成摘要（即使没有 compact boundary），确保关键上下文（文件路径、决策、待办）保留在 system prompt 中
5. Pivot 增加 `pivot_reason` 字段到 `AssembledContext`，在 `/context` 诊断中展示，帮助用户理解为什么上下文被截断
6. Pivot 增加回退机制：如果 pivot 后 LLM 请求了与 pivot 前相同的工具（如同一个 `ls` 命令），说明 pivot 可能是误触，在下一轮自动回退到正常路径

**Phase 3：智能分类（替代规则型 pivot）**

7. 用小型意图分类器替代正则匹配：输入（当前消息 + 最近 3 条 user_message 摘要）→ 输出（pivot / continue / correction / pause），可测试、可扩展
8. 分类器覆盖中文短句：换项目/换话题/停一下/只回答我/不要继续旧任务
9. 分类器结果写入 `/context` 和 `context_warning` 事件

#### 7. 验证命令

- [ ] 回放 session_321c48be：Turn 8 `hi`` 不应丢弃 Turn 6-7 的 Baidu 上下文
- [ ] 回放 session_e9fa6e3a：纠错 pivot "让你分析的就是 babel-X 项目" 仍应正确切换
- [ ] 新增：消息中包含同项目路径时不触发 pivot
- [ ] 新增：暂停 pivot 触发后模型不发起工具调用
- [ ] 新增：pivot 后的 omitted events 必须出现在 sessionSummary 中

## P1 Nexus Hooks 最小内核

参考 BabeL-X `src/utils/hooks.ts` 的生命周期事件设计，但不迁移其巨型实现、插件市场、遥测、React UI 和复杂 shell hook 管线。BabeL-O 版本必须是 Nexus-owned：runtime/agent/tool 生命周期产出 typed hook input，Hook executor 返回 typed result，再转成 Nexus events。

### 目标事件

- [ ] `UserPromptSubmit`: 用户输入进入 runtime 前触发，可追加 context、阻断明显错误目标、记录 prompt metadata。
- [ ] `PreToolUse`: 工具执行前触发，可返回 `updatedInput`、`additionalContext`、`denyReason` 或 `permissionBehavior`。
- [ ] `PostToolUse`: 工具成功后触发，可追加 tool summary、压缩 tool output、更新 memory。
- [ ] `PostToolUseFailure`: 工具失败后触发，可生成 retry hint、修复建议或更清晰的失败摘要；优先服务 `INVALID_TOOL_INPUT`、Bash 非零退出、MCP schema mismatch。
- [ ] `PermissionRequest`: 权限弹出前触发，可应用本地策略、allow rule、deny rule，或追加用户可读解释。
- [ ] `SubagentStart`: 子 Agent 启动前触发，可注入 scope、parent task、worktree notice、MCP/skill 上下文。
- [ ] `SubagentStop`: 子 Agent 结束时触发，可生成结果摘要、释放资源、记录 transcript path。
- [ ] `SessionEnd`: session close/cancel/failed/completed 时触发，必须有短 timeout，用于清理外部资源和写入最终审计。

### 实现要求

- [ ] 新增 `src/nexus/hooks/` 或 `src/runtime/hooks/`，包含 hook types、registry、executor、timeout helper 和 result normalizer。
- [ ] Hook registry 支持 built-in hooks 与用户配置 hooks 分层；第一版只实现 built-in function hooks，不执行任意 shell command。
- [ ] Hook executor 必须支持 AbortSignal、per-hook timeout、all-settled 聚合和错误隔离；Hook 失败不能让主 runtime 崩溃。
- [ ] Hook result 必须可审计：产出 `hook_started`、`hook_completed`、`hook_failed` 或合并进现有 event details。
- [ ] `PreToolUse.updatedInput` 需要重新过工具 schema 校验，失败时返回可恢复 tool result，而不是直接替换执行。
- [ ] `PermissionRequest` hook 不能绕过 deny-by-default；只能在已配置 allowlist / classifier 可解释范围内自动批准。
- [ ] `SessionEnd` 默认 timeout 建议 1.5s-3s，超时后记录 warning 并继续关闭流程。
- [ ] Hook 配置必须与 runtime core 解耦；CLI 只展示 hook event，不持有 hook 执行逻辑。
- [ ] 增加测试覆盖：tool input 修复、tool failure retry hint、permission auto decision、session close cleanup、hook timeout/error isolation。
- [x] 第一版内置 hooks 已接入 runtime 主链路：`PreToolUse`、`PostToolUseFailure`、`PermissionRequest`、`SessionEnd`，并可产出 `hook_started` / `hook_completed` / `hook_failed` 事件。
- [x] `INVALID_TOOL_INPUT` / Bash 非零退出已可通过 hook 追加 retry hint 或 failure summary，再回传给模型继续修复。
- [x] hook 单测已覆盖 invalid tool input 修复提示、permission hook、session cleanup hook。

### 第一批内置 Hook 候选

- [ ] `RecoverInvalidToolInputHook`: 对缺少 `Write.path`、`Edit.oldString/newString` 等常见 schema 失败生成清晰 retry hint。
- [ ] `BashFailureSummaryHook`: 对 Bash exitCode 非零输出提取 stderr/stdout 摘要，帮助模型继续自我修复。
- [x] `ExplicitPathAnchorHook`（以 `resolveCwdFromPrompt` + `Current focus project` system prompt 块实现）：当用户输入包含绝对路径时，将目标路径切换为 cwd 并注入 system prompt；当输入退化无显式路径但 cwd 不是用户主目录时，注入 `Current focus project` 块防止上下文丢失。
- [ ] `SubagentWorktreeNoticeHook`: 子 Agent 在 worktree 内启动时注入 parent cwd、worktree cwd、路径转换和变更隔离说明。
- [ ] `SessionCleanupAuditHook`: session 结束时记录 bash cwd/task queue/task session/pending permission 清理统计。

## P0 MCP-Ready Runtime Extensions

来自已合并的 BabeL-X 迁移结论 Milestone 2。目标是利用 Nexus-first 架构把 MCP server 作为 Nexus 管理的外部工具源，而不是绑定 CLI 生命周期。

- [x] 新增 `src/mcp/McpClient.ts`：实现 JSON-RPC 2.0 over stdio，覆盖 initialize、tools/list、tools/call、shutdown。
- [x] 新增 `src/mcp/McpRegistry.ts`：加载 `~/.babel-o/mcp.json` 和项目级 MCP 配置。
- [x] 新增 `src/mcp/McpToolAdapter.ts`：将 MCP tool 适配为 BabeL-O `ToolDefinition`。
- [x] MCP 初版只支持 stdio transport；http/sse/ws/OAuth/XAA 延后。
- [x] MCP server 配置默认 `allowedTools: []`，未显式白名单的 MCP 工具全部拒绝。
- [x] MCP tool 风险在适配阶段确定：read / write / execute / task，并复用现有 `permission_request` 流。
- [x] `GET /v1/tools/audit` 和 `bbl tools audit` 显示 MCP tool 来源、server name、risk 和 allowlist 状态。
- [x] 增加至少 3 个官方 MCP server e2e smoke。

## P1 Knowledge-First Skills

来自已合并的 BabeL-X 迁移结论 Milestone 3。目标是先实现纯文本 inline Skills，为模型提供稳定工作方法，不迁移 BabeL-X 的 React `SkillTool` 和 fork 模式。

- [x] 新增 `src/skills/loader.ts`：解析 front matter，加载 skill id/name/triggers/priority/content。
- [x] 支持三级目录：`src/skills/built-in`、`~/.babel-o/skills`、`<cwd>/.babel-o/skills`。
- [x] 新增 `matchSkills(skills, prompt)`：按触发词匹配，最多注入 3 个，按 priority 排序。
- [x] 将匹配到的 inline skill 注入 system prompt 或 context assembler。
- [x] 内置 5 个 skill：coding、optimization、debugging、testing、git。
- [x] 初版不支持 `mode: fork`；fork 等 AgentLoop/sub-agent 能力稳定后再接。

## P2 Smart Permissions

来自已合并的 BabeL-X 迁移结论 Milestone 4。目标是从全手动审批升级为轻量规则自动分类，不迁移 BabeL-X 的复杂九阶段权限管道。

- [x] 新增 `src/runtime/classifier.ts`。
- [x] Read/Grep/Glob 等 read-only 操作自动放行。
- [x] Bash 支持安全白名单：`ls`、`cat`、`pwd`、`git status`、`git log`、`git diff`、`npm list`、`npx tsc --noEmit` 等。
- [x] Bash 支持危险黑名单：`rm -rf`、`sudo`、管道 curl/wget、`npm publish`、`git push` 等。
- [x] 写操作默认仍要求人工确认。
- [x] 所有自动放行/拒绝记录 permission audit reason。
- [x] 收紧 Bash 自动审批白名单：把 `npm test`、宽松 `npx tsc .*`、任意参数 `cat` 等规则拆成精确命令/参数集合，补充绕过样例测试；未知 Bash 继续默认人工确认。
- [x] 为 Bash 分类引入轻量 shell 词法扫描，拦截管道/重定向/链式操作、命令替换、变量展开和未闭合引号，避免仅靠正则判断。
- [x] 收紧 Bash `cat` 自动审批边界：`classifyAction()` 接收 cwd 上下文，只有 workspace 内的明确文件路径可自动批准；`$VAR` / `${VAR}` / command substitution / glob / `/dev/*` / workspace escape 均进入人工 review。`permission-flow.test.ts` 覆盖 `/tmp/secret.txt` 不再自动批准。
- [x] Worktree / Git 并发安全：`createWorktree()`、`commitAndMergeWorktree()`、`removeWorktree()`、`pruneOrphanedWorktrees()` 以及 optimizer in-place `stash` / `commit` / `rollback` / `stash pop` 共用 per-cwd Git operation lock；`worktree.test.ts` 覆盖同仓串行、跨仓并发与真实 concurrent merge-back。
- [x] Optimizer safety 从硬编码黑名单升级为策略配置：保护 package/lock/env/bin 等敏感路径，并对高危命令保持 deny 或人工确认。
- [x] MCP tool 运行时输入校验使用远端 `inputSchema`，不再仅以 `z.record(z.string(), z.unknown())` 接收任意对象；校验失败返回可恢复 tool result。
- [ ] 参考 BabeL-X Bash permission options，支持可编辑 Bash prefix allow rule，例如 `npm run:*`、`git diff:*`，并将规则写入 session/project/user scope。
- [ ] 权限审批结果增加 scope：`once`、`session`、`project`、`user`，默认只提供 `once/session`，project/user 需要明确配置开启。
- [ ] 权限 request details 增加 decision candidates：classifier reason、suggested allow rule、risk explanation、tool schema summary，供 CLI approval panel 展示。
- [ ] 拒绝权限时支持用户反馈文本，并将反馈作为可恢复 tool result 传给 provider，避免模型继续重复同一危险调用。
- [ ] PermissionRequest hook 接入后，自动审批必须记录 `hookName`、`ruleId`、`scope` 和 `reason` 到 permission audit。

## P2 Architecture Boundary

- [ ] 明确 embedded local 与 Nexus-only 两种运行模式的架构口径：若保留 embedded，文档中承认其为本地单进程路径；若推进 Nexus-only，则 CLI 必须经 HTTP/WS 调用 Nexus。
- [ ] 减少 CLI 对 `SqliteStorage` / `closeNexusSession` 的直接 import：优先复用 Nexus API 或嵌入式 `createNexusApp()`，避免 Storage 操作散落在 CLI 层。
- [ ] 将 permission pending state 从进程内单例逐步抽象为可插拔 backend，为多进程 service/CLI 场景预留 SQLite 或 Nexus-owned 状态同步。

## P1 Storage

- [x] 定义正式 `NexusStorage` schema 版本。
- [x] 实现 SQLite storage。
- [x] 保存 sessions。
- [x] 保存 events。
- [x] 保存 tasks。
- [x] 保存 tool traces。
- [x] 支持服务启动 hydrate。
- [x] 支持 storage restart smoke test。
- [x] 给 sessions/tasks/events 列表加 `limit`。
- [x] 预留/实现 cursor pagination (复合游标复合分页)。
- [x] `storageBridge` 改为带 3 次重试、延迟调度、永久失败计数和 stats 暴露的持久化队列，避免 fire-and-forget 静默失败。
- [x] `storageBridge` 增加 JSONL WAL，持久化待落库操作和 ack，支持进程崩溃后 replay 未 flush 的 task/session mutation，并在队列清空时 compact WAL。
- [x] `storageBridge` WAL 支持可配置批量写入、flush interval 和 fsync 策略；默认 `batchSize=1` 保持即时落盘口径。
- [x] `TaskQueue` / `TaskSession` 模块级 Map 对终态数据增加 24 小时默认 prune 策略和后台 sweeper。
- [x] 补充 session close 生命周期入口，`POST /v1/sessions/:sessionId/close` 与 cancel 路径均触发 Bash CWD、task queue、task session 和 pending permission 级联清理。

## P1 Security

### 当前状态

- [x] 高风险工具交互式确认第一版已完成：Write/Edit/Bash 会生成 `permission_request`，可通过 HTTP `/approve`、`/deny` 或 WebSocket `permission_response` 恢复执行。
- [x] CLI embedded 与 service/WS 路径均已接入 approve/deny 交互。
- [x] Service-safe permissions 已完成收尾：实现默认绑定 127.0.0.1，且在绑定非 localhost 时强制要求 NEXUS_API_KEY。实现 HTTP/WS 鉴权防御。

- [x] 实现 workspace allowlist.
- [x] 实现 realpath 防 symlink escape.
- [x] 工具默认 deny-by-default.
- [x] 实现 `NEXUS_ALLOWED_TOOLS`.
- [x] 实现 Bash 风险分类.
- [x] 实现工具 allowlist policy.
- [x] 实现 denied tool event.
- [x] 将 Write/Edit/Bash 转为 permission event.
- [x] CLI 支持 approve/deny permission event.
- [x] 记录当前工具 allow/deny audit view.
- [x] 记录持久化 permission audit.
- [x] `PendingPermissionRegistry` 增加 30 分钟默认 TTL、后台 sweeper、`sweepExpired()`、`pendingCount()`，超时请求自动 deny 并释放 Promise。
- [x] 默认绑定 `127.0.0.1`.
- [x] 生产/远程部署默认要求 `NEXUS_API_KEY`.

## P2 Execution Environments

- [x] 定义 `executionEnvironment` 请求字段。
- [x] P2 只支持 `local`。
- [x] 对 `docker` / `remote` 返回明确 not implemented。
- [x] 设计并实现 Docker workspace mount 和资源限制（`BABEL_O_DOCKER_IMAGE` / `BABEL_O_DOCKER_NETWORK` / `BABEL_O_DOCKER_MEMORY` / `BABEL_O_DOCKER_CPUS`，默认 `--network none`）。
- [x] 实现 Docker 容器 Session 生命周期管理（首次按需创建、`docker exec` 复用、Session 关闭时 `docker rm -f`）。
- [ ] 设计 remote runner protocol。

## 验证命令

- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run cli -- run "hello"`
- [x] `npm run cli -- run "read README.md"`
- [x] `npm run start` + `curl /health`
- [x] `npm run cli -- run --url http://127.0.0.1:3000 "bash pwd"`
- [x] storage restart test 已纳入 `npm test`
- [x] storageBridge WAL replay / batch flush / 1000 pending ops 恢复测试已纳入 `npm test`
- [x] allowlisted tool denial test 已纳入 `npm test`
- [x] `test/security.test.ts` 安全鉴权测试已纳入 `npm test`
- [x] `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/permission-flow.test.ts test/agent-loop.test.ts test/runtime.test.ts test/security.test.ts`
- [ ] `npm run test:stream`

## 参考文件

- `src/nexus/app.ts`
- `src/nexus/server.ts`
- `src/nexus/createRuntime.ts`
- `src/runtime/Runtime.ts`
- `src/runtime/LocalCodingRuntime.ts`
- `src/runtime/LLMCodingRuntime.ts`
- `src/storage/Storage.ts`
- `src/storage/MemoryStorage.ts`
- `src/storage/SqliteStorage.ts`
