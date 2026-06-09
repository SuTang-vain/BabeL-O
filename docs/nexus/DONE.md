# BabeL-O / Nexus 已完成能力索引

## 口径

本文件用于把各 TODO 文档中的已完成大项移出待办清单，避免 `[x]` 历史堆叠干扰优先级判断。事实流水、验证命令和真实会话复盘仍以 [WORK_LOG.md](./WORK_LOG.md) 为准；本文件只保留可检索的完成能力索引。

完成项进入本文件的条件：

- 能对应到源码、测试、命令验证或明确工作记录。
- 已不再需要作为下一步开发任务持续跟踪。
- 若后续发现回归，应在对应 TODO 中重新开一个未收口项，而不是修改旧完成记录。

## Runtime / Nexus

- Nexus API、WebSocket stream、embedded/service runtime、sessions/tasks/events 基础接口已落地。
- `LocalCodingRuntime` 与 `LLMCodingRuntime` 已支持工具循环、provider stream、usage/error 归一、max loop 保护和失败 `result` 输出。
- Runtime pipeline seam 已继续推进：`runtimePipeline.ts` 统一承载 local prompt parser、provider turn collector、execution metrics builder、provider tool input/message builder、terminal result/error event builder、context blocking helper、loop state / execution state helper、compact/reassemble state refresh helper、provider request assembly / loop guard helper 与 provider turn outcome reducer；`runtimeToolLoop.ts` 已抽出单个 provider tool call execution helper，`LLMCodingRuntime` 已接入且保留既有 permission/hook/schema/Read cache/tool result budget 行为。
- SQLite / Memory storage 已支持 session、events、tasks、tool traces、permission audits、execution metrics、child sessions。
- `storageBridge` 已具备 retry、JSONL WAL、batch flush、replay 与 compact。
- `PendingPermissionRegistry`、Bash CWD、TaskQueue、TaskSession 已具备 TTL/prune/close cascade 生命周期清理。
- WebSocket 快速 `permission_response` 竞态已修复：runtime 在发送 `permission_request` 前先注册 pending permission entry，避免快客户端审批被丢弃。
- Workspace path escape、invalid tool input、Bash non-zero exit、provider empty response、max loops、context limit 等错误已改为可恢复或可诊断边界。
- Docker execution environment 第一版已实现 local container lifecycle、workspace mount、network/memory/cpu 配置；remote runner protocol 设计、`RemoteToolRunner` 最小 dispatch seam、`InMemoryRemoteToolRunner` test-double transport、permission/cancel/audit/capacity parity 回归与 `HttpRemoteToolRunner` / `createRemoteToolRunnerServer()` 最小 HTTP transport 已落地；仍不包含部署、调度、文件同步或 remote provider loop。
- Go Remote Runner Phase A protocol compatibility spike 已落地：`runners/go-runner/` 提供最小 HTTP server，支持 capabilities、Noop execute、cancel、protocol version validation、request id tracking 与 structured result/error；`test:go-runner` / `test:go-runner:smoke` 为显式 gated，不进入默认 `npm test`。
- Go Remote Runner Phase B read-only backend 已落地：capabilities 切换为 `ListDir` / `Glob` / `Grep` / `Read`，Go `internal/tools` 实现 ListDir bounded directory inventory、Glob stable sorted match、Grep regexp scan、Read offset/limit/preview/truncation、cwd/allowedPaths、workspace escape/symlink escape、输出预算与 context cancel/timeout；默认测试仍不要求 Go toolchain。
- Nexus 侧 remote runner 可选配置与降级已落地：`NEXUS_REMOTE_RUNNER_URL` / `NEXUS_REMOTE_RUNNER_REQUIRED` 显式配置、capabilities/protocol validation、`HttpRemoteToolRunner` 构造、required fail-fast、service/embedded mode 复用，以及 `/v1/runtime/status` redacted diagnostics。
- Go Remote Runner 安全默认值已落地：默认 loopback bind、非本机绑定显式 opt-in、read-only capabilities diagnostics、Bash/Write/Edit disabled、server-owned concurrency/output/deadline 硬上限，以及容量耗尽结构化错误。
- Go Remote Runner Phase C restricted Bash 已落地：`GO_RUNNER_ENABLE_BASH=1` 显式启用，复用 Nexus 权限/命令策略，Go 侧提供 process group cancel/timeout、stdout/stderr 分离、输出预算、exit code/signal/duration 结构化结果和 env allowlist。
- Go Remote Runner Phase D worktree-aware Write/Edit backend 已落地：`GO_RUNNER_ENABLE_WRITE=1` 显式启用，Nexus 保持 worktree lifecycle/review/merge/audit 所有权，remote executor/critic 步骤传递 worktree cwd 与 narrowed allowedPaths，Go 侧提供 Write/Edit 路径边界、symlink-parent escape 拒绝和 gated HTTP smoke 覆盖。
- Go Runner metrics passthrough 已落地：TS/Go remote protocol result 保留 runner id、protocol version、runner duration、roundtrip、truncated/originalBytes、exit code/signal、cancelled/timedOut/errorCode 诊断；Nexus 将其映射到 `tool_completed.remoteRunner`、tool trace、execution metrics 与 `/v1/runtime/metrics` 本地聚合，不新增远程 telemetry。
- EverCore Phase A REST Spike 已落地：新增默认关闭的可选 EverCore REST client 与环境配置，支持 EverOS 当前 `/api/v1/memory/add|flush|search`；`/v1/runtime/status` 暴露 redacted diagnostics；session close/cancel 可 opt-in 上传 bounded user/result messages 并 flush，失败不影响 BabeL-O 主流程且不替代 SQLite/session/event/tool trace 事实源。
- EverCore Phase B Internal MemoryProvider 已落地：`MemoryProvider` / `NoopMemoryProvider` / `EverCoreMemoryProvider` 抽象与 EverOS typed search response parser 已接入；server、embedded client 与本地 CLI flow 在 EverCore healthy 时可把 bounded search hits 注入 provider context；长期语义记忆 block 保持 volatile / non-cacheable 且失败不污染 provider-visible context。
- EverCore Phase C Context Budget / Diagnostics 已落地：MemoryProvider diagnostics 暴露 provider/enabled/hitCount/injectedChars/budgetChars/maxHitChars/truncated/searchLatencyMs/error；`analyzeContext()`、HTTP `/v1/sessions/:sessionId/context`、CLI `/context` 与 context view 均显示 long-term memory budget 状态，并保持检索失败 non-fatal。
- EverCore Phase D Optional MCP Tools 已落地：`BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=1` 且 EverCore healthy 时注册 `mcp:evercore:memory_search` / `memory_save_note` / `memory_flush_session`；search 为 bounded read-only explicit retrieval，save/flush 为 write risk 并复用现有 permission/audit 边界，不改变每轮自动检索或 session-end 上传策略。
- EverCore Phase E Embedded / Managed EverCore Spike 已落地：`BABEL_O_EVERCORE_MODE=managed` 可让 BabeL-O/Nexus 默认关闭地管理本地 loopback `everos server start` sidecar，自动分配端口与数据目录并在 `/v1/runtime/status` 展示 sidecar diagnostics；external mode 继续保留，失败 non-fatal，长期记忆仍不替代 SQLite/session/event/tool trace 事实源。
- Current-turn session finalization P0 回归已收口：`runSessionFlow()` 只使用当前轮 `executeStream()` events 结算 session outcome，不再回扫整段 session 旧 terminal event；当前轮无 `result` / `error` 时写入 `REQUEST_INTERRUPTED_WITHOUT_TERMINAL_EVENT` failed 诊断，用户取消保持 `cancelled`，新一轮开始清空旧 `result` / `error` / `terminalReason`。
- SessionChannel + Inbox MVP 已落地：`SessionChannel` / `SessionMessage` typed channel、MemoryStorage/SQLite persistence、Nexus API create/send/list/inbox/ack 与 runtime/context API non-cacheable inbox 注入已完成；跨 session 消息保持 collaboration context，不作为直接用户指令，不做 raw transcript sharing 或完整 dreaming。
- SessionChannel CLI/TUI unread inbox / ack 可见化已落地：HTTP/embedded clients 支持 list/ack inbox，`bbl sessions inbox/ack` 与 `bbl chat` `/inbox`、`/inbox all`、`/inbox ack <messageId>` 可展示 handoff/finding/message 来源、状态、priority 与 evidence refs，并继续提示先验证证据再行动。
- AgentScheduler parent-child channel 已落地：Explore/Review/Test child jobs 会创建 `parent_child` SessionChannel，parent→child 写入 review/validation request，child terminal 时向 parent inbox 写入 handoff/blocked；`agent_job_event` 与 child transcript 查询仍是 lifecycle/source-of-truth。
- EverCore projectId namespace 治理已落地：`/v1/runtime/status` 的 EverCore status 暴露 Layer 2 Project memory 使用 `projectId` 隔离且不是 session-scoped；启用 EverCore 但未显式配置 projectId 时输出 `EVERCORE_PROJECT_ID_DEFAULT` guidance；`BABEL_O_EVERCORE_PROJECT_ID_MODE=workspace` 可 opt-in 从 git root 或 cwd 派生稳定 projectId，显式 `BABEL_O_EVERCORE_PROJECT_ID` 仍最高优先级。
- EverCore project-scoped MemoryProvider diagnostics 已落地：`MemoryProviderDiagnostics` 暴露 scope、namespaceId、namespaceSource 与 isolationKey；EverCore provider 标记 `scope=project` / `isolationKey=projectId`，context analysis、HTTP context API、CLI `/context` 与 context view 均展示 long-term memory namespace/budget 状态。
- Session Channel scoped memory diagnostics 与可行性回归已落地：context analysis、HTTP context API、CLI `/context` 与 context view 暴露 `scopedMemory[]` 分项，覆盖 project/user/channel scope；SessionChannel API→Inbox→Context focused regression 验证两个 session 可通过 typed message 传输 collaboration context，ack 后不再注入接收方 context。
- Session Channel Phase E governed memory candidate MVP 已落地：`memory_candidate` message 会生成 review-only governance metadata，覆盖 scope classifier、evidence refs、confidence、staleness/supersession、approval requirement、blocked/review reasons 与 `autoWrite=false`；inbox context 显示候选治理状态，默认不自动写入 EverCore 或长期记忆。

