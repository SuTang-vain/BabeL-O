import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir, homedir } from 'node:os'
import { createId } from '../src/shared/id.js'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import { LocalCodingRuntime, allowAllTools } from '../src/runtime/LocalCodingRuntime.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { createNexusTask, taskQueueStatsForTest } from '../src/nexus/taskQueue.js'
import { createTaskSession, taskSessionStatsForTest } from '../src/nexus/taskSession.js'
import { PendingPermissionRegistry } from '../src/shared/session.js'
import { globTool } from '../src/tools/builtin/glob.js'
import { LLMCodingRuntime } from '../src/runtime/LLMCodingRuntime.js'
import { ConfigManager } from '../src/shared/config.js'
import { eventBase, NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'

function createRuntimeTestStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

ConfigManager.getInstance().save({})

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

test('local runtime emits hook events around failed tool execution', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-hooks`)
  await mkdir(cwd, { recursive: true })
  const tools = createDefaultToolRegistry()
  const runtime = new LocalCodingRuntime(tools)

  const events: Array<{ type: string; [key: string]: unknown }> = []
  for await (const event of runtime.executeStream({
    sessionId: 'session-hooks',
    prompt: 'bash cd /definitely/missing && pwd',
    cwd,
    skipPermissionCheck: true,
  })) {
    events.push(event as any)
  }

  assert.ok(events.some(event => event.type === 'tool_completed'))
  assert.ok(events.some(event => event.type === 'hook_started'))
  assert.ok(events.some(event => event.type === 'hook_completed'))
  assert.ok(events.some(event => event.type === 'result'))
})

test('local runtime answers natural-language questions about file contents', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-file-question`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'question.txt'), 'answer-token: violet-river\n', 'utf8')

  const tools = createDefaultToolRegistry()
  const runtime = new LocalCodingRuntime(tools)
  const events: Array<{ type: string; [key: string]: unknown }> = []
  for await (const event of runtime.executeStream({
    sessionId: 'session-file-question',
    prompt: 'What does question.txt say?',
    cwd,
  })) {
    events.push(event as any)
  }

  assert.ok(events.some(event => event.type === 'tool_completed' && event.name === 'Read'))
  assert.ok(events.some(event => event.type === 'assistant_delta' && String(event.text).includes('violet-river')))
  assert.ok(events.some(event => event.type === 'result' && String(event.message).includes('violet-river')))
})

test('Read returns a recoverable tool result for directories', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-read-dir`)
  await mkdir(join(cwd, 'src'), { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read src', cwd },
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    const toolCompleted = body.events.find((event: { type: string; name?: string }) =>
      event.type === 'tool_completed' && event.name === 'Read',
    )
    assert.equal(toolCompleted.success, false)
    assert.match(String(toolCompleted.output), /is a directory/)
    assert.equal(body.result.success, false)
  } finally {
    await app.close()
  }
})

test('Read returns a recoverable tool result for missing files', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-read-missing`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read missing.txt', cwd },
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    const toolCompleted = body.events.find((event: { type: string; name?: string }) =>
      event.type === 'tool_completed' && event.name === 'Read',
    )
    assert.equal(toolCompleted.success, false)
    assert.match(String(toolCompleted.output), /could not find/)
    assert.ok(!body.events.some((event: { type: string; code?: string }) =>
      event.type === 'error' && event.code === 'TOOL_ERROR',
    ))
  } finally {
    await app.close()
  }
})

test('Read returns a recoverable tool result for workspace escape paths', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-read-escape`)
  await mkdir(cwd, { recursive: true })
  const outsidePath = join(tmpdir(), `babel-o-outside-${Date.now()}.txt`)

  process.env.NEXUS_ALLOWED_WORKSPACES = cwd
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: `read ${outsidePath}`, cwd },
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    const toolCompleted = body.events.find((event: { type: string; name?: string }) =>
      event.type === 'tool_completed' && event.name === 'Read',
    )
    assert.equal(toolCompleted.success, false)
    assert.equal(toolCompleted.output.code, 'WORKSPACE_PATH_ESCAPE')
    assert.match(toolCompleted.output.message, /outside the current workspace/)
    assert.ok(!body.events.some((event: { type: string; code?: string }) =>
      event.type === 'error' && event.code === 'TOOL_ERROR',
    ))
  } finally {
    delete process.env.NEXUS_ALLOWED_WORKSPACES
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
    const restoredBeforeMetadata = await storageB.getSession(sessionId)
    assert.ok(restoredBeforeMetadata)
    restoredBeforeMetadata.metadata = { agentType: 'subagent', transcriptPath: `nexus://sessions/${sessionId}/events` }
    await storageB.saveSession(restoredBeforeMetadata)

    const restored = await storageB.getSession(sessionId)
    assert.ok(restored)
    assert.equal(restored.metadata?.agentType, 'subagent')
    assert.equal(restored.metadata?.transcriptPath, `nexus://sessions/${sessionId}/events`)
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

test('/v1/execute persists resolved cwd and reuses it for correction turns', async () => {
  const defaultCwd = join(tmpdir(), `babel-o-test-${Date.now()}-cwd-default`)
  const targetCwd = join(tmpdir(), `babel-o-test-${Date.now()}-cwd-target`)
  await mkdir(defaultCwd, { recursive: true })
  await mkdir(targetCwd, { recursive: true })
  await writeFile(join(targetCwd, 'marker.txt'), 'target marker\n', 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Bash'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd })
  try {
    const sessionId = `session-cwd-follow-${Date.now()}`
    const first = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        sessionId,
        prompt: `${targetCwd}查看这个项目`,
        cwd: defaultCwd,
      },
    })
    assert.equal(first.statusCode, 200)
    const sessionAfterFirst = await storage.getSession(sessionId, { includeEvents: false })
    assert.equal(sessionAfterFirst?.cwd, targetCwd)

    const second = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        sessionId,
        prompt: '呃让你分析的就是这个项目',
        cwd: defaultCwd,
      },
    })
    assert.equal(second.statusCode, 200)
    const body = second.json()
    const secondSessionStarted = body.events.find((event: any) =>
      event.type === 'session_started' && event.requestId === body.events.find((e: any) => e.type === 'session_started')?.requestId,
    )
    assert.equal(secondSessionStarted?.cwd, targetCwd)

    const sessionAfterSecond = await storage.getSession(sessionId, { includeEvents: false })
    assert.equal(sessionAfterSecond?.cwd, targetCwd)
    assert.equal(sessionAfterSecond?.lastUserInput, '呃让你分析的就是这个项目')
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

