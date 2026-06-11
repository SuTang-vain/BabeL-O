# TODO CLI / TUI Experience

## 目标

BabeL-O 的 CLI 必须保留 BabeL-X 出色的编程交互能力。轻量化不等于简陋；CLI 不拥有 runtime，但必须是一等交互客户端。本文只保留 `bbl chat`、输入框、slash/tool palette、权限交互、事件渲染和 PTY smoke 未收口项。已完成交互能力见 [DONE.md](../DONE.md)。

## 当前状态

- `bbl run/chat/nexus/sessions/tools/config/models`、embedded/service mode、slash palette、tool palette、history、model wizard、permission panel、diff、context/compact、agent running indicator、层级事件渲染、唯一 input owner、paste placeholder、PTY 基线均已落地。
- 当前风险不在“是否有 TUI”，而在编程闭环是否被真实 PTY smoke 持续守住：文件问答、task update/status、AgentLoop/sub-agent、唯一输入框键盘路由、tool picker/model wizard overlay、agent running terminal states、history search overlay ownership、长路径/CJK/ANSI/resize 宽度、MCP tool/audit 可见性、multi-agent status view、LSP context mention、file attachment references、image reference metadata 与 opt-in vim mode 已补齐；后续只在真实显示回归或新增交互状态时继续补 fixture。

## 已收口 Programming Loop Smoke

Programming loop smoke 已覆盖自然语言文件问答和 task update/status：PTY 中 local runtime 能读取临时 repo 文件并回答具体问题，`task status` / `task update <id|suffix|title> <status> [result]` 可测入口已落地，TUI 展示 assistant 文本、task session event 摘要与 task board 更新。

## 已收口 Visual / Keyboard Regression

Visual / keyboard P1 回归已补齐当前高价值集合：唯一输入框覆盖 slash palette、tool picker、model wizard、permission panel、history search、paste buffer、长输入、Tab/Enter/Backspace/Esc/↑/↓ 与 AgentLoop running 路径；agent running indicator 覆盖模型工作/生成、工具运行、等待权限、compact、retrying、子 Agent running、done/failed 和 context gauge 组合；终端视觉覆盖长路径、CJK、ANSI、resize、粘贴、多行输入、工具完成原地替换和 history redraw 基线。后续只在新增 provider retry / multi-agent terminal state 或真实显示回归时补组合 fixture。

## 已收口 MCP / Tool Discoverability

`/status` 与 `bbl tools audit` 已展示 compact tool audit：builtin/MCP 计数、MCP server、tool/resource 边界、registered name、风险等级、policy enabled/disabled、server allowlist 状态、approval required 与 suggested allow rule。展示 MCP 工具时不把 raw `inputSchema` / provider schema 塞入主对话；resource listing 当前 runtime 尚未暴露，TUI 明确显示 `MCP resources: not exposed by current runtime`。MCP tool 的 risk classification、requiresApproval、suggested allow rule、server identity 已进入 audit formatter；`permission_request.source` 会携带 MCP server/original tool，permission panel 展示 `mcp/<server>` 来源，含冒号的 MCP session allow rule 已有回归覆盖。

## 已收口 Path Mention / Completer

`src/cli/pathMention.ts` 已提供 lazy `WorkspacePathIndex`，按 fuzzy basename/path 查询 workspace 文件，cap 50K entries，并避免在普通自然语言 token 上扫描目录。`.babel-o/`、`.claude/` 等 dot-dir 可被发现；`node_modules`、build/dist/coverage/cache 类目录默认跳过；`@` mention 与带路径分隔符 token 触发补全，URL token 不触发，workspace escape 返回空候选。`test/path-mention.test.ts` 已纳入默认 `npm test`。

## 已收口 Prompt Suggestions

输入为空时基于 session 状态显示上下文相关 placeholder 提示：新 session 显示引导文案，执行完成后按最近事件类型（Read/Bash/result/task failed/pending）切换提示语，agent running 时隐藏。`src/cli/promptSuggestions.ts` 与 `setupAutosuggestions` sessionHintRef 接入现有 `renderBoxedInput` placeholder 渲染管线。

## 已收口 Theme / Brand Polish

`BABEL_O_THEME` 环境变量支持 `default` / `minimal` 两套主题：default 使用品牌色 hex #ff006e 与 accent 紫；minimal 使用 bold 黑白。Welcome card、renderEvent 等通过 `getTheme()` 单例获取主题函数。

## 已收口 Worktree Flow

TUI 已提供只读 Worktree Flow panel：从现有 `task_session_event` 聚合 `worktree_created`、`worktree_merged`、`worktree_merge_conflict` 与 `worktree_recovery_action`，展示 isolation、merge、conflict、recovery 状态、preserved worktree path、冲突文件和 `bbl sessions worktree-recovery <sessionId> <taskId> continue|abandon|keep` 操作提示。Task Status Board 会把 worktree recovery metadata 标记为 `worktree`，不改变后端 worktree lifecycle、merge/reject/recovery 所有权。

## 已收口 LSP Context Mention

CLI 侧已提供轻量 LSP context mention：`@symbol:` / `@sym:` 可补全 workspace 中 TypeScript/JavaScript/Go 的 class/interface/type/function/const/method 等语义引用，`@diagnostic:` / `@diag:` 可补全 TODO/FIXME/ts-ignore/eslint-disable/merge-conflict marker 等诊断引用；补全结果以普通 prompt 文本形式插入，例如 `@symbol:src/runtime/contextForker.ts#ContextForker`，不改变 runtime ownership、不启动外部 LSP server、不把 LSP 做成模型可见工具。

## 已收口 File Attachment / Image References

`bbl chat` 提交 prompt 前会解析 `@path` / `@file:path` file attachment references，把 workspace 内的小文本文件追加为有预算的 `<attached_file_references>` prompt block；目录、缺失路径、workspace escape、二进制文件和超预算文件只记录状态，不嵌入内容。图片路径、`@image:path` 与粘贴的 `file://` 图片 URI 会记录 `status="image"`、bytes 与 mimeType metadata，但不做 provider 多模态注入。

## 已收口 Vim Mode

`bbl chat` 已提供 opt-in vim input mode：`BABEL_O_VIM_MODE=1` 时在现有唯一 readline input owner 内支持 insert/normal 模式切换、`h`/`l`/`0`/`$` 移动、`x`/Backspace 删除、`i`/`a` 回到 insert；默认关闭，不改变 slash palette、permission panel、overlay、paste、Ctrl+C/Ctrl+E/Ctrl+O 或 readline 原生 Enter 提交路径。

## P2 SessionChannel 联系可见化

> Runtime / API 已具备 SessionChannel + Inbox；TUI 后续目标不是把多个 session 的 transcript 混成一个聊天流，而是把跨 session 联系作为 side-channel 显示，让用户知道“有其他工作区传来协作上下文”，同时保持当前 session 的主对话语义清晰。

### 已收口 SessionChannel Unread Indicator / Inbox Overlay

`bbl chat` 已在 boxed input footer 显示轻量 SessionChannel 状态：linked session 数、unread inbox 数、channel kind 摘要与 high-priority/key message 类型；状态不展示消息正文、不抢占主输入框、不改变当前 session 执行状态。`/inbox` / `/inbox all` 已打开 TUI Inbox overlay，每条消息展示 source session、target/broadcast、channel kind、message type、priority、createdAt、ack 状态、evidence refs 与 memory candidate governance 摘要；overlay 明确标注 collaboration context / not direct user instructions，并支持 open/read、ack、quote into current prompt。quote 只预填当前 prompt，必须由用户审阅后手动提交；ack 只调用 inbox ack，不改变 cwd/provider/profile/permission 或其他 session 状态。

### 已收口 SessionChannel 主对话轻量事件卡片

`bbl chat` 会在 session flow 后刷新 unread inbox snapshot，仅对关键 unread side-channel message 渲染 compact card：`handoff`、`blocked`、`request_review`、`request_validation`、high-priority `finding`、以及 governance rejected / requires approval 的 `memory_candidate`。卡片只展示 source/target、channel、evidence、governance 与 `[open inbox] [ack] [quote]` 操作提示，不自动注入消息正文、不自动触发工具、不改变 cwd/provider/profile/permission；启动时会把既有关键消息标记为 seen，避免旧消息在主对话中重放刷屏。普通低优先级 finding/question 只更新 unread indicator。

### 已收口 SessionChannel Inbox Overlay PTY Smoke

真实 PTY smoke 已覆盖 seeded local SessionChannel inbox：boxed input footer unread indicator、`/inbox` overlay 打开、ack selected message、quote into prompt 且不自动提交、主对话关键事件卡片、overlay 对 slash palette 的焦点互斥、resize/navigation 后 overlay 稳定以及关闭后主输入框恢复。当前 TUI 仍是消费侧入口：`/inbox` / `/inbox all` / `/inbox ack <messageId>` 用于处理 inbox；发起跨 session message 仍通过 Nexus API 或 AgentScheduler parent-child channel，不新增 raw transcript sharing 或直接跨 session 指令 UI。

