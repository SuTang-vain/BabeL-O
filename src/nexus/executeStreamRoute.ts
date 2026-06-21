/**
 * Phase 4A+ slice — `executeStreamRoute.ts`
 *
 * Extracts the WebSocket `/v1/stream` route handler from `src/nexus/app.ts`
 * into a focused module. The handler remains registered inline in
 * `createNexusApp`, but its body is composed here from the already-
 * extracted executionPreparation / executionFinalization /
 * executionTimeoutEvents / executionStreamLoop / executionRuntimeOptions /
 * executionWebSocketControl helpers, so any future change can be reviewed
 * in this 160-line file instead of `app.ts`.
 *
 * Goals:
 * - One small reviewable file that documents the WebSocket execute lifecycle.
 * - Preserve existing behavior: 429 EXECUTION_BUSY rejection, permission
 *   response fast-path, prepare / timeout / run / settle phases, lease
 *   release + client-close tracker cleanup in finally, stream metrics.
 * - Keep all helper imports from this file's sibling modules; do not
 *   introduce new coupling.
 *
 * Non-goals:
 * - Do not change the request body schema, error envelope shape, the
 *   `EXECUTION_BUSY` / `INVALID_REQUEST` error codes, or the WebSocket
 *   event ordering contract.
 * - Do not move the route registration itself into a FeatureRouter —
 *   the `executionGate` instance is per-app and the WebSocket route
 *   currently co-locates with the HTTP route for symmetric lease handling.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { NexusEvent } from '../shared/events.js'
import { nowIso } from '../shared/id.js'
import type { NexusRuntime } from '../runtime/Runtime.js'
import type { RemoteToolRunner } from '../runtime/remoteRunner.js'
import type { BehaviorMonitor } from '../runtime/behaviorMonitor.js'
import type { NexusStorage } from '../storage/Storage.js'
import { logger } from '../shared/logger.js'

import { executeSchema, isPrepareError, prepareExecution } from './executionPreparation.js'
import { settleExecutionSession } from './executionFinalization.js'
import { startExecutionTimeoutControls } from './executionTimeoutEvents.js'
import { runExecutionStreamLoop } from './executionStreamLoop.js'
import { buildRuntimeExecuteOptions } from './executionRuntimeOptions.js'
import {
  createWebSocketEventSender,
  forwardProcessedRuntimeEvent,
  parseJsonObject,
  resolvePermissionResponseMessage,
  sendJson,
  trackWebSocketClientClose,
  type WebSocketCloseTrackable,
} from './executionWebSocketControl.js'

/**
 * The full `@fastify/websocket` socket shape — extends the minimal
 * `WebSocketLike` helper type with the `.on` / `.once` / `.off` event
 * methods we use for `message` and `close` lifecycle handling.
 */
type NexusStreamSocket = WebSocketCloseTrackable & {
  on(event: 'message', listener: (raw: Buffer) => void): void
}
import type { NexusMetrics } from './metrics.js'
import type { ExecutionGate } from './executionGate.js'
import type { ActiveExecutionRegistry, ActiveExecutionLease } from './activeExecutionRegistry.js'

export type ExecuteStreamRouteDeps = {
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
}

/**
 * Register the WebSocket `/v1/stream` route against the provided Fastify
 * instance. The handler shape, message codes, and event ordering are
 * identical to the previous inline definition in `src/nexus/app.ts`.
 */
