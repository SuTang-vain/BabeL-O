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
- [ ] 尚未有 slash command。
- [ ] 尚未有 history search。
- [x] 尚未有权限确认 UI。
- [ ] 尚未有 diff UI。

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
- [ ] Ctrl-C graceful cancellation。
- [ ] session id display + resume hint。
- [ ] prettier JSON/status formatting。

## P1 Programming Workflow Parity

- [ ] `/help`。
- [ ] `/clear`。
- [ ] `/exit`。
- [ ] `/model`。
- [ ] `/status`。
- [ ] `/sessions`。
- [ ] 优化 embedded mode 下的存储生命周期，允许本地 cli chat 在不启动 Nexus 守护进程的情况下，使用 SQLite 数据库实现多轮会话恢复。
- [ ] file path completion。
- [ ] slash command completion。
- [ ] command history。
- [ ] history search。
- [ ] diff rendering for Edit/Write。
- [x] permission approve/deny prompt。
- [ ] task/Todo status panel。
- [ ] model/profile switching。
- [ ] MCP tool/resource display。

## P2 Advanced CLI/TUI

- [ ] 使用 Ink 或轻量 terminal renderer 重建高级交互。
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
