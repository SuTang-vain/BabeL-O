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

来自 `docs/RECOMMENDATIONS.md` 的 Milestone 1。目标是先做低风险、Nexus-owned 的上下文预算和压缩，不迁移 BabeL-X 的重型后台 SessionMemory 子 Agent。

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

## P1 Context Compact UX

参考 BabeL-X `src/services/compact/autoCompact.ts`、`src/components/TokenWarning.tsx` 和 `/compact` 命令体系，但保持 BabeL-O 的轻量 Nexus-first 设计。目标是把现有 context budget、snip compactor、session summary 和恢复边界变成用户可感知、可控制、可调试的长会话能力。

- [ ] 新增 `/compact` chat 命令：将当前 session 的旧事件压缩为显式 compact boundary / summary event，并保留最近用户轮次和未完成工具链。
- [ ] 定义 compact event schema：记录 `beforeEventCount`、`afterEventCount`、`summaryChars`、`snippedToolResults`、`trigger=manual|auto|reactive`、`modelId`、`budget`。
- [ ] `contextAssembler` 支持读取 compact boundary：优先使用最新 compact summary，再叠加 compact 后的 recent events，避免旧 summary 与旧 omitted events 双重计入。
- [ ] 增加 context warning 事件：当估算 token/char 用量接近模型窗口时，runtime 产生 `context_warning`，CLI 展示“剩余上下文/建议 compact”。
- [ ] 增加 auto-compact threshold：按 model context window 预留输出空间和安全 buffer，超过阈值时自动 compact；默认先关闭或 opt-in，避免早期误压缩。
- [ ] 增加 compact failure 熔断：连续 compact 失败达到阈值后停止自动重试，产出可见 warning，避免长会话每轮重复消耗 provider 调用。
- [ ] 增加 manual compact smoke：构造包含大量 tool output、thinking_delta、provider error、cancel boundary 的 session，验证 compact 后仍能回答最新用户问题。
- [ ] 增加 auto-compact benchmark：验证长会话输入规模下降、最近 2-4 个用户轮次完整保留、失败/取消后的 recovery boundary 不被 compact 破坏。
- [ ] 暂不迁移 BabeL-X SessionMemory 后台子 Agent；待 hooks、子 Agent transcript 和成本控制稳定后再评估。

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
- [ ] `ExplicitPathAnchorHook`: 当用户输入包含绝对路径时，将目标路径作为 additional context 强化给 runtime，防止被旧上下文带偏。
- [ ] `SubagentWorktreeNoticeHook`: 子 Agent 在 worktree 内启动时注入 parent cwd、worktree cwd、路径转换和变更隔离说明。
- [ ] `SessionCleanupAuditHook`: session 结束时记录 bash cwd/task queue/task session/pending permission 清理统计。

## P0 MCP-Ready Runtime Extensions

来自 `docs/RECOMMENDATIONS.md` 的 Milestone 2。目标是利用 Nexus-first 架构把 MCP server 作为 Nexus 管理的外部工具源，而不是绑定 CLI 生命周期。

- [x] 新增 `src/mcp/McpClient.ts`：实现 JSON-RPC 2.0 over stdio，覆盖 initialize、tools/list、tools/call、shutdown。
- [x] 新增 `src/mcp/McpRegistry.ts`：加载 `~/.babel-o/mcp.json` 和项目级 MCP 配置。
- [x] 新增 `src/mcp/McpToolAdapter.ts`：将 MCP tool 适配为 BabeL-O `ToolDefinition`。
- [x] MCP 初版只支持 stdio transport；http/sse/ws/OAuth/XAA 延后。
- [x] MCP server 配置默认 `allowedTools: []`，未显式白名单的 MCP 工具全部拒绝。
- [x] MCP tool 风险在适配阶段确定：read / write / execute / task，并复用现有 `permission_request` 流。
- [x] `GET /v1/tools/audit` 和 `bbl tools audit` 显示 MCP tool 来源、server name、risk 和 allowlist 状态。
- [x] 增加至少 3 个官方 MCP server e2e smoke。

## P1 Knowledge-First Skills

来自 `docs/RECOMMENDATIONS.md` 的 Milestone 3。目标是先实现纯文本 inline Skills，为模型提供稳定工作方法，不迁移 BabeL-X 的 React `SkillTool` 和 fork 模式。

- [x] 新增 `src/skills/loader.ts`：解析 front matter，加载 skill id/name/triggers/priority/content。
- [x] 支持三级目录：`src/skills/built-in`、`~/.babel-o/skills`、`<cwd>/.babel-o/skills`。
- [x] 新增 `matchSkills(skills, prompt)`：按触发词匹配，最多注入 3 个，按 priority 排序。
- [x] 将匹配到的 inline skill 注入 system prompt 或 context assembler。
- [x] 内置 5 个 skill：coding、optimization、debugging、testing、git。
- [x] 初版不支持 `mode: fork`；fork 等 AgentLoop/sub-agent 能力稳定后再接。

## P2 Smart Permissions

来自 `docs/RECOMMENDATIONS.md` 的 Milestone 4。目标是从全手动审批升级为轻量规则自动分类，不迁移 BabeL-X 的复杂九阶段权限管道。

- [x] 新增 `src/runtime/classifier.ts`。
- [x] Read/Grep/Glob 等 read-only 操作自动放行。
- [x] Bash 支持安全白名单：`ls`、`cat`、`pwd`、`git status`、`git log`、`git diff`、`npm list`、`npx tsc --noEmit` 等。
- [x] Bash 支持危险黑名单：`rm -rf`、`sudo`、管道 curl/wget、`npm publish`、`git push` 等。
- [x] 写操作默认仍要求人工确认。
- [x] 所有自动放行/拒绝记录 permission audit reason。
- [x] 收紧 Bash 自动审批白名单：把 `npm test`、宽松 `npx tsc .*`、任意参数 `cat` 等规则拆成精确命令/参数集合，补充绕过样例测试；未知 Bash 继续默认人工确认。
- [x] 为 Bash 分类引入轻量 shell 词法扫描，拦截管道/重定向/链式操作、命令替换、变量展开和未闭合引号，避免仅靠正则判断。
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
