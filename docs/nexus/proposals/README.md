# Nexus Proposals

> State: Index
> Governance: This directory stores draft and partially landed plans that are not yet stable long-lived references.
This directory holds work that is still being shaped, partially implemented, or waiting for stronger evidence. A proposal may graduate into `reference/`, be summarized into `history/`, or move to `archive/`.
## Current Proposals
| Proposal | State | Scope |
| --- | --- | --- |
| [agent-skills-ecosystem-protocol-governance-plan.md](./agent-skills-ecosystem-protocol-governance-plan.md) | Partially Landed | Adopt Agent Skills as BabeL-O's external skill package/interchange format while preserving `NormalizedSkill` as the internal IR; Phase 0-3 landed plus Phase 4 local directory import/export preview/write. |
| [fable-prompt-architecture-reference-governance-plan.md](./fable-prompt-architecture-reference-governance-plan.md) | Draft | External prompt architecture reference, without importing incompatible product assumptions. |
| [go-runner-plan.md](./go-runner-plan.md) | Partially Landed | Optional Go RemoteToolRunner phases and runner boundaries. |
| [go-tui-markdown-rendering-optimization-plan.md](./go-tui-markdown-rendering-optimization-plan.md) | Draft | Gradual Markdown rendering upgrade path for Go TUI transcript readability. |
| [go-tui-task-board-and-ask-user-question-plan.md](./go-tui-task-board-and-ask-user-question-plan.md) | Draft | Go TUI task board real-time update via TaskCreate event emission + AskUserQuestion dialog implementation. Phase 1-7: planning doc, task event, Go TUI handling, event protocol, tool + route, TUI dialog, verification. |
| [go-tui-top-card-task-page-plan.md](./go-tui-top-card-task-page-plan.md) | Draft | Add task-detail page (page 1) to the Ctrl+D top card with left/right arrow key navigation so users can monitor tasks during agent execution when `/tasks` is blocked by `m.running`. Phase 1-4: planning doc, state + rendering, key handling, verification. |
| [task-lifecycle-tool-family-expansion-plan.md](./task-lifecycle-tool-family-expansion-plan.md) | Draft | Close LLM-visible task lifecycle gap: add TaskList + TaskUpdate tools, runtime event emission, and Go TUI real-time status updates. Phase 0-5: planning doc, TaskList, TaskUpdate, runtime events, Go TUI handling, verification. |
| [provider-recovery-and-model-catalog-governance-plan.md](./provider-recovery-and-model-catalog-governance-plan.md) | Draft | Trim/implement `providerRecovery` fallback per error kind; resolve "user_config > builtin > undeclared" catalog rule; make BabeL-X model auto-switch explicit/opt-in. (Architecture review P2-8.) |
| [provider-unavailable-auto-retry-governance-plan.md](./provider-unavailable-auto-retry-governance-plan.md) | Partially Landed | Same-provider automatic retry for transient `provider_unavailable` / `rate_limit` failures, scoped by real MiniMax 500 evidence; Phase 0-2 landed with default 10 retries, 30s delay, Go TUI/CLI/inspect/metrics visibility, env/saved config overrides, and no silent model/provider switch. |
| [provider-tools-mcp-hygiene-plan.md](./provider-tools-mcp-hygiene-plan.md) | Draft | Extract provider-specific adapter hooks (MiniMax/DeepSeek), shared text-delta chunker, remove dead `list_dir` key, lazy MCP registration. (Architecture review P2-10.) |
| [llm-gateway-service-plan.md](./llm-gateway-service-plan.md) | Draft (spike-validated) | First-class inbound OpenAI-compatible LLM gateway (`POST /v1/chat/completions` + `GET /v1/models`) over the existing provider/retry/config pipeline; first consumer AetheL (`babel-ai-engine`). Phase 0 spike landed on `feat/chat-completions-gateway` (stream/non-stream/`response_format`/model defaulting/error mapping verified; `MODEL_NOT_FOUND` guard fixed); Phase 1 = `GET /v1/models` + non-stream fast path + `local`-provider integration tests + contract docs. |
| [session-graph-runtime-map-governance-plan.md](./session-graph-runtime-map-governance-plan.md) | Draft | Project existing session, event, tool, permission, child-session, and channel facts into a user-readable Session Graph runtime map. |
| [soft-error-retry-continuity-governance-plan.md](./soft-error-retry-continuity-governance-plan.md) | Draft | Promote soft runtime signals (soft timeout, intent suppression, soft tool denial) from hard-error presentation to a recoverable continuity path. Three slices: Fix A soft-timeout finish window, Fix B `self_diagnosis_request` exemption + suppression softening, Fix C unified `severity` framework. Reproduction: `session_2db242ff` (soft-timeout abort + intent false positive + user cancel). |
| [soft-timeout-recovery-architecture-plan.md](./soft-timeout-recovery-architecture-plan.md) | Draft | Architectural evaluation of whether soft-timeout can be made directly recoverable (retryable + finish path) without overturning the single-source watchdog. Options A (overturn) / B (in-architecture, landed) / C (timeout ratio tuning) / D (hybrid soft-abort-on-exhaust). Recommends D as structural target + C as immediate mitigation. Resolves soft-error-retry RC-1 / deferred Fix A1/A2. |
| [session-channel-tui-relationship-visibility-plan.md](./session-channel-tui-relationship-visibility-plan.md) | Draft | SessionChannel relationship visibility in TUI without transcript merging or auto-action. |
| [unify-agent-execution-models-plan.md](./unify-agent-execution-models-plan.md) | Draft | Converge the three overlapping agent subsystems (`runAgentLoop` / `ExploreAgentScheduler` / execute path) on one vocabulary + SQLite state owner; replace `skipPermissionCheck` with profile-scoped policy. (Architecture review P1-7.) |
| [unify-embedded-cli-path-plan.md](./unify-embedded-cli-path-plan.md) | Draft | Shared `NexusClientInterface`, long-lived embedded Nexus, route embedded execution through the app to eliminate the second orchestration in `runSessionFlow.ts`. (Architecture review P0-3.) |
| [strategy-authorization-and-consent-governance-plan.md](./strategy-authorization-and-consent-governance-plan.md) | Partially Landed | Separate tool need from execution authorization; Phase 0-3 gate and Phase 4 Go TUI, inspect-session, trace, and CLI one-shot wording slices landed. Replay evaluation remains open. |
| [authorization-continuity-execution-plan.md](./authorization-continuity-execution-plan.md) | ✅ Landed | Fix "继续任务" authorization reset bug: session-level authorization_state persistence + intake inheritance logic + continuation phrase vocabulary. Evidence: `session_1de7cf54` (Turn 6 authorization reset → TOOL_DENIED). Phase 0-4 landed with 67 tests. |
| [intake-conservatism-analysis.md](./intake-conservatism-analysis.md) | ✅ Fixed | Analysis of intake layer over-conservatism: default fallback to 'inspect', missing authorization verbs in regex, no inheritance mechanism. Main issues fixed via authorization-continuity plan Phase 0-4 + extended regex patterns. 35 tests pass. |
| [intent-guidance-architecture-optimization-analysis.md](./intent-guidance-architecture-optimization-analysis.md) | Draft | Deep analysis: Is the 3-layer intent guidance necessary? Based on 2024-2025 academic research (NTILC, CLAI, "Less is More"), token cost analysis, and industry practices. Conclusion: 3-layer design is redundant, can save 60-70% tokens. |
| [intent-guidance-simplification-execution-plan.md](./intent-guidance-simplification-execution-plan.md) | Draft | Execution plan to simplify intent guidance from 3 layers to 1 layer. Phase 1-5: merge layers, simplify prompt, remove redundant functions. Target: 60-70% token reduction, 80% code reduction. |
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
