import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { ActiveExecutionRegistry } from '../src/nexus/activeExecutionRegistry.js'
import {
  createShutdownSignal,
  registerDaemonShutdownHandlers,
} from '../src/nexus/daemonLifecycle.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Phase 1 of
 * `docs/nexus/proposals/daemon-graceful-shutdown-and-orphan-reaper-plan.md`.
 *
 * These tests cover the shutdown coordinator's in-process logic: the
 * shared `shuttingDown` flag, `cancelAll` abort propagation, and the
 * `storage.close()` flush path that was previously never triggered on
 * daemon teardown. The end-to-end signal-driven process test lives in
 * `test/daemon-orphan-reaper.test.ts` (Phase 3).
 *
 * `process.exit` is stubbed per-test so the coordinator's terminal
 * `process.exit(0)` does not kill the test runner; the stub records the
 * requested exit code so the test can assert the teardown reached the
 * end instead of hanging on the bounded grace budget.
 */
class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

/**
 * Stub `process.exit` so the coordinator's terminal exit does not kill
 * the test runner. The stub records the requested exit code and throws
 * an `ExitSentinel` to short-circuit the remaining shutdown body — this
 * mirrors real `process.exit` semantics (no code after it runs) so the
 * idempotency `exit(1)` is not overwritten by the trailing `exit(0)`.
 */
function withStubbedExit<T>(fn: () => Promise<T>): Promise<{ result: T; exitCode: number | null }> {
  let exitCode: number | null = null
  const originalExit = process.exit
  process.exit = ((code?: number) => {
    exitCode = code ?? 0
    throw new ExitSentinel(exitCode)
  }) as typeof process.exit
  return fn().then(
    result => {
      process.exit = originalExit
      return { result, exitCode }
    },
    err => {
      process.exit = originalExit
      if (err instanceof ExitSentinel) {
        return { result: undefined as unknown as T, exitCode: err.code }
      }
      throw err
    },
  )
}

test('createShutdownSignal starts with isShuttingDown=false', () => {
  const signal = createShutdownSignal()
  assert.equal(signal.isShuttingDown, false)
})

test('shutdown coordinator: sets flag, cancelAll aborts in-flight, flushes storage, exits 0', async () => {
  const signal = createShutdownSignal()
  const storagePath = join(tmpdir(), `daemon-shutdown-flush-${process.pid}-${Date.now()}.sqlite`)
  const storage = new SqliteStorage(storagePath)
  const registry = new ActiveExecutionRegistry()
  const app = Fastify({ logger: false })

  // Register a fake in-flight execution whose abort we can observe.
  const abortController = new AbortController()
  let aborted = false
  abortController.signal.addEventListener('abort', () => {
    aborted = true
  })
  registry.register('session-shutdown-test', {
    requestId: 'req-1',
    abortController,
    transport: 'http',
    startedAt: new Date().toISOString(),
  })

  const phases: string[] = []
  const shutdown = registerDaemonShutdownHandlers({
    signal,
    app,
    storage,
    activeExecutionRegistry: registry,
    graceMs: 200,
    onPhase: phase => phases.push(phase),
  })

  const { exitCode } = await withStubbedExit(async () => {
    await shutdown()
  })

  // Flag is set before anything else, so new leases get 503.
  assert.equal(signal.isShuttingDown, true)
  // cancelAll aborted the registered in-flight execution.
  assert.equal(aborted, true, 'cancelAll must abort registered in-flight executions')
  // storage.close() ran — the createRuntime.ts:169-176 flush path.
  // After close the db is no longer usable; a second close throws, proving it ran.
  assert.throws(() => storage['db'].prepare('SELECT 1'), /closed|database is not open/i)
  // The teardown reached the terminal exit.
  assert.equal(exitCode, 0)
  assert.deepEqual(phases, ['signal-received', 'drained', 'flushed', 'exited'])

  await app.close()
})

test('shutdown coordinator: second invocation forces exit(1) (idempotency)', async () => {
  const signal = createShutdownSignal()
  signal.isShuttingDown = true // already shutting down
  const storage = new SqliteStorage(join(tmpdir(), `daemon-shutdown-idem-${process.pid}-${Date.now()}.sqlite`))
  const registry = new ActiveExecutionRegistry()
  const app = Fastify({ logger: false })

  const shutdown = registerDaemonShutdownHandlers({
    signal,
    app,
    storage,
    activeExecutionRegistry: registry,
    graceMs: 50,
  })

  const { exitCode } = await withStubbedExit(async () => {
    await shutdown()
  })

  assert.equal(exitCode, 1, 'a second signal while shutting down forces exit(1)')
  await app.close()
  await storage.close?.()
})

test('shutdown coordinator: storage.close failure does not prevent exit', async () => {
  const signal = createShutdownSignal()
  const registry = new ActiveExecutionRegistry()
  const app = Fastify({ logger: false })
  // A storage whose close() rejects — simulates a WAL flush failure.
  const failingStorage = {
    close: async () => {
      throw new Error('wal flush failed')
    },
  }

  const shutdown = registerDaemonShutdownHandlers({
    signal,
    app,
    storage: failingStorage as any,
    activeExecutionRegistry: registry,
    graceMs: 50,
  })

  const { exitCode } = await withStubbedExit(async () => {
    await shutdown()
  })

  // Non-fatal: the daemon still exits 0 so the startup reaper (Phase 2)
  // can clean up on the next boot.
  assert.equal(exitCode, 0)
  await app.close()
})

test('cancelAll aborts every registered execution and returns the count', () => {
  const registry = new ActiveExecutionRegistry()
  const controllers = Array.from({ length: 3 }, () => new AbortController())
  controllers.forEach((c, i) => {
    registry.register(`session-${i}`, {
      requestId: `req-${i}`,
      abortController: c,
      transport: 'http',
      startedAt: new Date().toISOString(),
    })
  })

  const cancelled = registry.cancelAll()

  assert.equal(cancelled, 3)
  assert.ok(controllers.every(c => c.signal.aborted), 'every registered execution is aborted')
})
