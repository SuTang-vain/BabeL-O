import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import type { NexusTask } from '../src/shared/task.js'

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-task-repo-'))
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

function makeTask(overrides: Partial<NexusTask> = {}): NexusTask {
  return {
    taskId: 'task_1',
    sessionId: 'sess_1',
    title: 'first task',
    status: 'pending',
    dependsOn: [],
    blocks: [],
    retryCount: 0,
    createdAt: '2026-06-20T00:00:01.000Z',
    updatedAt: '2026-06-20T00:00:01.000Z',
    ...overrides,
  }
}

test('TaskRepository saveTask + getTask round-trip preserves all fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_task_repo_roundtrip'
    await storage.saveSession(baseSession(sessionId))
    const task = makeTask({
      taskId: 'task_roundtrip',
      sessionId,
      title: 'Inspect repo',
      description: 'look at every file',
      status: 'in_progress',
      ownerAgentId: 'agent_alpha',
      createdBySessionId: sessionId,
      source: 'planner',
      dependsOn: ['task_dep_1', 'task_dep_2'],
      blocks: ['task_block_1'],
      retryCount: 2,
      review: { status: 'pending', reason: 'awaiting review', reviewerAgentId: 'agent_beta' },
      metadata: { priority: 'high', tags: ['urgent', 'p0'] },
      result: 'partial',
    })
    await storage.saveTask(task)

    const loaded = await storage.getTask('task_roundtrip')
    assert.ok(loaded)
    assert.equal(loaded.taskId, 'task_roundtrip')
    assert.equal(loaded.sessionId, sessionId)
    assert.equal(loaded.title, 'Inspect repo')
    assert.equal(loaded.description, 'look at every file')
    assert.equal(loaded.status, 'in_progress')
    assert.equal(loaded.ownerAgentId, 'agent_alpha')
    assert.equal(loaded.createdBySessionId, sessionId)
    assert.equal(loaded.source, 'planner')
    assert.deepEqual(loaded.dependsOn, ['task_dep_1', 'task_dep_2'])
    assert.deepEqual(loaded.blocks, ['task_block_1'])
    assert.equal(loaded.retryCount, 2)
    assert.deepEqual(loaded.review, { status: 'pending', reason: 'awaiting review', reviewerAgentId: 'agent_beta' })
    assert.deepEqual(loaded.metadata, { priority: 'high', tags: ['urgent', 'p0'] })
    assert.equal(loaded.result, 'partial')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TaskRepository getTask returns null for unknown taskId', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_task_repo_missing'
    await storage.saveSession(baseSession(sessionId))
    const loaded = await storage.getTask('task_does_not_exist')
    assert.equal(loaded, null)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TaskRepository saveTask is upsert: re-save with same id updates fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_task_repo_upsert'
    await storage.saveSession(baseSession(sessionId))
    await storage.saveTask(makeTask({ taskId: 'task_upsert', sessionId, status: 'pending', title: 'before' }))
    await storage.saveTask(makeTask({
      taskId: 'task_upsert',
      sessionId,
      status: 'completed',
      title: 'after',
      result: 'done',
      updatedAt: '2026-06-20T00:00:05.000Z',
    }))
    const loaded = await storage.getTask('task_upsert')
    assert.ok(loaded)
    assert.equal(loaded.status, 'completed')
    assert.equal(loaded.title, 'after')
    assert.equal(loaded.result, 'done')
    assert.equal(loaded.updatedAt, '2026-06-20T00:00:05.000Z')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TaskRepository listTasks returns all tasks for a session ordered by created_at', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_task_repo_list'
    const otherSessionId = 'session_task_repo_list_other'
    await storage.saveSession(baseSession(sessionId))
    await storage.saveSession(baseSession(otherSessionId))
    // intentionally insert in non-sorted order
    await storage.saveTask(makeTask({
      taskId: 'task_c',
      sessionId,
      title: 'c',
      createdAt: '2026-06-20T00:00:03.000Z',
      updatedAt: '2026-06-20T00:00:03.000Z',
    }))
    await storage.saveTask(makeTask({
      taskId: 'task_a',
      sessionId,
      title: 'a',
      createdAt: '2026-06-20T00:00:01.000Z',
      updatedAt: '2026-06-20T00:00:01.000Z',
    }))
    await storage.saveTask(makeTask({
      taskId: 'task_b',
      sessionId,
      title: 'b',
      createdAt: '2026-06-20T00:00:02.000Z',
      updatedAt: '2026-06-20T00:00:02.000Z',
    }))
    // other session — should be excluded
    await storage.saveTask(makeTask({
      taskId: 'task_other',
      sessionId: otherSessionId,
      title: 'other',
      createdAt: '2026-06-20T00:00:01.000Z',
      updatedAt: '2026-06-20T00:00:01.000Z',
    }))

    const tasks = await storage.listTasks(sessionId)
    assert.equal(tasks.length, 3)
    assert.equal(tasks[0].taskId, 'task_a')
    assert.equal(tasks[1].taskId, 'task_b')
    assert.equal(tasks[2].taskId, 'task_c')
    assert.equal(tasks.every((t) => t.sessionId === sessionId), true)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TaskRepository listTasks returns empty array for session with no tasks', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_task_repo_empty'
    await storage.saveSession(baseSession(sessionId))
    const tasks = await storage.listTasks(sessionId)
    assert.deepEqual(tasks, [])
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TaskRepository saveTask preserves JSON-array columns (dependsOn / blocks)', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_task_repo_json'
    await storage.saveSession(baseSession(sessionId))
    await storage.saveTask(makeTask({
      taskId: 'task_json',
      sessionId,
      dependsOn: ['x', 'y', 'z'],
      blocks: ['m', 'n'],
    }))
    const loaded = await storage.getTask('task_json')
    assert.ok(loaded)
    assert.deepEqual(loaded.dependsOn, ['x', 'y', 'z'])
    assert.deepEqual(loaded.blocks, ['m', 'n'])
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TaskRepository saveTask handles optional fields as null when omitted', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_task_repo_min'
    await storage.saveSession(baseSession(sessionId))
    const minimal: NexusTask = {
      taskId: 'task_min',
      sessionId,
      title: 'minimal',
      status: 'pending',
      dependsOn: [],
      blocks: [],
      retryCount: 0,
      createdAt: '2026-06-20T00:00:00.000Z',
      updatedAt: '2026-06-20T00:00:00.000Z',
    }
    await storage.saveTask(minimal)
    const loaded = await storage.getTask('task_min')
    assert.ok(loaded)
    assert.equal(loaded.description, undefined)
    assert.equal(loaded.ownerAgentId, undefined)
    assert.equal(loaded.createdBySessionId, undefined)
    assert.equal(loaded.source, undefined)
    assert.equal(loaded.result, undefined)
    assert.equal(loaded.review, undefined)
    assert.equal(loaded.metadata, undefined)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
