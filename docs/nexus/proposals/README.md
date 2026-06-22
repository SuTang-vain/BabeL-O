# Nexus Proposals

> State: Index
> Governance: This directory stores draft and partially landed plans that are not yet stable long-lived references.

This directory holds work that is still being shaped, partially implemented, or waiting for stronger evidence. A proposal may graduate into `reference/`, be summarized into `history/`, or move to `archive/`.

## Current Proposals

| Proposal | State | Scope |
| --- | --- | --- |
| *adaptive-context-window-selection-plan.md (graduated 2026-06-22)* | *was Partially Landed* | *moved to [../reference/adaptive-context-window-selection-plan.md](../reference/adaptive-context-window-selection-plan.md) as `Active Plan` (Phase 0/1/2/3 closed against `session_cd42cb65` + `session_75d74b74`). Per [../decisions/0001-documentation-lifecycle.md](../decisions/0001-documentation-lifecycle.md) §Decision, reference holds durable architecture, not "the next stage after proposals".* |
| [behavior-monitor.md](./behavior-monitor.md) | Partially Landed | Behavior trace, monitor, live hint projection, and Go loop visualization follow-up. |
| *context-search-algorithm-robustness-plan.md (graduated 2026-06-21)* | *was Partially Landed* | *moved to [../reference/context-search-algorithm-robustness-plan.md](../reference/context-search-algorithm-robustness-plan.md) as `Active Plan` (Phase 0/1 closed against `session_06308b17`; Phase 2 CJK bigram gated). Per [../decisions/0001-documentation-lifecycle.md](../decisions/0001-documentation-lifecycle.md) §Decision, reference holds durable architecture, not "the next stage after proposals".* |
| [context-selection-dead-code-and-threshold-dedup-plan.md](./context-selection-dead-code-and-threshold-dedup-plan.md) | Draft | Remove unused context-selection scoring scaffold in `contextManager.ts`; unify warning/compact/blocking threshold computation to one source. (Architecture review P1-5.) |
| [daemon-graceful-shutdown-and-orphan-reaper-plan.md](./daemon-graceful-shutdown-and-orphan-reaper-plan.md) | Draft | SIGTERM/SIGINT graceful shutdown with `storage.close()` flush, plus startup orphan reaper for stale `executing` sessions / `running` agent jobs. (Architecture review P0-1.) |
| [fable-prompt-architecture-reference-governance-plan.md](./fable-prompt-architecture-reference-governance-plan.md) | Draft | External prompt architecture reference, without importing incompatible product assumptions. |
| [go-runner-plan.md](./go-runner-plan.md) | Partially Landed | Optional Go RemoteToolRunner phases and runner boundaries. |
| [go-tui-markdown-rendering-optimization-plan.md](./go-tui-markdown-rendering-optimization-plan.md) | Draft | Gradual Markdown rendering upgrade path for Go TUI transcript readability. |
| [go-tui-session-observability-governance-plan.md](./go-tui-session-observability-governance-plan.md) | Partially Landed | Embedded Nexus persistence and session inspectability gaps for Go TUI. |
| [intent-guidance-and-prompt-governance-optimization-plan.md](./intent-guidance-and-prompt-governance-optimization-plan.md) | Partially Landed | Intent guidance, deterministic policy normalization, and prompt-governance guardrails. |
| *layer-direction-audit-enforcement-plan.md (adopted as long-lived reference 2026-06-21)* | *was Draft* | *moved to [../reference/layer-direction-audit-enforcement-plan.md](../reference/layer-direction-audit-enforcement-plan.md) as `Active Plan`. Per [../decisions/0001-documentation-lifecycle.md](../decisions/0001-documentation-lifecycle.md) §Decision, reference holds durable architecture, not "the next stage after proposals".* |
| [provider-recovery-and-model-catalog-governance-plan.md](./provider-recovery-and-model-catalog-governance-plan.md) | Draft | Trim/implement `providerRecovery` fallback per error kind; resolve "user_config > builtin > undeclared" catalog rule; make BabeL-X model auto-switch explicit/opt-in. (Architecture review P2-8.) |
| [provider-tools-mcp-hygiene-plan.md](./provider-tools-mcp-hygiene-plan.md) | Draft | Extract provider-specific adapter hooks (MiniMax/DeepSeek), shared text-delta chunker, remove dead `list_dir` key, lazy MCP registration. (Architecture review P2-10.) |
| [provider-stream-silent-hang-abort-propagation-plan.md](./provider-stream-silent-hang-abort-propagation-plan.md) | Partially Landed | P0 core closed: Phase 1-3 fixed provider reader abort propagation, single-source watchdog, and `activeAgeMs`; Phase 4-6 fixed Nexus iterator abort race, reasoning-only pre-PostInvocation settlement, Go TUI backend-loss settlement, and startup stale-`executing` recovery. Optional BehaviorMonitor `activeAgeMs` push detector remains P2 Watch. Real sessions: `session_3c3ec27c`, `session_ffd44ccf`, `session_4872604b`, `session_2f196238`, `session_f4a0a894`, `session_f300c03c`. |
| *long-running-context-assembly.md (graduated 2026-06-21)* | *was Partially Landed* | *moved to [../reference/long-running-context-assembly.md](../reference/long-running-context-assembly.md) as `Active Plan` (R0-R7 closed).* |
| [session-graph-runtime-map-governance-plan.md](./session-graph-runtime-map-governance-plan.md) | Draft | Project existing session, event, tool, permission, child-session, and channel facts into a user-readable Session Graph runtime map. |
| [session-channel-tui-relationship-visibility-plan.md](./session-channel-tui-relationship-visibility-plan.md) | Draft | SessionChannel relationship visibility in TUI without transcript merging or auto-action. |
| [skill-execution-and-automated-normalized-skill-generation-governance-plan.md](./skill-execution-and-automated-normalized-skill-generation-governance-plan.md) | Partially Landed | Skill schema governance, explicit skill tools, draft/save boundaries, and generation constraints. |
| [task-scope-and-evidence-scope-governance-plan.md](./task-scope-and-evidence-scope-governance-plan.md) | Partially Landed | Task scope, evidence scope, boundary confirmation, and out-of-scope diagnostics. |
| [unify-agent-execution-models-plan.md](./unify-agent-execution-models-plan.md) | Draft | Converge the three overlapping agent subsystems (`runAgentLoop` / `ExploreAgentScheduler` / execute path) on one vocabulary + SQLite state owner; replace `skipPermissionCheck` with profile-scoped policy. (Architecture review P1-7.) |
| [unify-embedded-cli-path-plan.md](./unify-embedded-cli-path-plan.md) | Draft | Shared `NexusClientInterface`, long-lived embedded Nexus, route embedded execution through the app to eliminate the second orchestration in `runSessionFlow.ts`. (Architecture review P0-3.) |

## Lifecycle

| Outcome | Required action |
| --- | --- |
| Becomes canonical architecture | Move to `../reference/` and update `../reference/README.md`. |
| Implementation closes | Summarize into `../history/` or `../DONE.md`; do not keep it as a standalone proposal. |
| Superseded or stale | Move to `../archive/` with a short index note. |

## 中文概述

### 作用

`proposals/` 承接 Draft 和 Partially Landed 文档，避免这些尚未稳定的计划污染长期 reference。

### 规则

提案必须最终毕业、合并或归档；不能无限期留在 reference 中。