### P2 / Watch SessionChannel 关系可见化后续规划

详细设计见 [SessionChannel TUI Relationship Visibility Plan](../reference/session-channel-tui-relationship-visibility-plan.md)。推荐分层组合：状态栏长期显示 connection / unread / high-priority 摘要，session 列表用 badge / marker 提供扫描能力，`/sessions tree` / `/agents tree` 表达 parent-child 派生链，`/activity` overlay 审阅近期跨 session 事件，`/channels graph` 只作为 debug-only 概览。Full message handling 仍以 `/inbox` 为主；inline preview 只允许摘要，不展示完整正文或自动注入 prompt。

后续若重新打开实现项，按 Phase 1 状态栏增强 + session list badge、Phase 2 tree view、Phase 3 activity overlay、Phase 4 debug graph 的顺序推进。发起侧 UX 另行以 `/inbox` reply 和 `/channel send <sessionId|channelId>` 评估，但必须具备 typed message、evidence、confirmation preview 与手动提交边界。

### 持续语义边界

- 不实现 raw transcript sharing UI。
- 不把另一个 session 的消息渲染成当前 session 的用户输入。
- 不允许一个 session 通过 TUI 操作静默改变另一个 session 的 cwd、provider、profile、permission 或执行状态。
- `memory_candidate` 只展示 review-only governance metadata 与 approval requirement；不提供默认自动写入长期记忆按钮。若未来加入写入入口，必须先走独立 approval / permission 规划。

当前 P2 Advanced CLI/TUI 无打开实现项；SessionChannel 关系可见化已进入 P2 / Watch 参考规划，后续只在真实显示回归、PTY smoke drift、dashboard/agent UX 需要、关系可见化实现启动或发起侧 UX 明确时重新开未收口项。provider role defaults/fallback 仍按总控无限期 delay，不作为当前 TUI 前置项。

## 已收口 Go TUI Permission Policy / Bash Hard-Deny 治理

> 详细规划见 [Go TUI Permission Policy / Bash Hard-Deny 治理规划](../reference/go-tui-permission-policy-governance-plan.md)。真实样本：`session_go_1781076550805204000`（Go TUI WebSocket session，sessionId 末段 204000）。

- Phase A — Bash read-only subcommand 自动放行已收口：`src/tools/builtin/bashClassifier.ts` 新建 230 行纯函数 `classifyBashRisk`（read-only 白名单 + git 拒绝子命令 + find `-type f` 特殊处理 + 30+ 危险 pattern 二次校验）；`src/tools/builtin/bash.ts` `bashTool` 加 `riskForInput` 钩子（`risk` 仍 `'execute'` 保留 audit 身份）；`src/tools/Tool.ts` `ToolDefinition` 加 `riskForInput?: (input: any) => ToolRisk` 字段；`src/shared/events.ts` `ToolStartedEventSchema` 加 optional `effectiveRisk` 字段；`src/runtime/LocalCodingRuntime.ts` 与 `src/runtime/LLMCodingRuntime.ts` 新增 private `effectiveRisk` helper，hard-deny gate + approval gate 都用 `effectiveRisk` 判定；`test/bash-classifier.test.ts` 新建 12 个 focused test；既有 regression 测试更新为反映新语义。
- Phase B — soft-deny policy per-request override 已收口：`src/nexus/app.ts` `executeSchema` 加 `policy: z.enum(['strict', 'soft-deny']).optional()`；`CreateNexusAppOptions` 加 `executePolicyMode?: 'strict' | 'soft-deny'`（server-side 默认值，默认 `'strict'` 保 back-compat）；`prepareExecution` 解析 `policyMode = body.policy ?? executePolicyMode`；`src/runtime/Runtime.ts` `RuntimeExecuteOptions` 加 `policyMode?: 'strict' | 'soft-deny'`；`src/runtime/LocalCodingRuntime.ts` hard-deny gate 改为 `if (effectiveRisk !== 'read' && !this.toolPolicy.isAllowed(tool) && options.policyMode !== 'soft-deny')`——**核心改动仅一行**，soft-deny 仅 bypass hard-deny 让既有 approval gate 自然触发 `permission_request`；`clients/go-tui/internal/tui/tui.go` `Config` 加 `PolicyMode string`，`buildExecuteRequest` 总是附加 `policy` 字段（默认 `'soft-deny'`）；`test/runtime.test.ts` 新增 2 个 Nexus focused 测试 + 4 个 Go TUI `buildExecuteRequest` / `runStream` 测试。
- Phase C — 端到端 mock provider regression 已收口（含 bug 修复）：`src/runtime/LocalCodingRuntime.ts:4465` `case "result", "error"` 之前不重置 `m.inputMode`，导致 permission denied 流程后 model 卡在 `modePermission` 不出来，textinput 吞掉非 `a/y/n/r/esc` 键；修复为显式 `m.setMode(modeComposing)`。`clients/go-tui/internal/tui/tui_test.go` 新增 3 个 model-level 测试守住 `permission_request → modePermission` 与 `result → modeComposing` 双向 transition（含 approve / deny 两条路径）。`test/runtime.test.ts` 新增 `execute permission denial: user denies → tool denied + result(false)` 端到端测试。
- Phase D — Go TUI `--allow-tools` flag 已收口：`src/runtime/perRequestPolicy.ts` 新建独立模块（避免 `LLMCodingRuntime` ↔ `LocalCodingRuntime` 循环 import）——导出 `buildPerRequestAllowedToolsPolicy(allowedTools)` helper，镜像 server-startup policy 解析（`*` / `all` → `allowAllTools`；否则 → `allowlistedTools`）。`src/runtime/Runtime.ts` `RuntimeExecuteOptions` 加 `allowedTools?: readonly string[]` 字段。`src/runtime/LLMCodingRuntime.ts:128-143` 与 `src/runtime/LocalCodingRuntime.ts:109-127` `executeStream` wrapper：`options.allowedTools` 非空时构造 override policy、用 `withToolPolicy` 包裹 inner body（`runExecuteStreamInner` 抽到私有方法）。`src/nexus/app.ts` `executeSchema` 加 `allowedTools: z.array(z.string().min(1)).optional()`；HTTP + WebSocket 两条 `runtime.executeStream()` 调用都透传。`clients/go-tui/internal/tui/tui.go:42-50` `Config` 加 `AllowTools []string`；`buildExecuteRequest` 总是 trim / 空字符串过滤 / comma-split 后附加 `allowedTools` 数组。`clients/go-tui/cmd/go-tui/main.go` 加 `--allow-tools` flag（`flag.Func` 接收重复 + 逗号分隔）。`test/runtime.test.ts` 新增 2 个 Nexus focused 测试（soft-deny + allowlist 组合、turn 边界）；`clients/go-tui/internal/tui/tui_test.go` 新增 4 个 `buildExecuteRequest` 测试（include、omit、trim、wildcard）。

**守住的边界**：
- `bbl chat` 与 HTTP API 既有客户端完全 back-compat（不发 `policy` / `allowedTools` 走 server-side 默认 `'strict'` + `denyByDefaultTools()`）
- Go TUI 权限面板 `a/y/n/r/esc` 流程未改（不传 `--allow-tools` 时仍走流程）
- child AgentLoop 仍走 server-startup policy，不被 per-request `policy` / `allowedTools` 影响
- workspace path safety 仍由 `findWorkspaceEscapeInCommand` 拦截（独立机制）
- 不新增工具，不拆 Bash
- 不在 Nexus 主路径上改变 `denyByDefaultTools()` 默认 policy
- 端到端验证：721+ → 726 TS tests；Go TUI tests 全过；typecheck + format 0 failures

后续只在以下情形重新开项：(1) 真实会话继续暴露 Go TUI 权限 / policy drift；(2) 真实 PTY smoke 暴露 mode transition 边界 bug；(3) 真实用户反馈"需要 approval gate 区分 read / write / execute 三档"或类似 UX 增强。

## Watch / Stable Go TUI Maintenance

> 详细规划见 [Go TUI Long-Term Rewrite Plan](../reference/go-tui-rewrite-plan.md)。Go TUI 已通过 Phase 9 promotion gate，作为 `bbl chat` 的 stable opt-in alternative；它仍只拥有 terminal interaction / layout / keyboard routing / local rendering，不拥有 Nexus/runtime/context/AgentScheduler/provider/storage/permission 决策。

当前状态：

