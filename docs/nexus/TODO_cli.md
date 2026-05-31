# TODO CLI / TUI 兼容入口

> 本文件不作为主规划源。它只保留 CLI 相关主题的导航入口，避免后续把 CLI、Runtime、Provider 和 Agent 任务混写在同一个文件里。

## 新文档入口

- 总控规划：[TODO.md](./TODO.md)
- CLI / TUI 体验：[TODO_tui.md](./TODO_tui.md)
- Runtime / Nexus 运维 CLI：[TODO_runtime.md](./TODO_runtime.md)
- Provider / Model Registry：[TODO_provider_registry.md](./TODO_provider_registry.md)
- TaskSession / Agents：[TODO_agents.md](./TODO_agents.md)
- Cleanup / Decoupling：[TODO_cleanup.md](./TODO_cleanup.md)
- Performance：[TODO_performance.md](./TODO_performance.md)
- 已完成能力索引：[DONE.md](./DONE.md)
- 工作记录：[WORK_LOG.md](./WORK_LOG.md)

## CLI 相关内容归属

| 主题 | 维护位置 |
| --- | --- |
| `bbl chat`、交互输入、slash command、history、diff、权限确认 | [TODO_tui.md](./TODO_tui.md) |
| `bbl nexus start/status`、HTTP/WS API、sessions/tasks endpoint | [TODO_runtime.md](./TODO_runtime.md) |
| `bbl run`、embedded mode、service mode client 行为 | [TODO_tui.md](./TODO_tui.md) 与 [TODO_runtime.md](./TODO_runtime.md) |
| `bbl config`、`bbl models`、provider profile | [TODO_provider_registry.md](./TODO_provider_registry.md) |
| AgentLoop、TaskQueue、Planner/Executor/Critic | [TODO_agents.md](./TODO_agents.md) |
| 依赖治理、命名、BabeL-X 遗留隔离 | [TODO_cleanup.md](./TODO_cleanup.md) |

## 迁移状态

- [x] CLI 已采用 Commander。
- [x] `run` 支持 embedded mode 和 `--url` service mode。
- [x] `chat` 支持最小 readline 交互。
- [x] `nexus start/status` 已可用。
- [x] `sessions list/show` 已可用。
- [x] `sessions resume/cancel` 已可用。
- [x] `nexus start --storage-path` 已可用。
- [x] `config add/use/list` 已实现。
- [x] `models list/inspect` 已实现。
- [x] slash command 已实现，主清单维护在 [TODO_tui.md](./TODO_tui.md)。
- [x] 权限确认 UI 已实现，主清单维护在 [TODO_tui.md](./TODO_tui.md)。

## 维护规则

- 不向本文件追加具体任务。
- 新任务按主题写入对应子 TODO。
- 已完成事实写入 [WORK_LOG.md](./WORK_LOG.md)，已完成能力索引移入 [DONE.md](./DONE.md)。
