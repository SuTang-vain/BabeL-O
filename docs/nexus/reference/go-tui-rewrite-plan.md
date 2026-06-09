# Go TUI Long-Term Rewrite Plan

> Status: P3 / Long-term experimental track
> Current baseline: `clients/go-tui/` MVP + `bbl go` launcher + manual Nexus/WebSocket permission smoke
> Production default: TypeScript `bbl chat`

## 目标

Go TUI 重写不是把 BabeL-O 改写成 Go 项目，也不是替代 Nexus-first 架构。它的目标是验证并逐步建设一个更稳定、更易做终端布局、更适合长会话交互的独立 TUI 客户端：

```text
TypeScript Nexus owns execution, runtime, context, storage, agent orchestration and permission decisions.
Go TUI owns terminal interaction, layout, keyboard routing and local rendering.
```

长期目标是让 `bbl go` 成为可选高质量交互前端，在真实编程会话中提供：

- 更稳定的终端布局、viewport、输入框和 overlay 组合。
- 更清晰的 agent/tool/permission/context/session-channel 分层展示。
- 更可靠的 PTY 视觉回归测试。
- 更低的交互层复杂度，把 Node readline/raw mode 渲染压力从 TypeScript TUI 主线中剥离。

## 当前基线

截至 2026-06-09，已落地最小可行基线：

- `clients/go-tui/` 使用 Bubble Tea / Bubbles / Lip Gloss / gorilla/websocket。
- `bbl go` 入口已接入 CLI；优先运行本地 `clients/go-tui/go-tui` 二进制，缺失时 fallback 到 `go run .`。
- Go TUI 通过 Nexus `/v1/stream` WebSocket 发送 prompt，接收 `NexusEvent`。
- 支持 permission request：`a/y` approve，`r/n/esc` reject。
- MVP 界面具备 header、transcript、input line、footer、permission panel。
- `assistant_delta` / `thinking_delta` 会合并成连续 transcript 行。
- `tool_completed` 会展示 Bash stdout/stderr/exitCode 摘要。
- `hook_started` / `hook_completed` / `hook_failed` 会展示摘要，不裸渲染 hook JSON。
- 已手动 smoke：`local/coding-runtime` + `Bash: {"command":"node -e \"console.log('go-tui-smoke')\""}`，覆盖输入、permission_request、permission_response、Bash 执行、result 展示。

该基线只证明 Go TUI 作为 Nexus 客户端可行；尚未达到替代 `bbl chat` 的标准。

## 非目标

Go TUI 长期重写明确不做以下事情：

- 不迁移 TypeScript Nexus server。
- 不迁移 provider adapter、context manager、compact、token estimator、AgentScheduler、AgentLoop、storage 或 permission classifier。
- 不让 Go TUI 直接执行工具；工具执行仍走 Nexus runtime / RemoteToolRunner。
- 不让 Go TUI 成为 session/event/tool trace 事实源。
- 不把 Go TUI 与 Go Remote Runner 合并成同一进程职责。
- 不因为 Go TUI 存在而降低现有 `bbl chat` 的质量门槛。
- 不在默认测试/安装路径中强制要求 Go toolchain，除非未来正式切换分发策略。

## 架构边界

```text
┌──────────────────────────────┐
│ bbl go / Go TUI               │
│ - terminal layout             │
│ - keyboard routing            │
│ - prompt input                │
│ - event rendering             │
│ - permission UI               │
└──────────────┬───────────────┘
               │ WebSocket / HTTP Nexus API
┌──────────────▼───────────────┐
│ TypeScript Nexus              │
│ - session lifecycle           │
│ - runtime execution           │
│ - context assembly/compact    │
│ - permission registry         │
│ - storage/event/tool traces   │
│ - AgentScheduler/AgentLoop    │
└──────────────┬───────────────┘
               │ tool execution boundary
┌──────────────▼───────────────┐
│ Tools / optional runners      │
│ - built-in tools              │
│ - MCP tools                   │
│ - optional Go RemoteRunner    │
└──────────────────────────────┘
```

