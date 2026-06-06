import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ExploreAgentScheduler, createExploreRuntime } from '../src/nexus/agents/AgentScheduler.js'
import { AgentJobRegistryError } from '../src/nexus/agents/AgentJobRegistry.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { NEXUS_EVENT_SCHEMA_VERSION, NexusEventSchema, type NexusEvent } from '../src/shared/events.js'
import { InMemoryRemoteToolRunner } from '../src/runtime/remoteRunner.js'
import { allowlistedTools } from '../src/runtime/LocalCodingRuntime.js'
import { createRuntimeExecutionMetrics, type RuntimeProviderToolCall } from '../src/runtime/runtimePipeline.js'
import { executeProviderToolCall } from '../src/runtime/runtimeToolLoop.js'
import type { NexusRuntime, RuntimeExecuteOptions } from '../src/runtime/Runtime.js'
import type { SessionSnapshot } from '../src/shared/session.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'

test('ExploreAgentScheduler spawns read-only child session and completes with structured result', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(parentSession())
  const runtime = new RecordingRuntime([
    {
      type: 'tool_completed',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'filled-by-runtime',
      timestamp: '2026-06-04T00:00:02.000Z',
      toolUseId: 'tool-read',
      name: 'Read',
      success: true,
      output: 'AgentScheduler contents',
    },
    {
      type: 'result',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'filled-by-runtime',
      timestamp: '2026-06-04T00:00:03.000Z',
      success: true,
      message: 'Explore completed.',
    },
  ])
  const scheduler = new ExploreAgentScheduler({
    storage,
    now: fixedClock(),
    runtimeFactory: ({ allowedTools }) => {
      assert.deepEqual(allowedTools, ['ListDir', 'Glob', 'Grep', 'Read'])
      return runtime
    },
  })

  const job = await scheduler.spawnAgent({
    parentSessionId: 'session-parent',
    prompt: 'Find src/nexus/agents/AgentScheduler.ts',
  })
  const completed = await scheduler.waitForAgent(job.jobId, { timeoutMs: 100 })

  assert.equal(completed.status, 'completed')
  assert.equal(completed.result?.summary, 'Explore completed.')
  assert.equal(completed.result?.findings?.[0]?.message, 'Read completed.')
  assert.deepEqual(completed.result?.changedFiles, [])
  assert.deepEqual(completed.result?.commandsRun, [])
  assert.equal(completed.governance?.maxConcurrentAgents, 4)
  assert.equal(completed.governance?.activeAgents, 0)
  assert.equal(completed.governance?.maxDepth, 2)
  assert.equal(completed.governance?.depth, 1)
  assert.equal(completed.governance?.maxRuntimeMs, 120_000)
  assert.equal(completed.governance?.timeoutAt, '2026-06-04T00:02:00.000Z')
  assert.equal(runtime.calls[0]?.role, 'explore')
  assert.equal(runtime.calls[0]?.skipPermissionCheck, true)
  assert.equal(runtime.calls[0]?.replaySessionHistory, false)

  const child = await storage.getSession(job.childSessionId)
  assert.equal(child?.parentSessionId, 'session-parent')
  assert.equal(child?.assignedAgentId, 'explore')
  assert.equal(child?.phase, 'completed')
  assert.equal(child?.metadata?.agentJobId, job.jobId)
  assert.equal(child?.metadata?.contextForkMode, 'minimal')
  assert.equal(child?.metadata?.agentDepth, 1)
  assert.deepEqual(child?.metadata?.governance, completed.governance)

  const parentEvents = await storage.listEvents('session-parent')
  assert.deepEqual(parentEvents.events.map(event => event.type), [
    'agent_job_event',
    'agent_job_event',
    'agent_job_event',
  ])
  assert.deepEqual(parentEvents.events.map(event => event.type === 'agent_job_event' ? event.eventType : undefined), [
    'agent_job_queued',
    'agent_job_started',
    'agent_job_completed',
  ])
  const completedEvent = parentEvents.events.find(event => event.type === 'agent_job_event' && event.eventType === 'agent_job_completed')
  assert.equal(completedEvent?.type === 'agent_job_event' ? completedEvent.jobId : undefined, job.jobId)
  assert.equal(completedEvent?.type === 'agent_job_event' ? completedEvent.governance?.depth : undefined, 1)
  assert.equal(NexusEventSchema.parse(completedEvent).type, 'agent_job_event')
})

