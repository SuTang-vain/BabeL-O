import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { NexusRuntime } from '../runtime/Runtime.js'
import type { EverCoreClient } from '../runtime/everCoreClient.js'
import type { RemoteToolRunner } from '../runtime/remoteRunner.js'
import type { EverCoreRuntimeConfig, EverCoreStatus } from './everCoreConfig.js'
import type { MemoryProvider } from '../runtime/memoryProvider.js'
import type { RemoteRunnerStatus } from './remoteRunnerConfig.js'
import type { NexusEvent } from '../shared/events.js'
import { nowIso } from '../shared/id.js'
import type { NexusStorage } from '../storage/Storage.js'
import { ExecutionGate } from './executionGate.js'
import { NexusMetrics } from './metrics.js'
import { ActiveExecutionRegistry, type ActiveExecutionLease } from './activeExecutionRegistry.js'
import { executeSchema, isPrepareError, prepareExecution } from './executionPreparation.js'
import {
  settleExecutionSession,
} from './executionFinalization.js'
import { buildExecuteResultEnvelope } from './executionHttpResult.js'
import {
  startExecutionTimeoutControls,
} from './executionTimeoutEvents.js'
import { runExecutionStreamLoop } from './executionStreamLoop.js'
import { buildRuntimeExecuteOptions } from './executionRuntimeOptions.js'
import {
  createWebSocketEventSender,
  forwardProcessedRuntimeEvent,
  parseJsonObject,
  resolvePermissionResponseMessage,
  sendJson,
  trackWebSocketClientClose,
  type WebSocketLike,
} from './executionWebSocketControl.js'
import { buildRuntimeMetricsSnapshot } from './runtimeMetricsSnapshot.js'
import { ExploreAgentScheduler } from './agents/AgentScheduler.js'
import type { AgentScheduler } from './agents/types.js'
import { readEverOSBootstrapStateSync } from '../shared/everosBootstrapStore.js'
import { runtimeStatusRouter } from './routers/runtimeStatusRouter.js'
import { runtimeConfigMutationRouter } from './routers/runtimeConfigMutationRouter.js'
import { runtimeConfigRouter } from './routers/runtimeConfigRouter.js'
import { contextHistoryRouter } from './routers/contextHistoryRouter.js'
import { contextWorkingSetReadRouter } from './routers/contextWorkingSetReadRouter.js'
import { contextWorkingSetWriteRouter } from './routers/contextWorkingSetWriteRouter.js'
import { contextAssembleRouter } from './routers/contextAssembleRouter.js'
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
import { toolsAuditRouter } from './routers/toolsAuditRouter.js'
import { agentRouter } from './routers/agentRouter.js'
import { sessionChannelRouter } from './routers/sessionChannelRouter.js'
import { sessionReadRouter } from './routers/sessionReadRouter.js'
import { sessionWaitRouter } from './routers/sessionWaitRouter.js'
import { sessionChildrenRouter } from './routers/sessionChildrenRouter.js'
import { sessionInspectionRouter } from './routers/sessionInspectionRouter.js'
import { sessionCreateRouter } from './routers/sessionCreateRouter.js'
import { sessionTaskReadRouter } from './routers/sessionTaskReadRouter.js'
import { sessionTaskMutationRouter } from './routers/sessionTaskMutationRouter.js'
import { sessionResumeRouter } from './routers/sessionResumeRouter.js'
import { sessionPermissionRouter } from './routers/sessionPermissionRouter.js'
import { sessionInputRouter } from './routers/sessionInputRouter.js'
import { sessionCloseRouter } from './routers/sessionCloseRouter.js'
import { sessionCancelRouter } from './routers/sessionCancelRouter.js'
import { sessionContextRouter } from './routers/sessionContextRouter.js'
import { sessionCompactRouter } from './routers/sessionCompactRouter.js'
import { workingSetObserveRouter } from './routers/workingSetObserveRouter.js'
import { contextObserveRouter } from './routers/contextObserveRouter.js'
import type { EverOSBootstrapStatusSnapshot } from './router.js'

