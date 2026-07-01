# Nexus Proposals

> State: Index
> Governance: This directory stores draft and partially landed plans that are not yet stable long-lived references.

This directory holds work that is still being shaped, partially implemented, or waiting for stronger evidence. A proposal may graduate into `reference/`, be summarized into `history/`, or move to `archive/`.

## Current Proposals

| Proposal | State | Scope |
| --- | --- | --- |
| [fable-prompt-architecture-reference-governance-plan.md](./fable-prompt-architecture-reference-governance-plan.md) | Draft | External prompt architecture reference, without importing incompatible product assumptions. |
| [go-runner-plan.md](./go-runner-plan.md) | Partially Landed | Optional Go RemoteToolRunner phases and runner boundaries. |
| [go-tui-markdown-rendering-optimization-plan.md](./go-tui-markdown-rendering-optimization-plan.md) | Draft | Gradual Markdown rendering upgrade path for Go TUI transcript readability. |
| [go-tui-session-observability-governance-plan.md](./go-tui-session-observability-governance-plan.md) | Partially Landed | Embedded Nexus persistence and session inspectability gaps for Go TUI. |
| [intent-tool-suppression-stopgap-plan.md](./intent-tool-suppression-stopgap-plan.md) | Draft | Deterministic stopgap for `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` (Mode A action-verb negation in `isPureMemoryCapabilityQuestion` + Mode B `continue+normal` requiresTools guard); scoped slice of the intent-guidance Active Plan. Structural first-call passthrough deferred. |
| [provider-recovery-and-model-catalog-governance-plan.md](./provider-recovery-and-model-catalog-governance-plan.md) | Draft | Trim/implement `providerRecovery` fallback per error kind; resolve "user_config > builtin > undeclared" catalog rule; make BabeL-X model auto-switch explicit/opt-in. (Architecture review P2-8.) |
| [provider-tools-mcp-hygiene-plan.md](./provider-tools-mcp-hygiene-plan.md) | Draft | Extract provider-specific adapter hooks (MiniMax/DeepSeek), shared text-delta chunker, remove dead `list_dir` key, lazy MCP registration. (Architecture review P2-10.) |
| [session-graph-runtime-map-governance-plan.md](./session-graph-runtime-map-governance-plan.md) | Draft | Project existing session, event, tool, permission, child-session, and channel facts into a user-readable Session Graph runtime map. |
| [session-channel-tui-relationship-visibility-plan.md](./session-channel-tui-relationship-visibility-plan.md) | Draft | SessionChannel relationship visibility in TUI without transcript merging or auto-action. |
| [unify-agent-execution-models-plan.md](./unify-agent-execution-models-plan.md) | Draft | Converge the three overlapping agent subsystems (`runAgentLoop` / `ExploreAgentScheduler` / execute path) on one vocabulary + SQLite state owner; replace `skipPermissionCheck` with profile-scoped policy. (Architecture review P1-7.) |
| [unify-embedded-cli-path-plan.md](./unify-embedded-cli-path-plan.md) | Draft | Shared `NexusClientInterface`, long-lived embedded Nexus, route embedded execution through the app to eliminate the second orchestration in `runSessionFlow.ts`. (Architecture review P0-3.) |

已毕业到 `../reference/` 的提案（升为 `Active Plan`）以 [../reference/README.md](../reference/README.md) 为准；本目录不再重复登记毕业条目，避免与 reference 索引双重维护。

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

提案必须最终毕业、合并或归档；不能无限期留在 reference 中。已毕业提案的索引以 [../reference/README.md](../reference/README.md) 为准，本目录不再重复登记毕业条目。
