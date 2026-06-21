/**
 * Phase 2D — `src/runtime/services.ts`
 *
 * `RuntimeServices` is the typed composition-root container for the
 * Nexus / runtime service surface. It owns:
 *
 * - `configManager` — `ConfigManager` (Phase 2C explicit instance)
 * - `contextBroadcaster` — `ContextBroadcaster` (Phase 2B runtime
 *   hot-path injection)
 * - `everCoreManager` — `EverCoreRuntimeManager` (still a
 *   module-level singleton elsewhere; this container captures the
 *   composition-root reference so legacy callers fall through to
 *   `services.everCoreManager` instead of the singleton)
 * - `providerSessionRules` — `ProviderSessionRules` (Phase 2A
 *   injectable service)
 * - `env` — `RuntimeEnv` snapshot (Phase 7 `parseRuntimeEnv`)
 *
 * Why extracted:
 *
 * - Before Phase 2D, the Nexus composition root in
 *   `src/nexus/server.ts` and the CLI composition root in
 *   `src/cli/embedded.ts` both reached for module-level singletons
 *   (`ConfigManager.getInstance()`, `defaultContextBroadcaster`,
 *   `defaultEverCoreRuntimeManager`). The 35 `getInstance()` callsites
 *   and 10 `defaultEverCoreRuntimeManager` references spread
 *   composition knowledge across the codebase, hiding the runtime
 *   contract that the composition root is the only place that
 *   constructs these services.
 *
 * - The container is constructed once in `createDefaultNexusRuntime`
 *   and passed explicitly to the runtime / Nexus / CLI consumers.
 *   Each consumer can either accept a `RuntimeServices` argument or
 *   continue to use the legacy default for back-compat, but the
 *   composition root now has a single typed surface that documents
 *   the full set of runtime-owned services.
 *
 * - Per `module-coupling-decoupling-and-re-aggregation-plan.md` Phase 2
 *   stop rule (2026-06-21), Phase 2 closes when this container lands
 *   and the remaining module-level singletons collapse into it.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: every `ConfigManager.getInstance()`
 *   call that previously reached the singleton now goes through
 *   `services.configManager`. Every `defaultContextBroadcaster`
 *   reference now goes through `services.contextBroadcaster`. Every
 *   `defaultEverCoreRuntimeManager` reference now goes through
 *   `services.everCoreManager`. Backward-compat default singletons
 *   remain in place for legacy callers that do not yet accept the
 *   container.
 *
 * - Eliminate the implicit composition contract. After this slice,
 *   `grep -rn 'ConfigManager.getInstance' src/nexus/` should drop to
 *   the single composition-root call inside `createRuntimeServices`.
 *
 * Non-goals:
 *
 * - Do not refactor `LLMCodingRuntime` to take `RuntimeServices` in
 *   this slice. The `resumeDeps` field already carries a subset of
 *   runtime closures; that migration is a separate follow-up.
 * - Do not delete the legacy `defaultContextBroadcaster` /
 *   `defaultEverCoreRuntimeManager` exports. They remain for
 *   callers that do not yet accept `RuntimeServices`.
 * - Do not move `RuntimeServices` into `src/runtime/`. The container
 *   references Nexus-owned service classes
 *   (`ContextBroadcaster`, `EverCoreRuntimeManager`) and is a
 *   Nexus composition-root concern. It lives in `src/nexus/` so the
 *   `nexus → runtime` direction stays clean (the runtime side
 *   receives the container by value or by type-only import).
 *   `parseRuntimeEnv` and the `RuntimeEnv` type live in
 *   `src/runtime/env.ts` because the env contract is a runtime
 *   composition concern that does not depend on Nexus-owned types.
 */

import { ConfigManager } from '../shared/config.js'
import { ContextBroadcaster } from './contextBroadcaster.js'
import {
  EverCoreRuntimeManager,
  defaultEverCoreRuntimeManager,
} from './everCoreRuntimeManager.js'
import { ProviderSessionRules } from '../runtime/providerSessionRules.js'
import { parseRuntimeEnv, type RuntimeEnv } from '../runtime/env.js'

export type RuntimeServices = {
  configManager: ConfigManager
  contextBroadcaster: ContextBroadcaster
  everCoreManager: EverCoreRuntimeManager
  providerSessionRules: ProviderSessionRules
  env: RuntimeEnv
}

export type CreateRuntimeServicesOptions = {
  configManager?: ConfigManager
  contextBroadcaster?: ContextBroadcaster
  everCoreManager?: EverCoreRuntimeManager
  providerSessionRules?: ProviderSessionRules
  env?: RuntimeEnv
  processEnv?: NodeJS.ProcessEnv
  homeDir?: string
}

/**
 * Build the `RuntimeServices` container. By default each field is
 * the legacy module-level instance (`ConfigManager.getInstance()`,
 * `defaultContextBroadcaster`, `defaultEverCoreRuntimeManager`, a
 * fresh `ProviderSessionRules`, and `parseRuntimeEnv(process.env)`).
 * Test code and the composition root pass explicit instances to
 * avoid coupling to module-level state.
 */
export function createRuntimeServices(
  options: CreateRuntimeServicesOptions = {},
): RuntimeServices {
  return {
    configManager: options.configManager ?? ConfigManager.getInstance(),
    contextBroadcaster: options.contextBroadcaster ?? new ContextBroadcaster(),
    everCoreManager: options.everCoreManager ?? defaultEverCoreRuntimeManager,
    providerSessionRules: options.providerSessionRules ?? new ProviderSessionRules(),
    env: options.env ?? parseRuntimeEnv(options.processEnv ?? process.env, options.homeDir),
  }
}
