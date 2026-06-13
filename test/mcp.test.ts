import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { createNexusApp } from '../src/nexus/app.js'
import { PendingPermissionRegistry } from '../src/shared/session.js'
import type { EverCoreClient } from '../src/runtime/everCoreClient.js'
import type { EverCoreRuntimeConfig } from '../src/nexus/everCoreConfig.js'
import type { NexusEvent } from '../src/shared/events.js'

test('MCP stdio tools are registered, audited, and gated by explicit allowlist', async () => {
  const cwd = join(tmpdir(), `babel-o-mcp-${Date.now()}`)
  await mkdir(join(cwd, '.babel-o'), { recursive: true })
  await writeFile(join(cwd, '.babel-o', 'mcp.json'), JSON.stringify({
    servers: {
      mock: {
        command: process.execPath,
        args: [join(process.cwd(), 'test/fixtures/mock-mcp-server.mjs')],
        allowedTools: ['echo'],
        toolRisk: {
          echo: 'read',
          secretWrite: 'write',
        },
      },
    },
  }), 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime({
    cwd,
    enableMcp: true,
    allowedTools: ['Read', 'mcp:mock:echo', 'mcp:mock:secretWrite'],
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const auditResponse = await app.inject({
      method: 'GET',
      url: '/v1/tools/audit',
    })
    assert.equal(auditResponse.statusCode, 200)
    const audit = auditResponse.json()
    const echo = audit.tools.find((tool: { name: string }) => tool.name === 'mcp:mock:echo')
    const secretWrite = audit.tools.find((tool: { name: string }) => tool.name === 'mcp:mock:secretWrite')

    assert.equal(echo.allowed, true)
    assert.equal(echo.risk, 'read')
    assert.deepEqual(echo.source, {
      type: 'mcp',
      serverName: 'mock',
      originalName: 'echo',
    })
    assert.equal(secretWrite.allowed, true)
    assert.equal(secretWrite.risk, 'write')
    assert.equal(secretWrite.requiresApproval, true)
    assert.equal(secretWrite.suggestedAllowRule, 'mcp:mock:secretWrite')
    assert.equal(secretWrite.mcpServerAllowed, false)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        cwd,
        prompt: 'mcp:mock:echo {"message":"hello"}',
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.result.success, true)
    assert.match(JSON.stringify(body.events), /echo:hello/)
  } finally {
    await app.close()
    await storage.close?.()
  }
})

test('MCP write permission request carries server source identity', async () => {
  const cwd = join(tmpdir(), `babel-o-mcp-permission-${Date.now()}`)
  await mkdir(join(cwd, '.babel-o'), { recursive: true })
  await writeFile(join(cwd, '.babel-o', 'mcp.json'), JSON.stringify({
    servers: {
      mock: {
        command: process.execPath,
        args: [join(process.cwd(), 'test/fixtures/mock-mcp-server.mjs')],
        allowedTools: ['secretWrite'],
        toolRisk: {
          secretWrite: 'write',
        },
      },
    },
  }), 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime({
    cwd,
    enableMcp: true,
    allowedTools: ['mcp:mock:secretWrite'],
  })
  const sessionId = `session-mcp-permission-${Date.now()}`
  try {
    const events = []
    for await (const event of runtime.executeStream({
      sessionId,
      cwd,
      prompt: 'mcp:mock:secretWrite {"path":"secrets.txt"}',
      storage,
    })) {
      events.push(event)
      if (event.type === 'permission_request') {
        assert.equal(event.name, 'mcp:mock:secretWrite')
        assert.equal(event.risk, 'write')
        assert.deepEqual(event.source, {
          type: 'mcp',
          serverName: 'mock',
          originalName: 'secretWrite',
        })
        PendingPermissionRegistry.getInstance().resolve(sessionId, event.toolUseId, {
          approved: false,
          reason: 'test rejection',
        })
      }
    }
    assert.ok(events.some(event => event.type === 'permission_request'))
    assert.ok(events.some(event => event.type === 'permission_response' && event.approved === false))
  } finally {
    await storage.close?.()
  }
})

test('MCP tools default to denied when server allowlist omits the tool', async () => {
  const cwd = join(tmpdir(), `babel-o-mcp-deny-${Date.now()}`)
  await mkdir(join(cwd, '.babel-o'), { recursive: true })
  await writeFile(join(cwd, '.babel-o', 'mcp.json'), JSON.stringify({
    servers: {
      mock: {
        command: process.execPath,
        args: [join(process.cwd(), 'test/fixtures/mock-mcp-server.mjs')],
        allowedTools: [],
      },
    },
  }), 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime({
    cwd,
    enableMcp: true,
    allowedTools: ['mcp:mock:echo'],
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        cwd,
        prompt: 'mcp:mock:echo {"message":"hello"}',
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.result.success, false)
    assert.match(JSON.stringify(body.events), /not allowlisted/)
  } finally {
    await app.close()
    await storage.close?.()
  }
})

test('MCP tools validate runtime input against remote inputSchema', async () => {
  const cwd = join(tmpdir(), `babel-o-mcp-schema-${Date.now()}`)
  await mkdir(join(cwd, '.babel-o'), { recursive: true })
  await writeFile(join(cwd, '.babel-o', 'mcp.json'), JSON.stringify({
    servers: {
      mock: {
        command: process.execPath,
        args: [join(process.cwd(), 'test/fixtures/mock-mcp-server.mjs')],
        allowedTools: ['echo'],
      },
    },
  }), 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime({
    cwd,
    enableMcp: true,
    allowedTools: ['mcp:mock:echo'],
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        cwd,
        prompt: 'mcp:mock:echo {"extra":true}',
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.result.success, false)
    assert.match(JSON.stringify(body.events), /MCP_INPUT_SCHEMA_VALIDATION_FAILED/)
    assert.match(JSON.stringify(body.events), /message/)
  } finally {
    await app.close()
    await storage.close?.()
  }
})

test('EverCore MCP tools are not registered unless explicitly enabled and healthy', async () => {
  const cwd = join(tmpdir(), `babel-o-evercore-mcp-disabled-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const client = createMockEverCoreClient()
  const { runtime, storage } = await createDefaultNexusRuntime({
    cwd,
    allowedTools: ['*'],
    everCore: {
      client,
      config: createEverCoreTestConfig({ mcpToolsEnabled: false }),
    },
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/tools/audit' })
    assert.equal(response.statusCode, 200)
    const audit = response.json()
    assert.equal(audit.tools.some((tool: { name: string }) => tool.name.startsWith('mcp:evercore:')), false)
  } finally {
    await app.close()
    await storage.close?.()
  }
})

test('EverCore memory_search MCP tool returns bounded explicit search diagnostics', async () => {
  const cwd = join(tmpdir(), `babel-o-evercore-mcp-search-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const searchInputs: unknown[] = []
  const client = createMockEverCoreClient({
    async search(input) {
      searchInputs.push(input)
      return {
        data: {
          episodes: [
            { content: 'Remembered EverCore note about volatile MCP tools.', source: 'episode-1', score: 0.8765 },
            { content: 'This second note should be truncated by topK.', source: 'episode-2' },
          ],
        },
      }
    },
  })
  const { runtime, storage } = await createDefaultNexusRuntime({
    cwd,
    allowedTools: ['mcp:evercore:memory_search'],
    everCore: {
      client,
      config: createEverCoreTestConfig({ mcpToolsEnabled: true, topK: 5, maxContentChars: 80 }),
    },
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const auditResponse = await app.inject({ method: 'GET', url: '/v1/tools/audit' })
    const audit = auditResponse.json()
    const searchTool = audit.tools.find((tool: { name: string }) => tool.name === 'mcp:evercore:memory_search')
    assert.equal(searchTool.allowed, true)
    assert.equal(searchTool.risk, 'read')
    assert.equal(searchTool.requiresApproval, false)
    assert.match(searchTool.description, /prior preferences/)
    assert.match(searchTool.description, /workspace evidence/)
    assert.deepEqual(searchTool.source, {
      type: 'mcp',
      serverName: 'evercore',
      originalName: 'memory_search',
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        cwd,
        prompt: 'mcp:evercore:memory_search {"query":"volatile memory","topK":1,"maxChars":48,"maxHitChars":32}',
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.result.success, true)
    assert.equal(searchInputs.length, 1)
    assert.deepEqual(searchInputs[0], {
      query: 'volatile memory',
      appId: 'babel-o',
      projectId: 'project-1',
      userId: undefined,
      agentId: 'agent-1',
      method: 'hybrid',
      topK: 1,
    })
    const completed = body.events.find((event: NexusEvent) => event.type === 'tool_completed')
    assert.equal(completed.name, 'mcp:evercore:memory_search')
    assert.equal(completed.success, true)
    assert.equal(completed.output.hitCount, 1)
    assert.equal(completed.output.budgetChars, 48)
    assert.equal(completed.output.maxHitChars, 32)
    assert.equal(completed.output.truncated, true)
    assert.match(completed.output.content, /Remembered EverCore note/)
    assert.match(completed.output.note, /background hints/)
  } finally {
    await app.close()
    await storage.close?.()
  }
})

test('EverCore write MCP tools require permission and call add/flush only after approval', async () => {
  const cwd = join(tmpdir(), `babel-o-evercore-mcp-write-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const addInputs: unknown[] = []
  const flushInputs: unknown[] = []
  const client = createMockEverCoreClient({
    async addAgentMessages(input) {
      addInputs.push(input)
      return { data: { ok: true } }
    },
    async flushAgentSession(input) {
      flushInputs.push(input)
      return { data: { ok: true } }
    },
  })
  const { runtime, storage } = await createDefaultNexusRuntime({
    cwd,
    allowedTools: ['mcp:evercore:memory_save_note', 'mcp:evercore:memory_flush_session'],
    everCore: {
      client,
      config: createEverCoreTestConfig({ mcpToolsEnabled: true }),
    },
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  const auditResponse = await app.inject({ method: 'GET', url: '/v1/tools/audit' })
  const audit = auditResponse.json()
  const saveTool = audit.tools.find((tool: { name: string }) => tool.name === 'mcp:evercore:memory_save_note')
  const flushTool = audit.tools.find((tool: { name: string }) => tool.name === 'mcp:evercore:memory_flush_session')
  assert.match(saveTool.description, /permission-gated/)
  assert.match(saveTool.description, /current runtime session/)
  assert.match(saveTool.description, /workspace evidence/)
  assert.deepEqual(Object.keys(saveTool.inputSchema.properties).sort(), ['note'])
  assert.match(flushTool.description, /runtime session close/)
  await app.close()

  const saveSessionId = `session-evercore-mcp-save-${Date.now()}`
  const saveEvents: NexusEvent[] = []
  for await (const event of runtime.executeStream({
    sessionId: saveSessionId,
    cwd,
    prompt: 'mcp:evercore:memory_save_note {"note":"Persist this explicit note."}',
    storage,
  })) {
    saveEvents.push(event)
    if (event.type === 'permission_request') {
      assert.equal(event.name, 'mcp:evercore:memory_save_note')
      assert.equal(event.risk, 'write')
      assert.deepEqual(event.source, {
        type: 'mcp',
        serverName: 'evercore',
        originalName: 'memory_save_note',
      })
      PendingPermissionRegistry.getInstance().resolve(saveSessionId, event.toolUseId, {
        approved: true,
        reason: 'test approval',
      })
    }
  }
  assert.equal(addInputs.length, 1)
  assert.equal((addInputs[0] as any).sessionId, saveSessionId)
  assert.equal((addInputs[0] as any).messages.length, 2)
  assert.equal((addInputs[0] as any).messages[0].role, 'user')
  assert.equal((addInputs[0] as any).messages[0].content, 'Persist this explicit note.')
  assert.equal((addInputs[0] as any).messages[1].role, 'assistant')
  assert.match((addInputs[0] as any).messages[1].content, /Approved long-term memory note saved/)
  assert.ok(saveEvents.some(event => event.type === 'permission_response' && event.approved === true))

  const flushSessionId = `session-evercore-mcp-flush-${Date.now()}`
  for await (const event of runtime.executeStream({
    sessionId: flushSessionId,
    cwd,
    prompt: 'mcp:evercore:memory_flush_session {}',
    storage,
  })) {
    if (event.type === 'permission_request') {
      PendingPermissionRegistry.getInstance().resolve(flushSessionId, event.toolUseId, {
        approved: true,
        reason: 'test approval',
      })
    }
  }
  assert.equal(flushInputs.length, 1)
  assert.equal((flushInputs[0] as any).sessionId, flushSessionId)
  await storage.close?.()
})

test('EverCore memory_search MCP tool reports non-fatal failure as tool result', async () => {
  const cwd = join(tmpdir(), `babel-o-evercore-mcp-failure-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const client = createMockEverCoreClient({
    async search() {
      throw new Error('EverCore search unavailable')
    },
  })
  const { runtime, storage } = await createDefaultNexusRuntime({
    cwd,
    allowedTools: ['mcp:evercore:memory_search'],
    everCore: {
      client,
      config: createEverCoreTestConfig({ mcpToolsEnabled: true }),
    },
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        cwd,
        prompt: 'mcp:evercore:memory_search {"query":"anything"}',
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.result.success, false)
    const completed = body.events.find((event: NexusEvent) => event.type === 'tool_completed')
    assert.equal(completed.success, false)
    assert.equal(completed.output.code, 'EVERCORE_MEMORY_SEARCH_FAILED')
    assert.match(completed.output.message, /EverCore search unavailable/)
  } finally {
    await app.close()
    await storage.close?.()
  }
})

function createEverCoreTestConfig(
  overrides: Partial<EverCoreRuntimeConfig> = {},
): EverCoreRuntimeConfig {
  return {
    appId: 'babel-o',
    projectId: 'project-1',
    agentId: 'agent-1',
    retrieveMethod: 'hybrid',
    topK: 5,
    uploadOnSessionEnd: false,
    maxMessages: 8,
    maxContentChars: 120,
    mcpToolsEnabled: false,
    ...overrides,
  }
}

function createMockEverCoreClient(overrides: Partial<EverCoreClient> = {}): EverCoreClient {
  return {
    async search() {
      return { data: {} }
    },
    async addAgentMessages() {
      return { data: {} }
    },
    async flushAgentSession() {
      return { data: {} }
    },
    ...overrides,
  }
}
