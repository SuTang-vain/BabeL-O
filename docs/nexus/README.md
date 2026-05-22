# BabeL-O Nexus 文档库

这里是 BabeL-O 的 Nexus-first 重写规划中心。

BabeL-O 的目标不是复制 BabeL-X 的历史包袱，而是在新目录中保留 BabeL-X 出色的编程能力和 CLI 交互体验，同时让 Nexus 成为真正的执行核心。

## 文档入口

- [总控规划](./TODO.md)
- [Runtime / Nexus](./TODO_runtime.md)
- [TaskSession / Agents](./TODO_agents.md)
- [Provider / Model Registry](./TODO_provider_registry.md)
- [CLI / TUI Experience](./TODO_tui.md)
- [Cleanup / Decoupling](./TODO_cleanup.md)
- [Performance Hardening](./TODO_performance.md)
- [CLI 兼容入口](./TODO_cli.md)
- [工作记录](./WORK_LOG.md)

## 当前实现状态

当前项目已经有第一版可运行骨架：

- Fastify Nexus API
- Commander CLI
- embedded `run` / `chat`
- service `nexus start/status`
- sessions `list/show`
- in-memory session storage
- Runtime facade
- 基础工具：Read / Write / Edit / Bash / Grep / Glob / TaskCreate
- `npm run typecheck` 与 `npm test` 已通过

## 维护规则

- 总控 `TODO.md` 只维护阶段、优先级和链接。
- 每条主线只在对应子 TODO 中维护细节。
- `WORK_LOG.md` 只追加事实、验证和重要决策。
- 任何“已完成”状态必须能对应到代码、文档或命令验证。
