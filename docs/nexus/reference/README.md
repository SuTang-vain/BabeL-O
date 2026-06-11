# Nexus Reference Docs

本目录保留仍有架构约束价值的长期参考文档。它们不是当前 TODO 的唯一事实源；当前优先级以 [../TODO.md](../TODO.md) 和 [../active/](../active/) 为准。

## 文档

- [context-and-subagent-upgrade-plan.md](./context-and-subagent-upgrade-plan.md): Context Manager、ContextForker 与模型可见 AgentScheduler 架构参考。
- [tool-granularity-and-evidence-governance-plan.md](./tool-granularity-and-evidence-governance-plan.md): 工具粒度、证据语义与 Agent tool 命名治理。
- [workspace-path-drift-governance-plan.md](./workspace-path-drift-governance-plan.md): workspace path drift、连续路径失败恢复与证据降级治理。
- [session-finalization-and-evidence-governance-plan.md](./session-finalization-and-evidence-governance-plan.md): current-turn session finalization 污染修复与 evidence-scope drift 轻量治理样本。
- [session-to-session-memory-channel-plan.md](./session-to-session-memory-channel-plan.md): Session-to-Session typed channel、Scoped Memory 与 Inbox 架构参考。
- [go-runner-plan.md](./go-runner-plan.md): 可选 Go `RemoteToolRunner` 执行后端参考。
- [go-tui-rewrite-plan.md](./go-tui-rewrite-plan.md): `bbl go` / Go TUI 长期实验重写规划；Go 只作为交互客户端，不拥有 Nexus/runtime/context/permission。
- [go-tui-execute-timeout-governance-plan.md](./go-tui-execute-timeout-governance-plan.md): Go TUI WebSocket 请求未覆盖 `timeoutMs` 撞 Nexus 30s 默认导致 `REQUEST_TIMEOUT` 的治理规划；推荐 Go TUI per-request `timeoutMs` 修复。
- [go-tui-permission-policy-governance-plan.md](./go-tui-permission-policy-governance-plan.md): Bash 在 `denyByDefaultTools()` 下 hard-deny 跳过 `permission_request` 致 Go TUI 权限面板缺位的治理规划；推荐 read-only subcommand 自动放行 + `policy: 'soft-deny'` per-request override 组合。
- [go-tui-model-persistence-plan.md](./go-tui-model-persistence-plan.md): Go TUI `/model` Step 4 提交在 Phase 1 仍是 in-memory only（重启 `bbl go` 即丢失），需在 `POST /v1/runtime/config/select` 接受 `model` 字段并扩展 TUI 端 Step 4 state machine。

## 维护规则

- 已完成实现事实移入 [../DONE.md](../DONE.md)。
- 未收口任务写入 [../active/](../active/) 下对应 TODO。
- 本目录只保留设计边界、非目标、安全口径和未来扩展条件。
