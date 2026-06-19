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

## Status Update (2026-06-18)

This document is now the canonical coupling governance entry point. It should be used together with [development-process-stability-governance-plan.md](./development-process-stability-governance-plan.md): every coupling PR must follow the "one PR = one semantic slice" rule, carry explicit verification, and avoid combining behavior changes with broad documentation movement.

The line-count targets in this document are health indicators, not single-PR merge gates. `LLMCodingRuntime <= 600 lines` and `app.ts <= 400 lines` remain useful north-star outcomes, but no implementation PR should attempt to reach them in one large refactor. The actual execution path is the PR-sized phase map in [Execution Slicing Addendum](#execution-slicing-addendum).

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

- `LLMCodingRuntime` is a **1841-line class** (slightly larger than the Phase 0.5 audit baseline of 1758 because Phase 3B+ added strategy-class wiring) that 4 callers directly import (`nexus/createRuntime.ts`, `nexus/agentLoop.ts`, `nexus/agents/AgentScheduler.ts`, `cli/embedded.ts`). It carries 41 imports, owns its own `readFileCache`, and accepts an undocumented `resumeDeps` parameter object. Phase 2B removed its runtime hot-path dependency on the module-level `defaultContextBroadcaster` singleton. The 1241-line gap to the north-star `≤ 600` target has not closed.
- `src/nexus/app.ts` has been **reduced from 6170 to 864 lines** through Phase 4A+ (37 router files in `src/nexus/routers/`, plus `src/nexus/activeExecutionRegistry.ts`, `src/nexus/executionTimeoutEvents.ts`, `src/nexus/executionPreparation.ts`, `src/nexus/executionFinalization.ts`, `src/nexus/executionEventProcessing.ts`, `src/nexus/runtimeMetricsSnapshot.ts`, `src/nexus/executionHttpResult.ts`, `src/nexus/executionRuntimeOptions.ts`, `src/nexus/executionWebSocketControl.ts`, and `src/nexus/executionStreamLoop.ts`; only `/v1/execute` and `/v1/stream` remain inline). The file is still 464 lines above the north-star `≤ 400` target because it carries `FeatureRouterContext` construction helpers, WebSocket stream setup, shim closures for legacy compatibility, and route lifecycle / settlement wiring. `ConfigManager.getInstance()` moved from `app.ts` into `executionPreparation.ts`; downstream routers carry the remaining legacy callsites.
- `src/runtime/runtimePipeline.ts` is now a 137-line compatibility façade after Phase 3A. Its former helper clusters have been split into `src/runtime/pipeline/turn.ts`, `events.ts`, `context.ts`, `contextRefresh.ts`, `cache.ts`, `loop.ts`, `providerTurn.ts`, and `localIntent.ts`. Existing import paths still work through the façade, but new code should import directly from the narrower submodule it needs.
- Phase 3B+ has started with `src/runtime/ContextRefreshStrategy.ts` (56 lines), `src/runtime/ProviderTurnDriver.ts` (63 lines), and `src/runtime/ToolDispatchPipeline.ts` (135 lines). `LLMCodingRuntime` now routes hot-path context refresh / `resume()` context assembly through `ContextRefreshStrategy`, provider adapter `queryStream` + stream guard setup through `ProviderTurnDriver`, and provider tool-call dispatch coordination through `ToolDispatchPipeline`. Compact orchestration, recovery decisions, hook dispatch, and event yielding around the loop still remain in the runtime loop for later slices. The main loop body still owns 25+ `yield buildXxxEvent` calls, 5 `refreshRuntimeContextState` calls, 4 `compactSession` calls, and 14 `previousEvents.push` accumulator mutations.
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

## Problem Statement

The project has accumulated an organic, well-documented coupling debt. It is not blocking feature work today, but it produces predictable failure modes:

1. **P0 regressions root-trace to coupling.** `session_10320709` showed that `LLMCodingRuntime.runExecuteStreamInner` did not propagate `this.storage` into `RuntimeExecuteOptions`, causing `contextSearch` / `contextRecent` to return `CONTEXT_STORAGE_UNAVAILABLE`. The fix was a one-line guard, but the underlying cause — `RuntimeExecuteOptions.storage` is optional, every consumer must remember to inject it — is a coupling problem. The same pattern reappeared in `LocalCodingRuntime.runExecuteStreamInner` at line 170, requiring a separate fix.

2. **The 1841-line `LLMCodingRuntime` is a bottleneck for every review.** Every change to context assembly, tool policy, compact, provider recovery, behavior trace, or memory triggers touches this class. A future P0 that requires changing the loop body (e.g. `session_ef76f50a-` evidence-scope drift) has to navigate 25 inlined loop steps, 5 `refreshRuntimeContextState` calls, and 4 `compactSession` calls. The `resumeDeps` field is the most recent symptom: it bundles 4 closures (workingSetTracker, behaviorMonitor, buildSystemPrompt, mapEventsToMessages) because the WorkingSet / BehaviorMonitor were owned by `nexus/` until Phase 1A moved them. Phase 3B+ extracted 3 strategy objects (`ContextRefreshStrategy`, `ProviderTurnDriver`, `ToolDispatchPipeline`) but the main loop body still owns the orchestration, so the file grew from 1758 to 1841 lines.

3. **`app.ts` is a merge-conflict hot spot.** Every P0 fix over the last 30 days touched `app.ts`: `session_10320709` (cwd drift storage propagation, ~6 routes), `session_go_1781146359507755000` (embedded Nexus persistence, `/v1/runtime/status` route), `session_ef76f50a-` (task scope, ~3 routes). Phase 4A+ moved 35+ route clusters into `src/nexus/routers/`, plus active execution, timeout event/control, preparation, finalization/settlement, execution event-processing, runtime metrics snapshot, HTTP execute result, runtime execute options, WebSocket control/forwarding/lifecycle helpers, shared execution stream loop, and active execution leases into narrow modules, but `app.ts` is still 864 lines — 464 above the north-star `≤ 400` target — because it carries `FeatureRouterContext` construction, WebSocket stream setup, shim closures, and route lifecycle / settlement wiring. A modular helper split (separate from the route split) would localize the remaining conflicts.

4. **`runtimePipeline.ts` was an undeclared god module.** Before Phase 3A it had 1828 lines and 21 builder functions consumed through one flat import surface. That shape slowed reviews because a reviewer who wanted to know "what does the runtime loop depend on for context refresh?" had to grep 21 names. Phase 3A has now reduced it to a 137-line compatibility façade over narrow `runtime/pipeline/*` submodules; the remaining risk is preventing new code from re-growing the flat façade.

5. **The reverse `runtime → nexus` import direction is a layering violation that already caused one circular pair.** `BehaviorMonitor` ↔ `loopDiagnostics` is a true circular dependency, currently safe only because TypeScript allows the cycle when all references are type-only. `LLMCodingRuntime`'s `resumeDeps` is a workaround, not a fix. If a future change turns any of those type-only imports into a value import, the build will silently break. `loopDiagnostics` also reads `DEFAULT_HINT_COOLDOWN_MS` from `BehaviorMonitor`, which means cooldown tuning must touch two files in two layers.

6. **Module-level singletons prevent clean re-entry.** `ConfigManager.getInstance()` still creates global coupling for legacy callers, but Phase 2C proved explicit instances can isolate config files and wired the first runtime / agent composition paths. `defaultContextBroadcaster` no longer blocks the runtime hot path after Phase 2B, but remains as a Nexus compatibility default. The former `providerSessionRules` module-level `Map` has been removed in Phase 2A and is now an injectable service with a legacy default instance only for compatibility.

7. **`shared/events.ts` is a 779-line single point of truth.** 40 event types, 60+ consumer files, no codegen. The current `mapEventsToMessages` is a hand-written 200-line if/else, and any new event type has to be added there, in `buildXxxEvent` factories, in the Go TUI WS consumer, and in storage deserialization. A regression in one event will look like a bug in another.

8. **DI debt is concentrated, not pervasive.** `storage/`, `providers/`, `skills/`, and `mcp/` are exemplary: each is reachable only through narrow interfaces, has no module-level state, and depends on `shared/` only. The same pattern should be the *default*, not the exception. The decoupling work is therefore localized to `runtime/`, `nexus/app.ts`, `shared/config.ts`, and `shared/events.ts`.

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
| Phase 3B+ — LLMCodingRuntime Strategy Extraction | In Progress 2026-06-18 | Extract one strategy object per PR. Landed slices: `src/runtime/ContextRefreshStrategy.ts` for refresh dependency wiring and session inbox loading, `src/runtime/ProviderTurnDriver.ts` for provider adapter `queryStream` invocation plus stream leak-guard setup, and `src/runtime/ToolDispatchPipeline.ts` for provider tool-call dispatch coordination. Next candidates: hook dispatch / resume slices if they remain reviewable. | Each PR has focused tests for the extracted interface; no PR is required to hit the final 600-line target. `test/context-refresh-strategy.test.ts`, `test/provider-turn-driver.test.ts`, `test/tool-dispatch-pipeline.test.ts`, context/compact/tool LLMCodingRuntime focused tests, and resume tests pass for the landed slices. |
| Phase 4A+ — Nexus Router Slice | In Progress 2026-06-18 | Extract one low-risk router cluster per PR, and for the remaining execute/stream area first extract shared state into narrow services. Landed slices include runtime/config/memory/models/metrics/provider/loop/skill/session/schema/context/working-set/tools/session-channel routers plus observer WebSockets. Latest additions: `src/nexus/activeExecutionRegistry.ts` moved shared active execution state for `/v1/execute`, `/v1/stream`, resume, and cancel out of `app.ts`, and now returns an `ActiveExecutionLease` cleanup handle; `src/nexus/executionTimeoutEvents.ts` moved shared timeout event / watcher machinery and now owns `startExecutionTimeoutControls()` for HTTP/WS timeout controls setup; `src/nexus/executionPreparation.ts` moved shared request preparation; `src/nexus/executionFinalization.ts` moved shared session finalization, outcome, recoverable-denial, terminalReason, context-blocking recovery metadata, and loop-after settlement helpers; `src/nexus/executionEventProcessing.ts` moved execution metrics recording, cache-health event derivation, soft watchdog error decoration, and the shared single-event processing sink; `src/nexus/runtimeMetricsSnapshot.ts` moved `/v1/runtime/metrics` provider/agent/cache snapshot aggregation; `src/nexus/executionHttpResult.ts` moved HTTP `/v1/execute` result envelope/status-code assembly; `src/nexus/executionRuntimeOptions.ts` moved HTTP/WS shared `runtime.executeStream()` options assembly; `src/nexus/executionWebSocketControl.ts` moved WebSocket JSON parse / open-only send / `permission_response` fast-path control helpers, processed event forwarding, client-close tracking, and timeout/summary event sending; `src/nexus/executionStreamLoop.ts` moved shared HTTP/WS event loop control, near-timeout checkpointing, and terminal result/error tracking. Do not casually move `/v1/execute` or `/v1/stream`; remaining candidates now require `review-high-risk` planning. | Route behavior and response shape stay identical; one focused router integration test or runtime regression lands with each slice. The landed slices are covered by the named router tests plus selected `test/runtime.test.ts` regressions, `test/working-set-observe-websocket.test.ts`, and `test/context-observe-websocket.test.ts`; active execution state / lease behavior is covered by `test/active-execution-registry.test.ts` plus focused cancel/resume/watchdog/WS timeout regressions, timeout event/control extraction by focused near-timeout / soft-timeout / extension / watchdog / WebSocket timeout regressions, execution preparation by model gate / timeout-policy / cancel-resume / cwd continuity regressions, finalization/settlement by `test/execution-settlement.test.ts` plus timeout / denial / context-blocking / basic execute regressions, event processing/sink by `test/execution-event-processing.test.ts` plus timeout / metrics / cache-health / context-blocking regressions, runtime metrics snapshot by `test/runtime-metrics-router.test.ts` plus the cache-aware metrics regression, HTTP result assembly by basic/timeout/context-blocking execute regressions, runtime execute options assembly by `test/execution-runtime-options.test.ts`, WebSocket control/forwarding/lifecycle helpers by `test/execution-websocket-control.test.ts` plus selected WS regressions, and stream loop control by `test/execution-stream-loop.test.ts` plus selected execute/WS regressions. |
| Phase 5 Watch — Events / RuntimeEnv | Watch | Defer `shared/events.ts` exhaustive translator and full `parseRuntimeEnv` rollout until Phase 1-4 reduce the hot spots. | Reconsider after reverse imports and singleton state are under control. |

Latest Phase 4A+ slice update (2026-06-19): `src/nexus/executionWebSocketControl.ts` now also owns `trackWebSocketClientClose()` and `createWebSocketEventSender()`. WebSocket `/v1/stream` holds a close tracker for client-close state / cleanup and a single event sender for timeout / summary events with stream metric recording, while REST / WebSocket contracts and timeout behavior remain unchanged. Focused regression: `test/execution-websocket-control.test.ts` plus selected WebSocket runtime regressions. Previous same-day slices: `activeExecutionRegistry` added `ActiveExecutionLease`; `executionStreamLoop` moved shared stream-loop control; `executionWebSocketControl` added `forwardProcessedRuntimeEvent()` for WebSocket forwarding; `executionFinalization` added `settleExecutionSession()` for shared loop-after settlement; `executionTimeoutEvents` added `startExecutionTimeoutControls()` for shared timeout controls setup; `executionEventProcessing` added `processRuntimeExecutionEvent()` as the shared single-event sink; `executionWebSocketControl` moved WebSocket JSON parse / send / permission response helpers; `executionRuntimeOptions` moved HTTP/WS shared runtime options assembly; `executionHttpResult` moved HTTP result envelope/status-code assembly; `runtimeMetricsSnapshot` moved runtime metrics snapshot aggregation; `executionEventProcessing` initially moved execution metrics/cache-health/watchdog decoration rule helpers; `executionFinalization` initially moved finalization/outcome helpers; `executionPreparation` moved request preparation; `executionTimeoutEvents` moved timeout event and watcher helpers; `activeExecutionRegistry` moved the process-local active execution registry. Earlier slices: `contextObserveRouter` moved GET `/v1/context/observe`; `workingSetObserveRouter` moved GET `/v1/working-set/observe`; `sessionTaskMutationRouter` moved session task mutation cluster; `sessionCancelRouter` moved POST `/v1/sessions/:sessionId/cancel`; `sessionCompactRouter` moved POST `/v1/sessions/:sessionId/compact`; `sessionContextRouter` moved GET `/v1/sessions/:sessionId/context`; `sessionCloseRouter` moved POST `/v1/sessions/:sessionId/close`.

### Execution Rules

- Use the PR-sized phase map above for scheduling. The north-star phase map below remains the architectural destination.
- Every coupling PR must include a short audit diff: before / after for the relevant coupling fingerprint.
- Do not combine a coupling refactor with behavior fixes unless the behavior fix is the direct regression that motivates the refactor.
- Do not expand the current PR when a new coupling smell is discovered. File a `[coupling]` item in [../active/TODO_cleanup.md](../active/TODO_cleanup.md).

## Phases

Each phase is an independent PR. The order below minimises cross-stream merge conflicts.

The table below is the north-star phase map. It describes the desired end state by stream. The PR-sized phase map above is the merge order and review unit.

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 0 | Active Plan | This document lands and the existing `npm run deps:audit` + `npm test` + `npm run build:smoke` are still green. | New canonical coupling reference is indexed from [reference/README.md](./README.md) and [TODO.md §Cleanup](../TODO.md); no source code is changed in this phase. |
| Phase 1 | Closed 2026-06-18 | Stream A reverse-direction cleanup. `BehaviorMonitor`, `PersistedWorkingSetTracker`, `workingSetTracker`, and the shared EverOS background bootstrap implementation now live under `runtime/`. Thin compatibility facades remain for legacy import paths. | `npm run coupling:audit` reports `nexusToCli: []` and no monitor-related `runtime -> nexus` imports; focused behavior-monitor / working-set / resume / EverOS bootstrap tests pass. |
| Phase 2 | Active Plan | Stream B singletons to `RuntimeServices`. Phase 2A moved provider session rules to an injectable service; Phase 2B removed the runtime hot-path dependency on `defaultContextBroadcaster`; Phase 2C added explicit `ConfigManager` instances and migrated the first runtime / agent composition callsites. A later Stream B slice can introduce `src/runtime/services.ts` after these smaller seams are proven. | Focused service-injection tests prove no cross-talk for each migrated service; `npm test` passes when the full Stream B migration closes. |
| Phase 3 | Active Plan | Stream C `LLMCodingRuntime` decomposition. Extract `ProviderTurnDriver`, `ContextRefreshStrategy`, `ToolDispatchPipeline`, `HookDispatcher`. The class body eventually shrinks to ≤ 600 lines. The 4 callers continue to work without change. | A new focused test per extracted class (≥ 12 tests) exercises the class boundary; the existing `test/runtime-llm.test.ts` and `test/runtime.test.ts` pass without modification; line count is tracked by `wc -l src/runtime/LLMCodingRuntime.ts`. The ≤ 600-line target is cumulative, not a single-PR merge gate. |
| Phase 4 | Active Plan — 90% done | Stream D router split. 37 routers moved out of `app.ts`; `activeExecutionRegistry` / `executionTimeoutEvents` / `executionPreparation` / `executionFinalization` / `executionEventProcessing` / `runtimeMetricsSnapshot` / `executionHttpResult` / `executionRuntimeOptions` / `executionWebSocketControl` / `executionStreamLoop` extracted as narrow helper modules. `app.ts` is at 864 lines — 464 above the north-star `≤ 400` target. Only `/v1/execute` and `/v1/stream` remain inline. | Route behavior and response shape stay identical; one focused router integration test or runtime regression lands with each slice. The remaining 464-line gap is dominated by 37×`router.register(app, ctx)` boilerplate (~265 lines), `/v1/stream` WebSocket inline handler (~137 lines), and `/v1/execute` HTTP inline handler (~109 lines); collapsing the register boilerplate into a `registerRouters(app, ctx)` factory is a safe `review-high-risk` next step, but `/v1/execute` / `/v1/stream` further splitting requires `review-high-risk` planning because of WebSocket lifecycle and active-execution lease semantics. |
| Phase 5 | Closed 2026-06-18 | Stream E `runtimePipeline.ts` factory cluster. Reorganized into narrow `runtime/pipeline/*` submodules; `runtimePipeline.ts` is a 137-line re-export façade. | Existing imports still work through the façade; new code uses the submodules directly. Phase 3B+ can now extract `LLMCodingRuntime` strategies without first untangling the helper cluster. |
| Phase 6 | Active Plan | Stream F `shared/events.ts` codegen. Split into per-domain files. `mapEventsToMessages` becomes an exhaustive `Record` lookup. | TypeScript compile fails if a new event type is added without a translator entry (verified by a small `test/event-translator-exhaustiveness.test.ts`); existing translator tests pass. |
| Phase 7 | Active Plan | Cross-cutting `process.env` consolidation. Add `parseRuntimeEnv`. Migrate `nexus/server.ts`, `nexus/app.ts`, `shared/config.ts`, `runtime/toolResultBudget.ts`, `runtime/sessionMemoryLite.ts`, `runtime/behaviorTrace.ts`. | A new focused test `test/runtime-env.test.ts` parses a synthetic env and asserts every `RuntimeEnv` field is set correctly; `grep -rn 'process\\.env' src/nexus/` returns only the 2 expected hits (one for `NEXUS_API_KEY` auth in `app.ts`, one for `parseRuntimeEnv` itself). |
| Phase 8 Watch | Watch | Long-tail: extract `SessionChannel` from `shared/sessionChannel.ts` if it grows past 600 lines; revisit the `tools/ → runtime/` import direction in `tools/everCoreMcpTools.ts`; consider a real `bbl doctor` plugin that prints the coupling heat map above. | Coupling audit output (`scripts/audit-coupling.js`) reports no P0 hot spots for 30 consecutive days. |

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

BabeL-O 经过多轮 P0 回归修复和功能叠加，已经积累了一份有机的耦合债。当前真实状态（2026-06-19 审计）：遗留单例入口 (`ConfigManager.getInstance()` 35 处 / 24 文件,`defaultEverCoreRuntimeManager` 10 处,以及 Nexus compatibility default `defaultContextBroadcaster` 7 处),单文件巨模块 (`LLMCodingRuntime` 1841 行 / 41 import，`nexus/app.ts` 864 行 / 37 个 feature router + 2 inline route，`shared/events.ts` 779 行 / 40 事件类型)，以及 159 处 `process.env` 直读。Phase 0.5/1A/1B 已清掉 `runtime → nexus` 和 `nexus → cli` 全部反向 import；Phase 2A 已把 `providerSessionRules` 从 module-level Map 收敛为可注入服务；Phase 2B 已删除 `runtime/contextBroadcasterSingleton.ts` 并移除最后一个 `runtime → nexus` reverse import；Phase 2C 已证明 `ConfigManager` 可在同进程内双实例隔离并迁移了 runtime / agent composition 入口；Phase 3A 已把 `runtimePipeline.ts` 降为 137 行 compatibility façade。Phase 3B+ 已完成 `ContextRefreshStrategy`、`ProviderTurnDriver`、`ToolDispatchPipeline` 三个 strategy class（但 `LLMCodingRuntime` 主体未缩，主循环 25+ `yield` 调用仍在原处）。Phase 4A+ 已完成 37 个 router slice，并抽出 `ActiveExecutionRegistry` / `ActiveExecutionLease`、`ExecutionTimeoutEvents`（含 timeout controls setup）、`ExecutionPreparation`、`ExecutionFinalization`（含 settlement）、`ExecutionEventProcessing`（含单事件 sink）、`RuntimeMetricsSnapshot`、`ExecutionHttpResult`、`ExecutionRuntimeOptions`、`ExecutionWebSocketControl`（含 forwarding 和 lifecycle helper）、`ExecutionStreamLoop` 等 execute/stream 或 runtime metrics 共享边界模块，但 `app.ts` 的 execute/stream route wiring 仍未拆。`session_10320709` 的 `CONTEXT_STORAGE_UNAVAILABLE` 根因属于 [context-cwd-drift-and-recall-governance-plan.md §11](./context-cwd-drift-and-recall-governance-plan.md) Phase C2 已收口；`session_ef76f50a-` 的 task scope 修复和 `session_go_1781146359507755000` 的 embedded Nexus 持久化最初都在 `app.ts` 上叠加，现已迁出到 router 文件。

### 核心做法

本文件把耦合治理集中成一个 canonical 参考，分六条独立流：

1. **Stream A** — 已把 `BehaviorMonitor`、`PersistedWorkingSetTracker`、`workingSetTracker` 从 `nexus/` 迁回 `runtime/`，消除 4 处反向 `runtime → nexus` import 和 `BehaviorMonitor ↔ loopDiagnostics` 的循环依赖。
2. **Stream B** — 已完成 2A (`providerSessionRules` 服务化) / 2B (`ContextBroadcaster` 注入) / 2C (`ConfigManager` 实例化 pilot)；剩余 2D 引入 `RuntimeServices` 容器把 3 个 module-level singleton 改为一处构造时注入。
3. **Stream C** — 已抽取 `ContextRefreshStrategy`、`ProviderTurnDriver`、`ToolDispatchPipeline` 三个 strategy class，目标把 `LLMCodingRuntime` 拆成 `RuntimeOrchestrator` + 这些策略对象，主循环 ≤ 600 行（目前 1841 行 / 1241 行差距尚未关闭）。
4. **Stream D** — 已完成 37 个 router slice（远超原 14 个 router 目标）并抽出 active execution registry / lease、timeout event / controls helpers、execution preparation、execution finalization / settlement、execution event processing / sink、runtime metrics snapshot、HTTP execute result assembly、runtime execute options assembly、WebSocket control / forwarding / lifecycle helpers 与 shared stream-loop helper，`app.ts` 从 6170 行降到 864 行；剩余是 `app.ts` 的 execute / stream lifecycle、response/socket cleanup 与 shim closure 拆分，目标 ≤ 400 行。
5. **Stream E** — 已把 `runtimePipeline.ts` 的 21 个工厂/helper 函数拆成 `runtime/pipeline/{turn,providerTurn,events,context,contextRefresh,cache,loop,localIntent}.ts`，原文件保留为 compatibility re-export façade。
6. **Stream F** — 把 `shared/events.ts` 按域拆分子文件，`mapEventsToMessages` 改成穷尽性 `Record<type, translator>`，由 TypeScript 编译期保证新增事件类型不会忘记翻译。

另外把 159 处 `process.env` 直读合并为 `parseRuntimeEnv` 一次性解析，结果注入 `RuntimeServices.env`。

### 当前状态

`npm run deps:audit` 和 `npm run coupling:audit` 当前都绿。`storage/` 是自包含层（仅依赖 `shared/`）；`providers/` 是自包含层（仅依赖 `shared/`、`./retry.js`、`./sse.js`）；`mcp/` 仅依赖 `tools/Tool.js` 和 `shared/version.js`。`skills/` 仅一处 `shared/skillEvents.js` 越层（Phase 8 Watch）。`session_10320709` 暴露的 `RuntimeExecuteOptions.storage` 漏注已经在 [context-cwd-drift-and-recall-governance-plan.md §11](./context-cwd-drift-and-recall-governance-plan.md) Phase C2 收口，根因（runtime 不能独立持有 storage 引用）属于本计划 Phase 3 后续主循环拆分的范围。

### 下一步

按 `Execution Slicing Addendum` 的 PR-sized map 继续推进。已收口:Phase 0.5 / 1A / 1B / 2A / 2B / 2C / 3A / 4A+(37 routers + ActiveExecutionRegistry/Lease + ExecutionTimeoutEvents/Controls + ExecutionPreparation + ExecutionFinalization/Settlement + ExecutionEventProcessing/Sink + RuntimeMetricsSnapshot + ExecutionHttpResult + ExecutionRuntimeOptions + ExecutionWebSocketControl/Forwarding/Lifecycle + ExecutionStreamLoop)。在执行中的:Phase 3B+ (LLMCodingRuntime strategy 抽取,主循环未缩)、Phase 2D (RuntimeServices 容器)。Watch:Phase 5 (events / RuntimeEnv)、Phase 8 (tools → nexus 残留、SessionChannel 拆分)。下一步必须把 `app.ts` 864 行中的 `/v1/execute`、`/v1/stream`、route lifecycle / response/socket cleanup 与 shim closure 拆分作为单独 `review-high-risk` 设计;把 `LLMCodingRuntime.runExecuteStreamInner` 的 25 步主循环拆到独立的 `RuntimeOrchestrator`。每一阶段都必须独立 PR、独立 regression、独立 review,且不得改动对外 REST / WebSocket 契约和 SQLite schema。不得通过"提高 `maxLoops`"、"放宽 `permissionMode`"、"忽略 `process.env` warning"等小动作来掩盖本计划要解决的耦合问题。
