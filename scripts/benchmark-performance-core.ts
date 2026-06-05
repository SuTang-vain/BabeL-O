import { spawn } from 'node:child_process'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { assembleContext } from '../src/runtime/contextAssembler.js'
import { buildSystemPrompt, mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'
import type { ModelMessage } from '../src/providers/adapters/ModelAdapter.js'
import {
  NEXUS_EVENT_SCHEMA_VERSION,
  type NexusEvent,
} from '../src/shared/events.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import type { NexusStorage } from '../src/storage/Storage.js'
import type { NexusRuntime, RuntimeExecuteOptions } from '../src/runtime/Runtime.js'
import type { NexusTask } from '../src/shared/task.js'
import { compactSession } from '../src/runtime/compact.js'
import { buildCacheAwareCompactPolicy } from '../src/runtime/cacheAwareCompactPolicy.js'
import {
  estimateContextTokens,
  getContextWindowState,
} from '../src/runtime/tokenEstimator.js'
import { runMockAgentLoopBenchmark } from '../src/nexus/agentLoopBenchmark.js'
import { writeBenchmarkHistory } from '../src/nexus/benchmarkHistory.js'
import { runRetryPolicyBenchmark } from '../src/nexus/retryPolicyBenchmark.js'
import { runRunnerComparisonBenchmark } from '../src/nexus/runnerComparisonBenchmark.js'
import {
  configureStorageBridgeWalForTest,
  flushStorageBridgeForTest,
  flushStorageBridgeWalForTest,
  getStorageBridgeStats,
  persistNexusTask,
  resetStorageBridgeForTest,
  setNexusStorageForTest,
} from '../src/nexus/storageBridge.js'

type BenchmarkResult = {
  name: string
  iterations: number
  totalMs: number
  avgMs: number
  minMs: number
  maxMs: number
}

type PercentileBenchmarkResult = BenchmarkResult & {
  p50Ms: number
  p95Ms: number
}

type CommandBenchmarkResult = PercentileBenchmarkResult & {
  exitCode: number | null
}

type ContextBenchmarkResult = {
  name: string
  originalChars: number
  assembledChars: number
  reductionPct: number
  selectedEventCount: number
  omittedEventCount: number
  snippedEventCount: number
  preservedRecentMarkers: string[]
}

type AutoCompactBenchmarkResult = {
  name: string
  beforeEventCount: number
  afterEventCount: number
  reductionPct: number
  preservedRecentTurns: number
  recentTurnsExpected: number
  recoveryBoundaryIntact: boolean
  summaryLatencyMs: number
  recoverySummaryLatencyMs: number
}

type CacheAwareCompactBenchmarkResult = {
  name: string
  effectiveContextCeiling: number
  legacyContextCeiling: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  cacheReadRatio: number
  compactThresholdPercent: number
  cachePreservationMode: boolean
  longContextUtilizationMode: boolean
}

type ApiScaleBenchmarkResult = {
  name: string
  storage: 'memory' | 'sqlite'
  sessionCount: number
  eventsPerSession: number
  totalEventCount: number
  seedMs: number
  routes: Array<PercentileBenchmarkResult & {
    route: string
    payloadBytes: number
    itemCount: number
    eventCount: number
    queryCount: number
  }>
}

type ChatFirstResponseBenchmarkResult = {
  name: string
  scenarios: Array<PercentileBenchmarkResult & {
    scenario: 'cold_start_cli' | 'warm_start_embedded' | 'service_mode_http'
    providerSdkLoaded: boolean
    sqliteOpened: boolean
    contextAssemblyTriggered: boolean
    firstResponseEventType: string
    responseEventCount: number
  }>
}

type StorageBridgeFaultInjectionBenchmarkResult = {
  name: string
  scenarios: Array<PercentileBenchmarkResult & {
    scenario: 'corrupt_wal_skip_replay' | 'sqlite_write_failure_retry' | 'crash_interrupted_replay' | 'compact_failure_diagnostic'
    strategy: 'skip_malformed_record' | 'retry_then_ack' | 'replay_unacked_operation' | 'retain_pending_wal'
    diagnostic: string
    succeeded: number
    failed: number
    permanentFailures: number
    walPending: number
    walBuffered: number
    walWriteFailures: number
  }>
  complexityDecision: 'keep_storage_bridge'
  complexityReason: string
}

type TokenEstimatorBenchmarkResult = {
  name: string
  legacyTokens: number
  estimatedTokens: number
  multiplier: number
  maxTokens: number
  warningThresholdTokens: number
  blockingLimitTokens: number
  legacyWouldWarn: boolean
  estimatorWouldWarn: boolean
  estimatorWouldBlock: boolean
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

async function measure(
  name: string,
  iterations: number,
  fn: () => Promise<void>,
): Promise<BenchmarkResult> {
  return measureSamples(name, iterations, fn)
}

async function measureSamples(
  name: string,
  iterations: number,
  fn: () => Promise<void>,
): Promise<PercentileBenchmarkResult> {
  const samples: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint()
    await fn()
    samples.push(elapsedMs(start))
  }
  const totalMs = samples.reduce((sum, value) => sum + value, 0)
  return {
    name,
    iterations,
    totalMs: round(totalMs),
    avgMs: round(totalMs / iterations),
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
  }
}

async function measureCommand(
  name: string,
  iterations: number,
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; input?: string },
): Promise<CommandBenchmarkResult> {
  const samples: number[] = []
  let exitCode: number | null = 0
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint()
    exitCode = await runCommand(command, args, options)
    samples.push(elapsedMs(start))
    if (exitCode !== 0) {
      throw new Error(`${name} exited with ${exitCode}`)
    }
  }
  const totalMs = samples.reduce((sum, value) => sum + value, 0)
  return {
    name,
    iterations,
    exitCode,
    totalMs: round(totalMs),
    avgMs: round(totalMs / iterations),
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; input?: string },
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: options.input === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore'],
    })
    child.on('error', reject)
    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
    child.on('exit', code => resolve(code))
  })
}