test('ExploreAgentScheduler spawns review and test profiles with task-focused context', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(parentSession())
  const runtime = new RecordingRuntime([
    {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'filled-by-runtime',
      timestamp: '2026-06-04T00:00:01.000Z',
      toolUseId: 'tool-test',
      name: 'Bash',
      input: { command: 'npx tsx --test test/agent-scheduler.test.ts' },
    },
    {
      type: 'tool_completed',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'filled-by-runtime',
      timestamp: '2026-06-04T00:00:02.000Z',
      toolUseId: 'tool-test',
      name: 'Bash',
      success: true,
      output: 'tests passed',
    },
    {
      type: 'result',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'filled-by-runtime',
      timestamp: '2026-06-04T00:00:03.000Z',
      success: true,
      message: 'Test completed.',
    },
  ])
  const scheduler = new ExploreAgentScheduler({
    storage,
    now: fixedClock(),
    runtimeFactory: ({ agentType, allowedTools }) => {
      assert.equal(agentType, 'test')
      assert.deepEqual(allowedTools, ['ListDir', 'Glob', 'Grep', 'Read', 'Bash'])
      return runtime
    },
  })

  const job = await scheduler.spawnAgent({
    parentSessionId: 'session-parent',
    agentType: 'test',
    prompt: 'Run focused agent scheduler tests.',
  })
  const completed = await scheduler.waitForAgent(job.jobId, { timeoutMs: 100 })

  assert.equal(completed.agentType, 'test')
  assert.equal(completed.contextForkMode, 'task-focused')
  assert.equal(completed.result?.commandsRun?.[0], 'npx tsx --test test/agent-scheduler.test.ts')
  assert.equal(completed.result?.testsRun?.[0], 'npx tsx --test test/agent-scheduler.test.ts')
  assert.equal(runtime.calls[0]?.role, 'test')
  assert.equal(runtime.calls[0]?.skipPermissionCheck, true)

  const child = await storage.getSession(job.childSessionId)
  assert.equal(child?.assignedAgentId, 'test')
  assert.equal(child?.metadata?.contextForkMode, 'task-focused')
  assert.deepEqual(child?.metadata?.allowedTools, ['ListDir', 'Glob', 'Grep', 'Read', 'Bash'])
})

test('ExploreAgentScheduler allows review profile but still rejects editing tools', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(parentSession())
  const scheduler = new ExploreAgentScheduler({
    storage,
    runtimeFactory: ({ agentType, allowedTools }) => {
      assert.equal(agentType, 'review')
      assert.deepEqual(allowedTools, ['ListDir', 'Glob', 'Grep', 'Read', 'Bash'])
      return new RecordingRuntime([])
    },
  })

  const review = await scheduler.spawnAgent({
    parentSessionId: 'session-parent',
    agentType: 'review',
    prompt: 'Review changed files.',
  })
  assert.equal(review.agentType, 'review')
  assert.equal(review.contextForkMode, 'task-focused')

  await assert.rejects(
    () => scheduler.spawnAgent({
      parentSessionId: 'session-parent',
      agentType: 'review',
      prompt: 'Edit files.',
      allowedTools: ['Read', 'Edit'],
    }),
    (error: unknown) =>
      error instanceof AgentJobRegistryError && error.code === 'AGENT_TOOLS_NOT_ALLOWED',
  )
})

