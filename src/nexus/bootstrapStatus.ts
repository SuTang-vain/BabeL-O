/**
 * Phase 4A+ slice — `bootstrapStatus.ts`
 *
 * Extracts the `everCoreStatus` and `everOSBootstrapStatus` closure
 * factories from `src/nexus/app.ts` into a focused module. Both
 * factories are constructed once per app and called on every
 * `/v1/runtime/status` poll from the Go TUI, so they must remain cheap
 * to invoke (a single `readFileSync` or an object clone — no network
 * or DB round-trip).
 *
 * Goals:
 * - One small reviewable file that documents the runtime status and
 *   MemoryOS bootstrap status shapes used by `runtimeStatusRouter`.
 * - Preserve exact return-shape parity: the snapshot object built here
 *   must match what the inline closure in `app.ts` previously returned.
 * - Eliminate ~65 lines of bootstrap-related closure boilerplate from
 *   `app.ts`.
 *
 * Non-goals:
 * - Do not change the `EverOSBootstrapStatusSnapshot` shape — the
 *   `runtimeStatusRouter` consumer depends on every field.
 * - Do not introduce new runtime dependencies; this module reads the
 *   bootstrap state via the existing `readEverOSBootstrapStateSync`
 *   helper.
 * - Do not move the type definition for `EverOSBootstrapStatusSnapshot`
 *   — it is re-exported from `router.ts` for backward compatibility.
 */

import { readEverOSBootstrapStateSync } from '../shared/everosBootstrapStore.js'
import type { EverCoreStatus } from './everCoreConfig.js'

export type EverOSBootstrapStatusSnapshot = {
  configured: boolean
  path: string
  status: 'not_configured' | 'invalid' | string
  optedIn?: boolean
  optedOut?: boolean
  externalHintShown?: boolean
  sourceRepo?: string
  sourceRef?: string
  sourceCommit?: string
  sourceDir?: string
  dataDir?: string
  managedCommand?: string
  lastCheckedAt?: string
  lastBuildAt?: string
  errorCode?: import('../shared/everosBootstrapStore.js').EverOSBootstrapErrorCode
  errorMessage?: string
  autoBootstrapPolicy?: 'off' | 'on' | 'prompt'
  fallbackBuildTool?: 'uv' | 'pip' | 'none'
  mcpToolsEnabled?: boolean
}

/**
 * Default `EverCoreStatus` snapshot used when the composition root
 * does not pass an explicit `everCoreStatus` override. The shape mirrors
 * what `everCoreConfig.ts` produces for a "disabled" configuration
 * (the configuration exists but is not active).
 */
const DISABLED_EVER_CORE_STATUS: EverCoreStatus = {
  configured: false,
  enabled: false,
  healthy: true,
  mode: 'disabled' as const,
  uploadOnSessionEnd: false,
  mcpToolsEnabled: false,
  namespace: {
    layer: 'project_memory' as const,
    isolationKey: 'projectId' as const,
    sessionScoped: false,
    projectIdSource: 'default' as const,
  },
}

/**
 * Build an `everCoreStatus()` closure suitable for the
 * `FeatureRouterContext`. If `override` is provided, every call returns
 * that exact reference (cheap reference return). Otherwise the default
 * disabled snapshot is returned.
 */
export function buildEverCoreStatus(override?: EverCoreStatus): () => EverCoreStatus {
  if (override) {
    return () => override
  }
  return () => DISABLED_EVER_CORE_STATUS
}

/**
 * Build an `everOSBootstrapStatus()` closure suitable for the
 * `FeatureRouterContext`. Each invocation reads the on-disk bootstrap
 * state via `readEverOSBootstrapStateSync` and normalises it into the
 * shape consumed by `runtimeStatusRouter` and the Go TUI footer.
 *
 * The underlying `readFileSync` is intentionally synchronous because
 * the runtime status endpoint is polled on every UI refresh — making
 * it async would serialize every poll behind an event-loop tick.
 */
export function buildEverOSBootstrapStatus(): () => EverOSBootstrapStatusSnapshot {
  return (): EverOSBootstrapStatusSnapshot => {
    const read = readEverOSBootstrapStateSync()
    if (!read.ok) {
      return {
        configured: false,
        path: read.path,
        status: 'invalid',
        errorCode: read.errorCode,
        errorMessage: read.errorMessage,
      }
    }
    if (!read.exists || !read.state) {
      return {
        configured: false,
        path: read.path,
        status: 'not_configured',
      }
    }
    return {
      configured: true,
      path: read.path,
      status: read.state.buildStatus ?? 'not_started',
      optedIn: read.state.optedIn === true,
      optedOut: read.state.optedOut === true,
      externalHintShown: read.state.externalHintShown === true,
      sourceRepo: read.state.sourceRepo,
      sourceRef: read.state.sourceRef,
      sourceCommit: read.state.sourceCommit,
      sourceDir: read.state.sourceDir,
      dataDir: read.state.dataDir,
      managedCommand: read.state.managedCommand,
      lastCheckedAt: read.state.lastCheckedAt,
      lastBuildAt: read.state.lastBuildAt,
      errorCode: read.state.errorCode ?? undefined,
      errorMessage: read.state.errorMessage ?? undefined,
      autoBootstrapPolicy: read.state.autoBootstrapPolicy,
      fallbackBuildTool: read.state.fallbackBuildTool,
      mcpToolsEnabled: read.state.mcpToolsEnabled,
    }
  }
}
