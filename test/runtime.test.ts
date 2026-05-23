import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import { LocalCodingRuntime } from '../src/runtime/LocalCodingRuntime.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'

test('execute reads a workspace file and records session events', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'hello nexus\n', 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read sample.txt', cwd },
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.success, true)
    assert.ok(body.events.some((event: { type: string }) => event.type === 'tool_completed'))

    const session = await storage.getSession(body.sessionId)
    assert.ok(session)
    assert.ok(session.events.length >= 3)
  } finally {
    await app.close()
  }
})

test('plain prompts return local runtime guidance', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-plain`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'hello there', cwd },
    })
    const body = response.json()
    assert.equal(body.success, true)
    assert.match(body.result.message, /local runtime is active/)
  } finally {
    await app.close()
  }
})

test('sqlite storage persists sessions and events across storage instances', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-sqlite`)
  await mkdir(cwd, { recursive: true })
  const dbPath = join(cwd, 'nexus.sqlite')
  const tools = createDefaultToolRegistry()

  const storageA = new SqliteStorage(dbPath)
  const appA = await createNexusApp({
    runtime: new LocalCodingRuntime(tools),
    storage: storageA,
    defaultCwd: cwd,
  })
  let sessionId = ''
  try {
    const response = await appA.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'task "persist this"', cwd },
    })
    const body = response.json()
    sessionId = body.sessionId
    assert.equal(body.success, true)

    const taskResponse = await appA.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/tasks`,
      payload: { title: 'stored task' },
    })
    assert.equal(taskResponse.statusCode, 200)
  } finally {
    await appA.close()
    await storageA.close()
  }

  const storageB = new SqliteStorage(dbPath)
  try {
    const restored = await storageB.getSession(sessionId)
    assert.ok(restored)
    assert.ok(restored.events.some(event => event.type === 'session_started'))
    const tasks = await storageB.listTasks(sessionId)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]?.title, 'stored task')
  } finally {
    await storageB.close()
  }
})

test('/v1/execute session reuse and history mapping', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-reuse`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  try {
    const sessionId = 'session-test-reuse'
    
    // First execute
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { sessionId, prompt: 'hello first time', cwd },
    })
    assert.equal(res1.statusCode, 200)
    const body1 = res1.json()
    assert.equal(body1.sessionId, sessionId)

    // Verify session phase is completed
    const sessionAfterFirst = await storage.getSession(sessionId, { includeEvents: true })
    assert.ok(sessionAfterFirst)
    assert.ok(sessionAfterFirst.events.some(e => e.type === 'user_message' && e.text === 'hello first time'))

    // Second execute with the same sessionId
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { sessionId, prompt: 'hello second time', cwd },
    })
    assert.equal(res2.statusCode, 200)
    const body2 = res2.json()
    assert.equal(body2.sessionId, sessionId)

    // Verify session events include both user_message events and that the session phase is updated
    const sessionAfterSecond = await storage.getSession(sessionId, { includeEvents: true })
    assert.ok(sessionAfterSecond)
    assert.equal(sessionAfterSecond.lastUserInput, 'hello second time')
    
    const userMessages = sessionAfterSecond.events.filter(e => e.type === 'user_message')
    assert.equal(userMessages.length, 2)
    assert.equal((userMessages[0] as any).text, 'hello first time')
    assert.equal((userMessages[1] as any).text, 'hello second time')
  } finally {
    await app.close()
  }
})

test('session input, cancel, and task lifecycle endpoints update state', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-lifecycle`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const executeResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'hello', cwd },
    })
    const { sessionId } = executeResponse.json()

    const inputResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/input`,
      payload: { message: 'continue please' },
    })
    assert.equal(inputResponse.statusCode, 200)
    assert.equal(inputResponse.json().phase, 'executing')

    const taskResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/tasks`,
      payload: { title: 'finish lifecycle test' },
    })
    const taskId = taskResponse.json().task.taskId

    const claimResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/tasks/${taskId}/claim`,
    })
    assert.equal(claimResponse.json().task.status, 'in_progress')

    const completeResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/tasks/${taskId}/complete`,
      payload: { result: 'done' },
    })
    assert.equal(completeResponse.json().task.status, 'completed')
    assert.equal(completeResponse.json().task.result, 'done')

    const cancelResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/cancel`,
    })
    assert.equal(cancelResponse.statusCode, 200)
    const session = await storage.getSession(sessionId)
    assert.equal(session?.phase, 'cancelled')
  } finally {
    await app.close()
  }
})

