import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { ActiveExecutionRegistry } from '../src/nexus/activeExecutionRegistry.js'
import {
  createShutdownSignal,
  registerDaemonShutdownHandlers,
} from '../src/nexus/daemonLifecycle.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

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

/**
 * Phase 3 end-to-end: spawn a real Nexus process, wait for it to bind
 * its HTTP listener, send SIGTERM, and assert the daemon exits 0
 * cleanly via the Phase 1 graceful-shutdown path.
 *
 * This is the integration complement to the in-process tests above:
 * the in-process tests prove the coordinator logic in isolation; this
 * test proves the signal handler wired into `src/nexus/server.ts`
 * actually fires `process.exit(0)` under a real OS signal — the gap
 * that hid the silent-hang bug at the top of the plan.
 *
 * The test does NOT exercise an in-flight `/v1/execute` request: the
 * "WAL flush on shutdown" claim is covered by the in-process test
 * (which inspects the storage's `db` handle post-close). The end-to-end
 * test's job is narrower: prove the OS signal → `process.exit(0)` path
 * works through the production entrypoint.
 */
test('end-to-end: SIGTERM on a live Nexus process exits 0', async () => {
  const repoRoot = join(import.meta.dirname, '..')
  // Bypass the `node_modules/.bin/tsx` shim and spawn `node` directly
  // with tsx's loader. The shim launches a sh → exec node → node
  // spawns a grandchild server process, so `child.pid` is the shim's
  // and SIGTERM never reaches the Phase 1 coordinator (the server).
  // With this direct path, `child.pid` IS the server, and `child.kill`
  // delivers the signal cleanly.
  const tsxLoader = join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')
  const tsxPreflight = join(repoRoot, 'node_modules', 'tsx', 'dist', 'preflight.cjs')

  // Isolated config dir so this test never touches ~/.babel-o
  // (memory `babel-o-test-config-isolation`).
  const dir = mkdtempSync(join(tmpdir(), 'daemon-sigterm-e2e-'))
  const configFile = join(dir, 'config.json')
  const storagePath = join(dir, 'nexus.sqlite')
  // Pick a port unlikely to clash with parallel suites.
  const port = 18000 + Math.floor(Math.random() * 2000)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    BABEL_O_CONFIG_FILE: configFile,
    BABEL_O_TEST_CONFIG_WRITE_GUARD: '1',
    NEXUS_HOST: '127.0.0.1',
    NEXUS_PORT: String(port),
    NEXUS_STORAGE_PATH: storagePath,
    // Tight grace so the test doesn't hang on a stuck teardown.
    NEXUS_SHUTDOWN_GRACE_MS: '2000',
    // Disable MCP / agent / everCore bootstrap to keep the boot path
    // small and deterministic.
    NEXUS_ENABLE_MCP: '0',
    NEXUS_ENABLE_AGENT_TOOLS: '0',
    BABEL_O_EVERCORE_AUTO_BOOTSTRAP: '0',
    NO_COLOR: '1',
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [
      `--require=${tsxPreflight}`,
      `--import=${pathToFileURL(tsxLoader).href}`,
      join(repoRoot, 'src', 'nexus', 'server.ts'),
    ],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', chunk => { stdout += chunk.toString() })
  child.stderr!.on('data', chunk => { stderr += chunk.toString() })

  try {
    // Wait for the listener to bind. The server prints a single
    // "BabeL-O Nexus listening on http://127.0.0.1:<port>" line
    // (server.ts:163) once Fastify has the port. Up to 15s.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (stdout.includes('Nexus listening')) break
      if (child.exitCode !== null) {
        throw new Error(
          `Nexus child exited prematurely (code=${child.exitCode}) ` +
            `stdout=${stdout}\nstderr=${stderr}`,
        )
      }
      await delay(100)
    }
    if (!stdout.includes('Nexus listening')) {
      throw new Error(`Nexus never logged "listening". stdout=${stdout} stderr=${stderr}`)
    }

    // Send SIGTERM. The signal handler in daemonLifecycle.ts fires
    // the bounded teardown: flag → cancelAll → app.close → storage.close → exit(0).
    child.kill('SIGTERM')

    const exitCode: number | null = await new Promise(resolve => {
      const t = setTimeout(() => resolve(-1), 15_000)
      child.once('exit', code => {
        clearTimeout(t)
        resolve(code)
      })
    })
    assert.equal(exitCode, 0, `expected exit(0) on SIGTERM, got ${exitCode}\nstdout=${stdout}\nstderr=${stderr}`)
    // The storage file was created (proves boot got past createRuntime),
    // and a clean exit is consistent with the WAL flush in storage.close
    // running (the in-process test above proves the flush path).
    assert.ok(existsSync(storagePath), 'storage file should exist after a clean boot')
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
