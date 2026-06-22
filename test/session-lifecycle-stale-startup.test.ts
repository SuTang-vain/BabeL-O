import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settleStaleExecutingSessionsOnStartup } from '../src/nexus/sessionLifecycle.js'
import type { SessionSnapshot } from '../src/shared/session.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

function session(sessionId: string, phase: SessionSnapshot['phase']): SessionSnapshot {
  return {
    sessionId,
    cwd: '/workspace',
    prompt: 'test',
    phase,
    createdAt: '2026-06-22T00:00:00.000Z',
    updatedAt: '2026-06-22T00:01:00.000Z',
    events: [],
  }
}

test('startup settlement marks stale executing sessions failed without touching terminal or waiting sessions', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(session('session_stale_executing', 'executing'))
  await storage.saveSession(session('session_waiting_user', 'waiting_user'))
  await storage.saveSession(session('session_completed', 'completed'))

  const result = await settleStaleExecutingSessionsOnStartup(storage, {
    now: () => '2026-06-22T00:05:00.000Z',
  })

  assert.deepEqual(result.sessionIds, ['session_stale_executing'])
  assert.equal(result.settled, 1)

  const stale = await storage.getSession('session_stale_executing', { includeEvents: false })
  assert.equal(stale?.phase, 'failed')
  assert.equal(stale?.error, 'Nexus restarted before this execution emitted a terminal event.')
  assert.equal(stale?.terminalReason?.code, 'NEXUS_RESTARTED_DURING_EXECUTION')
  assert.equal(stale?.updatedAt, '2026-06-22T00:05:00.000Z')
  assert.deepEqual(stale?.metadata?.staleExecutionRecovery, {
    code: 'NEXUS_RESTARTED_DURING_EXECUTION',
    previousPhase: 'executing',
    previousUpdatedAt: '2026-06-22T00:01:00.000Z',
    settledAt: '2026-06-22T00:05:00.000Z',
  })

  const waiting = await storage.getSession('session_waiting_user', { includeEvents: false })
  assert.equal(waiting?.phase, 'waiting_user')
  const completed = await storage.getSession('session_completed', { includeEvents: false })
  assert.equal(completed?.phase, 'completed')
})
