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
- [go-tui-permission-policy-governance-plan.md](./go-tui-permission-policy-governance-plan.md): Bash 在 `denyByDefaultTools()` 下 hard-deny 跳过 `permission_request` 致 Go TUI 权限面板缺位的治理规划。Phase A — Bash read-only subcommand 自动放行（`src/tools/builtin/bashClassifier.ts` 纯函数分类器 + 30+ 危险 pattern 二次校验）；Phase B — `policy: 'soft-deny'` per-request override 组合；Phase C — 端到端 mock provider regression（含 `result`/`error` 不重置 mode 的 bug 修复）；Phase D — Go TUI `--allow-tools` flag（power-user opt-in，per-turn allowlist override）。四 Phase 全部收口，726 TS tests + Go TUI tests 全过。
- [go-tui-session-observability-governance-plan.md](./go-tui-session-observability-governance-plan.md): Go TUI session 可观测性 / Embedded Nexus 持久化治理规划。基于 `session_go_1781146359507755000` 复盘失败的真实样本：session ID 双轨命名（`session_go_<unixnano>` 客户端 vs `session_<uuid>` 服务端）+ embedded Nexus 走 `MemoryStorage` 进程退出即丢 + 无 session-start 日志。Phase 0 文档守门 + `bbl inspect-session` 工具；Phase 1 session ID 命名统一；Phase 2 embedded Nexus 默认持久化到 `~/.babel-o/db.sqlite`；Phase 3 session-start 日志与端到端映射；Phase 4 文档与守门标准同步。

## 维护规则

- 已完成实现事实移入 [../DONE.md](../DONE.md)。
- 未收口任务写入 [../active/](../active/) 下对应 TODO。
- 本目录只保留设计边界、非目标、安全口径和未来扩展条件。