## Context / Compact / 指令跟随

- Context budget、token estimator、blocking limit、manual/auto compact、compact failure fuse、retained tail、retained segment verification 已落地。
- Context blocking hard-block 诊断已落地：`context_blocking` 结构化事件、`CONTEXT_LIMIT_EXCEEDED` 413 details、`/v1/execute` result envelope status 和 CLI action 提示均能区分 warning 与 hard block。
- Compact / blocking recovery 回归已补强：覆盖成功 compact boundary 后 runtime 继续 provider 路径、auto compact failure fuse 开启后不重复 auto compact 并 hard block、WebSocket stream 传输并持久化 `context_blocking`。
- Token estimator conservative mode 已落地：默认 25% provider 偏差 buffer，budget/blocking 决策使用保守估算，并覆盖 conservative buffer 不变量与混合上下文样本回归。
- Token estimator provider 偏差校准增强已落地：JSON-like、长 tool_result、reasoning/thinking 与 provider tool schema wrapper 使用专用估算口径，focused 回归覆盖 50K JSON schema、10K 中文、长 tool_result、DeepSeek reasoning、provider schema overhead 和 conservative blocking state。
- Cache-aware compact / 长上下文利用已落地：runtime context budget 使用 adaptive effective ceiling，大上下文模型可突破旧 120k cap，同时保留 reserved output/provider safety buffer；高 cache-read + cacheable system prompt 会进入 cache-preserving mode 延迟 auto compact，provider context error 会退回保守 compact 阈值，`/context` 展示 cache economics 与 policy reason。
- Cache-aware compact benchmark/runtime metrics follow-up 已落地：`execution_metrics`、SQLite/Memory storage、session assets 与 `/v1/runtime/metrics` 已写入 first-token latency、cacheRead/cacheCreation、effective/legacy ceiling、cache policy mode 和 compact summary latency；performance benchmark 输出 `cacheAwareCompact` 与 auto compact summary latency。
- Context ceiling / runtime metrics 诊断对齐已落地：context analysis、CLI `/context`、context warning/blocking events、blocking error details、`execution_metrics` side table、`/v1/runtime/metrics` 与 `/v1/runtime/status` 统一暴露 registry model window、reserved output、provider safety buffer、legacy/effective ceiling、env hard cap、policy source 与 warning/compact/blocking thresholds。
- `/compact`、`/context`、Context Analysis API、Post-Compact State、Compact Capability Reminder 已落地。
- `Read` 重复大文件读取诊断已落地：同一 session 记录 byte/line range 与 session read index，再次完整读取同一大文件时返回 `<read-repeat>` 并引导 offset/limit、Grep/Glob 或 targeted read。
- Tool Discovery / Targeted Reading 第一阶段已收口：不新增与 `Grep` 重叠的重复 `Search`；`Glob` 用于 path pattern discovery，`Grep` 用于 content locating，`Read` preview / truncated result / repeat ledger 引导 targeted range 读取，避免重复灌入大文件。
- `ListDir` 已作为正交目录 inventory 工具落地：TypeScript builtin 与 Go Remote Runner read-only backend 均支持 bounded workspace-safe directory inventory，输出 entries/counts/truncated/skippedDirs/guidance；Explore/Review/Test Agent profile 与 allowlist 已同步使用 `ListDir` / `Glob` / `Grep` / `Read` 的明确边界。
- `Grep` fallback regex parity / no-result diagnostics 已落地：TypeScript fallback 在 `rg` 不可用时使用 JavaScript `RegExp` scan 支持基础 alternation，并对 fallback mode、no-result 与 invalid-regex 输出明确 locator diagnostics，避免空结果被误读为完整源码证据。
- `Grep` pathMatches 参数语义诊断已落地：`pathMatches: "true"` / `"false"` 这类 boolean-string 非 glob 意图会返回 `INVALID_GREP_PATH_MATCHES_GLOB` recoverable diagnostic，提示省略该字段或使用 `**/*.ts` / `**/package.json` 这类 file glob，避免误导性空结果。
- Bash-as-file-discovery guidance 已落地：`ls`/`find`/`tree`/recursive grep/`rg` 等只读 discovery 命令会获得 `BASH_AS_FILE_DISCOVERY` structured guidance，提示优先使用 `ListDir` / `Glob` / `Grep` / `Read`；broad discovery 命令的 classifier reason 也带同一替代工具提示。
- Bash timeout / SIGTERM recoverability 已落地：普通 command timeout 返回 `tool_completed(success=false)` 与结构化 `COMMAND_TIMEOUT` / `timedOut` / `signal` / stdout/stderr 摘要，不再把普通 shell timeout 升级为 session fatal；外部 request abort 仍走 runtime cancellation path。
- Workspace Path Drift 最小诊断已落地：`Read` / `ListDir` missing path 与 `Glob` missing search root 可输出 cwd-aware `PATH_DRIFT_SUSPECTED` guidance 和 safe candidate path，引导模型修正路径根，同时保留 recoverable failure / empty-result 语义且不自动切换 cwd。
- 工具结果持久化与消息级预算专项已完成，详见 [archive/TODO_tool_result_budget.md](./archive/TODO_tool_result_budget.md) 的历史设计。
- User Intake Guidance 事件管线已替代早期硬 pivot / regex 主分类，短问候、暂停、状态追问、纠错、显式路径切换均有回归覆盖。
- Intake 模型失败时的 respond-only fallback 已覆盖身份/能力短问（如“你是谁？”）与上下文记忆短追问（如“还记得我刚刚问什么吗？”），并通过直接 fallback 单元测试与 provider request 层回归避免短追问触发旧工具链或暴露 tools。
- Intake Classifier Phase 1/2/3/4 已落地：`status` intent 不再硬覆盖模型 `requiresTools=true` 判断，intake prompt 已加入中英文“验证/检查/跑测试/lint/build”等执行类 few-shot；真实样本 `"验证当前未提交改动是否健康"` 已覆盖为工具保持可见；纯 status 短问改为 prompt guidance 而非隐藏工具；pause/greeting 仍首轮硬 respond-only，并在 provider 坚持调用工具时通过 `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` 注入一次可恢复 retry。
- `session_321c48be`、`session_3ba2d788`、workspace escape 后“继续”、cancel 后状态追问、provider empty response、invalid tool input/schema failure 等真实漂移样本已进入 regression corpus。
- Session Memory Lite opt-in 第一版已实现：`BABEL_O_SESSION_MEMORY_LITE=1` 时维护 `.babel-o/session-memory.md` 并产出审计事件。
- Session Memory Lite 后台化最小切片已实现：无工具自然停顿或 token/tool-call 增长达到阈值时进入顺序后台队列，非阻塞写入 `.babel-o/session-memory.md` 并跳过同一用户轮重复更新。
- Session Memory Lite 诊断增强已实现：`session_memory_updated` 记录 decision/token/tool-call/summary policy 元数据，`/context` diagnostics、CLI 展示和 HTTP context API 均暴露 enabled、last update、next decision 与 extractive-only cost policy。
- Working Set 已接入 context assembly：runtime 从 `user_message` 与 tool input 提取路径，按 touches/recency 选择最多 16 个 entry，并以 non-cacheable `working_set` section 注入 system prompt，指导后续 targeted `ListDir` / `Glob` / `Grep` / `Read`。
- Context Manager 最小规范化切片已落地：`src/runtime/contextManager.ts` 定义显式 phase、`ContextItem` / `ScoredContextItem` / `SelectedContextItem` 与 selection diagnostics；`assembleContext()` 保留既有 selection 行为并输出 retained/dropped diagnostics，`analyzeContext()`、HTTP context API 与 CLI `/context` 已展示 retained/dropped reason、estimated tokens、working set paths 与 compact boundary。
- ContextForker 多模式已落地：`minimal`、`working-set`、`task-focused`、`full-summary`、`debug-replay` 均有 focused 回归；AgentScheduler 会把 fork diagnostics 写入 child session metadata，HTTP context API 与 CLI `/context` 已展示 fork mode、inherited/omitted item 数量。
- Prefix Cache 稳定性诊断已落地：runtime 计算 cacheable immutable prefix ratio、cacheable system text + sorted tool names 的 SHA-256 fingerprint，以及 volatile-content-last invariant，并写入 `execution_metrics`、storage、`/v1/runtime/metrics` 与 `/v1/runtime/status`。
- Path Mention / Completer 已落地：CLI lazy workspace path index 支持 `@` mention 与路径分隔符补全、fuzzy basename/path 匹配、50K entry cap、dot-dir 可发现、dependency/build 目录跳过，以及 workspace escape/URL 排除回归。
- LSP Context Mention 已落地：CLI 侧 `@symbol:` / `@sym:` 补全 TypeScript/JavaScript/Go 语义 symbol 引用，`@diagnostic:` / `@diag:` 补全 TODO/FIXME/ts-ignore/eslint-disable/merge-conflict marker 等诊断引用；结果以普通 prompt 文本插入，不改变 runtime ownership、不启动外部 LSP server、不新增模型可见 LSP 工具。
- File Attachment / Image References 已落地：`bbl chat` 提交前解析 `@path` / `@file:path`，把 workspace 内小文本文件追加为有预算的 `<attached_file_references>` prompt block；目录、缺失路径、workspace escape、二进制与超预算文件只记录状态；图片路径、`@image:path` 与粘贴的 `file://` 图片 URI 会记录 `status="image"`、bytes 与 mimeType metadata，不改变 Nexus event schema、provider message schema 或 provider 多模态注入语义。
- Vim Mode 已落地：`BABEL_O_VIM_MODE=1` opt-in 时，`bbl chat` 在现有唯一 readline input owner 内支持 insert/normal 模式切换、基础移动和删除；默认关闭，overlay/permission/paste/Enter/Ctrl+C/Ctrl+E/Ctrl+O 路径保持原语义。
- Prompt Suggestions 已落地：输入为空时基于 session 状态展示上下文相关 placeholder 提示（新 session / Read / Bash / result / task failed / pending），agent running 时隐藏。
- Theme / Brand Polish 已落地：`BABEL_O_THEME` 环境变量支持 `default`（品牌色 hex）与 `minimal`（黑白 bold）两套主题，Welcome card 与 CLI 共用 `getTheme()` 单例。

