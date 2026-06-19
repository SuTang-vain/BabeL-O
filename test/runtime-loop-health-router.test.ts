import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createNexusApp } from '../src/nexus/app.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import type { NexusEvent } from '../src/shared/events.js'

const SCHEMA_VERSION = '2026-05-21.babel-o.v1'

function eventBase(sessionId: string, type: string, timestamp: string) {
  return {
    type,
    schemaVersion: SCHEMA_VERSION as typeof SCHEMA_VERSION,
    sessionId,
    timestamp,
  }
}

async function saveEmptySession(storage: MemoryStorage, cwd: string, sessionId: string): Promise<void> {
  await storage.saveSession({
    sessionId,
    cwd,
    prompt: '',
    phase: 'created',
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    events: [],
  })
}

describe('RuntimeLoopHealthRouter', () => {
  test('GET /v1/runtime/loop/health aggregates pane status and task scope', async () => {
    const cwd = join(tmpdir(), `babel-o-loop-health-router-${Date.now()}`)
    await mkdir(cwd, { recursive: true })
    const storage = new MemoryStorage()
    const sessionId = 'session-loop-health-router'
    await saveEmptySession(storage, cwd, sessionId)
    await storage.appendEvent(sessionId, {
      ...eventBase(sessionId, 'task_scope_declared', '2026-06-18T00:00:00.000Z'),
      cwd,
      primaryRoot: cwd,
      explicitRoots: [],
      confirmedExternalRoots: ['/confirmed'],
      inferredCandidateRoots: [],
      mode: 'multi_root',
      source: 'user_confirmation',
      message: 'multi-root task',
    } as unknown as NexusEvent)
    await storage.appendEvent(sessionId, {
      ...eventBase(sessionId, 'permission_request', '2026-06-18T00:00:01.000Z'),
      toolUseId: 'tool-1',
      toolName: 'Bash',
      toolRisk: 'execute',
      toolInput: {},
      risk: 'execute',
    } as unknown as NexusEvent)

    const app = await createNexusApp({
      storage,
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/runtime/loop/health?sessionId=${sessionId}&lastN=25`,
      })
      assert.equal(response.statusCode, 200)
      const body = response.json()
      assert.equal(body.type, 'loop_health')
      assert.equal(body.filter.sessionId, sessionId)
      assert.equal(body.filter.lastN, 25)
      assert.equal(body.panes.length, 1)
      assert.equal(body.panes[0].sessionId, sessionId)
      assert.equal(body.panes[0].status, 'blocked')
      assert.equal(body.panes[0].pendingPermissions, 1)
      assert.equal(body.panes[0].taskScope.mode, 'multi_root')
      assert.deepEqual(body.panes[0].taskScope.confirmedExternalRoots, ['/confirmed'])
      assert.equal(body.panes[0].cacheHealth.type, 'cache_health')
    } finally {
      await app.close()
    }
  })

  test('GET /v1/runtime/loop/health returns empty panes for missing sessionId', async () => {
    const cwd = join(tmpdir(), `babel-o-loop-health-router-empty-${Date.now()}`)
    await mkdir(cwd, { recursive: true })
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/runtime/loop/health?sessionId=session-missing',
      })
      assert.equal(response.statusCode, 200)
      const body = response.json()
      assert.equal(body.type, 'loop_health')
      assert.equal(body.filter.sessionId, 'session-missing')
      assert.deepEqual(body.panes, [])
    } finally {
      await app.close()
    }
  })
})
