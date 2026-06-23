/**
 * Phase 4A+ slice — `executeHttpRoute.ts`
 *
 * Extracts the HTTP `/v1/execute` route handler from `src/nexus/app.ts`
 * into a focused module. The handler remains registered inline in
 * `createNexusApp`, but its body is composed here from the already-
 * extracted executionPreparation / executionFinalization /
 * executionTimeoutEvents / executionHttpResult / executionStreamLoop /
 * executionRuntimeOptions helpers, so any future change can be reviewed
 * in this 130-line file instead of `app.ts`.
 *
 * Goals:
 * - One small reviewable file that documents the HTTP execute lifecycle.
 * - Preserve existing behavior: 429 EXECUTION_BUSY rejection, prepare /
 *   timeout / run / settle phases, lease release in finally.
 * - Keep all helper imports from this file's sibling modules; do not
 *   introduce new coupling.
 *
 * Non-goals:
 * - Do not change the request body schema, response envelope shape, or
 *   the `EXECUTION_BUSY` error code.
 * - Do not move the route registration itself into a FeatureRouter —
 *   the `executionGate` instance is per-app and the HTTP route currently
 *   co-locates with the WebSocket route for symmetric lease handling.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { NexusEvent } from '../shared/events.js'
import { nowIso } from '../shared/id.js'
import type { NexusRuntime } from '../runtime/Runtime.js'
import type { RemoteToolRunner } from '../runtime/remoteRunner.js'
import type { BehaviorMonitor } from '../runtime/behaviorMonitor.js'
import type { NexusStorage } from '../storage/Storage.js'

import { executeSchema, isPrepareError, prepareExecution } from './executionPreparation.js'
import { settleExecutionSession } from './executionFinalization.js'
import { startExecutionTimeoutControls } from './executionTimeoutEvents.js'
import { buildExecuteResultEnvelope } from './executionHttpResult.js'
import { runExecutionStreamLoop } from './executionStreamLoop.js'
import { buildRuntimeExecuteOptions } from './executionRuntimeOptions.js'
import type { NexusMetrics } from './metrics.js'
import type { ExecutionGate } from './executionGate.js'
import type { ActiveExecutionRegistry, ActiveExecutionLease } from './activeExecutionRegistry.js'
import type { ShutdownSignal } from './daemonLifecycle.js'

export type ExecuteHttpRouteDeps = {
  runtime: NexusRuntime
  storage: NexusStorage
  remoteRunner?: RemoteToolRunner
  executeTimeoutMs: number
  executePolicyMode: 'strict' | 'soft-deny'
  maxToolOutputBytes: number
  bashMaxBufferBytes: number
  defaultCwd: string
  executionGate: ExecutionGate
  metrics: NexusMetrics
  activeExecutionRegistry: ActiveExecutionRegistry
  behaviorMonitor?: BehaviorMonitor
  /** Daemon graceful-shutdown flag (Phase 1 of the daemon shutdown plan). */
  shutdownSignal?: ShutdownSignal
}

/**
 * Register the HTTP `/v1/execute` route against the provided Fastify
 * instance. The handler shape, response codes, and error envelope are
 * identical to the previous inline definition in `src/nexus/app.ts`.
 */
export function registerExecuteHttpRoute(app: FastifyInstance, deps: ExecuteHttpRouteDeps): void {
  app.post('/v1/execute', async (request: FastifyRequest, reply: FastifyReply) => {
    // Daemon graceful shutdown (Phase 1 of daemon shutdown plan): reject
    // new leases once shutdown has begun, in the canonical error envelope.
    if (deps.shutdownSignal?.isShuttingDown) {
      return reply.code(503).send({
        type: 'error',
        code: 'SHUTTING_DOWN',
        message: 'Nexus daemon is shutting down. Retry against the next instance.',
      })
    }
    const releaseExecution = deps.executionGate.tryAcquire()
    if (!releaseExecution) {
      deps.metrics.recordExecuteRejected()
      return reply.code(429).send({
        type: 'error',
        code: 'EXECUTION_BUSY',
        message: 'Nexus execution capacity is full. Try again shortly.',
      })
    }
    deps.metrics.recordExecuteStart()
    const startedAtMs = deps.metrics.now()
    let activeExecutionLease: ActiveExecutionLease | undefined
    try {
      const body = executeSchema.parse(request.body)
      const prepared = await prepareExecution(body, {
        storage: deps.storage,
        defaultCwd: deps.defaultCwd,
        remoteRunnerAvailable: Boolean(deps.remoteRunner),
        executeTimeoutMs: deps.executeTimeoutMs,
        executePolicyMode: deps.executePolicyMode,
      })
      if (isPrepareError(prepared)) {
        return reply.status(prepared.status).send({
          type: 'error',
          code: prepared.code,
          message: prepared.message,
        })
      }
      const { sessionId, cwd, requestId, abortController, timeoutController, timeout, timeoutDecision } = prepared
      activeExecutionLease = deps.activeExecutionRegistry.register(sessionId, {
        requestId,
        abortController,
        transport: 'http',
        startedAt: nowIso(),
      })

      const events: NexusEvent[] = []
      const timeoutControls = startExecutionTimeoutControls({
        storage: deps.storage,
        events,
        sessionId,
        requestId,
        timeoutDecision,
        startedAtMs,
        now: () => deps.metrics.now(),
      })
      const { effectiveTimeoutMs } = timeoutControls
      try {
        await runExecutionStreamLoop({
          runtime: deps.runtime,
          runtimeOptions: buildRuntimeExecuteOptions({
            body,
            prepared,
            maxToolOutputBytes: deps.maxToolOutputBytes,
            bashMaxBufferBytes: deps.bashMaxBufferBytes,
            storage: deps.storage,
            remoteRunner: deps.remoteRunner,
          }),
          events,
          sessionId,
          cwd,
          requestId,
          storage: deps.storage,
          metrics: deps.metrics,
          timeoutDecision,
          watchdog: prepared.watchdog,
          timeoutMs: effectiveTimeoutMs,
          startedAtMs,
          now: () => deps.metrics.now(),
          behaviorMonitor: deps.behaviorMonitor,
        })
      } finally {
        timeoutControls.cancel()
        clearTimeout(timeout)
      }

      const timedOut = abortController.signal.aborted
      const settlement = await settleExecutionSession({
        storage: deps.storage,
        sessionId,
        requestId,
        events,
        timedOut,
        timeoutMs: effectiveTimeoutMs,
        startedAtMs,
        now: () => deps.metrics.now(),
      })
      deps.metrics.recordExecuteFinish({
        success: settlement.succeeded,
        timedOut: timedOut || settlement.timeoutEvent,
        durationMs: deps.metrics.now() - startedAtMs,
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
}