test('tool audit reports risk and allowlist status', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-audit`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({
    allowedTools: ['Read', 'Grep', 'Glob'],
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tools/audit',
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const read = body.tools.find((tool: { name: string }) => tool.name === 'Read')
    const bash = body.tools.find((tool: { name: string }) => tool.name === 'Bash')

    assert.equal(read.allowed, true)
    assert.equal(read.risk, 'read')
    assert.equal(bash.allowed, false)
    assert.equal(bash.risk, 'execute')
  } finally {
    await app.close()
  }
})

test('Grep and Glob fall back when ripgrep is unavailable', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-rg-fallback`)
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'fallback.txt'), 'needle appears here\n', 'utf8')

  const oldPath = process.env.PATH
  process.env.PATH = ''
  try {
    const { runtime, storage } = await createDefaultNexusRuntime({
      allowedTools: ['Grep', 'Glob'],
    })
    const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
    try {
      const grepResponse = await app.inject({
        method: 'POST',
        url: '/v1/execute',
        payload: { prompt: 'grep needle', cwd },
      })
      assert.equal(grepResponse.statusCode, 200)
      assert.match(
        JSON.stringify(
          grepResponse.json().events.find((event: { type: string }) => event.type === 'tool_completed'),
        ),
        /fallback\.txt/,
      )

      const globResponse = await app.inject({
        method: 'POST',
        url: '/v1/execute',
        payload: { prompt: 'glob fallback', cwd },
      })
      assert.equal(globResponse.statusCode, 200)
      assert.match(
        JSON.stringify(
          globResponse.json().events.find((event: { type: string }) => event.type === 'tool_completed'),
        ),
        /fallback\.txt/,
      )
    } finally {
      await app.close()
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
  }
})

test('allowlisted runtime executes allowed tools and denies blocked tools', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-allowlist`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'hello allowlist\n', 'utf8')
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const readResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read sample.txt', cwd },
    })
    assert.equal(readResponse.statusCode, 200)
    assert.equal(readResponse.json().success, true)

    const bashResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash pwd', cwd },
    })
    assert.equal(bashResponse.statusCode, 200)
    const body = bashResponse.json()
    assert.equal(body.success, false)
    assert.equal(body.result.success, false)
    assert.ok(body.events.some((event: { type: string }) => event.type === 'tool_denied'))
    assert.ok(
      body.events.some(
        (event: { type: string; name?: string }) =>
          event.type === 'tool_denied' && event.name === 'Bash',
      ),
    )
  } finally {
    await app.close()
  }
})

test('session list stays lightweight while session detail keeps events', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-session-list`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const executeResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'hello', cwd },
    })
    const { sessionId } = executeResponse.json()

    const listResponse = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
    })
    const listedSession = listResponse
      .json()
      .sessions.find((session: { sessionId: string }) => session.sessionId === sessionId)
    assert.ok(listedSession)
    assert.deepEqual(listedSession.events, [])

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
    })
    assert.ok(detailResponse.json().session.events.length > 0)
  } finally {
    await app.close()
  }
})

test('session detail uses recent events and events endpoint paginates history', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-events-page`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const executeResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read missing.txt', cwd },
    })
    const { sessionId } = executeResponse.json()

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}?recentEventLimit=2`,
    })
    const detail = detailResponse.json()
    assert.equal(detail.session.events.length, 2)
    assert.equal(detail.eventsTruncated, true)

    const firstPageResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/events?limit=2`,
    })
    const firstPage = firstPageResponse.json()
    assert.equal(firstPage.events.length, 2)
    assert.ok(firstPage.nextCursor)

    const secondPageResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/events?limit=2&cursor=${encodeURIComponent(
        firstPage.nextCursor,
      )}`,
    })
    const secondPage = secondPageResponse.json()
    assert.ok(secondPage.events.length > 0)
    assert.notDeepEqual(secondPage.events[0], firstPage.events[0])
  } finally {
    await app.close()
  }
})