test('remote cancel aborts active execution and resume returns session snapshot', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-remote-cancel`)
  await mkdir(cwd, { recursive: true })
  const storage = new SqliteStorage(join(cwd, 'nexus.sqlite'))
  const sessionId = `session-remote-cancel-${Date.now()}`
  const childSessionId = `${sessionId}-sub-1`
  let runtimeStarted!: () => void
  const runtimeStartedPromise = new Promise<void>(resolve => {
    runtimeStarted = resolve
  })
  const runtime = {
    async *executeStream(options: any): AsyncIterable<NexusEvent> {
      yield {
        type: 'session_started',
        ...eventBase(options.sessionId),
        cwd: options.cwd,
        requestId: options.requestId,
      }
      runtimeStarted()
      await new Promise<void>(resolve => {
        options.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: 'REQUEST_CANCELLED',
        message: 'Execution cancelled by user.',
      }
      yield {
        type: 'result',
        ...eventBase(options.sessionId),
        success: false,
        message: 'Execution cancelled by user.',
      }
    },
  }
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    await storage.saveSession({
      sessionId: childSessionId,
      cwd,
      prompt: 'child',
      phase: 'executing',
      parentSessionId: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      metadata: {
        agentType: 'subagent',
        status: 'running',
        transcriptPath: `nexus://sessions/${childSessionId}/events`,
      },
    })

    const executePromise = app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { sessionId, prompt: 'long running work', cwd },
    })
    await runtimeStartedPromise

    const taskResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/tasks`,
      payload: { title: 'remote task' },
    })
    assert.equal(taskResponse.statusCode, 200)

    const activeResumeResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/resume`,
      payload: { recentEventLimit: 10 },
    })
    assert.equal(activeResumeResponse.statusCode, 200)
    assert.equal(activeResumeResponse.json().activeExecution.transport, 'http')
    assert.equal(activeResumeResponse.json().childSessions[0].sessionId, childSessionId)
    assert.equal(activeResumeResponse.json().tasks[0].title, 'remote task')

    const cancelResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/cancel`,
      payload: { reason: 'remote dashboard cancel' },
    })
    assert.equal(cancelResponse.statusCode, 200)
    assert.equal(cancelResponse.json().activeExecutionCancelled, true)
    assert.deepEqual(cancelResponse.json().childSessionsCancelled, [childSessionId])

    const executeResponse = await executePromise
    assert.equal(executeResponse.statusCode, 200)
    assert.equal(executeResponse.json().success, false)

    const session = await storage.getSession(sessionId, { includeEvents: true })
    assert.equal(session?.phase, 'cancelled')
    assert.ok(session?.events.some(event => event.type === 'error' && event.code === 'REQUEST_CANCELLED'))

    const resumedResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/resume`,
      payload: { recentEventLimit: 10 },
    })
    const resumed = resumedResponse.json()
    assert.equal(resumed.activeExecution, null)
    assert.equal(resumed.session.phase, 'cancelled')
    assert.ok(resumed.session.events.some((event: NexusEvent) => event.type === 'error' && event.code === 'REQUEST_CANCELLED'))
  } finally {
    await app.close()
    await storage.close()
  }
})

test('session close cascades runtime session state cleanup', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-session-close`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({
    allowedTools: ['Bash'],
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  const sessionId = `session-close-${Date.now()}`
  const registry = PendingPermissionRegistry.getInstance()
  registry.resetForTest()

  try {
    await storage.saveSession({
      sessionId,
      cwd,
      prompt: 'close me',
      phase: 'executing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
    })

    createTaskSession({ sessionId, cwd, prompt: 'close me' })
    createNexusTask({ queueId: sessionId, title: 'cleanup task' })
    const pendingPermission = registry.register(sessionId, 'tool-close-test')

    const { bashTool, getBashSessionStateSizeForTest, clearBashSessionState } = await import('../src/tools/builtin/bash.js')
    await clearBashSessionState()
    await bashTool.execute({ command: 'cd /', timeoutMs: 10_000 }, {
      cwd,
      sessionId,
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 10_000,
    })
    assert.equal(getBashSessionStateSizeForTest(), 1)
    assert.equal(taskQueueStatsForTest().tasks, 1)
    assert.equal(taskSessionStatsForTest().sessions, 1)
    assert.equal(registry.pendingCount(), 1)

    const closeResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/close`,
      payload: { reason: 'test close' },
    })
    assert.equal(closeResponse.statusCode, 200)
    assert.equal(closeResponse.json().type, 'session_closed')

    const permissionResult = await pendingPermission
    assert.equal(permissionResult.approved, false)
    assert.equal(permissionResult.reason, 'test close')
    assert.equal(getBashSessionStateSizeForTest(), 0)
    assert.equal(taskQueueStatsForTest().tasks, 0)
    assert.equal(taskSessionStatsForTest().sessions, 0)
    assert.equal(registry.pendingCount(), 0)
  } finally {
    registry.resetForTest()
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

test('/v1/runtime/status returns redacted provider diagnostics', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-provider-status`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/runtime/status',
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'runtime_status')
    assert.equal(body.provider.modelId, 'local/coding-runtime')
    assert.equal(body.provider.providerId, 'local')
    assert.equal(body.provider.authConfigured, true)
    assert.equal(body.provider.authMode, 'none')
    assert.equal(body.provider.capabilities.toolCalling, true)
    assert.equal(body.provider.capabilities.streaming, true)
    assert.equal(body.provider.apiKey, undefined)
    const plannerResponse = await app.inject({
      method: 'GET',
      url: '/v1/runtime/provider-smoke?role=planner',
    })
    assert.equal(plannerResponse.statusCode, 200)
    const plannerBody = plannerResponse.json()
    assert.equal(plannerBody.provider.roleRecommendation.role, 'planner')
    assert.equal(plannerBody.provider.roleRecommendation.configured, false)
    assert.equal(plannerBody.provider.roleRecommendation.willAutoSwitch, false)

    assert.equal(body.providerSmoke.type, 'provider_smoke')
    assert.equal(body.providerSmoke.mode, 'dry_run')
    assert.equal(body.providerSmoke.ready, true)
    assert.equal(body.providerSmoke.provider.apiKey, undefined)
    assert.equal(body.providerSmoke.checks.authConfigured, true)
    assert.equal(body.providerSmoke.fallbackPolicy.allowSilentModelSwitch, false)
  } finally {
    await app.close()
  }
})

test('/v1/runtime/provider-smoke returns local dry-run readiness without executing sessions', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-provider-smoke-local`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/runtime/provider-smoke',
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'provider_smoke')
    assert.equal(body.mode, 'dry_run')
    assert.equal(body.ready, true)
    assert.equal(body.provider.providerId, 'local')
    assert.equal(body.provider.modelId, 'local/coding-runtime')
    assert.equal(body.provider.apiKey, undefined)
    assert.equal(body.checks.authConfigured, true)
    assert.equal(body.checks.toolsSupported, true)
    assert.equal(body.fallbackPolicy.allowSilentModelSwitch, false)
    assert.deepEqual(await storage.listSessions({ limit: 10 }), [])
  } finally {
    await app.close()
  }
})

