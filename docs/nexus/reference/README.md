# Nexus Reference Docs

本目录保留仍有架构约束价值的长期参考文档。它们不是当前 TODO 的唯一事实源；当前优先级以 [../TODO.md](../TODO.md) 和 [../active/](../active/) 为准。

## 文档

- [context-and-subagent-upgrade-plan.md](./context-and-subagent-upgrade-plan.md): Context Manager、ContextForker 与模型可见 AgentScheduler 架构参考。
- [tool-granularity-and-evidence-governance-plan.md](./tool-granularity-and-evidence-governance-plan.md): 工具粒度、证据语义与 Agent tool 命名治理。
- [workspace-path-drift-governance-plan.md](./workspace-path-drift-governance-plan.md): workspace path drift、连续路径失败恢复与证据降级治理。
- [session-finalization-and-evidence-governance-plan.md](./session-finalization-and-evidence-governance-plan.md): current-turn session finalization 污染修复与 evidence-scope drift 轻量治理样本。
- [session-to-session-memory-channel-plan.md](./session-to-session-memory-channel-plan.md): Session-to-Session typed channel、Scoped Memory 与 Inbox 架构参考。
- [go-runner-plan.md](./go-runner-plan.md): 可选 Go `RemoteToolRunner` 执行后端参考。

## 维护规则

- 已完成实现事实移入 [../DONE.md](../DONE.md)。
- 未收口任务写入 [../active/](../active/) 下对应 TODO。
- 本目录只保留设计边界、非目标、安全口径和未来扩展条件。