test('execute timeout aborts long-running tools and records metrics', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-timeout`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    executeTimeoutMs: 50,
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "sleep 1"', cwd, skipPermissionCheck: true },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.success, false)
    assert.ok(
      body.events.some(
        (event: { type: string; code?: string }) =>
          event.type === 'error' && event.code === 'REQUEST_TIMEOUT',
      ),
    )

    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/v1/runtime/metrics',
    })
    const metrics = metricsResponse.json()
    assert.equal(metrics.execute.count, 1)
    assert.equal(metrics.execute.timeoutCount, 1)
    assert.ok(metrics.execute.avgMs >= 0)
  } finally {
    await app.close()
  }
})

test('execute concurrency gate rejects excess work quickly', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-busy`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    executeTimeoutMs: 1_000,
    maxConcurrentExecutions: 1,
  })
  try {
    const first = app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "sleep 0.2"', cwd, skipPermissionCheck: true },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'hello', cwd },
    })

    assert.equal(rejected.statusCode, 429)
    assert.equal(rejected.json().code, 'EXECUTION_BUSY')
    assert.equal((await first).statusCode, 200)

    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/v1/runtime/metrics',
    })
    assert.equal(metricsResponse.json().execute.rejectedCount, 1)
  } finally {
    await app.close()
  }
})

test('tool output is truncated before it is stored in events', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-truncate`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'big.txt'), 'x'.repeat(500), 'utf8')
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    maxToolOutputBytes: 64,
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read big.txt', cwd },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const completed = body.events.find(
      (event: { type: string }) => event.type === 'tool_completed',
    )
    assert.equal(completed.truncated, true)
    assert.equal(completed.originalBytes, 500)
    assert.equal(completed.output.length, 64)

    const session = await storage.getSession(body.sessionId)
    const storedCompleted = session?.events.find(event => event.type === 'tool_completed')
    assert.equal(
      storedCompleted?.type === 'tool_completed' && storedCompleted.truncated,
      true,
    )
  } finally {
    await app.close()
  }
})

test('bash max buffer is configurable and fails safely on excessive output', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-buffer`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    bashMaxBufferBytes: 32,
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "printf 1234567890123456789012345678901234567890"', cwd, skipPermissionCheck: true },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.success, false)
    assert.ok(
      body.events.some(
        (event: { type: string; code?: string }) =>
          event.type === 'error' && event.code === 'TOOL_ERROR',
      ),
    )
  } finally {
    await app.close()
  }
})

test('websocket stream executes prompts and records stream metrics', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-stream`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    await app.ready()
    const ws = await app.injectWS('/v1/stream')
    const events: Array<{ type: string; success?: boolean }> = []
    ws.on('message', (data: Buffer) => {
      events.push(JSON.parse(String(data)))
    })
    ws.send(JSON.stringify({ prompt: 'hello', cwd }))
    await waitFor(() => events.some(event => event.type === 'result'))
    ws.terminate()

    assert.ok(events.some(event => event.type === 'session_started'))
    assert.equal(events.find(event => event.type === 'result')?.success, true)

    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/v1/runtime/metrics',
    })
    const metrics = metricsResponse.json()
    assert.equal(metrics.stream.count, 1)
    assert.equal(metrics.stream.successCount, 1)
    assert.ok(metrics.stream.sentEventCount >= 3)
  } finally {
    await app.close()
  }
})

test('websocket stream timeout aborts long-running tools', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-stream-timeout`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    executeTimeoutMs: 50,
  })
  try {
    await app.ready()
    const ws = await app.injectWS('/v1/stream')
    const events: Array<{ type: string; code?: string }> = []
    ws.on('message', (data: Buffer) => {
      events.push(JSON.parse(String(data)))
    })
    ws.send(JSON.stringify({ prompt: 'bash "sleep 1"', cwd, skipPermissionCheck: true }))
    await waitFor(() =>
      events.some(event => event.type === 'error' && event.code === 'REQUEST_TIMEOUT'),
    )
    ws.terminate()

    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/v1/runtime/metrics',
    })
    const metrics = metricsResponse.json()
    assert.equal(metrics.stream.count, 1)
    assert.equal(metrics.stream.timeoutCount, 1)
  } finally {
    await app.close()
  }
})