## Provider / Model

- Provider registry、config CLI、models CLI、Anthropic-compatible / OpenAI-compatible / Local adapter、retry、usage/error 归一已落地。
- Zhipu、MiniMax、DeepSeek、OpenAI、Anthropic official provider seed 已落地。
- Moonshot 与 Ollama/local OpenAI-compatible provider seed 已落地：registry、models list/inspect、OpenAI-compatible adapter mock smoke、provider diagnostics 与 BabeL-X Moonshot config import 均有回归覆盖。
- MiniMax text-encoded `<minimax:tool_call>` 已归一为标准 Nexus tool invocation。
- Provider protocol regression 已覆盖标准 tool call、partial/malformed tool arguments、multi-tool arguments、MiniMax XML-like tool call、Anthropic malformed delta 与 OpenAI malformed function arguments。
- Provider adapter robustness error metadata slice 已落地：`ProviderError` 解析 provider-specific error code/type/message/request id，OpenAI-compatible non-200 回归覆盖 JSON error body，Agent role structured output diagnostics 可区分 provider protocol、JSON parse、schema mismatch 与 capability gate。
- Provider diagnostics、`/v1/runtime/status`、`/status`、provider smoke dry-run、显式 simple-text/tool-call live smoke、fallback policy 诊断与 fallback plan API 已落地。
- 统一 diagnostics object 已落地：`RuntimeDiagnosticsEnvelope` 被 context analysis、provider dry/live smoke、provider fallback plan 和 AgentLoop live smoke 复用，CLI/API 输出同一 `status · summary` 口径且保留非 silent fallback action。
- Runtime 模型能力诊断与 Models Inspect polish 已落地：`inspectModelCapabilities()` 统一输出 registry declaration、capability source、provider adapter/auth mode、context/default max tokens、tool/json/structured/streaming、long-context 与 AgentLoop role suitability；`ConfigManager.getProviderDiagnostics()` 与 `bbl models inspect` 复用同一口径，unknown/custom model 显示 undeclared 保守占位且不做自动模型切换。
- 测试进程写真实 provider config 的污染守门已落地：`ConfigManager.save()` 在测试进程中拒绝写默认 `~/.babel-o/config.json`，要求通过 `BABEL_O_CONFIG_FILE` 或显式临时路径隔离。
- DeepSeek `reasoning_content` replay 已有 adapter 与 runtime 回归，能在 tool result 续轮中回放真实 reasoning，不伪造缺失 reasoning。
- Tool-call Text Leakage P0 守门已落地：MiniMax bracket-wrapped pseudo tool call 可被严格归一为标准 tool-use deltas；runtime 在 `respond_only`、tools hidden、final-response-only 等禁用阶段对未知 tool-shaped assistant text 执行 suppression-only guard，输出 `TOOL_CALL_TEXT_LEAK_SUPPRESSED`、redacted preview、retry/metrics diagnostics，且不会把未知文本语法提升为真实工具调用。