- `clients/go-tui/` 已采用标准 Go layout：`cmd/go-tui/` 为 executable entry，`internal/tui/` 为核心 TUI package 与白盒状态机测试，`bin/` 为本地 build output 且被 git ignore。
- `bbl go` 已接入 CLI，优先运行本地 Go TUI binary（source checkout 下为 `clients/go-tui/bin/go-tui`），缺失时 fallback 到 `go run ./cmd/go-tui`；wrapper 会先探活 `GET /health`，本地 URL 不健康时自动拉起 managed Nexus child，远程 URL 或 `--no-start-nexus` 只连接不启动。
- MVP 已具备 header、transcript、bottom input、footer、permission panel 与 layered event rendering。
- 已手动完成 local Nexus + WebSocket + `permission_request` / `permission_response` / Bash tool / result smoke；transcript 可显示 `stdout="go-tui-smoke"`。
- Go TUI 已开始消费共享模型配置：启动时拉取 `GET /v1/runtime/config`，header 展示 active profile；`/config`、`/profile`、`/profiles`、`/profile <name>` 作为本地命令通过 Nexus HTTP API 读取/切换 profile，不作为 agent prompt 发送。

近期未收口项：

- [x] Phase 1 opt-in Go TUI smoke harness（2026-06-09 收口）。
  - `test/go_tui_pty_driver.py` + `test/go-tui-smoke.test.ts` 已落地，验证 `bbl go --no-alt` 下 `bash echo go-tui-smoke` 走通 Nexus → `Permission: Bash` → approve → `Bash done success=true` → `done success=true`。
  - 默认 `BABEL_O_RUN_GO_TUI_SMOKE` 未设置时 skip；显式 `npm run test:go-tui:smoke` 启动。
  - 失败时打印 cleaned transcript + raw terminal bytes。
  - CI 默认不引用该脚本，避免强制 Go toolchain 依赖。
- [x] Phase 2 event renderer parity（2026-06-09 收口）。
  - `formatNexusEvent` 补 9 个 case：`user_message` / `user_intake_guidance` / `task_created` / `task_session_event` / `agent_job_event` / `compact_boundary` / `compact_failure` / `session_memory_updated` / `execution_metrics`，不再 fall through 到 `compactJSON`。
  - `linePresentation` 加 11 个稳定 8 字符 label。
  - `renderPermission` 现在显示 `input: <command>` 与 `reason: <message>`——直接收掉之前标记的 P1 安全 UX bug（用户盲批 Bash）。
  - `formatToolInput(name, input)` 按工具名提取最相关字段（Bash.command / Read.path / Grep.pattern / ListDir.path / TaskCreate.title）。
  - 16 个 Go test 守住 Phase 2 行为；`go test ./...` 21/21 通过；`npm run test:go-tui:smoke` 仍过。
- [x] §5 路径 C 阶段 1：ConfigManager 公开 + Nexus 配置拉取 HTTP 端点（2026-06-09 收口）。
  - `src/shared/config.ts` 公开 `ConfigManager.hasProfile(name)`，允许外部消费方按名字查询 profile 是否存在。
  - `src/nexus/app.ts` 暴露共享配置读端点：`GET /v1/runtime/config`、`GET /v1/runtime/config/profiles`、`GET /v1/runtime/config/profiles/:name`、`GET /v1/runtime/models`；响应均脱敏，不返回 `apiKey` 或 profile `baseUrl` 原文。
  - Go TUI 与其他远程客户端只能走 Nexus HTTP 拉取 profile/active/model 视图，不依赖 private 字段，不读取本地 config 文件。
- [x] §5 路径 C 阶段 2：真实 profile 切换 + 增量版本 + tombstone 基线（2026-06-09 收口）。
  - `GET /v1/runtime/config?since=<version>` 支持无变化时返回 `304`，用于 Go TUI 后续增量刷新。
  - `POST /v1/runtime/config/select` 保留为受限 profile 切换入口：只接受 `profile`，拒绝 `model` / `role` / `roleModel` 动态切换，避免远程 TUI 绕过 CLI 配置治理。
  - `ConfigManager` 已具备 `configVersion`、`tombstones`、`deleteProfile()`、`restoreProfile()`、`isProfileTombstoned()`；重新 `setProfile()` 会清理同名 tombstone，避免同名 profile 复建后仍无法选择。
  - `bbl config profile list/use/delete/restore` 已提供 CLI-only profile 生命周期操作；Go TUI `/profile <name>` 调用 Nexus `config/select`，不会直接写 config 文件。
  - `GET /v1/runtime/models` 的 `configured` 判断覆盖 env、provider config、active profile 与其他 profile 内的 provider API key，响应仍不泄露 secret。
- [x] §5 路径 C 阶段 3：Go TUI 消费 version polling + tombstone UX 收口（2026-06-09 收口）。
  - Go TUI 加 `--poll-interval-ms` flag（默认 30000，0 禁用）；`fetchRuntimeConfig(cfg, since int)` 在 since > 0 时附加 `?since=N` 查询；`nexusJSON` 在 304 时返回 `errNotModified` 哨兵，handler 静默 reschedule 不刷 transcript。
  - `runtimeConfigMsg` 在 version 实际推进时打 `config updated:` 状态行；304 静默 reschedule。
  - `friendlyNexusError` 把 `tombstoned_profile` / `unknown_profile` / `not_supported` / `missing_profile` 映射为人话 hint；`/profile <name>` 选到 tombstoned profile 时不再吐 raw JSON，而是显示"profile is tombstoned; restore via `bbl config profile restore <name>`"。
  - `formatRuntimeProfiles` 现在把 tombstones 列在独立 `tombstones (N):` 块下，按 name 字典序，带 `[tombstoned] deletedAt=<ts>` 标记。
  - 待补：profile 切换确认面板（带 y/n overlay）、错误态视觉回归 PTY smoke——留到 Phase 7 一并做。
- [x] Phase 3：Input owner / overlay state machine 收口（2026-06-09 收口）。
  - 引入 `inputMode`（`composing` / `permission` / `slashPick` / `helpOverlay`）+ `setMode` + `canEditInput()`。textinput 实例在 `newModel` 一次性创建，跨 mode 永不替换；in-progress draft 在 permission/help round-trip 后仍保留。
  - `Update` 的 KeyMsg 路由按 mode 分发：permission mode 吞掉 a/r/n/esc 以外所有键；help mode 走 up/down/esc/enter/q；slashPick 留占位（完整 live filter 走 Phase 4）。
  - `?`（空 input）开 help overlay；help 渲染单独 `helpOverlayLines`（含三种 mode 的键盘参考 + 当前已知 slash 命令清单）。
  - `permission_request` 抵达时 `setMode(modePermission)`；`sendPermissionDecision` 完成后 `setMode(modeComposing)`。phase 3 单 input owner 守住了"permission 模式下 `?` 不会打开 help 覆盖"这一关键不变量。
  - 14 个新单测守住：默认 composing、setMode 幂等、canEditInput 唯一性、permission 模式 key 不会污染 textinput、help overlay 开/关/esc、'q' 在 overlay 内不退出、textinput 跨 mode 实例不替换等。
  - `test/go_tui_pty_driver.py` 新增 `phase3-overlay-mutex` 序列：help 开/关 → permission 触发 → permission 模式按 'z' 不污染 textinput → '?' 在 permission 模式被吞掉 → 'a' approve → `Bash done` + `done success=true`。
  - 待补：真正交互式 slash palette（live filter 跟随输入）、toolPalette / historySearch / contextOverlay / inboxOverlay——`inputMode` 已为这些预留常量，下个 phase 继续。
- [x] Phase 4：slash / tool palette 收口（2026-06-09 收口）。
  - 引入 `slashCommand` 类型 + 18 个静态注册表项（/help、/config、/profile(/profiles)、/clear、/exit、/context、/compact、/inbox、/models、/tools、/sessions、/agents、/bash、/read、/grep、/glob、/write、/edit）。`handleLocalCommand` 重写为 registry 查表。
  - Live-filter palette：`/`（空 input）打开 `modeSlashPick`，按后续字符实时过滤；Up/Down/Tab 导航；Enter 运行零参 / 插入 prefix；Esc 关闭。`runPaletteSelection` 三种语义：prefix 命令 → textinput 插入 prefix + 回 composing；hasArgs 但无 prefix → 插入 `<cmd> `；零参 → 立即 `cmd.run(m, nil)`。
  - `renderSlashPalette` 渲染 header + 至多 6 候选（带 `>` 选中标记）+ navigation hint。
  - Tool palette：`toolDescriptor` + `renderToolPalette` 按 name/risk/source/approval-required 列对齐；`/tools` 注册项用静态目录（Read/Write/Edit/Bash/Glob/Grep/TaskCreate）。`/v1/tools/audit` HTTP wire 留到 Phase 7 之后的未来 phase。
  - 15 个新单测守住：registry 完整性、alias 解析、live filter、backspace、esc、up-down clamp、Enter 零参 / Enter prefix、palette render 隐藏性、tool palette 对齐、`handleLocalCommand` 未知命令错误路径。
  - 待补：`/context` `/compact` `/inbox` `/models` `/sessions` `/agents` 仍 status 行 TODO，留 Phase 5/6 wire 真实 backend；`/v1/tools/audit` 真实 wire 留到 Phase 7 之后；其他 overlay `inputMode` 留 Phase 6。
