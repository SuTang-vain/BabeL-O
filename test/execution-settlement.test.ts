import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settleExecutionSession } from '../src/nexus/executionFinalization.js'
import { eventBase, type NexusEvent } from '../src/shared/events.js'
import type { SessionSnapshot } from '../src/shared/session.js'
import type { NexusStorage } from '../src/storage/Storage.js'

class SettlementStorage {
  readonly appended: Array<{ sessionId: string; event: NexusEvent }> = []
  readonly savedSessions: SessionSnapshot[] = []
  session: SessionSnapshot

  constructor(sessionId: string) {
    this.session = {
      sessionId,
      cwd: '/workspace',
      prompt: 'test',
      phase: 'executing',
      createdAt: '2026-06-19T00:00:00.000Z',
      updatedAt: '2026-06-19T00:00:00.000Z',
      events: [],
    }
  }

  async getSession(): Promise<SessionSnapshot> {
    return this.session
  }

  async saveSession(session: SessionSnapshot): Promise<void> {
    this.session = { ...session, events: [...session.events] }
    this.savedSessions.push(this.session)
  }

  async appendEvent(sessionId: string, event: NexusEvent): Promise<void> {
    this.appended.push({ sessionId, event })
  }
}

test('settleExecutionSession appends timeout partial result and execute summary', async () => {
  const sessionId = 'session-execution-settlement-timeout'
  const storage = new SettlementStorage(sessionId)
  const events: NexusEvent[] = [
    {
      type: 'assistant_delta',
      ...eventBase(sessionId),
      text: 'partial answer before timeout',
    },
    {
      type: 'error',
      ...eventBase(sessionId),
      code: 'REQUEST_TIMEOUT',
      message: 'timed out',
    },
  ]
  const sent: NexusEvent[] = []

  const result = await settleExecutionSession({
    storage: storage as unknown as NexusStorage,
    sessionId,
    requestId: 'req-timeout',
    events,
    timedOut: true,
    timeoutMs: 100,
    startedAtMs: 1_000,
    now: () => 1_125,
    send: event => sent.push(event),
  })

  assert.equal(result.partialResultEvent?.type, 'result')
  assert.equal(result.summaryEvent.type, 'execute_summary')
  assert.equal(result.summaryEvent.outcome, 'timeout')
  assert.equal(result.executeDurationMs, 125)
  assert.equal(result.succeeded, false)
  assert.equal(storage.session.phase, 'failed')
  assert.equal(storage.session.terminalReason?.category, 'timeout')
  assert.deepEqual(
    events.map(event => event.type),
    ['assistant_delta', 'error', 'result', 'execute_summary'],
  )
  assert.deepEqual(
    storage.appended.map(entry => entry.event.type),
    ['result', 'execute_summary'],
  )
  assert.deepEqual(
    sent.map(event => event.type),
    ['result', 'execute_summary'],
  )
})

test('settleExecutionSession treats recoverable tool denial only turn as successful', async () => {
  const sessionId = 'session-execution-settlement-denial'
  const storage = new SettlementStorage(sessionId)
  const events: NexusEvent[] = [
    {
      type: 'tool_denied',
      ...eventBase(sessionId),
      name: 'Bash',
      risk: 'execute',
      message: 'denied by policy',
      recoverable: true,
      terminal: false,
    },
    {
      type: 'result',
      ...eventBase(sessionId),
      success: false,
      message: 'Tool denied, waiting for approval.',
    },
  ]

  const result = await settleExecutionSession({
    storage: storage as unknown as NexusStorage,
    sessionId,
    requestId: 'req-denial',
    events,
    timedOut: false,
    timeoutMs: 500,
    startedAtMs: 2_000,
    now: () => 2_100,
  })

  assert.equal(result.recoveredFromToolDenial, true)
  assert.equal(result.succeeded, true)
  assert.equal(result.summaryEvent.outcome, 'success')
  assert.equal(storage.session.phase, 'completed')
  assert.equal(storage.session.error, undefined)
  assert.deepEqual(
    storage.appended.map(entry => entry.event.type),
    ['execute_summary'],
  )
})