async function main(): Promise<void> {
  const cwd = join(tmpdir(), `babel-o-benchmark-${Date.now()}`)
  const projectRoot = new URL('..', import.meta.url).pathname
  const configPath = join(cwd, 'config.json')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'hello benchmark\n', 'utf8')
  await writeFile(
    configPath,
    JSON.stringify({ defaultModel: 'local/coding-runtime', providers: {} }, null, 2),
    'utf8',
  )
  Object.assign(process.env, benchmarkEnv(configPath))

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    executeTimeoutMs: 5_000,
    maxConcurrentExecutions: 16,
  })

  try {
    const results = [
      await measure('GET /health', 100, async () => {
        const response = await app.inject({ method: 'GET', url: '/health' })
        if (response.statusCode !== 200) throw new Error(response.body)
      }),
      await measure('GET /v1/runtime/status', 100, async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/runtime/status',
        })
        if (response.statusCode !== 200) throw new Error(response.body)
      }),
      await measure('POST /v1/execute hello', 50, async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/execute',
          payload: { prompt: 'hello', cwd },
        })
        if (response.statusCode !== 200) throw new Error(response.body)
      }),
      await measure('POST /v1/execute Read', 50, async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/execute',
          payload: { prompt: 'read sample.txt', cwd },
        })
        if (response.statusCode !== 200) throw new Error(response.body)
      }),
      await measure('POST /v1/execute Grep', 25, async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/execute',
          payload: { prompt: 'grep benchmark', cwd },
        })
        if (response.statusCode !== 200) throw new Error(response.body)
      }),
      await measure('POST /v1/execute Bash', 25, async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/execute',
          payload: { prompt: 'bash pwd', cwd },
        })
        if (response.statusCode !== 200) throw new Error(response.body)
      }),
      await measure('SQLite storage restart', 10, async () => {
        const dbPath = join(cwd, `bench-${Date.now()}-${Math.random()}.sqlite`)
        const storage = new SqliteStorage(dbPath)
        await storage.saveSession({
          sessionId: `session-${Date.now()}-${Math.random()}`,
          cwd,
          prompt: 'benchmark',
          phase: 'completed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          events: [],
        })
        await storage.close()
        const restored = new SqliteStorage(dbPath)
        await restored.listSessions({ limit: 5 })
        await restored.close()
      }),
      await measureCommand(
        'CLI --help startup',
        5,
        'npm',
        ['run', 'cli', '--', '--help'],
        { cwd: projectRoot, env: benchmarkEnv(configPath) },
      ),
      await measureCommand(
        'CLI embedded run hello',
        5,
        'npm',
        ['run', 'cli', '--', 'run', 'hello'],
        { cwd: projectRoot, env: benchmarkEnv(configPath) },
      ),
    ]
    const contextBenchmark = await benchmarkContextAssembly(cwd)
    const autoCompactBenchmark = await benchmarkAutoCompact()
    const cacheAwareCompactBenchmark = benchmarkCacheAwareCompactPolicy()
    const apiScaleBenchmark = await benchmarkApiScale(cwd)
    const chatFirstResponseBenchmark = await benchmarkChatFirstResponse(cwd, projectRoot, configPath)
    const storageBridgeFaultInjectionBenchmark = await benchmarkStorageBridgeFaultInjection(cwd)
    const tokenEstimatorBenchmark = benchmarkChineseTokenEstimator()
    const agentLoopBenchmark = await runMockAgentLoopBenchmark()
    const retryPolicyBenchmark = await runRetryPolicyBenchmark({ agentLoop: agentLoopBenchmark })
    const runnerComparisonBenchmark = await runRunnerComparisonBenchmark({
      workspaceRoot: cwd,
      projectRoot,
      runGoRunner: process.env.BABEL_O_RUN_GO_RUNNER_SMOKE === '1',
    })

    const benchmarkResult = {
      type: 'performance_benchmark',
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      results,
      context: contextBenchmark,
      autoCompact: autoCompactBenchmark,
      cacheAwareCompact: cacheAwareCompactBenchmark,
      apiScale: apiScaleBenchmark,
      chatFirstResponse: chatFirstResponseBenchmark,
      storageBridgeFaultInjection: storageBridgeFaultInjectionBenchmark,
      tokenEstimator: tokenEstimatorBenchmark,
      agentLoop: agentLoopBenchmark,
      retryPolicy: retryPolicyBenchmark,
      runnerComparison: runnerComparisonBenchmark,
      metrics: (await app.inject({
        method: 'GET',
        url: '/v1/runtime/metrics',
      })).json(),
    }
    const benchmarkHistory = await writeBenchmarkHistory({
      result: benchmarkResult,
      projectRoot,
      outputDir: process.env.BABEL_O_BENCHMARK_HISTORY_DIR,
      disabled: process.env.BABEL_O_BENCHMARK_HISTORY_DISABLED === '1',
    })

    console.log(
      JSON.stringify(
        {
          ...benchmarkResult,
          benchmarkHistory,
        },
        null,
        2,
      ),
    )
  } finally {
    await app.close()
    await storage.close?.()
    await rm(cwd, { recursive: true, force: true })
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function percentile(samples: number[], percent: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.ceil((percent / 100) * sorted.length) - 1
  return round(sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0)
}

function benchmarkEnv(configPath: string): Record<string, string> {
  return {
    BABEL_O_CONFIG_FILE: configPath,
    BABEL_O_MODEL: 'local/coding-runtime',
    BABEL_O_PROVIDER: 'local',
    BABEL_O_CONFIG_DIR: join(configPath, '..'),
  }
}

async function benchmarkChatFirstResponse(
  cwd: string,
  projectRoot: string,
  configPath: string,
): Promise<ChatFirstResponseBenchmarkResult> {
  const coldStart = await measureCommand(
    'chat first-response cold CLI startup',
    3,
    'npm',
    ['run', 'cli', '--', 'chat', '--cwd', cwd],
    {
      cwd: projectRoot,
      env: benchmarkEnv(configPath),
      input: '/exit\n',
    },
  )

  const warmStorage = new MemoryStorage()
  const warmApp = await createNexusApp({
    runtime: createBenchmarkRuntime(),
    storage: warmStorage,
    defaultCwd: cwd,
    executeTimeoutMs: 5_000,
  })
  let warmResponseEventCount = 0
  let warmFirstResponseEventType = 'none'
  try {
    const warm = await measureSamples('chat first-response warm embedded execute', 25, async () => {
      const response = await warmApp.inject({
        method: 'POST',
        url: '/v1/execute',
        payload: { prompt: 'hello', cwd },
      })
      if (response.statusCode !== 200) throw new Error(response.body)
      const payload = response.json()
      const events = Array.isArray(payload.events) ? payload.events : []
      warmResponseEventCount = events.length
      warmFirstResponseEventType = firstResponseEventType(events)
    })

    const serviceStorage = new SqliteStorage(join(cwd, `chat-service-${Date.now()}-${Math.random()}.sqlite`))
    const serviceApp = await createNexusApp({
      runtime: createBenchmarkRuntime(),
      storage: serviceStorage,
      defaultCwd: cwd,
      executeTimeoutMs: 5_000,
    })
    let serviceResponseEventCount = 0
    let serviceFirstResponseEventType = 'none'
    try {
      const service = await measureSamples('chat first-response service HTTP execute', 25, async () => {
        const response = await serviceApp.inject({
          method: 'POST',
          url: '/v1/execute',
          payload: { prompt: 'hello', cwd },
        })
        if (response.statusCode !== 200) throw new Error(response.body)
        const payload = response.json()
        const events = Array.isArray(payload.events) ? payload.events : []
        serviceResponseEventCount = events.length
        serviceFirstResponseEventType = firstResponseEventType(events)
      })

      return {
        name: 'chat first response latency',
        scenarios: [
          {
            ...coldStart,
            scenario: 'cold_start_cli',
            providerSdkLoaded: false,
            sqliteOpened: true,
            contextAssemblyTriggered: false,
            firstResponseEventType: 'welcome_or_exit',
            responseEventCount: 0,
          },
          {
            ...warm,
            scenario: 'warm_start_embedded',
            providerSdkLoaded: false,
            sqliteOpened: false,
            contextAssemblyTriggered: false,
            firstResponseEventType: warmFirstResponseEventType,
            responseEventCount: warmResponseEventCount,
          },
          {
            ...service,
            scenario: 'service_mode_http',
            providerSdkLoaded: false,
            sqliteOpened: true,
            contextAssemblyTriggered: false,
            firstResponseEventType: serviceFirstResponseEventType,
            responseEventCount: serviceResponseEventCount,
          },
        ],
      }
    } finally {
      await serviceApp.close()
      await serviceStorage.close?.()
    }
  } finally {
    await warmApp.close()
    await warmStorage.close?.()
  }
}

function createBenchmarkRuntime(): NexusRuntime {
  return {
    async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
      yield {
        type: 'session_started',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: options.sessionId,
        timestamp: new Date().toISOString(),
        cwd: options.cwd,
        requestId: options.requestId,
      }
      yield {
        type: 'assistant_delta',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: options.sessionId,
        timestamp: new Date().toISOString(),
        text: options.prompt,
      }
      yield {
        type: 'result',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: options.sessionId,
        timestamp: new Date().toISOString(),
        success: true,
        message: options.prompt,
      }
    },
  }
}

