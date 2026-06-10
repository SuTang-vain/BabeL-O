import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { InMemoryRemoteToolRunner } from '../src/runtime/remoteRunner.js'
import {
  PendingPermissionRegistry,
  type PendingPermissionBackend,
  type PendingPermissionEntry,
  type PermissionResolution,
} from '../src/shared/session.js'

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

test('remote execution waits for permission before dispatching runner', async () => {
  const cwd = join(tmpdir(), `babel-o-test-remote-permission-approve-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const remoteRunner = new InMemoryRemoteToolRunner({
    handler: () => ({ kind: 'result', success: true, output: { remote: true } }),
  })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'], remoteRunner })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd, remoteRunner })
  const sessionId = `session-remote-approve-${Date.now()}`

  try {
    const executePromise = app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'write remote.txt "remote permission"', cwd, sessionId, executionEnvironment: 'remote' },
    })

    let toolUseId = ''
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (remoteRunner.requests.length > 0) break
      const sessionRes = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}` })
      if (sessionRes.statusCode !== 200) continue
      const reqEvent = sessionRes.json().session?.events?.find((e: any) => e.type === 'permission_request')
      if (reqEvent) {
        toolUseId = reqEvent.toolUseId
        break
      }
    }

    assert.ok(toolUseId, 'Should request permission before remote dispatch')
    assert.equal(remoteRunner.requests.length, 0)

    const approveRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/approve`,
      payload: { toolUseId },
    })
    assert.equal(approveRes.statusCode, 200)

    const response = await executePromise
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().success, true)
    assert.equal(remoteRunner.requests.length, 1)
    assert.equal(remoteRunner.requests[0].toolName, 'Write')

    const auditsRes = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}/permission-audits` })
    const auditsBody = auditsRes.json()
    assert.equal(auditsBody.audits.length, 1)
    assert.equal(auditsBody.audits[0].toolName, 'Write')
    assert.equal(auditsBody.audits[0].decision, 'approved')
  } finally {
    await app.close()
  }
})

test('remote execution denial does not dispatch runner and persists audit', async () => {
  const cwd = join(tmpdir(), `babel-o-test-remote-permission-deny-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const remoteRunner = new InMemoryRemoteToolRunner({
    handler: () => ({ kind: 'result', success: true, output: { remote: true } }),
  })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'], remoteRunner })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd, remoteRunner })
  const sessionId = `session-remote-deny-${Date.now()}`

  try {
    const executePromise = app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'write remote.txt "remote denied"', cwd, sessionId, executionEnvironment: 'remote' },
    })

    let toolUseId = ''
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100))
      const sessionRes = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}` })
      if (sessionRes.statusCode !== 200) continue
      const reqEvent = sessionRes.json().session?.events?.find((e: any) => e.type === 'permission_request')
      if (reqEvent) {
        toolUseId = reqEvent.toolUseId
        break
      }
    }

    assert.ok(toolUseId, 'Should request permission before remote denial')
    const denyRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/deny`,
      payload: { toolUseId, reason: 'remote denied by test' },
    })
    assert.equal(denyRes.statusCode, 200)

    const response = await executePromise
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().success, false)
    assert.equal(remoteRunner.requests.length, 0)

    const finalSessionRes = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}` })
    const events = finalSessionRes.json().session.events
    assert.ok(events.some((e: any) => e.type === 'permission_response' && e.approved === false))
    assert.ok(events.some((e: any) => e.type === 'tool_denied'))
    assert.ok(!events.some((e: any) => e.type === 'tool_completed'))

    const auditsRes = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}/permission-audits` })
    const auditsBody = auditsRes.json()
    assert.equal(auditsBody.audits.length, 1)
    assert.equal(auditsBody.audits[0].toolName, 'Write')
    assert.equal(auditsBody.audits[0].decision, 'denied')
    assert.equal(auditsBody.audits[0].reason, 'remote denied by test')
  } finally {
    await app.close()
  }
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

test('smart permissions: read-only Bash subcommands skip the approval gate entirely', async () => {
  // Phase A of docs/nexus/reference/go-tui-permission-policy-governance-plan.md
  // downgrades read-only Bash subcommands (`ls`, `cat`, `git status`, ...) to
  // `risk: 'read'` at the classifier layer, so the runtime skips BOTH the
  // policy hard-deny and the approval gate. There is no permission_request
  // event and no permission_audit row — the command runs as a normal
  // read-only tool call, just like `Read` or `ListDir`.
  const cwd = join(tmpdir(), `babel-o-test-smart-approve-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'hello smart-approve\n', 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const sessionId = `session-smart-approve-${Date.now()}`

  const response = await app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: { prompt: 'bash "ls"', cwd, sessionId },
  })

  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.success, true, `expected success, got body=${JSON.stringify(body).slice(0, 400)}`)

  const sessionRes = await app.inject({
    method: 'GET',
    url: `/v1/sessions/${sessionId}`,
  })
  assert.equal(sessionRes.statusCode, 200)
  const sessionData = sessionRes.json()
  const events = sessionData.session.events

  // No permission_request because the read-only subcommand bypasses the
  // approval gate entirely.
  assert.ok(
    !events.some((e: any) => e.type === 'permission_request'),
    'read-only Bash subcommand should not raise permission_request',
  )
  // tool_started should record effectiveRisk=read (classifier downgrade).
  const started = events.find((e: any) => e.type === 'tool_started' && e.name === 'Bash')
  assert.ok(started, 'expected tool_started for Bash')
  assert.equal(started.effectiveRisk, 'read')

  // No permission audit row — approval gate was never entered.
  const auditsRes = await app.inject({
    method: 'GET',
    url: `/v1/sessions/${sessionId}/permission-audits`,
  })
  assert.equal(auditsRes.statusCode, 200)
  const auditsBody = auditsRes.json()
  assert.equal(auditsBody.audits.length, 0, 'no permission_audit should be written for auto-allowed read-only Bash')

  await app.close()
})

