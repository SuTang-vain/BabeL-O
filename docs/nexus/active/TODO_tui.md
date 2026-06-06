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

当前 P2 Advanced CLI/TUI 已无打开功能项；后续只在真实显示回归、PTy smoke drift 或新增交互状态时重新开未收口项。provider role defaults/fallback 仍按总控无限期 delay，不作为当前 TUI 前置项。

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
