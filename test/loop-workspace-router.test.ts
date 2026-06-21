import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createNexusApp } from '../src/nexus/app.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

describe('LoopWorkspaceRouter', () => {
  test('GET /v1/loop/workspaces lists panes and preserves filters', async () => {
    const cwd = join(tmpdir(), `babel-o-loop-workspace-router-${Date.now()}`)
    await mkdir(cwd, { recursive: true })
    const storage = new MemoryStorage()
    await storage.upsertLoopPane({
      paneId: 'pane-a',
      workspaceId: 'workspace-a',
      tabId: 'tab-a',
      sessionId: 'session-a',
      agent: 'bbl',
      cwd,
      label: 'Pane A',
      lastRev: 3,
      updatedAt: '2026-06-18T10:00:00.000Z',
    })
    await storage.upsertLoopPane({
      paneId: 'pane-b',
      workspaceId: 'workspace-b',
      tabId: 'tab-b',
      sessionId: 'session-b',
      agent: 'review',
      cwd,
      label: null,
      lastRev: 1,
      updatedAt: '2026-06-18T10:01:00.000Z',
    })

    const app = await createNexusApp({
      storage,
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const all = await app.inject({ method: 'GET', url: '/v1/loop/workspaces' })
      assert.equal(all.statusCode, 200)
      const allBody = all.json()
      assert.equal(allBody.type, 'loop_workspaces')
      assert.equal(allBody.panes.length, 2)
      assert.equal(allBody.filter.workspaceId, null)
      assert.equal(allBody.filter.sessionId, null)

      const filtered = await app.inject({
        method: 'GET',
        url: '/v1/loop/workspaces?workspaceId=workspace-a&sessionId=session-a',
      })
      assert.equal(filtered.statusCode, 200)
      const filteredBody = filtered.json()
      assert.equal(filteredBody.type, 'loop_workspaces')
      assert.equal(filteredBody.panes.length, 1)
      assert.equal(filteredBody.panes[0].paneId, 'pane-a')
      assert.equal(filteredBody.panes[0].lastRev, 3)
      assert.equal(filteredBody.filter.workspaceId, 'workspace-a')
      assert.equal(filteredBody.filter.sessionId, 'session-a')
    } finally {
      await app.close()
    }
  })
})