test('/v1/runtime/provider-smoke reports unmet capability without silent fallback', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-provider-smoke-capability`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/runtime/provider-smoke?model=local%2Fcoding-runtime&requireStructuredOutput=true',
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'provider_smoke')
    assert.equal(body.mode, 'dry_run')
    assert.equal(body.ready, false)
    assert.equal(body.provider.providerId, 'local')
    assert.equal(body.provider.modelId, 'local/coding-runtime')
    assert.equal(body.provider.apiKey, undefined)
    assert.equal(body.checks.authConfigured, true)
    assert.equal(body.checks.structuredOutputSupported, false)
    assert.equal(body.fallbackPolicy.mode, 'fix_configuration')
    assert.equal(body.fallbackPolicy.allowSilentModelSwitch, false)
    assert.deepEqual(await storage.listSessions({ limit: 10 }), [])
  } finally {
    await app.close()
  }
})

test('/v1/runtime/provider-fallback/plan returns non-executing fallback action', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-provider-fallback-plan`)
  await mkdir(cwd, { recursive: true })

  const oldFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = async () => {
    fetchCalled = true
    throw new Error('provider should not be called')
  }

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/provider-fallback/plan',
      payload: { kind: 'context_window' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'provider_fallback_plan')
    assert.equal(body.provider.providerId, 'local')
    assert.equal(body.provider.apiKey, undefined)
    assert.equal(body.fallbackPolicy.mode, 'compact_then_retry')
    assert.equal(body.fallbackPolicy.allowSilentModelSwitch, false)
    assert.equal(body.action.requiresUserConfirmation, true)
    assert.equal(body.action.willSwitchModel, false)
    assert.equal(body.action.willSwitchProvider, false)
    assert.equal(body.action.willMutateConfig, false)
    assert.equal(body.action.willCallProvider, false)
    assert.equal(body.action.willCreateSession, false)
    assert.equal(fetchCalled, false)
    assert.deepEqual(await storage.listSessions({ limit: 10 }), [])
  } finally {
    await app.close()
    globalThis.fetch = oldFetch
  }
})