test('ExploreAgentScheduler rejects non-read-only tool overrides', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(parentSession())
  const scheduler = new ExploreAgentScheduler({
    storage,
    runtimeFactory: () => new RecordingRuntime([]),
  })

  await assert.rejects(
    () => scheduler.spawnAgent({
      parentSessionId: 'session-parent',
      prompt: 'Edit files.',
      allowedTools: ['Read', 'Edit'],
    }),
    (error: unknown) =>
      error instanceof AgentJobRegistryError && error.code === 'AGENT_TOOLS_NOT_ALLOWED',
  )
})

test('ExploreAgentScheduler cancels running jobs and child session', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(parentSession())
  const runtime = new HangingRuntime()
  const scheduler = new ExploreAgentScheduler({
    storage,
    now: fixedClock(),
    runtimeFactory: () => runtime,
  })

  const job = await scheduler.spawnAgent({
    parentSessionId: 'session-parent',
    prompt: 'Find files slowly.',
  })
  await runtime.started
  const cancelled = await scheduler.cancelAgent(job.jobId, 'No longer needed.')

  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.error?.message, 'No longer needed.')
  const waited = await scheduler.waitForAgent(job.jobId)
  assert.equal(waited.status, 'cancelled')
  const child = await storage.getSession(job.childSessionId)
  assert.equal(child?.phase, 'cancelled')
})

test('ExploreAgentScheduler restores persisted completed jobs after scheduler restart', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(parentSession())
  const firstScheduler = new ExploreAgentScheduler({
    storage,
    now: fixedClock(),
    runtimeFactory: () => new RecordingRuntime([
      {
        type: 'result',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: 'filled-by-runtime',
        timestamp: '2026-06-04T00:00:03.000Z',
        success: true,
        message: 'Persisted explore completed.',
      },
    ]),
  })
  const spawned = await firstScheduler.spawnAgent({
    parentSessionId: 'session-parent',
    prompt: 'Persist this job.',
  })
  await firstScheduler.waitForAgent(spawned.jobId)

  const restoredScheduler = new ExploreAgentScheduler({
    storage,
    now: fixedClock(),
    runtimeFactory: () => new RecordingRuntime([]),
  })

  const listed = await restoredScheduler.listAgents({ parentSessionId: 'session-parent' })
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.jobId, spawned.jobId)
  assert.equal(listed[0]?.status, 'completed')
  const waited = await restoredScheduler.waitForAgent(spawned.jobId, { timeoutMs: 1 })
  assert.equal(waited.result?.summary, 'Persisted explore completed.')
  const persisted = await storage.getAgentJob(spawned.jobId)
  assert.equal(persisted?.status, 'completed')
})

test('ExploreAgentScheduler exposes persisted non-terminal jobs after scheduler restart', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(parentSession())
  await storage.saveAgentJob({
    jobId: 'agent-job-persisted',
    parentSessionId: 'session-parent',
    childSessionId: 'session-child-persisted',
    agentType: 'explore',
    status: 'queued',
    prompt: 'Persist queued job.',
    contextForkMode: 'minimal',
    isolation: 'none',
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
  })

  const restoredScheduler = new ExploreAgentScheduler({
    storage,
    now: fixedClock(),
    runtimeFactory: () => new RecordingRuntime([]),
  })

  const waited = await restoredScheduler.waitForAgent('agent-job-persisted', { timeoutMs: 1 })
  assert.equal(waited.status, 'queued')
  const cancelled = await restoredScheduler.cancelAgent('agent-job-persisted', 'Restart cleanup.')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await storage.getAgentJob('agent-job-persisted'))?.status, 'cancelled')
})

