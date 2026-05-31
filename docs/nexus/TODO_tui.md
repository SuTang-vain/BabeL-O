# TODO CLI / TUI Experience

## 目标

BabeL-O 的 CLI 必须保留 BabeL-X 出色的编程交互能力。轻量化不等于简陋；CLI 不拥有 runtime，但必须是一等交互客户端。本文只保留 `bbl chat`、输入框、slash/tool palette、权限交互、事件渲染和 PTY smoke 未收口项。已完成交互能力见 [DONE.md](./DONE.md)。

## 当前状态

- `bbl run/chat/nexus/sessions/tools/config/models`、embedded/service mode、slash palette、tool palette、history、model wizard、permission panel、diff、context/compact、agent running indicator、层级事件渲染、唯一 input owner、paste placeholder、PTY 基线均已落地。
- 当前风险不在“是否有 TUI”，而在编程闭环是否被真实 PTY smoke 持续守住：文件问答、task update/status、AgentLoop/sub-agent、MCP tool/resource display 和视觉回归仍需补齐。

## P1 Programming Loop Smoke

- [ ] ask coding question about files。
  - PTY 中让模型读取临时 repo 文件并回答具体问题。
  - 断言模型使用正确文件内容，不被旧会话、错误路径或 provider protocol 文本带偏。
- [ ] update/status task。
  - 当前 local chat 只有 `task <title>` -> `TaskCreate` 可测入口。
  - 需要新增 TUI/local command，或改走 service/API smoke 并在 TUI 中能展示 task status/update 结果。
- [ ] run sub-agent / AgentLoop。
  - 在 PTY 或 CLI smoke 中覆盖 `bbl optimize --provider-smoke-live`/mock AgentLoop 输出层级。
  - 断言 parent blocked、child created/running/completed、depth、parentTaskId、transcript 引用可见。

## P1 Visual / Keyboard Regression

- [ ] 输入框唯一性截图/smoke。
  - overlay 打开、slash palette、tool palette、history search、model wizard、permission panel、agent running、工具运行时均只显示一个待输入框。
  - Backspace/Esc/Tab/Enter/↑/↓ 路由必须互斥，不得回到双输入框或重复插入命令。
- [ ] agent running indicator smoke。
  - 覆盖模型思考、工具运行、等待权限、compact、retrying、子 Agent running、done/failed。
  - 不改变原有 `● Bash running/done` 工具状态，只额外提供 agent 当前状态。
- [ ] 终端视觉回归扩展。
  - 长路径、CJK、ANSI、resize、粘贴、多行输入、工具完成原地替换、history redraw 都需要持续覆盖。

## P1 MCP / Tool Discoverability

- [ ] MCP tool/resource display。
  - 在 `/tool` 或 `/status` 中展示 MCP server、tool/resource 名称、风险等级、来源、enabled/disabled 状态。
  - 展示 MCP 工具时不能把 provider raw schema 塞入主对话；需要 compact summary + 可展开详情。
- [ ] MCP audit 与 permission panel 对齐。
  - MCP tool 的 risk classification、requiresApproval、suggested allow rule、server identity 要能进入 permission panel 和 audit event。

## P2 Advanced CLI/TUI

- [ ] vim mode。
- [ ] image paste / file attachment references。
- [ ] LSP context picker。
- [ ] worktree flow。
- [ ] multi-agent status view。
- [ ] prompt suggestions。
- [ ] theme / brand polish。

这些高级项排在 P1 live smoke、SDK task mutation API、provider role defaults/fallback 和 TUI 编程闭环 smoke 之后。

## 验证命令

- [x] `npm test` 中的 renderer/input/permission/paste/PTY 基线。
- [x] 最小 PTY smoke：slash palette、permission panel、compact Read、input placeholder、read/edit/diff/Grep/Glob/TaskCreate、resume session、paste/input。
- [ ] PTY ask coding question about files。
- [ ] task update/status smoke。
- [ ] run sub-agent / AgentLoop smoke。
- [ ] 唯一输入框截图/smoke。
- [ ] agent running indicator smoke。

## 参考文件

- `src/cli/commands/chat.ts`
- `src/cli/inputBox.ts`
- `src/cli/pasteBuffer.ts`
- `src/cli/renderEvents.ts`
- `src/cli/ui.ts`
- `test/tui-input.test.ts`
- `test/tui-pty-smoke.test.ts`
- `test/tui_pty_driver.py`
