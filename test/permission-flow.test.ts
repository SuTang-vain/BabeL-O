import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { PendingPermissionRegistry } from '../src/shared/session.js'

test('interactive permission approval flow via HTTP POST', async () => {
  const cwd = join(tmpdir(), `babel-o-test-permission-approve-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const sessionId = `session-approve-${Date.now()}`
  
  // 异步发起 execute 流程，遇到写文件会阻塞
  const executePromise = app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: { prompt: 'write temp.txt "hello permission"', cwd, sessionId },
  })

  // 轮询等待 permission_request 事件出现并被持久化
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

  assert.ok(toolUseId, 'Should have received a permission request with toolUseId')

  // 调用 /approve 端点批准提权
  const approveRes = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/approve`,
    payload: { toolUseId },
  })
  assert.equal(approveRes.statusCode, 200)

  // 等待 execute 流程执行完成
  const response = await executePromise
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.success, true)

  // 验证结果，应该包含 permission_response 以及 tool_completed 且执行成功
  const finalSessionRes = await app.inject({
    method: 'GET',
    url: `/v1/sessions/${sessionId}`,
  })
  const finalData = finalSessionRes.json()
  const events = finalData.session.events

  assert.ok(events.some((e: any) => e.type === 'permission_request'))
  assert.ok(events.some((e: any) => e.type === 'permission_response' && e.approved === true))
  assert.ok(events.some((e: any) => e.type === 'tool_completed' && e.success === true))

  await app.close()
})

test('interactive permission denial flow via HTTP POST', async () => {
  const cwd = join(tmpdir(), `babel-o-test-permission-deny-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const sessionId = `session-deny-${Date.now()}`
  
  // 异步发起 execute 流程
  const executePromise = app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: { prompt: 'write temp.txt "hello permission"', cwd, sessionId },
  })

  // 轮询等待 permission_request 事件出现并被持久化
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

  assert.ok(toolUseId, 'Should have received a permission request')

  // 调用 /deny 端点拒绝提权
  const denyRes = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/deny`,
    payload: { toolUseId, reason: 'test rejection' },
  })
  assert.equal(denyRes.statusCode, 200)

  // 等待 execute 流程执行完成
  const response = await executePromise
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.success, false)

  // 验证结果，应该包含 permission_response(approved=false) 以及 tool_denied
  const finalSessionRes = await app.inject({
    method: 'GET',
    url: `/v1/sessions/${sessionId}`,
  })
  const finalData = finalSessionRes.json()
  const events = finalData.session.events

  assert.ok(events.some((e: any) => e.type === 'permission_request'))
  assert.ok(events.some((e: any) => e.type === 'permission_response' && e.approved === false && e.reason === 'test rejection'))
  assert.ok(events.some((e: any) => e.type === 'tool_denied'))
  assert.ok(!events.some((e: any) => e.type === 'tool_completed'))

  await app.close()
})

test('interactive permission approval via WebSocket stream', async () => {
  const cwd = join(tmpdir(), `babel-o-test-permission-ws-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const address = await app.listen({ port: 0 })
  const wsUrl = address.replace(/^http/, 'ws') + '/v1/stream'

  const sessionId = `session-ws-${Date.now()}`
  
  const wsModule = await import('ws')
  const wsCtor = (globalThis as any).WebSocket || wsModule.default
  const ws = new wsCtor(wsUrl)

  const events: any[] = []
  
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ prompt: 'write temp.txt "ws content"', cwd, sessionId }))
    })

    ws.addEventListener('message', (event: any) => {
      const ev = JSON.parse(event.data)
      events.push(ev)

      if (ev.type === 'permission_request') {
        ws.send(JSON.stringify({
          type: 'permission_response',
          sessionId,
          toolUseId: ev.toolUseId,
          approved: true,
        }))
      } else if (ev.type === 'result') {
        ws.close()
        resolve()
      } else if (ev.type === 'error') {
        ws.close()
        reject(new Error(ev.message))
      }
    })

    ws.addEventListener('error', (err: any) => {
      reject(err)
    })
  })

  assert.ok(events.some((e: any) => e.type === 'permission_request'))
  assert.ok(events.some((e: any) => e.type === 'permission_response' && e.approved === true))
  assert.ok(events.some((e: any) => e.type === 'tool_completed' && e.success === true))

  await app.close()
})

test('smart permissions: auto-approves safe commands and persists audit log', async () => {
  const cwd = join(tmpdir(), `babel-o-test-smart-approve-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const sessionId = `session-smart-approve-${Date.now()}`

  // Execute a whitelisted safe command 'ls'
  const response = await app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: { prompt: 'bash "ls"', cwd, sessionId },
  })

  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.success, true)

  // Verify that it auto-approved: there should be NO permission_request event
  const sessionRes = await app.inject({
    method: 'GET',
    url: `/v1/sessions/${sessionId}`,
  })
  assert.equal(sessionRes.statusCode, 200)
  const sessionData = sessionRes.json()
  const events = sessionData.session.events
  assert.ok(!events.some((e: any) => e.type === 'permission_request'), 'Should not have asked for permission')

  // Verify the audit log exists in SQLite storage and is marked as approved with reason Auto-approved
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
  assert.equal(auditsBody.audits[0].toolName, 'Bash')
  assert.equal(auditsBody.audits[0].decision, 'approved')
  assert.match(auditsBody.audits[0].reason, /Auto-approved: Known safe command/)

  await app.close()
})

