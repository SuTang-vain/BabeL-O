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
- [ ] task/Todo status panel。
- [ ] model/profile switching。
- [ ] MCP tool/resource display。

## P2 Advanced CLI/TUI

- [x] 使用轻量 terminal renderer 重建高级交互第一版。
- [x] 参考 BabeL-X 的输入底栏、候选列表、工具块和 agent 状态流完成 lightweight TUI 第二版。
- [x] 参考 Claude/Gemini CLI 的层级输出完成 lightweight TUI 第三版：用户输入、Thought、工具调用、权限和 assistant 回复分块显示。
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
- [ ] ask coding question about files。
- [ ] edit file and render diff。
- [x] deny risky command and continue。
- [x] approve risky command once and continue。
- [ ] use Grep/Glob on a real repo。
- [ ] create/update task。
- [ ] resume session。
- [ ] run sub-agent / AgentLoop。

## 参考文件

- `src/cli/program.ts`
- `src/cli/NexusClient.ts`
- `src/cli/renderEvents.ts`
- `src/cli/embedded.ts`