export {
  parseSinceFromQuery,
  runBehaviorTraceGet,
  runContextHistory,
  type ContextHistoryParams,
} from './routers/contextHistoryRouter.js'
export {
  runContextAssemble,
  type ContextAssembleParams,
  type ContextAssembleScope,
} from './routers/contextAssembleRouter.js'
export {
  runWorkingSetGet,
  runWorkingSetList,
  runWorkspaceWorkingSetGet,
  type WorkingSetSession,
  type WorkspaceAggregatedEntry,
  type WorkspaceEntryContributor,
} from './routers/contextWorkingSetReadRouter.js'
export { runWorkingSetPut } from './routers/contextWorkingSetWriteRouter.js'

declare module 'fastify' {
  interface FastifyRequest {
    performanceStartMs: number
  }
}

export type CreateNexusAppOptions = {
  runtime: NexusRuntime
  storage: NexusStorage
  defaultCwd: string
  /**
   * PR-27: Optional shared WorkingSetBroadcaster. When provided, the
   * /v1/working-set/observe WebSocket and any future REST handlers that
   * opt in will share a per-cwd PersistedWorkingSetTracker instance, so
   * mutations flow into the same event bus that subscribers are listening
   * on. If not provided, a default per-app broadcaster is created.
   */
  workingSetBroadcaster?: import('./workingSetBroadcaster.js').WorkingSetBroadcaster
  /**
   * Optional ContextBroadcaster instance for /v1/context/observe.
   * Composition roots that need live runtime fan-out should pass the
   * same instance to createDefaultNexusRuntime({ contextBroadcaster }).
   * When omitted, the route uses the legacy default instance.
   */
  contextBroadcaster?: import('./contextBroadcaster.js').ContextBroadcaster
  /**
   * Optional BehaviorMonitor for cross-session event ingestion.
   * When provided, every Nexus event yielded during execution is
   * fed to behaviorMonitor.ingest() so that the 3 cross-session
   * detectors (hot-path, tool-storm, scope-drift-wave) receive
   * real event data. Without this, detectAll() always returns
   * empty results. The monitor is created per-cwd inside
   * createDefaultNexusRuntime(); server.ts passes it through.
   */
  behaviorMonitor?: import('../runtime/behaviorMonitor.js').BehaviorMonitor
  executeTimeoutMs?: number
  /**
   * Server-side default for the per-request `policy` body field. When a
   * request body omits `policy`, this value is used. Defaults to
   * `'strict'` to preserve existing HTTP API behavior. Go TUI overrides
   * per-request to `'soft-deny'`.
   */
  executePolicyMode?: 'strict' | 'soft-deny'
  maxConcurrentExecutions?: number
  maxToolOutputBytes?: number
  bashMaxBufferBytes?: number
  apiKey?: string
  remoteRunner?: RemoteToolRunner
  remoteRunnerStatus?: RemoteRunnerStatus
  everCoreClient?: EverCoreClient
  everCoreConfig?: EverCoreRuntimeConfig
  everCoreStatus?: EverCoreStatus
  memoryProvider?: MemoryProvider
  agentScheduler?: AgentScheduler
  agentExecutionEnvironment?: 'local' | 'remote'
}

