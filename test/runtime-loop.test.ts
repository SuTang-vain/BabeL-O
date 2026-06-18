// test/runtime-loop.test.ts
//
// bbl loop plan Phase 1: tests for the `/v1/sessions/:id/wait`
// incremental event subscription and the `derivePaneStatus`
// runtime-owned projection helper.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { createNexusApp } from '../src/nexus/app.js'
import { derivePaneStatus } from '../src/runtime/loopDiagnostics.js'
import type { NexusEvent } from '../src/shared/events.js'

const SCHEMA_VERSION = '2026-05-21.babel-o.v1'

interface SeedSessionInput {
  cwd: string
  storage: Awaited<ReturnType<typeof createDefaultNexusRuntime>>['storage']
  events: NexusEvent[]
}

async function seedSession({ cwd, storage, events }: SeedSessionInput): Promise<string> {
  const sessionId = `session-loop-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  await storage.saveSession({
    sessionId,
    cwd,
    prompt: '',
    phase: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
  })
  for (const event of events) {
    await storage.appendEvent(sessionId, event)
  }
  return sessionId
}

async function createEmptySession(cwd: string, storage: SeedSessionInput['storage']): Promise<string> {
  const sessionId = `session-loop-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  await storage.saveSession({
    sessionId,
    cwd,
    prompt: '',
    phase: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
  })
  return sessionId
}

function eventBase(sessionId: string, type: string, timestamp: string) {
  return {
    type,
    schemaVersion: SCHEMA_VERSION as typeof SCHEMA_VERSION,
    sessionId,
    timestamp,
  }
}

test('derivePaneStatus returns idle for empty stream', () => {
  const snapshot = derivePaneStatus({ events: [] })
  assert.equal(snapshot.status, 'idle')
  assert.equal(snapshot.pendingPermissions, 0)
  assert.equal(snapshot.pendingScopeBoundaries, 0)
})

test('derivePaneStatus marks blocked when permission_request is unresolved', () => {
  const events: NexusEvent[] = [
    eventBase('s', 'permission_request', '2026-06-16T00:00:00.000Z') as NexusEvent,
  ]
  const snapshot = derivePaneStatus({ events })
  assert.equal(snapshot.status, 'blocked')
  assert.equal(snapshot.pendingPermissions, 1)
})

test('derivePaneStatus marks drift when scope_boundary_detected is unresolved', () => {
  const events: NexusEvent[] = [
    {
      ...eventBase('s', 'scope_boundary_detected', '2026-06-16T00:00:00.000Z'),
      toolUseId: 'tool-1',
      toolName: 'Read',
      targetRoot: '/external',
      taskPrimaryRoot: '/primary',
      boundaryKind: 'sibling_repo',
      action: 'require_confirmation',
      scopeRisk: 'sibling_repo',
      reason: 'unresolved sibling repo',
      suggestedPrompt: 'confirm',
    } as unknown as NexusEvent,
  ]
  const snapshot = derivePaneStatus({ events })
  assert.equal(snapshot.status, 'drift')
  assert.equal(snapshot.pendingScopeBoundaries, 1)
  assert.equal(snapshot.outOfScopeEvidence, 1)
})

test('derivePaneStatus prefers blocked over drift and working', () => {
  const events: NexusEvent[] = [
    {
      ...eventBase('s', 'tool_started', '2026-06-16T00:00:00.000Z'),
      toolUseId: 'tool-1',
      name: 'Bash',
      input: {},
    } as unknown as NexusEvent,
    {
      ...eventBase('s', 'scope_boundary_detected', '2026-06-16T00:00:01.000Z'),
      toolUseId: 'tool-1',
      toolName: 'Bash',
      targetRoot: '/external',
      taskPrimaryRoot: '/primary',
      boundaryKind: 'sibling_repo',
      action: 'require_confirmation',
      scopeRisk: 'sibling_repo',
      reason: 'unresolved',
      suggestedPrompt: 'confirm',
    } as unknown as NexusEvent,
    {
      ...eventBase('s', 'permission_request', '2026-06-16T00:00:02.000Z'),
      toolUseId: 'tool-1',
      toolName: 'Bash',
      toolRisk: 'execute',
      toolInput: {},
      risk: 'execute',
    } as unknown as NexusEvent,
  ]
  const snapshot = derivePaneStatus({ events })
  assert.equal(snapshot.status, 'blocked')
  assert.equal(snapshot.pendingPermissions, 1)
  assert.equal(snapshot.pendingScopeBoundaries, 1)
})

