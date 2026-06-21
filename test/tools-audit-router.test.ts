import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { createNexusApp } from '../src/nexus/app.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

describe('ToolsAuditRouter', () => {
  test('GET /v1/tools/audit returns runtime tool definitions', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: process.cwd(),
      runtime: {
        listTools: () => [
          {
            name: 'Read',
            description: 'read files',
            parameters: { type: 'object', properties: {} },
            risk: 'read',
          },
        ],
      } as any,
    })
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/tools/audit' })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.type, 'tools_audit')
      assert.equal(body.tools.length, 1)
      assert.equal(body.tools[0].name, 'Read')
    } finally {
      await app.close()
    }
  })

  test('GET /v1/tools/audit returns an empty list when runtime has no listTools', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: process.cwd(),
      runtime: {} as any,
    })
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/tools/audit' })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.type, 'tools_audit')
      assert.deepEqual(body.tools, [])
    } finally {
      await app.close()
    }
  })
})
