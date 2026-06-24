/**
 * Phase 3 of
 * `docs/nexus/proposals/daemon-graceful-shutdown-and-orphan-reaper-plan.md`.
 *
 * End-to-end verification of the startup orphan reaper. The reaper is
 * run in-process (no spawned daemon) so the test can:
 *   1. seed two strands of orphan state directly into the storage layer
 *      (a session in `executing` and an `AgentJob` in `running`),
 *   2. invoke `runStartupReaper` once, then
 *   3. assert the storage row for the session is now in `interrupted`
 *      and the agent job is now `failed` with the right reason.
 *
 * The non-fatal error path is also covered: a reaper that throws inside
 * one half must not prevent the other half from running, and the report
 * must carry the captured error.
 *
 * `process.env` for `NODE_ENV` and the user config is left untouched
 * (memory `babel-o-test-config-isolation`).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import { ExploreAgentScheduler } from '../src/nexus/agents/AgentScheduler.js'
import { runStartupReaper } from '../src/nexus/startupReaper.js'
import type { SessionSnapshot } from '../src/shared/session.js'

/**
 * Build a minimal in-flight `SessionSnapshot` for seeding. Mirrors the
 * shape Nexus writes via `processRuntimeExecutionEvent` + the
 * `executionEventProcessing.ts:35` SQLite write site. Only the fields
 * the reaper reads (`phase`, `updatedAt`) and that `saveSession` needs
 * (`id`, `createdAt`, `cwd`, `policyMode`) are populated.
 */
function makeInFlightSession(id: string, phase: SessionSnapshot['phase']): SessionSnapshot {
  const now = new Date().toISOString()
  // `sessionId` and `prompt` are required by `sessionParams` in
  // `SqliteStorage.saveSession` (storage/SqliteStorage.ts:906); the
  // reaper only reads `phase` + `updatedAt` but storage validation
  // would reject anything that fails to bind cleanly.
  return {
    sessionId: id,
    prompt: '',
    phase,
    createdAt: now,
    updatedAt: now,
    cwd: process.cwd(),
    events: [],
  } as SessionSnapshot
}

function makeTempStorage() {
  const path = join(tmpdir(), `daemon-reaper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
  return { storage: new SqliteStorage(path), path }
}

test('startup reaper: executing session is transitioned to interrupted', async () => {
  const { storage, path } = makeTempStorage()
  try {
    const orphan = makeInFlightSession('session-orphan-exec', 'executing')
    await storage.saveSession(orphan)

    const scheduler = new ExploreAgentScheduler({ storage })
    const report = await runStartupReaper({ storage, agentScheduler: scheduler })

    assert.equal(report.error, undefined)
    assert.equal(report.reapedSessions, 1)
    assert.equal(report.reapedAgentJobs, 0)

    const reaped = await storage.getSession('session-orphan-exec')
    assert.ok(reaped, 'session row must still exist after reaping')
    assert.equal(reaped!.phase, 'interrupted')
    assert.equal(reaped!.terminalReason?.code, 'daemon_restart_orphan')
    assert.equal(reaped!.terminalReason?.category, 'runtime')
    assert.match(reaped!.error ?? '', /Nexus daemon was last killed/)
  } finally {
    await storage.close?.()
  }
})

test('startup reaper: terminal sessions are left alone', async () => {
  const { storage } = makeTempStorage()
  try {
    const completed = {
      ...makeInFlightSession('session-done', 'completed'),
      terminalReason: { category: 'runtime' as const, code: 'completed', message: 'done' },
    }
    const failed = { ...makeInFlightSession('session-fail', 'failed'), error: 'something broke' }
    await storage.saveSession(completed)
    await storage.saveSession(failed)

    const scheduler = new ExploreAgentScheduler({ storage })
    const report = await runStartupReaper({ storage, agentScheduler: scheduler })

    assert.equal(report.reapedSessions, 0)

    const c = await storage.getSession('session-done')
    const f = await storage.getSession('session-fail')
    assert.equal(c!.phase, 'completed')
    assert.equal(f!.phase, 'failed')
  } finally {
    await storage.close?.()
  }
})

test('startup reaper: all in-flight phase kinds are caught', async () => {
  const { storage } = makeTempStorage()
  try {
    const phases = ['created', 'planning', 'executing', 'reviewing', 'waiting_user', 'waiting_permission'] as const
    for (const phase of phases) {
      await storage.saveSession(makeInFlightSession(`session-${phase}`, phase))
    }

    const scheduler = new ExploreAgentScheduler({ storage })
    const report = await runStartupReaper({ storage, agentScheduler: scheduler })

    assert.equal(report.reapedSessions, phases.length)
    for (const phase of phases) {
      const reaped = await storage.getSession(`session-${phase}`)
      assert.equal(reaped!.phase, 'interrupted', `phase ${phase} should be reaped`)
    }
  } finally {
    await storage.close?.()
  }
})

test('startup reaper: no orphans → empty report, no errors', async () => {
  const { storage } = makeTempStorage()
  try {
    const scheduler = new ExploreAgentScheduler({ storage })
    const report = await runStartupReaper({ storage, agentScheduler: scheduler })

    assert.deepEqual(report, { reapedSessions: 0, reapedAgentJobs: 0 })
  } finally {
    await storage.close?.()
  }
})

test('startup reaper: error in one half is captured, the other half still runs', async () => {
  const { storage } = makeTempStorage()
  try {
    const orphan = makeInFlightSession('session-orphan-partial', 'executing')
    await storage.saveSession(orphan)

    // A scheduler whose reapOrphanedJobsOnStartup throws. The session
    // reaper must still complete (proving the try/catch is per-half).
    const brokenScheduler = {
      reapOrphanedJobsOnStartup: async () => {
        throw new Error('agent job reaper exploded')
      },
    } as unknown as ExploreAgentScheduler

    const report = await runStartupReaper({ storage, agentScheduler: brokenScheduler })

    assert.equal(report.reapedSessions, 1, 'session reaper must run before the agent-job reaper fails')
    assert.match(report.error ?? '', /agent job reaper exploded/)

    const reaped = await storage.getSession('session-orphan-partial')
    assert.equal(reaped!.phase, 'interrupted')
  } finally {
    await storage.close?.()
  }
})
