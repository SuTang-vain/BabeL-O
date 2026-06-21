import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createNexusApp } from '../src/nexus/app.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

describe('LoopPaneRouter', () => {
  test('POST/PATCH/DELETE loop panes preserve the existing envelope', async () => {
    const cwd = join(tmpdir(), `babel-o-loop-pane-router-${Date.now()}`)
    await mkdir(cwd, { recursive: true })
    const storage = new MemoryStorage()
    const app = await createNexusApp({
      storage,
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/loop/workspaces/workspace-a/panes',
        payload: {
          paneId: 'pane-a',
          workspaceId: 'workspace-a',
          tabId: 'tab-a',
          sessionId: 'session-a',
          agent: 'bbl',
          cwd,
          label: 'Main',
          lastRev: 1,
        },
      })
      assert.equal(created.statusCode, 200)
      assert.equal(created.json().type, 'loop_pane')
      assert.equal(created.json().pane.paneId, 'pane-a')
      assert.equal(created.json().pane.label, 'Main')

      const patched = await app.inject({
        method: 'PATCH',
        url: '/v1/loop/workspaces/workspace-a/tabs/tab-a/panes/pane-a',
        payload: { label: 'Renamed', lastRev: 7 },
      })
      assert.equal(patched.statusCode, 200)
      assert.equal(patched.json().type, 'loop_pane')
      assert.equal(patched.json().pane.label, 'Renamed')
      assert.equal(patched.json().pane.lastRev, 7)

      const deleted = await app.inject({
        method: 'DELETE',
        url: '/v1/loop/workspaces/workspace-a/tabs/tab-a/panes/pane-a',
      })
      assert.equal(deleted.statusCode, 200)
      assert.deepEqual(deleted.json(), {
        type: 'loop_pane_deleted',
        paneId: 'pane-a',
      })

      const panes = await storage.listLoopPanes({ paneId: 'pane-a' })
      assert.equal(panes.length, 0)
    } finally {
      await app.close()
    }
  })

  test('POST rejects workspace mismatch and DELETE reports missing panes', async () => {
    const cwd = join(tmpdir(), `babel-o-loop-pane-router-errors-${Date.now()}`)
    await mkdir(cwd, { recursive: true })
    const storage = new MemoryStorage()
    const app = await createNexusApp({
      storage,
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const mismatch = await app.inject({
        method: 'POST',
        url: '/v1/loop/workspaces/workspace-url/panes',
        payload: {
          paneId: 'pane-a',
          workspaceId: 'workspace-body',
          tabId: 'tab-a',
          sessionId: 'session-a',
          agent: 'bbl',
          cwd,
        },
      })
      assert.equal(mismatch.statusCode, 400)
      assert.equal(mismatch.json().code, 'WORKSPACE_MISMATCH')

      const missing = await app.inject({
        method: 'DELETE',
        url: '/v1/loop/workspaces/workspace-a/tabs/tab-a/panes/missing-pane',
      })
      assert.equal(missing.statusCode, 404)
      assert.equal(missing.json().code, 'PANE_NOT_FOUND')
    } finally {
      await app.close()
    }
  })
})