test('websocket stream concurrency gate rejects excess work', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-stream-busy`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    maxConcurrentExecutions: 1,
    executeTimeoutMs: 1_000,
  })
  try {
    await app.ready()
    const first = await app.injectWS('/v1/stream')
    first.send(JSON.stringify({ prompt: 'bash "sleep 0.2"', cwd, skipPermissionCheck: true }))
    await new Promise(resolve => setTimeout(resolve, 20))

    const second = await app.injectWS('/v1/stream')
    const events: Array<{ type: string; code?: string }> = []
    second.on('message', (data: Buffer) => {
      events.push(JSON.parse(String(data)))
    })
    second.send(JSON.stringify({ prompt: 'hello', cwd }))
    await waitFor(() =>
      events.some(event => event.type === 'error' && event.code === 'EXECUTION_BUSY'),
    )

    first.terminate()
    second.terminate()
    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/v1/runtime/metrics',
    })
    assert.equal(metricsResponse.json().stream.rejectedCount, 1)
  } finally {
    await app.close()
  }
})

test('bash tool session CWD retention', async () => {
  const baseCwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-cwd`)
  await mkdir(baseCwd, { recursive: true })
  const subDir = join(baseCwd, 'sub')
  await mkdir(subDir, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: baseCwd })
  try {
    const sessionId = `test-session-${Date.now()}`

    // 1. Run "cd sub && pwd" to navigate to the subdirectory
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "cd sub && pwd"', cwd: baseCwd, sessionId, skipPermissionCheck: true },
    })
    assert.equal(res1.statusCode, 200)
    const body1 = res1.json()
    assert.equal(body1.success, true)
    const event1 = body1.events.find((e: any) => e.type === 'tool_completed' && e.name === 'Bash')
    assert.ok(event1)
    assert.match(event1.output.stdout, /sub/)

    // 2. Run a simple "pwd" and verify CWD is retained as the subdirectory
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "pwd"', cwd: baseCwd, sessionId, skipPermissionCheck: true },
    })
    assert.equal(res2.statusCode, 200)
    const body2 = res2.json()
    assert.equal(body2.success, true)
    const event2 = body2.events.find((e: any) => e.type === 'tool_completed' && e.name === 'Bash')
    assert.ok(event2)
    assert.match(event2.output.stdout, /sub/)

    // 3. Execute a failing command, and make sure that subsequent CWD is still preserved as subDir
    const res3 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "cd nonexistent && pwd"', cwd: baseCwd, sessionId, skipPermissionCheck: true },
    })
    assert.equal(res3.statusCode, 200)
    const body3 = res3.json()
    assert.equal(body3.success, false) // Should fail as cd nonexistent fails

    // Verify it is still subDir after the failure
    const res4 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "pwd"', cwd: baseCwd, sessionId, skipPermissionCheck: true },
    })
    assert.equal(res4.statusCode, 200)
    const body4 = res4.json()
    assert.equal(body4.success, true)
    const event4 = body4.events.find((e: any) => e.type === 'tool_completed' && e.name === 'Bash')
    assert.ok(event4)
    assert.match(event4.output.stdout, /sub/)

    // 4. Verify different session IDs have isolated CWDs
    const otherSessionId = `other-session-${Date.now()}`
    const res5 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "pwd"', cwd: baseCwd, sessionId: otherSessionId, skipPermissionCheck: true },
    })
    assert.equal(res5.statusCode, 200)
    const body5 = res5.json()
    const event5 = body5.events.find((e: any) => e.type === 'tool_completed' && e.name === 'Bash')
    assert.ok(event5)
    // The other session should run in baseCwd, which does not contain 'sub'
    assert.ok(!event5.output.stdout.includes('sub'))
  } finally {
    await app.close()
  }
})

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
