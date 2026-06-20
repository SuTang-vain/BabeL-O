import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import type { AgentJob } from '../src/shared/agentJob.js'

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-agent-job-repo-'))
  return { dir, dbPath: join(dir, 'nexus.sqlite') }
}

function baseSession(sessionId: string) {
  return {
    sessionId,
    cwd: '/workspace',
    prompt: 'inspect',
    phase: 'created' as const,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    events: [],
  }
}

function makeJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    jobId: 'job_1',
    parentSessionId: 'parent_1',
    childSessionId: 'child_1',
    agentType: 'review',
    status: 'queued',
    prompt: 'audit the storage layer',
    contextForkMode: 'working-set',
    isolation: 'none',
    createdAt: '2026-06-20T00:00:01.000Z',
    updatedAt: '2026-06-20T00:00:01.000Z',
    ...overrides,
  }
}

test('AgentJobRepository saveAgentJob + getAgentJob round-trip preserves all fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('parent_roundtrip'))
    await storage.saveSession(baseSession('child_roundtrip'))
    const job = makeJob({
      jobId: 'job_roundtrip',
      parentSessionId: 'parent_roundtrip',
      childSessionId: 'child_roundtrip',
      agentType: 'debug',
      status: 'completed',
      prompt: 'trace the bug',
      contextForkMode: 'debug-replay',
      isolation: 'worktree',
      createdAt: '2026-06-20T00:00:01.000Z',
      updatedAt: '2026-06-20T00:00:05.000Z',
      startedAt: '2026-06-20T00:00:02.000Z',
      completedAt: '2026-06-20T00:00:05.000Z',
      result: { summary: 'root cause was a stale closure', confidence: 'high' },
      error: { code: 'TIMEOUT', message: 'exec blew past budget' },
      transcriptPath: '/var/transcripts/job_roundtrip.jsonl',
      governance: {
        maxConcurrentAgents: 4,
        activeAgents: 1,
        maxDepth: 3,
        depth: 1,
        maxRuntimeMs: 60_000,
        timeoutAt: '2026-06-20T00:01:05.000Z',
      },
      metadata: { trigger: 'manual', tags: ['p0'] },
    })
    await storage.saveAgentJob(job)
    const loaded = await storage.getAgentJob('job_roundtrip')
    assert.ok(loaded)
    assert.equal(loaded.jobId, 'job_roundtrip')
    assert.equal(loaded.parentSessionId, 'parent_roundtrip')
    assert.equal(loaded.childSessionId, 'child_roundtrip')
    assert.equal(loaded.agentType, 'debug')
    assert.equal(loaded.status, 'completed')
    assert.equal(loaded.prompt, 'trace the bug')
    assert.equal(loaded.contextForkMode, 'debug-replay')
    assert.equal(loaded.isolation, 'worktree')
    assert.equal(loaded.startedAt, '2026-06-20T00:00:02.000Z')
    assert.equal(loaded.completedAt, '2026-06-20T00:00:05.000Z')
    assert.deepEqual(loaded.result, { summary: 'root cause was a stale closure', confidence: 'high' })
    assert.deepEqual(loaded.error, { code: 'TIMEOUT', message: 'exec blew past budget' })
    assert.equal(loaded.transcriptPath, '/var/transcripts/job_roundtrip.jsonl')
    assert.equal(loaded.governance?.maxConcurrentAgents, 4)
    assert.equal(loaded.governance?.timeoutAt, '2026-06-20T00:01:05.000Z')
    assert.deepEqual(loaded.metadata, { trigger: 'manual', tags: ['p0'] })
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AgentJobRepository getAgentJob returns null for unknown jobId', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const loaded = await storage.getAgentJob('job_does_not_exist')
    assert.equal(loaded, null)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AgentJobRepository saveAgentJob is upsert: re-save with same id updates fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('parent_upsert'))
    await storage.saveSession(baseSession('child_upsert'))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_upsert',
      parentSessionId: 'parent_upsert',
      childSessionId: 'child_upsert',
      status: 'queued',
      createdAt: '2026-06-20T00:00:01.000Z',
      updatedAt: '2026-06-20T00:00:01.000Z',
    }))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_upsert',
      parentSessionId: 'parent_upsert',
      childSessionId: 'child_upsert',
      status: 'completed',
      startedAt: '2026-06-20T00:00:02.000Z',
      completedAt: '2026-06-20T00:00:05.000Z',
      result: { summary: 'done' },
      createdAt: '2026-06-20T00:00:01.000Z',
      updatedAt: '2026-06-20T00:00:05.000Z',
    }))
    const loaded = await storage.getAgentJob('job_upsert')
    assert.ok(loaded)
    assert.equal(loaded.status, 'completed')
    assert.equal(loaded.startedAt, '2026-06-20T00:00:02.000Z')
    assert.equal(loaded.completedAt, '2026-06-20T00:00:05.000Z')
    assert.deepEqual(loaded.result, { summary: 'done' })
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AgentJobRepository listAgentJobs returns empty array when no jobs exist', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const jobs = await storage.listAgentJobs()
    assert.deepEqual(jobs, [])
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AgentJobRepository listAgentJobs without filter returns all jobs ordered by created_at ASC, job_id ASC', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('parent_order'))
    await storage.saveSession(baseSession('child_order'))
    // intentionally insert out of order
    await storage.saveAgentJob(makeJob({
      jobId: 'job_c', parentSessionId: 'parent_order', childSessionId: 'child_order',
      createdAt: '2026-06-20T00:00:03.000Z', updatedAt: '2026-06-20T00:00:03.000Z',
    }))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_a', parentSessionId: 'parent_order', childSessionId: 'child_order',
      createdAt: '2026-06-20T00:00:01.000Z', updatedAt: '2026-06-20T00:00:01.000Z',
    }))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_b', parentSessionId: 'parent_order', childSessionId: 'child_order',
      createdAt: '2026-06-20T00:00:02.000Z', updatedAt: '2026-06-20T00:00:02.000Z',
    }))

    const jobs = await storage.listAgentJobs()
    assert.equal(jobs.length, 3)
    assert.equal(jobs[0].jobId, 'job_a')
    assert.equal(jobs[1].jobId, 'job_b')
    assert.equal(jobs[2].jobId, 'job_c')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AgentJobRepository listAgentJobs filter by parentSessionId excludes other parents', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('parent_a'))
    await storage.saveSession(baseSession('parent_b'))
    await storage.saveSession(baseSession('child_x'))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_a1', parentSessionId: 'parent_a', childSessionId: 'child_x',
      createdAt: '2026-06-20T00:00:01.000Z', updatedAt: '2026-06-20T00:00:01.000Z',
    }))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_a2', parentSessionId: 'parent_a', childSessionId: 'child_x',
      createdAt: '2026-06-20T00:00:02.000Z', updatedAt: '2026-06-20T00:00:02.000Z',
    }))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_b1', parentSessionId: 'parent_b', childSessionId: 'child_x',
      createdAt: '2026-06-20T00:00:03.000Z', updatedAt: '2026-06-20T00:00:03.000Z',
    }))

    const aJobs = await storage.listAgentJobs({ parentSessionId: 'parent_a' })
    assert.equal(aJobs.length, 2)
    assert.deepEqual(aJobs.map(j => j.jobId).sort(), ['job_a1', 'job_a2'])

    const bJobs = await storage.listAgentJobs({ parentSessionId: 'parent_b' })
    assert.equal(bJobs.length, 1)
    assert.equal(bJobs[0].jobId, 'job_b1')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AgentJobRepository listAgentJobs filter by status excludes other statuses', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('parent_status'))
    await storage.saveSession(baseSession('child_status'))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_queued', parentSessionId: 'parent_status', childSessionId: 'child_status',
      status: 'queued', createdAt: '2026-06-20T00:00:01.000Z', updatedAt: '2026-06-20T00:00:01.000Z',
    }))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_running', parentSessionId: 'parent_status', childSessionId: 'child_status',
      status: 'running', createdAt: '2026-06-20T00:00:02.000Z', updatedAt: '2026-06-20T00:00:02.000Z',
    }))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_completed', parentSessionId: 'parent_status', childSessionId: 'child_status',
      status: 'completed', createdAt: '2026-06-20T00:00:03.000Z', updatedAt: '2026-06-20T00:00:03.000Z',
    }))

    const running = await storage.listAgentJobs({ status: 'running' })
    assert.equal(running.length, 1)
    assert.equal(running[0].jobId, 'job_running')

    const queued = await storage.listAgentJobs({ status: 'queued' })
    assert.equal(queued.length, 1)
    assert.equal(queued[0].jobId, 'job_queued')

    const failed = await storage.listAgentJobs({ status: 'failed' })
    assert.equal(failed.length, 0)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AgentJobRepository listAgentJobs filter by agentType excludes other agent types', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('parent_agent_type'))
    await storage.saveSession(baseSession('child_agent_type'))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_review', parentSessionId: 'parent_agent_type', childSessionId: 'child_agent_type',
      agentType: 'review', createdAt: '2026-06-20T00:00:01.000Z', updatedAt: '2026-06-20T00:00:01.000Z',
    }))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_implement', parentSessionId: 'parent_agent_type', childSessionId: 'child_agent_type',
      agentType: 'implement', createdAt: '2026-06-20T00:00:02.000Z', updatedAt: '2026-06-20T00:00:02.000Z',
    }))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_explore', parentSessionId: 'parent_agent_type', childSessionId: 'child_agent_type',
      agentType: 'explore', createdAt: '2026-06-20T00:00:03.000Z', updatedAt: '2026-06-20T00:00:03.000Z',
    }))

    const review = await storage.listAgentJobs({ agentType: 'review' })
    assert.equal(review.length, 1)
    assert.equal(review[0].jobId, 'job_review')

    const implement = await storage.listAgentJobs({ agentType: 'implement' })
    assert.equal(implement.length, 1)
    assert.equal(implement[0].jobId, 'job_implement')

    const debug = await storage.listAgentJobs({ agentType: 'debug' })
    assert.equal(debug.length, 0)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AgentJobRepository listAgentJobs combined filters (parentSessionId + status + agentType) compose via AND', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('parent_a'))
    await storage.saveSession(baseSession('parent_b'))
    await storage.saveSession(baseSession('child_x'))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_match', parentSessionId: 'parent_a', childSessionId: 'child_x',
      agentType: 'review', status: 'completed',
      createdAt: '2026-06-20T00:00:01.000Z', updatedAt: '2026-06-20T00:00:01.000Z',
    }))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_wrong_status', parentSessionId: 'parent_a', childSessionId: 'child_x',
      agentType: 'review', status: 'queued',
      createdAt: '2026-06-20T00:00:02.000Z', updatedAt: '2026-06-20T00:00:02.000Z',
    }))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_wrong_parent', parentSessionId: 'parent_b', childSessionId: 'child_x',
      agentType: 'review', status: 'completed',
      createdAt: '2026-06-20T00:00:03.000Z', updatedAt: '2026-06-20T00:00:03.000Z',
    }))
    await storage.saveAgentJob(makeJob({
      jobId: 'job_wrong_type', parentSessionId: 'parent_a', childSessionId: 'child_x',
      agentType: 'implement', status: 'completed',
      createdAt: '2026-06-20T00:00:04.000Z', updatedAt: '2026-06-20T00:00:04.000Z',
    }))

    const filtered = await storage.listAgentJobs({
      parentSessionId: 'parent_a',
      status: 'completed',
      agentType: 'review',
    })
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].jobId, 'job_match')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AgentJobRepository saveAgentJob preserves complex nested result + error + metadata JSON', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('parent_complex'))
    await storage.saveSession(baseSession('child_complex'))
    const complexResult = {
      summary: 'decoupled the storage layer into 6 repositories',
      findings: [
        { severity: 'info' as const, message: 'extracted EventRepository', file: 'src/storage/EventRepository.ts', line: 1 },
        { severity: 'warning' as const, message: 'helper functions were orphaned during extraction', file: 'src/storage/SqliteStorage.ts' },
        { severity: 'error' as const, message: 'JSON.stringify circular ref', evidence: 'self-reference' },
      ],
      changedFiles: ['src/storage/SqliteStorage.ts', 'src/storage/AgentJobRepository.ts'],
      testsRun: ['test/storage-agent-job-repository.test.ts'],
      commandsRun: ['pnpm run typecheck', 'pnpm test'],
      nextSteps: ['continue 3B-26', 'update plan doc'],
      confidence: 'medium' as const,
    }
    const complexError = {
      code: 'PARTIAL_FAILURE',
      message: 'repository 3 failed but others passed',
      details: { failedStep: 3, totalSteps: 6, indices: [3] },
    }
    const complexMetadata = {
      trigger: 'auto-refactor',
      tags: ['p0', 'storage'],
      nested: { source: 'plan', refs: ['docs/nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md'] },
    }
    const job = makeJob({
      jobId: 'job_complex',
      parentSessionId: 'parent_complex',
      childSessionId: 'child_complex',
      result: complexResult,
      error: complexError,
      metadata: complexMetadata,
    })
    await storage.saveAgentJob(job)
    const loaded = await storage.getAgentJob('job_complex')
    assert.ok(loaded)
    assert.deepEqual(loaded.result, complexResult)
    assert.deepEqual(loaded.error, complexError)
    assert.deepEqual(loaded.metadata, complexMetadata)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