function firstResponseEventType(events: unknown[]): string {
  const event = events.find(item => isRecord(item) && item.type !== 'session_started')
  return isRecord(event) && typeof event.type === 'string' ? event.type : 'none'
}

async function benchmarkStorageBridgeFaultInjection(
  cwd: string,
): Promise<StorageBridgeFaultInjectionBenchmarkResult> {
  const scenarios: StorageBridgeFaultInjectionBenchmarkResult['scenarios'] = []

  scenarios.push(await benchmarkStorageBridgeFaultScenario(
    'storageBridge corrupt WAL skip and replay',
    'corrupt_wal_skip_replay',
    'skip_malformed_record',
    async () => {
      const walPath = join(cwd, `storage-corrupt-${Date.now()}-${Math.random()}.wal.jsonl`)
      resetStorageBridgeForTest()
      configureStorageBridgeWalForTest(walPath)
      setNexusStorageForTest(null)
      const task = createBenchmarkTask('queue-storage-fault-corrupt', 'recover after corrupt wal')
      persistNexusTask(task)
      flushStorageBridgeWalForTest()
      await appendFile(walPath, '{malformed storage bridge record\n', 'utf8')

      resetStorageBridgeForTest()
      configureStorageBridgeWalForTest(walPath)
      const storage = new MemoryStorage()
      setNexusStorageForTest(storage)
      await flushStorageBridgeForTest()

      if ((await storage.getTask(task.taskId))?.title !== task.title) {
        throw new Error('Corrupt WAL replay did not persist the valid task')
      }
      const stats = getStorageBridgeStats()
      if (!stats.lastError) {
        throw new Error('Corrupt WAL replay did not expose a diagnostic')
      }
      await storage.close?.()
      resetStorageBridgeForTest()
      return stats
    },
  ))

  scenarios.push(await benchmarkStorageBridgeFaultScenario(
    'storageBridge sqlite write failure retry',
    'sqlite_write_failure_retry',
    'retry_then_ack',
    async () => {
      class FlakySqliteStorage extends SqliteStorage {
        attempts = 0
        async saveTask(task: NexusTask): Promise<void> {
          this.attempts += 1
          if (this.attempts === 1) {
            throw new Error('simulated sqlite write failure')
          }
          await super.saveTask(task)
        }
      }

      resetStorageBridgeForTest()
      const walPath = join(cwd, `storage-sqlite-retry-${Date.now()}-${Math.random()}.wal.jsonl`)
      const storage = new FlakySqliteStorage(join(cwd, `storage-sqlite-retry-${Date.now()}-${Math.random()}.sqlite`))
      configureStorageBridgeWalForTest(walPath)
      setNexusStorageForTest(storage)
      const task = createBenchmarkTask('queue-storage-fault-retry', 'retry sqlite write')
      persistNexusTask(task)

      await flushStorageBridgeForTest()
      await flushStorageBridgeForTest()

      if ((await storage.getTask(task.taskId))?.title !== task.title) {
        throw new Error('Retried SQLite write did not persist the task')
      }
      const stats = getStorageBridgeStats()
      if (stats.failed < 1 || stats.succeeded < 1 || stats.permanentFailures !== 0) {
        throw new Error('SQLite retry stats did not record recoverable failure')
      }
      await storage.close?.()
      resetStorageBridgeForTest()
      return stats
    },
  ))

  scenarios.push(await benchmarkStorageBridgeFaultScenario(
    'storageBridge crash interrupted replay',
    'crash_interrupted_replay',
    'replay_unacked_operation',
    async () => {
      const walPath = join(cwd, `storage-crash-${Date.now()}-${Math.random()}.wal.jsonl`)
      resetStorageBridgeForTest()
      configureStorageBridgeWalForTest(walPath)
      setNexusStorageForTest(null)
      const task = createBenchmarkTask('queue-storage-fault-crash', 'recover unacked op')
      persistNexusTask(task)
      flushStorageBridgeWalForTest()

      resetStorageBridgeForTest()
      configureStorageBridgeWalForTest(walPath)
      const storage = new MemoryStorage()
      setNexusStorageForTest(storage)
      await flushStorageBridgeForTest()

      if ((await storage.getTask(task.taskId))?.title !== task.title) {
        throw new Error('Crash replay did not persist the unacked task')
      }
      const stats = getStorageBridgeStats()
      if (stats.walPending !== 0 || stats.succeeded !== 1) {
        throw new Error('Crash replay stats did not ack the pending operation')
      }
      await storage.close?.()
      resetStorageBridgeForTest()
      return stats
    },
  ))

  scenarios.push(await benchmarkStorageBridgeFaultScenario(
    'storageBridge compact failure diagnostic',
    'compact_failure_diagnostic',
    'retain_pending_wal',
    async () => {
      const walPath = join(cwd, `storage-compact-${Date.now()}-${Math.random()}.wal.jsonl`)
      resetStorageBridgeForTest()
      configureStorageBridgeWalForTest(walPath)
      setNexusStorageForTest(null)
      const task = createBenchmarkTask('queue-storage-fault-compact', 'compact diagnostic')
      persistNexusTask(task)
      flushStorageBridgeWalForTest()
      await mkdir(`${walPath}.tmp`, { recursive: true })

      const storage = new MemoryStorage()
      setNexusStorageForTest(storage)
      await flushStorageBridgeForTest()

      if ((await storage.getTask(task.taskId))?.title !== task.title) {
        throw new Error('Compact failure scenario did not persist the task before compact')
      }
      const stats = getStorageBridgeStats()
      if (!stats.lastError) {
        throw new Error('Compact failure did not expose a diagnostic')
      }
      await storage.close?.()
      resetStorageBridgeForTest()
      return stats
    },
  ))

  return {
    name: 'storageBridge fault injection',
    scenarios,
    complexityDecision: 'keep_storage_bridge',
    complexityReason: 'Fault injection shows the bridge preserves valid replay, exposes skip/retry/compact diagnostics, and avoids an undiagnosed session/task fork.',
  }
}

