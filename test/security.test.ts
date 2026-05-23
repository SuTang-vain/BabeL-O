import test from 'node:test'
import assert from 'node:assert'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { createNexusApp, isLocalHost, validateSecurityConfig } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'

test('isLocalHost detects localhost patterns', () => {
  assert.ok(isLocalHost('127.0.0.1'))
  assert.ok(isLocalHost('localhost'))
  assert.ok(isLocalHost('::1'))
  assert.ok(isLocalHost('[::1]'))
  assert.ok(isLocalHost('LOCALHOST'))
  assert.ok(isLocalHost(' 127.0.0.1 '))

  assert.ok(!isLocalHost('0.0.0.0'))
  assert.ok(!isLocalHost('192.168.1.1'))
  assert.ok(!isLocalHost('example.com'))
})

test('validateSecurityConfig throws on non-localhost binds without API Key', () => {
  assert.doesNotThrow(() => validateSecurityConfig('127.0.0.1', ''))
  assert.doesNotThrow(() => validateSecurityConfig('localhost', undefined))
  assert.doesNotThrow(() => validateSecurityConfig('0.0.0.0', 'secret-key'))

  assert.throws(() => validateSecurityConfig('0.0.0.0', ''), /Security Error/)
  assert.throws(() => validateSecurityConfig('192.168.1.1', undefined), /Security Error/)
})

test('HTTP API endpoints authentication checks', async () => {
  const cwd = join(tmpdir(), `babel-o-test-security-http-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    apiKey: 'my-super-secret-key'
  })

  try {
    await app.ready()

    // 1. health is unprotected
    const resHealth = await app.inject({
      method: 'GET',
      url: '/health',
    })
    assert.equal(resHealth.statusCode, 200)

    // 2. status without key fails with 401
    const resStatusNoKey = await app.inject({
      method: 'GET',
      url: '/v1/runtime/status',
    })
    assert.equal(resStatusNoKey.statusCode, 401)
    const bodyNoKey = resStatusNoKey.json()
    assert.equal(bodyNoKey.type, 'error')
    assert.equal(bodyNoKey.code, 'UNAUTHORIZED')

    // 3. status with wrong key fails with 401
    const resStatusWrongKey = await app.inject({
      method: 'GET',
      url: '/v1/runtime/status',
      headers: {
        'x-nexus-api-key': 'wrong-key',
      }
    })
    assert.equal(resStatusWrongKey.statusCode, 401)

    // 4. status with correct X-Nexus-API-Key header succeeds
    const resStatusCorrectXKey = await app.inject({
      method: 'GET',
      url: '/v1/runtime/status',
      headers: {
        'x-nexus-api-key': 'my-super-secret-key',
      }
    })
    assert.equal(resStatusCorrectXKey.statusCode, 200)

    // 5. status with correct Authorization: Bearer <key> header succeeds
    const resStatusCorrectAuthKey = await app.inject({
      method: 'GET',
      url: '/v1/runtime/status',
      headers: {
        'authorization': 'Bearer my-super-secret-key',
      }
    })
    assert.equal(resStatusCorrectAuthKey.statusCode, 200)

    // 6. status with wrong Authorization format fails
    const resStatusWrongAuthKey = await app.inject({
      method: 'GET',
      url: '/v1/runtime/status',
      headers: {
        'authorization': 'Bearer wrong-key',
      }
    })
    assert.equal(resStatusWrongAuthKey.statusCode, 401)
  } finally {
    await app.close()
  }
})

test('WebSocket stream handshake authentication checks', async () => {
  const cwd = join(tmpdir(), `babel-o-test-security-ws-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  const apiKey = 'ws-secret-key'
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    apiKey,
  })

  try {
    const address = await app.listen({ port: 0 })
    const wsUrl = address.replace(/^http/, 'ws') + '/v1/stream'

    const wsModule = await import('ws')
    const wsCtor = wsModule.default

    // 1. Connection without API key should fail
    await new Promise<void>((resolve, reject) => {
      const ws = new wsCtor(wsUrl)
      ws.on('open', () => {
        ws.close()
        reject(new Error('WebSocket connection should not succeed without API key'))
      })
      ws.on('error', () => {
        resolve()
      })
    })

    // 2. Connection with incorrect API key should fail
    await new Promise<void>((resolve, reject) => {
      const ws = new wsCtor(wsUrl, {
        headers: {
          'X-Nexus-API-Key': 'incorrect-ws-key',
        }
      })
      ws.on('open', () => {
        ws.close()
        reject(new Error('WebSocket connection should not succeed with incorrect API key'))
      })
      ws.on('error', () => {
        resolve()
      })
    })

    // 3. Connection with correct API key should succeed
    await new Promise<void>((resolve, reject) => {
      const ws = new wsCtor(wsUrl, {
        headers: {
          'X-Nexus-API-Key': apiKey,
        }
      })
      ws.on('open', () => {
        ws.close()
        resolve()
      })
      ws.on('error', (err: any) => {
        reject(new Error(`WebSocket connection failed with correct API key: ${err.message}`))
      })
    })
  } finally {
    await app.close()
  }
})

