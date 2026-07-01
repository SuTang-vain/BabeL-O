# Shared

> Module reference · stable public contract · see linked governance docs for deep architecture

[简体中文](shared.zh-CN.md)

## Role

Shared is the leaf foundation of the entire project. It defines the event schemas
(the `NexusEvent` discriminated union; 41 event types via Zod), shared type
definitions (`SessionSnapshot`, `NexusTask`, `TaskStatus`, `AgentJob`,
`SessionChannel`, `ToolTrace`, `BabelOConfig`, `ErrorCodes`), identity helpers
(`createId`, `nowIso`), error classes (`NexusError`, `ProviderError`), and
utility modules (`logger`, `parseSocketQuery`, `validateSecurityConfig`,
`getBashFileDiscoveryGuidance`). Every other module (`nexus`, `runtime`,
`providers`, `tools`, `storage`, `mcp`, `skills`, `cli`) imports from shared;
shared must never import from any project module except the one allowlisted
edge below.

## Public contract

- **`NexusEventSchema` / `NexusEvent`** — Zod-discriminated union of 41+ event
  types (`session_started`, `assistant_delta`, `thinking_delta`,
  `user_message`, `user_intake_guidance`, `usage`, `tool_started`,
  `tool_completed`, `tool_denied`, `task_created`, `result`, `error`,
  `execute_summary`, `near_timeout_warning`, `timeout_budget_exceeded`,
  `timeout_extension_granted`, `task_session_event`, `agent_job_event`,
  `permission_request`, `permission_response`, `hook_started`,
  `hook_completed`, `hook_failed`, `compact_boundary`,
  `context_compact_boundary`, `compact_failure`, `context_warning`,
  `context_blocking`, `context_usage`, `context_microcompact`,
  `context_recovery_attempted`, `context_grounding_required`,
  `context_grounding_confirmed`, `workspace_dirty_detected`,
  `task_scope_declared`, `session_root_continuity`,
  `scope_boundary_detected`, `scope_boundary_confirmed`,
  `session_memory_updated`, `memory_retrieval`, `execution_metrics`,
  `cache_health`). Skill events (`skill_matched`, `skill_invoked`,
  `skill_validation`, `skill_saved`) are typed alongside in
  `skillEvents.ts` but intentionally excluded from the main union.
  Events.ts is hand-written (not codegen); codegen is tracked as a long-term
  coupling-debt item.

- **`SessionSnapshot`** — session state shape consumed by storage,
  serialisation, and HTTP/WS responses.

- **`NexusTask` / `TaskStatus`** — task model used by Nexus scheduling and
  agent loops.

- **`BabelOConfig` / `ConfigManager`** — configuration types and manager
  class (`ConfigManager.getInstance()` singleton + per-instance path).
  `ConfigManager` is the one shared module that crosses the leaf boundary:
  it imports `providers/registry.ts` for Zod validation of provider/model IDs.
  This edge is allowlisted in the layer-direction audit.

- **`NexusError` / `ProviderError` / `ErrorCodes`** — standardised error types
  and string-code constants shared across all modules.

- **`AgentJob` / `AgentJobStatus`** — agent job model for sub-agent
  scheduling, worktree isolation, and governance enforcement.

- **`SessionChannel` / `SessionMessage`** — typed models for inter-session
  messaging.

- **`ToolTrace`** — per-invocation tool-execution record shape.

- **`createId(prefix)` / `nowIso()`** — id-generation and timestamp helpers.

- **`logger`** — structured logger with `silent | error | warn | info | debug`
  levels, gated by `NEXUS_LOG_LEVEL`.

- **`validateSecurityConfig`** — host + API-key security validation.

- **`parseSocketQuery`** — framework-agnostic WebSocket query-string parser.

- **`getBashFileDiscoveryGuidance`** — heuristic guidance for steering `ls` /
  `find` / `grep` / `tree` commands toward native tools.

## Allowed dependencies

Shared is the leaf — it must not import from any project-internal module except
the single allowlisted edge:

- Third-party dependencies (`zod`, `node:fs`, `node:path`, `node:os`,
  `node:crypto`) are all permitted.
- `src/shared/config.ts` imports `src/providers/registry.ts` for Zod schema
  validation of provider/model IDs. This reverse edge is explicitly
  allowlisted in `scripts/layer-direction-allowlist.json` and enforced by
  the layer-direction audit (rule 4: `shared → outside`).
- All other shared files import only `node:*` modules, third-party packages, or
  other files within `src/shared/`.

See
[Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md)
for the allowlist detail and enforcement mechanism.

## Extension points

- **Add a new event type** — create a new Zod schema in `events.ts` with a
  distinct `type` literal, add it to `NexusEventSchema`'s
  `z.discriminatedUnion('type', [...])`, and export the inferred type. Update
  the hand-written `mapEventsToMessages` translation in `LLMCodingRuntime`.
  For skill-domain events, add the schema in `skillEvents.ts` instead.

- **Add an error code** — append a new constant to `ErrorCodes` and export it.
  All code-consuming modules handle new codes via existing switch/case
  patterns.

- **Add a shared utility** — create a new file under `src/shared/`. Ensure it
  imports only `node:*` modules, third-party packages, or other `src/shared/`
  files. Any import outside `src/shared/` requires a layer-direction audit
  allowlist entry.

## Related governance

- [Module coupling governance](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md) —
  coupling heat map, `shared/events.ts` codegen plans, and `ConfigManager`
  singleton-to-injection roadmap.
- [Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md) —
  direction-aware dependency gates; shared's single allowlisted reverse edge.
- [Context governance index](../../nexus/reference/context-governance-index.md) —
  event taxonomy for context-warning, context-blocking, context-usage,
  compact-boundary, and memory-retrieval event families.