async function benchmarkStorageBridgeFaultScenario(
  name: string,
  scenario: StorageBridgeFaultInjectionBenchmarkResult['scenarios'][number]['scenario'],
  strategy: StorageBridgeFaultInjectionBenchmarkResult['scenarios'][number]['strategy'],
  run: () => Promise<ReturnType<typeof getStorageBridgeStats>>,
): Promise<StorageBridgeFaultInjectionBenchmarkResult['scenarios'][number]> {
  let stats = getStorageBridgeStats()
  const measured = await measureSamples(name, 1, async () => {
    stats = await run()
  })
  return {
    ...measured,
    scenario,
    strategy,
    diagnostic: stats.lastError ?? 'ok',
    succeeded: stats.succeeded,
    failed: stats.failed,
    permanentFailures: stats.permanentFailures,
    walPending: stats.walPending,
    walBuffered: stats.walBuffered,
    walWriteFailures: stats.walWriteFailures,
  }
}

function createBenchmarkTask(sessionId: string, title: string): NexusTask {
  const now = new Date().toISOString()
  return {
    taskId: `task-${Date.now()}-${Math.random()}`,
    sessionId,
    title,
    status: 'pending',
    dependsOn: [],
    blocks: [],
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  }
}

async function benchmarkContextAssembly(cwd: string): Promise<ContextBenchmarkResult> {
  const events = createLongSessionEvents()
  const originalSystemPrompt = buildSystemPrompt({
    sessionId: 'session-context-benchmark',
    prompt: 'continue',
    cwd,
  })
  const originalMessages = mapEventsToMessages(events, 'continue')
  const originalChars =
    originalSystemPrompt.length + estimateMessagesChars(originalMessages)

  const assembled = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context-benchmark',
      prompt: 'continue',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })
  const assembledChars =
    assembled.systemPrompt.length + estimateMessagesChars(assembled.messages)
  const reductionPct = ((originalChars - assembledChars) / originalChars) * 100
  const assembledMessagesText = JSON.stringify(assembled.messages)
  const preservedRecentMarkers = ['recent-turn-38', 'recent-turn-39']
    .filter(marker => assembledMessagesText.includes(marker))

  if (reductionPct < 50) {
    throw new Error(`Context benchmark reduction below target: ${round(reductionPct)}%`)
  }
  if (preservedRecentMarkers.length !== 2) {
    throw new Error('Context benchmark did not preserve recent turns')
  }

  return {
    name: 'Context assembly long session',
    originalChars,
    assembledChars,
    reductionPct: round(reductionPct),
    selectedEventCount: assembled.selectedEventCount,
    omittedEventCount: assembled.omittedEventCount,
    snippedEventCount: assembled.snippedEventCount,
    preservedRecentMarkers,
  }
}

