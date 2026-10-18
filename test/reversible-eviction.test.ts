import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { allocateBudget } from '../src/runtime/contextAssembler.js'
import { evictReversibleBeforeCurrentTurn } from '../src/runtime/reversibleEviction.js'
import type { NexusEvent } from '../src/shared/events.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

function toolPair(sessionId: string, toolUseId: string, path: string, output: string, second: number): NexusEvent[] {
  return [
    {
      type: 'tool_started',
      schemaVersion,
      sessionId,
      timestamp: `2026-05-23T00:00:${String(second).padStart(2, '0')}.000Z`,
      toolUseId,
      name: 'Read',
      input: { path },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId,
      timestamp: `2026-05-23T00:00:${String(second + 1).padStart(2, '0')}.000Z`,
      toolUseId,
      name: 'Read',
      success: true,
      output,
    },
  ]
}

describe('evictReversibleBeforeCurrentTurn', () => {
  test('dedupes/trims prior turns but leaves the current turn byte-exact', () => {
    const sessionId = 'session-reversible'
    const events: NexusEvent[] = [
      {
        type: 'session_started',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:00.000Z',
        cwd: '/tmp',
      },
      {
        type: 'user_message',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:01.000Z',
        text: 'old turn',
      },
      ...toolPair(sessionId, 'old-1', 'src/a.ts', `A${'a'.repeat(4_000)}`, 2),
      ...toolPair(sessionId, 'old-2', 'src/a.ts', `B${'b'.repeat(4_000)}`, 5),
      {
        type: 'user_message',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:10.000Z',
        text: 'CURRENT INSTRUCTION',
      },
      ...toolPair(sessionId, 'current-1', 'src/current.ts', `C${'c'.repeat(4_000)}`, 11),
    ]
    const currentTurn = events.slice(events.findIndex(event => event.type === 'user_message' && event.text === 'CURRENT INSTRUCTION'))
    const budget = allocateBudget('local/coding-runtime')

    const result = evictReversibleBeforeCurrentTurn(events, budget)

    assert.ok(result.compactedEvents > 0)
    assert.ok(result.bytesSaved > 0)
    const retainedCurrent = result.events.slice(-currentTurn.length)
    assert.deepEqual(retainedCurrent, currentTurn)
    for (let index = 0; index < currentTurn.length; index += 1) {
      assert.equal(retainedCurrent[index], currentTurn[index], 'current turn events must be the same objects')
    }

    const oldCompleted = result.events.filter(
      (event): event is Extract<NexusEvent, { type: 'tool_completed' }> =>
        event.type === 'tool_completed' && event.toolUseId === 'old-1',
    )
    assert.equal(oldCompleted.length, 1)
    assert.match(String(oldCompleted[0]!.output), /microcompacted duplicate|microcompacted Read output/)

    const currentCompleted = result.events.filter(
      (event): event is Extract<NexusEvent, { type: 'tool_completed' }> =>
        event.type === 'tool_completed' && event.toolUseId === 'current-1',
    )
    assert.equal(currentCompleted.length, 1)
    assert.equal(String(currentCompleted[0]!.output).length, 4_001)
  })

  test('returns the input unchanged when there is no user message', () => {
    const events: NexusEvent[] = [
      {
        type: 'session_started',
        schemaVersion,
        sessionId: 'session-no-user',
        timestamp: '2026-05-23T00:00:00.000Z',
        cwd: '/tmp',
      },
    ]
    const result = evictReversibleBeforeCurrentTurn(events, allocateBudget('local/coding-runtime'))
    assert.equal(result.events, events)
    assert.equal(result.compactedEvents, 0)
    assert.equal(result.bytesSaved, 0)
  })
})
