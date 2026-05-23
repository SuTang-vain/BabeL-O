import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { createNexusApp } from '../src/nexus/app.js'

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
