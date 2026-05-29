import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'
import type { ToolTrace } from '../src/shared/toolTrace.js'

test('MemoryStorage tool trace lifecycle and pagination', async () => {
  const storage = new MemoryStorage()
  const sessionId = 'session-mem-1'

  // 1. Initial State
  await storage.saveSession({
    sessionId,
    cwd: tmpdir(),
    prompt: 'test memory traces',
    phase: 'created',
    createdAt: '2026-05-22T12:00:00.000Z',
    updatedAt: '2026-05-22T12:00:00.000Z',
    events: [],
  })
  const empty = await storage.listToolTraces(sessionId)
  assert.equal(empty.traces.length, 0)
  assert.equal(empty.nextCursor, undefined)

  // 2. Intercept Event: tool_started
  const startEvent: NexusEvent = {
    type: 'tool_started',
    schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
    sessionId,
    timestamp: '2026-05-22T12:00:00.000Z',
    toolUseId: 'tool-use-1',
    name: 'bash',
    input: { command: 'echo "hello"' },
  }
  await storage.appendEvent(sessionId, startEvent)

  const trace1 = await storage.getToolTrace('tool-use-1')
  assert.ok(trace1)
  assert.equal(trace1.toolUseId, 'tool-use-1')
  assert.equal(trace1.sessionId, sessionId)
  assert.equal(trace1.name, 'bash')
  assert.deepEqual(trace1.input, { command: 'echo "hello"' })
  assert.equal(trace1.startedAt, '2026-05-22T12:00:00.000Z')
  assert.equal(trace1.completedAt, undefined)
  assert.equal(trace1.durationMs, undefined)
  assert.equal(trace1.success, undefined)

  // 3. Intercept Event: tool_completed
  const completeEvent: NexusEvent = {
    type: 'tool_completed',
    schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
    sessionId,
    timestamp: '2026-05-22T12:00:01.500Z',
    toolUseId: 'tool-use-1',
    name: 'bash',
    success: true,
    output: 'hello\n',
  }
  await storage.appendEvent(sessionId, completeEvent)

  const trace1Updated = await storage.getToolTrace('tool-use-1')
  assert.ok(trace1Updated)
  assert.equal(trace1Updated.completedAt, '2026-05-22T12:00:01.500Z')
  assert.equal(trace1Updated.durationMs, 1500)
  assert.equal(trace1Updated.success, true)
  assert.equal(trace1Updated.output, 'hello\n')

  // 4. Pagination Setup
  // Clean up and create 5 traces
  const storageForPaging = new MemoryStorage()
  const pSessionId = 'session-mem-paging'

  for (let i = 1; i <= 5; i++) {
    const trace: ToolTrace = {
      toolUseId: `tool-${i}`,
      sessionId: pSessionId,
      name: `tool-name-${i}`,
      input: { i },
      startedAt: `2026-05-22T12:00:0${i}.000Z`,
      completedAt: `2026-05-22T12:00:0${i}.100Z`,
      durationMs: 100,
      success: true,
      output: `out-${i}`,
    }
    await storageForPaging.saveToolTrace(trace)
  }

  // Test Ascending Pagination
  const ascPage1 = await storageForPaging.listToolTraces(pSessionId, { limit: 2, order: 'asc' })
  assert.equal(ascPage1.traces.length, 2)
  assert.equal(ascPage1.traces[0]?.toolUseId, 'tool-1')
  assert.equal(ascPage1.traces[1]?.toolUseId, 'tool-2')
  assert.equal(ascPage1.nextCursor, '2')

  const ascPage2 = await storageForPaging.listToolTraces(pSessionId, { limit: 2, order: 'asc', cursor: ascPage1.nextCursor })
  assert.equal(ascPage2.traces.length, 2)
  assert.equal(ascPage2.traces[0]?.toolUseId, 'tool-3')
  assert.equal(ascPage2.traces[1]?.toolUseId, 'tool-4')
  assert.equal(ascPage2.nextCursor, '4')

  const ascPage3 = await storageForPaging.listToolTraces(pSessionId, { limit: 2, order: 'asc', cursor: ascPage2.nextCursor })
  assert.equal(ascPage3.traces.length, 1)
  assert.equal(ascPage3.traces[0]?.toolUseId, 'tool-5')
  assert.equal(ascPage3.nextCursor, undefined)

  // Test Descending Pagination
  const descPage1 = await storageForPaging.listToolTraces(pSessionId, { limit: 2, order: 'desc' })
  assert.equal(descPage1.traces.length, 2)
  assert.equal(descPage1.traces[0]?.toolUseId, 'tool-5')
  assert.equal(descPage1.traces[1]?.toolUseId, 'tool-4')
  assert.equal(descPage1.nextCursor, '2')

  const descPage2 = await storageForPaging.listToolTraces(pSessionId, { limit: 2, order: 'desc', cursor: descPage1.nextCursor })
  assert.equal(descPage2.traces.length, 2)
  assert.equal(descPage2.traces[0]?.toolUseId, 'tool-3')
  assert.equal(descPage2.traces[1]?.toolUseId, 'tool-2')
  assert.equal(descPage2.nextCursor, '4')

  const descPage3 = await storageForPaging.listToolTraces(pSessionId, { limit: 2, order: 'desc', cursor: descPage2.nextCursor })
  assert.equal(descPage3.traces.length, 1)
  assert.equal(descPage3.traces[0]?.toolUseId, 'tool-1')
  assert.equal(descPage3.nextCursor, undefined)
})

