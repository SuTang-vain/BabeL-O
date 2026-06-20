/**
 * Phase 4A+ slice — `routerRegistrar.ts`
 *
 * Extracts the 37× `router.register(app, { ... })` boilerplate from
 * `src/nexus/app.ts` into a single factory function. Each router is
 * registered against a shared `FeatureRouterContext` built once here.
 * Routers that need extra context (memoryApprovalCounters,
 * agentScheduler, getActiveExecutionSnapshot, cancelActiveExecution)
 * receive them via the `extras` field that the registrar merges into
 * the shared context.
 *
 * Goals:
 * - One small reviewable file that documents the router ordering and
 *   shared context construction.
 * - Preserve existing route ordering and per-router extras exactly.
 * - Eliminate ~250 lines of duplicated `router.register` boilerplate
 *   from `app.ts`.
 *
 * Non-goals:
 * - Do not change the FeatureRouterContext shape or any router's extras.
 * - Do not move router files themselves — only the registration site.
 * - Do not introduce new dependency on runtime/pipeline modules.
 */

import type { FastifyInstance } from 'fastify'
import type { FeatureRouter, FeatureRouterContext } from './router.js'
import type { CreateNexusAppOptions } from './app.js'
import type { WorkingSetBroadcaster } from './workingSetBroadcaster.js'
import { runtimeStatusRouter } from './routers/runtimeStatusRouter.js'
import { runtimeConfigRouter } from './routers/runtimeConfigRouter.js'
import { runtimeConfigMutationRouter } from './routers/runtimeConfigMutationRouter.js'
import { runtimeMemoryRouter } from './routers/runtimeMemoryRouter.js'
import { runtimeModelsRouter } from './routers/runtimeModelsRouter.js'
import { runtimeMetricsRouter } from './routers/runtimeMetricsRouter.js'
import { runtimeProviderDiagnosticsRouter } from './routers/runtimeProviderDiagnosticsRouter.js'
import { runtimeLoopHealthRouter } from './routers/runtimeLoopHealthRouter.js'
import { loopWorkspaceRouter } from './routers/loopWorkspaceRouter.js'
import { loopPaneRouter } from './routers/loopPaneRouter.js'
import { skillReadRouter } from './routers/skillReadRouter.js'
import { skillValidateRouter } from './routers/skillValidateRouter.js'
import { skillActionRouter } from './routers/skillActionRouter.js'
import { schemaRouter } from './routers/schemaRouter.js'
import { contextHistoryRouter } from './routers/contextHistoryRouter.js'
import { contextWorkingSetReadRouter } from './routers/contextWorkingSetReadRouter.js'
import { contextWorkingSetWriteRouter } from './routers/contextWorkingSetWriteRouter.js'
import { contextAssembleRouter } from './routers/contextAssembleRouter.js'
import { contextObserveRouter } from './routers/contextObserveRouter.js'
import { toolsAuditRouter } from './routers/toolsAuditRouter.js'
import { agentRouter } from './routers/agentRouter.js'
import { sessionChannelRouter } from './routers/sessionChannelRouter.js'
import { sessionReadRouter } from './routers/sessionReadRouter.js'
import { sessionCreateRouter } from './routers/sessionCreateRouter.js'
import { sessionWaitRouter } from './routers/sessionWaitRouter.js'
import { sessionChildrenRouter } from './routers/sessionChildrenRouter.js'
import { sessionInspectionRouter } from './routers/sessionInspectionRouter.js'
import { sessionTaskReadRouter } from './routers/sessionTaskReadRouter.js'
import { sessionTaskMutationRouter } from './routers/sessionTaskMutationRouter.js'
import { sessionResumeRouter } from './routers/sessionResumeRouter.js'
import { sessionResumePreviewRouter } from './routers/sessionResumePreviewRouter.js'
import { sessionPermissionRouter } from './routers/sessionPermissionRouter.js'
import { sessionInputRouter } from './routers/sessionInputRouter.js'
import { sessionCloseRouter } from './routers/sessionCloseRouter.js'
import { sessionCancelRouter } from './routers/sessionCancelRouter.js'
import { sessionContextRouter } from './routers/sessionContextRouter.js'
import { sessionCompactRouter } from './routers/sessionCompactRouter.js'
import { workingSetObserveRouter } from './routers/workingSetObserveRouter.js'
import type { ActiveExecutionRegistry } from './activeExecutionRegistry.js'
import type { AgentScheduler } from './agents/types.js'
import type { NexusMetrics } from './metrics.js'
import { buildRuntimeMetricsSnapshot } from './runtimeMetricsSnapshot.js'
import type { EverOSBootstrapStatusSnapshot } from './router.js'
import type { EverCoreStatus } from './everCoreConfig.js'

