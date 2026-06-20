# Module Coupling Decoupling And Re-aggregation Plan

> State: Active Plan
> Track: Runtime / Nexus / Tools / Storage / CLI
> Priority: P1 (long-lived coupling debt; escalate to P0 only if a P0 regression root-traces to coupling — e.g. `session_10320709` `contextSearch` `CONTEXT_STORAGE_UNAVAILABLE` already partially traces to runtime↔nexus reverse-import of `BehaviorMonitor` / `PersistedWorkingSetTracker`)
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../active/TODO_cleanup.md](../active/TODO_cleanup.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/nexus/`, `src/runtime/`, `src/shared/`, `src/tools/`, `src/storage/`, `src/providers/`, `scripts/audit-dependency-boundary.js`
> Governance: Canonical coupling governance entry point. Indexed by [README.md](./README.md) and cross-referenced from [development-process-stability-governance-plan.md](./development-process-stability-governance-plan.md), [context-governance-index.md](./context-governance-index.md), [tool-governance-plan.md](./tool-governance-plan.md), [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md), [context-cwd-drift-and-recall-governance-plan.md](./context-cwd-drift-and-recall-governance-plan.md).
> Related: [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md), [memory-governance-plan.md](./memory-governance-plan.md), [prompt-model-governance-index.md](./prompt-model-governance-index.md), [evidence-governance-index.md](./evidence-governance-index.md), [go-client-distribution-governance-index.md](./go-client-distribution-governance-index.md), archived source documents in [../archive/](../archive/).

## Purpose

This document is the canonical reference for the project-wide module-coupling debt. It consolidates the audit findings, the decomposition design, and the re-aggregation roadmap so that future runtime work does not have to rediscover the same coupling hot spots.

The plan is intentionally cross-track. It does not own any single runtime feature; it owns the *boundaries between* runtime features. Its job is to keep the existing `npm run deps:audit` gate honest, eliminate the reverse `runtime → nexus` import path introduced by PR-A4, replace module-level singletons with constructor-injected services, and split the two largest code-organization hot spots — `src/nexus/app.ts` (6170 lines, 85 routes) and `src/runtime/LLMCodingRuntime.ts` (1758 lines, 33 imports) — into narrowly bounded modules whose interfaces can be reviewed independently.

It does not invent new product capability. Every change must be motivated by a real coupling incident, a future P0 risk, or a known regression root cause; every phase must leave `npm test`, `npm run deps:audit`, and `npm run build:smoke` green.

## Status Update (2026-06-19)

This document is now the canonical coupling governance entry point. It should be used together with [development-process-stability-governance-plan.md](./development-process-stability-governance-plan.md): every coupling PR must follow the "one PR = one semantic slice" rule, carry explicit verification, and avoid combining behavior changes with broad documentation movement.

The line-count targets in this document are health indicators, not single-PR merge gates. `LLMCodingRuntime <= 600 lines` and `app.ts <= 400 lines` remain useful north-star outcomes, but no implementation PR should attempt to reach them in one large refactor. The actual execution path is the PR-sized phase map in [Execution Slicing Addendum](#execution-slicing-addendum).

**Phase 4A+ — Nexus Router Slice** crossed a major milestone on 2026-06-19: the cumulative app.ts decomposition landed 7 review-high-risk sub-slices (A1/A2/A3/C1/C2/C3/E1) and reduced `app.ts` from 864 to **226 lines** on 2026-06-19, then the 2026-06-20 tail cleanup moved shared socket/security utilities out and brought it to **191 lines**. This 77.9% cumulative reduction takes the file **below the north-star ≤ 400 line target for the first time**. The 191-line `createNexusApp` is now a 9-step composition root that delegates route registration, route-lifecycle wiring, middleware, status snapshot construction, and utility ownership to narrowly-bounded modules. Phase 4 row is updated to "Closed 2026-06-19" with tail cleanup recorded on 2026-06-20. See [Phase 4A+ App.ts Decomposition Retrospective](#phase-4a-appts-decomposition-retrospective-2026-06-19) for the full slice inventory and verification numbers.

**Stream G — SqliteStorage Repository Decomposition** opened on 2026-06-20. The 1753-line `SqliteStorage.ts` monolithic database manager began shrinking through repository extraction: `EventRepository` (3B-20, 206 lines, owns events-table operations including listEvents / appendEvent / sequence allocation / duplicate-repair) and `TaskRepository` (3B-21, 166 lines, owns tasks-table operations including saveTask / getTask / listTasks / JSON-column serialization) have both landed. `SqliteStorage.ts` is now **1594 lines (-159 / -9.1%)** with the public `listEvents` / `appendEvent` / `saveTask` / `getTask` / `listTasks` methods reduced to thin delegations. The remaining domains — `permission_audits`, `tool_traces`, `session_channels`, `session_messages`, `agent_jobs`, `execution_metrics`, `loop_panes` — are still inline in `SqliteStorage.ts` and queued for `AuditRepository` (3B-22) and follow-on slices. Phase 9 row is updated to "In Progress 2026-06-20" with this two-slice status recorded below.

## Current State

Implemented pieces:

- `scripts/audit-dependency-boundary.js` + `npm run deps:audit` enforce that no `src/runtime/*` file reaches into `chalk`, `commander`, or `ws` (the three CLI-only dependencies). Last clean run reported `failures: { missingOwnership: [], runtimeCliLeaks: [], devDependencyLeaks: [], undeclaredImports: [] }`.
- `src/shared/config.ts` has a typed `BabelOConfig` Zod schema, a `ConfigManager` class, and a `resolveConfigDirForStorageEnv` helper that honours `BABEL_O_CONFIG_DIR` / `BABEL_O_CONFIG_FILE` precedence. `BabelOConfigSchema` validates profile / provider / model / hook configuration.
- `src/storage/` (`MemoryStorage`, `SqliteStorage`) implements the `NexusStorage` interface and is selected by `createDefaultNexusRuntime` via `resolveDefaultStoragePath`. `NODE_ENV === 'test'` opt-in keeps 100+ existing tests isolated.
- `src/providers/` adapters (`AnthropicAdapter`, `OpenAIAdapter`, `LocalAdapter`) and `registry.ts` (`providerRegistry` + `modelRegistry`) only import `shared/errors` and `retry.js`. They do not depend on `runtime/`, `nexus/`, `storage/`, or `tools/`.
- `src/skills/` is fully self-contained — every internal file only imports other `skills/*` files, except one `shared/skillEvents.js` reference.
- `src/mcp/` (`McpClient`, `McpRegistry`, `McpToolAdapter`) only depends on `tools/Tool.js` and `shared/version.js`. It plugs into the runtime via `createMcpToolRegistry()` called from `nexus/createRuntime.ts:106`.
- `src/tools/contextTools.ts` registers pure `contextSearch` / `contextRecent` / `contextSummarize` tools that read from a `NexusStorage` argument; they are part of the Phase C2 context recall plan tracked in [context-cwd-drift-and-recall-governance-plan.md](./context-cwd-drift-and-recall-governance-plan.md).
- `LLMCodingRuntime.runExecuteStreamInner` now injects `this.storage` into `RuntimeExecuteOptions` (Phase C2 of the context cwd-drift plan), and `resolveCwdWithContinuity` is the single shared cwd-resolver used by both `app.ts` and the runtime.

Open coupling debt (the subject of this document):

- `LLMCodingRuntime` is a **1493-line class** (Phase 0.5 audit baseline 1758; Phase 3B+ peaked at 1841 with strategy-class wiring, then 5 helper extractions reduced it to 1493; 1841 → 1493 = -348 / -18.9%) that 4 callers directly import (`nexus/createRuntime.ts`, `nexus/agentLoop.ts`, `nexus/agents/AgentScheduler.ts`, `cli/embedded.ts`). It carries 41 imports, owns its own `readFileCache`, and accepts an undocumented `resumeDeps` parameter object. Phase 2B removed its runtime hot-path dependency on the module-level `defaultContextBroadcaster` singleton. The 893-line gap to the north-star `≤ 600` target has narrowed but not closed.
- `src/nexus/app.ts` has been **reduced from 6170 to 191 lines** through Phase 4A+ — 37 router files in `src/nexus/routers/`, plus the original helper modules (`activeExecutionRegistry`, `executionTimeoutEvents`, `executionPreparation`, `executionFinalization`, `executionEventProcessing`, `runtimeMetricsSnapshot`, `executionHttpResult`, `executionRuntimeOptions`, `executionWebSocketControl`, `executionStreamLoop`) and the 2026-06-19/20 review-high-risk sub-slices (`executeHttpRoute`, `executeStreamRoute`, `routerRegistrar`, `bootstrapStatus`, `middleware`, `executeRouteDeps`, `workingSetBroadcaster` wire, `socketQuery`, and `security`). The 2026-06-19 7-slice pull took the file below the north-star `≤ 400` line target (864 → 226 lines, **-73.8%**), and the 2026-06-20 tail cleanup moved the last generic helpers to `src/shared/` (226 → 191 lines). `createNexusApp` is now a 9-step composition root that delegates route registration, route-lifecycle wiring, middleware, status snapshot, execute route deps construction, WebSocket query parsing, and security validation to narrowly-bounded modules.
- `src/runtime/runtimePipeline.ts` is now a 137-line compatibility façade after Phase 3A. Its former helper clusters have been split into `src/runtime/pipeline/turn.ts`, `events.ts`, `context.ts`, `contextRefresh.ts`, `cache.ts`, `loop.ts`, `providerTurn.ts`, and `localIntent.ts`. Existing import paths still work through the façade, but new code should import directly from the narrower submodule it needs.
- Phase 3B+ has landed three strategy classes (`src/runtime/ContextRefreshStrategy.ts` 56 lines, `src/runtime/ProviderTurnDriver.ts` 63 lines, `src/runtime/ToolDispatchPipeline.ts` 135 lines) and five standalone helpers extracted from the runtime body (`src/runtime/eventsTranslator.ts` 332 lines, `src/runtime/behaviorTraceTap.ts` 175 lines, `src/runtime/loadWorkingSetOverride.ts` 118 lines, `src/runtime/applyWorkingSetUpdate.ts` 83 lines, `src/runtime/executeProviderRecoveryDecision.ts` 382 lines — 3B-19 catch-block extraction). `LLMCodingRuntime` now routes hot-path context refresh / `resume()` context assembly through `ContextRefreshStrategy`, provider adapter `queryStream` + stream guard setup through `ProviderTurnDriver`, provider tool-call dispatch coordination through `ToolDispatchPipeline`, NexusEvent → provider message translation through `mapEventsToMessages`, behavior-trace tap through `wrapWithBehaviorTraceTap`, R2 working-set read/write through the two standalone helpers, and provider-loop catch-block + recovery decision tree through `executeProviderRecoveryDecision`. R2 wiring-guard contract is preserved via thin-delegate methods on the class prototype. Compact orchestration, hook dispatch, and event yielding around the loop still remain in the runtime loop for later slices. The main loop body still owns 25+ `yield buildXxxEvent` calls, 5 `refreshRuntimeContextState` calls, 4 `compactSession` calls, and 14 `previousEvents.push` accumulator mutations; the catch-block 100-line inline sequence has been collapsed to one helper call.
- `src/runtime/runtimeToolLoop.ts` (903 lines) is the only place that runs the scope-boundary permission flow, the per-tool permission gate, and the per-tool dispatch. Phase 2A moved provider session approval rules into an injectable `ProviderSessionRules` service, but `executeProviderToolCall` and `replaceLargeToolResult` still keep this file on the hot path.
- Phase 1A closed the monitor-owned reverse imports from `src/runtime/*` into `src/nexus/*`: `BehaviorMonitor`, `WorkingSetTracker`, and `PersistedWorkingSetTracker` are now runtime-owned modules with thin `nexus/` compatibility facades (`nexus/behaviorMonitor.ts`, `nexus/persistedWorkingSetTracker.ts`, `nexus/workingSetTracker.ts` are 3-line re-export shims). Phase 2B removed the last `runtime -> nexus` reverse import by deleting the `runtime/contextBroadcasterSingleton.ts` façade and passing a runtime-owned broadcaster interface into the hot path. `npm run coupling:audit` reports `runtimeToNexus: []`.
- `ConfigManager` still has a lazy singleton (`ConfigManager.getInstance()`, **35 references across 24 files**) for legacy callers, but Phase 2C added an explicit instance path (`new ConfigManager({ configFile })`) and proved two config files can coexist in one process. `createDefaultNexusRuntime({ configManager })` and `ExploreAgentScheduler({ configManager })` now use injected instances; the remaining 22+ callsites (CLI commands, routers, runtime diagnostics, provider smoke, compact summary, bash tool) still reach for the singleton.
- `defaultContextBroadcaster` is now a Nexus compatibility default (**7 references** in `nexus/routers/contextObserveRouter.ts`, `nexus/cacheHealth.ts`, and `nexus/contextBroadcaster.ts`) used only by the `/v1/context/observe` WebSocket and the metrics aggregator. The runtime hot path receives a structural `RuntimeContextBroadcaster` (`src/runtime/contextBroadcaster.ts`) by injection. `defaultEverCoreRuntimeManager` (`nexus/everCoreRuntimeManager.ts`) is still a module-level `const` singleton with **10 references**.
- Phase 2A removed the module-level `providerSessionRules` `Map` from `runtimeToolLoop.ts` and introduced `src/runtime/providerSessionRules.ts` as a per-instance service.
- `src/shared/events.ts` is a 779-line file defining 40 discriminated-union event types via Zod schemas. `grep -rln 'NexusEvent\b' src/` returns 60+ consumer files. The 200-line `mapEventsToMessages` (`LLMCodingRuntime.ts:1426-1627`) translates events into provider messages, but it is a hand-written if/else chain — there is no codegen guard that ensures all 40 types are translated.
- `process.env` is read 159 times across `src/`, with 247 hits when counting BABEL_O_/EVERCORE_/EVEROS_/ANTHROPIC_/OPENAI_ env-var names. `nexus/server.ts:1-50` parses 17 env vars at boot, while `nexus/createRuntime.ts:138-142` and `nexus/server.ts:9-15` repeat the same `resolveConfigDirForStorageEnv` logic.
- Storage null guards are duplicated. `LLMCodingRuntime.ts:293` and `LocalCodingRuntime.ts:170` both contain the same `if (!options.storage && this.storage) { options = { ...options, storage: this.storage } }` block — they are the Phase C2 fix landed separately in each runtime.
- The cwd-resolver has a documented dual-site problem. `LLMCodingRuntime.resolveCwdFromPrompt` is a thin wrapper around `systemPromptBuilder.resolvePromptCwd`, but `nexus/app.ts:resolveExplicitPromptCwd` predates the wrapper and was *weaker* — until [context-cwd-drift-and-recall-governance-plan.md §13 Bug 4](./context-cwd-drift-and-recall-governance-plan.md) was filed to merge them. The same review also flagged that `app.ts:2301` writes `session.cwd = cwd` on every turn, masking drift across turns.
- Phase 1B closed the reverse-direction `nexus -> cli` import. `startEverOSBackgroundBootstrap`, `runEverOSMemorySetup`, EverOS prerequisite inspection, and pip fallback build helpers now live under `src/runtime/`; `src/cli/everos*.ts` files remain compatibility facades or CLI policy wrappers. `npm run coupling:audit` reports `nexusToCli: []`.
- `tools/everCoreMcpTools.ts` still imports `nexus/everCoreConfig` (type-only) and `runtime/everCoreClient` / `runtime/memoryProvider`. The intended separation is to keep `tools/` pure-functional with explicit dependencies on `runtime/` interfaces only, not the Nexus `everCoreConfig` runtime-config type. This is the one remaining `tools → nexus` edge in the audit and is on the Watch list for Phase 8.
- `SqliteStorage.ts` is a 1753-line file that manages all SQLite database table initializations, schemas, transaction locks, serialization maps, event logging, task storage, and audit logs. This large monolithic design tightly couples multiple domains into a single maintenance hot spot. Stream G started on 2026-06-20: `EventRepository` (3B-20, 206 lines) and `TaskRepository` (3B-21, 166 lines) have been extracted; `SqliteStorage.ts` is now **1594 lines (-159 / -9.1%)** with `listEvents` / `appendEvent` / `saveTask` / `getTask` / `listTasks` reduced to thin delegations. The remaining inline domains are `permission_audits`, `tool_traces`, `session_channels` / `session_messages`, `agent_jobs`, `execution_metrics`, `loop_panes` — queued for `AuditRepository` (3B-22) and follow-on slices.

## Problem Statement

The project has accumulated an organic, well-documented coupling debt. It is not blocking feature work today, but it produces predictable failure modes:

1. **P0 regressions root-trace to coupling.** `session_10320709` showed that `LLMCodingRuntime.runExecuteStreamInner` did not propagate `this.storage` into `RuntimeExecuteOptions`, causing `contextSearch` / `contextRecent` to return `CONTEXT_STORAGE_UNAVAILABLE`. The fix was a one-line guard, but the underlying cause — `RuntimeExecuteOptions.storage` is optional, every consumer must remember to inject it — is a coupling problem. The same pattern reappeared in `LocalCodingRuntime.runExecuteStreamInner` at line 170, requiring a separate fix.

2. **The 1493-line `LLMCodingRuntime` is a bottleneck for every review.** Every change to context assembly, tool policy, compact, provider recovery, behavior trace, or memory triggers touches this class. A future P0 that requires changing the loop body (e.g. `session_ef76f50a-` evidence-scope drift) has to navigate 25 inlined loop steps, 5 `refreshRuntimeContextState` calls, and 4 `compactSession` calls. The `resumeDeps` field is the most recent symptom: it bundles 4 closures (workingSetTracker, behaviorMonitor, buildSystemPrompt, mapEventsToMessages) because the WorkingSet / BehaviorMonitor were owned by `nexus/` until Phase 1A moved them. Phase 3B+ extracted 3 strategy objects (`ContextRefreshStrategy`, `ProviderTurnDriver`, `ToolDispatchPipeline`) and 5 standalone helpers (`mapEventsToMessages`, `wrapWithBehaviorTraceTap`, `loadWorkingSetOverride`, `applyWorkingSetUpdate`, `executeProviderRecoveryDecision`); the main-loop orchestration still lives here, so the file went 1758 → 1841 (with strategy wiring) → 1620 (after 4 helper extractions) → 1493 (after 3B-19 catch-block extraction).

3. **`app.ts` is a merge-conflict hot spot.** Every P0 fix over the last 30 days touched `app.ts`: `session_10320709` (cwd drift storage propagation, ~6 routes), `session_go_1781146359507755000` (embedded Nexus persistence, `/v1/runtime/status` route), `session_ef76f50a-` (task scope, ~3 routes). Phase 4A+ moved 35+ route clusters into `src/nexus/routers/`, plus active execution, timeout event/control, preparation, finalization/settlement, execution event-processing, runtime metrics snapshot, HTTP execute result, runtime execute options, WebSocket control/forwarding/lifecycle helpers, shared execution stream loop, and active execution leases into narrow modules. The 2026-06-19 7-slice pull closed the remaining `app.ts` gap by extracting the 37× `router.register` boilerplate into a `registerAllRouters()` factory, splitting `/v1/execute` and `/v1/stream` into focused route modules, lifting bootstrap status + middleware + execute route deps into helper factories, and wiring the shared `workingSetBroadcaster` end-to-end. `app.ts` is now 191 lines after the 2026-06-20 socket/security tail cleanup, **below the `≤ 400` north-star target**. Remaining inline modules are tiny enough that future P0 fixes touching them no longer have to navigate the 864-line god file.

4. **`runtimePipeline.ts` was an undeclared god module.** Before Phase 3A it had 1828 lines and 21 builder functions consumed through one flat import surface. That shape slowed reviews because a reviewer who wanted to know "what does the runtime loop depend on for context refresh?" had to grep 21 names. Phase 3A has now reduced it to a 137-line compatibility façade over narrow `runtime/pipeline/*` submodules; the remaining risk is preventing new code from re-growing the flat façade.

5. **The reverse `runtime → nexus` import direction is a layering violation that already caused one circular pair.** `BehaviorMonitor` ↔ `loopDiagnostics` is a true circular dependency, currently safe only because TypeScript allows the cycle when all references are type-only. `LLMCodingRuntime`'s `resumeDeps` is a workaround, not a fix. If a future change turns any of those type-only imports into a value import, the build will silently break. `loopDiagnostics` also reads `DEFAULT_HINT_COOLDOWN_MS` from `BehaviorMonitor`, which means cooldown tuning must touch two files in two layers.

6. **Module-level singletons prevent clean re-entry.** `ConfigManager.getInstance()` still creates global coupling for legacy callers, but Phase 2C proved explicit instances can isolate config files and wired the first runtime / agent composition paths. `defaultContextBroadcaster` no longer blocks the runtime hot path after Phase 2B, but remains as a Nexus compatibility default. The former `providerSessionRules` module-level `Map` has been removed in Phase 2A and is now an injectable service with a legacy default instance only for compatibility.

7. **`shared/events.ts` is a 779-line single point of truth.** 40 event types, 60+ consumer files, no codegen. The current `mapEventsToMessages` is a hand-written 200-line if/else, and any new event type has to be added there, in `buildXxxEvent` factories, in the Go TUI WS consumer, and in storage deserialization. A regression in one event will look like a bug in another.

8. **DI debt is concentrated, not pervasive.** `storage/`, `providers/`, `skills/`, and `mcp/` are exemplary: each is reachable only through narrow interfaces, has no module-level state, and depends on `shared/` only. The same pattern should be the *default*, not the exception. The decoupling work is therefore localized to `runtime/`, `nexus/app.ts`, `shared/config.ts`, and `shared/events.ts`.

9. **`SqliteStorage` is a monolithic database manager.** The single class `SqliteStorage.ts` handles WAL log batches, schema setup, session retrieval, task mutations, and event lists. Changes to different data models are coupled in this file, making testing of isolated entities harder and increasing merge conflict risk. Stream G started on 2026-06-20 with `EventRepository` (3B-20) and `TaskRepository` (3B-21) extracted; the file is now 1594 lines (-159 / -9.1%) and the public list/append/save/get methods are thin delegations. Remaining inline domains (`permission_audits`, `tool_traces`, `session_channels` / `session_messages`, `agent_jobs`, `execution_metrics`, `loop_panes`) are queued for `AuditRepository` (3B-22) and follow-on slices.

## Planning Correction

The original phase map intentionally describes the destination architecture. It should not be interpreted as permission to open large, mixed refactor PRs.

Specifically:

- `LLMCodingRuntime <= 600 lines` and `app.ts <= 400 lines` are cumulative health goals, not single-PR exit criteria.
- Each PR should remove one reviewable coupling point and prove the before/after audit fingerprint improved.
- `shared/events.ts` domain splitting and full `RuntimeEnv` consolidation are later investments. They must not block higher-priority fixes for reverse imports and singleton state.
- Any PR that touches runtime/storage/events/CI is `review-high-risk` under the development-process plan.

## Goals

- Keep the existing `npm run deps:audit` clean. Phase 1 eliminated `nexus -> cli` (`everosBackgroundBootstrap`) and the monitor-owned `runtime -> nexus` imports (`BehaviorMonitor`, `PersistedWorkingSetTracker`, `workingSetTracker`); Phase 2B removed the remaining `runtime/contextBroadcasterSingleton.ts -> nexus/contextBroadcaster.ts` reverse import. `npm run coupling:audit` now reports `runtimeToNexus: []` and `nexusToCli: []`.
- Reduce `LLMCodingRuntime` from 1758 lines / 33 imports to a thin orchestrator (target ≤ 600 lines / ≤ 12 imports) by extracting 5–7 strategy objects whose boundaries are testable independently.
- Reduce `nexus/app.ts` from 6170 lines / 85 routes to a route-table that registers ≤ 8 feature routers (`/v1/runtime/*`, `/v1/context/*`, `/v1/agents/*`, `/v1/skills/*`, `/v1/sessions*`, `/v1/execute`, `/v1/loop/*`, `/v1/working-set/*`), each in its own file. Each feature router must declare its dependencies in a typed `FeatureRouter` interface.
- Replace `ConfigManager.getInstance()` with constructor-injected `ConfigManager` over several small slices. Phase 2C has already added `new ConfigManager({ configFile })` and migrated `createDefaultNexusRuntime` / `ExploreAgentScheduler` composition; later slices can keep reducing the remaining legacy singleton callsites.
- Replace the remaining module-level singletons (`defaultContextBroadcaster`, `defaultEverCoreRuntimeManager`) with a typed `RuntimeServices` container that is constructed once in `createDefaultNexusRuntime` and passed through `RuntimeExecuteOptions.services` to the runtime. Phase 2A already converted `providerSessionRules` into an injectable service; later Stream B work can fold that service into `RuntimeServices`.
- Make `NexusEvent` schema evolution a codegen step. Either generate the `mapEventsToMessages` translation table from the Zod schema, or split `events.ts` into per-domain event files (`events/turn.ts`, `events/tool.ts`, `events/context.ts`, `events/scope.ts`, `events/memory.ts`, `events/permission.ts`, `events/hook.ts`) with a single re-exporting `events/index.ts` for back-compat.
- Consolidate `process.env` reading. Move all `BABEL_O_*` / `NEXUS_*` env access behind a typed `RuntimeEnv` snapshot, parsed once at `createDefaultNexusRuntime` boundary.
- Decompose the 1753-line `SqliteStorage.ts` class by extracting domain-specific database operations into separate helper classes: `EventRepository`, `TaskRepository`, and `AuditRepository`. The main `SqliteStorage` class should delegate tasks to these repositories, reducing complexity. Stream G started on 2026-06-20 with `EventRepository` (3B-20) and `TaskRepository` (3B-21) extracted — `SqliteStorage.ts` is now 1594 lines (-159 / -9.1%). `AuditRepository` and follow-on slices are queued.
- Land each phase as an independent PR with focused regression tests. No silent refactors.

## Non-goals

- Do not change the public Nexus HTTP / WebSocket contract. Existing REST + WS routes must keep the same URL, request shape, response shape, and error codes.
- Do not change the on-disk SQLite schema or the JSONL event log format. `NEXUS_EVENT_SCHEMA_VERSION = '2026-05-21.babel-o.v1'` must remain backwards compatible for at least one major version.
- Do not migrate to a different configuration store, a different ORM, or a different web framework. Fastify + Commander + native `node:sqlite` are the chosen stack; this plan only reorganizes the existing modules.
- Do not introduce a heavy DI container (InversifyJS, NestJS). Constructor injection with concrete types is sufficient and matches the existing storage / provider style.
- Do not silently change runtime behavior to "fix" coupling. Every refactor must be verified by an existing focused test or a new one.
- Do not split the 60+ `NexusEvent` consumers in this plan. The schema codegen is the consumer-side fix; the consumer code itself is not the subject of this plan.
- Do not let the new `RuntimeServices` container leak into `shared/`. The container is a runtime composition root concept, not a shared utility.
- Do not let `cli/embedded.ts` import from `nexus/createRuntime.ts` *and* `nexus/app.ts` from the same import path. After the router split, `cli/embedded.ts` should depend on a single `nexus/index.ts` entry point.

## Coupling Heat Map

The numbers below are pulled from `grep` over the source tree on 2026-06-18. They are not benchmarked; they are an *audit fingerprint* of the layering stress.

### Layer-by-layer import directions

| Direction | Count of files | Highest-stress paths |
| --- | --- | --- |
| `runtime/*` → `shared/*` | 12 | `shared/events.js` (26), `shared/config.js` (8), `shared/session.js` (5) |
| `runtime/*` → `nexus/*` (reverse direction) | 0 | Closed by Phase 1A + Phase 2B; `runtime/contextBroadcasterSingleton.ts` removed |
| `runtime/*` → `tools/*` | 4 | `tools/Tool.js` (7) |
| `runtime/*` → `storage/*` | 1 | `storage/Storage.js` (6) |
| `runtime/*` → `providers/*` | 2 | `providers/adapters/ModelAdapter.js` (12), `providers/registry.js` (4) |
| `nexus/*` → `runtime/*` | 12 | `runtime/everCoreClient.js` (4), `runtime/remoteRunner.js` (5), `runtime/memoryProvider.js` (3) |
| `nexus/*` → `shared/*` | 8 | `shared/config.js` (11), `shared/session.js` (9), `shared/events.js` (9) |
| `nexus/*` → `cli/*` (reverse direction) | 0 | Closed by Phase 1B; `createRuntime.ts` imports `runtime/everosBackgroundBootstrap.js` |
| `tools/*` → `runtime/*` | 2 | `runtime/everCoreClient.js` (1), `runtime/memoryProvider.js` (1) |
| `cli/*` → `nexus/*` (allowed, narrow) | 3 | `nexus/app.js` (1, `cli/embedded.ts`), `nexus/createRuntime.js` (1), `nexus/agents/types.js` (1, type-only) |
| `cli/*` → `runtime/*` (allowed, narrow) | 1 | `runtime/hooks.js` (1, `cli/runSessionFlow.ts`), `runtime/systemPromptBuilder.js` (1) |
| `shared/*` → outside `shared/` | 1 | `providers/registry.js` (1, `shared/config.ts`) |
| `storage/*` → outside `storage/` | 0 | self-contained |
| `providers/*` → outside `providers/` | 0 | self-contained |
| `skills/*` → outside `skills/` | 1 | `shared/skillEvents.js` (1) |
| `mcp/*` → outside `mcp/` | 2 | `tools/Tool.js` (2), `shared/version.js` (1) |

### Singleton / module-state count

| State owner | Pattern | Reset path | Files reading it |
| --- | --- | --- | --- |
| `ConfigManager` | explicit instance path plus legacy lazy singleton (`getInstance`) | construct `new ConfigManager({ configFile })` for isolated callers | runtime factory / agent scheduler can now inject an instance; remaining legacy import sites tracked by `npm run coupling:audit` |
| `defaultContextBroadcaster` | Nexus compatibility default | `setDefaultContextBroadcaster` (legacy/test-only) | `nexus/app.ts` and context observer tests; runtime hot path uses injected `RuntimeContextBroadcaster` |
| `defaultEverCoreRuntimeManager` | `const` export | none | `nexus/server.ts:69`, `cli/embedded.ts:293` |
| `ProviderSessionRules` | injectable service with legacy default instance | `resetProviderSessionRulesForTest()` clears the default instance | `LLMCodingRuntime` owns a per-runtime instance; `runtimeToolLoop.ts` accepts an injected service |
| `cacheHealth dedup` | module-level dedup set | test-only reset | `nexus/cacheHealth.ts:460-480` |

### `process.env` access concentration

| File | `process.env` reads | `process.cwd` reads |
| --- | --- | --- |
| `shared/config.ts` | 26 | 0 |
| `nexus/server.ts` | 21 | 1 |
| `providers/adapters/AnthropicAdapter.ts` | 9 | 0 |
| `nexus/app.ts` | 9 | 0 |
| `cli/commands/go.ts` | 8 | 0 |
| `cli/runSessionFlow.ts` | 7 | 0 |
| `tools/builtin/bash.ts` | 6 | 1 |

## Decomposition Design

The decomposition has six independent streams, each with its own phase plan below. Streams are sequenced so that no stream depends on a later one.

### Stream A — Reverse direction cleanup

Move three formerly `nexus/`-owned stateful classes into `runtime/`:

- `BehaviorMonitor` is now `src/runtime/behaviorMonitor.ts`. It is a state machine over event streams; it does not depend on Fastify, WebSockets, or HTTP. `src/nexus/behaviorMonitor.ts` remains only as a compatibility re-export.
- `PersistedWorkingSetTracker` is now `src/runtime/persistedWorkingSetTracker.ts`. The on-disk `.babel-o/working-set.json` schema is a runtime concern, not an HTTP concern. `src/nexus/persistedWorkingSetTracker.ts` remains only as a compatibility re-export.
- `workingSetTracker` (the in-memory class) is now `src/runtime/workingSetTracker.ts`. The Nexus WS observer that publishes its updates stays in `nexus/`, but reads the tracker through a narrow interface. `src/nexus/workingSetTracker.ts` remains only as a compatibility re-export.

After the move, the only `nexus → runtime` dependency in this stream is the WS observer hook, which is a valid direction (server depends on runtime).

### Stream B — Singletons to injected services

A new `src/runtime/services.ts` defines:

```ts
export type RuntimeServices = {
  configManager: ConfigManager
  contextBroadcaster: ContextBroadcaster
  everCoreManager: EverCoreRuntimeManager
  providerSessionRules: ProviderSessionRules
  env: RuntimeEnv
}
```

`createDefaultNexusRuntime` constructs the `RuntimeServices` once. `LLMCodingRuntime` accepts `RuntimeServices` via a new `RuntimeExecuteOptions.services` field (defaulted to `defaultServices` for back-compat). The remaining module-level singletons become `defaultServices` exports that legacy code paths can still reach, while the Phase 2A `ProviderSessionRules` service is folded into that container.

`providerSessionRules` became `src/runtime/providerSessionRules.ts` in Phase 2A. The service exposes explicit rule addition, lookup, allow-check, and clear behavior; the module-level `Map` disappeared from `runtimeToolLoop.ts`. A legacy default instance remains only for direct `executeProviderToolCall` callers that have not yet injected an instance.

### Stream C — `LLMCodingRuntime` decomposition

The current class has five intertwined responsibilities. After decomposition each becomes a standalone class with a focused interface.

| Responsibility | Current location (line range in `LLMCodingRuntime.ts`) | New class |
| --- | --- | --- |
| Loop orchestration | `runExecuteStreamInner` (284-1157) | `RuntimeOrchestrator` (thin shell, ≤ 400 lines) |
| Provider call / stream / retry | `streamProviderTurn`, `providerRecovery` block (857-981) | `ProviderTurnDriver` |
| Context refresh / compact coordination | `refreshRuntimeContextState` (430-633) | `ContextRefreshStrategy` |
| Tool dispatch / permission flow | `executeProviderToolCall` (1077-1127) | `ToolDispatchPipeline` (already partially in `runtimeToolLoop.ts`; lift the loop's call site into it) |
| Hook dispatch | `executeRuntimeHooks` (843-902, 983-1000) | `HookDispatcher` (already exists in `runtime/hooks.ts`; thin wrap here) |
| Behavior trace tap | `wrapWithBehaviorTraceTap` (1682-1742) | already separate; move to `runtime/behaviorTrace.ts` as a pure function (no class needed) |
| Memory retrieval | `emitMemoryRetrieval` (243-282) + `onMemoryRetrieval` callback | already separate; keep as `MemoryRetrievalEmitter` |
| Resume | `resume()` (1170-1295) | `RuntimeResumeService` |

The class signature becomes:

```ts
class LLMCodingRuntime implements NexusRuntime {
  constructor(
    private readonly tools: Map<string, AnyTool>,
    private toolPolicy: ToolPolicy,
    private readonly storage: NexusStorage,
    private readonly services: RuntimeServices,
    private readonly strategies: {
      providerTurn: ProviderTurnDriver
      contextRefresh: ContextRefreshStrategy
      toolDispatch: ToolDispatchPipeline
      hookDispatcher: HookDispatcher
      resume?: RuntimeResumeService
    },
  )
}
```

The 4 existing callers (`createRuntime`, `agentLoop`, `AgentScheduler`, `embedded`) gain a `strategies` factory in `createDefaultNexusRuntime` so they do not have to know which strategy class is in use.

### Stream D — `nexus/app.ts` router split

`app.ts` becomes a route table:

```ts
const featureRouters: FeatureRouter[] = [
  runtimeStatusRouter,
  runtimeMemoryRouter,
  runtimeConfigRouter,
  runtimeConfigMutationRouter,
  runtimeMetricsRouter,
  runtimeProviderDiagnosticsRouter,
  schemaRouter,
  contextHistoryRouter,
  contextWorkingSetRouter,
  contextAssembleRouter,
  contextObserveRouter,
  agentsRouter,
  skillsRouter,
  sessionsRouter,
  executeRouter,
  loopRouter,
  healthRouter,
]

export async function createNexusApp(options: NexusAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ ... })
  for (const router of featureRouters) {
    await router.register(app, options)
  }
  return app
}
```

Each router file owns its own `ConfigManager` access (via `options.services.configManager`), its own storage access (via `options.storage`), and its own env reads (via `options.services.env`). `app.ts` keeps only the Fastify setup, the CORS / logger plugins, the WebSocket route, and the route table.

A `FeatureRouter` interface is added to `src/nexus/router.ts`:

```ts
export type FeatureRouter = {
  register(app: FastifyInstance, options: NexusAppOptions): Promise<void>
}
```

**Status: Closed 2026-06-19, tail-cleaned 2026-06-20** — The 2026-06-19 7-slice pull (A1/A2/A3/C1/C2/C3/E1) reduced `app.ts` from 864 → 226 lines and put the file **below the `≤ 400` north-star target**. The 2026-06-20 D1/D2 tail cleanup then moved socket/security utilities into `src/shared/`, bringing `app.ts` to 191 lines. The 37× `router.register` boilerplate is collapsed into a `registerAllRouters()` factory; `/v1/execute` and `/v1/stream` are extracted into focused route modules; bootstrap status closures, cross-cutting middleware, and execute route deps are lifted into helper factories; and the shared `workingSetBroadcaster` is wired end-to-end. See [Phase 4A+ App.ts Decomposition Retrospective](#phase-4a-appts-decomposition-retrospective-2026-06-19) for the slice inventory and verification numbers.

### Stream E — `runtimePipeline.ts` factory cluster

The former 21 builder/helper functions in `runtimePipeline.ts` are organized into narrow typed submodules:

- `runtime/pipeline/turn.ts` — provider turn types, provider tool-call input resolution, assistant/tool-result message builders.
- `runtime/pipeline/providerTurn.ts` — provider turn stream collection, usage aggregation, max-token / empty-output / final-response-only outcome reduction, option-selection clarification, and leak guards.
- `runtime/pipeline/events.ts` — runtime result/error and tool-call text leak suppression event builders.
- `runtime/pipeline/context.ts` — context-grounding required/confirmed helpers, post-compact grounding events, workspace dirty detection, and git status changed-file parsing.
- `runtime/pipeline/contextRefresh.ts` — context blocking/warning/usage/microcompact/recovery events, context refresh state, and injected broadcaster publish path.
- `runtime/pipeline/cache.ts` — runtime execution metrics, execution metrics event builder, and provider/cache/prefix/compact/remote metrics absorption.
- `runtime/pipeline/loop.ts` — provider loop state, request state, query params, prefix-cache diagnostics, context character counting, final-response-only guard, system prompt blocks, and execution state block helpers.
- `runtime/pipeline/localIntent.ts` — deterministic local runtime prompt intent parser.

`runtimePipeline.ts` remains a re-export façade for back-compat. New code is required to import from the submodules directly.

### Stream F — `shared/events.ts` codegen

Two acceptable shapes:

1. **Code-generate `mapEventsToMessages`** from the Zod schema at build time. A new `scripts/generate-event-translator.ts` reads `src/shared/events.ts`, walks the discriminated union, and emits `src/shared/events/translator.ts` with a typed dispatcher. The script is wired into `npm run build`.
2. **Split `events.ts` into per-domain files** (`events/turn.ts`, `events/tool.ts`, `events/context.ts`, `events/scope.ts`, `events/memory.ts`, `events/permission.ts`, `events/hook.ts`, `events/index.ts`). Each domain file owns its event types and its `buildX` / `parseX` factory pair. `events.ts` becomes a re-export façade. `mapEventsToMessages` moves to `events/translator.ts` and is rewritten as a `Record<type, (event) => ModelMessage | null>` lookup, with an exhaustiveness check that the Zod schema can prove.

Shape 2 is preferred because it makes the schema → translator mapping explicit without a build step. The translator becomes:

```ts
const translators: Record<NexusEvent['type'], (event: NexusEvent) => MessageChunk> = {
  session_started: e => /* ... */,
  assistant_delta: e => /* ... */,
  // ... exhaustive
}
```

The TypeScript compiler will fail the build if any new event type is added without a translator entry. No codegen script, no runtime check, no test.

### Cross-cutting — `process.env` consolidation

A new `src/runtime/env.ts` exports:

```ts
export type RuntimeEnv = {
  nexus: {
    host: string
    port: number
    apiKey?: string
    executeTimeoutMs?: number
    maxConcurrentExecutions: number
    maxToolOutputBytes: number
    bashMaxBufferBytes: number
    storagePath?: string
    allowedTools?: string[]
    storageWal: StorageBridgeWalOptions
    defaultPolicyMode: 'strict' | 'soft-deny'
  }
  workspace: {
    cwd: string
  }
  feature: {
    enableMcp: boolean
    enableAgentTools: boolean
    agentExecutionEnvironment?: 'local' | 'remote'
  }
  runtime: {
    thinkingBudget?: number
    behaviorTraceEnabled: boolean
    thinkingBudgetEnv?: string
  }
}

