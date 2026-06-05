import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AgentJobRegistry,
  AgentJobRegistryError,
  isTerminalAgentJobStatus,
} from '../src/nexus/agents/AgentJobRegistry.js'
import type { AgentResult } from '../src/nexus/agents/types.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'

test('agent job registry creates queued explore jobs with profile defaults', () => {
  const registry = new AgentJobRegistry({ now: fixedClock() })

  const job = registry.createJob({
    parentSessionId: 'session-parent',
    childSessionId: 'session-child',
    prompt: 'Find files related to prefix cache.',
    transcriptPath: '.babel-o/sessions/session-child.jsonl',
    metadata: { source: 'test' },
  })

  assert.equal(job.jobId, 'agent-job-1')
  assert.equal(job.agentType, 'explore')
  assert.equal(job.status, 'queued')
  assert.equal(job.contextForkMode, 'minimal')
  assert.equal(job.isolation, 'none')
  assert.equal(job.createdAt, '2026-06-04T00:00:00.000Z')
  assert.equal(job.updatedAt, '2026-06-04T00:00:00.000Z')
  assert.equal(job.transcriptPath, '.babel-o/sessions/session-child.jsonl')
  assert.deepEqual(job.metadata, { source: 'test' })
})

test('agent job registry lists jobs by parent session, status, and profile', () => {
  const registry = new AgentJobRegistry({ now: fixedClock() })
  const first = registry.createJob({
    parentSessionId: 'session-a',
    childSessionId: 'session-a-child',
    prompt: 'Find runtime files.',
  })
  registry.createJob({
    parentSessionId: 'session-b',
    childSessionId: 'session-b-child',
    prompt: 'Find provider files.',
  })
  registry.markRunning(first.jobId)

  assert.deepEqual(
    registry.listJobs({ parentSessionId: 'session-a' }).map(job => job.jobId),
    [first.jobId],
  )
  assert.deepEqual(
    registry.listJobs({ status: 'running' }).map(job => job.jobId),
    [first.jobId],
  )
  assert.deepEqual(
    registry.listJobs({ agentType: 'explore' }).map(job => job.jobId),
    ['agent-job-1', 'agent-job-2'],
  )
})

test('agent job registry completes running jobs with structured result only', () => {
  const registry = new AgentJobRegistry({ now: incrementingClock() })
  const job = registry.createJob({
    parentSessionId: 'session-parent',
    childSessionId: 'session-child',
    prompt: 'Find AgentScheduler files.',
    transcriptPath: '.babel-o/sessions/session-child.jsonl',
  })

  const running = registry.markRunning(job.jobId)
  assert.equal(running.status, 'running')
  assert.equal(running.startedAt, '2026-06-04T00:00:01.000Z')

  const result: AgentResult = {
    summary: 'Found agent scheduler planning files.',
    findings: [
      {
        severity: 'info',
        message: 'Agent profile defaults live in the agents module.',
        file: 'src/nexus/agents/AgentProfiles.ts',
        line: 1,
      },
    ],
    changedFiles: [],
    testsRun: [],
    commandsRun: [],
    nextSteps: ['Implement AgentJobRegistry.'],
    confidence: 'high',
  }
  const completed = registry.completeJob(job.jobId, result)

  assert.equal(completed.status, 'completed')
  assert.equal(completed.completedAt, '2026-06-04T00:00:02.000Z')
  assert.equal(completed.result?.summary, 'Found agent scheduler planning files.')
  assert.equal(completed.transcriptPath, '.babel-o/sessions/session-child.jsonl')
  assert.equal('transcript' in completed, false)
  assert.deepEqual(completed.result?.changedFiles, [])
  assert.equal(isTerminalAgentJobStatus(completed.status), true)
})

test('agent job registry supports failed and cancelled terminal transitions', () => {
  const registry = new AgentJobRegistry({ now: fixedClock() })
  const failedJob = registry.createJob({
    parentSessionId: 'session-parent',
    childSessionId: 'session-failed',
    prompt: 'Find missing files.',
  })
  const cancelledJob = registry.createJob({
    parentSessionId: 'session-parent',
    childSessionId: 'session-cancelled',
    prompt: 'Find obsolete files.',
  })

  const failed = registry.failJob(failedJob.jobId, {
    code: 'AGENT_RUNTIME_ERROR',
    message: 'Provider failed.',
  })
  const cancelled = registry.cancelJob(cancelledJob.jobId, 'No longer needed.')

  assert.equal(failed.status, 'failed')
  assert.equal(failed.error?.code, 'AGENT_RUNTIME_ERROR')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.error?.code, 'AGENT_JOB_CANCELLED')
  assert.equal(cancelled.error?.message, 'No longer needed.')
  assert.throws(
    () => registry.markRunning(cancelled.jobId),
    (error: unknown) =>
      error instanceof AgentJobRegistryError && error.code === 'AGENT_JOB_TERMINAL',
  )
})

test('agent job registry rejects invalid transitions and unknown jobs', () => {
  const registry = new AgentJobRegistry({ now: fixedClock() })
  const job = registry.createJob({
    parentSessionId: 'session-parent',
    childSessionId: 'session-child',
    prompt: 'Find files.',
  })

  assert.throws(
    () => registry.completeJob(job.jobId, { summary: 'Done.' }),
    (error: unknown) =>
      error instanceof AgentJobRegistryError && error.code === 'AGENT_JOB_INVALID_TRANSITION',
  )
  assert.throws(
    () => registry.getJob('missing-job'),
    (error: unknown) =>
      error instanceof AgentJobRegistryError && error.code === 'AGENT_JOB_NOT_FOUND',
  )
})