/**
 * Inputs that are not on the FeatureRouterContext shape but must be
 * available to specific routers. The registrar spreads these into the
 * shared context so each router can read them from `context`.
 */
export type RouterRegistrarExtras = {
  options: CreateNexusAppOptions
  metrics: NexusMetrics
  everCoreStatus: () => EverCoreStatus
  everOSBootstrapStatus: () => EverOSBootstrapStatusSnapshot
  memoryApprovalCounters?: {
    approved: number
    denied: number
    pendingReview: number
  }
  activeExecutionRegistry: ActiveExecutionRegistry
  agentScheduler: AgentScheduler
  /**
   * R3 of docs/nexus/proposals/long-running-context-assembly.md §20:
   * the composition-root-resolved shared WorkingSetBroadcaster. The
   * composition root (`createNexusApp`) is responsible for providing a
   * default instance when the caller omits one, so this field is
   * always non-undefined. Routers that need to mutate or subscribe to
   * per-cwd working-set state read it from the shared context.
   */
  workingSetBroadcaster: WorkingSetBroadcaster
}

/**
 * Build the shared `FeatureRouterContext` once and register all 37
 * feature routers in their original declaration order. Each router
 * receives the same context object; the `runtimeMetricsSnapshot`
 * closure captures the live `metrics` and `storage` references so
 * later reads see up-to-date values.
 */
export async function registerAllRouters(app: FastifyInstance, extras: RouterRegistrarExtras): Promise<void> {
  const sharedContext: FeatureRouterContext = {
    options: extras.options,
    metrics: extras.metrics,
    memoryApprovalCounters: extras.memoryApprovalCounters,
    everCoreStatus: extras.everCoreStatus,
    everOSBootstrapStatus: extras.everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(extras.metrics, extras.options.storage),
    getActiveExecutionSnapshot: sessionId => extras.activeExecutionRegistry.snapshot(sessionId),
    cancelActiveExecution: sessionId => extras.activeExecutionRegistry.cancel(sessionId),
    agentScheduler: extras.agentScheduler,
    // R3: forward the resolved shared broadcaster so REST PUT can route
    // mutations through the same per-cwd tracker that /v1/working-set/observe
    // subscribes to. The composition root always provides a default,
    // so this is non-undefined at this point.
    workingSetBroadcaster: extras.workingSetBroadcaster,
  }

  // Declaration order is significant: it determines the Fastify route
  // registration order. Keep this list in the same order as the original
  // inline registration block in `src/nexus/app.ts` so route precedence
  // and any implicit ordering invariants are preserved.
  const routers: FeatureRouter[] = [
    runtimeStatusRouter,
    runtimeConfigRouter,
    runtimeConfigMutationRouter,
    runtimeMemoryRouter,
    runtimeModelsRouter,
    runtimeMetricsRouter,
    runtimeProviderDiagnosticsRouter,
    runtimeLoopHealthRouter,
    loopWorkspaceRouter,
    loopPaneRouter,
    skillReadRouter,
    skillValidateRouter,
    skillActionRouter,
    schemaRouter,
    contextHistoryRouter,
    contextWorkingSetReadRouter,
    contextWorkingSetWriteRouter,
    contextAssembleRouter,
    toolsAuditRouter,
    agentRouter,
    sessionChannelRouter,
    sessionReadRouter,
    sessionCreateRouter,
    sessionWaitRouter,
    sessionChildrenRouter,
    sessionInspectionRouter,
    sessionTaskReadRouter,
    sessionTaskMutationRouter,
    sessionResumeRouter,
    sessionResumePreviewRouter,
    sessionPermissionRouter,
    sessionInputRouter,
    sessionCloseRouter,
    sessionCancelRouter,
    sessionContextRouter,
    sessionCompactRouter,
    workingSetObserveRouter,
    contextObserveRouter,
  ]

  for (const router of routers) {
    await router.register(app, sharedContext)
  }
}