test('Workspace allowlist blocks unauthorized paths', async () => {
  const allowedCwd = join(tmpdir(), `babel-o-test-allowed-${Date.now()}`)
  const forbiddenCwd = join(tmpdir(), `babel-o-test-forbidden-${Date.now()}`)
  await mkdir(allowedCwd, { recursive: true })
  await mkdir(forbiddenCwd, { recursive: true })

  // Set the environment variable
  process.env.NEXUS_ALLOWED_WORKSPACES = allowedCwd

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: allowedCwd,
  })

  try {
    await app.ready()

    // 1. Allowed workspace execution should succeed/proceed (not fail with allowlist error)
    const allowedRes = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read temp.txt', cwd: allowedCwd, skipPermissionCheck: true },
    })
    // Since read is fine and skipped permissions, it returns 200
    assert.equal(allowedRes.statusCode, 200)
    const allowedBody = allowedRes.json()
    assert.notEqual(allowedBody.code, 'INVALID_REQUEST')

    // 2. Forbidden workspace execution should fail with 400 INVALID_REQUEST
    const forbiddenRes = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read temp.txt', cwd: forbiddenCwd, skipPermissionCheck: true },
    })
    assert.equal(forbiddenRes.statusCode, 400)
    const forbiddenBody = forbiddenRes.json()
    assert.equal(forbiddenBody.code, 'INVALID_REQUEST')
    assert.match(forbiddenBody.message, /Workspace directory not allowed/)
  } finally {
    delete process.env.NEXUS_ALLOWED_WORKSPACES
    await app.close()
  }
})

test('Deny-by-default blocks high risk tools unless allowed', async () => {
  const cwd = join(tmpdir(), `babel-o-test-deny-by-default-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  // Create runtime with default option -> denyByDefaultTools()
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
  })

  try {
    await app.ready()

    // Write is high risk, should be blocked by policy immediately
    const res = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'write temp.txt "content"', cwd, skipPermissionCheck: true },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.success, false)
    assert.ok(body.events.some((e: any) => e.type === 'tool_denied' && e.name === 'Write' && e.message.includes('policy')))
  } finally {
    await app.close()
  }
})

test('Allow-all policy still prompts for high risk tools', async () => {
  const cwd = join(tmpdir(), `babel-o-test-allow-all-prompts-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  const { runtime } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const sessionId = `allow-all-prompts-${Date.now()}`
  const events: any[] = []

  const executePromise = (async () => {
    for await (const event of runtime.executeStream({
      sessionId,
      prompt: 'bash "make build"',
      cwd,
    })) {
      events.push(event)
    }
  })()

  let toolUseId = ''
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 50))
    const request = events.find((e: any) => e.type === 'permission_request')
    if (request) {
      toolUseId = request.toolUseId
      break
    }
  }

  assert.ok(toolUseId, 'high risk tools should reach permission_request')
  assert.ok(!events.some((e: any) => e.type === 'tool_denied' && e.message.includes('policy')))

  const { PendingPermissionRegistry } = await import('../src/shared/session.js')
  PendingPermissionRegistry.getInstance().resolve(sessionId, toolUseId, {
    approved: false,
    reason: 'test denial',
  })

  await executePromise

  assert.ok(events.some((e: any) => e.type === 'permission_response' && e.approved === false))
  assert.ok(events.some((e: any) => e.type === 'tool_denied' && e.message === 'test denial'))
})

test('Permission audit records are correctly persisted and retrievable', async () => {
  const cwd = join(tmpdir(), `babel-o-test-permission-audit-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  // Enable all tools in policy, so high risk tools trigger permission flow instead of policy block
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
  })

  try {
    await app.ready()

    const sessionId = `audit-session-${Date.now()}`
    const executePromise = app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'write temp.txt "audit content"', cwd, sessionId },
    })

    // Poll until permission_request event is added
    let toolUseId = ''
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100))
      const sessionRes = await app.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}`,
      })
      if (sessionRes.statusCode === 200) {
        const data = sessionRes.json()
        if (data.session && Array.isArray(data.session.events)) {
          const reqEvent = data.session.events.find((e: any) => e.type === 'permission_request')
          if (reqEvent) {
            toolUseId = reqEvent.toolUseId
            break
          }
        }
      }
    }

    assert.ok(toolUseId, 'Should have received permission request')

    // Approve the request
    const approveRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/approve`,
      payload: { toolUseId },
    })
    assert.equal(approveRes.statusCode, 200)

    // Wait for execution to finish
    const response = await executePromise
    assert.equal(response.statusCode, 200)

    // Now, fetch permission audits via API
    const auditsRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/permission-audits`,
    })
    assert.equal(auditsRes.statusCode, 200)
    const auditsBody = auditsRes.json()
    assert.equal(auditsBody.type, 'permission_audits')
    assert.equal(auditsBody.sessionId, sessionId)
    assert.ok(Array.isArray(auditsBody.audits))
    assert.equal(auditsBody.audits.length, 1)

    const audit = auditsBody.audits[0]
    assert.ok(audit.auditId.startsWith('audit_'))
    assert.equal(audit.sessionId, sessionId)
    assert.equal(audit.toolUseId, toolUseId)
    assert.equal(audit.toolName, 'Write')
    assert.equal(audit.toolRisk, 'write')
    assert.equal(audit.decision, 'approved')
    assert.ok(audit.timestamp)
  } finally {
    await app.close()
  }
})