Go TUI 只消费 stable `NexusEvent` 与 Nexus HTTP/WebSocket API。若 TUI 需要新能力，应优先补 Nexus API / event schema，而不是在 Go TUI 中读取内部 SQLite 或复刻 runtime 逻辑。

## 与现有 TypeScript TUI 的关系

`bbl chat` 继续是生产默认入口。Go TUI 是长期实验轨道，只有满足以下条件才考虑提升为正式候选：

- 核心编程 loop parity 达标。
- PTY/visual smoke 覆盖不低于 TypeScript TUI 当前关键路径。
- 对 SessionChannel、AgentLoop、context diagnostics、permission panel 等高级状态有明确 UI 表达。
- 安装、构建、发布不会显著增加默认用户负担。
- 真实长会话中观察到 Go TUI 明显降低输入/渲染漂移、减少键盘路由冲突或改善状态可见性。

## 分阶段计划

### Phase 0 — MVP Baseline

状态：已落地。

范围：

- `clients/go-tui/` 独立 Go module。
- `bbl go` CLI 入口。
- WebSocket stream prompt / event / permission response。
- Header + transcript + input + footer + permission panel。
- 手动真实 smoke 覆盖权限审批链路。

继续保留：

- `go test ./...`
- `go build .`
- `node bin/bbl.js go --help`
- `npm run format:check`
- `npm run typecheck`

### Phase 1 — 可选 Go TUI Smoke Harness

目标：把手动 smoke 固化成可重复、默认关闭的测试入口。

任务：

- 新增 `test:go-tui:smoke` 或脚本入口，默认跳过。
- 使用临时 Nexus 端口、临时 config、`local/coding-runtime`、内存 storage。
- 通过 PTY 驱动 `bbl go --no-alt` 输入 Bash prompt。
- 自动等待 permission panel，发送 `a`，验证 transcript 中出现：
  - `Permission: Bash`
  - `permit approved=true`
  - `tool ok Bash done success=true stdout="go-tui-smoke"`
  - `done success=true`
- 退出 TUI 并确保临时 Nexus 进程清理。
- CI 默认不启用，使用 `BABEL_O_RUN_GO_TUI_SMOKE=1` 显式开启。

收口标准：

- smoke 可稳定在 macOS/Linux PTY 中运行。
- 失败时输出可读 transcript。
- 不依赖外部 provider API key。
- 不引入默认 Go toolchain 要求。

### Phase 2 — Event Renderer Parity

目标：Go TUI 对主要 `NexusEvent` 的显示能力达到 TypeScript TUI 的可读性基线。

任务：

- 完整梳理 `src/shared/events.ts` 的事件类型。
- 为 Go TUI 建立事件分类表：
  - session/user/assistant/thinking
  - tool lifecycle
  - permission lifecycle
  - hooks
  - context warning/blocking/compact
  - task session events
  - agent job events
  - provider recovery/fallback
  - SessionChannel inbox/key cards
  - execution metrics/usage
- 引入 compact/expanded rendering 模式：
  - 默认 transcript 显示摘要。
  - 支持展开单条 tool/hook/context details。
- 增加宽度约束、CJK、ANSI、长路径、多行 wrapping 的测试。

收口标准：

- Go TUI 不再裸渲染重要 JSON。
- 关键事件都有稳定 label、summary 和可测试 snapshot。
- 与 TypeScript `renderEvents.ts` 的重要语义保持一致，但不要求完全相同视觉风格。

### Phase 3 — Input Owner / Overlay System

目标：建立 Go TUI 自己的唯一输入所有者模型，解决 slash palette、permission panel、history、tool picker 等交互冲突。

任务：

- 定义 input state machine：
  - composing
  - slashPalette
  - toolPalette
  - permissionPanel
  - historySearch
  - contextOverlay
  - inboxOverlay
  - helpOverlay
