import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import type { SessionSnapshot } from '../src/shared/session.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-storage-'))
  return { dir, dbPath: join(dir, 'nexus.sqlite') }
}

function session(sessionId: string): SessionSnapshot {
  return {
    sessionId,
    cwd: '/workspace',
    prompt: 'inspect',
    phase: 'created',
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    events: [],
  }
}

test('SqliteStorage event_seq preserves append order for same timestamp tool events', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_storage_seq'
    await storage.saveSession(session(sessionId))
    const timestamp = '2026-06-13T00:00:01.000Z'
    const completed: NexusEvent = {
      type: 'tool_completed',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp,
      toolUseId: 'call_seq',
      name: 'Bash',
      success: true,
      output: 'ok',
    }
    const started: NexusEvent = {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp,
      toolUseId: 'call_seq',
      name: 'Bash',
      input: { command: 'echo ok' },
    }

    await storage.appendEvent(sessionId, completed)
    await storage.appendEvent(sessionId, started)

    const { events } = await storage.listEvents(sessionId, { order: 'asc', limit: 10 })
    assert.deepEqual(events.map(event => event.type), ['tool_completed', 'tool_started'])

    const desc = await storage.listEvents(sessionId, { order: 'desc', limit: 10 })
    assert.deepEqual(desc.events.map(event => event.type), ['tool_started', 'tool_completed'])
  } finally {
    await storage.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SqliteStorage event_seq is unique across concurrent appends to one session', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_storage_seq_concurrent'
    await storage.saveSession(session(sessionId))
    await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      await storage.appendEvent(sessionId, {
        type: 'assistant_delta',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: '2026-06-13T00:00:02.000Z',
        text: `delta-${index}`,
      })
    }))

    const { events } = await storage.listEvents(sessionId, { order: 'asc', limit: 20 })
    assert.equal(events.length, 12)
    assert.deepEqual(events.map(event => event.type), Array.from({ length: 12 }, () => 'assistant_delta'))

    const seqRows = (storage as any).db
      .prepare('SELECT event_seq FROM events WHERE session_id = ? ORDER BY event_seq ASC')
      .all(sessionId) as Array<{ event_seq: number }>
    assert.deepEqual(seqRows.map(row => row.event_seq), Array.from({ length: 12 }, (_, index) => index + 1))
  } finally {
    await storage.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