test('agent job registry resolves waiters on terminal state', async () => {
  const registry = new AgentJobRegistry({ now: fixedClock() })
  const job = registry.createJob({
    parentSessionId: 'session-parent',
    childSessionId: 'session-child',
    prompt: 'Find files.',
  })

  const waited = registry.waitForJob(job.jobId)
  assert.equal(registry.pendingWaiterCount(job.jobId), 1)
  registry.markRunning(job.jobId)
  registry.completeJob(job.jobId, { summary: 'Done.', confidence: 'high' })

  const completed = await waited
  assert.equal(completed.status, 'completed')
  assert.equal(completed.result?.summary, 'Done.')
  assert.equal(registry.pendingWaiterCount(job.jobId), 0)

  const terminalWait = await registry.waitForJob(job.jobId)
  assert.equal(terminalWait.status, 'completed')
})

test('agent job registry times out waiters without cancelling the job', async () => {
  const registry = new AgentJobRegistry({ now: fixedClock() })
  const job = registry.createJob({
    parentSessionId: 'session-parent',
    childSessionId: 'session-child',
    prompt: 'Find files.',
  })

  await assert.rejects(
    () => registry.waitForJob(job.jobId, { timeoutMs: 1 }),
    (error: unknown) =>
      error instanceof AgentJobRegistryError && error.code === 'AGENT_JOB_WAIT_TIMEOUT',
  )

  assert.equal(registry.getJob(job.jobId).status, 'queued')
  assert.equal(registry.pendingWaiterCount(job.jobId), 0)
})

test('agent job registry returns defensive copies', () => {
  const registry = new AgentJobRegistry({ now: fixedClock() })
  const job = registry.createJob({
    parentSessionId: 'session-parent',
    childSessionId: 'session-child',
    prompt: 'Find files.',
    metadata: { nested: 'original' },
  })

  job.metadata!.nested = 'mutated'
  registry.markRunning(job.jobId)
  const completed = registry.completeJob(job.jobId, {
    summary: 'Done.',
    findings: [{ severity: 'info', message: 'Found file.' }],
  })
  completed.result!.findings![0]!.message = 'Mutated.'

  const stored = registry.getJob(job.jobId)
  assert.deepEqual(stored.metadata, { nested: 'original' })
  assert.equal(stored.result?.findings?.[0]?.message, 'Found file.')
})

test('agent job registry hydrates persisted jobs and preserves generated ids', () => {
  const restored = new AgentJobRegistry({ now: fixedClock() })
  restored.hydrateJobs([
    {
      jobId: 'agent-job-7',
      parentSessionId: 'session-parent',
      childSessionId: 'session-child',
      agentType: 'explore',
      status: 'completed',
      prompt: 'Persisted job.',
      contextForkMode: 'minimal',
      isolation: 'none',
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:01.000Z',
      completedAt: '2026-06-04T00:00:01.000Z',
      result: { summary: 'Persisted.' },
      metadata: { source: 'storage' },
    },
  ])

  assert.equal(restored.getJob('agent-job-7').result?.summary, 'Persisted.')
  const next = restored.createJob({
    parentSessionId: 'session-parent',
    childSessionId: 'session-next',
    prompt: 'Next job.',
  })
  assert.equal(next.jobId, 'agent-job-8')
})

test('agent job storage persists and filters jobs in memory and sqlite', async () => {
  const stores = [
    new MemoryStorage(),
    new SqliteStorage(join(tmpdir(), `babel-o-agent-jobs-${process.pid}-${Date.now()}.sqlite`)),
  ]

  for (const storage of stores) {
    try {
      const registry = new AgentJobRegistry({ now: incrementingClock() })
      const first = registry.createJob({
        parentSessionId: 'session-a',
        childSessionId: 'session-a-child',
        prompt: 'Persist first job.',
        governance: {
          maxConcurrentAgents: 4,
          activeAgents: 0,
          maxDepth: 2,
          depth: 1,
          maxRuntimeMs: 120_000,
          timeoutAt: '2026-06-04T00:02:00.000Z',
        },
      })
      await storage.saveAgentJob(first)
      const second = registry.createJob({
        parentSessionId: 'session-b',
        childSessionId: 'session-b-child',
        prompt: 'Persist second job.',
        agentType: 'review',
      })
      await storage.saveAgentJob(registry.markRunning(second.jobId))
      await storage.saveAgentJob(registry.completeJob(second.jobId, { summary: 'Second done.' }))

      assert.equal((await storage.getAgentJob(first.jobId))?.governance?.depth, 1)
      assert.deepEqual(
        (await storage.listAgentJobs({ parentSessionId: 'session-b' })).map(job => job.jobId),
        [second.jobId],
      )
      assert.deepEqual(
        (await storage.listAgentJobs({ status: 'completed' })).map(job => job.jobId),
        [second.jobId],
      )
      assert.deepEqual(
        (await storage.listAgentJobs({ agentType: 'explore' })).map(job => job.jobId),
        [first.jobId],
      )
    } finally {
      await storage.close?.()
    }
  }
})

function fixedClock(): () => string {
  return () => '2026-06-04T00:00:00.000Z'
}

function incrementingClock(): () => string {
  let tick = -1
  return () => {
    tick += 1
    return `2026-06-04T00:00:0${tick}.000Z`
  }
}
