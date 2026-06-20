import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import type { PermissionAudit } from '../src/storage/Storage.js'

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-audit-repo-'))
  return { dir, dbPath: join(dir, 'nexus.sqlite') }
}

function baseSession(sessionId: string) {
  return {
    sessionId,
    cwd: '/workspace',
    prompt: 'inspect',
    phase: 'created' as const,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    events: [],
  }
}

function makeAudit(overrides: Partial<PermissionAudit> = {}): PermissionAudit {
  return {
    auditId: 'audit_1',
    sessionId: 'sess_1',
    toolUseId: 'call_1',
    toolName: 'Bash',
    toolRisk: 'medium',
    toolInput: { command: 'ls -la' },
    decision: 'approved',
    timestamp: '2026-06-20T00:00:01.000Z',
    ...overrides,
  }
}

test('AuditRepository savePermissionAudit + listPermissionAudits round-trip preserves all fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_audit_repo_roundtrip'
    await storage.saveSession(baseSession(sessionId))
    const audit = makeAudit({
      auditId: 'audit_roundtrip',
      sessionId,
      toolUseId: 'call_roundtrip',
      toolName: 'Bash',
      toolRisk: 'high',
      toolInput: { command: 'rm -rf /tmp/build', cwd: '/workspace', env: { DEBUG: '1' } },
      decision: 'denied',
      reason: 'destructive command requires explicit approval',
      timestamp: '2026-06-20T00:00:01.000Z',
    })
    await storage.savePermissionAudit(audit)

    const list = await storage.listPermissionAudits(sessionId)
    assert.equal(list.length, 1)
    const loaded = list[0]
    assert.equal(loaded.auditId, 'audit_roundtrip')
    assert.equal(loaded.sessionId, sessionId)
    assert.equal(loaded.toolUseId, 'call_roundtrip')
    assert.equal(loaded.toolName, 'Bash')
    assert.equal(loaded.toolRisk, 'high')
    assert.deepEqual(loaded.toolInput, { command: 'rm -rf /tmp/build', cwd: '/workspace', env: { DEBUG: '1' } })
    assert.equal(loaded.decision, 'denied')
    assert.equal(loaded.reason, 'destructive command requires explicit approval')
    assert.equal(loaded.timestamp, '2026-06-20T00:00:01.000Z')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AuditRepository savePermissionAudit is upsert: re-save with same id updates fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_audit_repo_upsert'
    await storage.saveSession(baseSession(sessionId))
    await storage.savePermissionAudit(makeAudit({
      auditId: 'audit_upsert',
      sessionId,
      decision: 'approved',
      timestamp: '2026-06-20T00:00:01.000Z',
    }))
    await storage.savePermissionAudit(makeAudit({
      auditId: 'audit_upsert',
      sessionId,
      decision: 'denied',
      reason: 're-evaluated as too risky',
      timestamp: '2026-06-20T00:00:05.000Z',
    }))
    const list = await storage.listPermissionAudits(sessionId)
    assert.equal(list.length, 1)
    assert.equal(list[0].decision, 'denied')
    assert.equal(list[0].reason, 're-evaluated as too risky')
    assert.equal(list[0].timestamp, '2026-06-20T00:00:05.000Z')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AuditRepository listPermissionAudits returns audits ordered by timestamp ASC', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_audit_repo_order'
    const otherSessionId = 'session_audit_repo_order_other'
    await storage.saveSession(baseSession(sessionId))
    await storage.saveSession(baseSession(otherSessionId))
    // intentionally insert in non-sorted order
    await storage.savePermissionAudit(makeAudit({
      auditId: 'audit_c',
      sessionId,
      toolUseId: 'call_c',
      timestamp: '2026-06-20T00:00:03.000Z',
    }))
    await storage.savePermissionAudit(makeAudit({
      auditId: 'audit_a',
      sessionId,
      toolUseId: 'call_a',
      timestamp: '2026-06-20T00:00:01.000Z',
    }))
    await storage.savePermissionAudit(makeAudit({
      auditId: 'audit_b',
      sessionId,
      toolUseId: 'call_b',
      timestamp: '2026-06-20T00:00:02.000Z',
    }))
    // other session — should be excluded
    await storage.savePermissionAudit(makeAudit({
      auditId: 'audit_other',
      sessionId: otherSessionId,
      toolUseId: 'call_other',
      timestamp: '2026-06-20T00:00:01.000Z',
    }))

    const audits = await storage.listPermissionAudits(sessionId)
    assert.equal(audits.length, 3)
    assert.equal(audits[0].auditId, 'audit_a')
    assert.equal(audits[1].auditId, 'audit_b')
    assert.equal(audits[2].auditId, 'audit_c')
    assert.equal(audits.every((a) => a.sessionId === sessionId), true)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AuditRepository listPermissionAudits returns empty array for session with no audits', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_audit_repo_empty'
    await storage.saveSession(baseSession(sessionId))
    const audits = await storage.listPermissionAudits(sessionId)
    assert.deepEqual(audits, [])
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AuditRepository savePermissionAudit handles optional reason as undefined', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_audit_repo_no_reason'
    await storage.saveSession(baseSession(sessionId))
    await storage.savePermissionAudit(makeAudit({
      auditId: 'audit_no_reason',
      sessionId,
      decision: 'approved',
      reason: undefined,
    }))
    const list = await storage.listPermissionAudits(sessionId)
    assert.equal(list.length, 1)
    assert.equal(list[0].reason, undefined)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AuditRepository savePermissionAudit preserves complex nested toolInput JSON', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_audit_repo_complex'
    await storage.saveSession(baseSession(sessionId))
    const complexInput = {
      command: 'git push',
      args: ['--force-with-lease', 'origin', 'main'],
      env: { CI: '1', DEBUG: 'trace' },
      flags: { force: true, dryRun: false, remote: { name: 'origin', url: 'git@github.com:foo/bar.git' } },
      tags: ['deploy', 'p0'],
    }
    await storage.savePermissionAudit(makeAudit({
      auditId: 'audit_complex',
      sessionId,
      toolInput: complexInput,
    }))
    const list = await storage.listPermissionAudits(sessionId)
    assert.equal(list.length, 1)
    assert.deepEqual(list[0].toolInput, complexInput)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