test('/v1/runtime/provider-smoke/live runs fixed live smoke without creating sessions', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-provider-smoke-live`)
  const configPath = join(cwd, 'config.json')
  await mkdir(cwd, { recursive: true })

  const oldConfigFile = process.env.BABEL_O_CONFIG_FILE
  const oldAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  const oldAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL
  const oldFetch = globalThis.fetch
  process.env.BABEL_O_CONFIG_FILE = configPath
  process.env.ANTHROPIC_API_KEY = 'anthropic-live-smoke-test-key'
  process.env.ANTHROPIC_BASE_URL = 'https://api.test-anthropic.com'

  const fetchCalls: RequestInit[] = []
  globalThis.fetch = async (_url, init) => {
    fetchCalls.push(init ?? {})
    return {
      ok: true,
      status: 200,
      body: createRuntimeTestStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"BABEL_O_PROVIDER_SMOKE_OK"}}\n\n',
        'event: message_delta\n',
        'data: {"delta":{"stop_reason":"end_turn"}}\n\n',
      ]),
      text: async () => 'mock live smoke response',
    } as Response
  }

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/provider-smoke/live',
      payload: { model: 'anthropic/claude-3-5-sonnet' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'provider_smoke')
    assert.equal(body.mode, 'live')
    assert.equal(body.smokeMode, 'simple_text')
    assert.equal(body.ready, true)
    assert.equal(body.live, true)
    assert.equal(body.success, true)
    assert.equal(body.matchedExpectedText, true)
    assert.equal(body.outputPreview, 'BABEL_O_PROVIDER_SMOKE_OK')
    assert.equal(body.provider.apiKey, undefined)
    assert.equal(body.fallbackPolicy.allowSilentModelSwitch, false)
    assert.deepEqual(await storage.listSessions({ limit: 10 }), [])

    assert.equal(fetchCalls.length, 1)
    const requestBody = JSON.parse(String(fetchCalls[0].body))
    assert.match(JSON.stringify(requestBody), /BABEL_O_PROVIDER_SMOKE_OK/)
    assert.doesNotMatch(JSON.stringify(requestBody), /分析|project|Baidu/)
  } finally {
    await app.close()
    globalThis.fetch = oldFetch
    if (oldAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = oldAnthropicApiKey
    if (oldAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = oldAnthropicBaseUrl
    if (oldConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
    else process.env.BABEL_O_CONFIG_FILE = oldConfigFile
  }
})

test('/v1/runtime/provider-smoke/live tool-call mode probes provider protocol without sessions', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-provider-smoke-live-tool`)
  const configPath = join(cwd, 'config.json')
  await mkdir(cwd, { recursive: true })

  const oldConfigFile = process.env.BABEL_O_CONFIG_FILE
  const oldAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  const oldAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL
  const oldFetch = globalThis.fetch
  process.env.BABEL_O_CONFIG_FILE = configPath
  process.env.ANTHROPIC_API_KEY = 'anthropic-live-tool-smoke-test-key'
  process.env.ANTHROPIC_BASE_URL = 'https://api.test-anthropic.com'

  const fetchCalls: RequestInit[] = []
  globalThis.fetch = async (_url, init) => {
    fetchCalls.push(init ?? {})
    return {
      ok: true,
      status: 200,
      body: createRuntimeTestStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool_smoke","name":"provider_smoke_probe","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"probe\\":\\"BABEL_O_PROVIDER_SMOKE_OK\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
        'event: message_delta\n',
        'data: {"delta":{"stop_reason":"tool_use"}}\n\n',
      ]),
      text: async () => 'mock live tool smoke response',
    } as Response
  }

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/provider-smoke/live',
      payload: { model: 'anthropic/claude-3-5-sonnet', mode: 'tool_call' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'provider_smoke')
    assert.equal(body.mode, 'live')
    assert.equal(body.smokeMode, 'tool_call')
    assert.equal(body.ready, true)
    assert.equal(body.live, true)
    assert.equal(body.success, true)
    assert.equal(body.requirements.tools, true)
    assert.equal(body.matchedExpectedTool, true)
    assert.equal(body.toolCallCount, 1)
    assert.deepEqual(body.toolCalls, [
      { name: 'provider_smoke_probe', input: { probe: 'BABEL_O_PROVIDER_SMOKE_OK' } },
    ])
    assert.equal(body.provider.apiKey, undefined)
    assert.equal(body.fallbackPolicy.allowSilentModelSwitch, false)
    assert.deepEqual(await storage.listSessions({ limit: 10 }), [])

    assert.equal(fetchCalls.length, 1)
    const requestBody = JSON.parse(String(fetchCalls[0].body))
    assert.equal(requestBody.tools[0].name, 'provider_smoke_probe')
    assert.equal(requestBody.tools[0].input_schema.properties.probe.enum[0], 'BABEL_O_PROVIDER_SMOKE_OK')
    assert.match(JSON.stringify(requestBody), /provider_smoke_probe/)
    assert.match(JSON.stringify(requestBody), /BABEL_O_PROVIDER_SMOKE_OK/)
    assert.doesNotMatch(JSON.stringify(requestBody), /分析|project|Baidu/)
  } finally {
    await app.close()
    globalThis.fetch = oldFetch
    if (oldAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = oldAnthropicApiKey
    if (oldAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = oldAnthropicBaseUrl
    if (oldConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
    else process.env.BABEL_O_CONFIG_FILE = oldConfigFile
  }
})

test('/v1/sessions/:sessionId/assets returns SDK dashboard data assets', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-session-assets-api`)
  await mkdir(cwd, { recursive: true })
  const storage = new SqliteStorage(join(tmpdir(), `babel-o-assets-${Date.now()}.sqlite`))
  const runtime = new LocalCodingRuntime(createDefaultToolRegistry(), allowAllTools(), storage)
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  const sessionId = `session-assets-${Date.now()}`
  const childSessionId = `${sessionId}-child`
  const now = Date.now()
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()

  try {
    await storage.saveSession({
      sessionId,
      cwd,
      prompt: 'dashboard assets',
      phase: 'completed',
      createdAt: iso(0),
      updatedAt: iso(10),
      events: [],
      result: 'done',
    })
    await storage.saveSession({
      sessionId: childSessionId,
      cwd,
      prompt: 'child assets',
      phase: 'completed',
      parentSessionId: sessionId,
      createdAt: iso(1),
      updatedAt: iso(9),
      events: [
        {
          type: 'assistant_delta',
          schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
          sessionId: childSessionId,
          timestamp: iso(2),
          text: 'child transcript stays out of parent asset snapshot',
        },
      ],
      metadata: {
        agentId: 'agent-child',
        status: 'completed',
        transcriptPath: `nexus://sessions/${childSessionId}/events`,
      },
    })
    await storage.saveTask({
      taskId: 'task-assets-1',
      sessionId,
      title: 'Review dashboard query API',
      description: 'Expose stable data assets',
      status: 'failed',
      source: 'critic',
      dependsOn: [],
      blocks: [],
      retryCount: 1,
      review: {
        status: 'rejected',
        reason: 'Critic wants clearer usage totals',
        reviewerAgentId: 'critic',
      },
      createdAt: iso(3),
      updatedAt: iso(8),
      result: 'needs changes',
    })
    await storage.appendEvent(sessionId, {
      type: 'usage',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: iso(4),
      inputTokens: 12,
      outputTokens: 8,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
    })
    await storage.appendEvent(sessionId, {
      type: 'task_session_event',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      eventId: 'event-critic-assets-1',
      eventType: 'critic_completed',
      phase: 'reviewing',
      timestamp: iso(5),
      payload: {
        taskId: 'task-assets-1',
        title: 'Review dashboard query API',
        approved: false,
        reason: 'Usage summary missing',
      },
    })
    await storage.appendEvent(sessionId, {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: iso(6),
      toolUseId: 'tool-assets-1',
      name: 'Read',
      input: { path: 'README.md' },
    })
    await storage.appendEvent(sessionId, {
      type: 'tool_completed',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: iso(7),
      toolUseId: 'tool-assets-1',
      name: 'Read',
      success: true,
      output: 'ok',
    })
    await storage.savePermissionAudit({
      auditId: 'audit-assets-1',
      sessionId,
      toolUseId: 'tool-assets-1',
      toolName: 'Read',
      toolRisk: 'read',
      toolInput: { path: 'README.md' },
      decision: 'approved',
      timestamp: iso(7),
    })
    await storage.saveExecutionMetrics({
      metricId: 'metric-assets-1',
      sessionId,
      executeDurationMs: 123,
      toolCallCount: 1,
      contextCharsIn: 456,
      contextCharsOut: 78,
      timestamp: iso(9),
    })

    const response = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/assets?eventLimit=2&toolTraceLimit=1`,
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'session_assets')
    assert.equal(body.schemaVersion, '2026-05-31.babel-o.session-assets.v1')
    assert.equal(body.sessionId, sessionId)
    assert.equal(body.session.events.length, 0)
    assert.equal(body.tasks[0].taskId, 'task-assets-1')
    assert.equal(body.childSessions[0].sessionId, childSessionId)
    assert.equal(body.childSessions[0].events.length, 0)
    assert.equal(body.childSessions[0].metadata.transcriptPath, `nexus://sessions/${childSessionId}/events`)
    assert.equal(body.events.items.length, 2)
    assert.equal(body.events.truncated, true)
    assert.equal(body.toolTraces.items.length, 1)
    assert.equal(body.toolTraces.items[0].toolUseId, 'tool-assets-1')
    assert.equal(body.toolTraces.items[0].success, true)
    assert.equal(body.usageSummary.eventCount, 1)
    assert.equal(body.usageSummary.inputTokens, 12)
    assert.equal(body.usageSummary.outputTokens, 8)
    assert.equal(body.usageSummary.cacheCreationInputTokens, 2)
    assert.equal(body.usageSummary.cacheReadInputTokens, 3)
    assert.ok(body.criticReviews.some((review: any) =>
      review.source === 'task_review' &&
      review.taskId === 'task-assets-1' &&
      review.reason === 'Critic wants clearer usage totals',
    ))
    assert.ok(body.criticReviews.some((review: any) =>
      review.source === 'critic_event' &&
      review.taskId === 'task-assets-1' &&
      review.reason === 'Usage summary missing',
    ))
    assert.equal(body.permissionAudits[0].auditId, 'audit-assets-1')
    assert.equal(body.executionMetrics.metricId, 'metric-assets-1')
    assert.equal(body.executionMetrics.toolCallCount, 1)

    const missingResponse = await app.inject({
      method: 'GET',
      url: '/v1/sessions/missing-session/assets',
    })
    assert.equal(missingResponse.statusCode, 404)
    assert.equal(missingResponse.json().code, 'SESSION_NOT_FOUND')

    const leanResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/assets?includeEvents=false&includeToolTraces=false&includePermissionAudits=false&includeExecutionMetrics=false`,
    })
    assert.equal(leanResponse.statusCode, 200)
    const lean = leanResponse.json()
    assert.equal(lean.events, undefined)
    assert.equal(lean.toolTraces, undefined)
    assert.equal(lean.permissionAudits, undefined)
    assert.equal(lean.executionMetrics, undefined)
    assert.equal(lean.usageSummary.inputTokens, 12)
  } finally {
    await app.close()
    await storage.close()
  }
})

test('/v1/sessions/:sessionId/context returns reusable context analysis', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-context-api`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'hello context\n', 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const executeResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read sample.txt', cwd },
    })
    assert.equal(executeResponse.statusCode, 200)
    const sessionId = executeResponse.json().sessionId

    const contextResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/context?modelId=local/coding-runtime`,
    })
    assert.equal(contextResponse.statusCode, 200)
    const body = contextResponse.json()
    assert.equal(body.type, 'context_analysis')
    assert.equal(body.sessionId, sessionId)
    assert.ok(body.estimate.totalTokens > 0)
    assert.ok(body.window.maxTokens > 0)
    assert.equal(body.sections.toolDefinitionCount, 1)
    assert.equal(typeof body.runtimePolicy.toolsVisible, 'boolean')
    assert.equal(typeof body.runtimePolicy.recoveryBoundaryActive, 'boolean')
    assert.equal(typeof body.userIntentGuidance.intent, 'string')
    assert.ok(Array.isArray(body.recommendations))
  } finally {
    await app.close()
  }
})

test('/v1/sessions/:sessionId/compact creates a manual compact boundary', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-compact-api`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'hello compact\n', 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const executeResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read sample.txt', cwd },
    })
    assert.equal(executeResponse.statusCode, 200)
    const sessionId = executeResponse.json().sessionId

    const compactResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/compact`,
      payload: {
        modelId: 'local/coding-runtime',
        trigger: 'manual',
      },
    })
    assert.equal(compactResponse.statusCode, 200)
    const body = compactResponse.json()
    assert.equal(body.type, 'compact_result')
    assert.equal(body.sessionId, sessionId)
    assert.equal(body.event.type, 'compact_boundary')
    assert.equal(body.event.trigger, 'manual')
    assert.ok(body.event.summary.length > 0)
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

test('bash non-zero exit returns a recoverable failed tool result', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-nonzero`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        prompt: 'bash "printf visible-out && printf visible-err >&2 && exit 7"',
        cwd,
        skipPermissionCheck: true,
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const toolCompleted = body.events.find((event: { type: string; name?: string }) =>
      event.type === 'tool_completed' && event.name === 'Bash',
    )
    assert.ok(toolCompleted)
    assert.equal(toolCompleted.success, false)
    assert.match(toolCompleted.output.stdout, /visible-out/)
    assert.match(toolCompleted.output.stderr, /visible-err/)
    assert.equal(toolCompleted.output.exitCode, 7)
    assert.ok(!body.events.some((event: { type: string; code?: string }) =>
      event.type === 'error' && event.code === 'TOOL_ERROR',
    ))
  } finally {
    await app.close()
  }
})

