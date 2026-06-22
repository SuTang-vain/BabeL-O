import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-event-repo-'))
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
    events: [] as NexusEvent[],
  }
}

function makeThinkingEvent(sessionId: string, timestamp: string, text: string): NexusEvent {
  return {
    type: 'thinking_delta',
    schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
    sessionId,
    timestamp,
    text,
  } as NexusEvent
}

test('EventRepository appendEvent + listEvents round-trip preserves payload and ordering', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_repo_roundtrip'
    await storage.saveSession(baseSession(sessionId))
    const e1 = makeThinkingEvent(sessionId, '2026-06-20T00:00:01.000Z', 'first')
    const e2 = makeThinkingEvent(sessionId, '2026-06-20T00:00:02.000Z', 'second')
    const e3 = makeThinkingEvent(sessionId, '2026-06-20T00:00:03.000Z', 'third')
    await storage.appendEvent(sessionId, e1)
    await storage.appendEvent(sessionId, e2)
    await storage.appendEvent(sessionId, e3)

    const page = await storage.listEvents(sessionId, { limit: 10, order: 'asc' })
    assert.equal(page.events.length, 3)
    assert.equal((page.events[0] as any).text, 'first')
    assert.equal((page.events[1] as any).text, 'second')
    assert.equal((page.events[2] as any).text, 'third')
    assert.equal(page.lastSeq, 3)
    assert.equal(page.nextCursor, undefined)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('EventRepository listEvents cursor pagination returns nextCursor and consumes full set', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_repo_pagination'
    await storage.saveSession(baseSession(sessionId))
    for (let i = 0; i < 5; i++) {
      await storage.appendEvent(sessionId, makeThinkingEvent(sessionId, `2026-06-20T00:00:0${i + 1}.000Z`, `t${i}`))
    }

    const first = await storage.listEvents(sessionId, { limit: 2, order: 'asc' })
    assert.equal(first.events.length, 2)
    assert.equal((first.events[0] as any).text, 't0')
    assert.equal((first.events[1] as any).text, 't1')
    assert.equal(first.nextCursor, '2')
    assert.equal(first.lastSeq, 2)

    const second = await storage.listEvents(sessionId, { limit: 2, order: 'asc', cursor: first.nextCursor })
    assert.equal(second.events.length, 2)
    assert.equal((second.events[0] as any).text, 't2')
    assert.equal((second.events[1] as any).text, 't3')
    assert.equal(second.nextCursor, '4')
    assert.equal(second.lastSeq, 4)

    const third = await storage.listEvents(sessionId, { limit: 2, order: 'asc', cursor: second.nextCursor })
    assert.equal(third.events.length, 1)
    assert.equal((third.events[0] as any).text, 't4')
    assert.equal(third.nextCursor, undefined)
    assert.equal(third.lastSeq, 5)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('EventRepository listEvents descending order returns events in reverse sequence', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_repo_desc'
    await storage.saveSession(baseSession(sessionId))
    await storage.appendEvent(sessionId, makeThinkingEvent(sessionId, '2026-06-20T00:00:01.000Z', 'a'))
    await storage.appendEvent(sessionId, makeThinkingEvent(sessionId, '2026-06-20T00:00:02.000Z', 'b'))
    await storage.appendEvent(sessionId, makeThinkingEvent(sessionId, '2026-06-20T00:00:03.000Z', 'c'))

    const desc = await storage.listEvents(sessionId, { limit: 10, order: 'desc' })
    assert.equal(desc.events.length, 3)
    assert.equal((desc.events[0] as any).text, 'c')
    assert.equal((desc.events[1] as any).text, 'b')
    assert.equal((desc.events[2] as any).text, 'a')
    assert.equal(desc.lastSeq, 3)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('EventRepository listEvents eventTypes pushdown filters at SQL layer and bypasses row cap', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_repo_typefilter'
    await storage.saveSession(baseSession(sessionId))
    // Interleave user_message and thinking_delta events. With a low limit
    // and NO filter, the ascending cap would return only the earliest rows
    // (all thinking_delta), missing the user_message events entirely. With
    // eventTypes: ['user_message'], the WHERE clause filters before LIMIT so
    // the user_message events are reachable regardless of the thinking_delta
    // volume. This mirrors the session_06308b17 regression where the 10k
    // ascending cap dropped the newest user messages.
    for (let i = 0; i < 5; i += 1) {
      await storage.appendEvent(sessionId, makeThinkingEvent(sessionId, `2026-06-20T00:00:0${i}.000Z`, `think-${i}`))
    }
    await storage.appendEvent(sessionId, {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-20T00:00:10.000Z',
      text: 'first user message',
    } as NexusEvent)
    for (let i = 0; i < 5; i += 1) {
      await storage.appendEvent(sessionId, makeThinkingEvent(sessionId, `2026-06-20T00:00:1${i + 1}.000Z`, `think-late-${i}`))
    }
    await storage.appendEvent(sessionId, {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-20T00:00:20.000Z',
      text: 'second user message',
    } as NexusEvent)

    // limit=3, no filter → first 3 rows are all thinking_delta.
    const unfiltered = await storage.listEvents(sessionId, { limit: 3, order: 'asc' })
    assert.equal(unfiltered.events.length, 3)
    assert.ok(unfiltered.events.every((e) => e.type === 'thinking_delta'), 'unfiltered low-limit returns only earliest thinking_delta')

    // limit=3 WITH eventTypes pushdown → returns user_message rows that sit
    // beyond the unfiltered cap, because the filter runs in SQL before LIMIT.
    const filtered = await storage.listEvents(sessionId, {
      limit: 3, order: 'asc', eventTypes: ['user_message'],
    })
    assert.equal(filtered.events.length, 2, `expected 2 user_message events, got ${filtered.events.length}`)
    assert.ok(filtered.events.every((e) => e.type === 'user_message'))
    assert.equal((filtered.events[0] as any).text, 'first user message')
    assert.equal((filtered.events[1] as any).text, 'second user message')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MemoryStorage listEvents eventTypes filter mirrors SQL pushdown', async () => {
  const storage = new MemoryStorage()
  try {
    const sessionId = 'session_mem_typefilter'
    await storage.saveSession(baseSession(sessionId))
    for (let i = 0; i < 3; i += 1) {
      await storage.appendEvent(sessionId, makeThinkingEvent(sessionId, `2026-06-20T00:00:0${i}.000Z`, `think-${i}`))
    }
    await storage.appendEvent(sessionId, {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-20T00:00:10.000Z',
      text: 'a user message',
    } as NexusEvent)

    const filtered = await storage.listEvents(sessionId, {
      limit: 10, order: 'asc', eventTypes: ['user_message'],
    })
    assert.equal(filtered.events.length, 1)
    assert.equal(filtered.events[0].type, 'user_message')

    const unfiltered = await storage.listEvents(sessionId, { limit: 10, order: 'asc' })
    assert.equal(unfiltered.events.length, 4, 'unfiltered returns all types')
  } finally {
    storage.close()
  }
})

test('EventRepository isolates events between distinct sessions', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const a = 'session_repo_iso_a'
    const b = 'session_repo_iso_b'
    await storage.saveSession(baseSession(a))
    await storage.saveSession(baseSession(b))
    await storage.appendEvent(a, makeThinkingEvent(a, '2026-06-20T00:00:01.000Z', 'A1'))
    await storage.appendEvent(a, makeThinkingEvent(a, '2026-06-20T00:00:02.000Z', 'A2'))
    await storage.appendEvent(b, makeThinkingEvent(b, '2026-06-20T00:00:01.000Z', 'B1'))

    const aPage = await storage.listEvents(a, { limit: 10, order: 'asc' })
    const bPage = await storage.listEvents(b, { limit: 10, order: 'asc' })
    assert.equal(aPage.events.length, 2)
    assert.equal(bPage.events.length, 1)
    assert.equal((aPage.events[0] as any).text, 'A1')
    assert.equal((aPage.events[1] as any).text, 'A2')
    assert.equal((bPage.events[0] as any).text, 'B1')
    assert.equal(aPage.lastSeq, 2)
    assert.equal(bPage.lastSeq, 1)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('EventRepository appendEvent is idempotent on identical (timestamp, type, json) duplicates', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_repo_dup'
    await storage.saveSession(baseSession(sessionId))
    const ev = makeThinkingEvent(sessionId, '2026-06-20T00:00:01.000Z', 'same')
    await storage.appendEvent(sessionId, ev)
    await storage.appendEvent(sessionId, ev)
    await storage.appendEvent(sessionId, ev)

    const page = await storage.listEvents(sessionId, { limit: 10, order: 'asc' })
    assert.equal(page.events.length, 1)
    assert.equal(page.lastSeq, 1)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('EventRepository appendEvent with session_started updates session cwd', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const sessionId = 'session_repo_started'
    await storage.saveSession(baseSession(sessionId))
    const started: NexusEvent = {
      type: 'session_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-20T00:00:01.000Z',
      cwd: '/workspace/new',
    } as NexusEvent
    await storage.appendEvent(sessionId, started)

    const snapshot = await storage.getSession(sessionId)
    assert.ok(snapshot)
    assert.equal(snapshot.cwd, '/workspace/new')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