## Agents / Optimize

- TaskSession、TaskQueue、Planner/Executor/Critic、Optimizer、自优化 CLI、Planner human-in-the-loop 已落地。
- SubTasks、受控 sub-agent 委派、max depth/max subTasks、父任务 blocked/resume、重复委派检测、成本控制、`--no-critic` 等已落地。
- Worktree isolation、nested worktree merge-back、cherry-pick 范围回传、冲突诊断、冲突现场保留、continue/abandon/keep 恢复入口、in-place Git hardening 与 per-cwd Git lock 已落地；Git workspace 中的 optimizer in-place task 默认需要显式 opt-in/confirmation，worktree 创建失败不静默 fallback，并记录 task 前后与 resolution 后 Git status snapshot。
- 跨 session 子 Agent、child transcript 引用、父 session 作用域 child transcript 摘要/详情查询、CLI retry-task 入口、失败子 Agent transcript-preserving rerun API/CLI、permission inheritance 审计、child cancel/resume、父 session close 级联取消已落地。
- `bbl optimize --provider-smoke-live` 入口已落地，使用固定临时 workspace、固定 read-only fixture、固定 planner review task，不执行任意用户任务。
- AgentLoop live/manual smoke 已提供 role diagnostics：展示每个 role 的模型、工具白名单、repair 次数、事件/工具计数与结构化输出失败类型；mocked smoke 覆盖不泄露 API key，MiniMax-M3 真实 provider 固定 smoke 已通过。
- SDK/dashboard session assets query API 已落地：`GET /v1/sessions/:sessionId/assets` 聚合 session、tasks、child sessions、events page、tool traces、permission audits、critic reviews、usage summary 与 execution metrics。
- SDK task mutation 最小写接口已落地：create、update、claim/complete/fail/cancel/retry/approve/reject，支持 actor/source/reason 审计、requestId 幂等与 expectedUpdatedAt revision guard；MemoryStorage 与 SqliteStorage 最小 smoke 已覆盖。
- 外部 task cancel 已与 TaskSession 生命周期初步合并：取消任务会级联取消匹配 child sessions，并把依赖该任务的 blocked/pending/in-progress task 标记为 failed。
- 外部 task fail/retry 已复用依赖传播语义：fail 会把依赖该任务的可传播 task 标记为 failed 并记录 failedDependencies；retry 会恢复由该依赖失败导致的 dependent task 到 blocked。
- 外部 task approve/reject 已收紧到 Planner HITL 边界：只有 `review.status === 'pending'` 的 task 可被 approve/reject，非 pending review task 返回 `TASK_REVIEW_NOT_PENDING`。
- SDK/dashboard task mutation smoke 已扩展到 active/terminal session 与 worktree task：active session 允许写，completed/cancelled/failed session 返回 `SESSION_NOT_MUTABLE`，worktree task mutation 保留 isolation metadata。
- AgentLoop mocked cost/failure benchmark 已接入 `npm run benchmark`：覆盖 critic retry success、sub-agent delegation success、executor failure limit，并输出 role call、duration、retry、failureTypes、subAgentSessionCount、token estimate、retry overhead 与 sub-agent cost。
- AgentLoop structured output repair 已落地：Planner 空计划优先 repair 为更小任务列表，Executor/Optimizer repair prompt 保留 raw invalid output，Critic repair 失败时 conservative reject / needs-human-review。
- AgentScheduler 第一片 core contracts/profile groundwork 已落地：`src/nexus/agents/types.ts` 定义 `AgentJob`、`AgentResult`、`AgentProfile`、`ContextForkMode` 与 scheduler interface 占位；`AgentProfiles.ts` 启用 read-only `explore` profile，默认 `ListDir/Glob/Grep/Read`、`minimal` context fork、无 Bash/编辑权限；`test/agent-profiles.test.ts` 已纳入默认 `npm test`，不改变既有 `runAgentLoop()` 行为。
- In-memory `AgentJobRegistry` 已落地：支持 queued/running/waiting_permission/completed/failed/cancelled 状态转换、parent/status/profile list filter、terminal wait/timeout、cancel、defensive clone 与 transcript reference-only contract；`test/agent-job-registry.test.ts` 已纳入默认 `npm test`。
- Read-only Explore Agent MVP 已落地：`ExploreAgentScheduler` 独立于 `RemoteToolRunner` 和 `runAgentLoop()`，负责 child session/job lifecycle、minimal context fork、read-only runtime 执行、cancel/wait/list 与 structured `AgentResult`；`AgentSpawn`、`AgentWait`、`AgentList`、`AgentCancel` 可通过显式 `enableAgentTools` / `BABEL_O_ENABLE_AGENT_TOOLS=1` 暴露给 parent runtime，Explore child 仅允许 `ListDir/Glob/Grep/Read`。
- AgentScheduler API / CLI 管理层已落地：Nexus runtime factory 创建共享 `ExploreAgentScheduler`，HTTP API 提供 `/v1/agents` spawn/list/get/wait/cancel/transcript 与 session-scoped list，`bbl agents` 提供 spawn/list/show/wait/cancel/transcript/session 命令；focused API/CLI 回归已纳入默认 `npm test`。
- Review/Test Agent profiles 已落地：`review` / `test` profiles 复用 `task-focused` fork，允许 `ListDir` / `Glob` / `Grep` / `Read` 与受限 Bash check-only 命令，不允许编辑；AgentResult 会记录 `commandsRun` / `testsRun`，focused profile/scheduler/tool/API/CLI 回归已覆盖。
- Explore Agent remote execution smoke 已落地：`ExploreAgentScheduler` 支持显式 scheduler-level `executionEnvironment: remote` / `remoteRunner`，service/embedded 可通过 `NEXUS_AGENT_EXECUTION_ENVIRONMENT=remote` opt in；`AgentSpawn(explore)` 可在不暴露 Go Runner 为模型可见工具的前提下，通过 Go Runner 执行 `ListDir` / `Glob` / `Grep` / `Read`，并回收 `AgentResult`、child transcript reference、cancel 与失败摘要。
- AgentScheduler governance、独立 event schema 与 persistent AgentJob storage 已落地：模型可见 AgentScheduler 具备 max concurrent agents、max depth、timeout failed 状态和 job/child session/tool output diagnostics；AgentJob 生命周期使用 top-level `agent_job_event`，TaskSession 旧事件继续保留；Memory/SQLite 已持久化 AgentJob 并支持重启后 list/get/wait/cancel 可见；Implement Agent 继续延后，不向普通 child agent 开放 Edit/Write。
- AgentLoop maintainability helper 拆分已落地：`agentLoopSubAgents.ts` 抽出 sub-agent session id、lifecycle metadata、permission inheritance、parent reference、orchestration context、subtask normalization 与 session summary helper；`agentLoopWorktree.ts` 抽出 optimizer Git stash/commit/rollback、Git status snapshot 与 in-place optimizer approval helper；`runAgentLoop()` 主状态机未重写，focused helper/AgentLoop/worktree/benchmark 回归已覆盖。
- Agent role capability diagnostics 已落地：runtime role step、`agent_loop_role_step_metrics` 与 AgentLoop live smoke per-role diagnostics 均展示当前 provider/model、context window、default max tokens、tool/json/structured/streaming、role suitability、missing capabilities 与 manual switch hint；capability gate mismatch 产出 `AGENT_ROLE_CAPABILITY_MISMATCH` 且不会触发 runtime/provider 调用，不恢复自动模型选择、fallback execution 或 silent switch。
- `runAgentLoop` ↔ AgentScheduler bridge 评估已收口：两者保持执行路径分离，`runAgentLoop()` 继续负责 optimize/task orchestration、subTasks、worktree/retry/critic/permission inheritance，AgentScheduler 继续负责模型可见 Explore/Review/Test jobs、ContextForker、AgentJob governance/storage 与 `agent_job_event`；后续只在 UX 需要时评估只读 observability/status bridge。
- Implement profile 评估已收口：当前不启用 `implement` AgentScheduler profile、不开放 Edit/Write child agent；未来必须先实现 worktree-isolated child execution、changed files/diff 摘要、parent review/merge/reject/recovery 与独立写安全策略，且 remote runner Write/Edit 只作为执行后端。