- [x] Phase 7：Go TUI PTY / visual regression harness 收口（2026-06-09 收口）。
  - `test/go_tui_pty_driver.py` 重构为 `SEQUENCES` 注册表驱动：每个 entry 含 `runner` / `ok_message` / `required_invariants`，`main()` 按 `--sequence` name 派发；新增 8 个独立序列 + 1 个 orchestrator：
    - `permission-approve`：Phase 1 baseline（bash echo → Permission: Bash → approve → Bash done → done success=true）。
    - `phase3-overlay-mutex`：Phase 3 单 input owner + overlay 互斥——help 开/关、permission 模式按 stray key 不污染 textinput、'?' 在 permission 模式被吞、'a' approve 收尾。
    - `slash-palette`：Phase 4 `/` 打开 live-filter palette → 输入 `h` → 单候选 `/help` → Enter 跑命令、出现 `local commands:` 与 `/profile` 行。
    - `slash-palette-prefix`：Phase 4 输入 `/bash` → Enter → 触发 prefix 插入，transcript 出现 `inserted prefix:` 状态行 + textinput 实际包含 `/bash `。
    - `tool-palette`：Phase 4 `/tools` 静态目录渲染（含 Bash risk=execute + approval-required 标记 + Bash/Read/Grep/Glob 列名）。
    - `help-overlay`：Phase 3/4 `?` 开 help overlay + `Esc` 关 overlay + 'q' 不退。
    - `tombstone-rejection`：§5 path C phase 3 polish——`/profile ghost` 走 friendlyNexusError 出 `unknown profile "ghost"`（同 friendly 路径覆盖 tombstoned profile 错误码）。
    - `visual-regression-narrow`：driver 启动时设 `COLUMNS=40 LINES=20`，验证 banner + help overlay 在窄宽度下不破坏 layout。
  - 新增 `all` 序列 = Phase 7 orchestrator：在一个 PTY session 内顺序跑其余 6 个真实序列（help-overlay / slash-palette / slash-palette-prefix / tool-palette / phase3-overlay-mutex / permission-approve），每个序列后用 `Esc` + 60 次 `\x7f`（DEL/backspace）重置 textinput 回到 composing——避免 `slash-palette-prefix` 把 `/bash ` 留在 input box 里污染下一段导致 `/bash /tools` 触发 unknown command 路径。
  - `clients/go-tui/main.go` 修一个 Phase 4 引入的 `handleLocalCommand` panic：prefix-insertion 命令（如 `/bash`）的 `cmd.run == nil`，但 Phase 4 直接 submit 路径没保护。`handleLocalCommand` 现在显式判定 `cmd.run == nil` 并返回 `command is not executable via direct submit: <name> (open the slash palette to use it)`，避免 nil-pointer-dereference（orchestrator 在 phase3 阶段就被这条 path 触发过一次）。
  - `test/go-tui-smoke.test.ts` 扩展到 9 个测试：8 个独立序列各一条 + 1 条 `all` orchestrator，orchestrator 测试额外断言每个 `running <name>` 行都打出来。`runGoTuiSmoke(sequence, timeoutSeconds)` 参数化 helper，opt-in 仍由 `BABEL_O_RUN_GO_TUI_SMOKE=1` 控制。
  - `BABEL_O_GO_TUI_SMOKE_CONFIG` 环境变量：driver 在 main() 把 PTY session 用的 config 路径注入到 Go TUI 子进程与 parent process，方便未来 tombstone / 错误态 PTY 序列做 pre-seed；当前 `tombstone-rejection` 序列不依赖它（友好错误路径等价）。
  - 范围克制：tool palette 仍走静态目录（`/v1/tools/audit` 真实 wire 留到未来 phase）、`/context` `/compact` `/inbox` `/models` `/sessions` `/agents` 仍 status 行 TODO（Phase 5/6 wire）、paste / multiline / Shift+Enter 仍留后续 PR。
- [x] §5 路径 C 阶段 3 polish 续：profile 切换 y/n overlay 收口（2026-06-09 收口）。
  - `clients/go-tui/main.go`:
    - 新增 `modeProfileConfirm` inputMode 常量 + `pendingProfileName` 字段；与 `modePermission` / `modeHelpOverlay` / `modeSlashPick` 共用 single-input-owner 状态机。
    - `submitPrompt` 取消 `m.setMode(modeComposing)` 强制重置（之前是 Phase 3 defensive 行为，但现在 /profile <name> 需要保留 modeProfileConfirm）；`handleLocalCommand` 自己拥有 mode 转换。
    - `/profile <name>` 重新实现：`profile == m.activeProfile` 时 short-circuit 出 `profile already active: <name>` 状态行并不开 overlay；否则把 `pendingProfileName` 写入 + `setMode(modeProfileConfirm)`，不直接发 HTTP。
    - `Update` 的 KeyMsg dispatch 加 `case modeProfileConfirm`：`y` / `enter` 调 `selectRuntimeProfile` 后回 composing；`n` / `esc` 清 pending + 写 `profile switch cancelled: <name>` 状态行 + 回 composing；其他键被吞（textinput 不会收到 stray key）。
    - 新增 `renderProfileConfirm(width int) string`：title "Confirm profile switch" + `current: <from>` / `→ new: <to>`（activeProfile 为空时单行 `→ Switch active profile to: <name>`） + y/enter / n/esc hint；与 help / slash palette 同一渲染风格，非 modeProfileConfirm 时返回空字符串。
    - `View()` 拼接 `profileConfirm` 在 permission / help / palette 之间、input / footer 之前；`helpOverlayLines` 加 Profile confirm overlay 段。
  - `clients/go-tui/main_test.go`:
    - 修改 `TestHandleLocalConfigCommandsDoNotStartAgentStream`：现在断言 `/profile dev` 返回 nil、进入 modeProfileConfirm、`pendingProfileName == "dev"`。
    - 新增 9 个单测：`TestProfileAlreadyActiveShortCircuitsConfirmOverlay` / `TestProfileConfirmYKeyFiresHTTPCommand` / `TestProfileConfirmEnterKeyFiresHTTPCommand` / `TestProfileConfirmNKeyCancelsWithoutHTTP` / `TestProfileConfirmEscKeyCancels` / `TestProfileConfirmStrayKeyDoesNotReachTextinput` / `TestRenderProfileConfirmEmptyOutsideMode` / `TestRenderProfileConfirmShowsHeaderInMode` / `TestProfileConfirmWithEmptyActiveShowsNoCurrent`。
  - `test/go_tui_pty_driver.py`:
    - seeded config 加 `activeProfile: alpha` + `profiles: {alpha, beta}`（都指向 local/coding-runtime）。
    - 新增 `run_profile_confirm_sequence` 三路径：n 取消 → "profile switch cancelled: beta"；y 确认 → "selecting shared Nexus profile: beta" + "profile switched: beta"；再选已 active → "profile already active: beta" 短路。
    - 加进 `SEQUENCES` registry；`all` orchestrator 顺序里插在 `tool-palette` 与 `phase3-overlay-mutex` 之间。
    - `tombstone-rejection` 序列跟随新行为：先等 confirm overlay 出现，按 `y` 后再等 `unknown profile "ghost"`。
  - `test/go-tui-smoke.test.ts`: 加 `profile-confirm` 测试 + `all` orchestrator 顺序同步。
  - 范围克制：profile 切换确认面板现在覆盖 y / n / esc / 留空重选四路径；tombstone / unknown profile 的 friendly 错误路径走同 `friendlyNexusError` 映射不变；后续若要扩展（如切换前展示 provider/model diff）留到 Phase 5/6 wire 真实 model metadata 时一并做。
