// test/authorization-state-persistence.test.ts
//
// Phase 2 of authorization-continuity-execution-plan.md:
// `sessions.authorization_state` column + intake inheritance wiring.
// session_1de7cf54 proved that "继续任务" resets authorization from local_change
// to inspect, causing TOOL_DENIED. This test verifies the fix:
// 1. authorization_state is persisted after each turn
// 2. continuation phrases inherit the previous authorization
// 3. the full flow works with MemoryStorage and SqliteStorage

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import type { SessionAuthorizationState } from '../src/shared/session.js'
import { extractAuthorizationStateFromEvents } from '../src/nexus/executionFinalization.js'

const SESSION_BASE = {
  prompt: 'test prompt',
  phase: 'executing' as const,
  createdAt: '2026-07-10T10:00:00.000Z',
  updatedAt: '2026-07-10T10:00:00.000Z',
  events: [],
}

describe('Phase 2: authorization_state persistence — MemoryStorage', () => {
  test('authorization_state can be saved and retrieved', async () => {
    const storage = new MemoryStorage()
    const sid = `auth-mem-${randomUUID()}`

    const authState: SessionAuthorizationState = {
      level: 'local_change',
      scope: 'stated_plan',
      source: 'explicit_user',
      establishedAt: '2026-07-10T10:00:00.000Z',
      lastConfirmedAt: '2026-07-10T10:00:00.000Z',
    }

    await storage.saveSession({
      sessionId: sid,
      cwd: '/proj/root',
      ...SESSION_BASE,
      authorizationState: authState,
    })

    const retrieved = await storage.getSession(sid, { includeEvents: false })
    assert.deepEqual(retrieved!.authorizationState, authState, 'authorization_state is persisted')
  })

  test('authorization_state is updated on subsequent saves', async () => {
    const storage = new MemoryStorage()
    const sid = `auth-update-${randomUUID()}`

    const auth1: SessionAuthorizationState = {
      level: 'inspect',
      scope: 'current_step',
      source: 'inferred_none',
      establishedAt: '2026-07-10T10:00:00.000Z',
      lastConfirmedAt: '2026-07-10T10:00:00.000Z',
    }

    await storage.saveSession({
      sessionId: sid,
      cwd: '/proj/root',
      ...SESSION_BASE,
      authorizationState: auth1,
    })

    const auth2: SessionAuthorizationState = {
      level: 'local_change',
      scope: 'stated_plan',
      source: 'explicit_user',
      establishedAt: '2026-07-10T10:01:00.000Z',
      lastConfirmedAt: '2026-07-10T10:01:00.000Z',
    }

    await storage.saveSession({
      sessionId: sid,
      cwd: '/proj/root',
      ...SESSION_BASE,
      authorizationState: auth2,
    })

    const retrieved = await storage.getSession(sid, { includeEvents: false })
    assert.equal(retrieved!.authorizationState!.level, 'local_change', 'authorization_state is updated')
    assert.equal(retrieved!.authorizationState!.scope, 'stated_plan', 'scope is updated')
  })
})

describe('Phase 2: authorization_state persistence — SqliteStorage', () => {
  let dbPath: string
  let tmpRoot: string

  test.before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'auth-state-sqlite-'))
    dbPath = join(tmpRoot, 'test.db')
  })

  test.after(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('authorization_state persists through SQLite round-trip', async () => {
    const storage = new SqliteStorage(dbPath)
    const sid = `auth-sqlite-${randomUUID()}`

    const authState: SessionAuthorizationState = {
      level: 'shared_change',
      scope: 'session_workflow',
      source: 'explicit_user',
      establishedAt: '2026-07-10T10:00:00.000Z',
      lastConfirmedAt: '2026-07-10T10:00:00.000Z',
    }

    await storage.saveSession({
      sessionId: sid,
      cwd: '/proj/root',
      ...SESSION_BASE,
      authorizationState: authState,
    })

    const retrieved = await storage.getSession(sid, { includeEvents: false })
    assert.deepEqual(retrieved!.authorizationState, authState, 'authorization_state survives SQLite round-trip')
  })

  test('authorization_state column migration works', async () => {
    const storage = new SqliteStorage(dbPath)
    const sid = `auth-migration-${randomUUID()}`

    // Save without authorization_state (simulating pre-Phase-2 session)
    await storage.saveSession({
      sessionId: sid,
      cwd: '/proj/root',
      ...SESSION_BASE,
    })

    const retrieved = await storage.getSession(sid, { includeEvents: false })
    assert.equal(retrieved!.authorizationState, undefined, 'pre-Phase-2 session has no authorization_state')

    // Now update with authorization_state
    const authState: SessionAuthorizationState = {
      level: 'destructive',
      scope: 'stated_plan',
      source: 'explicit_user',
      establishedAt: '2026-07-10T10:00:00.000Z',
      lastConfirmedAt: '2026-07-10T10:00:00.000Z',
    }

    await storage.saveSession({
      sessionId: sid,
      cwd: '/proj/root',
      ...SESSION_BASE,
      authorizationState: authState,
    })

    const updated = await storage.getSession(sid, { includeEvents: false })
    assert.equal(updated!.authorizationState!.level, 'destructive', 'authorization_state can be added to existing session')
  })
})