test('SqliteStorage tool trace lifecycle and pagination', async () => {
  const tempDir = join(tmpdir(), `babel-o-test-sqlite-traces-${Date.now()}`)
  await mkdir(tempDir, { recursive: true })
  const dbPath = join(tempDir, 'nexus.sqlite')

  const storage = new SqliteStorage(dbPath)
  const sessionId = 'session-sqlite-1'

  try {
    // 1. Initial State
    const empty = await storage.listToolTraces(sessionId)
    assert.equal(empty.traces.length, 0)
    assert.equal(empty.nextCursor, undefined)

    // Make sure session exists so foreign key references or updates on session work
    // (SqliteStorage.appendEvent writes a log and updates session timestamp)
    await storage.saveSession({
      sessionId,
      cwd: tempDir,
      prompt: 'test sqlite traces',
      phase: 'created',
      createdAt: '2026-05-22T12:00:00.000Z',
      updatedAt: '2026-05-22T12:00:00.000Z',
      events: [],
    })

    // 2. Intercept Event: tool_started
    const startEvent: NexusEvent = {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-22T12:00:00.000Z',
      toolUseId: 'tool-use-1',
      name: 'bash',
      input: { command: 'echo "hello"' },
    }
    await storage.appendEvent(sessionId, startEvent)

    const trace1 = await storage.getToolTrace('tool-use-1')
    assert.ok(trace1)
    assert.equal(trace1.toolUseId, 'tool-use-1')
    assert.equal(trace1.sessionId, sessionId)
    assert.equal(trace1.name, 'bash')
    assert.deepEqual(trace1.input, { command: 'echo "hello"' })
    assert.equal(trace1.startedAt, '2026-05-22T12:00:00.000Z')
    assert.equal(trace1.completedAt, undefined)
    assert.equal(trace1.durationMs, undefined)
    assert.equal(trace1.success, undefined)

    // 3. Intercept Event: tool_completed
    const completeEvent: NexusEvent = {
      type: 'tool_completed',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-22T12:00:01.500Z',
      toolUseId: 'tool-use-1',
      name: 'bash',
      success: true,
      output: 'hello\n',
    }
    await storage.appendEvent(sessionId, completeEvent)

    const trace1Updated = await storage.getToolTrace('tool-use-1')
    assert.ok(trace1Updated)
    assert.equal(trace1Updated.completedAt, '2026-05-22T12:00:01.500Z')
    assert.equal(trace1Updated.durationMs, 1500)
    assert.equal(trace1Updated.success, true)
    assert.equal(trace1Updated.output, 'hello\n')

    // 4. Pagination Setup with 5 traces
    const pSessionId = 'session-sqlite-paging'
    await storage.saveSession({
      sessionId: pSessionId,
      cwd: tempDir,
      prompt: 'test sqlite paging',
      phase: 'created',
      createdAt: '2026-05-22T12:00:00.000Z',
      updatedAt: '2026-05-22T12:00:00.000Z',
      events: [],
    })

    const traces: ToolTrace[] = []
    for (let i = 1; i <= 5; i++) {
      const trace: ToolTrace = {
        toolUseId: `tool-${i}`,
        sessionId: pSessionId,
        name: `tool-name-${i}`,
        input: { i },
        startedAt: `2026-05-22T12:00:0${i}.000Z`,
        completedAt: `2026-05-22T12:00:0${i}.100Z`,
        durationMs: 100,
        success: true,
        output: `out-${i}`,
      }
      traces.push(trace)
      await storage.saveToolTrace(trace)
    }

    // Test Ascending Pagination
    const ascPage1 = await storage.listToolTraces(pSessionId, { limit: 2, order: 'asc' })
    assert.equal(ascPage1.traces.length, 2)
    assert.equal(ascPage1.traces[0]?.toolUseId, 'tool-1')
    assert.equal(ascPage1.traces[1]?.toolUseId, 'tool-2')
    assert.equal(ascPage1.nextCursor, `${traces[1]?.startedAt}|tool-2`)

    const ascPage2 = await storage.listToolTraces(pSessionId, { limit: 2, order: 'asc', cursor: ascPage1.nextCursor })
    assert.equal(ascPage2.traces.length, 2)
    assert.equal(ascPage2.traces[0]?.toolUseId, 'tool-3')
    assert.equal(ascPage2.traces[1]?.toolUseId, 'tool-4')
    assert.equal(ascPage2.nextCursor, `${traces[3]?.startedAt}|tool-4`)

    const ascPage3 = await storage.listToolTraces(pSessionId, { limit: 2, order: 'asc', cursor: ascPage2.nextCursor })
    assert.equal(ascPage3.traces.length, 1)
    assert.equal(ascPage3.traces[0]?.toolUseId, 'tool-5')
    assert.equal(ascPage3.nextCursor, undefined)

    // Test Descending Pagination
    const descPage1 = await storage.listToolTraces(pSessionId, { limit: 2, order: 'desc' })
    assert.equal(descPage1.traces.length, 2)
    assert.equal(descPage1.traces[0]?.toolUseId, 'tool-5')
    assert.equal(descPage1.traces[1]?.toolUseId, 'tool-4')
    assert.equal(descPage1.nextCursor, `${traces[3]?.startedAt}|tool-4`)

    const descPage2 = await storage.listToolTraces(pSessionId, { limit: 2, order: 'desc', cursor: descPage1.nextCursor })
    assert.equal(descPage2.traces.length, 2)
    assert.equal(descPage2.traces[0]?.toolUseId, 'tool-3')
    assert.equal(descPage2.traces[1]?.toolUseId, 'tool-2')
    assert.equal(descPage2.nextCursor, `${traces[1]?.startedAt}|tool-2`)

    const descPage3 = await storage.listToolTraces(pSessionId, { limit: 2, order: 'desc', cursor: descPage2.nextCursor })
    assert.equal(descPage3.traces.length, 1)
    assert.equal(descPage3.traces[0]?.toolUseId, 'tool-1')
    assert.equal(descPage3.nextCursor, undefined)

    // Test simultaneous startedAt values
    const simSessionId = 'session-sqlite-simultaneous'
    await storage.saveSession({
      sessionId: simSessionId,
      cwd: tempDir,
      prompt: 'test sqlite simultaneous',
      phase: 'created',
      createdAt: '2026-05-22T12:00:00.000Z',
      updatedAt: '2026-05-22T12:00:00.000Z',
      events: [],
    })

    const simTime = '2026-05-22T12:00:00.000Z'
    await storage.saveToolTrace({
      toolUseId: 'tool-sim-b',
      sessionId: simSessionId,
      name: 'tool-b',
      input: {},
      startedAt: simTime,
    })
    await storage.saveToolTrace({
      toolUseId: 'tool-sim-a',
      sessionId: simSessionId,
      name: 'tool-a',
      input: {},
      startedAt: simTime,
    })

    // tool-sim-a should be first because of alphabetical sorting of toolUseId
    const simAsc = await storage.listToolTraces(simSessionId, { limit: 1, order: 'asc' })
    assert.equal(simAsc.traces.length, 1)
    assert.equal(simAsc.traces[0]?.toolUseId, 'tool-sim-a')
    assert.equal(simAsc.nextCursor, `${simTime}|tool-sim-a`)

    const simAscPage2 = await storage.listToolTraces(simSessionId, { limit: 1, order: 'asc', cursor: simAsc.nextCursor })
    assert.equal(simAscPage2.traces.length, 1)
    assert.equal(simAscPage2.traces[0]?.toolUseId, 'tool-sim-b')
    assert.equal(simAscPage2.nextCursor, undefined)

  } finally {
    await storage.close()
  }
})

