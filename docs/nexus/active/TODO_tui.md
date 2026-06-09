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
- `bbl go` 已接入 CLI，优先运行本地 Go TUI binary，缺失时 fallback 到 `go run .`。
- MVP 已具备 header、transcript、bottom input、footer、permission panel 与 layered event rendering。
- 已手动完成 local Nexus + WebSocket + `permission_request` / `permission_response` / Bash tool / result smoke；transcript 可显示 `stdout="go-tui-smoke"`。

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

后续：

- Phase 3 Input owner / overlay state machine。
- Phase 4 slash/tool palette / model UX。
- Phase 5 context/compact 长会话 UX。
- Phase 6 Agent/Task/SessionChannel views。
- Phase 7 Go TUI PTY/visual regression harness（建议补：加 `input` 行的 PTY smoke 守住权限面板 UX 改进不回归）。
- Phase 8 packaging/distribution。
- Phase 9 promotion gate。

后续只有 Phase 1 稳定后才推进：

- Phase 2 Event renderer parity。
- Phase 3 Input owner / overlay state machine。
- Phase 4 slash/tool palette。
- Phase 5 context/compact long-session UX。
- Phase 6 Agent/Task/SessionChannel views。
- Phase 7 Go TUI PTY/visual regression harness。
- Phase 8 packaging/distribution。
- Phase 9 promotion gate。

持续边界：

- Go TUI 只通过 Nexus WebSocket/HTTP API 交互。
- 不读取内部 SQLite，不复刻 context manager，不执行工具。
- 不与 Go Remote Runner 合并职责：Go TUI 是客户端，Go Runner 是可选执行后端。
- 默认安装和默认测试不强制要求 Go toolchain。

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