function estimateMessagesChars(messages: ModelMessage[]): number {
  return JSON.stringify(messages).length
}

function benchmarkCacheAwareCompactPolicy(): CacheAwareCompactBenchmarkResult {
  const cacheReadInputTokens = 120_000
  const cacheCreationInputTokens = 20_000
  const policy = buildCacheAwareCompactPolicy({
    modelId: 'anthropic/claude-3-5-sonnet',
    tokenEstimate: 130_000,
    usage: {
      inputTokens: 40_000,
      outputTokens: 8_000,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    },
    cacheableSystemPromptRatio: 0.8,
    maxOutputTokens: 16_384,
  })

  if (!policy.longContextUtilizationMode) {
    throw new Error('Cache-aware compact benchmark did not enter long-context utilization mode')
  }
  if (!policy.cachePreservationMode) {
    throw new Error('Cache-aware compact benchmark did not enter cache preservation mode')
  }

  return {
    name: 'Cache-aware compact policy',
    effectiveContextCeiling: policy.effectiveContextCeiling,
    legacyContextCeiling: policy.legacyContextCeiling,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheReadRatio: round(policy.cacheReadRatio),
    compactThresholdPercent: policy.compactThresholdPercent,
    cachePreservationMode: policy.cachePreservationMode,
    longContextUtilizationMode: policy.longContextUtilizationMode,
  }
}

async function benchmarkApiScale(cwd: string): Promise<ApiScaleBenchmarkResult[]> {
  return [
    await benchmarkStorageApiScale('memory', new MemoryStorage(), cwd),
    await benchmarkStorageApiScale(
      'sqlite',
      new SqliteStorage(join(cwd, `scale-${Date.now()}-${Math.random()}.sqlite`)),
      cwd,
    ),
  ]
}

