// test/session-origin-cwd.test.ts
//
// Bug 2 (context-cwd-drift-and-recall-governance-plan.md §13.4): immutable
// `sessions.origin_cwd` column + Phase B continuity wiring. session_10320709
// proved that `session.cwd` itself drifts (turn 1 → ~/Library, carried
// forward turns 2-6), so Phase B continuity cannot trust session.cwd as the
// "stored session root". originCwd is written ONCE at session creation
// (launcher body.cwd / Nexus defaultCwd) and never overwritten by per-turn
// cwd mutations. Nexus prepareExecution then passes
// `storedSessionCwd = session.originCwd` + `latestTaskPrimaryRoot` to
// executeStream so resolveCwdWithContinuity can recover a drifted requestCwd.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'

const SESSION_BASE = {
  prompt: 'p',
  phase: 'executing' as const,
  createdAt: '2026-06-18T10:00:00.000Z',
  updatedAt: '2026-06-18T10:00:00.000Z',
  events: [],
}

describe('Bug 2: originCwd immutability — MemoryStorage', () => {
  test('originCwd set at creation survives a saveSession with a drifted cwd', async () => {
    const storage = new MemoryStorage()
    const sid = `mem-${randomUUID()}`
    const originCwd = '/proj/root'
    await storage.saveSession({ sessionId: sid, cwd: originCwd, originCwd, ...SESSION_BASE })
    // Simulate the session_10320709 drift: cwd moves to ~/Library.
    await storage.saveSession({ sessionId: sid, cwd: '/Users/x/Library', ...SESSION_BASE })

    const after = await storage.getSession(sid, { includeEvents: false })
    assert.equal(after!.cwd, '/Users/x/Library', 'cwd reflects the drift')
    assert.equal(after!.originCwd, originCwd, 'originCwd is immutable')
  })

  test('originCwd preserved when a later saveSession omits the field (older caller)', async () => {
    const storage = new MemoryStorage()
    const sid = `mem-omit-${randomUUID()}`
    const originCwd = '/proj/root'
    await storage.saveSession({ sessionId: sid, cwd: originCwd, originCwd, ...SESSION_BASE })
    // Older caller that doesn't know originCwd — must not clobber to undefined.
    await storage.saveSession({ sessionId: sid, cwd: '/another/path', ...SESSION_BASE })

    const after = await storage.getSession(sid, { includeEvents: false })
    assert.equal(after!.originCwd, originCwd, 'originCwd preserved when omitted on update')
  })
})

describe('Bug 2: originCwd immutability — SqliteStorage', () => {
  let dbPath: string
  let tmpRoot: string

  test('originCwd set at creation survives a saveSession with a drifted cwd (ON CONFLICT does not touch origin_cwd)', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'babel-o-origin-cwd-'))
    dbPath = join(tmpRoot, 'test.sqlite')
    try {
      const storage = new SqliteStorage(dbPath)
      const sid = `sqlite-${randomUUID()}`
      const originCwd = '/Users/test/DEV/BABEL/BabeL-O'
      await storage.saveSession({ sessionId: sid, cwd: originCwd, originCwd, ...SESSION_BASE })
      // Drift cwd to ~/Library — the session_10320709 scenario.
      await storage.saveSession({ sessionId: sid, cwd: '/Users/test/Library', ...SESSION_BASE })

      const after = await storage.getSession(sid, { includeEvents: false })
      assert.equal(after!.cwd, '/Users/test/Library', 'cwd reflects the drift')
      assert.equal(after!.originCwd, originCwd, 'originCwd immutable across ON CONFLICT update')

      await storage.close?.()
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('v15 migration backfills origin_cwd = cwd for pre-Bug-2 sessions', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'babel-o-origin-migrate-'))
    dbPath = join(tmpRoot, 'test.sqlite')
    try {
      // First open runs the migration (adds origin_cwd column, bumps
      // user_version to 15) and persists a real session.
      const s1 = new SqliteStorage(dbPath)
      const sid = `legacy-${randomUUID()}`
      const legacyCwd = '/legacy/cwd'
      await s1.saveSession({ sessionId: sid, cwd: legacyCwd, ...SESSION_BASE })
      await s1.close?.()

      // Simulate a pre-Bug-2 row: blow origin_cwd back to NULL directly,
      // then reopen storage. The v15 migration's backfill UPDATE runs
      // (origin_cwd IS NULL → cwd) only when user_version < 15, so to
      // exercise it we also reset user_version to 14 to force re-migration.
      const { DatabaseSync } = await import('node:sqlite')
      const raw = new DatabaseSync(dbPath)
      raw.prepare('UPDATE sessions SET origin_cwd = NULL WHERE session_id = ?').run(sid)
      raw.prepare('PRAGMA user_version = 14').run()
      raw.close()

      const s2 = new SqliteStorage(dbPath)
      const after = await s2.getSession(sid, { includeEvents: false })
      assert.equal(after!.originCwd, legacyCwd, 'legacy session backfilled with cwd as best-effort origin')
      await s2.close?.()
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