## CLI / TUI

- `bbl run`、`bbl chat`、`bbl nexus`、`bbl sessions`、`bbl tools audit`、`bbl config`、`bbl models` 已落地。
- CLI embedded local boundary 已收口：`createEmbeddedNexusClient()` 通过 `createNexusApp().inject()` 复用 Nexus API，`chat.ts` 不再直接 import SQLite storage、session lifecycle、compact/context runtime internals。
- Local runtime 已支持自然语言文件问答，同时显式 `read/write/edit/grep/glob/bash/task` 工具命令保持最高解析优先级。
- Slash palette、tool palette、history search、model wizard、status/smoke/context/compact 命令已落地。
- 多级 permission panel 已落地，支持 once/session/editable rule/reject/reject with instruction，Esc/Backspace 不误批准。
- 类 Claude/Gemini 的层级事件渲染、工具状态原地更新、compact/expanded 工具详情、agent running indicator、context warning、task status panel 已落地。
- `/agentloop-smoke` TUI 入口已落地：mock AgentLoop/sub-agent 层级可在 `bbl chat` 中稳定触发并展示 parent blocked、child running/completed、depth、parentTaskId 与 transcript 引用。
- `/agents` 只读 multi-agent status view 已落地：按当前 session 聚合 AgentScheduler `AgentJob` 与 AgentLoop sub-agent lifecycle，展示状态计数、child session、governance/error metadata 与 transcript reference，不改变执行路径。
- TUI Worktree Flow panel 已落地：从 worktree lifecycle/recovery `task_session_event` 聚合 isolation、merge、conflict、recovery 状态，展示 preserved worktree、冲突文件和 `bbl sessions worktree-recovery` 操作提示；Task Status Board 会标记 worktree recovery task。
- 无外框 welcome header、boxed input prompt、长输入软换行、paste placeholder 压缩/展开、唯一 input owner、原生滚动恢复已落地。
- 唯一输入框键盘路由 PTY smoke 已覆盖 slash palette、tool picker、model wizard、permission panel、长输入、Tab/Enter/Backspace/Esc/↑/↓ 与 AgentLoop running 路径，避免双输入框和重复命令插入回归。
- Agent running indicator smoke 已覆盖 Working/Generating/Running tool/Waiting permission/Compacting/Running sub-agent/Retrying，以及 successful/failed tool terminal states 不残留 live status。
- 最小 PTY smoke 已覆盖 slash palette、permission panel、compact Read 渲染、input placeholder、read/edit/diff/Grep/Glob/TaskCreate、resume session 和 paste/input 基线，并扩展到 AgentLoop/sub-agent 层级、tool/model overlay、键盘路由和 agent terminal states 主路径。
- `/status` 与 `bbl tools audit` 已支持 compact tool audit 展示：builtin/MCP 计数、MCP server/tool、registered name、risk、policy/server 状态、approval required 与 suggested allow rule，并避免在 TUI 主输出泄露 raw inputSchema。
- SessionChannel TUI unread indicator / Inbox overlay 已落地：`bbl chat` boxed input footer 显示 linked sessions、unread count、channel kind 与 key message 摘要；`/inbox` / `/inbox all` 打开 side-channel overlay，展示 message/evidence/governance，支持 open/read、ack 与 quote into current prompt，quote 只预填且需用户手动提交。
- SessionChannel 主对话关键事件卡片已落地：`bbl chat` 在 session flow 后只对关键 unread side-channel message 渲染 compact card（handoff/blocked/review/validation/high finding/governed memory_candidate），卡片只提示 open inbox/ack/quote 与 evidence/governance，不把跨 session 消息自动作为当前用户输入或工具指令。
- SessionChannel TUI 真实 PTY smoke 已落地：覆盖 unread footer、`/inbox` overlay、ack、quote into prompt 且不自动提交、主对话事件卡片、overlay 焦点互斥、resize/navigation 稳定和关闭后主输入框恢复。

