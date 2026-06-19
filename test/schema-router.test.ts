import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'

const originalConfigFile = process.env.BABEL_O_CONFIG_FILE
const originalNodeEnv = process.env.NODE_ENV
process.env.BABEL_O_CONFIG_FILE = join(tmpdir(), `babel-o-schema-router-${process.pid}.json`)
process.env.NODE_ENV = 'test'

after(() => {
  if (originalConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
  else process.env.BABEL_O_CONFIG_FILE = originalConfigFile
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

test('schema router preserves Nexus event JSON schema endpoint', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/schema/events' })
    assert.equal(response.statusCode, 200)
    const schema = response.json()
    assert.equal(typeof schema, 'object')
    const encoded = JSON.stringify(schema)
    assert.match(encoded, /task_scope_declared/)
    assert.match(encoded, /scope_boundary_detected/)
    assert.match(encoded, /result/)
  } finally {
    await app.close()
  }
})
