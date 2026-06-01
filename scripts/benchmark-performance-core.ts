import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { compactSession } from '../src/runtime/compact.js'
import {
  estimateContextTokens,
  getContextWindowState,
} from '../src/runtime/tokenEstimator.js'
import { runMockAgentLoopBenchmark } from '../src/nexus/agentLoopBenchmark.js'

type BenchmarkResult = {
  name: string
  iterations: number
  totalMs: number
  avgMs: number
  minMs: number
  maxMs: number
}

type CommandBenchmarkResult = BenchmarkResult & {
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
  }
}

async function measureCommand(
  name: string,
  iterations: number,
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
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
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: 'ignore',
    })
    child.on('error', reject)
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
    const tokenEstimatorBenchmark = benchmarkChineseTokenEstimator()
    const agentLoopBenchmark = await runMockAgentLoopBenchmark()

    console.log(
      JSON.stringify(
        {
          type: 'performance_benchmark',
          timestamp: new Date().toISOString(),
          schemaVersion: 1,
          results,
          context: contextBenchmark,
          autoCompact: autoCompactBenchmark,
          tokenEstimator: tokenEstimatorBenchmark,
          agentLoop: agentLoopBenchmark,
          metrics: (await app.inject({
            method: 'GET',
            url: '/v1/runtime/metrics',
          })).json(),
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

function benchmarkEnv(configPath: string): Record<string, string> {
  return {
    BABEL_O_CONFIG_FILE: configPath,
    BABEL_O_MODEL: 'local/coding-runtime',
    BABEL_O_PROVIDER: 'local',
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