test('derivePaneStatus projects done after successful result with no pending items', () => {
  const events: NexusEvent[] = [
    {
      ...eventBase('s', 'tool_started', '2026-06-16T00:00:00.000Z'),
      toolUseId: 'tool-1',
      name: 'Bash',
      input: {},
    } as unknown as NexusEvent,
    {
      ...eventBase('s', 'tool_completed', '2026-06-16T00:00:01.000Z'),
      toolUseId: 'tool-1',
      name: 'Bash',
      success: true,
      output: { stdout: 'ok' },
    } as unknown as NexusEvent,
    {
      ...eventBase('s', 'result', '2026-06-16T00:00:02.000Z'),
      success: true,
      message: 'done',
    } as unknown as NexusEvent,
  ]
  const snapshot = derivePaneStatus({ events })
  assert.equal(snapshot.status, 'done')
})

test('derivePaneStatus tracks waiting for timeout events', () => {
  const events: NexusEvent[] = [
    {
      ...eventBase('s', 'tool_started', '2026-06-16T00:00:00.000Z'),
      toolUseId: 'tool-1',
      name: 'Bash',
      input: {},
    } as unknown as NexusEvent,
    eventBase('s', 'timeout_budget_exceeded', '2026-06-16T00:00:01.000Z') as NexusEvent,
  ]
  const snapshot = derivePaneStatus({ events })
  assert.equal(snapshot.status, 'waiting')
})

test('GET /v1/sessions/:id/wait filters by type and substring match', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-loop-wait`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const sessionId = await createEmptySession(cwd, storage)
    const base = (type: string, ts: string) => eventBase(sessionId, type, ts)
    await storage.appendEvent(sessionId, {
      ...base('tool_started', '2026-06-16T00:00:00.000Z'),
      toolUseId: 'tool-1',
      name: 'Read',
      input: { path: '/workspace/a.ts' },
    } as unknown as NexusEvent)
    await storage.appendEvent(sessionId, {
      ...base('permission_request', '2026-06-16T00:00:01.000Z'),
      toolUseId: 'tool-1',
      toolName: 'Read',
      toolRisk: 'read',
      toolInput: { path: '/workspace/a.ts' },
      risk: 'read',
    } as unknown as NexusEvent)
    await storage.appendEvent(sessionId, {
      ...base('permission_response', '2026-06-16T00:00:02.000Z'),
      toolUseId: 'tool-1',
      approved: true,
    } as unknown as NexusEvent)
    await storage.appendEvent(sessionId, {
      ...base('tool_completed', '2026-06-16T00:00:03.000Z'),
      toolUseId: 'tool-1',
      name: 'Read',
      success: true,
      output: { stdout: '' },
    } as unknown as NexusEvent)

    const filtered = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/wait?types=permission_request,permission_response&match=permission_request`,
    })
    assert.equal(filtered.statusCode, 200)
    const filteredBody = filtered.json()
    assert.equal(filteredBody.type, 'session_wait')
    assert.equal(filteredBody.matched, true)
    assert.equal(filteredBody.events.length, 1)
    assert.equal(filteredBody.events[0].type, 'permission_request')

    const byTypeOnly = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/wait?types=tool_completed`,
    })
    assert.equal(byTypeOnly.statusCode, 200)
    assert.equal(byTypeOnly.json().events.length, 1)
    assert.equal(byTypeOnly.json().events[0].type, 'tool_completed')

    const unmatched = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/wait?types=result&timeout=0`,
    })
    assert.equal(unmatched.statusCode, 200)
    assert.equal(unmatched.json().matched, false)
    assert.equal(unmatched.json().events.length, 0)
  } finally {
    await app.close()
  }
})