- 所有 overlay 共享明确键盘路由：
  - Enter
  - Esc
  - Backspace
  - Tab
  - ↑/↓
  - PageUp/PageDown
  - Ctrl+C
- 确保 slash palette 打开后不会出现多个输入框。
- slash/tool/history overlay 关闭后恢复同一个 input model。
- paste/multiline/Shift+Enter 的行为与 TypeScript TUI 对齐或明确差异。

收口标准：

- 单测覆盖 state transitions。
- PTY smoke 覆盖 slash palette 与 permission panel 互斥。
- 不再出现“进入下拉列表后输入框重复/无法 Esc/Backspace 退出”类回归。

### Phase 4 — Slash Commands / Tool Palette / Model UX

目标：让 Go TUI 具备实际日常使用所需的命令发现与操作入口。

任务：

- `/help`
- `/clear`
- `/exit`
- `/context`
- `/compact`
- `/inbox`
- `/models`
- `/tools`
- `/sessions`
- `/agents`
- `/bash` / `/read` / `/grep` / `/glob` / `/write` / `/edit` prefix insertion
- Tool palette 显示风险等级、source、approval requirement。
- Model/config wizard 暂不复刻完整 TypeScript 交互；优先提供只读显示与跳转提示。

收口标准：

- 常用 slash commands 可发现、可补全、可执行或给出明确“暂未支持”提示。
- 不绕过 Nexus API。
- 不在 Go TUI 内直接写 config，除非后续补独立 config mutation API 和确认 UI。

### Phase 5 — Context / Compact / Long Session UX

目标：Go TUI 能成为长会话调试入口，而不只是聊天窗口。

任务：

- 显示 context warning/blocking：
  - tokenEstimate
  - maxTokens
  - percentUsed
  - blockingLimit
  - cache preserving / long-context mode
- `/context` 调用 Nexus context API 并展示分层表格：
  - system prompt
  - session summary
  - compact boundary
  - recent events
  - tools/MCP schema budget
  - scoped memory diagnostics
- `/compact` 调用现有 Nexus compact 入口或复用 CLI API。
- compact 后 transcript 展示 boundary marker。
- 对 provider max output / context-window recovery event 提供明确提示。

收口标准：

- 长会话不再只靠 provider error 才知道超上下文。
- Go TUI 能展示 compact 前后关键状态。
- 不在 Go 端自行估 token；只展示 Nexus diagnostics。

### Phase 6 — Agent / Task / SessionChannel Views

目标：把 Go TUI 的优势用于复杂状态可视化。

任务：

- Agent status panel：
  - parent/child session
  - taskId
  - agent role
  - depth
  - status
  - delegatedSubTaskIds
- Task board：
  - pending/in_progress/blocked/completed/failed
  - worktree state
  - review/recovery actions
- SessionChannel:
  - unread indicator
  - `/inbox` overlay
  - key event cards
  - parent-child tree / relationship view
- Activity overlay：
  - recent tool runs
  - permission decisions
  - agent job events
  - context warnings

收口标准：

- Go TUI 至少达到现有 TypeScript TUI 的 SessionChannel consumption-side 能力。
- 不实现 raw transcript sharing。
- 不把其他 session message 当作当前用户直接输入。
- 所有跨 session 操作必须保留 review/quote/manual-submit 边界。

### Phase 7 — PTY / Visual Regression Harness

目标：建立 Go TUI 专属视觉回归体系，并减少交互层回归成本。

任务：

- 复用或扩展 `test/tui_pty_driver.py`。
- 为 `bbl go` 增加独立 PTY driver fixture。
- 覆盖：
  - launch/help
  - simple assistant response
  - Bash permission approve/deny
  - slash palette navigation
  - history search
  - context warning
  - tool output wrapping
  - CJK / long path / narrow resize
  - inbox overlay
  - agent running status