export function parseRuntimeEnv(env: NodeJS.ProcessEnv): RuntimeEnv { /* ... */ }
```

`parseRuntimeEnv` is called once in `createDefaultNexusRuntime`. Every other module reads through `RuntimeServices.env.nexus.*`. The 17 `process.env` reads in `nexus/server.ts` collapse to a single `parseRuntimeEnv(process.env)`.

## Execution Slicing Addendum

The table below is the actual execution order. It converts the larger north-star phases into small PRs that can be reviewed, reverted, and verified independently.

| Slice | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 0.5 — Coupling Audit Baseline | Closed 2026-06-18 | Added `scripts/audit-coupling.js` and `npm run coupling:audit` to report reverse imports, known singleton state, large-file line counts, and `process.env` concentration. | Command emits machine-readable JSON; no runtime behavior changes; TODO / WORK_LOG record the baseline. |
| Phase 1A — Move Runtime-Owned Monitors | Closed 2026-06-18 | Moved `BehaviorMonitor`, `workingSetTracker`, and `PersistedWorkingSetTracker` from `nexus/` to `runtime/`; left thin `nexus/` re-export facades for compatibility. | `npm run coupling:audit` shows monitor-related `runtime -> nexus` imports removed; focused behavior-monitor / working-set / resume tests pass. |
| Phase 1B — Remove Nexus -> CLI Bootstrap Import | Closed 2026-06-18 | Removed `nexus/createRuntime.ts -> cli/everosBackgroundBootstrap` by moving the shared EverOS bootstrap implementation to `runtime/`. CLI keeps compatibility facades / policy wrapper imports. | `grep -rn 'from .\\.\\./cli' src/nexus/` returns 0; `npm run coupling:audit` reports `nexusToCli: []`; EverOS bootstrap focused tests pass. |
| Phase 2A — ProviderSessionRules Service | Closed 2026-06-18 | Replaced the module-level `providerSessionRules` `Map` with `src/runtime/providerSessionRules.ts`. `LLMCodingRuntime` owns a per-instance service; `executeProviderToolCall` accepts an injected service and falls back to a legacy default instance for compatibility. | Focused provider-session test proves two injected services do not share approval rules; `npm run coupling:audit` confirms no new reverse import. |
| Phase 2B — ContextBroadcaster Injection | Closed 2026-06-18 | Added `src/runtime/contextBroadcaster.ts` as a structural runtime interface; `refreshRuntimeContextState` accepts an injected broadcaster; `LLMCodingRuntime` passes its per-instance broadcaster; `server.ts` / embedded CLI create one shared `ContextBroadcaster` for runtime + app. Deleted `runtime/contextBroadcasterSingleton.ts`; Nexus keeps `defaultContextBroadcaster` only as a compatibility default. | `npm run coupling:audit` reports `runtimeToNexus: []`; focused runtime broadcaster injection test and context observe WebSocket tests pass. |
| Phase 2C — ConfigManager Instance Pilot | Closed 2026-06-18 | Added `new ConfigManager({ configFile })` while preserving the old string constructor; `createDefaultNexusRuntime({ configManager })` and `ExploreAgentScheduler({ configManager })` / `createExploreRuntime({ configManager })` now use injected instances. | `test/config-manager-instance.test.ts` proves two config files do not cross-talk and that injected managers select independent runtime types for Nexus and agent runtime creation. |
| Phase 3A — RuntimePipeline Submodule Split | Closed 2026-06-18 | Extracted pure helpers into `src/runtime/pipeline/{turn,events,context,contextRefresh,cache,loop,providerTurn,localIntent}.ts`; kept `runtimePipeline.ts` as a re-export façade. | Existing imports still work through `runtimePipeline.ts`; focused runtime pipeline helper tests pass; `runtimePipeline.ts` is down to 137 lines and has no inline helper implementations. |
| Phase 3B+ — LLMCodingRuntime Strategy Extraction | In Progress 2026-06-19 | Extract one strategy object or one standalone helper per PR. Landed strategy classes: `src/runtime/ContextRefreshStrategy.ts` (refresh dependency wiring + session inbox loading), `src/runtime/ProviderTurnDriver.ts` (provider adapter `queryStream` invocation + stream leak-guard setup), `src/runtime/ToolDispatchPipeline.ts` (provider tool-call dispatch coordination). Landed standalone helpers (2026-06-19 4-slice pull 3B-1/6/7/8): `src/runtime/eventsTranslator.ts` (332 lines, `mapEventsToMessages` pure event-to-provider-message translation), `src/runtime/behaviorTraceTap.ts` (175 lines, `wrapWithBehaviorTraceTap` async-generator tap + `behaviorTraceDetectionKey` helper), `src/runtime/loadWorkingSetOverride.ts` (118 lines, R2 read-side working-set override loader with rebuild fallback), `src/runtime/applyWorkingSetUpdate.ts` (83 lines, R2 write-side per-event tracker apply, fire-and-forget). 3B-19 standalone helper (2026-06-20): `src/runtime/executeProviderRecoveryDecision.ts` (382 lines, provider-loop catch-block + recovery decision tree — owns hook firing, error classification, recovered/blocked/rethrow branching, reactive compact + refresh + enforceMessageBudget sequence). The R2 wiring-guard contract test (`test/runtime-working-set-hot-path.test.ts`) is preserved by keeping thin-delegate methods on the `LLMCodingRuntime` prototype. Net effect: `LLMCodingRuntime.ts` 1841 → 1493 (-348 / -18.9%) with the runtime body main-loop orchestration still inside the class. The main-loop 25 inlined steps + the catch-block 100-line inline sequence are now each collapsed to one helper call. Next candidates: `runExecuteStreamInner` tool-call loop main body slicing (high risk — must preserve risk classifier / soft-timeout / R2 hot-path / approval chain), or `tokenBudgetEnforcer` / `riskClassifier` style side-effect helpers if they remain reviewable. | Each PR has focused tests for the extracted interface; no PR is required to hit the final 600-line target. Strategy class tests: `test/context-refresh-strategy.test.ts`, `test/provider-turn-driver.test.ts`, `test/tool-dispatch-pipeline.test.ts`, plus context/compact/tool LLMCodingRuntime focused tests and resume tests. Standalone helper tests (2026-06-19): `test/events-translator.test.ts` (14 tests), `test/behavior-trace-tap.test.ts` (6 tests), `test/load-working-set-override.test.ts` (8 tests), `test/apply-working-set-update.test.ts` (7 tests). Catch-block helper tests (3B-19, 2026-06-20): `test/execute-provider-recovery-decision.test.ts` (6 tests). `npm test` reports all green; `npm run coupling:audit` still reports `runtimeToNexus: []` / `nexusToCli: []`; `npm run docs:check` / `npm run build:smoke` green. |
| Phase 4A+ — Nexus Router Slice | Closed 2026-06-19 | Extract one low-risk router cluster per PR, and for the remaining execute/stream area first extract shared state into narrow services. Landed slices include runtime/config/memory/models/metrics/provider/loop/skill/session/schema/context/working-set/tools/session-channel routers plus observer WebSockets. Latest additions: `src/nexus/activeExecutionRegistry.ts` moved shared active execution state for `/v1/execute`, `/v1/stream`, resume, and cancel out of `app.ts`, and now returns an `ActiveExecutionLease` cleanup handle; `src/nexus/executionTimeoutEvents.ts` moved shared timeout event / watcher machinery and now owns `startExecutionTimeoutControls()` for HTTP/WS timeout controls setup; `src/nexus/executionPreparation.ts` moved shared request preparation; `src/nexus/executionFinalization.ts` moved shared session finalization, outcome, recoverable-denial, terminalReason, context-blocking recovery metadata, and loop-after settlement helpers; `src/nexus/executionEventProcessing.ts` moved execution metrics recording, cache-health event derivation, soft watchdog error decoration, and the shared single-event processing sink; `src/nexus/runtimeMetricsSnapshot.ts` moved `/v1/runtime/metrics` provider/agent/cache snapshot aggregation; `src/nexus/executionHttpResult.ts` moved HTTP `/v1/execute` result envelope/status-code assembly; `src/nexus/executionRuntimeOptions.ts` moved HTTP/WS shared `runtime.executeStream()` options assembly; `src/nexus/executionWebSocketControl.ts` moved WebSocket JSON parse / open-only send / `permission_response` fast-path control helpers, processed event forwarding, client-close tracking, and timeout/summary event sending; `src/nexus/executionStreamLoop.ts` moved shared HTTP/WS event loop control, near-timeout checkpointing, and terminal result/error tracking. **2026-06-19 review-high-risk pull landed 7 sub-slices (A1/A2/A3/C1/C2/C3/E1) and closed the app.ts gap**: `executeHttpRoute.ts` extracted the HTTP `/v1/execute` handler; `executeStreamRoute.ts` extracted the WebSocket `/v1/stream` handler; `routerRegistrar.ts` collapsed the 37× `router.register` boilerplate into a `registerAllRouters()` factory; `bootstrapStatus.ts` extracted `buildEverCoreStatus()` and `buildEverOSBootstrapStatus()` closures; `middleware.ts` extracted `setErrorHandler` + 3 `addHook` calls into focused helpers; `executeRouteDeps.ts` deduplicated the HTTP/WS shared deps literal; and the `workingSetBroadcaster` was wired end-to-end through composition root + `registerAllRouters` extras + `contextWorkingSetWriteRouter`. Net effect: `app.ts` 864 → 226 lines on 2026-06-19 (**-73.8%**) and 226 → 191 lines after the 2026-06-20 D1/D2 tail cleanup (**-77.9%** cumulative), below the north-star `≤ 400` target. | Route behavior and response shape stay identical; one focused router integration test or runtime regression lands with each slice. The landed slices are covered by the named router tests plus selected `test/runtime.test.ts` regressions, `test/working-set-observe-websocket.test.ts`, and `test/context-observe-websocket.test.ts`; active execution state / lease behavior is covered by `test/active-execution-registry.test.ts` plus focused cancel/resume/watchdog/WS timeout regressions, timeout event/control extraction by focused near-timeout / soft-timeout / extension / watchdog / WebSocket timeout regressions, execution preparation by model gate / timeout-policy / cancel-resume / cwd continuity regressions, finalization/settlement by `test/execution-settlement.test.ts` plus timeout / denial / context-blocking / basic execute regressions, event processing/sink by `test/execution-event-processing.test.ts` plus timeout / metrics / cache-health / context-blocking regressions, runtime metrics snapshot by `test/runtime-metrics-router.test.ts` plus the cache-aware metrics regression, HTTP result assembly by basic/timeout/context-blocking execute regressions, runtime execute options assembly by `test/execution-runtime-options.test.ts`, WebSocket control/forwarding/lifecycle helpers by `test/execution-websocket-control.test.ts` plus selected WS regressions, stream loop control by `test/execution-stream-loop.test.ts` plus selected execute/WS regressions. **2026-06-19 sub-slice coverage**: `test/execute-http-route.test.ts` (4 tests), `test/execute-stream-route.test.ts` (2 tests), `test/router-registrar.test.ts` (5 tests including the broadcaster-wire contract test), `test/bootstrap-status.test.ts` (5 tests), `test/middleware.test.ts` (13 tests), `test/execute-route-deps.test.ts` (6 tests). `npm test` reports 1077/1077 pass; `npm run coupling:audit` still reports `runtimeToNexus: []` and `nexusToCli: []`; `npm run docs:check` and `npm run build:smoke` green. |
| Phase 5 Watch — Events / RuntimeEnv | Watch | Defer `shared/events.ts` exhaustive translator and full `parseRuntimeEnv` rollout until Phase 1-4 reduce the hot spots. | Reconsider after reverse imports and singleton state are under control. |

Latest Phase 4A+ slice update (2026-06-20): the optional tail cleanup moved the last `app.ts` utility helpers out of the composition root. `parseSocketQuery` now lives in `src/shared/socketQuery.ts` for WebSocket/TUI reuse, and `isLocalHost` / `validateSecurityConfig` now live in `src/shared/security.ts` with compatibility re-exports from `nexus/app.ts`; `server.ts` now imports the startup validator directly from `shared/security` instead of routing through `nexus/app.ts`. `app.ts` is down to 191 lines while REST / WebSocket contracts remain unchanged. Focused regressions: `test/socket-query.test.ts`, `test/security.test.ts`, and `test/middleware.test.ts`; `npm run coupling:audit` still reports `runtimeToNexus: []` and `nexusToCli: []`. Previous same-day slices: `executeHttpRoute`, `executeStreamRoute`, `routerRegistrar`, `bootstrapStatus`, `middleware`, `executeRouteDeps`, and shared `workingSetBroadcaster` wire closed the main Phase 4A+ app.ts gap. Earlier slices: `activeExecutionRegistry` added `ActiveExecutionLease`; `executionStreamLoop` moved shared stream-loop control; `executionWebSocketControl` added forwarding/lifecycle helpers; `executionFinalization` added `settleExecutionSession()`; `executionTimeoutEvents` added `startExecutionTimeoutControls()`; `executionEventProcessing` added the shared single-event sink; `runtimeMetricsSnapshot`, `executionHttpResult`, and `executionRuntimeOptions` moved their respective execute/metrics helper boundaries; the router series moved context/session/runtime/skill/tool/agent/working-set clusters out of `app.ts`.

### Execution Rules

- Use the PR-sized phase map above for scheduling. The north-star phase map below remains the architectural destination.
- Every coupling PR must include a short audit diff: before / after for the relevant coupling fingerprint.
- Do not combine a coupling refactor with behavior fixes unless the behavior fix is the direct regression that motivates the refactor.
- Do not expand the current PR when a new coupling smell is discovered. File a `[coupling]` item in [../active/TODO_cleanup.md](../active/TODO_cleanup.md).

### Phase 4A+ App.ts Decomposition Retrospective (2026-06-19)

The 2026-06-19 review-high-risk pull landed 7 sub-slices inside the existing Phase 4A+ envelope and closed the `app.ts` ≤ 400-line gap. Each sub-slice is a PR-sized, independently-revertable change that preserved REST + WebSocket contract parity and the SQLite schema.

| Sub-slice | Module(s) created | `app.ts` Δ | Tests added | Verification |
| --- | --- | --- | --- | --- |
| **A1** HTTP `/v1/execute` route extraction | `src/nexus/executeHttpRoute.ts` (174 lines) + `ExecuteHttpRouteDeps` | -100 lines | `test/execute-http-route.test.ts` (4 tests) | `npm test` pass; `security.test.ts` still hits real `/v1/execute` |
| **A2** WebSocket `/v1/stream` route extraction | `src/nexus/executeStreamRoute.ts` (172 lines) + `ExecuteStreamRouteDeps` + local `NexusStreamSocket` type | -120 lines | `test/execute-stream-route.test.ts` (2 tests) | `npm test` pass; WebSocket upgrade contract preserved |
| **A3** 37-router registrar factory | `src/nexus/routerRegistrar.ts` (173 lines) + `RouterRegistrarExtras` | -290 lines | `test/router-registrar.test.ts` (4 tests) | `app.printRoutes()` matches full route table |
| **C1** Bootstrap status closure factories | `src/nexus/bootstrapStatus.ts` (138 lines) + `buildEverCoreStatus` / `buildEverOSBootstrapStatus`; `EverOSBootstrapStatusSnapshot` ownership moved from `router.ts` (re-exported) | -62 lines | `test/bootstrap-status.test.ts` (5 tests) | Override reference return + disabled default + 3 on-disk states |
| **C2** Cross-cutting middleware extraction | `src/nexus/middleware.ts` (152 lines) + `registerErrorHandler` / `registerRequestMetricsStamp` / `registerApiKeyAuth` / `registerResponseMetrics` / `registerCoreMiddleware` | -50 lines | `test/middleware.test.ts` (13 tests) | Validation 400, custom 418, no-key 401, Bearer header case-insensitive, `/health` bypass, route-metric key shape |
| **C3** Shared execute route deps factory | `src/nexus/executeRouteDeps.ts` (97 lines) + `ExecuteRouteSharedDeps` + `buildExecuteRouteSharedDeps` | -15 lines | `test/execute-route-deps.test.ts` (6 tests) | Field identity preservation + optional fields + structural compatibility with both route deps types |
| **E1** Shared `workingSetBroadcaster` wire | `app.ts` resolves `options.workingSetBroadcaster ?? new WorkingSetBroadcaster()`; `registerAllRouters` extras gains a required `workingSetBroadcaster` field; `contextWorkingSetWriteRouter` now reliably sees the same per-cwd tracker as `/v1/working-set/observe` | +13 lines (default broadcaster + explicit extras + comments) | `test/router-registrar.test.ts` adds wire contract test (1 test) | `broadcaster.size()` increments after PUT; `tracker.get(sessionId)` returns persisted data — proves R3 wire is live |
| **D1** Shared socket query parser | `src/shared/socketQuery.ts` (77 lines) + `parseSocketQuery()` | -27 lines | `test/socket-query.test.ts` (14 tests) | Handshake query priority, array value handling, malformed raw URL pairs, and no-query fallback preserved |
| **D2** Shared security helpers | `src/shared/security.ts` (10 lines) + `nexus/app.ts` compatibility re-export | -8 lines | `test/security.test.ts` adds shared-vs-legacy parity coverage | `isLocalHost` / `validateSecurityConfig` behavior unchanged; server and legacy app imports keep working |
| **TOTAL** | 9 new helper modules, 7 new/focused test files, 1 wire contract added to existing test | **864 → 191 (-673 lines, -77.9%)** | **50+ focused tests across the slice family** | `npm run coupling:audit` clean; focused D1/D2/middleware regression group 37/37 pass; earlier 2026-06-19 closure gates included `npm test`, `npm run deps:audit`, `npm run docs:check`, and `npm run build:smoke` |

**Cross-slice design rules that held up:**

1. **Preserve existing helper composition.** A1/A2 do not reinvent any helper modules — they just extract the route binding shell and let the existing `executionPreparation` / `executionFinalization` / `executionTimeoutEvents` / `executionHttpResult` / `executionStreamLoop` / `executionRuntimeOptions` / `executionWebSocketControl` modules keep their composition. The 174-line `executeHttpRoute.ts` is a thin wrapper, not a rewrite.
2. **`registerAllRouters` keeps router ordering.** A3 preserves the original declaration order of the 37 routers so Fastify route precedence is bit-for-bit identical to the inline block. The factory only collapses the boilerplate, not the wiring topology.
3. **Override references, not clones.** C1's `buildEverCoreStatus(override)` returns `() => override` (reference) instead of `() => ({...override})` (clone) — `runtimeStatusRouter` is a high-frequency poll path and every poll would otherwise allocate a fresh object.
4. **`apiKey === undefined` = no-op middleware.** C2's `registerApiKeyAuth(app, undefined)` short-circuits and does not register the hook, so the composition root does not have to guard.
5. **`RouterRegistrarExtras` requires `workingSetBroadcaster`.** E1 promotes the broadcaster from optional `extras.options.workingSetBroadcaster` to a required `extras.workingSetBroadcaster` field. Composition roots must now provide a default (compiler-enforced), eliminating the silent-undefined gap that allowed REST PUT mutations to skip the observer bus.
6. **`WorkingSetBroadcaster` is the canonical per-cwd tracker owner.** Both REST PUT and `/v1/working-set/observe` resolve to the same `PersistedWorkingSetTracker` instance per cwd through `broadcaster.mutate()` / `broadcaster.subscribe()`. E1's wire-contract test (`broadcaster.size()` increments after PUT) proves the closure is live, not just typed.

**Open minor candidates (no longer required for ≤ 400 target):**

- **B1 / B2**: extract shared `EXECUTION_BUSY` rejection + lease/finally cleanup into a `withExecutionLease({ gate, registry, ... })` higher-order function used by both `executeHttpRoute` and `executeStreamRoute` (~50 lines DRY).
- **F1 docs continuation**: keep this retrospective in sync with future app.ts edits.

## Phases

Each phase is an independent PR. The order below minimises cross-stream merge conflicts.

The table below is the north-star phase map. It describes the desired end state by stream. The PR-sized phase map above is the merge order and review unit.

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 0 | Active Plan | This document lands and the existing `npm run deps:audit` + `npm test` + `npm run build:smoke` are still green. | New canonical coupling reference is indexed from [reference/README.md](./README.md) and [TODO.md §Cleanup](../TODO.md); no source code is changed in this phase. |
| Phase 1 | Closed 2026-06-18 | Stream A reverse-direction cleanup. `BehaviorMonitor`, `PersistedWorkingSetTracker`, `workingSetTracker`, and the shared EverOS background bootstrap implementation now live under `runtime/`. Thin compatibility facades remain for legacy import paths. | `npm run coupling:audit` reports `nexusToCli: []` and no monitor-related `runtime -> nexus` imports; focused behavior-monitor / working-set / resume / EverOS bootstrap tests pass. |
| Phase 2 | Active Plan | Stream B singletons to `RuntimeServices`. Phase 2A moved provider session rules to an injectable service; Phase 2B removed the runtime hot-path dependency on `defaultContextBroadcaster`; Phase 2C added explicit `ConfigManager` instances and migrated the first runtime / agent composition callsites. A later Stream B slice can introduce `src/runtime/services.ts` after these smaller seams are proven. | Focused service-injection tests prove no cross-talk for each migrated service; `npm test` passes when the full Stream B migration closes. |
| Phase 3 | Active Plan | Stream C `LLMCodingRuntime` decomposition. Extract `ProviderTurnDriver`, `ContextRefreshStrategy`, `ToolDispatchPipeline`, `HookDispatcher`. The class body eventually shrinks to ≤ 600 lines. The 4 callers continue to work without change. | A new focused test per extracted class (≥ 12 tests) exercises the class boundary; the existing `test/runtime-llm.test.ts` and `test/runtime.test.ts` pass without modification; line count is tracked by `wc -l src/runtime/LLMCodingRuntime.ts`. The ≤ 600-line target is cumulative, not a single-PR merge gate. |
| Phase 4 | Closed 2026-06-19 | Stream D router split. 37 routers moved out of `app.ts`; `activeExecutionRegistry` / `executionTimeoutEvents` / `executionPreparation` / `executionFinalization` / `executionEventProcessing` / `runtimeMetricsSnapshot` / `executionHttpResult` / `executionRuntimeOptions` / `executionWebSocketControl` / `executionStreamLoop` extracted as narrow helper modules; `/v1/execute` and `/v1/stream` extracted to `executeHttpRoute.ts` / `executeStreamRoute.ts`; 37× `router.register` boilerplate collapsed into `routerRegistrar.ts`; bootstrap status + middleware + execute route deps lifted into helper factories; shared `workingSetBroadcaster` wired end-to-end. `app.ts` is now 191 lines after the D1/D2 tail cleanup — **209 lines below the north-star `≤ 400` target**. | Route behavior and response shape stay identical; one focused router integration test or runtime regression lands with each slice. The 2026-06-19 7-sub-slice pull (A1/A2/A3/C1/C2/C3/E1) closed the previous 464-line gap; see [Phase 4A+ App.ts Decomposition Retrospective](#phase-4a-appts-decomposition-retrospective-2026-06-19) for the slice inventory, line-count deltas, and verification numbers. |
| Phase 5 | Closed 2026-06-18 | Stream E `runtimePipeline.ts` factory cluster. Reorganized into narrow `runtime/pipeline/*` submodules; `runtimePipeline.ts` is a 137-line re-export façade. | Existing imports still work through the façade; new code uses the submodules directly. Phase 3B+ can now extract `LLMCodingRuntime` strategies without first untangling the helper cluster. |
| Phase 6 | Active Plan | Stream F `shared/events.ts` codegen. Split into per-domain files. `mapEventsToMessages` becomes an exhaustive `Record` lookup. | TypeScript compile fails if a new event type is added without a translator entry (verified by a small `test/event-translator-exhaustiveness.test.ts`); existing translator tests pass. |
| Phase 7 | Active Plan | Cross-cutting `process.env` consolidation. Add `parseRuntimeEnv`. Migrate `nexus/server.ts`, `nexus/app.ts`, `shared/config.ts`, `runtime/toolResultBudget.ts`, `runtime/sessionMemoryLite.ts`, `runtime/behaviorTrace.ts`. | A new focused test `test/runtime-env.test.ts` parses a synthetic env and asserts every `RuntimeEnv` field is set correctly; `grep -rn 'process\\.env' src/nexus/` returns only the 2 expected hits (one for `NEXUS_API_KEY` auth in `app.ts`, one for `parseRuntimeEnv` itself). |
| Phase 8 Watch | Watch | Long-tail: extract `SessionChannel` from `shared/sessionChannel.ts` if it grows past 600 lines; revisit the `tools/ → runtime/` import direction in `tools/everCoreMcpTools.ts`; consider a real `bbl doctor` plugin that prints the coupling heat map above. | Coupling audit output (`scripts/audit-coupling.js`) reports no P0 hot spots for 30 consecutive days. |
| Phase 9 | In Progress 2026-06-20 | Stream G Storage Decoupling. Extract `EventRepository`, `TaskRepository`, and `AuditRepository` from `SqliteStorage.ts` to reduce monolithic database complexity. Landed (3B-20): `src/storage/EventRepository.ts` (206 lines, owns events-table operations — `listEvents` / `appendEvent` / sequence allocation / duplicate-repair / sessions-table updated_at refresh / tool-trace & execution-metrics callbacks via constructor-injected options). Landed (3B-21): `src/storage/TaskRepository.ts` (166 lines, owns tasks-table operations — `saveTask` / `getTask` / `listTasks` / JSON-column serialization for `dependsOn` / `blocks` / `review` / `metadata`). Net effect: `SqliteStorage.ts` 1753 → 1594 lines (-159 / -9.1%) with the public `listEvents` / `appendEvent` / `saveTask` / `getTask` / `listTasks` methods reduced to thin delegations. The remaining inline domains — `permission_audits`, `tool_traces`, `session_channels` / `session_messages`, `agent_jobs`, `execution_metrics`, `loop_panes` — are queued for `AuditRepository` (3B-22) and follow-on slices. | `wc -l src/storage/SqliteStorage.ts` is reduced significantly (1753 → 1594), storage focused unit tests pass (`test/storage-event-repository.test.ts` 6 cases, `test/storage-task-repository.test.ts` 7 cases, plus existing `test/storage.test.ts` 2 cases stay green as byte-identical regression evidence), and session persistence remains intact (R2/R5/R7 + `npm run build:smoke` + `npm run typecheck` + `npm run format:check` + `npm run docs:check` + `npm run deps:audit` + `npm run coupling:audit` all green). |

## Verification

The plan is verified by the same gates the project already uses, plus a new dedicated coupling audit. Each phase PR must run:

- `npm run docs:check` — must pass for documentation changes.
- `npm run typecheck` — must pass.
- `npm run format:check` — must pass.
- `npm run deps:audit` — must report `failures: { missingOwnership: [], runtimeCliLeaks: [], devDependencyLeaks: [], undeclaredImports: [] }`.
- `npm run coupling:audit` — must be pasted as a before / after fingerprint for coupling PRs. Phase 0.5 is informational and exits green for known debt; later phases may add stricter thresholds once a specific hotspot is closed.
- `npm test` — must pass; the existing 80+ tests must continue to pass without modification unless a test is the direct subject of the PR.
- `npm run build:smoke` — must pass; `bbl --help`, `bbl chat --help`, `bbl run hello` must continue to work.
- `npm run test:quarantine` — state-listing only; this is not a required pass/fail gate for coupling PRs.

Every source-code coupling PR must also include:

- the smallest focused test for the touched subsystem;
- a coupling audit diff, even if the first version is a manual `grep` / `wc -l` fingerprint;
- an explicit statement that no new `runtime → nexus` import was introduced.

Phase-specific verifications:

- **Phase 1** — `grep -rn 'from .\.\./nexus' src/runtime/` must return 0 lines; `test/behavior-monitor.test.ts` (≥ 28 tests) must pass.
- **Phase 2** — `test/runtime-services-injection.test.ts` must construct two `LLMCodingRuntime` instances with different `ConfigManager` and prove no cross-talk. Existing `test/quarantine.json` entries remain unchanged.
- **Phase 3** — `wc -l src/runtime/LLMCodingRuntime.ts` must report ≤ 600 lines; per-class focused tests must cover the public surface; `test/runtime-llm.test.ts` and `test/runtime.test.ts` must pass.
- **Phase 4** — `wc -l src/nexus/app.ts` must report ≤ 400 lines; each feature router must have a focused integration test; `scripts/smoke-nexus-routes.sh` must hit one route per router.
- **Phase 5** — `runtimePipeline.ts` must stay a re-export façade; new runtime code imports from `src/runtime/pipeline/*` directly instead of adding fresh dependencies on the flat façade.
- **Phase 6** — `tsc --noEmit` must fail if a new event type is added without a translator entry; the failure message must point at the missing translator line.
- **Phase 7** — `grep -rn 'process\.env' src/nexus/` must report exactly 2 hits: the `NEXUS_API_KEY` auth check in `app.ts` and the `parseRuntimeEnv` definition itself.
- **Phase 8** — the coupling audit script must report no P0 hot spots for 30 consecutive CI runs.

Real-session regression replays (must continue to pass at every phase):

- `session_10320709` (cwd drift / context recall) — `bbl inspect-session <id> --trace` shows the same trace shape; no new `CONTEXT_STORAGE_UNAVAILABLE` event appears.
- `session_ef76f50a-` (task scope drift) — `bbl inspect-session <id> --trace` shows `task_scope_declared` / `scope_boundary_detected` / `scope_boundary_confirmed` events in the same order.
- `session_go_1781146359507755000` (embedded Nexus persistence) — `bbl go --check` shows the same storage path; restart preserves session data.

## Document Ownership

- This document is the canonical reference for module coupling governance. It supersedes any previous inline notes about coupling hot spots, reverse imports, or singleton patterns that may have been scattered across `active/TODO_cleanup.md`, `WORK_LOG.md`, and individual PR descriptions.
- This document owns the coupling roadmap only. It does not own feature behavior, runtime semantics, or public API contracts.
- Current priority and sequencing live in [../TODO.md](../TODO.md) and [../active/TODO_cleanup.md](../active/TODO_cleanup.md). This document is the *why* and *how*; the active TODO is the *what next*.
- Per-phase implementation evidence (PR numbers, test counts, regression replays) goes into [../DONE.md](../DONE.md) and [../WORK_LOG.md](../WORK_LOG.md). This document keeps only the durable phase plan.
- No phase may close without: (a) a passing `npm run deps:audit`, (b) a focused regression test, (c) an entry in [../DONE.md](../DONE.md), and (d) the `wc -l` proof of the line-count target where one is specified.
- Any new coupling hot spot discovered after Phase 0 lands must be filed as a `[coupling]` line in [../active/TODO_cleanup.md](../active/TODO_cleanup.md) and cross-referenced from this document.
- Architecture decisions taken during this plan (e.g. "the new `RuntimeServices` container does not leak into `shared/`") are recorded as ADRs in [../decisions/](../decisions/).

## 中文概述

### 背景

BabeL-O 经过多轮 P0 回归修复和功能叠加，已经积累了一份有机的耦合债。当前真实状态（2026-06-19 审计）：遗留单例入口 (`ConfigManager.getInstance()` 35 处 / 24 文件,`defaultEverCoreRuntimeManager` 10 处,以及 Nexus compatibility default `defaultContextBroadcaster` 7 处),单文件巨模块 (`LLMCodingRuntime` 1620 行 / 41 import,`nexus/app.ts` 191 行 / Phase 4A+ 收口后已低于 ≤400 目标,`shared/events.ts` 779 行 / 40 事件类型),以及 159 处 `process.env` 直读。Phase 0.5/1A/1B 已清掉 `runtime → nexus` 和 `nexus → cli` 全部反向 import；Phase 2A 已把 `providerSessionRules` 从 module-level Map 收敛为可注入服务；Phase 2B 已删除 `runtime/contextBroadcasterSingleton.ts` 并移除最后一个 `runtime → nexus` reverse import；Phase 2C 已证明 `ConfigManager` 可在同进程内双实例隔离并迁移了 runtime / agent composition 入口；Phase 3A 已把 `runtimePipeline.ts` 降为 137 行 compatibility façade。Phase 3B+ 已完成 `ContextRefreshStrategy`、`ProviderTurnDriver`、`ToolDispatchPipeline` 三个 strategy class 与 `eventsTranslator`、`behaviorTraceTap`、`loadWorkingSetOverride`、`applyWorkingSetUpdate` 四个 standalone helper（2026-06-19 4-slice pull,LLMCodingRuntime 1841 → 1620 行,-221 行 / -12.0%；R2 wiring-guard 通过 thin-delegate 保留），但主循环 25+ `yield` 调用仍在原处。Phase 4A+ 已完成 37 个 router slice，并抽出 `ActiveExecutionRegistry` / `ActiveExecutionLease`、`ExecutionTimeoutEvents`（含 timeout controls setup）、`ExecutionPreparation`、`ExecutionFinalization`（含 settlement）、`ExecutionEventProcessing`（含单事件 sink）、`RuntimeMetricsSnapshot`、`ExecutionHttpResult`、`ExecutionRuntimeOptions`、`ExecutionWebSocketControl`（含 forwarding 和 lifecycle helper）、`ExecutionStreamLoop`、A1/A2/A3/C1/C2/C3/E1 七子切片（`executeHttpRoute`、`executeStreamRoute`、`routerRegistrar`、`bootstrapStatus`、`middleware`、`executeRouteDeps`、`workingSetBroadcaster` wire），`app.ts` 已降到 191 行。`session_10320709` 的 `CONTEXT_STORAGE_UNAVAILABLE` 根因属于 [context-cwd-drift-and-recall-governance-plan.md §11](./context-cwd-drift-and-recall-governance-plan.md) Phase C2 已收口；`session_ef76f50a-` 的 task scope 修复和 `session_go_1781146359507755000` 的 embedded Nexus 持久化最初都在 `app.ts` 上叠加，现已迁出到 router 文件。

### 核心做法

本文件把耦合治理集中成一个 canonical 参考，分六条独立流：

1. **Stream A** — 已把 `BehaviorMonitor`、`PersistedWorkingSetTracker`、`workingSetTracker` 从 `nexus/` 迁回 `runtime/`，消除 4 处反向 `runtime → nexus` import 和 `BehaviorMonitor ↔ loopDiagnostics` 的循环依赖。
2. **Stream B** — 已完成 2A (`providerSessionRules` 服务化) / 2B (`ContextBroadcaster` 注入) / 2C (`ConfigManager` 实例化 pilot)；剩余 2D 引入 `RuntimeServices` 容器把 3 个 module-level singleton 改为一处构造时注入。
3. **Stream C** — 已抽取 `ContextRefreshStrategy`、`ProviderTurnDriver`、`ToolDispatchPipeline` 三个 strategy class 与 `eventsTranslator`、`behaviorTraceTap`、`loadWorkingSetOverride`、`applyWorkingSetUpdate` 四个 standalone helper（2026-06-19 4-slice pull, R2 wiring-guard 通过 thin-delegate 保留）。目标把 `LLMCodingRuntime` 拆成 `RuntimeOrchestrator` + 这些策略对象，主循环 ≤ 600 行（目前 1620 行 / 1020 行差距尚未关闭）。下一步可选切片是 `runExecuteStreamInner` tool-call loop 主体（高风险 — 必须保留 risk classifier / soft-timeout / R2 hot-path / approval chain），或 `tokenBudgetEnforcer` / `riskClassifier` 类副作用 helper。
4. **Stream D** — 已完成 37 个 router slice（远超原 14 个 router 目标）并抽出 active execution registry / lease、timeout event / controls helpers、execution preparation、execution finalization / settlement、execution event processing / sink、runtime metrics snapshot、HTTP execute result assembly、runtime execute options assembly、WebSocket control / forwarding / lifecycle helpers 与 shared stream-loop helper。2026-06-19 review-high-risk pull 把 7 个子切片（A1/A2/A3/C1/C2/C3/E1）合入，`app.ts` 从 864 行进一步降到 **226 行（-73.8%）**，并在 2026-06-20 tail cleanup 后降到 **191 行（累计 -77.9%）**，首次低于 `≤ 400` 行 north-star 目标；HTTP `/v1/execute` / WS `/v1/stream` route lifecycle、37 个 `router.register` boilerplate、bootstrap status closure、cross-cutting middleware、execute route deps 共享字段、shared `workingSetBroadcaster` 都已抽到独立模块并端到端 wire。Phase 4 收口，详情见 [Phase 4A+ App.ts Decomposition Retrospective](#phase-4a-appts-decomposition-retrospective-2026-06-19)。
5. **Stream E** — 已把 `runtimePipeline.ts` 的 21 个工厂/helper 函数拆成 `runtime/pipeline/{turn,providerTurn,events,context,contextRefresh,cache,loop,localIntent}.ts`，原文件保留为 compatibility re-export façade。
6. **Stream F** — 把 `shared/events.ts` 按域拆分子文件，`mapEventsToMessages` 改成穷尽性 `Record<type, translator>`，由 TypeScript 编译期保证新增事件类型不会忘记翻译。
7. **Stream G** — 存储层解耦（2026-06-20 起，已抽 2/3）。将 1753 行的大单体数据库管理类 `SqliteStorage.ts` 按领域拆分为主类做委托聚合：3B-20 已抽 `EventRepository`（206 行，events 表 + listEvents/appendEvent + sequence allocation + duplicate-repair + tool-trace & execution-metrics callbacks）、3B-21 已抽 `TaskRepository`（166 行，tasks 表 + saveTask/getTask/listTasks + JSON-column 序列化）。`SqliteStorage.ts` 已降到 **1594 行（-159 / -9.1%）**，listEvents/appendEvent/saveTask/getTask/listTasks 已是 thin delegation；剩余 `permission_audits` / `tool_traces` / `session_channels` + `session_messages` / `agent_jobs` / `execution_metrics` / `loop_panes` 等待 3B-22 `AuditRepository` 及后续 slice。

另外把 159 处 `process.env` 直读合并为 `parseRuntimeEnv` 一次性解析，结果注入 `RuntimeServices.env`。

### 当前状态

`npm run deps:audit` 和 `npm run coupling:audit` 当前都绿。`storage/` 是自包含层（仅依赖 `shared/`）；`providers/` 是自包含层（仅依赖 `shared/`、`./retry.js`、`./sse.js`）；`mcp/` 仅依赖 `tools/Tool.js` 和 `shared/version.js`。`skills/` 仅一处 `shared/skillEvents.js` 越层（Phase 8 Watch）。`session_10320709` 暴露的 `RuntimeExecuteOptions.storage` 漏注已经在 [context-cwd-drift-and-recall-governance-plan.md §11](./context-cwd-drift-and-recall-governance-plan.md) Phase C2 收口，根因（runtime 不能独立持有 storage 引用）属于本计划 Phase 3 后续主循环拆分的范围。

### 下一步

按 `Execution Slicing Addendum` 的 PR-sized map 继续推进。已收口:Phase 0.5 / 1A / 1B / 2A / 2B / 2C / 3A / **4A+(完整收口 — 含 2026-06-19 A1/A2/A3/C1/C2/C3/E1 七子切片,app.ts 864 → 226 → 191 行,累计 -77.9%,首次低于 ≤ 400 行目标)**。在执行中的:Phase 3B+(strategy class + 5 个 standalone helper 已抽出 — `eventsTranslator` / `behaviorTraceTap` / `loadWorkingSetOverride` / `applyWorkingSetUpdate` / `executeProviderRecoveryDecision`,LLMCodingRuntime 1841 → 1493 行 / -18.9%;主循环 25 步仍未缩)、Phase 2D (RuntimeServices 容器)、**Phase 9 Stream G 存储层解耦 (2026-06-20 起,已抽 2/3:`EventRepository` + `TaskRepository`,SqliteStorage 1753 → 1594 行 / -9.1%)**。Watch:Phase 5 (events / RuntimeEnv)、Phase 8 (tools → nexus 残留、SessionChannel 拆分)。下一步必须把 `LLMCodingRuntime.runExecuteStreamInner` 的 25 步主循环拆到独立的 `RuntimeOrchestrator`,同时继续 Phase 9 推进 `AuditRepository` (3B-22);`app.ts` 已降到 191 行,`parseSocketQuery` / `isLocalHost` / `validateSecurityConfig` tail cleanup 已完成。每一阶段都必须独立 PR、独立 regression、独立 review,且不得改动对外 REST / WebSocket 契约和 SQLite schema。不得通过"提高 `maxLoops`"、"放宽 `permissionMode`"、"忽略 `process.env` warning"等小动作来掩盖本计划要解决的耦合问题。