test('REST API endpoint GET /v1/sessions/:sessionId/tool-traces', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const sessionId = 'session-api-test'
  
  await storage.saveSession({
    sessionId,
    cwd: tmpdir(),
    prompt: 'test api traces',
    phase: 'created',
    createdAt: '2026-05-22T12:00:00.000Z',
    updatedAt: '2026-05-22T12:00:00.000Z',
    events: [],
  })

  // Pre-populate some tool traces in the storage
  for (let i = 1; i <= 3; i++) {
    await storage.saveToolTrace({
      toolUseId: `tool-${i}`,
      sessionId,
      name: `tool-name-${i}`,
      input: { i },
      startedAt: `2026-05-22T12:00:0${i}.000Z`,
      completedAt: `2026-05-22T12:00:0${i}.100Z`,
      durationMs: 100,
      success: true,
      output: `out-${i}`,
    })
  }

  const app = await createNexusApp({ runtime, storage, defaultCwd: tmpdir() })

  try {
    // 1. Request for non-existent session
    const notFoundRes = await app.inject({
      method: 'GET',
      url: '/v1/sessions/non-existent-session/tool-traces',
    })
    assert.equal(notFoundRes.statusCode, 404)
    const notFoundBody = notFoundRes.json()
    assert.equal(notFoundBody.type, 'error')
    assert.equal(notFoundBody.code, 'SESSION_NOT_FOUND')

    // 2. Request for correct session, default options
    const successRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/tool-traces`,
    })
    assert.equal(successRes.statusCode, 200)
    const body = successRes.json()
    assert.equal(body.type, 'tool_traces')
    assert.equal(body.sessionId, sessionId)
    assert.equal(body.traces.length, 3)
    assert.equal(body.traces[0].toolUseId, 'tool-1')
    assert.equal(body.traces[2].toolUseId, 'tool-3')

    // 3. Request with custom limit and order
    const limitRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/tool-traces?limit=2&order=desc`,
    })
    assert.equal(limitRes.statusCode, 200)
    const limitBody = limitRes.json()
    assert.equal(limitBody.traces.length, 2)
    assert.equal(limitBody.traces[0].toolUseId, 'tool-3')
    assert.equal(limitBody.traces[1].toolUseId, 'tool-2')
    assert.ok(limitBody.nextCursor)

    // 4. Request using the next cursor
    const cursorRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/tool-traces?limit=2&order=desc&cursor=${limitBody.nextCursor}`,
    })
    assert.equal(cursorRes.statusCode, 200)
    const cursorBody = cursorRes.json()
    assert.equal(cursorBody.traces.length, 1)
    assert.equal(cursorBody.traces[0].toolUseId, 'tool-1')
    assert.equal(cursorBody.nextCursor, undefined)
  } finally {
    await app.close()
  }
})