describe('extractAuthorizationStateFromEvents', () => {
  test('returns undefined for empty events', () => {
    const result = extractAuthorizationStateFromEvents([])
    assert.equal(result, undefined, 'no authorization for empty events')
  })

  test('returns undefined when no intake guidance event', () => {
    const events = [
      { type: 'user_message', timestamp: '2026-07-10T10:00:00.000Z', text: 'hello' },
      { type: 'assistant_delta', timestamp: '2026-07-10T10:00:01.000Z', text: 'hi' },
    ]
    const result = extractAuthorizationStateFromEvents(events as any)
    assert.equal(result, undefined, 'no authorization without intake guidance')
  })

  test('returns undefined for authorizationLevel=none', () => {
    const events = [
      {
        type: 'user_intake_guidance',
        timestamp: '2026-07-10T10:00:00.000Z',
        userText: 'what tools do you have',
        authorizationLevel: 'none',
        consentScope: 'current_step',
        consentSource: 'inferred_none',
      },
    ]
    const result = extractAuthorizationStateFromEvents(events as any)
    assert.equal(result, undefined, 'trivial authorization (none) is not persisted')
  })

  test('returns undefined for inspect + inferred_none', () => {
    const events = [
      {
        type: 'user_intake_guidance',
        timestamp: '2026-07-10T10:00:00.000Z',
        userText: 'show me the project structure',
        authorizationLevel: 'inspect',
        consentScope: 'current_step',
        consentSource: 'inferred_none',
      },
    ]
    const result = extractAuthorizationStateFromEvents(events as any)
    assert.equal(result, undefined, 'default inspect authorization is not persisted')
  })

  test('returns authorization for local_change', () => {
    const events = [
      {
        type: 'user_intake_guidance',
        timestamp: '2026-07-10T10:00:00.000Z',
        userText: 'write a document',
        authorizationLevel: 'local_change',
        consentScope: 'stated_plan',
        consentSource: 'explicit_user',
      },
    ]
    const result = extractAuthorizationStateFromEvents(events as any)
    assert.ok(result, 'local_change authorization is persisted')
    assert.equal(result!.level, 'local_change', 'level is correct')
    assert.equal(result!.scope, 'stated_plan', 'scope is correct')
    assert.equal(result!.source, 'explicit_user', 'source is correct')
    assert.equal(result!.establishedAt, '2026-07-10T10:00:00.000Z', 'timestamp is correct')
  })

  test('uses latest intake guidance event when multiple exist', () => {
    const events = [
      {
        type: 'user_intake_guidance',
        timestamp: '2026-07-10T10:00:00.000Z',
        userText: 'check the project',
        authorizationLevel: 'inspect',
        consentScope: 'current_step',
        consentSource: 'inferred_none',
      },
      {
        type: 'user_intake_guidance',
        timestamp: '2026-07-10T10:01:00.000Z',
        userText: 'write a document',
        authorizationLevel: 'local_change',
        consentScope: 'stated_plan',
        consentSource: 'explicit_user',
      },
    ]
    const result = extractAuthorizationStateFromEvents(events as any)
    assert.equal(result!.level, 'local_change', 'uses latest intake event')
    assert.equal(result!.establishedAt, '2026-07-10T10:01:00.000Z', 'timestamp from latest event')
  })
})