## MCP / Skills / Permissions / Hooks

- MCP stdio client、registry、tool adapter、risk classification、input schema validation、tools audit 与官方 MCP smoke 已落地。
- Markdown inline skills loader、project/user/built-in 三层目录、trigger/priority 匹配与内置 coding/debugging/testing/git/optimization skills 已落地。
- Smart permission classifier、Bash lexical scan、read-only auto approve、危险命令 deny/manual review、cat workspace preflight、permission audit 已落地。
- Permission pending state backend seam 已落地：`PendingPermissionRegistry` 通过 `PendingPermissionBackend` 委派 register/resolve/resolveSession/sweep/reset，默认 in-memory backend 保持 process-local 行为，后续可替换为 SQLite/Nexus-owned backend。
- MCP permission display 已对齐：`permission_request.source` 可携带 MCP server/original tool，permission panel 展示来源，含冒号 MCP 工具名的 session allow rule 可正确缓存匹配。
- Runtime hooks 最小内核已落地：`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`SubagentStart`、`SubagentStop`、`SessionEnd` 的 typed event、内置 hook、timeout/error isolation 和审计事件。
- Runtime hook 配置聚合已落地：`hooks.enabled`、built-in hook enable/disable、timeout 覆盖、统一结果聚合 helper、runtime/tool loop/CLI prompt/session close/subagent lifecycle 配置透传已覆盖；仍不执行任意自定义 shell hook。
- Invocation Diagnostics hooks 已落地：`PreInvocation` / `PostInvocation` 包住每次 provider call，记录 provider/model、role、loop、context budget、tool visibility、cache/final-response mode、duration、success/errorCode/failureKind，并复用现有 hook event 流。
- Provider / AgentLoop runtime metrics 可观测性已落地：`/v1/runtime/metrics` 与 `/v1/runtime/status` 基于本地 persisted events 聚合 provider invocation 成败/耗时/failure kind/error code/role、AgentLoop role step token/耗时/失败/retry/sub-agent，以及 AgentJob completed/failed/cancelled 指标，不引入云端 telemetry。

## Cleanup / Performance

- `docs/nexus` 已成为唯一长期文档中心。
- Runtime 去重已完成：共享 `toolExecutor.ts`、`app.ts` 执行准备/metrics helpers、Git helpers、结构化 logger。
- `npm run typecheck`、`npm test`、`npm run benchmark`、核心 storage/context/provider/TUI smoke 已建立；Runtime context 回归套件已纳入默认 `npm test`，覆盖 token estimator、blocking/context diagnostics、microcompact、compact post-restore、context display/API、working set、prefix cache、path mention 与 tool result budget。
- 1000+ sessions/events API scale benchmark 已接入 `npm run benchmark`：`apiScale` 覆盖 MemoryStorage 与 SqliteStorage 的 `/v1/sessions`、session detail、events page 和 assets 查询，并输出 p50/p95、payload size、item/event count 与 query count 近似诊断。
- Chat first-response 与 storageBridge fault-injection benchmark 已接入 `npm run benchmark` / `npm run test:performance`：`chatFirstResponse` 覆盖 cold CLI、warm embedded、service HTTP 和 provider SDK/SQLite/context assembly 诊断；`storageBridgeFaultInjection` 覆盖 corrupt WAL skip、SQLite write retry、crash interrupted replay、compact failure diagnostic，并基于结果暂保留 storageBridge 结构。
- Provider retry policy benchmark 已接入 `npm run benchmark` / `npm run test:performance`：`retryPolicy` 覆盖 rate limit retry success、provider unavailable retry exhausted、empty response output retry exhausted、schema mismatch repair success 与 tool protocol no-auto-retry，并输出 retry count、failure type、额外 token/耗时、success rate 与 mocked AgentLoop retry overhead 汇总。
- 本地 benchmark history 已接入 `npm run benchmark` / `npm run test:performance`：默认写入 `.babel-o/benchmarks/latest.json`、`history.json` 与 `summary.json`，保留最近 20 次机器可读摘要和 previous/delta/deltaPct，不引入远程 telemetry。
- TS/Go runner 对比 benchmark 已接入 `npm run benchmark` / `npm run test:performance`：默认执行 TS local runner 场景并输出 Go skipped reason，`BABEL_O_RUN_GO_RUNNER_SMOKE=1` 时才启动可选 Go RemoteToolRunner；覆盖 `Read`、大目录 `Grep`/`Glob`、Bash stdout、大输出截断、workspace escape、cancel latency 与 timeout correctness，并将 runnerComparison 指标纳入本地 benchmark history summary。
- 测试并发治理 Phase 1-4 已落地：`npm run test:concurrency` 使用 bounded per-file 测试进程，为每个文件创建独立临时 BabeL-O config，当前覆盖 50 个已审计测试文件，包含 AgentLoop、benchmark history、runner comparison benchmark、permission flow、optimizer safety、runtime、security 与 worktree 强状态候选；runner 不再覆盖测试内显式 model/provider config，并通过 `node --import tsx --test` 稳定子进程模块解析。
- Production build smoke 与 dependency boundary audit 已落地：`npm run build:smoke` build `dist/` 后验证 `bbl --help`、`bbl chat --help`、`bbl run hello`；`npm run deps:audit` 输出 dependency ownership、runtime reachable imports、CLI imports，并拦截 runtime→CLI 依赖泄漏、dev dependency 泄漏和未声明第三方 import。
- Check-only lint/format、CI workflow 与 coverage report 已落地：`npm run format:check` 只检查 CRLF/final newline/trailing whitespace/JSON parse，不自动改写文件；`npm run lint` 串联 typecheck、format check 和 dependency audit；`.github/workflows/ci.yml` 覆盖 npm ci/typecheck/format/deps/test/build smoke；`npm run coverage` 产出 `coverage/coverage-summary.json` 且暂不设置硬阈值。
- BabeL-X compatibility strategy 已落地：BabeL-O 默认不读取 `~/.babel/config.json`，只提供显式一次性 `bbl config import-babel-x` dry-run/apply；导入输出不泄露 API key，`--apply` 合并写入 BabeL-O config；BabeL-X transcript import 不支持，Nexus runtime/session schema 不接纳旧 transcript schema。
- TUI Visual / Keyboard P1 回归已补齐：history search overlay ownership、长路径/CJK/ANSI/resize 宽度、stale wrapped rows 和 sub-agent running + model/context gauge 组合均有 focused 覆盖。
- `README.md` 与 `README.zh-CN.md` 已拆分英文/中文入口。

## 上下文管理升级专项

历史 Phase 0-3 已完成能力记录保留在本节；后续上下文规范化、ContextForker 与模型可见 AgentScheduler 规划见 [reference/context-and-subagent-upgrade-plan.md](./reference/context-and-subagent-upgrade-plan.md)。

已收口范围覆盖 Token 估算、Blocking Limit、Microcompact、Compact 后状态重建、Session Memory、Working Set、Prefix Cache、Path Mention。

- Microcompact 已抽离到 `src/runtime/compactors/microCompact.ts`：保留兼容导出，支持重复工具输出按工具名与规范化输入去重、保留最新结果，并向 `/context` 诊断暴露 dedupe/byte/token savings 指标。
- Compact 后状态重建已抽离到 `src/runtime/compactPostRestore.ts`：`contextAssembler.ts` 保留兼容导出，post-compact state、restored file contents 和 capability reminder 可单测复用。
- Restored file contents 总预算已接入 compact post-restore：单文件与总 char budget 同时生效，超预算内容带截断提示，避免 compact 后状态重建反向膨胀。
- `/context` 诊断已增强：`analyzeContext()` 输出 structured diagnostics，覆盖 remaining/headroom、usage input/cached/output/reasoning、auto compact fuse、large tool results、repeated tool inputs、memory pressure、microcompact savings 和 recommendations；CLI `/context` 展示同步更新。
- Retained segment / resume 用户可见诊断已接入 `/context`：compact retained segment fallback 与 resume recovery boundary 会出现在 diagnostics、signals、recommendations 和 CLI 展示中。
- `/context` 诊断继续增强已完成：新增轻量 working set 路径、large-context auto-compact floor 解释与 compact 前后 token/event delta，并覆盖 CLI 展示和 HTTP context API passthrough。
- `/context` 展示一致性回归已补齐：blocking/warning、compact boundary、recovery boundary 的 structured diagnostics、CLI formatter 文本和 HTTP Nexus API passthrough 已有 focused 覆盖。
- Retained segment / resume fixture 已补强：覆盖 retained tail 使用、boundary anchor mismatch、first/last event identity mismatch、hash mismatch、count mismatch、recovery boundary code 集合与 auto-compact 后恢复边界保留。
- Compact Post-Restore 已增强：从现有 tool/task/task_session/hook 事件推导 MCP tool audit、tool contract reminders、tool failure summary、skill reminders、agent/sub-task status，并覆盖 compact 后最新任务、workspace escape、cancel boundary、provider empty response 恢复 fixture。
- Session Memory Lite 诊断增强已收口：更新审计元数据、extractive-only 成本策略、next decision、last update 状态已进入 structured diagnostics、CLI `/context` 和 HTTP context API，并覆盖 compact/manual 与 reactive pause 路径。
- Cache-aware compact / 长上下文利用已收口：新增纯 policy helper、adaptive assembly ceiling、runtime auto-compact policy、provider loop guard 和 `/context` cache economics 展示；focused 回归覆盖长窗口 effective ceiling、cache-preserving threshold、env hard cap、provider context error 保守路径和 CLI reason 输出。
- Context Manager / ContextForker 规范化已收口：显式 pipeline phases、统一 ContextItem/Scored/Selected types、selection diagnostics、retained/dropped reason 与 `/context` 展示已接入；ContextForker 已支持 `minimal`、`working-set`、`task-focused`、`full-summary`、`debug-replay` 多模式 fork diagnostics。
- Go TUI Phase 1 opt-in smoke harness 已收口：`test/go_tui_pty_driver.py` + `test/go-tui-smoke.test.ts` 在 `BABEL_O_RUN_GO_TUI_SMOKE=1` 下固化 `bbl go --no-alt` → `bash <command>` → `Permission: Bash` → `a` approve → `Bash done success=true` → `done success=true` 链路；默认 skip，CI 不强制 Go toolchain；`test/go-command.test.ts` 增加 driver `--help` 探针守住 Python 端 CLI 表面。
- Go TUI Phase 2 event renderer parity 已收口：`formatNexusEvent` 补 9 个 case（`user_message` / `user_intake_guidance` / `task_created` / `task_session_event` / `agent_job_event` / `compact_boundary` / `compact_failure` / `session_memory_updated` / `execution_metrics`），不再 fall through 到 `compactJSON`；`linePresentation` 加 11 个稳定 8 字符 label；`renderPermission` 现在展示 `input: <command>` 与 `reason: <message>`（消除 P1 安全 UX bug：`Permission: Bash (execute risk)` 不再盲批）；`formatToolInput` 按工具名提取最相关字段；21 个 Go test 全过。
- §5 路径 C 阶段 2：增量拉取 + profile 切换命令 + tombstone 已收口：`BabelOConfig` / `BabelOConfigSchema` 加 `tombstones` 与 `configVersion`（`save` 自增）；`ConfigManager.deleteProfile()` / `restoreProfile()` / `isProfileTombstoned()` / `getTombstones()` / `getConfigVersion()` 暴露；`GET /v1/runtime/config?since=<v>` 在 since >= version 时返回 304；`GET /v1/runtime/config/profiles` 与单 profile 详情端点均带 `version` + `tombstones`；`POST /v1/runtime/config/select` 把 tombstone 检查放在 `unknown_profile` 之前并返回 400 `tombstoned_profile`；`isProviderConfiguredForSharedView` 同时扫 env / provider config / active profile / 所有 profile 的 apiKey 持有；`bbl config profile <list|use|delete|restore>` CLI 子命令落地；Go TUI 联调 `fetchRuntimeConfig` / `fetchRuntimeProfiles` / `selectRuntimeProfile` 三个 HTTP 调用，新增本地 `/config` / `/profile` / `/profiles` slash-style 命令。
- §5 路径 C 阶段 3：Go TUI 消费 version polling + tombstone UX 收口：`clients/go-tui/main.go` 加 `--poll-interval-ms` flag（默认 30000ms，0 禁用）；`fetchRuntimeConfig(cfg, since)` 在 since > 0 时附加 `?since=N`，`nexusJSON` 在 304 时返回 `errNotModified` 哨兵，`runtimeConfigMsg` 304 静默 reschedule、version 推进时打印 `config updated:` 状态行；`friendlyNexusError` 把 `tombstoned_profile` / `unknown_profile` / `not_supported` / `missing_profile` 映射为人话 hint，`/profile <name>` 选到 tombstoned profile 不再吐 raw JSON；`formatRuntimeProfiles` 把 tombstones 单独列在 `tombstones (N):` 块下，按 name 字典序、带 `[tombstoned] deletedAt=<ts>` 标记；32 个 Go test 全过。
- Go TUI Phase 3：input owner / overlay state machine 收口：`clients/go-tui/main.go` 引入 `inputMode` 类型（`composing` / `permission` / `slashPick` / `helpOverlay`）+ `setMode` + `canEditInput()`；`Update` 的 KeyMsg 路由按 mode 分发，permission 模式下除 a/r/n/esc 外所有键被吞、help 模式走 up/down/esc/enter/q；`?`（空 input）开 help overlay；`permission_request` 抵达时 `setMode(modePermission)`，`sendPermissionDecision` 完成后回到 `modeComposing`；textinput 实例在 `newModel` 一次性创建、跨 mode 永不替换（in-progress draft 在 permission/help round-trip 后仍保留）；14 个新单测 + `test/go_tui_pty_driver.py phase3-overlay-mutex` 序列守住单 input owner 与 overlay 互斥。
- Go TUI Phase 8 early slice：`bbl go` managed Nexus launcher 已收口：TypeScript CLI wrapper 会先构建 Go TUI launch spec，再探活 `GET /health`；localhost / `ws://localhost` URL 不健康时自动拉起隐藏 `__server` child，并继承 `process.execArgv` 支持开发态 `node --import tsx`；远程 URL 和 `--no-start-nexus` 只连接不启动；Go TUI 退出时只清理本次 wrapper 自己拉起的 child；`--allowed-tools`、`--nexus-startup-timeout-ms`、`--poll-interval-ms` 已接入。Go binary 仍保持纯客户端，不拥有 Nexus/runtime/tool/session 决策。

## 仍需守住的底线

- TODO 文件只写未完成项；完成后移动到本文件并在 WORK_LOG 追加事实。
- 新增真实会话回归时，先补最小 regression corpus，再调整 runtime/adapter/TUI。
- Provider fallback 不能 silent model switch；任何模型/profile 切换必须用户显式确认。
- 子 Agent / optimizer 默认优先隔离执行；in-place Git 操作不能纳入无关未跟踪文件或删除用户文件。
- TUI 权限面板、slash/tool palette 和 input owner 的键盘路由不能退回多输入框或 `y/N` 单行审批。