- [x] Phase 5：context/compact 长会话 UX 收口（2026-06-09 收口）。
  - `clients/go-tui/main.go`:
    - 替换 `/context` `/compact` 的 status-line TODO：现在两者都先检查 `m.sessionID`，无 session 时直接出 `"context: no active session yet — submit a prompt first"` / `"compact: no active session yet — submit a prompt first"` 状态行 + 不发 HTTP；有 session 时 `appendLine "analyzing shared Nexus context: <shortID>"` / `"compacting shared Nexus context: <shortID>"` + 发 HTTP。
    - 新增 `contextAnalysisMsg` / `compactResultMsg` 类型（都带 `sessionID` + `raw []byte` + `err`），Update KeyMsg dispatch 加两个 case：err 路径 appendLine `"context: <err>"` / `"compact: <err>"`；成功路径 push `formatContextAnalysis(msg.raw)` / `formatCompactResult(msg.raw)`。
    - 新增 `fetchContextAnalysis(cfg, sessionID) tea.Cmd` 调 `GET /v1/sessions/<id>/context`；`triggerCompact(cfg, sessionID) tea.Cmd` 调 `POST /v1/sessions/<id>/compact` 带 `{"trigger":"manual"}`。
    - 新增 `nexusRawJSON` helper：与 `nexusJSON` 同请求 / 错误语义但返回 raw 字节，让 Go TUI 只 decode 关心的 stable envelope 字段、不被 upstream schema churn 击穿。
    - 新增 `contextAnalysisDiagnostic` / `contextSignal` 类型 + `formatContextAnalysis(raw []byte) string`：渲染 `context_analysis model=<id>` + `summary`（如 `context 6500/8192 tokens; 1692 remaining`）+ `status: <status>` + `compact: boundary present`（当 `compact.hasBoundary == true`）+ top 3 signals（含 `+N more` 截断标记）+ top 3 recommendations（含 `+N more`）。
    - 新增 `formatCompactResult(raw []byte) string`：渲染 `compact_result events: <before> → <after>` + `boundary: <type> <code>` 行；raw decode 失败时输出 `compact: decode failed: <err>`。
  - `clients/go-tui/main_test.go`: 12 个新单测——`TestContextWithEmptySessionShortCircuits` / `TestCompactWithEmptySessionShortCircuits` / `TestContextWithActiveSessionFiresHTTP` / `TestCompactWithActiveSessionFiresHTTP` / `TestFormatContextAnalysisExtractsTopLevelEnvelope` / `TestFormatContextAnalysisTruncatesLongSignalsAndRecommendations` / `TestFormatContextAnalysisReportsDecodeErrorOnInvalidJSON` / `TestFormatCompactResultExtractsEventCounts` / `TestFormatCompactResultIncludesCodeWhenPresent` / `TestFormatCompactResultReportsDecodeErrorOnInvalidJSON` / `TestContextAnalysisMsgErrorAppendsFriendlyLine` / `TestCompactResultMsgErrorAppendsFriendlyLine`。
  - `test/go_tui_pty_driver.py`: 新 `run_context_and_compact_sequence`——bash echo 让 `session_started` 事件填好 `m.sessionID`、approve permission、等 `Bash done` + `done success=true`，然后 `/context` 等 `analyzing shared Nexus context` + `context_analysis` envelope header，再 `/compact` 等 `compacting shared Nexus context` + `compact_result events:` 行。加进 `SEQUENCES` registry；`all` orchestrator 顺序里插在 `profile-confirm` 与 `phase3-overlay-mutex` 之间。
  - `test/go-tui-smoke.test.ts`: 加 `context-and-compact` 测试 + `all` orchestrator 顺序同步。
  - 范围克制：`/context` 只渲染 stable top-level envelope（summary / status / signals / recommendations），不做 full 200+ 行的 `contextView` 渲染（那需要 `contextOverlay inputMode` 常量 + viewport，留 Phase 6 Agent views 之后）；`/compact` 只展示 before/after event counts + boundary event type/code，不展开 compact 后状态重建细节（同 Phase 6 之后）。`/inbox` `/models` `/sessions` `/agents` 仍 status 行 TODO（Phase 6）。
- [x] Phase 5 续：contextOverlay 模式 + compact post-compact 详表 收口（2026-06-09 收口）。
  - `clients/go-tui/main.go`:
    - 新增 `modeContextOverlay` inputMode 常量 + `contextOverlayLines []string` + `contextOverlayScroll int` 字段。`/context` 响应处理从「只 push transcript 行」改为「先 push `formatContextAnalysis` 摘要到 transcript（持久化面包屑） + 建 full overlay lines + 打开 modeContextOverlay」。
    - KeyMsg dispatch 加 `case modeContextOverlay`：`esc` / `enter` / `q` 关闭 overlay + 清 `contextOverlayLines` + 写 `context closed` 状态行（与 help overlay 关闭模式一致）；`up` / `k` 减 scroll（clamp 到 0）；`down` / `j` / `tab` 增 scroll（clamp 到 `len-1`）；stray key 被吞。
    - 新增 `renderContextOverlay(width int) string`：与 help / slash palette / profileConfirm 同风格——`titleStyle.Render("Context · Phase 5 overlay")` header + divider + clamped line window + 底部 `scroll N/M` + `up/down/tab scroll  esc/enter/q close` 提示。`contextStyle` (foreground 75) 新增。
    - 新增 `buildContextOverlayLines(raw []byte) []string`：从 stable top-level envelope 抽取 sections、budget layers、compact retention、compact token delta、auto compact threshold / fuse、long-term memory (provider / scope / namespace / hits / injected / truncated / search latency / error)、scoped memory（每个 scope）、session memory lite（lastUpdate / nextDecision / costPolicy）、resume recovery、working set paths（top 3）、repeated tool inputs（top 2）、large tool results（top 2）、top 5 signals + top 5 recommendations。跳过 missing 字段保持 bounded line 数。
    - `formatContextAnalysis` 维持 stable top-level envelope 渲染（summary / status / top 3 signals / top 3 recommendations）——overlay 是主 UX，transcript 行是持久面包屑。
    - `formatCompactResult` 扩展 post-compact 详表：`compact_result events: <before> → <after>` + `boundary: <type> <code> trigger=<manual|auto|reactive>` + `summary: <first line>` (单行截断) + `summaryChars: N` + `snippedToolResults: N` + `budget layers: system=… summary=… history=… memory=…` + `retained segment: <status> · events=N`。新增 `firstLine(s, maxLen) string` helper（取首行 + 超长加 ellipsis）和 `formatCharCount(n int) string`（0 / < 1k / 1k-10k / 10k-1M / ≥ 1M 区间）。
    - `helpOverlayLines` 加 Context overlay 段：`up / down / tab  scroll` + `esc / enter / q  close`。
  - `clients/go-tui/main_test.go`: 10 个新单测 + `fmt` import——`TestBuildContextOverlayLinesExtractsTopLevelEnvelope` / `TestBuildContextOverlayLinesReportsDecodeErrorOnInvalidJSON` / `TestContextOverlayOpensOnMsgAndClearsOnClose` / `TestContextOverlayScrollClamps` / `TestRenderContextOverlayEmptyOutsideMode` / `TestRenderContextOverlayShowsHeaderInMode` / `TestFormatCompactResultExtendedDetails` / `TestFormatCompactResultSummaryTruncatedToFirstLine` / `TestFormatCharCountHumanFriendly` / `TestFirstLineBoundsAndStripsTrailingNewlines`。`fullContextPayload()` helper 覆盖 sections / budget / compact / auto / long-term / scoped / session memory / recovery / working set / repeated / large 字段。
  - `test/go_tui_pty_driver.py`:
    - 新 `run_context_overlay_sequence`——bash round-trip populate sessionID、approve permission、等 `Bash done` + `done success=true`，然后 `/context` 等 `analyzing shared Nexus context` + `Context · Phase 5 overlay` header，按 `down` / `tab` / `up` 滚动，esc 关 overlay 等 `context closed`。
    - 改 `run_context_and_compact_sequence`：`/context` 现在 assert overlay header（`Context · Phase 5 overlay`）而不是 transcript 面包屑（`context_analysis`）；overlay 用 esc 关掉（`context closed` 状态行）然后 `/compact` 验 `compact_result events:` + `boundary: compact_boundary` + `budget layers:` 三条。
    - orchestrator 顺序不动——但 Phase 5 续的两个序列因 back-to-back permission panel + bubble tea mode switch race 偶发，留在 standalone test（`context-overlay` + `context-and-compact`），orchestrator 跑原 7 序列。
  - `test/go-tui-smoke.test.ts`: 加 `context-overlay` 测试；orchestrator 顺序同步（不含 `context-overlay` / `context-and-compact`）。
  - 范围克制：`/context` overlay 不展开 scoped memory / long-term memory 的 raw diagnostics（每个 scope 一行够用），完整 `contextView` 仍留给 TypeScript TUI 的 `openContextView`；`/compact` 不展开 retained segment 内的具体 event id 列表（boundary event 的 type/code 够用），post-compact state 重建详情留给 chat TUI。
- [x] Phase 8 packaging/distribution early slice：`bbl go` managed Nexus launcher 收口（2026-06-09 收口）。
  - `bbl go` 先构建 Go TUI launch spec，避免 Go TUI binary/source 不存在时误启动 Nexus；随后探活 `GET /health`。
  - localhost / `ws://localhost` URL 不健康时自动启动 `__server` 子进程，并继承 `process.execArgv`，确保开发态 `node --import tsx src/cli/program.ts go` 也能正确拉起 TypeScript server。
  - managed Nexus child 使用 `BABEL_O_WORKSPACE=<cwd>`、URL 推导的 `NEXUS_HOST` / `NEXUS_PORT`，`NEXUS_ALLOWED_TOOLS` 默认取环境变量，未设置时为 `*`；高风险工具仍走现有 permission prompt。
  - `--no-start-nexus` 只连接不启动；远程 URL 不健康时报错，不尝试本地拉起；Go TUI 退出时只关闭本次 wrapper 自己拉起的 child，不影响用户已有 Nexus。
  - `--poll-interval-ms` 已由 wrapper 透传给 Go TUI。