async function benchmarkStorageApiScale(
  storageKind: 'memory' | 'sqlite',
  storage: NexusStorage,
  cwd: string,
): Promise<ApiScaleBenchmarkResult> {
  const sessionCount = 1_000
  const eventsPerSession = 8
  const seedStart = process.hrtime.bigint()
  const targetSessionId = `session-scale-${storageKind}-0500`
  try {
    for (let index = 0; index < sessionCount; index += 1) {
      const sessionId = `session-scale-${storageKind}-${String(index).padStart(4, '0')}`
      const events = createScaleSessionEvents(sessionId, eventsPerSession, index)
      await storage.saveSession({
        sessionId,
        cwd,
        prompt: `scale benchmark ${index}`,
        phase: 'completed',
        createdAt: events[0]?.timestamp ?? '2026-05-23T00:00:00.000Z',
        updatedAt: events.at(-1)?.timestamp ?? '2026-05-23T00:00:00.000Z',
        events,
      })
      await storage.saveExecutionMetrics({
        metricId: `metric-${sessionId}`,
        sessionId,
        executeDurationMs: 10 + (index % 7),
        providerFirstTokenMs: 2 + (index % 5),
        providerRequestDurationMs: 5 + (index % 11),
        streamDeltaCount: eventsPerSession,
        toolCallCount: 1,
        toolRoundtripDurationMs: 3 + (index % 3),
        contextCharsIn: 100 + index,
        contextCharsOut: 50 + index,
        inputTokens: 20 + index,
        outputTokens: 10 + (index % 13),
        cacheCreationInputTokens: index % 17,
        cacheReadInputTokens: index % 19,
        timestamp: events.at(-1)?.timestamp ?? '2026-05-23T00:00:00.000Z',
      })
    }

    const app = await createNexusApp({
      runtime: { async *executeStream() {} },
      storage,
      defaultCwd: cwd,
      executeTimeoutMs: 5_000,
    })

    try {
      const routes = [
        await benchmarkApiScaleRoute(app, 'GET /v1/sessions?limit=200', '/v1/sessions?limit=200', 25),
        await benchmarkApiScaleRoute(app, 'GET /v1/sessions/:id', `/v1/sessions/${targetSessionId}?recentEventLimit=100`, 25),
        await benchmarkApiScaleRoute(app, 'GET /v1/sessions/:id/events', `/v1/sessions/${targetSessionId}/events?limit=500`, 25),
        await benchmarkApiScaleRoute(app, 'GET /v1/sessions/:id/assets', `/v1/sessions/${targetSessionId}/assets?eventLimit=500&toolTraceLimit=500`, 25),
      ]

      return {
        name: '1000+ sessions/events API scale',
        storage: storageKind,
        sessionCount,
        eventsPerSession,
        totalEventCount: sessionCount * eventsPerSession,
        seedMs: round(elapsedMs(seedStart)),
        routes,
      }
    } finally {
      await app.close()
    }
  } finally {
    await storage.close?.()
  }
}

async function benchmarkApiScaleRoute(
  app: FastifyInstance,
  name: string,
  url: string,
  iterations: number,
): Promise<PercentileBenchmarkResult & {
  route: string
  payloadBytes: number
  itemCount: number
  eventCount: number
  queryCount: number
}> {
  let payloadBytes = 0
  let itemCount = 0
  let eventCount = 0
  const measured = await measureSamples(name, iterations, async () => {
    const response = await app.inject({ method: 'GET', url })
    if (response.statusCode !== 200) throw new Error(response.body)
    payloadBytes = Buffer.byteLength(response.body)
    const payload = response.json()
    itemCount = countPayloadItems(payload)
    eventCount = countPayloadEvents(payload)
  })

  return {
    ...measured,
    route: url,
    payloadBytes,
    itemCount,
    eventCount,
    queryCount: 1,
  }
}

function createScaleSessionEvents(
  sessionId: string,
  eventCount: number,
  sessionIndex: number,
): NexusEvent[] {
  const events: NexusEvent[] = []
  for (let index = 0; index < eventCount; index += 1) {
    const timestamp = `2026-05-23T00:${String(sessionIndex % 60).padStart(2, '0')}:${String(index).padStart(2, '0')}.000Z`
    if (index === 0) {
      events.push({
        type: 'session_started',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp,
        cwd: '/tmp/babel-o-scale',
      })
    } else if (index % 4 === 1) {
      events.push({
        type: 'user_message',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp,
        text: `scale user turn ${sessionIndex}-${index}`,
      })
    } else if (index % 4 === 2) {
      events.push({
        type: 'assistant_delta',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp,
        text: `scale assistant turn ${sessionIndex}-${index}`,
      })
    } else if (index % 4 === 3) {
      events.push({
        type: 'usage',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp,
        inputTokens: 10 + sessionIndex + index,
        outputTokens: 4 + index,
        cacheCreationInputTokens: index,
        cacheReadInputTokens: sessionIndex % 11,
      })
    } else {
      events.push({
        type: 'tool_started',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp,
        toolUseId: `tool-scale-${sessionIndex}-${index}`,
        name: 'Read',
        input: { path: `src/scale-${sessionIndex}.ts` },
      })
    }
  }
  return events
}

function countPayloadItems(payload: unknown): number {
  if (!isRecord(payload)) return 0
  if (Array.isArray(payload.sessions)) return payload.sessions.length
  if (Array.isArray(payload.events)) return payload.events.length
  if (isRecord(payload.session)) return 1
  if (isRecord(payload.events) && Array.isArray(payload.events.items)) return payload.events.items.length
  return 0
}