test('bash absolute paths outside workspace return recoverable workspace escape result', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-workspace-escape`)
  const outside = join(tmpdir(), `babel-o-outside-${Date.now()}.txt`)
  await mkdir(cwd, { recursive: true })
  await writeFile(outside, 'outside workspace')

  process.env.NEXUS_ALLOWED_WORKSPACES = cwd
  try {
    const { bashTool } = await import('../src/tools/builtin/bash.js')
    const result = await bashTool.execute({
      command: `ls -la ${outside}`,
      timeoutMs: 10_000,
    }, {
      cwd,
      sessionId: `bash-escape-${Date.now()}`,
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 10_000,
    })

    assert.equal(result.success, false)
    assert.equal((result.output as any).code, 'WORKSPACE_PATH_ESCAPE')
    assert.match((result.output as any).message, /outside the current workspace/)
    assert.equal((result.output as any).requestedPath, outside)
  } finally {
    delete process.env.NEXUS_ALLOWED_WORKSPACES
  }
})

test('websocket stream executes prompts and records stream metrics', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-stream`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    await app.ready()
    const ws: any = await app.injectWS('/v1/stream')
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
    const ws: any = await app.injectWS('/v1/stream')
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
    const first: any = await app.injectWS('/v1/stream')
    first.send(JSON.stringify({ prompt: 'bash "sleep 0.2"', cwd, skipPermissionCheck: true }))
    await new Promise(resolve => setTimeout(resolve, 20))

    const second: any = await app.injectWS('/v1/stream')
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

test('bash retained CWD resets when the same session switches workspace', async () => {
  const firstCwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-first`)
  const secondCwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-second`)
  await mkdir(join(firstCwd, 'nested'), { recursive: true })
  await mkdir(secondCwd, { recursive: true })

  const { bashTool, clearBashSessionState } = await import('../src/tools/builtin/bash.js')
  const sessionId = `workspace-switch-${Date.now()}`

  try {
    const first = await bashTool.execute({
      command: 'cd nested && pwd',
      timeoutMs: 10_000,
    }, {
      cwd: firstCwd,
      sessionId,
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 10_000,
    })
    assert.equal(first.success, true)
    assert.match(String((first.output as any).stdout), /nested/)

    const second = await bashTool.execute({
      command: 'pwd',
      timeoutMs: 10_000,
    }, {
      cwd: secondCwd,
      sessionId,
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 10_000,
    })
    assert.equal(second.success, true)
    assert.equal(String((second.output as any).stdout).trim(), await realpath(secondCwd))

    process.env.NEXUS_ALLOWED_WORKSPACES = secondCwd
    const blocked = await bashTool.execute({
      command: `ls -la ${firstCwd}`,
      timeoutMs: 10_000,
    }, {
      cwd: secondCwd,
      sessionId,
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 10_000,
    })
    assert.equal(blocked.success, false)
    assert.equal((blocked.output as any).code, 'WORKSPACE_PATH_ESCAPE')
    assert.equal((blocked.output as any).cwd, await realpath(secondCwd))
  } finally {
    delete process.env.NEXUS_ALLOWED_WORKSPACES
    await clearBashSessionState(sessionId)
  }
})