test('smart permissions: prompts user for cat paths outside workspace', async () => {
  const cwd = join(tmpdir(), `babel-o-test-smart-cat-outside-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const sessionId = `session-smart-cat-outside-${Date.now()}`
  const executePromise = app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: { prompt: 'bash "cat /tmp/secret.txt"', cwd, sessionId },
  })

  let toolUseId = ''
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100))
    const sessionRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
    })
    if (sessionRes.statusCode === 200) {
      const data = sessionRes.json()
      const reqEvent = data.session?.events?.find((e: any) => e.type === 'permission_request')
      if (reqEvent) {
        toolUseId = reqEvent.toolUseId
        assert.match(reqEvent.message, /manual review/i)
        break
      }
    }
  }

  assert.ok(toolUseId, 'Should have received permission request for cat outside workspace')

  const denyRes = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/deny`,
    payload: { toolUseId, reason: 'outside workspace cat requires review' },
  })
  assert.equal(denyRes.statusCode, 200)

  const response = await executePromise
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.success, false)

  const auditsRes = await app.inject({
    method: 'GET',
    url: `/v1/sessions/${sessionId}/permission-audits`,
  })
  assert.equal(auditsRes.statusCode, 200)
  const auditsBody = auditsRes.json()
  assert.equal(auditsBody.audits.length, 1)
  assert.equal(auditsBody.audits[0].toolName, 'Bash')
  assert.equal(auditsBody.audits[0].decision, 'denied')

  await app.close()
})

test('smart permissions: prompts user on non-whitelisted/dangerous command', async () => {
  const cwd = join(tmpdir(), `babel-o-test-smart-prompt-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const sessionId = `session-smart-prompt-${Date.now()}`

  // Execute a dangerous/non-whitelisted command: 'rm -rf temporary_folder'
  const executePromise = app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: { prompt: 'bash "rm -rf temporary_folder"', cwd, sessionId },
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

  assert.ok(toolUseId, 'Should have received permission request for dangerous command')

  // Approve the request to let it complete
  const approveRes = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/approve`,
    payload: { toolUseId },
  })
  assert.equal(approveRes.statusCode, 200)

  // Wait for execution to finish
  const response = await executePromise
  assert.equal(response.statusCode, 200)

  // Verify the audit log exists and matches user review
  const auditsRes = await app.inject({
    method: 'GET',
    url: `/v1/sessions/${sessionId}/permission-audits`,
  })
  assert.equal(auditsRes.statusCode, 200)
  const auditsBody = auditsRes.json()
  assert.equal(auditsBody.audits.length, 1)
  assert.equal(auditsBody.audits[0].toolName, 'Bash')
  assert.equal(auditsBody.audits[0].decision, 'approved')
  assert.equal(auditsBody.audits[0].reason, 'User review')

  await app.close()
})

test('pending permission registry expires unresolved requests', async () => {
  const registry = PendingPermissionRegistry.getInstance()
  registry.resetForTest()
  registry.configureForTest({ ttlMs: 5, disableSweeper: true })

  const pending = registry.register('session-ttl', 'tool-ttl')
  assert.equal(registry.pendingCount(), 1)

  const expired = registry.sweepExpired(Date.now() + 10)
  assert.equal(expired, 1)
  assert.equal(registry.pendingCount(), 0)
  const resolution = await pending
  assert.equal(resolution.approved, false)
  assert.equal(resolution.reason, 'Permission request timed out')

  registry.resetForTest()
})