test('GET /v1/sessions/:id/wait returns 404 for missing session', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-loop-wait-404`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sessions/session-missing/wait',
    })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().code, 'SESSION_NOT_FOUND')
  } finally {
    await app.close()
  }
})

test('GET /v1/sessions/:id/wait polls and resolves when a matching event arrives', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-loop-wait-poll`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const sessionId = await createEmptySession(cwd, storage)
    const base = (type: string, ts: string) => eventBase(sessionId, type, ts)
    await storage.appendEvent(sessionId, {
      ...base('tool_started', '2026-06-16T00:00:00.000Z'),
      toolUseId: 'tool-1',
      name: 'Read',
      input: { path: '/workspace/a.ts' },
    } as unknown as NexusEvent)

    const pending = app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/wait?match=permission_request&timeout=2000`,
    })
    setTimeout(() => {
      void storage.appendEvent(sessionId, {
        ...base('permission_request', new Date().toISOString()),
        toolUseId: 'tool-1',
        toolName: 'Read',
        toolRisk: 'read',
        toolInput: { path: '/workspace/a.ts' },
        risk: 'read',
      } as unknown as NexusEvent)
    }, 400)

    const response = await pending
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.matched, true)
    assert.ok(body.events.some((event: { type: string }) => event.type === 'permission_request'))
  } finally {
    await app.close()
  }
})

test('GET /v1/runtime/loop/health aggregates status and taskScope per session', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-loop-health`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const sessionId = await createEmptySession(cwd, storage)
    const base = (type: string, ts: string) => eventBase(sessionId, type, ts)
    await storage.appendEvent(sessionId, {
      ...base('task_scope_declared', '2026-06-16T00:00:00.000Z'),
      cwd,
      primaryRoot: cwd,
      explicitRoots: [],
      confirmedExternalRoots: ['/external-confirmed'],
      inferredCandidateRoots: [],
      mode: 'multi_root',
      source: 'user_confirmation',
      message: 'multi-root task',
    } as unknown as NexusEvent)
    await storage.appendEvent(sessionId, {
      ...base('scope_boundary_detected', '2026-06-16T00:00:01.000Z'),
      toolUseId: 'tool-1',
      toolName: 'Bash',
      targetRoot: '/external-pending',
      taskPrimaryRoot: cwd,
      boundaryKind: 'sibling_repo',
      action: 'require_confirmation',
      scopeRisk: 'sibling_repo',
      reason: 'unresolved sibling',
      suggestedPrompt: 'confirm',
    } as unknown as NexusEvent)
    await storage.appendEvent(sessionId, {
      ...base('permission_request', '2026-06-16T00:00:02.000Z'),
      toolUseId: 'tool-2',
      toolName: 'Bash',
      toolRisk: 'execute',
      toolInput: {},
      risk: 'execute',
    } as unknown as NexusEvent)

    const response = await app.inject({
      method: 'GET',
      url: `/v1/runtime/loop/health?sessionId=${sessionId}`,
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'loop_health')
    assert.ok(Array.isArray(body.panes))
    const pane = body.panes.find((entry: { sessionId: string }) => entry.sessionId === sessionId)
    assert.ok(pane)
    assert.equal(pane.status, 'blocked')
    assert.equal(pane.pendingPermissions, 1)
    assert.equal(pane.pendingScopeBoundaries, 1)
    assert.equal(pane.outOfScopeEvidence, 1)
    assert.equal(pane.taskScope.mode, 'multi_root')
    assert.equal(pane.taskScope.primaryRoot, cwd)
    assert.deepEqual(pane.taskScope.confirmedExternalRoots, ['/external-confirmed'])
    assert.ok(typeof pane.lastEventRev === 'number' || pane.lastEventRev === undefined)
  } finally {
    await app.close()
  }
})

test('GET /v1/runtime/loop/health returns empty panes when no sessions exist', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-loop-health-empty`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/runtime/loop/health?workspaceId=ws-empty',
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'loop_health')
    assert.equal(body.panes.length, 0)
  } finally {
    await app.close()
  }
})

test('GET /v1/runtime/loop/health does not synthesize panes for missing sessionId', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-loop-health-missing-session`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const realSessionId = await createEmptySession(cwd, storage)
    const response = await app.inject({
      method: 'GET',
      url: '/v1/runtime/loop/health?sessionId=session-local-deadbeef',
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'loop_health')
    assert.equal(body.filter.sessionId, 'session-local-deadbeef')
    assert.deepEqual(body.panes, [])

    const realResponse = await app.inject({
      method: 'GET',
      url: `/v1/runtime/loop/health?sessionId=${realSessionId}`,
    })
    assert.equal(realResponse.statusCode, 200)
    const realBody = realResponse.json()
    assert.equal(realBody.panes.length, 1)
    assert.equal(realBody.panes[0].sessionId, realSessionId)
  } finally {
    await app.close()
  }
})