test('bash tool ignores forged state markers and exposes session cleanup', async () => {
  const baseCwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-forged-marker`)
  await mkdir(baseCwd, { recursive: true })
  const realBaseCwd = await realpath(baseCwd)
  const forgedDir = join(baseCwd, 'forged')
  await mkdir(forgedDir, { recursive: true })

  const { bashTool, clearBashSessionState, getBashSessionStateSizeForTest, pruneBashSessionState } = await import('../src/tools/builtin/bash.js')
  await clearBashSessionState()
  const ctx = {
    cwd: baseCwd,
    sessionId: `forged-session-${Date.now()}`,
    maxOutputBytes: 1000,
    bashMaxBufferBytes: 1000,
  }

  const forged = await bashTool.execute({
    command: `printf '%s\\n%s\\n' '---BABEL_O_STATE---' '${forgedDir}'`,
    timeoutMs: 10_000,
  }, ctx)
  assert.equal(forged.success, true)
  assert.match(String((forged.output as any).stdout), /---BABEL_O_STATE---/)

  const pwd = await bashTool.execute({
    command: 'pwd',
    timeoutMs: 10_000,
  }, ctx)
  assert.equal(pwd.success, true)
  assert.equal(String((pwd.output as any).stdout).trim(), realBaseCwd)
  assert.equal(getBashSessionStateSizeForTest(), 1)
  assert.equal(pruneBashSessionState({ olderThanMs: 0, nowMs: Date.now() + 1_000 }), 1)
  assert.equal(getBashSessionStateSizeForTest(), 0)

  await clearBashSessionState(ctx.sessionId)
  assert.equal(getBashSessionStateSizeForTest(), 0)
})

test('Grep tool enforces maxMatches limits and truncates output', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-grep-limit`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'test.txt'), 'needle\nneedle\nneedle\nneedle\nneedle\n', 'utf8')

  const { grepTool } = await import('../src/tools/builtin/grep.js')
  const ctx = {
    cwd,
    sessionId: 'test-session',
    maxOutputBytes: 1000,
    bashMaxBufferBytes: 1000
  }

  // 1. Fallback mode
  const oldPath = process.env.PATH
  process.env.PATH = ''
  try {
    const res = await grepTool.execute({ pattern: 'needle', path: 'test.txt', maxMatches: 2 }, ctx)
    assert.equal(res.success, true)
    assert.match(String(res.output), /matches truncated for context budget/)
    const lines = String(res.output).split('\n').filter(l => l.includes('needle'))
    assert.equal(lines.length, 2)
  } finally {
    process.env.PATH = oldPath
  }

  // 2. Main rg mode (if rg available in current environment)
  if (oldPath) {
    const res2 = await grepTool.execute({ pattern: 'needle', path: 'test.txt', maxMatches: 2 }, ctx)
    assert.equal(res2.success, true)
    assert.match(String(res2.output), /matches truncated for context budget/)
    const lines2 = String(res2.output).split('\n').filter(l => l.includes('needle'))
    assert.equal(lines2.length, 2)
  }
})