test('ExploreAgentScheduler forwards remote execution context and cancel to runner', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession({
    ...parentSession(),
    allowedPaths: ['/workspace/project'],
  })
  const remoteRunner = new InMemoryRemoteToolRunner({
    capabilities: { tools: ['Read'] },
    handler: (_request, context) => new Promise<never>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('remote read aborted')))
    }),
  })
  const runtime = new ProviderToolCallRuntime({
    storage,
    allowedTools: ['ListDir', 'Glob', 'Grep', 'Read'],
    toolCalls: [providerToolCall('tool-remote-read', 'Read', { path: 'README.md' })],
  })
  const scheduler = new ExploreAgentScheduler({
    storage,
    now: fixedClock(),
    executionEnvironment: 'remote',
    remoteRunner,
    runtimeFactory: options => {
      assert.equal(options.executionEnvironment, 'remote')
      assert.equal(options.remoteRunner, remoteRunner)
      return runtime
    },
  })

  const job = await scheduler.spawnAgent({
    parentSessionId: 'session-parent',
    prompt: 'Read README remotely.',
  })
  await waitFor(() => remoteRunner.requests.length === 1)
  assert.equal(runtime.calls[0]?.executionEnvironment, 'remote')
  assert.equal(runtime.calls[0]?.remoteRunner, remoteRunner)
  assert.deepEqual(remoteRunner.requests[0].allowedPaths, ['/workspace/project'])

  const cancelled = await scheduler.cancelAgent(job.jobId, 'Stop remote read.')
  assert.equal(cancelled.status, 'cancelled')
  await scheduler.waitForAgent(job.jobId)
  await waitFor(() => remoteRunner.cancelRequests.length === 1)
  assert.equal(remoteRunner.cancelRequests[0].toolUseId, remoteRunner.requests[0].toolUseId)
  const child = await storage.getSession(job.childSessionId)
  assert.equal(child?.phase, 'cancelled')
})

test('ExploreAgentScheduler rejects spawns beyond max concurrent agents', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(parentSession())
  const scheduler = new ExploreAgentScheduler({
    storage,
    maxConcurrentAgents: 1,
    runtimeFactory: () => new HangingRuntime(),
  })

  const running = await scheduler.spawnAgent({
    parentSessionId: 'session-parent',
    prompt: 'Find files slowly.',
  })

  try {
    await assert.rejects(
      () => scheduler.spawnAgent({
        parentSessionId: 'session-parent',
        prompt: 'Find more files.',
      }),
      (error: unknown) =>
        error instanceof AgentJobRegistryError &&
        error.code === 'AGENT_SCHEDULER_CAPACITY_EXCEEDED' &&
        error.status === 429,
    )
  } finally {
    await scheduler.cancelAgent(running.jobId, 'Test cleanup.')
  }
})

test('ExploreAgentScheduler enforces max depth from parent session metadata', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession({
    ...parentSession(),
    metadata: { agentDepth: 2 },
  })
  const scheduler = new ExploreAgentScheduler({
    storage,
    maxDepth: 2,
    runtimeFactory: () => new RecordingRuntime([]),
  })

  await assert.rejects(
    () => scheduler.spawnAgent({
      parentSessionId: 'session-parent',
      prompt: 'Spawn too deeply.',
    }),
    (error: unknown) =>
      error instanceof AgentJobRegistryError &&
      error.code === 'AGENT_SCHEDULER_MAX_DEPTH_EXCEEDED',
  )
})

test('ExploreAgentScheduler fails jobs that exceed max runtime', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(parentSession())
  const runtime = new HangingRuntime()
  const scheduler = new ExploreAgentScheduler({
    storage,
    now: fixedClock(),
    runtimeFactory: () => runtime,
  })

  const job = await scheduler.spawnAgent({
    parentSessionId: 'session-parent',
    prompt: 'Find files too slowly.',
    maxRuntimeMs: 5,
  })
  await runtime.started
  const failed = await scheduler.waitForAgent(job.jobId, { timeoutMs: 100 })

  assert.equal(failed.status, 'failed')
  assert.equal(failed.error?.code, 'AGENT_JOB_TIMEOUT')
  assert.equal(failed.governance?.maxRuntimeMs, 5)
  assert.equal(failed.governance?.timeoutAt, '2026-06-04T00:00:00.005Z')
  const child = await storage.getSession(job.childSessionId)
  assert.equal(child?.phase, 'failed')
  assert.match(child?.error ?? '', /timed out after 5ms/)
})