- [x] Phase 6 PR1：SessionChannel `/inbox` overlay + footer unread indicator 收口（2026-06-09 收口）。
  - 数据模型：`SessionChannelKind` / `SessionMessageType` / `SessionMessagePriority` / `SessionMessageStatus` / `SessionChannelStatus` 枚举 + `evidenceRef` / `sessionChannel` / `sessionMessage` / `sessionInboxResponse` 类型；`sessionMessage.Metadata map[string]any` 暴露 governance blob 以便 memory_candidate 走 isKeyInboxMessage 路径。
  - 状态机：`modeInboxOverlay` inputMode 常量 + 模型字段 `inboxMessages` / `inboxChannels` / `inboxOverlaySelected` / `inboxOverlayScroll` / `inboxOverlayIncludeAck` / `seenInboxCardMessageIDs`。
  - HTTP：`fetchInbox(cfg, sessionID, includeAck)` 调 `GET /v1/sessions/:id/inbox?includeAcknowledged=...`；`ackInboxMessage(cfg, sessionID, messageID)` 调 `POST /v1/sessions/:id/inbox/:msgId/ack`；两者都返回 typed msg（`inboxMsg` / `inboxAckMsg`）+ `raw []byte` envelope。复用 `nexusRawJSON` 防止 schema churn 击穿。
  - 渲染：`inboxStyle` (foreground 33) + `formatInboxFooterStatus`（linked sessions / unread / channels / high 段）+ `buildInboxOverlayLines`（每条 message 3-5 行、selected marker）+ `renderInboxOverlay`（与 help / slash palette / profileConfirm 同 viewport 风格，title `Inbox · Phase 6 overlay` / `Inbox · all · Phase 6 overlay`）+ `renderInboxEventCard`（main flow 关键事件卡片，divider 包裹）+ `renderNewInboxEventCards`（按 messageId 去重）。
  - 协议：`isKeyInboxMessage` 复刻 TS `shouldRenderInboxEventCard`——handoff / blocked / request_review / request_validation 总是 key；finding 只在 priority=high 时 key；memory_candidate 在 governance.decision ∈ {rejected, requires_approval} 或 approval.status ∈ {required, rejected} 时 key。
  - slash 命令：替换 `/inbox` placeholder——bare `/inbox` 调 unread-only fetch；`/inbox all` 调 includeAck fetch；`/inbox ack <id>` 直接 POST ack；都先 short-circuit 友好状态行（无 active session 时）。
  - KeyMsg dispatch：`case modeInboxOverlay`——esc/enter/q 关闭 + 清 inboxOverlayScroll / inboxOverlaySelected + 写 `inbox closed` 状态行；up/k 减 selected（clamp 0）；down/j/tab 增 selected（clamp len-1）；`a` 调 `ackSelectedInboxMessage` 触发 ackInboxMessage HTTP；stray key 全部被吞。
  - inboxAckMsg handler：ack 成功后只在本地 snapshot 标 status=acknowledged + acknowledgedAt="now" + 写 `inbox ack: <id>` 状态行（避免强制 re-fetch）。
  - renderFooter：现有 hint 后追加 inbox footer 状态（`linked sessions: N [...]` / `inbox: N unread` / `channels: kind1 N/kind2 M` / `high: <type>`），用 `  · ` 分隔，宽度超限时走 truncatePlain。
  - View()：拼接 inboxOverlay 段在 contextOverlay 之后、input / footer 之前。
  - helpOverlayLines：新增 Inbox overlay 段。
  - 22 个新单测 + 1 个 PTY smoke (`inbox-overlay`) + 1 个 TS smoke 入口守住 envelope 抽取 / decode error / render 隐藏性 / banner 切换 / 选中 clamp / esc/enter/q 关闭 / stray key 不污染 / ack 成功路径 / slash 命令 short-circuit / event card key 判定 / 已渲染去重 / HTTP 真实 wire；123/123 go test 通过；`BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 13/13 pass。
  - 范围克制：自动 inbox refresh on `result` event 留到 Phase 6 PR2；`/inbox` quote into prompt 留到 Phase 6 PR2（避免 overlay ↔ composing round-trip 引入新 race）；PTY smoke 走 empty-inbox 路径（避免依赖 Nexus seed inbox fixture）。
- [x] Phase 6 PR2：`/inbox` quote into prompt + end-of-turn auto-refresh 收口（2026-06-09 收口）。
  - `quoteInboxMessageContent(message) string` 新增：复刻 TS TUI `quoteInboxMessage`（`Use this SessionChannel inbox context only after verifying evidence:` 头 + `message=<id> type=<type> priority=<pri> from=<from> channel=<chan>` 行 + `content: <content>` + 可选 `evidence: ...` + 可选 `memory_candidate <governance>`），所有 required 字段走 `fallbackUnknown` 兜底。
  - `inboxMsg` 加 `trigger string`（`"user"` / `"auto"`）；`fetchInbox(cfg, sessionID, includeAck, trigger)` 加 trigger 参数。
  - `consumeNexusEvent` signature 改 `func (m *model) consumeNexusEvent(event map[string]any) tea.Cmd`；`case "result", "error":` 末尾若 `m.sessionID != ""` 返回 `fetchInbox(m.cfg, m.sessionID, false, "auto")`；call site 改 `tea.Batch(waitForStreamEvent(m.events), eventCmd)`。
  - `case inboxMsg` Update handler：`trigger == "auto"` 路径只调 `renderNewInboxEventCards()`（按 `seenInboxCardMessageIDs` 去重）+ return（不开 overlay、不 push breadcrumb、selection / scroll 不重置）；`"user"` 走原路径。
  - `modeInboxOverlay` KeyMsg dispatch：`q` / `c` 改 quote（之前误归 close）；`quoteSelectedInboxMessage()` 新方法把选中消息的 quote 填进 textinput + `CursorEnd()` + `setMode(modeComposing)` + push `quoted inbox message: <id> into prompt` 状态行 + 保留 `inboxOverlaySelected`（UX 与 TS TUI 一致）。
  - `helpOverlayLines`：`q / c quote into prompt` 段、`esc / enter close` 段。
  - 11 个新 Go 单测 + 1 个 PTY smoke (`inbox-quote`) + 1 个 TS smoke 入口；134/134 go test pass；`BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 14/14 pass。
  - 范围克制：空 list 上的 `q` / `c` 是 no-op（`quoteSelectedInboxMessage` 检查越界则 return nil，textinput 不动、mode 不变）——真实 quote 内容由 Go 单测覆盖。auto-refresh 不输出 breadcrumb，只静默 update snapshot + 渲染新 event card，避免每 turn 结束刷一行。
