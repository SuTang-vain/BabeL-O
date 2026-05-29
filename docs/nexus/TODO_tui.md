# TODO CLI / TUI Experience

## 目标

BabeL-O 的 CLI 必须保留 BabeL-X 出色的编程交互能力。轻量化不等于简陋；CLI 不拥有 runtime，但必须是一等交互客户端。

## 当前状态

- [x] `bbl run` 已可用。
- [x] `bbl run --url` 已可用。
- [x] `bbl chat` 已可用。
- [x] `bbl nexus start/status` 已可用。
- [x] `bbl sessions list/show` 已可用。
- [x] `bbl sessions resume/cancel` 已可用。
- [x] `bbl tools audit` 已可用。
- [x] `bbl config add/use/list` 已可用。
- [x] `bbl models list/inspect` 已可用。
- [x] `chat` 当前为 readline 交互。
- [x] 已支持 slash command。
- [x] 已支持 history search。
- [x] 已支持多级权限确认 UI（本地 embedded chat 会进入可上下选择的 approval panel，支持 approve once / approve for session / reject / reject with instruction；默认 service runtime 仍保持 deny-by-default，需要通过 `--allowed-tools`/`NEXUS_ALLOWED_TOOLS` 显式开放可询问工具）。
- [x] 已支持 diff UI。
- [x] 已支持 compact / expanded 双模式 TUI 渲染。
- [x] 已支持交互式补全候选菜单与快捷工具别名转换（如 /read -> read ）。
- [x] 已支持 `/` slash command palette：输入 `/` 即展示命令下拉列表，支持上下导航与 Tab 完成。
- [x] 已支持 `/tool` 工具选择面板（带工具类别和用途说明，方向键选择，Enter 插入执行）。
- [x] 已支持 agent/model 状态行、工具运行状态块和 agent task session event 渲染。
- [x] 已支持类 Claude/Gemini 的块状层级渲染：`▸ Thought`、`● Tool(...)`、`⏺ assistant`，并修复执行阶段输入重复回显。
- [x] 已支持输入框唯一 owner 与 overlay 互斥，slash/tool palette、permission panel、history search、agent running 不再渲染第二个输入框。
- [x] 已支持 slash/tool palette 键盘互斥路由，进入候选列表后 ↑/↓ 只切换候选，Backspace/Esc 可退出且不误批准。
- [x] 已支持 agent running indicator 与工具块分离，能独立提示模型思考、等待权限、compact、retrying 和子 Agent running。
- [x] 已完成 TUI 显示稳定性优化：ANSI/CJK 宽度计算、welcome card 对齐、spinner 清理、assistant streaming 合并、工具状态残影修复。
- [x] 已完成固定输入框第一版：长路径输入使用单行 viewport 截断，autosuggestion 仅在可容纳时显示，避免自动换行和重复 prompt。
- [x] 已恢复终端原生滚动：chat 启动时保持 mouse tracking disabled，wheel/touchpad 不再被 TUI 捕获。
- [x] 已简化 compact 工具状态显示：Read/Write/Edit 只显示路径，Bash 只显示命令摘要，隐藏 `path`/`timeoutMs`/`maxBytes` 等原始参数名。
- [x] 已支持 live 工具状态原地更新：工具完成时在同一行替换为 `done/failed`，不再额外追加一条完成行。
- [x] 已去重 compact 展开提示：`ctrl+o to expand tool details` 最多显示一次，不再挂在每条工具记录后。

## P0 Interaction Baseline

- [x] start a multi-turn chat loop。
- [x] one-shot `run`。
- [x] embedded mode。
- [x] service mode client。
- [x] tool call rendering。
- [x] tool result rendering。
- [x] streaming assistant delta rendering。
- [x] thinking delta rendering。
- [x] clean exit via `exit` / `quit` / `/exit`。
- [x] Ctrl-C graceful cancellation。
- [x] session id display + resume hint。
- [x] prettier JSON/status formatting。

## P1 Programming Workflow Parity

- [x] `/help`。
- [x] `/clear`。
- [x] `/exit`。
- [x] `/model` 交互式配置向导（支持 Provider -> API Key -> Base URL -> Model ID 连贯交互流程，并支持空密钥保留及自定义 Base URL 清除）。
- [x] `/status`。
- [x] `/sessions`。
- [x] `/tool` 工具选择面板。
- [x] 优化 embedded mode 下的存储生命周期，允许本地 cli chat 在不启动 Nexus 守护进程的情况下，使用 SQLite 数据库实现多轮会话恢复。
- [x] file path completion。
- [x] slash command completion。
- [x] slash command dropdown palette。
- [x] command history。
- [x] history search。
- [x] diff rendering for Edit/Write。
- [x] permission approval panel（包含工具名、风险级别、命令摘要、一次批准、会话级批准、拒绝和带说明拒绝）。
- [x] task/Todo status panel。
- [x] model/profile switching。
- [ ] MCP tool/resource display。

## P2 Advanced CLI/TUI