function countPayloadEvents(payload: unknown): number {
  if (!isRecord(payload)) return 0
  if (Array.isArray(payload.events)) return payload.events.length
  if (isRecord(payload.session) && Array.isArray(payload.session.events)) return payload.session.events.length
  if (isRecord(payload.events) && Array.isArray(payload.events.items)) return payload.events.items.length
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function benchmarkChineseTokenEstimator(): TokenEstimatorBenchmarkResult {
  const systemPrompt = [
    'You are BabeL-O. Preserve the latest Chinese user request and tool chain.',
    '当前任务是继续分析上下文管理、自动压缩、工具结果和模型窗口边界。',
  ].join('\n')
  const chineseParagraph =
    '请继续核对 BabeL-O 的上下文管理能力，重点确认中文长会话、工具调用结果、JSON 结构、thinking 输出和 compact 恢复边界是否会触发窗口风险。'
  const codeBlock = [
    '```ts',
    'export function explainContextRisk(input: string): string {',
    '  return `上下文风险: ${input.length}`',
    '}',
    '```',
  ].join('\n')
  const jsonToolResult = JSON.stringify({
    diagnostics: Array.from({ length: 80 }, (_, index) => ({
      file: `src/runtime/example-${index}.ts`,
      message: `中文诊断 ${index}: 工具输出过长，需要估算 token 并保护最近用户轮次。`,
      severity: index % 3 === 0 ? 'warning' : 'info',
    })),
  })
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: `${chineseParagraph}\n`.repeat(120),
    },
    {
      role: 'assistant',
      content: `${chineseParagraph}\n${codeBlock}\n`.repeat(80),
      reasoningContent: `${chineseParagraph}\n`.repeat(60),
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool-benchmark-1',
          name: 'Grep',
          input: {
            pattern: 'context_warning|compact_boundary|tool_result',
            path: '/Users/tangyaoyue/DEV/BABEL/BabeL-O/src',
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'tool-benchmark-1',
          content: jsonToolResult,
        },
      ],
    },
  ]
  const tools = [
    {
      name: 'Grep',
      description: 'Search files and return matching lines.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          maxMatches: { type: 'number' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'Read',
      description: 'Read file contents.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  ]

  const legacyTokens = Math.ceil((systemPrompt.length + estimateMessagesChars(messages)) / 4)
  const estimatedTokens = estimateContextTokens({
    systemPrompt,
    messages,
    tools,
  }).totalTokens
  const maxTokens = estimatedTokens + 250
  const legacyState = getContextWindowState({
    tokenEstimate: legacyTokens,
    maxTokens,
    warningPercent: 85,
    blockingBufferTokens: 500,
  })
  const estimatorState = getContextWindowState({
    tokenEstimate: estimatedTokens,
    maxTokens,
    warningPercent: 85,
    blockingBufferTokens: 500,
  })
  const multiplier = estimatedTokens / legacyTokens

  if (multiplier < 1.5) {
    throw new Error(`Token estimator benchmark multiplier below target: ${round(multiplier)}x`)
  }
  if (legacyState.isWarning) {
    throw new Error('Legacy chars/4 estimate unexpectedly reached warning threshold')
  }
  if (!estimatorState.isWarning || !estimatorState.isBlocking) {
    throw new Error('Token estimator did not reach expected warning/blocking threshold')
  }

  return {
    name: 'Chinese context token estimator',
    legacyTokens,
    estimatedTokens,
    multiplier: round(multiplier),
    maxTokens,
    warningThresholdTokens: estimatorState.warningThresholdTokens,
    blockingLimitTokens: estimatorState.blockingLimitTokens,
    legacyWouldWarn: legacyState.isWarning,
    estimatorWouldWarn: estimatorState.isWarning,
    estimatorWouldBlock: estimatorState.isBlocking,
  }
}

function createLongSessionEvents(): NexusEvent[] {
  const sessionId = 'session-context-benchmark'
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'Optimize this project while preserving the recent context.',
    },
  ]

  for (let index = 0; index < 40; index += 1) {
    const minute = String(index).padStart(2, '0')
    events.push(
      {
        type: 'assistant_delta',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:01.000Z`,
        text: `Planning turn ${index}. `,
      },
      {
        type: 'tool_started',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:02.000Z`,
        toolUseId: `tool-${index}`,
        name: 'Read',
        input: { path: `src/feature-${index}.ts` },
      },
      {
        type: 'tool_completed',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:03.000Z`,
        toolUseId: `tool-${index}`,
        name: 'Read',
        success: true,
        output: `${'x'.repeat(8_000)}\nrecent-turn-${index}\n${'y'.repeat(8_000)}`,
      },
      {
        type: 'user_message',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:04.000Z`,
        text: `Continue after recent-turn-${index}.`,
      },
    )
  }

  return events
}

