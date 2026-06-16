# Nexus Reference Docs

本目录保留仍有架构约束价值的长期参考文档。它们不是当前 TODO 的唯一事实源；当前优先级以 [../TODO.md](../TODO.md) 和 [../active/](../active/) 为准。

## 文档

- [context-and-subagent-upgrade-plan.md](./context-and-subagent-upgrade-plan.md): Context Manager、ContextForker 与模型可见 AgentScheduler 架构参考。
- [context-management-optimization-plan.md](./context-management-optimization-plan.md): 基于 BabeL-2 上下文管理机制复盘与 BabeL-O 真实 session `session_661479db-6327-46f2-a793-7b88e0431174` 的上下文管理优化规划；聚焦 runtime-owned context facts、microcompact-first、compact boundary protocol、provider context-limit recovery 与 Go TUI 可见性。
- [tool-granularity-and-evidence-governance-plan.md](./tool-granularity-and-evidence-governance-plan.md): 工具粒度、证据语义与 Agent tool 命名治理。
- [task-scope-and-evidence-scope-governance-plan.md](./task-scope-and-evidence-scope-governance-plan.md): task scope / evidence scope 治理；防止 read-only 工具把 sibling repo、历史 session path 或 memory hit 自动当作本轮任务证据。
- [workspace-path-drift-governance-plan.md](./workspace-path-drift-governance-plan.md): workspace path drift、连续路径失败恢复与证据降级治理。
- [session-finalization-and-evidence-governance-plan.md](./session-finalization-and-evidence-governance-plan.md): current-turn session finalization 污染修复与 evidence-scope drift 轻量治理样本。
- [session-replay-and-evidence-governance-plan.md](./session-replay-and-evidence-governance-plan.md): 基于 `session_315814e7-3b82-4a31-8601-a5b383288e9c` 的 provider replay、Read evidence coverage、line/byte range、intent target 与 self-diagnosis 综合治理规划。
- [session-to-session-memory-channel-plan.md](./session-to-session-memory-channel-plan.md): Session-to-Session typed channel、Scoped Memory 与 Inbox 架构参考。
- [memory-capability-awareness-and-trigger-plan.md](./memory-capability-awareness-and-trigger-plan.md): Memory capability awareness、自触发 memory_search / memory_save_note 与写入治理规划。
- [skill-execution-and-automated-normalized-skill-generation-governance-plan.md](./skill-execution-and-automated-normalized-skill-generation-governance-plan.md): Skill 显式执行、可观测性、schema normalization、自动生成草稿与人工确认保存的长期治理规划；明确现有 skill 是 prompt-context module，不是任意脚本执行或权限绕过机制。
- [behavior-monitor.md](./behavior-monitor.md): 行为监控草案；规划 behavior trace、跨 session drift/loop monitor 与用户意图跟随诊断，不替代 session/event/tool trace、memory 或 compact 事实源。
- [long-running-context-assembly.md](./long-running-context-assembly.md): 长任务上下文组装草案；规划 Nexus-owned working set、resume pack 与 context assembly API，不代表 `context.search` / `WorkingSetTracker` 已在源码落地。
- [intent-guidance-and-prompt-governance-optimization-plan.md](./intent-guidance-and-prompt-governance-optimization-plan.md): 基于 `session_b2e5660a-2669-4aec-a4a7-73ed65ed1f8e` 的 intent guidance / prompt governance 优化规划；核心原则是禁止事故特定硬编码提示词注入，用语义规则 predicate、结构化 Turn Policy、最小稳定提示词和真实 session regression 区分 pure capability question 与 current-state availability check。
- [fable-prompt-architecture-reference-governance-plan.md](./fable-prompt-architecture-reference-governance-plan.md): 以 `/Users/tangyaoyue/DEV/BABEL/CLAUDE-FABLE-5.md` 为架构参考的 BabeL-O prompt governance 规划；只吸收 section 化、capability contract、current-state verification、tool boundary、external action 与 skill trigger 等设计方法，不复制 Claude Web / Artifacts / antml / `/mnt/user-data` 等不兼容内容。
- [evercore-lifecycle-cache-and-answer-governance-plan.md](./evercore-lifecycle-cache-and-answer-governance-plan.md): EverCore managed sidecar 按需拉起、缓存复用、idle TTL、`/memory` 管理面板与记忆能力问答不泄露内通的治理规划。
- [tool-surface-expansion-and-native-mcp-coexistence-plan.md](./tool-surface-expansion-and-native-mcp-coexistence-plan.md): Plan-only 工具面扩展草案；规划 native tools、MCP coexistence、Plan/HITL tool surface 与 governance，不等同于源码已注册这些工具。
- [tool-governance-reference-integration.md](./tool-governance-reference-integration.md): 工具治理参考整合索引；把 tool granularity、evidence scope、tool surface expansion 三条规划串成一致的边界说明。
- [go-runner-plan.md](./go-runner-plan.md): 可选 Go `RemoteToolRunner` 执行后端参考。
- [go-tui-rewrite-plan.md](./go-tui-rewrite-plan.md): `bbl go` / Go TUI 长期实验重写规划；Go 只作为交互客户端，不拥有 Nexus/runtime/context/permission。
- [go-tui-loop-multipane-plan.md](./go-tui-loop-multipane-plan.md): 借鉴 [ogulcancelik/herdr](https://github.com/ogulcancelik/herdr) 的 workspace/tab/pane + wait-event + persist snapshot 形态，新增 `bbl loop` 多 session pane TUI 入口的长期规划；不复制 herdr 的 IPC/multiplexer 责任，只复用 API 形态，不引入新的 runtime truth。
- [go-tui-permission-policy-governance-plan.md](./go-tui-permission-policy-governance-plan.md): Bash 在 `denyByDefaultTools()` 下 hard-deny 跳过 `permission_request` 致 Go TUI 权限面板缺位的治理规划。Phase A — Bash read-only subcommand 自动放行（`src/tools/builtin/bashClassifier.ts` 纯函数分类器 + 30+ 危险 pattern 二次校验）；Phase B — `policy: 'soft-deny'` per-request override 组合；Phase C — 端到端 mock provider regression（含 `result`/`error` 不重置 mode 的 bug 修复）；Phase D — Go TUI `--allow-tools` flag（power-user opt-in，per-turn allowlist override）。四 Phase 全部收口，726 TS tests + Go TUI tests 全过。
- [go-tui-session-observability-governance-plan.md](./go-tui-session-observability-governance-plan.md): Go TUI session 可观测性 / Embedded Nexus 持久化治理规划。基于 `session_go_1781146359507755000` 复盘失败的真实样本：session ID 双轨命名（`session_go_<unixnano>` 客户端 vs `session_<uuid>` 服务端）+ embedded Nexus 走 `MemoryStorage` 进程退出即丢 + 无 session-start 日志。当前源码核对状态：Phase 0 `bbl inspect-session` 已收口；Phase 1 server UUID payload 与本地 client→server 映射日志部分落地；Phase 2 生产默认 SQLite 部分落地；Phase 3 Nexus startup log 与 client-log reverse-resolve 部分落地；Phase 4 跨文档同步与 PTY/e2e 守门仍需补齐。
- [task-adaptive-recoverable-timeout-plan.md](./task-adaptive-recoverable-timeout-plan.md): Task-adaptive recoverable timeout 规划；基于 `session_791b10ce-0d41-409d-b2de-1e5d14eb19b3`，将普通 timeout 从 fatal request cutoff 拆成模型可见 soft deadline 与系统兜底 hard watchdog。
- [go-tui-markdown-rendering-optimization-plan.md](./go-tui-markdown-rendering-optimization-plan.md): Go TUI transcript Markdown 渲染优化规划；对照 Crush 的 Glamour + Chroma + Lip Gloss 链路，建议 assistant-only renderer façade、compile spike、代码块高亮与 benchmark gate 渐进落地。
- [go-tui-selection-highlight-optimization-plan.md](./go-tui-selection-highlight-optimization-plan.md): Go TUI `--mouse` 文本选区高亮与剪贴板复制优化记录；已用窄范围 ultraviolet cell-buffer highlight 收口“实际选中但视觉未高亮/不覆盖”的问题。
- [distribution-guide.md](./distribution-guide.md): 分发操作指导；说明 v0.3.5+ lightweight portable package、`install.sh`、GitHub release assets、安装自检、发版清单与常见启动问题排查。
- [distribution-strategy-plan.md](./distribution-strategy-plan.md): 分发策略规划；当前以 `bbl-<platform>.tar.gz` portable 包降低体积并避开 Node SEA 主路径，中期补 npm 普通 Node wrapper + Go TUI asset 下载，长期将生产 launcher 迁移到 Go launcher。

## 维护规则

- 已完成实现事实移入 [../DONE.md](../DONE.md)。
- 未收口任务写入 [../active/](../active/) 下对应 TODO。
- 本目录只保留设计边界、非目标、安全口径和未来扩展条件。