- [x] 使用轻量 terminal renderer 重建高级交互第一版。
- [x] 参考 BabeL-X 的输入底栏、候选列表、工具块和 agent 状态流完成 lightweight TUI 第二版。
- [x] 参考 Claude/Gemini CLI 的层级输出完成 lightweight TUI 第三版：用户输入、Thought、工具调用、权限和 assistant 回复分块显示。
- [x] 参考 BabeL-X `PromptInput` 状态分层完成第一版收口：新增 `inputState` 统一记录 `slashPalette`、`toolPalette`、`permissionPanel`、`historySearch`、`modelWizard`、`agentRunning` 等互斥模式，避免方向键/Tab/Esc/Backspace 在常见路径互相抢占。
- [x] 输入框保持唯一 owner：任何 overlay 打开时不再渲染第二个输入框；overlay 只在输入框上方渲染候选内容，当前输入内容继续留在主输入框中。
- [x] slash palette 键盘路由：进入 `/` 下拉后，↑/↓ 只移动候选，不触发历史浏览；Backspace 删除 `/` 后自动关闭 palette；Esc 关闭 palette 并保留当前输入。
- [x] slash/tool palette 自动填充：候选移动时可预览，不重复插入；Tab/Enter 才确认插入命令或工具 prefix；避免 `/clear`、`/edit` 等多次回显。
- [x] 权限 approval panel 升级为多级选项：Approve once、Approve for session、Approve with editable rule、Reject、Reject with instruction；支持 ↑/↓ 选择、Enter 确认、Esc 拒绝、Backspace 退出输入模式。已修复新增 editable rule 后 Esc 误选第三项导致批准的安全回归。
- [x] Bash permission panel 展示 suggested allow rule：如 `npm run:*`、`git diff:*`，允许用户编辑 prefix 后批准；session cache 已按工具名+规则前缀匹配，避免 `Bash:npm test:*` 泛化批准所有 Bash 命令。
- [x] Agent running indicator 独立于工具块：保留原有 `● Bash running/done` 等工具状态，同时增加“agent running / waiting permission / waiting user / compacting / retrying”的动态状态提示。
- [x] 子 Agent/Task status view：展示 parent blocked、child created/claimed/running/completed、depth、parentTaskId、delegatedSubTaskIds、worktree 标识和 transcript 引用。
- [x] Context warning / compact UI：当 runtime 产出 context warning 时，在 footer 或状态行展示剩余比例与 `/compact` 建议；执行 compact 时显示 compacting/done/failed。
- [x] 长工具输出折叠：默认展示工具名、目标路径/命令摘要、exitCode 和前几行 stderr/stdout；支持通过 compact/expanded 切换查看完整详情，compact 模式不重复展示展开提示。
- [x] 消息层级继续统一：用户输入、assistant 文本、thought、tool started/completed、permission request、hook event、agent task event 使用稳定图标/缩进，不让 provider 原始 JSON 混入主对话。
- [x] 工具状态行显示收口：live 模式下工具完成原地替换同一行，history redraw 中 completed tool 覆盖 running state，避免 Read/Bash 成对重复行和残留 running 文案。
- [ ] vim mode。
- [ ] image paste / file attachment references。
- [ ] LSP context picker。
- [ ] worktree flow。
- [ ] multi-agent status view。
- [ ] prompt suggestions。
- [ ] theme / brand polish。

## CLI 命令规划

- [x] `bbl run <prompt...>`
- [x] `bbl chat`
- [x] `bbl nexus start`
- [x] `bbl nexus status`
- [x] `bbl sessions list`
- [x] `bbl sessions show <id>`
- [x] `bbl sessions events <id>`
- [x] `bbl sessions resume <id>`
- [x] `bbl sessions cancel <id>`
- [x] `bbl tools audit`
- [x] `bbl config add`
- [x] `bbl config use`
- [x] `bbl config list`
- [x] `bbl models list`
- [x] `bbl models inspect <provider/model>`

## 编程能力基线测试

- [x] `run "read README.md"`
- [x] `run --url ... "bash pwd"`
- [x] compact / expanded renderer 单元测试。
- [x] TUI renderer/input 回归：工具参数摘要、工具完成原地更新、展开提示去重、assistant delta 合并、固定输入框、ANSI/CJK 宽度均有单元覆盖。
- [ ] ask coding question about files。
- [ ] edit file and render diff。
- [x] deny risky command and continue。
- [x] approve risky command once and continue。
- [ ] use Grep/Glob on a real repo。
- [ ] create/update task。
- [ ] resume session。
- [ ] run sub-agent / AgentLoop。
- [x] slash palette 键盘冲突回归测试：`/` 后 ↑/↓ 不触发 history，Esc 关闭，Backspace 删除 `/` 后关闭。
- [x] permission panel 多级选项单元回归：dialog 覆盖 once/session/editable rule/reject/reject feedback 展示，并验证 session rule 只匹配已批准 Bash 前缀。
- [ ] permission panel PTY 回归：once/session/reject/reject feedback/editable rule 的真实键盘路径均可完成，Esc/Backspace 不会误批准。
- [ ] 输入框唯一性截图/smoke：overlay 打开、权限弹窗、agent running、工具运行时均只显示一个待输入框。
- [ ] agent running indicator smoke：模型思考、工具运行、等待权限、compact、子 Agent running 均有状态提示。

## 参考文件

- `src/cli/program.ts`
- `src/cli/NexusClient.ts`
- `src/cli/renderEvents.ts`
- `src/cli/embedded.ts`
