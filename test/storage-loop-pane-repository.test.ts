import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import type { LoopPaneState } from '../src/storage/Storage.js'

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-loop-pane-repo-'))
  return { dir, dbPath: join(dir, 'nexus.sqlite') }
}

function makePane(overrides: Partial<LoopPaneState> = {}): LoopPaneState {
  return {
    paneId: 'pane_1',
    workspaceId: 'ws_1',
    tabId: 'tab_1',
    sessionId: 'session_1',
    agent: 'claude',
    cwd: '/workspace',
    label: 'main pane',
    lastRev: 0,
    updatedAt: '2026-06-20T00:00:00.000Z',
    ...overrides,
  }
}

test('LoopPaneRepository upsertLoopPane round-trip preserves all fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const pane = makePane({
      paneId: 'pane_roundtrip',
      workspaceId: 'ws_roundtrip',
      tabId: 'tab_roundtrip',
      sessionId: 'session_roundtrip',
      agent: 'gemini',
      cwd: '/workspace/roundtrip',
      label: 'audit loop',
      lastRev: 42,
      updatedAt: '2026-06-20T00:00:01.000Z',
    })
    const result = await storage.upsertLoopPane(pane)
    assert.equal(result.paneId, 'pane_roundtrip')
    const loaded = await storage.listLoopPanes({ paneId: 'pane_roundtrip' })
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].paneId, 'pane_roundtrip')
    assert.equal(loaded[0].workspaceId, 'ws_roundtrip')
    assert.equal(loaded[0].tabId, 'tab_roundtrip')
    assert.equal(loaded[0].sessionId, 'session_roundtrip')
    assert.equal(loaded[0].agent, 'gemini')
    assert.equal(loaded[0].cwd, '/workspace/roundtrip')
    assert.equal(loaded[0].label, 'audit loop')
    assert.equal(loaded[0].lastRev, 42)
    assert.equal(loaded[0].updatedAt, '2026-06-20T00:00:01.000Z')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LoopPaneRepository upsertLoopPane is upsert: re-save with same paneId updates fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.upsertLoopPane(makePane({
      paneId: 'pane_upsert',
      workspaceId: 'ws_upsert',
      label: 'first',
      lastRev: 10,
    }))
    await storage.upsertLoopPane(makePane({
      paneId: 'pane_upsert',
      workspaceId: 'ws_upsert',
      label: 'second',
      lastRev: 99,
      updatedAt: '2026-06-20T00:00:05.000Z',
    }))
    const loaded = await storage.listLoopPanes({ paneId: 'pane_upsert' })
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].label, 'second')
    assert.equal(loaded[0].lastRev, 99)
    assert.equal(loaded[0].updatedAt, '2026-06-20T00:00:05.000Z')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LoopPaneRepository listLoopPanes returns empty array when no panes exist', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const panes = await storage.listLoopPanes()
    assert.deepEqual(panes, [])
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LoopPaneRepository listLoopPanes filter by workspaceId excludes other workspaces', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.upsertLoopPane(makePane({ paneId: 'pane_a', workspaceId: 'ws_a', tabId: 'tab_a' }))
    await storage.upsertLoopPane(makePane({ paneId: 'pane_b', workspaceId: 'ws_b', tabId: 'tab_a' }))
    await storage.upsertLoopPane(makePane({ paneId: 'pane_c', workspaceId: 'ws_a', tabId: 'tab_b' }))

    const aPanes = await storage.listLoopPanes({ workspaceId: 'ws_a' })
    assert.equal(aPanes.length, 2)
    assert.deepEqual(aPanes.map(p => p.paneId).sort(), ['pane_a', 'pane_c'])

    const bPanes = await storage.listLoopPanes({ workspaceId: 'ws_b' })
    assert.equal(bPanes.length, 1)
    assert.equal(bPanes[0].paneId, 'pane_b')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LoopPaneRepository listLoopPanes filter by tabId excludes other tabs', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.upsertLoopPane(makePane({ paneId: 'pane_t1', workspaceId: 'ws', tabId: 'tab_one' }))
    await storage.upsertLoopPane(makePane({ paneId: 'pane_t2', workspaceId: 'ws', tabId: 'tab_one' }))
    await storage.upsertLoopPane(makePane({ paneId: 'pane_t3', workspaceId: 'ws', tabId: 'tab_two' }))

    const t1 = await storage.listLoopPanes({ tabId: 'tab_one' })
    assert.equal(t1.length, 2)
    assert.deepEqual(t1.map(p => p.paneId).sort(), ['pane_t1', 'pane_t2'])

    const t2 = await storage.listLoopPanes({ tabId: 'tab_two' })
    assert.equal(t2.length, 1)
    assert.equal(t2[0].paneId, 'pane_t3')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LoopPaneRepository listLoopPanes filter by sessionId excludes other sessions', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.upsertLoopPane(makePane({ paneId: 'pane_s1', sessionId: 'sess_x' }))
    await storage.upsertLoopPane(makePane({ paneId: 'pane_s2', sessionId: 'sess_y' }))

    const xPanes = await storage.listLoopPanes({ sessionId: 'sess_x' })
    assert.equal(xPanes.length, 1)
    assert.equal(xPanes[0].paneId, 'pane_s1')

    const yPanes = await storage.listLoopPanes({ sessionId: 'sess_y' })
    assert.equal(yPanes.length, 1)
    assert.equal(yPanes[0].paneId, 'pane_s2')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LoopPaneRepository listLoopPanes combined filters compose via AND', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.upsertLoopPane(makePane({ paneId: 'pane_match', workspaceId: 'ws_a', tabId: 'tab_x', sessionId: 'sess_match' }))
    await storage.upsertLoopPane(makePane({ paneId: 'pane_wrong_ws', workspaceId: 'ws_b', tabId: 'tab_x', sessionId: 'sess_match' }))
    await storage.upsertLoopPane(makePane({ paneId: 'pane_wrong_tab', workspaceId: 'ws_a', tabId: 'tab_y', sessionId: 'sess_match' }))

    const filtered = await storage.listLoopPanes({ workspaceId: 'ws_a', tabId: 'tab_x' })
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].paneId, 'pane_match')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LoopPaneRepository listLoopPanes returns panes ordered by workspace_id, tab_id, pane_id ASC', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    // intentionally out of sort order
    await storage.upsertLoopPane(makePane({ paneId: 'pane_c', workspaceId: 'ws_b', tabId: 'tab_x' }))
    await storage.upsertLoopPane(makePane({ paneId: 'pane_a', workspaceId: 'ws_a', tabId: 'tab_y' }))
    await storage.upsertLoopPane(makePane({ paneId: 'pane_b', workspaceId: 'ws_a', tabId: 'tab_x' }))

    const all = await storage.listLoopPanes()
    assert.equal(all.length, 3)
    assert.equal(all[0].paneId, 'pane_b') // ws_a/tab_x
    assert.equal(all[1].paneId, 'pane_a') // ws_a/tab_y
    assert.equal(all[2].paneId, 'pane_c') // ws_b/tab_x
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LoopPaneRepository upsertLoopPane preserves null label (no coalesce to empty string)', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.upsertLoopPane(makePane({ paneId: 'pane_no_label', label: null }))
    const loaded = await storage.listLoopPanes({ paneId: 'pane_no_label' })
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].label, null)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LoopPaneRepository deleteLoopPane returns true on success and false for unknown paneId', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.upsertLoopPane(makePane({ paneId: 'pane_delete' }))

    const deleted = await storage.deleteLoopPane('pane_delete')
    assert.equal(deleted, true)

    const reloaded = await storage.listLoopPanes({ paneId: 'pane_delete' })
    assert.equal(reloaded.length, 0)

    const deletedAgain = await storage.deleteLoopPane('pane_delete')
    assert.equal(deletedAgain, false)

    const unknownDeleted = await storage.deleteLoopPane('pane_does_not_exist')
    assert.equal(unknownDeleted, false)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LoopPaneRepository updateLoopPaneRev advances lastRev and updatedAt', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.upsertLoopPane(makePane({ paneId: 'pane_rev', lastRev: 5, updatedAt: '2026-06-20T00:00:00.000Z' }))
    const updated = await storage.updateLoopPaneRev('pane_rev', 99, '2026-06-20T00:00:10.000Z')
    assert.ok(updated)
    assert.equal(updated?.paneId, 'pane_rev')
    assert.equal(updated?.lastRev, 99)
    assert.equal(updated?.updatedAt, '2026-06-20T00:00:10.000Z')
    // other fields preserved
    assert.equal(updated?.agent, 'claude')
    assert.equal(updated?.workspaceId, 'ws_1')

    const reloaded = await storage.listLoopPanes({ paneId: 'pane_rev' })
    assert.equal(reloaded[0].lastRev, 99)
    assert.equal(reloaded[0].updatedAt, '2026-06-20T00:00:10.000Z')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LoopPaneRepository updateLoopPaneRev returns null for unknown paneId', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const result = await storage.updateLoopPaneRev('pane_does_not_exist', 1, '2026-06-20T00:00:01.000Z')
    assert.equal(result, null)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
