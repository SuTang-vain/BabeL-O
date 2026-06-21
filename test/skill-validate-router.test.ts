import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createNexusApp } from '../src/nexus/app.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

test('skill validate router preserves diagnostics and status codes', async () => {
  const app = await createNexusApp({
    storage: new MemoryStorage(),
    defaultCwd: '/tmp',
    runtime: { listTools: () => [] } as any,
  })
  try {
    const valid = await app.inject({
      method: 'POST',
      url: '/v1/skills/validate',
      payload: {
        body: `---
id: test-skill
name: Test
triggers: [test]
priority: 5
---
body`,
      },
    })
    assert.equal(valid.statusCode, 200)
    const validBody = valid.json()
    assert.equal(validBody.ok, true)
    assert.equal(validBody.skillId, 'test-skill')
    assert.equal(validBody.errorCount, 0)

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/skills/validate',
      payload: {
        body: `---
name: Missing Id
triggers: [test]
---
body`,
      },
    })
    assert.equal(invalid.statusCode, 422)
    const invalidBody = invalid.json()
    assert.equal(invalidBody.ok, false)
    assert.equal(invalidBody.errorCount, 1)
    assert.equal(invalidBody.diagnostics[0].code, 'SKILL_PARSE_FAILED')
  } finally {
    await app.close()
  }
})