test('review and test runtime expose only restricted Bash commands', async () => {
  const storage = new MemoryStorage()
  const runtime = createExploreRuntime({
    agentType: 'test',
    allowedTools: ['ListDir', 'Glob', 'Grep', 'Read', 'Bash'],
    storage,
  })

  const tools = runtime.listTools?.() ?? []
  assert.equal(tools.find(tool => tool.name === 'Bash')?.allowed, true)
  assert.equal(tools.find(tool => tool.name === 'Edit')?.allowed, false)

  const events: NexusEvent[] = []
  for await (const event of runtime.executeStream({
    sessionId: 'session-test-child',
    prompt: 'bash "npm install"',
    cwd: process.cwd(),
    role: 'test',
    skipPermissionCheck: true,
    replaySessionHistory: false,
    storage,
  })) {
    events.push(event)
  }

  const completed = events.find((event): event is Extract<NexusEvent, { type: 'tool_completed' }> =>
    event.type === 'tool_completed' && event.name === 'Bash'
  )
  assert.equal(completed?.success, false)
  assert.match(String((completed?.output as any)?.message), /focused read-only validation commands/)
})

test('ExploreAgentScheduler fails unsupported profiles and missing parent sessions', async () => {
  const scheduler = new ExploreAgentScheduler({
    storage: new MemoryStorage(),
    runtimeFactory: () => new RecordingRuntime([]),
  })

  await assert.rejects(
    () => scheduler.spawnAgent({
      parentSessionId: 'missing-session',
      prompt: 'Find files.',
    }),
    (error: unknown) =>
      error instanceof AgentJobRegistryError && error.code === 'AGENT_PARENT_SESSION_NOT_FOUND',
  )

  const storage = new MemoryStorage()
  await storage.saveSession(parentSession())
  const schedulerWithParent = new ExploreAgentScheduler({
    storage,
    runtimeFactory: () => new RecordingRuntime([]),
  })
  await assert.rejects(
    () => schedulerWithParent.spawnAgent({
      parentSessionId: 'session-parent',
      agentType: 'implement',
      prompt: 'Implement files.',
    }),
    /not enabled|unsupported/,
  )
})

function parentSession(): SessionSnapshot {
  return {
    sessionId: 'session-parent',
    cwd: '/workspace/project',
    prompt: 'Parent prompt',
    phase: 'executing',
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
    events: [],
  }
}

function fixedClock(): () => string {
  return () => '2026-06-04T00:00:00.000Z'
}

class RecordingRuntime implements NexusRuntime {
  readonly calls: RuntimeExecuteOptions[] = []

  constructor(private readonly events: NexusEvent[]) {}

  async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    this.calls.push(options)
    for (const event of this.events) {
      yield { ...event, sessionId: options.sessionId }
    }
  }
}

class HangingRuntime implements NexusRuntime {
  private resolveStarted!: () => void
  readonly started = new Promise<void>(resolve => {
    this.resolveStarted = resolve
  })

  async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    this.resolveStarted()
    while (!options.signal?.aborted) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  }
}

class ProviderToolCallRuntime implements NexusRuntime {
  readonly calls: RuntimeExecuteOptions[] = []
  private readonly tools = createDefaultToolRegistry()

  constructor(private readonly options: {
    storage: MemoryStorage
    allowedTools: string[]
    toolCalls: RuntimeProviderToolCall[]
  }) {}

  async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    this.calls.push(options)
    const metrics = createRuntimeExecutionMetrics()
    for (const call of this.options.toolCalls) {
      const stream = executeProviderToolCall({
        toolCall: call,
        tools: this.tools,
        toolPolicy: allowlistedTools(this.options.allowedTools),
        runtimeOptions: options,
        storage: this.options.storage,
        metrics,
        readFileCache: new Map(),
      })
      for await (const event of stream) yield event
    }
  }
}

function providerToolCall(id: string, name: string, input: unknown): RuntimeProviderToolCall {
  return {
    id,
    name,
    input,
    partialInput: JSON.stringify(input),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 100): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('Timed out waiting for condition.')
}
