# Nexus Reference Docs

本目录保留仍有架构约束价值的长期参考文档。它们不是当前 TODO 的唯一事实源；当前优先级以 [../TODO.md](../TODO.md) 和 [../active/](../active/) 为准。

## 文档

- [context-and-subagent-upgrade-plan.md](./context-and-subagent-upgrade-plan.md): Context Manager、ContextForker 与模型可见 AgentScheduler 架构参考。
- [context-management-optimization-plan.md](./context-management-optimization-plan.md): 基于 BabeL-2 上下文管理机制复盘与 BabeL-O 真实 session `session_661479db-6327-46f2-a793-7b88e0431174` 的上下文管理优化规划；聚焦 runtime-owned context facts、microcompact-first、compact boundary protocol、provider context-limit recovery 与 Go TUI 可见性。
- [tool-granularity-and-evidence-governance-plan.md](./tool-granularity-and-evidence-governance-plan.md): 工具粒度、证据语义与 Agent tool 命名治理。
- [workspace-path-drift-governance-plan.md](./workspace-path-drift-governance-plan.md): workspace path drift、连续路径失败恢复与证据降级治理。
- [session-finalization-and-evidence-governance-plan.md](./session-finalization-and-evidence-governance-plan.md): current-turn session finalization 污染修复与 evidence-scope drift 轻量治理样本。
- [session-to-session-memory-channel-plan.md](./session-to-session-memory-channel-plan.md): Session-to-Session typed channel、Scoped Memory 与 Inbox 架构参考。
- [go-runner-plan.md](./go-runner-plan.md): 可选 Go `RemoteToolRunner` 执行后端参考。
- [go-tui-rewrite-plan.md](./go-tui-rewrite-plan.md): `bbl go` / Go TUI 长期实验重写规划；Go 只作为交互客户端，不拥有 Nexus/runtime/context/permission。
- [go-tui-permission-policy-governance-plan.md](./go-tui-permission-policy-governance-plan.md): Bash 在 `denyByDefaultTools()` 下 hard-deny 跳过 `permission_request` 致 Go TUI 权限面板缺位的治理规划。Phase A — Bash read-only subcommand 自动放行（`src/tools/builtin/bashClassifier.ts` 纯函数分类器 + 30+ 危险 pattern 二次校验）；Phase B — `policy: 'soft-deny'` per-request override 组合；Phase C — 端到端 mock provider regression（含 `result`/`error` 不重置 mode 的 bug 修复）；Phase D — Go TUI `--allow-tools` flag（power-user opt-in，per-turn allowlist override）。四 Phase 全部收口，726 TS tests + Go TUI tests 全过。
- [go-tui-session-observability-governance-plan.md](./go-tui-session-observability-governance-plan.md): Go TUI session 可观测性 / Embedded Nexus 持久化治理规划。基于 `session_go_1781146359507755000` 复盘失败的真实样本：session ID 双轨命名（`session_go_<unixnano>` 客户端 vs `session_<uuid>` 服务端）+ embedded Nexus 走 `MemoryStorage` 进程退出即丢 + 无 session-start 日志。当前源码核对状态：Phase 0 `bbl inspect-session` 已收口；Phase 1 server UUID payload 与本地 client→server 映射日志部分落地；Phase 2 生产默认 SQLite 部分落地；Phase 3 Nexus startup log 与 client-log reverse-resolve 部分落地；Phase 4 跨文档同步与 PTY/e2e 守门仍需补齐。
- [task-adaptive-recoverable-timeout-plan.md](./task-adaptive-recoverable-timeout-plan.md): Task-adaptive recoverable timeout 规划；基于 `session_791b10ce-0d41-409d-b2de-1e5d14eb19b3`，将普通 timeout 从 fatal request cutoff 拆成模型可见 soft deadline 与系统兜底 hard watchdog。
- [go-tui-markdown-rendering-optimization-plan.md](./go-tui-markdown-rendering-optimization-plan.md): Go TUI transcript Markdown 渲染优化规划；对照 Crush 的 Glamour + Chroma + Lip Gloss 链路，建议 assistant-only renderer façade、compile spike、代码块高亮与 benchmark gate 渐进落地。

## 维护规则

- 已完成实现事实移入 [../DONE.md](../DONE.md)。
- 未收口任务写入 [../active/](../active/) 下对应 TODO。
- 本目录只保留设计边界、非目标、安全口径和未来扩展条件。
