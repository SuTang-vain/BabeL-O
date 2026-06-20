import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import type { ToolTrace } from '../src/shared/toolTrace.js'

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-tool-trace-repo-'))
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

function makeTrace(overrides: Partial<ToolTrace> = {}): ToolTrace {
  return {
    toolUseId: 'call_1',
    sessionId: 'sess_1',
    name: 'Bash',
    input: { command: 'ls -la' },
    startedAt: '2026-06-20T00:00:01.000Z',
    ...overrides,
  }
}

test('ToolTraceRepository saveToolTrace + getToolTrace round-trip preserves all fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_tool_trace_repo_roundtrip'
    await storage.saveSession(baseSession(sessionId))
    const trace = makeTrace({
      toolUseId: 'call_roundtrip',
      sessionId,
      name: 'Bash',
      input: { command: 'rm -rf /tmp/x', cwd: '/workspace', env: { DEBUG: '1' } },
      output: 'ok',
      success: true,
      startedAt: '2026-06-20T00:00:01.000Z',
      completedAt: '2026-06-20T00:00:02.500Z',
      durationMs: 1500,
      remoteRunner: { runnerId: 'runner_a', protocolVersion: 'v1', durationMs: 1480, exitCode: 0 },
    })
    await storage.saveToolTrace(trace)

    const loaded = await storage.getToolTrace('call_roundtrip')
    assert.ok(loaded)
    assert.equal(loaded.toolUseId, 'call_roundtrip')
    assert.equal(loaded.sessionId, sessionId)
    assert.equal(loaded.name, 'Bash')
    assert.deepEqual(loaded.input, { command: 'rm -rf /tmp/x', cwd: '/workspace', env: { DEBUG: '1' } })
    assert.equal(loaded.output, 'ok')
    assert.equal(loaded.success, true)
    assert.equal(loaded.startedAt, '2026-06-20T00:00:01.000Z')
    assert.equal(loaded.completedAt, '2026-06-20T00:00:02.500Z')
    assert.equal(loaded.durationMs, 1500)
    assert.deepEqual(loaded.remoteRunner, { runnerId: 'runner_a', protocolVersion: 'v1', durationMs: 1480, exitCode: 0 })
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ToolTraceRepository getToolTrace returns null for unknown toolUseId', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const loaded = await storage.getToolTrace('call_does_not_exist')
    assert.equal(loaded, null)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ToolTraceRepository saveToolTrace is upsert: re-save with same id updates fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_tool_trace_repo_upsert'
    await storage.saveSession(baseSession(sessionId))
    await storage.saveToolTrace(makeTrace({
      toolUseId: 'call_upsert',
      sessionId,
      name: 'Bash',
      input: { command: 'ls' },
      startedAt: '2026-06-20T00:00:01.000Z',
    }))
    await storage.saveToolTrace(makeTrace({
      toolUseId: 'call_upsert',
      sessionId,
      name: 'Bash',
      input: { command: 'ls -la' },
      output: 'file1\nfile2\n',
      success: true,
      startedAt: '2026-06-20T00:00:01.000Z',
      completedAt: '2026-06-20T00:00:01.250Z',
      durationMs: 250,
    }))
    const loaded = await storage.getToolTrace('call_upsert')
    assert.ok(loaded)
    assert.equal(loaded.success, true)
    assert.equal(loaded.output, 'file1\nfile2\n')
    assert.equal(loaded.completedAt, '2026-06-20T00:00:01.250Z')
    assert.equal(loaded.durationMs, 250)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ToolTraceRepository listToolTraces returns traces ordered by started_at ASC', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_tool_trace_repo_order'
    const otherSessionId = 'session_tool_trace_repo_order_other'
    await storage.saveSession(baseSession(sessionId))
    await storage.saveSession(baseSession(otherSessionId))
    await storage.saveToolTrace(makeTrace({ toolUseId: 'call_c', sessionId, startedAt: '2026-06-20T00:00:03.000Z' }))
    await storage.saveToolTrace(makeTrace({ toolUseId: 'call_a', sessionId, startedAt: '2026-06-20T00:00:01.000Z' }))
    await storage.saveToolTrace(makeTrace({ toolUseId: 'call_b', sessionId, startedAt: '2026-06-20T00:00:02.000Z' }))
    // other session — should be excluded
    await storage.saveToolTrace(makeTrace({ toolUseId: 'call_other', sessionId: otherSessionId, startedAt: '2026-06-20T00:00:01.000Z' }))

    const result = await storage.listToolTraces(sessionId, { limit: 10, order: 'asc' })
    assert.equal(result.traces.length, 3)
    assert.equal(result.traces[0].toolUseId, 'call_a')
    assert.equal(result.traces[1].toolUseId, 'call_b')
    assert.equal(result.traces[2].toolUseId, 'call_c')
    assert.equal(result.nextCursor, undefined)
    assert.equal(result.traces.every((t) => t.sessionId === sessionId), true)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ToolTraceRepository listToolTraces composite cursor pagination round-trips full set', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_tool_trace_repo_pagination'
    await storage.saveSession(baseSession(sessionId))
    for (let i = 0; i < 5; i++) {
      await storage.saveToolTrace(makeTrace({
        toolUseId: `call_${i}`,
        sessionId,
        startedAt: `2026-06-20T00:00:0${i + 1}.000Z`,
      }))
    }

    const first = await storage.listToolTraces(sessionId, { limit: 2, order: 'asc' })
    assert.equal(first.traces.length, 2)
    assert.equal(first.traces[0].toolUseId, 'call_0')
    assert.equal(first.traces[1].toolUseId, 'call_1')
    assert.ok(first.nextCursor)

    const second = await storage.listToolTraces(sessionId, { limit: 2, order: 'asc', cursor: first.nextCursor })
    assert.equal(second.traces.length, 2)
    assert.equal(second.traces[0].toolUseId, 'call_2')
    assert.equal(second.traces[1].toolUseId, 'call_3')
    assert.ok(second.nextCursor)

    const third = await storage.listToolTraces(sessionId, { limit: 2, order: 'asc', cursor: second.nextCursor })
    assert.equal(third.traces.length, 1)
    assert.equal(third.traces[0].toolUseId, 'call_4')
    assert.equal(third.nextCursor, undefined)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ToolTraceRepository listToolTraces descending order returns traces in reverse', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_tool_trace_repo_desc'
    await storage.saveSession(baseSession(sessionId))
    await storage.saveToolTrace(makeTrace({ toolUseId: 'call_a', sessionId, startedAt: '2026-06-20T00:00:01.000Z' }))
    await storage.saveToolTrace(makeTrace({ toolUseId: 'call_b', sessionId, startedAt: '2026-06-20T00:00:02.000Z' }))
    await storage.saveToolTrace(makeTrace({ toolUseId: 'call_c', sessionId, startedAt: '2026-06-20T00:00:03.000Z' }))

    const desc = await storage.listToolTraces(sessionId, { limit: 10, order: 'desc' })
    assert.equal(desc.traces.length, 3)
    assert.equal(desc.traces[0].toolUseId, 'call_c')
    assert.equal(desc.traces[1].toolUseId, 'call_b')
    assert.equal(desc.traces[2].toolUseId, 'call_a')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ToolTraceRepository saveToolTrace handles object output as JSON-serialized', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_tool_trace_repo_obj_output'
    await storage.saveSession(baseSession(sessionId))
    const objectOutput = { stdout: 'ok', stderr: '', code: 0, files: ['a.txt', 'b.txt'] }
    await storage.saveToolTrace(makeTrace({
      toolUseId: 'call_obj_output',
      sessionId,
      output: objectOutput,
      success: true,
    }))
    const loaded = await storage.getToolTrace('call_obj_output')
    assert.ok(loaded)
    assert.deepEqual(loaded.output, objectOutput)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ToolTraceRepository saveToolTrace handles minimal trace (no output / success / completedAt)', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_tool_trace_repo_minimal'
    await storage.saveSession(baseSession(sessionId))
    await storage.saveToolTrace(makeTrace({
      toolUseId: 'call_minimal',
      sessionId,
    }))
    const loaded = await storage.getToolTrace('call_minimal')
    assert.ok(loaded)
    assert.equal(loaded.output, undefined)
    assert.equal(loaded.success, undefined)
    assert.equal(loaded.completedAt, undefined)
    assert.equal(loaded.durationMs, undefined)
    assert.equal(loaded.remoteRunner, undefined)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
