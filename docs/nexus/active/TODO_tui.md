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

## P3 / Long-term Go TUI Rewrite

> 详细规划见 [Go TUI Long-Term Rewrite Plan](../reference/go-tui-rewrite-plan.md)。Go TUI 是长期实验交互客户端，不替代当前生产默认 `bbl chat`，不拥有 Nexus/runtime/context/AgentScheduler/provider/storage/permission 决策。

当前状态：

- `clients/go-tui/` 已落地 Bubble Tea MVP。
- `bbl go` 已接入 CLI，优先运行本地 Go TUI binary，缺失时 fallback 到 `go run .`；wrapper 会先探活 `GET /health`，本地 URL 不健康时自动拉起 managed Nexus child，远程 URL 或 `--no-start-nexus` 只连接不启动。
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

后续只有 Phase 1 / Phase 2 / §5 路径 C 阶段 1-3 / §5 path C 阶段 3 polish y/n overlay / Phase 3 / Phase 4 / Phase 5 / Phase 5 续 / Phase 6 PR1 / Phase 6 PR2 / Phase 7 / Phase 8 稳定后才推进：

- Phase 6 PR3：Agent status panel（parent/child + taskId + role + depth + status + delegatedSubTaskIds）。
- Phase 6 PR4：Task board（pending/in_progress/blocked/completed/failed + worktree state + review/recovery）。
- Phase 6 PR5：Activity overlay（recent tool runs / permission decisions / agent job events / context warnings）。
- Go TUI tool palette `/v1/tools/audit` 真实 wire（Phase 4 静态目录的下一阶段）。
- Phase 8 packaging/distribution 剩余项：预编译 binary 发布、版本兼容矩阵、安装包策略。
- Phase 9 promotion gate。

持续边界：

- Go TUI 只通过 Nexus WebSocket/HTTP API 交互。
- 不读取内部 SQLite，不复刻 context manager，不执行工具。
- 不与 Go Remote Runner 合并职责：Go TUI 是客户端，Go Runner 是可选执行后端。
- 默认安装和默认测试不强制要求 Go toolchain。
- §5 路径 C 起的所有配置访问：Go TUI 只通过 Nexus 暴露的 HTTP API 拿到 config profile/active/model 视图，并且只通过受限 `POST /v1/runtime/config/select` 切换已有 profile；不允许 Go TUI 读取本地 `ConfigManager` 私有字段，也不复制 `ConfigManager` 的 schema 决策。

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