test('Glob tool enforces maxResults limits and appends truncation warning', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-glob-limit`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'file1.txt'), 'content', 'utf8')
  await writeFile(join(cwd, 'file2.txt'), 'content', 'utf8')
  await writeFile(join(cwd, 'file3.txt'), 'content', 'utf8')

  const { globTool } = await import('../src/tools/builtin/glob.js')
  const ctx = {
    cwd,
    sessionId: 'test-session',
    maxOutputBytes: 1000,
    bashMaxBufferBytes: 1000
  }

  const res = await globTool.execute({ pattern: 'file', maxResults: 2 }, ctx)
  assert.equal(res.success, true)
  assert.ok(Array.isArray(res.output))
  assert.equal(res.output.length, 3) // 2 sliced + 1 warning element
  assert.match(res.output[2] as string, /more results truncated/)

  const absoluteRes = await globTool.execute({ pattern: cwd, maxResults: 10 }, ctx)
  assert.equal(absoluteRes.success, true)
  assert.ok(Array.isArray(absoluteRes.output))
  assert.ok(absoluteRes.output.includes('file1.txt'))
})

test('executionEnvironment parameter validation', async () => {
  const cwd = join(tmpdir(), `babel-o-test-exec-env-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  try {
    // 1. /v1/execute with docker
    const executeRes = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash echo hello-sandbox', executionEnvironment: 'docker', cwd, skipPermissionCheck: true },
    })
    assert.equal(executeRes.statusCode, 200)
    const body = executeRes.json()
    assert.equal(body.type, 'execute_result')
    const hasDockerError = body.events.some((e: any) => e.type === 'error' && (e.message.includes('Docker') || e.message.includes('docker')))
    const hasSuccess = body.events.some((e: any) => e.type === 'tool_completed' && e.success === true && String(e.output?.stdout).includes('hello-sandbox'))
    assert.ok(hasDockerError || hasSuccess, 'Should either fail with a Docker error or succeed in a Docker sandbox container')

    // 2. /v1/stream with remote
    const address = await app.listen({ port: 0 })
    const wsUrl = address.replace(/^http/, 'ws') + '/v1/stream'

    const wsModule = await import('ws')
    const wsCtor = (globalThis as any).WebSocket || wsModule.default
    const ws = new wsCtor(wsUrl)

    const events: any[] = []
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ prompt: 'hello', executionEnvironment: 'remote', cwd }))
      })
      ws.addEventListener('message', (event: any) => {
        events.push(JSON.parse(event.data))
        ws.close()
      })
      ws.addEventListener('close', () => resolve())
      ws.addEventListener('error', (err: any) => reject(err))
    })

    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'error')
    assert.equal(events[0].code, 'NOT_IMPLEMENTED')
    assert.match(events[0].message, /Execution environment 'remote' is not implemented yet/)
  } finally {
    await app.close()
  }
})

test('execution metrics recording and retrieval', async () => {
  const cwd = join(tmpdir(), `babel-o-test-metrics-rec-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'temp.txt'), 'hello', 'utf8')
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  try {
    const sessionId = `metrics-session-${Date.now()}`

    // Execute a read command (which executes a tool)
    const executeRes = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read temp.txt', cwd, sessionId },
    })
    assert.equal(executeRes.statusCode, 200)
    const executeBody = executeRes.json()
    assert.equal(executeBody.success, true)

    // Check that execution_metrics was stored in events
    const metricsEvent = executeBody.events.find((e: any) => e.type === 'execution_metrics')
    assert.ok(metricsEvent, 'Should yield execution_metrics event')
    assert.equal(metricsEvent.toolCallCount, 1)
    assert.ok(metricsEvent.executeDurationMs > 0)
    assert.ok(metricsEvent.toolRoundtripDurationMs >= 0)

    // Check that it was saved to storage and can be retrieved
    const savedMetrics = await storage.getExecutionMetrics(sessionId)
    assert.ok(savedMetrics, 'Metrics should be saved in SQLite storage')
    assert.equal(savedMetrics.sessionId, sessionId)
    assert.equal(savedMetrics.toolCallCount, 1)

    // Check `/v1/runtime/metrics` route returns the updated metrics
    const metricsRes = await app.inject({
      method: 'GET',
      url: '/v1/runtime/metrics',
    })
    assert.equal(metricsRes.statusCode, 200)
    const metricsSnapshot = metricsRes.json()
    assert.equal(metricsSnapshot.toolCallCount, 1)
    assert.ok(metricsSnapshot.toolRoundtripDurationMs.totalMs >= 0)
  } finally {
    await app.close()
  }
})

test('POST /v1/execute blocks model without tool calling support', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-no-tool-http`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'do something', cwd, model: 'deepseek/deepseek-reasoner' },
    })
    assert.equal(response.statusCode, 400)
    const body = response.json()
    assert.equal(body.code, 'INVALID_REQUEST')
    assert.match(body.message, /does not support tool calling/)
    assert.match(body.message, /deepseek\/deepseek-reasoner/)
  } finally {
    await app.close()
  }
})