export async function createNexusApp(options: CreateNexusAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const metrics = new NexusMetrics()
  /**
   * §3.5 Memory Quality Metrics: in-process counters for
   * `memory_save_note` approval / denial / pending-review. The
   * counts reset on Nexus restart (process-local, not durable),
   * which is consistent with the v1 contract: §3.5 metrics are
   * recent-window quality signals, not audit history. The
   * `memory_candidate` governance metadata on SessionChannel
   * messages is the durable per-candidate record.
   */
  const memoryApprovalCounters = { approved: 0, denied: 0, pendingReview: 0 }
  const apiKey = options.apiKey ?? process.env.NEXUS_API_KEY
  const executeTimeoutMs = options.executeTimeoutMs ?? 30_000
  const executePolicyMode = options.executePolicyMode ?? 'strict'
  const maxToolOutputBytes = options.maxToolOutputBytes ?? 200_000
  const bashMaxBufferBytes = options.bashMaxBufferBytes ?? 1_000_000
  const executionGate = new ExecutionGate(options.maxConcurrentExecutions ?? 8)
  const activeExecutionRegistry = new ActiveExecutionRegistry()
  const agentScheduler =
    options.agentScheduler ??
    new ExploreAgentScheduler({
      storage: options.storage,
      cwd: options.defaultCwd,
      executionEnvironment: options.agentExecutionEnvironment,
      remoteRunner: options.remoteRunner,
    })
  await app.register(websocket)

  const everCoreStatus = () =>
    options.everCoreStatus ?? {
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
   * MemoryOS bootstrap status snapshot used by `/v1/runtime/status`
   * (and `/v1/runtime/memory/status`). The Go TUI's persistent
   * `[m: …]` footer reads this field via the runtime status poll,
   * so the function must be safe to call synchronously on every
   * poll — the underlying `readEverOSBootstrapStateSync` is a single
   * readFileSync, not a network round-trip.
   */
  const everOSBootstrapStatus = (): EverOSBootstrapStatusSnapshot => {
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

  app.setErrorHandler((error: any, request, reply) => {
    const isValidationError = error.validation || error.name === 'ZodError' || error.statusCode === 400

    if (isValidationError) {
      return reply.status(400).send({
        type: 'error',
        code: 'INVALID_REQUEST',
        message: error.message || String(error),
      })
    }

    const code = (error as { code?: string }).code || 'INTERNAL_ERROR'
    const statusCode = error.statusCode || 500
    return reply.status(statusCode).send({
      type: 'error',
      code,
      message: error.message || String(error),
    })
  })

  app.addHook('onRequest', async request => {
    request.performanceStartMs = metrics.now()
  })

  if (apiKey) {
    app.addHook('onRequest', async (request, reply) => {
      const pathname = request.url.split('?')[0]
      if (pathname === '/health') {
        return
      }

      const authHeader = request.headers['authorization']
      let clientKey = request.headers['x-nexus-api-key']
      if (!clientKey && typeof authHeader === 'string') {
        const parts = authHeader.split(' ')
        if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
          clientKey = parts[1]
        }
      }

      if (clientKey !== apiKey) {
        return reply.code(401).send({
          type: 'error',
          code: 'UNAUTHORIZED',
          message: 'Unauthorized: Invalid or missing API key',
        })
      }
    })
  }

  app.addHook('onResponse', async (request, reply) => {
    metrics.recordRoute(`${request.method} ${request.routeOptions.url ?? request.url}`, reply.statusCode, metrics.now() - request.performanceStartMs)
  })

  await runtimeStatusRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await runtimeConfigRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await runtimeConfigMutationRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await runtimeMemoryRouter.register(app, {
    options,
    metrics,
    memoryApprovalCounters,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await runtimeModelsRouter.register(app, {
    options,
    metrics,
    memoryApprovalCounters,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await runtimeMetricsRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await runtimeProviderDiagnosticsRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await runtimeLoopHealthRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await loopWorkspaceRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await loopPaneRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await skillReadRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await skillValidateRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await skillActionRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await schemaRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await contextHistoryRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await contextWorkingSetReadRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await contextWorkingSetWriteRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await contextAssembleRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await toolsAuditRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await agentRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
    agentScheduler,
  })
  await sessionChannelRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await sessionReadRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await sessionCreateRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await sessionWaitRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await sessionChildrenRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await sessionInspectionRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await sessionTaskReadRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await sessionTaskMutationRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await sessionResumeRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
    getActiveExecutionSnapshot: sessionId => activeExecutionRegistry.snapshot(sessionId),
  })
  await sessionPermissionRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await sessionInputRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await sessionCloseRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await sessionCancelRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
    cancelActiveExecution: sessionId => activeExecutionRegistry.cancel(sessionId),
  })
  await sessionContextRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await sessionCompactRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await workingSetObserveRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })
  await contextObserveRouter.register(app, {
    options,
    metrics,
    everCoreStatus,
    everOSBootstrapStatus,
    runtimeMetricsSnapshot: () => buildRuntimeMetricsSnapshot(metrics, options.storage),
  })

  // === 路径 C: 结束 ===

  app.post('/v1/execute', async (request, reply) => {
    const releaseExecution = executionGate.tryAcquire()
    if (!releaseExecution) {
      metrics.recordExecuteRejected()
      return reply.code(429).send({
        type: 'error',
        code: 'EXECUTION_BUSY',
        message: 'Nexus execution capacity is full. Try again shortly.',
      })
    }
    metrics.recordExecuteStart()
    const startedAtMs = metrics.now()
    let activeExecutionLease: ActiveExecutionLease | undefined
    try {
      const body = executeSchema.parse(request.body)
      const prepared = await prepareExecution(body, {
        storage: options.storage,
        defaultCwd: options.defaultCwd,
        remoteRunnerAvailable: Boolean(options.remoteRunner),
        executeTimeoutMs,
        executePolicyMode,
      })
      if (isPrepareError(prepared)) {
        return reply.status(prepared.status).send({
          type: 'error',
          code: prepared.code,
          message: prepared.message,
        })
      }
      const { sessionId, cwd, requestId, abortController, timeoutController, timeout, timeoutDecision } = prepared
      activeExecutionLease = activeExecutionRegistry.register(sessionId, {
        requestId,
        abortController,
        transport: 'http',
        startedAt: nowIso(),
      })

      const events: NexusEvent[] = []
      const timeoutControls = startExecutionTimeoutControls({
        storage: options.storage,
        events,
        sessionId,
        requestId,
        timeoutDecision,
        startedAtMs,
        now: () => metrics.now(),
      })
      const { effectiveTimeoutMs } = timeoutControls
      try {
        await runExecutionStreamLoop({
          runtime: options.runtime,
          runtimeOptions: buildRuntimeExecuteOptions({
            body,
            prepared,
            maxToolOutputBytes,
            bashMaxBufferBytes,
            storage: options.storage,
            remoteRunner: options.remoteRunner,
          }),
          events,
          sessionId,
          cwd,
          requestId,
          storage: options.storage,
          metrics,
          timeoutDecision,
          watchdog: prepared.watchdog,
          timeoutMs: effectiveTimeoutMs,
          startedAtMs,
          now: () => metrics.now(),
          behaviorMonitor: options.behaviorMonitor,
        })
      } finally {
        timeoutControls.cancel()
        clearTimeout(timeout)
      }

      const timedOut = abortController.signal.aborted
      const settlement = await settleExecutionSession({
        storage: options.storage,
        sessionId,
        requestId,
        events,
        timedOut,
        timeoutMs: effectiveTimeoutMs,
        startedAtMs,
        now: () => metrics.now(),
      })
      metrics.recordExecuteFinish({
        success: settlement.succeeded,
        timedOut: timedOut || settlement.timeoutEvent,
        durationMs: metrics.now() - startedAtMs,
      })

      return buildExecuteResultEnvelope({
        sessionId,
        succeeded: settlement.succeeded,
        events,
        resultEvent: settlement.resultEvent,
        errorEvent: settlement.errorEvent,
        timeoutMs: effectiveTimeoutMs,
        executeDurationMs: settlement.executeDurationMs,
        summaryEvent: settlement.summaryEvent,
      })
    } finally {
      activeExecutionLease?.release()
      releaseExecution()
    }
  })

  app.get('/v1/stream', { websocket: true }, socket => {
    socket.on('message', async (raw: Buffer) => {
      const parsedJson = parseJsonObject(raw)
      if (resolvePermissionResponseMessage(parsedJson)) return

      const clientCloseTracker = trackWebSocketClientClose(socket)

      const releaseExecution = executionGate.tryAcquire()
      if (!releaseExecution) {
        metrics.recordStreamRejected()
        sendJson(socket, {
          type: 'error',
          code: 'EXECUTION_BUSY',
          message: 'Nexus execution capacity is full. Try again shortly.',
        })
        clientCloseTracker.cleanup()
        return
      }

      metrics.recordStreamStart()
      const startedAtMs = metrics.now()
      let abortController: AbortController | undefined
      let activeExecutionLease: ActiveExecutionLease | undefined
      socket.once('close', () => abortController?.abort())

      let success = false
      let timedOut = false
      try {
        const parsed = executeSchema.safeParse(parsedJson)
        if (!parsed.success) {
          sendJson(socket, {
            type: 'error',
            code: 'INVALID_REQUEST',
            message: z.prettifyError(parsed.error),
          })
          return
        }

        const body = parsed.data
        const prepared = await prepareExecution(body, {
          storage: options.storage,
          defaultCwd: options.defaultCwd,
          remoteRunnerAvailable: Boolean(options.remoteRunner),
          executeTimeoutMs,
          executePolicyMode,
        })
        if (isPrepareError(prepared)) {
          sendJson(socket, {
            type: 'error',
            code: prepared.code,
            message: prepared.message,
          })
          return
        }
        const { sessionId, cwd, requestId } = prepared
        abortController = prepared.abortController
        const streamAbortController = prepared.abortController
        activeExecutionLease = activeExecutionRegistry.register(sessionId, {
          requestId,
          abortController,
          transport: 'websocket',
          startedAt: nowIso(),
        })
        const timeout = prepared.timeout
        const events: NexusEvent[] = []
        const sendTimeoutEvent = createWebSocketEventSender(socket, metrics)
        const timeoutControls = startExecutionTimeoutControls({
          storage: options.storage,
          events,
          sessionId,
          requestId,
          timeoutDecision: prepared.timeoutDecision,
          startedAtMs,
          now: () => metrics.now(),
          send: sendTimeoutEvent,
        })
        const { effectiveTimeoutMs } = timeoutControls

        try {
          const loopResult = await runExecutionStreamLoop({
            runtime: options.runtime,
            runtimeOptions: buildRuntimeExecuteOptions({
              body,
              prepared,
              maxToolOutputBytes,
              bashMaxBufferBytes,
              storage: options.storage,
              remoteRunner: options.remoteRunner,
            }),
            events,
            sessionId,
            cwd,
            requestId,
            storage: options.storage,
            metrics,
            timeoutDecision: prepared.timeoutDecision,
            watchdog: prepared.watchdog,
            timeoutMs: effectiveTimeoutMs,
            startedAtMs,
            now: () => metrics.now(),
            behaviorMonitor: options.behaviorMonitor,
            sendTimeoutEvent,
            forwardProcessedEvent: processed => forwardProcessedRuntimeEvent(socket, processed, metrics, streamAbortController),
          })
          success = loopResult.success
          timedOut = loopResult.timedOut
        } finally {
          timeoutControls.cancel()
          clearTimeout(timeout)
        }
        timedOut = timedOut || abortController.signal.aborted
        const settlement = await settleExecutionSession({
          storage: options.storage,
          sessionId,
          requestId,
          events,
          timedOut,
          timeoutMs: effectiveTimeoutMs,
          startedAtMs,
          now: () => metrics.now(),
          send: sendTimeoutEvent,
          initialSucceeded: success,
        })
        success = settlement.succeeded
      } finally {
        clientCloseTracker.cleanup()
        activeExecutionLease?.release()
        releaseExecution()
        metrics.recordStreamFinish({
          success,
          timedOut,
          clientClosed: clientCloseTracker.closedByClient,
          durationMs: metrics.now() - startedAtMs,
        })
      }
    })
  })

  return app
}

