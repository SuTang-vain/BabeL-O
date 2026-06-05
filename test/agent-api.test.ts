import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNexusApp } from '../src/nexus/app.js'
import { AgentJobRegistry } from '../src/nexus/agents/AgentJobRegistry.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'
import type { NexusRuntime } from '../src/runtime/Runtime.js'
import type { SessionSnapshot } from '../src/shared/session.js'
import type { AgentJob, AgentScheduler, AgentSpawnRequest, AgentWaitOptions, AgentJobFilter } from '../src/nexus/agents/types.js'

const parent: SessionSnapshot = {
  sessionId: 'session-parent',
  cwd: '/workspace/project',
  prompt: 'Parent prompt',
  phase: 'executing',
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  events: [],
}

const transcriptEvent: NexusEvent = {
  type: 'assistant_delta',
  schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
  sessionId: 'session-child',
  timestamp: '2026-06-04T00:00:01.000Z',
  text: 'Found AgentScheduler.',
}

test('Nexus agent API manages jobs and transcript pages', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(parent)
  const scheduler = new RecordingScheduler(storage)
  const app = await createNexusApp({
    runtime: new EmptyRuntime(),
    storage,
    agentScheduler: scheduler,
    defaultCwd: '/workspace/project',
  })

  try {
    await app.ready()

    const spawned = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: {
        parentSessionId: 'session-parent',
        prompt: 'Find AgentScheduler.ts',
        agentType: 'review',
        contextForkMode: 'task-focused',
      },
    })
    assert.equal(spawned.statusCode, 200)
    const spawnedBody = spawned.json()
    assert.equal(spawnedBody.type, 'agent_job_spawned')
    assert.equal(spawnedBody.job.status, 'queued')
    assert.deepEqual(scheduler.spawnRequests, [{
      parentSessionId: 'session-parent',
      prompt: 'Find AgentScheduler.ts',
      agentType: 'review',
      contextForkMode: 'task-focused',
    }])

    const list = await app.inject({ method: 'GET', url: '/v1/agents?parentSessionId=session-parent&status=queued' })
    assert.equal(list.statusCode, 200)
    assert.equal(list.json().jobs.length, 1)
    assert.deepEqual(scheduler.listFilters.at(-1), { parentSessionId: 'session-parent', status: 'queued' })

    const sessionList = await app.inject({ method: 'GET', url: '/v1/sessions/session-parent/agents?agentType=review' })
    assert.equal(sessionList.statusCode, 200)
    assert.equal(sessionList.json().parentSessionId, 'session-parent')
    assert.deepEqual(scheduler.listFilters.at(-1), { agentType: 'review', parentSessionId: 'session-parent' })

    const shown = await app.inject({ method: 'GET', url: '/v1/agents/agent-job-1' })
    assert.equal(shown.statusCode, 200)
    assert.equal(shown.json().job.jobId, 'agent-job-1')

    const waited = await app.inject({
      method: 'POST',
      url: '/v1/agents/agent-job-1/wait',
      payload: { timeoutMs: 50 },
    })
    assert.equal(waited.statusCode, 200)
    assert.equal(waited.json().job.status, 'completed')
    assert.deepEqual(scheduler.waitRequests, [{ jobId: 'agent-job-1', options: { timeoutMs: 50 } }])

    const transcript = await app.inject({ method: 'GET', url: '/v1/agents/agent-job-1/transcript?limit=10' })
    assert.equal(transcript.statusCode, 200)
    assert.equal(transcript.json().type, 'agent_transcript')
    assert.equal(transcript.json().childSessionId, 'session-child')
    assert.deepEqual(transcript.json().events, [transcriptEvent])

    const cancelled = await app.inject({
      method: 'POST',
      url: '/v1/agents/agent-job-1/cancel',
      payload: { reason: 'Stop.' },
    })
    assert.equal(cancelled.statusCode, 200)
    assert.equal(cancelled.json().job.status, 'cancelled')
    assert.deepEqual(scheduler.cancelRequests, [{ jobId: 'agent-job-1', reason: 'Stop.' }])
  } finally {
    await app.close()
  }
})

test('Nexus agent API returns not found for unknown agent transcripts', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(parent)
  const app = await createNexusApp({
    runtime: new EmptyRuntime(),
    storage,
    agentScheduler: new RecordingScheduler(storage),
    defaultCwd: '/workspace/project',
  })

  try {
    await app.ready()
    const missing = await app.inject({ method: 'GET', url: '/v1/agents/missing/transcript' })
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.json().code, 'AGENT_JOB_NOT_FOUND')
  } finally {
    await app.close()
  }
})

class EmptyRuntime implements NexusRuntime {
  async *executeStream(): AsyncIterable<NexusEvent> {}
}

class RecordingScheduler implements AgentScheduler {
  private readonly registry = new AgentJobRegistry({ now: () => '2026-06-04T00:00:00.000Z' })
  readonly spawnRequests: AgentSpawnRequest[] = []
  readonly waitRequests: Array<{ jobId: string; options?: AgentWaitOptions }> = []
  readonly listFilters: Array<AgentJobFilter | undefined> = []
  readonly cancelRequests: Array<{ jobId: string; reason?: string }> = []

  constructor(private readonly storage: MemoryStorage) {}

  async spawnAgent(request: AgentSpawnRequest): Promise<AgentJob> {
    this.spawnRequests.push(request)
    const job = this.registry.createJob({
      parentSessionId: request.parentSessionId,
      childSessionId: 'session-child',
      prompt: request.prompt,
      agentType: request.agentType,
      contextForkMode: request.contextForkMode,
      isolation: request.isolation,
    })
    await this.storage.saveSession({
      sessionId: 'session-child',
      cwd: '/workspace/project',
      prompt: request.prompt,
      phase: 'completed',
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:01.000Z',
      parentSessionId: request.parentSessionId,
      events: [],
    })
    await this.storage.appendEvent('session-child', transcriptEvent)
    return job
  }

  async waitForAgent(jobId: string, options?: AgentWaitOptions): Promise<AgentJob> {
    this.waitRequests.push({ jobId, options })
    this.registry.markRunning(jobId)
    return this.registry.completeJob(jobId, { summary: 'Completed.', confidence: 'high' })
  }

  async listAgents(filter?: AgentJobFilter): Promise<AgentJob[]> {
    this.listFilters.push(filter)
    return this.registry.listJobs(filter)
  }

  async cancelAgent(jobId: string, reason?: string): Promise<AgentJob> {
    this.cancelRequests.push({ jobId, reason })
    return {
      ...this.registry.getJob(jobId),
      status: 'cancelled',
      error: { code: 'AGENT_JOB_CANCELLED', message: reason ?? 'Agent job cancelled.' },
    }
  }
}
