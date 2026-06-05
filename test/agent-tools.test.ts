import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentToolRegistry } from '../src/nexus/agents/AgentTools.js'
import type { AgentJob, AgentScheduler, AgentSpawnRequest, AgentWaitOptions, AgentJobFilter } from '../src/nexus/agents/types.js'

const queuedJob: AgentJob = {
  jobId: 'agent-job-1',
  parentSessionId: 'session-parent',
  childSessionId: 'session-child',
  agentType: 'explore',
  status: 'queued',
  prompt: 'Find files.',
  contextForkMode: 'minimal',
  isolation: 'none',
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  governance: {
    maxConcurrentAgents: 4,
    activeAgents: 0,
    maxDepth: 2,
    depth: 1,
    maxRuntimeMs: 120_000,
    timeoutAt: '2026-06-04T00:02:00.000Z',
  },
}

const completedJob: AgentJob = {
  ...queuedJob,
  status: 'completed',
  result: { summary: 'Found files.', confidence: 'high' },
  completedAt: '2026-06-04T00:00:01.000Z',
}

test('Agent tools expose spawn/wait/list/cancel definitions', () => {
  const tools = createAgentToolRegistry(new RecordingScheduler())

  assert.deepEqual([...tools.keys()], ['AgentSpawn', 'AgentWait', 'AgentList', 'AgentCancel'])
  for (const tool of tools.values()) {
    assert.equal(tool.risk, 'task')
    assert.equal(tool.requiresApproval, false)
    assert.ok(tool.prompt?.().length)
  }
})

test('AgentSpawn uses current session as parent and can wait for result', async () => {
  const scheduler = new RecordingScheduler()
  const spawn = createAgentToolRegistry(scheduler).get('AgentSpawn')!

  const result = await spawn.execute({
    prompt: 'Find AgentScheduler files.',
    agentType: 'explore',
    wait: true,
    timeoutMs: 50,
  }, toolContext('session-parent'))

  assert.equal(result.success, true)
  assert.deepEqual(scheduler.spawnRequests, [{
    parentSessionId: 'session-parent',
    prompt: 'Find AgentScheduler files.',
    agentType: 'explore',
    contextForkMode: undefined,
    isolation: undefined,
  }])
  assert.deepEqual(scheduler.waitRequests, [{ jobId: 'agent-job-1', options: { timeoutMs: 50 } }])
  assert.equal((result.output as any).status, 'completed')
  assert.equal((result.output as any).governance.maxConcurrentAgents, 4)
  assert.equal((result.output as any).result.summary, 'Found files.')
})

test('AgentSpawn passes review and task-focused options through scheduler', async () => {
  const scheduler = new RecordingScheduler()
  const spawn = createAgentToolRegistry(scheduler).get('AgentSpawn')!

  const result = await spawn.execute({
    prompt: 'Review ContextForker changes.',
    agentType: 'review',
    contextForkMode: 'task-focused',
    isolation: 'none',
    wait: false,
  }, toolContext('session-parent'))

  assert.equal(result.success, true)
  assert.deepEqual(scheduler.spawnRequests, [{
    parentSessionId: 'session-parent',
    prompt: 'Review ContextForker changes.',
    agentType: 'review',
    contextForkMode: 'task-focused',
    isolation: 'none',
  }])
})

test('AgentWait, AgentList, and AgentCancel call scheduler', async () => {
  const scheduler = new RecordingScheduler()
  const tools = createAgentToolRegistry(scheduler)

  const waited = await tools.get('AgentWait')!.execute({ jobId: 'agent-job-1' }, toolContext('session-parent'))
  const listed = await tools.get('AgentList')!.execute({ status: 'completed' }, toolContext('session-parent'))
  const cancelled = await tools.get('AgentCancel')!.execute({
    jobId: 'agent-job-1',
    reason: 'Stop.',
  }, toolContext('session-parent'))

  assert.equal((waited.output as AgentJob).status, 'completed')
  assert.deepEqual(scheduler.listFilters, [{ parentSessionId: 'session-parent', status: 'completed' }])
  assert.deepEqual((listed.output as any).jobs, [completedJob])
  assert.equal((cancelled.output as AgentJob).status, 'cancelled')
  assert.deepEqual(scheduler.cancelRequests, [{ jobId: 'agent-job-1', reason: 'Stop.' }])
})

function toolContext(sessionId: string) {
  return {
    cwd: '/workspace/project',
    sessionId,
    maxOutputBytes: 100_000,
    bashMaxBufferBytes: 100_000,
  }
}

class RecordingScheduler implements AgentScheduler {
  readonly spawnRequests: AgentSpawnRequest[] = []
  readonly waitRequests: Array<{ jobId: string; options?: AgentWaitOptions }> = []
  readonly listFilters: Array<AgentJobFilter | undefined> = []
  readonly cancelRequests: Array<{ jobId: string; reason?: string }> = []

  async spawnAgent(request: AgentSpawnRequest): Promise<AgentJob> {
    this.spawnRequests.push(request)
    return queuedJob
  }

  async waitForAgent(jobId: string, options?: AgentWaitOptions): Promise<AgentJob> {
    this.waitRequests.push({ jobId, options })
    return completedJob
  }

  async listAgents(filter?: AgentJobFilter): Promise<AgentJob[]> {
    this.listFilters.push(filter)
    return [completedJob]
  }

  async cancelAgent(jobId: string, reason?: string): Promise<AgentJob> {
    this.cancelRequests.push({ jobId, reason })
    return {
      ...queuedJob,
      status: 'cancelled',
      error: { code: 'AGENT_JOB_CANCELLED', message: reason ?? 'Cancelled.' },
    }
  }
}