export function registerExecuteStreamRoute(app: FastifyInstance, deps: ExecuteStreamRouteDeps): void {
  app.get('/v1/stream', { websocket: true }, (socket: NexusStreamSocket) => {
    socket.on('message', async (raw: Buffer) => {
      const parsedJson = parseJsonObject(raw)
      if (resolvePermissionResponseMessage(parsedJson)) return

      const clientCloseTracker = trackWebSocketClientClose(socket)

      const releaseExecution = deps.executionGate.tryAcquire()
      if (!releaseExecution) {
        deps.metrics.recordStreamRejected()
        sendJson(socket, {
          type: 'error',
          code: 'EXECUTION_BUSY',
          message: 'Nexus execution capacity is full. Try again shortly.',
        })
        clientCloseTracker.cleanup()
        return
      }

      deps.metrics.recordStreamStart()
      const startedAtMs = deps.metrics.now()
      let abortController: AbortController | undefined
      let activeExecutionLease: ActiveExecutionLease | undefined
      socket.once('close', () => abortController?.abort())

      // Hard watchdog timer (Bug fix 2026-06-21). Registered later
      // — after prepareExecution() resolves the timeoutDecision
      // and abortController — so it can read both values. The
      // `setTimeout` is registered immediately after the runtime
      // stream loop is set up; if it fires, the provider stream
      // is force-aborted and the WS client gets a clear
      // REQUEST_TIMEOUT event with details.kind='watchdog'.

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
          storage: deps.storage,
          defaultCwd: deps.defaultCwd,
          remoteRunnerAvailable: Boolean(deps.remoteRunner),
          executeTimeoutMs: deps.executeTimeoutMs,
          executePolicyMode: deps.executePolicyMode,
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
        activeExecutionLease = deps.activeExecutionRegistry.register(sessionId, {
          requestId,
          abortController,
          transport: 'websocket',
          startedAt: nowIso(),
        })
        const timeout = prepared.timeout
        const events: NexusEvent[] = []
        const sendTimeoutEvent = createWebSocketEventSender(socket, deps.metrics)
        const timeoutControls = startExecutionTimeoutControls({
          storage: deps.storage,
          events,
          sessionId,
          requestId,
          timeoutDecision: prepared.timeoutDecision,
          startedAtMs,
          now: () => deps.metrics.now(),
          send: sendTimeoutEvent,
        })
        const { effectiveTimeoutMs } = timeoutControls

        // Hard watchdog (Bug fix 2026-06-21): before this, the only
        // path that aborted a hung stream consumer was socket close
        // (line 109). If the provider stream went silent — DeepSeek
        // V4 + long-thinking model has been observed to emit
        // hundreds of thinking_delta chunks and then never resume,
        // captured against session_ffd44ccf-7f3b-4597-9844-a077f41a8967
        // on 2026-06-20 — the runtime's `for await (const ev of
        // stream)` blocked indefinitely. softTimeoutMs only fires
        // `near_timeout_warning` / `timeout_extension_granted` events
        // but never aborts. This timer closes the gap: when the
        // provider fails to yield ANY event for `watchdogTimeoutMs`,
        // force-abort the stream consumer and push REQUEST_TIMEOUT.
        // The downstream `for await` throws AbortError, which the
        // recovery decision tree already classifies as `timedOut=true`.
        // Normal healthy streams finish well before this fires, so
        // the cost is one `setTimeout` registration per request.
        const watchdogMs = prepared.timeoutDecision.watchdogTimeoutMs
        const watchdogTimer = watchdogMs > 0
          ? setTimeout(() => {
              const elapsedMs = deps.metrics.now() - startedAtMs
              logger.warn(
                `hard watchdog fired: provider stream unresponsive for ${elapsedMs}ms (session=${sessionId})`,
              )
              prepared.watchdog.fired = true
              try {
                sendJson(socket, {
                  type: 'error',
                  code: 'REQUEST_TIMEOUT',
                  message: `Provider stream did not yield events within ${watchdogMs}ms; aborting.`,
                  details: { kind: 'watchdog', elapsedMs, timeoutMs: watchdogMs },
                })
              } catch {
                // socket may already be closed; abort will tear down
              }
              abortController?.abort()
            }, watchdogMs)
          : null

        try {
          const loopResult = await runExecutionStreamLoop({
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
            timeoutDecision: prepared.timeoutDecision,
            watchdog: prepared.watchdog,
            timeoutMs: effectiveTimeoutMs,
            startedAtMs,
            now: () => deps.metrics.now(),
            behaviorMonitor: deps.behaviorMonitor,
            sendTimeoutEvent,
            forwardProcessedEvent: processed =>
              forwardProcessedRuntimeEvent(socket, processed, deps.metrics, streamAbortController),
          })
          success = loopResult.success
          timedOut = loopResult.timedOut
        } finally {
          timeoutControls.cancel()
          clearTimeout(timeout)
          if (watchdogTimer) clearTimeout(watchdogTimer)
        }
        timedOut = timedOut || abortController.signal.aborted
        const settlement = await settleExecutionSession({
          storage: deps.storage,
          sessionId,
          requestId,
          events,
          timedOut,
          timeoutMs: effectiveTimeoutMs,
          startedAtMs,
          now: () => deps.metrics.now(),
          send: sendTimeoutEvent,
          initialSucceeded: success,
        })
        success = settlement.succeeded
      } finally {
        clientCloseTracker.cleanup()
        activeExecutionLease?.release()
        releaseExecution()
        deps.metrics.recordStreamFinish({
          success,
          timedOut,
          clientClosed: clientCloseTracker.closedByClient,
          durationMs: deps.metrics.now() - startedAtMs,
        })
      }
    })
  })
}