- 输出 cleaned transcript 和 raw terminal trace。

收口标准：

- 默认不启用慢 PTY smoke。
- 显式启用时可复现真实 TTY 视觉问题。
- 新 UI 状态必须补对应 fixture。

### Phase 8 — Packaging / Distribution

目标：在不破坏当前 Node/SEA 发布路径的前提下，探索 Go TUI 的安装体验。

任务：

- 明确 `bbl go` 在不同安装形态下的行为：
  - source checkout
  - npm package
  - standalone Node SEA binary
  - future prebuilt Go binary
- 不把本机 `clients/go-tui/go-tui` 直接提交仓库。
- 评估 release asset：
  - `bbl-go-tui-darwin-arm64`
  - `bbl-go-tui-linux-x64`
  - `bbl-go-tui-linux-arm64`
- `bbl go` 可优先查找：
  - explicit `--binary`
  - package-bundled binary
  - source fallback `go run .`
- 若默认用户没有 Go toolchain，错误提示必须清晰。

收口标准：

- 默认安装不因为缺 Go toolchain 失败。
- 发布包体积可控。
- Node CLI 与 Go TUI 的版本兼容策略明确。

### Phase 9 — Promotion Gate

目标：决定 Go TUI 是否从实验入口提升为正式候选。

提升条件：

- 日常 coding loop 可用性超过或等于 TypeScript TUI。
- 真实长会话中显著改善输入框、overlay、权限、agent 状态和工具展示体验。
- 至少一个 release 周期内没有严重 TTY 回归。
- Go TUI 的测试/发布维护成本可接受。
- 用户可以稳定通过 `bbl chat` 与 `bbl go` 二选一，不造成文档和支持混乱。

可能结论：

- 保持实验入口：`bbl go` 作为 advanced opt-in。
- 提升为可选推荐入口：文档推荐复杂 TUI 用户尝试。
- 提升为默认入口候选：需要另开迁移 RFC。
- 停止推进：若维护成本高于收益，保留 `clients/go-tui` 为研究样本或归档。

## 风险与治理

| 风险 | 影响 | 治理 |
| --- | --- | --- |
| 双 TUI 维护成本升高 | 两套交互路径分叉 | Go TUI 先作为 P3 experimental；promotion 前必须证明收益 |
| Event schema drift | Go TUI 显示落后于 Nexus | 建立 event renderer parity tests 与 smoke |
| 权限 UI 与 Nexus registry 不一致 | 用户误以为审批成功/失败 | 权限决策只通过 Nexus WebSocket/API；Go 只发送 user decision |
| 默认安装要求 Go | 用户安装失败 | Go smoke 默认 opt-in；发布策略不强制 Go toolchain |
| Go TUI 复刻 runtime 逻辑 | 破坏 Nexus-first | 文档与代码边界禁止 Go 读取 storage/runtime internals |
| 与 Go Runner 混淆 | 执行层和交互层职责混乱 | Go TUI = client；Go Runner = optional RemoteToolRunner backend |

## TODO 挂载口径

- 总控入口：`docs/nexus/TODO.md` 标记为 P3 / Long-term Go TUI。
- 细节承接：`docs/nexus/active/TODO_tui.md`。
- 本文件只维护长期设计边界、阶段计划和 promotion gate。
- 具体实现完成后，事实写入 `WORK_LOG.md`，完成能力移入 `DONE.md`。

## 下一步建议

短期只建议推进 Phase 1：

1. 新增 `BABEL_O_RUN_GO_TUI_SMOKE=1` gated smoke。
2. 固化当前手动验证过的 local Nexus + Bash permission approve 链路。
3. 不继续扩大功能面，先让 smoke 能守住现有 MVP。

Phase 1 稳定后，再进入 Phase 2 event renderer parity。不要在没有 smoke 的情况下继续扩大 slash/overlay 功能，否则会复制 TypeScript TUI 早期的键盘路由复杂度。