test('smart permissions: workspace path safety blocks cat outside workspace', async () => {
  // Phase A of docs/nexus/reference/go-tui-permission-policy-governance-plan.md
  // downgrades `cat` to `risk: 'read'`, so the smart-permissions layer no
  // longer asks for a permission_request for `cat /tmp/secret.txt`.
  // However, the workspace path safety check in `findWorkspaceEscapeInCommand`
  // (src/tools/builtin/bash.ts) still runs first and returns a
  // WORKSPACE_PATH_ESCAPE failure that the runtime surfaces as a
  // tool_completed event with success=false — the cat never runs and
  // no permission_request is raised. This test pins that new contract.
  const cwd = join(tmpdir(), `babel-o-test-smart-cat-outside-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  // Restrict allowed paths to cwd so the workspace-escape check fires.
  process.env.NEXUS_ALLOWED_WORKSPACES = cwd
  try {
    const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
    const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

    const sessionId = `session-smart-cat-outside-${Date.now()}`
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "cat /tmp/secret.txt"', cwd, sessionId },
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.success, false, 'workspace-escape cat should fail')

    // No permission_request — read-only Bash subcommand bypasses the
    // approval gate; the workspace-safety check is enforced inside the
    // Bash tool itself.
    const sessionRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
    })
    assert.equal(sessionRes.statusCode, 200)
    const events = sessionRes.json().session.events
    assert.ok(
      !events.some((e: any) => e.type === 'permission_request'),
      'cat outside workspace should not raise permission_request under Phase A',
    )

    // tool_completed with success=false is the workspace-escape failure.
    const toolCompleted = events.find((e: any) => e.type === 'tool_completed' && e.name === 'Bash')
    assert.ok(toolCompleted, 'expected tool_completed for Bash')
    assert.equal(toolCompleted.success, false)

    // No permission_audit row — the approval gate was never entered.
    const auditsRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/permission-audits`,
    })
    const auditsBody = auditsRes.json()
    assert.equal(auditsBody.audits.length, 0)

    await app.close()
  } finally {
    delete process.env.NEXUS_ALLOWED_WORKSPACES
  }
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

test('pending permission registry delegates to a replaceable backend', async () => {
  const registry = PendingPermissionRegistry.getInstance()
  registry.resetForTest()
  registry.configureForTest({ disableSweeper: true })
  const backend = new RecordingPermissionBackend()
  registry.setBackend(backend)

  const pending = registry.register('session-backend', 'tool-backend')
  assert.equal(backend.registered.length, 1)
  assert.equal(registry.pendingCount(), 1)
  assert.equal(registry.resolve('session-backend', 'tool-backend', {
    approved: true,
    reason: 'backend approved',
  }), true)

  const resolution = await pending
  assert.deepEqual(resolution, {
    approved: true,
    reason: 'backend approved',
  })
  assert.equal(registry.pendingCount(), 0)

  registry.resetForTest()
})

class RecordingPermissionBackend implements PendingPermissionBackend {
  readonly registered: PendingPermissionEntry[] = []
  private readonly pending = new Map<string, PendingPermissionEntry>()

  register(entry: PendingPermissionEntry): void {
    this.registered.push(entry)
    this.pending.set(this.key(entry.sessionId, entry.toolUseId), entry)
  }

  resolve(sessionId: string, toolUseId: string, resolution: PermissionResolution): boolean {
    const key = this.key(sessionId, toolUseId)
    const entry = this.pending.get(key)
    if (!entry) return false
    entry.resolve(resolution)
    this.pending.delete(key)
    return true
  }

  resolveSession(sessionId: string, resolution: PermissionResolution): boolean {
    let resolvedAny = false
    for (const [key, entry] of this.pending.entries()) {
      if (entry.sessionId !== sessionId) continue
      entry.resolve(resolution)
      this.pending.delete(key)
      resolvedAny = true
    }
    return resolvedAny
  }

  sweepExpired(nowMs: number): number {
    let expired = 0
    for (const [key, entry] of this.pending.entries()) {
      if (entry.expiresAt > nowMs) continue
      entry.resolve({ approved: false, reason: 'Permission request timed out' })
      this.pending.delete(key)
      expired += 1
    }
    return expired
  }

  pendingCount(): number {
    return this.pending.size
  }

  reset(resolution: PermissionResolution): void {
    for (const entry of this.pending.values()) entry.resolve(resolution)
    this.pending.clear()
  }

  private key(sessionId: string, toolUseId: string): string {
    return `${sessionId}:${toolUseId}`
  }
}