test('loop_state CRUD routes round-trip a pane', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-loop-state`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const upsert = await app.inject({
      method: 'POST',
      url: '/v1/loop/workspaces/ws-1/panes',
      payload: {
        paneId: 'pane-1',
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        sessionId: 'session-loop-1',
        agent: 'bbl',
        cwd,
        label: 'main',
        lastRev: 0,
      },
    })
    assert.equal(upsert.statusCode, 200)
    const upserted = upsert.json().pane
    assert.equal(upserted.paneId, 'pane-1')
    assert.equal(upserted.workspaceId, 'ws-1')

    const list = await app.inject({
      method: 'GET',
      url: '/v1/loop/workspaces?workspaceId=ws-1',
    })
    assert.equal(list.statusCode, 200)
    assert.equal(list.json().panes.length, 1)
    assert.equal(list.json().panes[0].paneId, 'pane-1')

    const patch = await app.inject({
      method: 'PATCH',
      url: '/v1/loop/workspaces/ws-1/tabs/tab-1/panes/pane-1',
      payload: { label: 'renamed', lastRev: 42 },
    })
    assert.equal(patch.statusCode, 200)
    const patched = patch.json().pane
    assert.equal(patched.label, 'renamed')
    assert.equal(patched.lastRev, 42)

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/v1/loop/workspaces/ws-1/tabs/tab-1/panes/pane-1',
    })
    assert.equal(deleteResponse.statusCode, 200)
    assert.equal(deleteResponse.json().type, 'loop_pane_deleted')

    const listAfterDelete = await app.inject({
      method: 'GET',
      url: '/v1/loop/workspaces?workspaceId=ws-1',
    })
    assert.equal(listAfterDelete.json().panes.length, 0)
  } finally {
    await app.close()
  }
})

test('loop_state POST rejects mismatched workspaceId between URL and body', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-loop-state-mismatch`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/loop/workspaces/ws-url/panes',
      payload: {
        paneId: 'pane-x',
        workspaceId: 'ws-body',
        tabId: 'tab-1',
        sessionId: 'session-loop-1',
        agent: 'bbl',
        cwd,
      },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().code, 'WORKSPACE_MISMATCH')
  } finally {
    await app.close()
  }
})

test('loop_state DELETE returns 404 when pane is missing', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-loop-state-404`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({
    allowedTools: ['*'],
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/loop/workspaces/ws-1/tabs/tab-1/panes/pane-missing',
    })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().code, 'PANE_NOT_FOUND')
  } finally {
    await app.close()
  }
})

test('loop_state ghost pane cleanup removes local rows without a server pane', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-loop-state-ghost`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({
    allowedTools: ['*'],
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    await options_crud_upsert(app, 'pane-keep', 'ws-1', 'tab-1')
    await options_crud_upsert(app, 'pane-ghost', 'ws-1', 'tab-1')
    const serverPanes = await app.inject({
      method: 'GET',
      url: '/v1/loop/workspaces',
    })
    const serverIds = new Set(serverPanes.json().panes.map((pane: { paneId: string }) => pane.paneId))
    const localSnapshot = ['pane-keep', 'pane-ghost', 'pane-stale-local-only']
    const keep = localSnapshot.filter(paneId => serverIds.has(paneId)).sort()
    const ghost = localSnapshot.filter(paneId => !serverIds.has(paneId)).sort()
    assert.deepEqual(keep, ['pane-ghost', 'pane-keep'])
    assert.deepEqual(ghost, ['pane-stale-local-only'])
  } finally {
    await app.close()
  }
})

async function options_crud_upsert(
  app: Awaited<ReturnType<typeof createNexusApp>>,
  paneId: string,
  workspaceId: string,
  tabId: string,
): Promise<void> {
  await app.inject({
    method: 'POST',
    url: `/v1/loop/workspaces/${workspaceId}/panes`,
    payload: {
      paneId,
      workspaceId,
      tabId,
      sessionId: `session-${paneId}`,
      agent: 'bbl',
      cwd: '/tmp',
    },
  })
}