- [x] Phase 6 PR3：`/agents` 多 agent status overlay + end-of-turn auto-refresh 收口（2026-06-10 收口）。
  - 数据模型：`agentProfileId` / `agentJobStatus` / `contextForkMode` / `agentIsolationMode` 枚举 + `agentJobGovernance` + `agentJob`（jobId / parentSessionId / childSessionId / parentTaskId / agentType / status / prompt / contextForkMode / isolation / createdAt / updatedAt / startedAt / completedAt / governance）+ `sessionAgentJobsResponse`（type / sessionId / jobs）+ `agentJobsMsg`（带 trigger 字段）。
  - 状态机：`modeAgentOverlay` inputMode 常量 + 模型字段 `agentJobs` / `agentOverlayScroll`。
  - HTTP：`fetchSessionAgents(cfg, sessionID, trigger)` 调 `GET /v1/sessions/:id/agents`，保留 raw bytes envelope。
  - end-of-turn auto-refresh：`consumeNexusEvent` 的 `result`/`error` case 改 `return tea.Batch(fetchInbox(..., "auto"), fetchSessionAgents(..., "auto"))`，两路并行静默刷新。
  - 渲染：`agentStyle` (foreground 141) + `formatAgentStatusIcon(status)` 终端友好 marker (`[run]`/`[done]`/`[fail]`/`[perm]`/`[queue]`/`[cancel]`) + `formatAgentGovernanceSummary(*agentJobGovernance)` + `formatAgentJobRow(job)` (status icon + `job` + agentType + `dN` + child=<shortID> + governance + task#<id> + 截断 prompt 第二行) + `buildAgentOverlayLines(jobs)` (空时 `No agent jobs for this session.` placeholder) + `summarizeAgentJobs(jobs)` (running/waiting_permission/queued/failed/cancelled/completed 排序计数) + `renderAgentOverlay(width)` (title `Agent status · Phase 6 PR3 overlay · <shortID>` + divider + clamped window + scroll/close hint)。
  - slash 命令：替换 `/agents` placeholder，`/agents` 调 `fetchSessionAgentsWithSession()`，无 active session 时 short-circuit 友好状态行。
  - KeyMsg dispatch：`case modeAgentOverlay`——esc/enter/q 关闭 + 清 scroll + 写 `agent status closed` 状态行；up/k 减 scroll clamp 0；down/j/tab 增 scroll clamp `len(buildAgentOverlayLines(...))-1`；stray key 全部被吞。
  - case agentJobsMsg Update handler：`trigger == "auto"` 路径只更新 `m.agentJobs` + return；`"user"` 走原路径（reset scroll + push `agents: N job(s)` breadcrumb + `setMode(modeAgentOverlay)`）。
  - helpOverlayLines：新增 `Agent status overlay (Phase 6 PR3):` 段。
  - View()：拼接 `agentOverlay` 段在 `inboxOverlay` 之后、input / footer 之前。
  - 17 个新 Go 单测 + 1 个 PTY smoke (`agent-status`) + 1 个 TS smoke 入口；151/151 go test pass；`BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 15/15 pass。
  - 范围克制：AgentLoop sub-agent 聚合（`task_session_event` stream 中的 subagent lifecycle 事件）留到未来 PR——本次只覆盖 AgentJob REST 端点。ack / cancel 按钮留 CLI（`bbl agents cancel <jobId>`），Go TUI agent overlay 保持只读。transcriptPath 字段省略（TS TUI 也只在 metadata 中展示）。"running sub-agent" 实时 badge 留到未来 PR。
- [x] Phase 4 wire：Go TUI tool palette `/v1/tools/audit` 真实 wire 收口（2026-06-10 收口）。
  - 数据模型：`toolRisk` / `toolSourceType` 枚举 + `toolAuditSource` struct + `runtimeToolAuditEntry`（name / description / risk / allowed / inputSchema / requiresApproval / suggestedAllowRule / mcpServerAllowed / source）+ `toolsAuditResponse` envelope + `toolAuditMsg` typed msg。
  - 状态机：`modeToolAuditOverlay` inputMode 常量 + 模型字段 `toolAuditEntries` / `toolAuditScroll`。
  - HTTP：`fetchToolAudit(cfg, trigger)` 调 `GET /v1/tools/audit`（**全局端点，无 sessionID**），保留 `raw []byte` envelope 抗 schema churn。
  - 静态 fallback：`staticToolDescriptorCatalog()` helper 把原 Phase 4 硬编码 7 条 builtin 列表抽成函数，wire 失败时通过 `renderToolPalette` 推回 transcript 让用户能继续看到 known-good 列表。
  - 渲染：`toolPaletteStyle` (foreground 117) + `formatToolRiskIcon(risk)` (`[read]`/`[write]`/`[execute]`/`[task]`) + `formatToolSourceTag(source)` (builtin / `mcp:<serverName>` / 空 / unknown) + `formatToolApprovalStatus(requiresApproval)` (`no-approval` / `approval-required`) + `formatToolAuditRow(entry)` (风险 + 来源 tag + 审批状态 + name + 截断 description + 可选 MCP server allowed 第二行 + 可选 suggested allow rule 第二行) + `buildToolAuditOverlayLines(entries)` + `summarizeToolAudit(entries)` (execute / write / task / read 排序计数) + `renderToolAuditOverlay(width)` (title `Tools audit · Phase 4 wire overlay` + divider + clamped window + scroll/close hint)。
  - slash 命令：替换 `/tools` placeholder——`/tools` 调 `fetchToolAudit(m.cfg, "user")`；wire 成功打开 overlay；wire 失败时 push `tools audit: <err>` error 行 + 走 static fallback。
  - KeyMsg dispatch：`case modeToolAuditOverlay`——esc/enter/q 关闭 + 清 scroll + 写 `tools audit closed` 状态行；up/k 减 scroll clamp 0；down/j/tab 增 scroll clamp `len-1`；stray key 全部被吞。
  - case toolAuditMsg Update handler：`err != nil` 走 fallback 路径；`trigger == "auto"` 静默 update `m.toolAuditEntries`；`"user"` 走原路径（reset scroll + push breadcrumb + open overlay）。
  - helpOverlayLines：新增 `Tool audit overlay (Phase 4 wire):` 段。
  - View()：拼接 `toolAuditOverlay` 段在 `activityOverlay` 之后、input / footer 之前。
  - 18 个新 Go 单测 + 1 个 PTY smoke (`tools-audit`) + 1 个 TS smoke 入口；`run_tool_palette_sequence` orchestrator 序列升级为 wire 行为（保留在 `all` 里）；203/203 go test pass；`BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 19/19 pass。
  - 范围克制：ack / cancel 按钮（per-tool approval gate、allow-rule editing）留 CLI（`bbl tools policy`），Go TUI 保持只读。`inputSchema` 字段以 `map[string]any` 形式保留在 typed struct 里但不在 overlay 行展示。`/v1/tools/audit` 是全局端点不**走** end-of-turn auto-refresh——audit 是 runtime 视图不是 session 视图。
- [x] Phase 8 剩余：version reporting + prebuilt release pipeline + bbl go --check（2026-06-10 收口）。
  - **PR1 (version reporting)**: Go TUI `--version` / `-v` flag + `versionString()` + `majorVersion()` + `isGoTuiMajorCompatible()`（`clients/go-tui/version.go`）；`Makefile` 嵌入 -ldflags 注入 `Version` / `Commit` / `BuildDate`（`make build` 从 `package.json` + `git rev-parse --short HEAD` + `date -u` 构造）；`config.printVersion` 短路 main()；`runtimeVersionCompat` / `runtimeVersionResponse` / `runtimeVersionMsg` typed msg + `checkRuntimeVersion(cfg)` HTTP command + `Init()` 启动时 fire + `case runtimeVersionMsg` mismatch 警告。Nexus 端：`GET /v1/runtime/version` 返回 `serverVersion`（`readOwnPackageVersion()` helper 从 `package.json` 读）+ `schemaVersion` + `goTuiCompatibility` / `nodeCliCompatibility` 兼容范围（当前 `[0]`，未来 bump 手动维护）。
  - **PR2 (prebuilt release + multi-path discovery)**: `.github/workflows/go-tui-release.yml` triggers on `go-tui-v*` tag push，matrix-builds 5 个目标（darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 / windows-x64.exe），`make build` + `--version` 验证 build metadata + 重命名为 `bbl-go-tui-<os>-<arch>` + 上传 GitHub Release + mirror `dist/go-tui/`。Launcher: `collectGoTuiBinaryCandidates(input)` 6 步搜索（`--binary` / `BABEL_O_GO_TUI_BINARY` / `BABEL_O_GO_TUI_PACKAGE_BINARY` / `<packageRoot>/bin/go-tui-<platform>-<arch>` / `<sourceDir>/bin/go-tui` / XDG user-local）；`createGoTuiLaunchSpec` 改用候选列表迭代；`platformSuffix(platform)` 集中管理 canonical 段；`defaultGoTuiBinaryName(platform)` 保留平台二进制文件名。
  - **PR3 (bbl go --check + clearer errors)**: `bbl go --check` 子命令 + `goTuiCheckReport` 函数：3 块报告（Go TUI launchability / Nexus health / version compat），FAIL exit 1、WARN exit 0（CI 友好）。改进 `child.on('error')` 错误消息：之前只说 "Install Go or build..."，新消息明确指引 prebuilt release 路径。
  - 18 个新单测（8 Go + 2 TS endpoint + 9 launcher + 5 --check = 24，但 8 Go 与 9 launcher 有重叠 = 18 unique）。`go test` 211/211 pass；`npm test` 704/704 pass；`npm run test:go-tui:smoke` 19/19 pass。
  - 范围克制：真实 release 资产需要打 `go-tui-v0.3.2` tag 才会上传（不能本地复现）；XDG user-local install 路径文档化在 install strategy 但 launcher 不自动 mkdir；`bbl go --check` 是非交互式命令不在 TUI 启动时自动跑。
- [x] Phase 9 promotion gate：Go TUI 提升为可选推荐入口（stable alternative to `bbl chat`）（2026-06-10 决策收口）。
  - 决策结论（详见 `docs/nexus/PHASE_9_DECISION.md`）：Go TUI 不再标 "experimental / MVP"，而**提升为 stable alternative**。两 TUI 并存：`bbl chat`（TypeScript）仍为默认；`bbl go`（Go）opt-in。提升条件 5 条全部满足（日常 coding loop usability ≥ TS TUI / 真实长会话改进 / 一个 release 周期无 TTY 回归 / 测试发布维护成本可接受 / 用户能稳定二选一）。
  - 行动项：(1) `src/cli/commands/go.ts` 把 `bbl go` command description 从 "Launch the experimental Go TUI client" 改为 "Launch the Go TUI client (stable alternative to bbl chat; see docs/nexus/PHASE_9_DECISION.md)"（在 `bbl go --help` 展示）；(2) `clients/go-tui/README.md` 去掉 "intentionally does not replace `bbl chat`" 免责，文档化稳定状态；(3) `docs/nexus/reference/go-tui-rewrite-plan.md` Status 改 "Stable alternative (promoted 2026-06-10 via Phase 9)" + 风险表对应行更新；(4) `test/go-command.test.ts` 加回归 guard——`bbl go --help` 必须保持 "stable alternative to bbl chat" 用词且不能回退到 "experimental"（否则 trip smoke step）。
  - 范围克制：默认命令不变（`bbl` 仍启动 `bbl chat`）；不在 Go TUI 里实现 per-tool approval gate（CLI 独占）；Activity overlay 已包含 AgentLoop sub-agent 聚合路径，TS TUI 的 `bbl inbox` footer summary 是同形等价物不需要 cross-port；Go TUI 后续以 bug 修 + 安全补丁 + overlay-stack 改进为主，**不**主动替代 `bbl chat` 为默认。

后续：Phase 1-9 全部收口。BabeL-O Go TUI 长期重写计划闭环。Go TUI 进入 "稳定维护" 阶段——后续若有新交互需求优先落在 `bbl chat`（TypeScript TUI），Go TUI 通过 `bbl go --check` 持续验证 install readiness。

持续边界：

- Go TUI 只通过 Nexus WebSocket/HTTP API 交互。
- 不读取内部 SQLite，不复刻 context manager，不执行工具。
- 不与 Go Remote Runner 合并职责：Go TUI 是客户端，Go Runner 是可选执行后端。
- 默认安装和默认测试不强制要求 Go toolchain。
- §5 路径 C 起的所有配置访问：Go TUI 只通过 Nexus 暴露的 HTTP API 拿到 config profile/active/model 视图，并且只通过受限 `POST /v1/runtime/config/select` 切换已有 profile；不允许 Go TUI 读取本地 `ConfigManager` 私有字段，也不复制 `ConfigManager` 的 schema 决策。

## P1 `/model` 模型持久化

> Phase 1 设计上 `/model` Step 4 是 in-memory only——`m.modelID` 立刻切、但 `bbl go` 重启即丢失，操作员必须切回 `bbl config use` 或 `bbl chat /model` 才能落盘。`clients/go-tui/internal/tui/tui.go:2135-2144` Step 4 Enter 分支的 status 行文案 `"model writeback is CLI-only in Phase 1; run bbl config use ... to persist"` 自证这是设计边界而不是 bug。
>
> 详细规划见 [Go TUI `/model` 模型持久化规划](../reference/go-tui-model-persistence-plan.md)。本节是该 reference doc 在 active TODO 的同步桩，承载状态变迁与 watch 触发条件。

### 计划切片

- [ ] Phase 1：Nexus 协议层
  - 改 `src/nexus/app.ts:765` handler 拆三态（`{profile}` 走 `setActiveProfile` / `{model}` 走 `setDefaultModel` / 互斥 400 `mutually_exclusive` / 缺字段 400 `missing_field` / 未知 model 400 `unknown_model`）；role / roleModel 仍 `not_supported`。
  - 改 `test/config-endpoints.test.ts` 既有 `rejects model / role switching (CLI-only)` 改为只验 role / roleModel，新增 5 条测试（`missing_field` / `mutually_exclusive` / `switches default model and persists` / `model switch preserves an active profile binding` / `rejects unknown model with 400`）。
  - 验证：`npx tsc --noEmit` 干净 + `node --import tsx --test test/config-endpoints.test.ts` 22/22。
- [ ] Phase 2：TUI 客户端
  - `clients/go-tui/internal/tui/tui.go` 加 `modelSelectMsg` typed struct + `selectRuntimeModel(cfg, modelID) tea.Cmd` + `modelPickSubmitting bool` in-flight 锁字段。
  - 改 Step 4 Enter 分支：进入 in-flight 态（esc 仍允许退 step） + dispatch `selectRuntimeModel` + 打印 `saving model:` status。
  - 加 `case modelSelectMsg` Update handler：err 路径留 picker + 清 submitting + 报错；ok 路径 `applyRuntimeConfig` + 打印 `model saved:` + 重置 picker 临时态 + `setMode(modeComposing)`。
  - 改 `renderModelPickModel` 加 saving 态渲染（spinner + "saving model…"）。
  - 加 3 个 Go 单测：`TestModelPickStep4EnterFiresSelectCommand` / `TestModelSelectMsgAppliesConfigAndClosesPicker` / `TestModelSelectMsgErrorStaysInPicker`。
  - 验证：`go test ./...` 154+/154+、`go vet ./...` 干净、重编 binary。
- [ ] Phase 3：PTY smoke（可选）
  - `test/go_tui_pty_driver.py` 新 `run_model_persistence_sequence`：bash echo 触发 `session_started` → `/model` → 选 provider → 选 model → 等 `model saved:` → 重启 TUI → 验 header modelId 是新选的。
  - 需 pre-seed `BABEL_O_CONFIG_FILE` 让 default model 与新选不同（避免 no-op 假阳性）。
- [ ] Phase 4：收口入库
  - `docs/nexus/DONE.md` 写收口条目（commit hash + 文件列表 + 测试覆盖 + 验证命令）。
  - 同步本节到"已收口"，把 `P1 /model 模型持久化` 段落从 active TODO 移除 / 折叠到"已收口 P1 列表"。
  - 同步 `docs/nexus/reference/go-tui-model-persistence-plan.md` Status 行 → "Phase 1+2+3 全部已落地（治理收口）"。

### UX Caveat（已写明在 reference doc §7，本节作为 watch 触发条件）

`ConfigManager.resolveSettings()` 链：`profile.model > env > role > defaultModel > 'local/coding-runtime'`。当操作员存在 active profile 且 `profile.model` 与 Step 4 选的不一致时，`setDefaultModel` 写入**不**生效于下一个 turn 的 provider call —— server 仍用 `profile.model`。TUI 下一次 `fetchRuntimeConfig` poll 会回 `modelId: <profile.model>`，header 文字会从"刚选的新模型"退回"profile 锁住的模型"。

收口底线：本切片**不**做 y/n overlay 询问是否清 active profile、**不**改 `resolveSettings()` 优先级、**不**自动清 active profile。操作员通过 transcript `model saved:` 状态行 + 下次 poll 回的 `modelId` 自我理解现状。若此 UX 阻断被真实会话标为 P0，则**另起**reference doc 讨论 `model saved + active profile cleared` y/n overlay 切片，不在本规划内增量。

### 触发条件

按以下任一条件重新打开实现项：

- 真实会话或 PTY smoke 暴露 `/model` 切完 model 但下一次 turn 仍用旧 model 致 user-facing confusion
- 多个用户复现"重启 `bbl go` model 不保留"，且 `bbl config use` 不在 workflow 内的吐槽
- 收到 `bbl config use` ↔ `bbl go /model` 之间的等价性需求（用户希望两边切换路径完全一致）

触发时不重新设计，沿本规划 + reference doc 推进；若 reference doc 边界需要扩（如包含 api-key / base-URL 持久化），按本 reference doc 12 节"另起姊妹 doc"规则处理，不在本 doc 增量。

### 与已有边界的兼容

- 不动 §5 路径 C 阶段 2 已收口的 `setActiveProfile` 路径
- 不动 `bbl chat` / `bbl config use` 既有行为；新协议路径与 CLI 路径语义完全等价（`setDefaultModel` 已被 `bbl config use` 使用）
- 不触碰 `babel-o-auto-model-selection-delayed.md` / `feedback-provider-quota-priority.md` 既定 delay 项
- 持续边界（上方 bullet 列表）字面不动；本切片只新增 `config/select` 接受 `model` 字段，与 `profile` 路径同属受限端点

## 验证命令

历史验证覆盖：renderer/input/permission/paste/PTY 基线，slash palette、permission panel、compact Read、input placeholder、read/edit/diff/Grep/Glob/TaskCreate、resume session、paste/input，ask coding question about files，task update/status，sub-agent / AgentLoop，唯一输入框键盘路由，tool picker / model wizard overlay routing，agent running terminal states，MCP tool audit / permission display，history search overlay ownership，长路径/CJK/ANSI/resize 宽度，stale wrapped rows，LSP context mention，file attachment references，image reference metadata，opt-in vim mode，以及 sub-agent running + model/context gauge 组合。

## 参考文件

- `src/cli/commands/chat.ts`
- `src/cli/inputBox.ts`
- `src/cli/pasteBuffer.ts`
- `src/cli/renderEvents.ts`
- `src/cli/ui.ts`
- `test/tui-input.test.ts`
- `test/tui-pty-smoke.test.ts`
- `test/tui_pty_driver.py`
