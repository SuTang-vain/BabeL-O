/**
 * Daemon graceful-shutdown coordinator.
 *
 * Phase 1 of
 * `docs/nexus/proposals/daemon-graceful-shutdown-and-orphan-reaper-plan.md`.
 *
 * The Nexus daemon previously registered only a Fastify `onClose` hook
 * (`server.ts`) that shut down `defaultEverCoreRuntimeManager`. There was
 * no `SIGTERM` / `SIGINT` handler, no `app.close()` call, and
 * `storage.close()` — which flushes the `storageBridge` WAL and disposes
 * tools (`createRuntime.ts:169-176`) — was never invoked during daemon
 * teardown. A hard kill therefore dropped the in-memory storageBridge
 * queue and left persisted `executing` sessions / `running` agent jobs
 * stranded.
 *
 * This module wires signal-driven graceful shutdown:
 *   1. Set a `shuttingDown` flag that `/v1/execute` / `/v1/stream`
 *      check before acquiring a lease, rejecting new leases with a
 *      `503 SHUTTING_DOWN` in the canonical `{type:'error',code,message}`
 *      envelope from `registerErrorHandler` (`middleware.ts:45-66`).
 *   2. Abort all in-flight executions via `ActiveExecutionRegistry.cancelAll`
 *      so long-running agent loops stop instead of blocking `app.close()`.
 *   3. `app.close()` — stops accepting new connections, drains in-flight
 *      requests, and fires the existing `onClose` hook (which calls
 *      `defaultEverCoreRuntimeManager.shutdown()`).
 *   4. `storage.close()` — runs the `createRuntime.ts:169-176` override
 *      that flushes `storageBridge` and disposes tools. The WAL queue
 *      reaches disk.
 *   5. `process.exit(0)`.
 *
 * Idempotency: a second signal forces `process.exit(1)` immediately.
 *
 * Non-goals (owned by other plans):
 * - Cross-process coordination / distributed locks (single-daemon assumption).
 * - Replacing `node:sqlite` `DatabaseSync` with async I/O.
 * - The startup orphan reaper (Phase 2 of the same plan).
 */

import type { FastifyInstance } from 'fastify'
import type { NexusStorage } from '../storage/Storage.js'
import type { ActiveExecutionRegistry } from './activeExecutionRegistry.js'
import { logger } from '../shared/logger.js'

/**
 * Shared mutable flag consulted by the execute route handlers. When
 * `isShuttingDown` is true, `/v1/execute` and `/v1/stream` reject new
 * leases with `503 SHUTTING_DOWN` before calling `executionGate.tryAcquire`.
 *
 * The flag is a plain object reference (not a getter/setter) so the route
 * handlers read it with zero allocation on the hot path. The shutdown
 * coordinator mutates `isShuttingDown` in place.
 */
export type ShutdownSignal = { isShuttingDown: boolean }

export function createShutdownSignal(): ShutdownSignal {
  return { isShuttingDown: false }
}

export type ShutdownPhase = 'signal-received' | 'drained' | 'flushed' | 'exited'

export type RegisterDaemonShutdownHandlersOptions = {
  signal: ShutdownSignal
  app: FastifyInstance
  storage: NexusStorage
  activeExecutionRegistry: ActiveExecutionRegistry
  /**
   * Bounded grace budget (ms) for in-flight executions to settle after
   * `cancelAll` aborts them, before `app.close()` / `storage.close()`
   * force the teardown. Mirrors the soft-recoverable-timeout principle:
   * a shutdown is a recoverable interruption, not a fatal cutoff, but it
   * must still be bounded so a stuck execution cannot hang the daemon
   * forever. Default 5000ms; configurable via `NEXUS_SHUTDOWN_GRACE_MS`.
   */
  graceMs?: number
  /**
   * Optional sink for structured shutdown progress events. The daemon
   * emits one line per phase so an operator tailing logs can see the
   * teardown sequence. Defaults to `logger.info`.
   */
  onPhase?: (phase: ShutdownPhase, detail?: Record<string, unknown>) => void
}

/**
 * Register `SIGTERM` / `SIGINT` handlers that drive a bounded graceful
 * shutdown. Returns the underlying `shutdown()` function so callers (e.g.
 * tests) can trigger it without sending a real signal.
 *
 * The handler is intentionally idempotent: a second invocation
 * short-circuits to `process.exit(1)`.
 */
export function registerDaemonShutdownHandlers(
  options: RegisterDaemonShutdownHandlersOptions,
): () => Promise<void> {
  const { signal, app, storage, activeExecutionRegistry } = options
  const graceMs = options.graceMs ?? parseGraceMs()
  const onPhase: (phase: ShutdownPhase, detail?: Record<string, unknown>) => void =
    options.onPhase ?? ((phase, detail) => logger.info(`daemon shutdown: ${phase}`, detail))

  let inFlight = false

  const shutdown = async () => {
    // Second signal (or re-entrant call) forces an immediate exit.
    if (signal.isShuttingDown) {
      process.exit(1)
    }
    signal.isShuttingDown = true
    if (inFlight) return
    inFlight = true

    onPhase('signal-received')

    // Abort all in-flight executions so long-running agent loops stop
    // instead of blocking app.close(). The aborted requests' finally
    // blocks release their leases and settle the session state.
    const cancelled = activeExecutionRegistry.cancelAll()
    onPhase('drained', { cancelledExecutions: cancelled })

    // Bounded grace: let the aborted executions settle, but race against
    // the grace budget so a stuck finally block cannot hang teardown.
    // app.close() stops accepting new connections and drains in-flight
    // requests; it also fires the existing onClose hook
    // (defaultEverCoreRuntimeManager.shutdown()).
    const closeTimeout = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, graceMs)
      timer.unref?.()
    })
    await Promise.race([app.close(), closeTimeout])

    // Flush the storageBridge WAL + dispose tools. This is the path that
    // was previously never triggered on daemon teardown — the
    // createRuntime.ts:169-176 override.
    try {
      await storage.close?.()
      onPhase('flushed')
    } catch (error) {
      // storage.close failure must not prevent exit — the daemon is
      // already shutting down. Log and proceed so the process can exit
      // and the startup reaper (Phase 2) can clean up on the next boot.
      logger.error('daemon shutdown: storage.close failed', { error })
    }

    onPhase('exited')
    process.exit(0)
  }

  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  return shutdown
}

function parseGraceMs(): number {
  const raw = process.env.NEXUS_SHUTDOWN_GRACE_MS
  if (!raw) return 5000
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return 5000
  return parsed
}