async function benchmarkAutoCompact(): Promise<AutoCompactBenchmarkResult> {
  const sessionId = 'session-auto-compact-benchmark'
  const storage = new MemoryStorage()

  // Build a long session with many turns and large tool outputs
  const events = createLongSessionEventsForAutoCompact(sessionId)
  await storage.saveSession({
    sessionId,
    cwd: '/tmp',
    prompt: 'benchmark',
    phase: 'executing',
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
    events,
  })

  const result = await compactSession({
    storage,
    sessionId,
    modelId: 'local/coding-runtime',
    trigger: 'auto',
  })

  const beforeEventCount = result.beforeEventCount
  const afterEventCount = result.afterEventCount
  const reductionPct = ((beforeEventCount - afterEventCount) / beforeEventCount) * 100

  // Verify recent 2-4 user turns are preserved
  const recentUserMessages = events
    .filter((e, i): e is Extract<NexusEvent, { type: 'user_message' }> =>
      e.type === 'user_message' && i >= events.length - 8,
    )
  const { events: postCompactEvents } = await storage.listEvents(sessionId, { limit: 10_000, order: 'asc' })
  const assembledAfterCompact = await assembleContext({
    runtimeOptions: {
      sessionId,
      prompt: 'Continue after auto-compact benchmark.',
      cwd: '/tmp',
    },
    events: postCompactEvents,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })
  const postCompactMessagesText = JSON.stringify(assembledAfterCompact.messages)
  const preservedRecentTurns = recentUserMessages.filter(um =>
    postCompactMessagesText.includes(um.text),
  ).length

  if (reductionPct < 50) {
    throw new Error(`Auto-compact benchmark reduction below target: ${round(reductionPct)}%`)
  }

  // Recovery boundary test: build a session with cancellation + subsequent user message
  const recoverySessionId = 'session-recovery-benchmark'
  const recoveryEvents = createRecoveryBoundarySession(recoverySessionId)
  await storage.saveSession({
    sessionId: recoverySessionId,
    cwd: '/tmp',
    prompt: 'recovery benchmark',
    phase: 'executing',
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
    events: recoveryEvents,
  })

  const recoveryResult = await compactSession({
    storage,
    sessionId: recoverySessionId,
    modelId: 'local/coding-runtime',
    trigger: 'auto',
  })

  const { events: recoveryPostCompact } = await storage.listEvents(recoverySessionId, { limit: 10_000, order: 'asc' })
  const assembledRecovery = await assembleContext({
    runtimeOptions: {
      sessionId: recoverySessionId,
      prompt: 'Final question after recovery.',
      cwd: '/tmp',
    },
    events: recoveryPostCompact,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })
  const recoveryMessagesText = JSON.stringify(assembledRecovery.messages)
  const recoveryBoundaryIntact =
    recoveryMessagesText.includes('Follow-up after cancellation') &&
    recoveryMessagesText.includes('Final question after recovery.')

  if (!recoveryBoundaryIntact) {
    throw new Error('Auto-compact benchmark destroyed recovery boundary')
  }

  return {
    name: 'Auto-compact long session',
    beforeEventCount,
    afterEventCount,
    reductionPct: round(reductionPct),
    preservedRecentTurns,
    recentTurnsExpected: recentUserMessages.length,
    recoveryBoundaryIntact,
    summaryLatencyMs: round(result.summaryLatencyMs),
    recoverySummaryLatencyMs: round(recoveryResult.summaryLatencyMs),
  }
}

function createLongSessionEventsForAutoCompact(sessionId: string): NexusEvent[] {
  const events: NexusEvent[] = [
    {
      type: 'session_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:00.000Z',
      cwd: '/tmp',
    },
    {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:01.000Z',
      text: 'Start the long task.',
    },
  ]

  for (let index = 0; index < 40; index += 1) {
    const minute = String(index).padStart(2, '0')
    events.push(
      {
        type: 'assistant_delta',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:02.000Z`,
        text: `Assistant turn ${index} with a lengthy explanation that goes on and on to simulate real model output. `.repeat(20),
      },
      {
        type: 'thinking_delta',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:03.000Z`,
        text: `Thinking about turn ${index} and considering various approaches. `.repeat(10),
      },
      {
        type: 'tool_started',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:04.000Z`,
        toolUseId: `tool-${index}`,
        name: 'Read',
        input: { path: `src/feature-${index}.ts` },
      },
      {
        type: 'tool_completed',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:05.000Z`,
        toolUseId: `tool-${index}`,
        name: 'Read',
        success: true,
        output: `${'x'.repeat(10_000)}\nauto-compact-turn-${index}\n${'y'.repeat(10_000)}`,
      },
      {
        type: 'user_message',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:06.000Z`,
        text: `Continue after auto-compact-turn-${index}.`,
      },
    )
  }

  return events
}

function createRecoveryBoundarySession(sessionId: string): NexusEvent[] {
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'Start the task.',
    },
    {
      type: 'assistant_delta',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:01.000Z',
      text: 'Working on it.',
    },
    {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'tool-1',
      name: 'Bash',
      input: { command: 'sleep 10' },
    },
    {
      type: 'tool_completed',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:03.000Z',
      toolUseId: 'tool-1',
      name: 'Bash',
      success: false,
      output: 'Command was cancelled.',
    },
    {
      type: 'error',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:04.000Z',
      code: 'REQUEST_CANCELLED',
      message: 'Execution cancelled by user.',
    },
    {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:05.000Z',
      text: 'Follow-up after cancellation',
    },
    {
      type: 'assistant_delta',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:06.000Z',
      text: 'Responding to follow-up.',
    },
    {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:07.000Z',
      toolUseId: 'tool-2',
      name: 'Read',
      input: { path: 'README.md' },
    },
    {
      type: 'tool_completed',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:08.000Z',
      toolUseId: 'tool-2',
      name: 'Read',
      success: true,
      output: 'x'.repeat(5_000),
    },
    {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:09.000Z',
      text: 'Final question after recovery.',
    },
  ]

  return events
}

await main()