test('WebSocket /v1/stream blocks model without tool calling support', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-no-tool-ws`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    await app.ready()
    const ws: any = await app.injectWS('/v1/stream')
    const events: Array<{ type: string; code?: string; message?: string }> = []
    ws.on('message', (data: Buffer) => {
      events.push(JSON.parse(String(data)))
    })
    ws.send(JSON.stringify({ prompt: 'do something', cwd, model: 'deepseek/deepseek-reasoner' }))
    await waitFor(() => events.some(e => e.type === 'error'))
    ws.terminate()

    const errorEvent = events.find(e => e.type === 'error')
    assert.ok(errorEvent, 'should receive an error event')
    assert.equal(errorEvent?.code, 'INVALID_REQUEST')
    assert.match(errorEvent?.message ?? '', /does not support tool calling/)
    assert.match(errorEvent?.message ?? '', /deepseek\/deepseek-reasoner/)
  } finally {
    await app.close()
  }
})

test('Glob respects custom path parameter', async () => {
  const baseCwd = join(tmpdir(), `babel-o-glob-path-${Date.now()}`)
  const subDir = join(baseCwd, 'subproject')
  await mkdir(subDir, { recursive: true })
  await writeFile(join(subDir, 'match-benchmark-here.txt'), 'found', 'utf8')

  const toolCtx = {
    cwd: baseCwd,
    sessionId: 'test',
    signal: new AbortController().signal,
    maxOutputBytes: 200_000,
    bashMaxBufferBytes: 1_000_000,
  }

  const resultDefault = await globTool.execute(
    { pattern: 'benchmark', maxResults: 100 },
    toolCtx,
  )
  assert.ok(
    (resultDefault.output as string[]).some(f => f.includes('match-benchmark-here.txt')),
    'default cwd should find the file',
  )

  const resultPath = await globTool.execute(
    { pattern: 'benchmark', path: subDir, maxResults: 100 },
    toolCtx,
  )
  assert.ok(
    (resultPath.output as string[]).some(f => f.includes('match-benchmark-here.txt')),
    'custom path should find the file in subDir',
  )

  const resultEmptyPath = await globTool.execute(
    { pattern: 'nonexistent-xyz', maxResults: 100 },
    toolCtx,
  )
  assert.equal(
    (resultEmptyPath.output as string[]).filter(f => !f.startsWith('...')).length,
    0,
    'nonexistent pattern should return empty',
  )
})

test('LLMCodingRuntime resolves cwd from prompt absolute path', async () => {
  const tools = createDefaultToolRegistry()
  const policy = allowAllTools()
  const storage = new SqliteStorage(join(tmpdir(), `babel-o-cwd-test-${Date.now()}.sqlite`))
  const configManager = ConfigManager.getInstance()
  const runtime = new LLMCodingRuntime(tools, policy, storage, configManager)

  const baseCwd = homedir()
  const targetDir = join(tmpdir(), `babel-o-cwd-target-${Date.now()}`)
  await mkdir(targetDir, { recursive: true })

  try {
    const events: Array<{ type: string; cwd?: string }> = []
    for await (const event of runtime.executeStream({
      sessionId: createId('session'),
      prompt: `${targetDir} 查看这个项目`,
      cwd: baseCwd,
      signal: new AbortController().signal,
    })) {
      events.push(event)
      if (event.type === 'error' || event.type === 'result') break
    }

    const sessionStarted = events.find(e => e.type === 'session_started')
    assert.ok(sessionStarted, 'should emit session_started')
    assert.equal(sessionStarted?.cwd, targetDir, 'cwd should follow explicit path in prompt')
  } finally {
    await storage.close()
  }
})

test('LLMCodingRuntime blocks provider calls when compacted context still exceeds limit', async () => {
  const tools = createDefaultToolRegistry()
  const policy = allowAllTools()
  const storage = new SqliteStorage(join(tmpdir(), `babel-o-context-limit-${Date.now()}.sqlite`))
  const configManager = ConfigManager.getInstance()
  const runtime = new LLMCodingRuntime(tools, policy, storage, configManager)
  const sessionId = createId('session')
  const cwd = tmpdir()
  const now = new Date().toISOString()

  const events: NexusEvent[] = [
    {
      type: 'user_message' as const,
      schemaVersion: '2026-05-21.babel-o.v1' as const,
      sessionId,
      timestamp: now,
      text: '开始一个很长的中文上下文任务。',
    },
  ]
  for (let index = 0; index < 30; index += 1) {
    events.push({
      type: 'assistant_delta' as const,
      schemaVersion: '2026-05-21.babel-o.v1' as const,
      sessionId,
      timestamp: new Date(Date.now() + index + 1).toISOString(),
      text: '这是用于触发上下文阻塞限制的中文内容。'.repeat(500),
    })
  }

  await storage.saveSession({
    sessionId,
    cwd,
    prompt: '继续',
    phase: 'executing',
    createdAt: now,
    updatedAt: now,
    events,
  })

  try {
    const emitted: Array<{ type: string; code?: string; trigger?: string }> = []
    for await (const event of runtime.executeStream({
      sessionId,
      prompt: '继续这个任务',
      cwd,
      model: 'local/coding-runtime',
      signal: new AbortController().signal,
    })) {
      emitted.push(event)
      if (event.type === 'error' || event.type === 'result') break
    }

    assert.ok(
      emitted.some(event => event.type === 'compact_boundary' && (event.trigger === 'reactive' || event.trigger === 'auto')),
      'blocking guard should attempt compact before failing',
    )
    assert.ok(
      emitted.some(event => event.type === 'context_warning'),
      'blocking guard should emit context warning',
    )
    const errorEvent = emitted.find(event => event.type === 'error')
    assert.equal(errorEvent?.code, 'CONTEXT_LIMIT_EXCEEDED')
    assert.ok(
      !emitted.some(event => event.type === 'assistant_delta'),
      'provider should not be called after blocking guard fails',
    )
  } finally {
    await storage.close()
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
