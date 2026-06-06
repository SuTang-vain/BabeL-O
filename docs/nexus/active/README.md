# Nexus Active TODO

本目录只维护仍会影响近期开发优先级的专项 TODO。总控顺序见 [../TODO.md](../TODO.md)，完成能力索引见 [../DONE.md](../DONE.md)，事实流水见 [../WORK_LOG.md](../WORK_LOG.md)。

## 文档

- [TODO_runtime.md](./TODO_runtime.md): Runtime、Nexus API、storage、security、context、compact、MCP、skills、permissions。
- [TODO_agents.md](./TODO_agents.md): TaskSession、TaskQueue、AgentLoop、Planner/Executor/Critic、sub-agent、worktree。
- [TODO_provider_registry.md](./TODO_provider_registry.md): Provider registry、adapter、role routing、model capability matrix。
- [TODO_tui.md](./TODO_tui.md): `bbl chat`、输入框、slash/tool palette、permission panel、事件渲染。
- [TODO_performance.md](./TODO_performance.md): benchmark、metrics、storage/API 性能、故障注入、并发治理。
- [TODO_cleanup.md](./TODO_cleanup.md): 依赖治理、BabeL-X 迁入规则、build/CI/lint/coverage。

## 维护规则

- 只保留未收口项、watch 项和真实回归守门项。
- 已完成能力移动到 [../DONE.md](../DONE.md)，不要在 active TODO 中堆 `[x]` 历史。
- 长期架构边界放入 [../reference/](../reference/)，历史专项放入 [../archive/](../archive/)。