// PR-27: parse WebSocket query string. Robust to either @fastify/websocket
// shape (handshake.query object) or raw URL on `socket.url`.
function parseSocketQuery(socket: { url?: string; handshake?: { query?: Record<string, unknown> } }): Record<string, string | undefined> {
  const handshakeQuery = socket.handshake?.query
  if (handshakeQuery && typeof handshakeQuery === 'object') {
    const out: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(handshakeQuery)) {
      if (typeof v === 'string') out[k] = v
      else if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0]
    }
    return out
  }
  const url = socket.url
  if (typeof url !== 'string') return {}
  const qIdx = url.indexOf('?')
  if (qIdx < 0) return {}
  const out: Record<string, string | undefined> = {}
  const search = url.slice(qIdx + 1)
  for (const pair of search.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq < 0) {
      out[decodeURIComponent(pair)] = ''
    } else {
      const key = decodeURIComponent(pair.slice(0, eq))
      const val = decodeURIComponent(pair.slice(eq + 1))
      out[key] = val
    }
  }
  return out
}

export function isLocalHost(h: string): boolean {
  const normalized = h.toLowerCase().trim()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
}

export function validateSecurityConfig(host: string, apiKey: string | undefined): void {
  if (!isLocalHost(host) && !apiKey) {
    throw new Error(`Security Error: Running Nexus on non-localhost (${host}) requires setting the NEXUS_API_KEY environment variable.`)
  }
}
